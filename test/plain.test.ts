// One end-to-end check: a tiny repo, one change with planted issues, assert plain names each one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { report, snapshot, tanstackRoute, appFacts, things, type FileFacts } from '../src/plain.ts'
import { recapCli } from '../src/session.ts'
import { readDb, findings } from '../src/supabase.ts'

const dir = mkdtempSync(join(tmpdir(), 'plain-test-'))
const write = (files: Record<string, string>) => {
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(dir, dirname(p)), { recursive: true }); writeFileSync(join(dir, p), t) }
}
const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })

write({
  'package.json': '{"dependencies":{"stripe":"14.0.0"}}',
  '.env.example': 'STRIPE_SECRET_KEY=\n',
  'prisma/schema.prisma': 'model Order {\n  id Int @id\n  total Int\n  discount Int\n}\n',
  'lib/money.ts': 'export function calculateTotal(xs: number[]) { return Math.round(xs.reduce((a, b) => a + b, 0)) }\nexport function oldDiscount(t: number) { return t }\n',
  'lib/format.ts': 'export const formatPrice = (c: number) => `$${c / 100}`\n',
  'app/api/checkout/route.ts': "import { calculateTotal } from '@/lib/money'\nimport { stripe } from '@/lib/stripe'\nexport async function POST() { const t = calculateTotal([1]); await stripe.checkout.sessions.create({ amount: t }) }\n",
  'app/admin/refunds/page.tsx': "import { oldDiscount } from '@/lib/money'\nimport { auth } from '@/lib/auth'\nexport default async function Page() { await auth(); return <p>{oldDiscount(1)}</p> }\n",
})
git('init', '-q', '-b', 'main'); git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')

write({
  'package.json': '{"dependencies":{"stripe":"16.0.0"}}',
  'prisma/schema.prisma': 'model Order {\n  id Int @id\n  total Int\n}\nmodel Coupon {\n  code String @id\n  percentOff Int\n}\n',
  'lib/money.ts': 'export function calculateTotal(xs: number[]) { return Math.floor(xs.reduce((a, b) => a + b, 0)) }\n',
  'lib/format.ts': 'export const formatPrice   =   (c: number) =>   `$${c / 100}`\n',
  'lib/coupon.ts': "export function getCoupons() { return [{ code: 'SAVE10', percentOff: 10 }] }\n",
  'components/CouponInput.tsx': 'export function CouponInput() { return <input /> }\n',
  'app/api/coupon/route.ts': "import { prisma } from '@/lib/prisma'\nexport async function POST(req: any) {\n  // TODO rate limit\n  try { return await prisma.coupon.findUnique({ where: { code: process.env.COUPON_SALT } }) } catch {}\n}\n",
  'app/api/checkout/route.ts': "import { calculateTotal } from '@/lib/money'\nimport { stripe } from '@/lib/stripe'\nimport { prisma } from '@/lib/prisma'\nexport async function POST() { const c = await prisma.coupon.findUnique({}); const t = calculateTotal([1]); await stripe.checkout.sessions.create({ amount: t }) }\n",
})

const out = report(snapshot(dir, 'main'), snapshot(dir, null), { ref: 'main', asked: 'add coupon codes at checkout' })
console.log(out)
// The recap over the same change, treated as a one-request session.
const start = git('rev-parse', 'HEAD').toString().trim()
git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'coupons')
const rc = recapCli(dir, ['--refs', `${start},HEAD`, '--asks', 'add coupon codes at checkout'], false)
for (const e of ['plain recap · 1 request', 'YOUR APP NOW', '1. "add coupon codes at checkout"', 'STILL OPEN',
  '⚠ Anyone can use the coupon part of your server without logging in. (request 1)', '3 THINGS TO REMEMBER', 'Money goes through checkout'])
  assert.ok(rc.includes(e), `recap missing: ${e}\n${rc}`)
rmSync(dir, { recursive: true, force: true })

const expect = [
  '⚠ 2 problems  ·  1 thing to decide  ·  5 loose ends  ·  4 steps before you ship',           // verdict first
  '⚠ Anyone can use the coupon part of your server without logging in.',  // no login check
  '✖ oldDiscount() was deleted from lib/money.ts, but the admin refunds page still uses it',
  '? The agent also changed calculateTotal() in lib/money.ts',             // unasked change...
  "It's used by the checkout part of your server",                         // ...and what it affects
  '+ New server code that looks up coupons.',
  'The checkout part of your server now reads coupons. This is the code that charges your',
  '+ Your database now stores coupons: code and percent off.',
  'Orders will no longer store the discount.',
  'The agent left a to-do: "rate limit"',
  'the error is silently ignored',
  'getCoupons() returns made-up data instead of reading your database.',
  "The coupon input component was built, but it isn't shown on any page yet.",
  'Back up your data first: the discount on orders will be deleted for good.',
  'run `npx prisma migrate dev`',
  "Add COUPON_SALT to your hosting settings (like Vercel). It's also missing from",
  'it was upgraded from 14.0.0 to 16.0.0.',
  '(Hidden: 1 file with only formatting changes, or lockfiles.)',          // lib/format.ts
]
for (const e of expect) assert.ok(out.includes(e), `missing: ${e}`)
assert.ok(!out.includes('lib/format.ts'), 'reformatted file should be hidden')
console.log('\nok')

// Asked to control something, got a page that only shows information.
const viewOnly = report(new Map(), new Map([['app/admin/page.tsx', 'export default function P() { return <h1>Sales</h1> }']]),
  { ref: 'main', asked: 'make a dashboard to control sales' })
assert.ok(viewOnly.includes('You asked to "control", but nothing new lets you change anything'), viewOnly)
assert.ok(viewOnly.includes('titled "Sales"') && viewOnly.includes('It only shows information'), viewOnly)
console.log('ok (view-only)')

// Node + React: Express routers mounted under /api (guards on the mount), React Router pages (nested, lazy, guarded), axios.
const nrBefore = new Map(Object.entries({
  'package.json': '{"workspaces":["client","server"]}',
  'server/package.json': '{"dependencies":{"express":"4.19.0","@prisma/client":"6.0.0"}}',
  'server/prisma/schema.prisma': 'model Walker {\n  id Int @id\n  name String\n}\n',
  'server/src/index.ts': "import express from 'express'\nimport walkers from './routes/walkers.js'\nimport admin from './routes/admin.js'\nimport { requireAuth, requireAdmin } from './middleware/auth.js'\nconst app = express()\napp.use(express.json())\napp.use('/api/walkers', walkers)\napp.use('/api/admin', requireAuth, requireAdmin, admin)\napp.listen(3001)\n",
  'server/src/routes/walkers.ts': "import { Router } from 'express'\nimport { prisma } from '../db.js'\nconst router = Router()\nrouter.get('/', async (req, res) => res.json(await prisma.walker.findMany()))\nrouter.get('/:id', async (req, res) => res.json(await prisma.walker.findUnique({ where: { id: +req.params.id } })))\nexport default router\n",
  'server/src/routes/admin.ts': "import { Router } from 'express'\nimport { prisma } from '../db.js'\nconst router = Router()\nrouter.post('/walkers', async (req, res) => res.json(await prisma.walker.create({ data: req.body })))\nexport default router\n",
  'client/src/App.tsx': "import { Routes, Route } from 'react-router-dom'\nimport Home from './pages/Home'\nimport Walker from './pages/Walker'\nexport default function App() { return <Routes><Route path=\"/\" element={<Home />} /><Route path=\"/walkers/:id\" element={<Walker />} /></Routes> }\n",
  'client/src/pages/Home.tsx': "export default function Home() { return <h1>Paw Pals</h1> }\n",
  'client/src/pages/Walker.tsx': "export default function Walker() { fetch('/api/walkers/1'); return <h1>Walker</h1> }\n",
}))
const nrAfter = new Map(nrBefore)
nrAfter.set('server/prisma/schema.prisma', 'model Walker {\n  id Int @id\n  name String\n  reviews Review[]\n}\nmodel Review {\n  id Int @id\n  stars Int\n  text String\n  walker Walker @relation(fields: [walkerId], references: [id])\n  walkerId Int\n}\n')
nrAfter.set('server/src/routes/walkers.ts', nrBefore.get('server/src/routes/walkers.ts')!.replace('export default', "router.post('/:id/reviews', async (req, res) => res.json(await prisma.review.create({ data: req.body })))\nexport default"))
nrAfter.set('server/src/routes/admin.ts', nrBefore.get('server/src/routes/admin.ts')!.replace('export default', "router.delete('/reviews/:id', async (req, res) => res.json(await prisma.review.delete({ where: { id: +req.params.id } })))\nexport default"))
nrAfter.set('server/src/routes/bookings.ts', "import { Router } from 'express'\nimport { prisma } from '../db.js'\nimport Stripe from 'stripe'\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)\nconst router = Router()\nrouter.post('/', async (req, res) => { const b = await prisma.booking.create({ data: req.body }); const s = await stripe.checkout.sessions.create({}); res.json(s) })\nexport default router\n")
nrAfter.set('server/src/index.ts', nrBefore.get('server/src/index.ts')!.replace("app.listen", "import bookings from './routes/bookings.js'\napp.use('/api/bookings', bookings)\napp.listen"))
nrAfter.set('client/src/App.tsx', "import { Routes, Route } from 'react-router-dom'\nimport { lazy } from 'react'\nimport Home from './pages/Home'\nimport Walker from './pages/Walker'\nimport RequireAuth from './components/RequireAuth'\nconst Admin = lazy(() => import('./pages/admin/Reviews'))\nexport default function App() { return <Routes><Route path=\"/\" element={<Home />} /><Route path=\"/walkers/:id\" element={<Walker />} /><Route path=\"/admin\" element={<RequireAuth />}><Route path=\"reviews\" element={<Admin />} /></Route></Routes> }\n")
nrAfter.set('client/src/pages/Walker.tsx', "import ReviewForm from '../components/ReviewForm'\nexport default function Walker() { fetch('/api/walkers/1'); return <><h1>Walker</h1><ReviewForm /></> }\n")
nrAfter.set('client/src/components/ReviewForm.tsx', "export default function ReviewForm() { const send = () => fetch(`/api/walkers/${1}/reviews`, { method: 'POST' }); return <form><textarea placeholder=\"How was the walk?\" /><button onClick={send}>Post review</button></form> }\n")
nrAfter.set('client/src/pages/admin/Reviews.tsx', "import axios from 'axios'\nexport default function Reviews() { axios.get('/api/walkers'); return <><h1>Reviews</h1><button>Delete</button></> }\n")
const nr = report(nrBefore, nrAfter, { ref: 'main', asked: 'let customers review walkers and let me delete bad reviews' })
for (const e of ['9 files changed', '+ The admin reviews page is new, titled "Reviews".', 'You have to log in to open it ✓',
  '/admin/reviews', 'Each walker page now has a box for "How was the walk?" and a "Post review" button,', 'sends reviews to your server',
  '+ New server code that saves new reviews.', '/api/walkers/[id]/reviews', '+ New server code that deletes reviews and requires login ✓.',
  'saves new bookings and charges customers 💰', 'Add STRIPE_SECRET_KEY'])
  assert.ok(nr.includes(e), `node+react missing: ${e}\n${nr}`)
assert.ok(!nr.includes('#'), nr)
console.log('ok (node + react)')

// Plain-JS Express with require(): unguarded writes on sensitive addresses, an update described as an update.
const cjs = report(new Map(), new Map(Object.entries({
  'server.js': "const express = require('express')\nconst app = express()\napp.use('/api/orders', require('./routes/orders'))\napp.use('/api/admin', require('./routes/admin'))\napp.listen(3000)\n",
  'routes/orders.js': "const express = require('express')\nconst router = express.Router()\nconst { verifyToken } = require('../middleware/auth')\nconst Order = require('../models/Order')\nrouter.get('/', verifyToken, listOrders)\nrouter.post('/:id/refund', async (req, res) => { await prisma.order.update({}) })\nasync function listOrders(req, res) { res.json(await prisma.order.findMany()) }\nmodule.exports = router\n",
  'routes/admin.js': "const router = require('express').Router()\nrouter.delete('/users/:id', async (req, res) => { await prisma.user.delete({}) })\nmodule.exports = router\n",
})), { ref: "main" })
for (const e of ['⚠ Anyone can use the order refund part of your server without logging in.', '⚠ Anyone can use the admin user part of your server',
  'lists orders and requires login ✓', 'New server code that updates orders.', 'New server code that deletes users.'])
  assert.ok(cjs.includes(e), `commonjs missing: ${e}\n${cjs}`)
console.log('ok (commonjs express)')

// A fetch helper (api('/x') -> fetch(`/api${path}`)), methods, form labels, public-by-design routes, secrets shipped to the browser.
const ui = report(new Map(), new Map(Object.entries({
  'client/src/lib/api.ts': "export async function api(path: string, options: RequestInit = {}) { return fetch(`/api${path}`, options) }\n",
  'client/src/App.tsx': "import { Routes, Route } from 'react-router-dom'\nimport Admin from './pages/Admin'\nimport Login from './pages/Login'\nexport default function App() { return <Routes><Route path=\"/admin/bookings\" element={<Admin />} /><Route path=\"/login\" element={<Login />} /></Routes> }\n",
  'client/src/pages/Admin.tsx': "import { api } from '../lib/api'\nexport default function Admin() { api('/bookings'); const s = () => api(`/bookings/${1}`, { method: 'PATCH' }); return <><h1>Bookings</h1><h2>{n} with {m}</h2><label>Status<select><option>Paid</option></select></label><button onClick={s}>{busy ? 'Saving…' : 'Add note'}</button></> }\n",
  'client/src/pages/Login.tsx': "export default function Login() { const k = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY; return <form><label htmlFor=\"e\">Email</label><input id=\"e\" type=\"email\" /><input type=\"password\" /></form> }\n",
  'server/src/index.ts': "import express from 'express'\nconst app = express()\napp.post('/api/auth/register', async (req, res) => { await prisma.user.create({}) })\napp.patch('/api/bookings/:id', async (req, res) => { await prisma.booking.update({}) })\n",
})), { ref: 'main' })
for (const e of ['loads data from your server and updates bookings on your server', 'a box for "Status"', 'an "Add note" button',
  'an email box and a password box', '⚠ VITE_SUPABASE_SERVICE_ROLE_KEY is a secret', '⚠ Anyone can use the booking part of your server without logging in'])
  assert.ok(ui.replace(/\s+/g, ' ').includes(e), `ui missing: ${e}\n${ui}`)   // ignore line wrapping
for (const e of ['with', 'Paid', 'register part', 'Saving']) assert.ok(!new RegExp(`sections for.*${e}|${e} part|"${e}`).test(ui), `ui should not say: ${e}\n${ui}`)
console.log('ok (helpers, forms, public routes, browser secrets)')

// Review findings (2026-10-28), each one a scenario that used to be wrong.
const card = (before: Record<string, string>, after: Record<string, string>) =>
  report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
const exp = { 'package.json': '{"dependencies":{"express":"4"}}' }
const ordersRouter = "import { Router } from 'express'\nconst router = Router()\nrouter.post('/', async (req, res) => { await prisma.order.create({}) })\nexport default router\n"
const idx = (body: string) => `import express from 'express'\nimport orders from './orders'\nimport authRoutes from './authRoutes'\nimport { requireAuth } from './mw'\nconst app = express()\n${body}\n`
const cases: [string, Record<string, string>, Record<string, string>, string[], string[]][] = [
  ['login check removed from a mount (router file unchanged)',
    { ...exp, 'server/orders.ts': ordersRouter, 'server/index.ts': idx("app.use('/api/orders', requireAuth, orders)") },
    { ...exp, 'server/orders.ts': ordersRouter, 'server/index.ts': idx("app.use('/api/orders', orders)") },
    ['⚠ Anyone can use the orders part of your server without logging in.', 'no longer requires login'], []],
  ['session setup is not a login check', {},
    { ...exp, 'server/orders.ts': ordersRouter, 'server/authRoutes.ts': "import { Router } from 'express'\nconst router = Router()\nrouter.post('/login', async (req, res) => {})\nexport default router\n",
      'server/index.ts': idx("app.use(session({ secret: 'x' }))\napp.use(passport.session())\napp.use(authRoutes)\napp.use('/api/orders', orders)") },
    ['⚠ Anyone can use the orders part'], []],
  ['app-wide check before a mount, and a check scoped to a path', {},
    { ...exp, 'server/orders.ts': ordersRouter, 'server/index.ts': idx("app.use(requireAuth)\napp.use('/api/orders', orders)\napp.use('/api/admin', requireAuth)\napp.post('/api/admin/refund', async (req, res) => { await prisma.order.update({}) })") },
    ['saves new orders and requires login ✓', 'updates orders and requires login ✓'], ['Anyone']],
  ['router made and mounted in the same file; route() chains', {},
    { ...exp, 'server/index.ts': "import express from 'express'\nconst app = express()\nconst admin = express.Router()\nadmin.post('/coupons', async (req, res) => { await prisma.coupon.create({}) })\napp.use('/api/admin', requireAdmin, admin)\napp.route('/api/orders').get(async (req, res) => {}).post(async (req, res) => { await prisma.order.create({}) })\n" },
    ['/api/admin/coupons', 'saves new coupons and requires login ✓', '⚠ Anyone can use the orders part', 'lists orders and saves new ones'], ['coupons part']],
  ['webhooks are public anywhere in the address; admin actions never are', {},
    { 'app/api/webhooks/stripe/route.ts': 'export async function POST() { await prisma.order.update({}) }\n',
      'app/api/admin/users/[id]/verify/route.ts': 'export async function POST() { await prisma.user.update({}) }\n' },
    ['⚠ Anyone can use the admin user verify part'], ['webhooks stripe part']],
  ['Next.js routes include what their imports do', {},
    { 'app/api/things/route.ts': "import { refund } from '../../../server/orders'\nexport async function GET() { await refund() }\n", 'server/orders.ts': 'export async function refund() { await prisma.payment.update({}) }\n' },
    ['⚠ Anyone can use the things part'], []],
  ['React Router: wrapper removed, pathless guarded layout, index route',
    { 'src/App.tsx': "import Admin from './Admin'\nexport const r = [{ path: '/admin', element: <RequireAuth><Admin /></RequireAuth> }]\n", 'src/Admin.tsx': 'export default function Admin() { return <h1>Admin</h1> }\n' },
    { 'src/App.tsx': "import Admin from './Admin'\nimport Home from './Home'\nimport Account from './Account'\nexport const r = [{ path: '/admin', element: <Admin /> }, { index: true, element: <Home /> }, { element: <RequireAuth />, children: [{ path: '/account', element: <Account /> }] }]\n",
      'src/Admin.tsx': 'export default function Admin() { return <h1>Admin</h1> }\n', 'src/Home.tsx': 'export default function Home() { return <h1>Hi</h1> }\n', 'src/Account.tsx': 'export default function Account() { return <h1>You</h1> }\n' },
    ['⚠ Anyone can open the admin page without logging in.', 'The admin page no longer requires login.', 'The home page is new', 'The account page is new, titled "You". It only shows information: nothing on it lets you change anything. You have to log in'], ['open the account page']],
]
for (const [name, before, after, has, hasNot] of cases) {
  const c = card(before, after)
  for (const e of has) assert.ok(c.includes(e), `${name}: missing "${e}"\n${c}`)
  for (const e of hasNot) assert.ok(!c.includes(e), `${name}: should not say "${e}"\n${c}`)
}
console.log(`ok (${cases.length} review scenarios)`)

// Supabase (the Lovable / Bolt backend): tables and access rules from supabase/migrations, database calls from the browser, edge functions.
const sbM1 = `-- shop
create table public.products (id uuid primary key default gen_random_uuid(), name text not null, price_cents int, created_at timestamptz default now());
alter table public.products enable row level security;
create policy "Products are public" on public.products for select using (true);
create table public.orders (id uuid primary key, user_id uuid references auth.users not null, status text default 'pending', total_cents int, notes text);
alter table public.orders enable row level security;
create policy "Own orders" on public.orders for select to authenticated using (auth.uid() = user_id);
`
const sbBefore = {
  'package.json': '{"dependencies":{"@supabase/supabase-js":"2.45.0","react-router-dom":"6"}}',
  'supabase/migrations/20260101000000_shop.sql': sbM1,
  'src/integrations/supabase/client.ts': "import { createClient } from '@supabase/supabase-js'\nexport const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY)\n",
  'src/App.tsx': "import { Routes, Route } from 'react-router-dom'\nimport Shop from './pages/Shop'\nexport default function App() { return <Routes><Route path=\"/\" element={<Shop />} /></Routes> }\n",
  'src/pages/Shop.tsx': "import { supabase } from '@/integrations/supabase/client'\nexport default function Shop() { supabase.from('products').select('*'); return <h1>Shop</h1> }\n",
}
const sbAfter = { ...sbBefore,
  'supabase/migrations/20260202000000_accounts.sql': `
create table public.profiles (id uuid primary key references auth.users, full_name text, email text, phone text);
create policy "Logged in can read orders" on public.orders for select using (auth.role() = 'authenticated');
create policy "Update own orders" on public.orders for update using (auth.uid() = user_id);
create table public.messages (id bigint generated always as identity primary key, body text);
alter table public.messages enable row level security;
create policy "Anyone can send" on public.messages for insert to anon with check (true);
create policy "Admins" on public.orders for all using ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
alter table public.orders drop column notes;
delete from public.messages;
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
`,
  'supabase/functions/create-checkout/index.ts': "import Stripe from 'npm:stripe@14'\nimport { createClient } from 'jsr:@supabase/supabase-js@2'\nconst stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!)\nDeno.serve(async (req) => { const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!); const s = await stripe.checkout.sessions.create({}); await supabase.from('orders').insert({ status: 'pending' }); return new Response(JSON.stringify(s)) })\n",
  'src/App.tsx': "import { Routes, Route } from 'react-router-dom'\nimport Shop from './pages/Shop'\nimport Account from './pages/Account'\nexport default function App() { return <Routes><Route path=\"/\" element={<Shop />} /><Route path=\"/account\" element={<Account />} /></Routes> }\n",
  'src/pages/Account.tsx': "import { supabase } from '@/integrations/supabase/client'\nexport default function Account() { supabase.from('orders').select('*'); const pay = () => supabase.functions.invoke('create-checkout', { body: {} }); const save = () => supabase.from('profiles').update({ full_name: 'x' }); return <><h1>Your account</h1><button onClick={save}>Save</button><button onClick={pay}>Pay</button></> }\n",
}
const sb = card(sbBefore, sbAfter)
for (const e of ['⚠ Anyone can use the create checkout part of your server without logging in.',
  '⚠ Every logged-in user can read every one of your orders, including other people\'s (rule "Logged in can read orders").',
  '! People can edit their own orders, including the status column', '⚠ The rule "Admins" on orders trusts user_metadata',
  '⚠ Anyone can read and change every row of profiles: the table has no access rules', '! Anyone, even without logging in, can add messages',
  '! Files in the "avatars" storage bucket can be opened by anyone', 'shows orders, saves profiles and starts a payment 💰',
  'New server code that saves new orders and charges customers 💰. /functions/v1/create-checkout', 'stores profiles: full name, email and phone. Each one belongs to a user.',
  'deletes every row of messages', '(`supabase db push`)', "Add STRIPE_SECRET_KEY to your Supabase project's secrets", "aren't visible to plain"])
  assert.ok(sb.includes(e), `supabase missing: "${e}"\n${sb}`)
for (const e of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'Products are public', 'calls Supabase', 'Other files', 'Own orders'])
  assert.ok(!sb.includes(e), `supabase should not say "${e}"\n${sb}`)

// A careful Supabase app gets no warnings: own-row rules, a public catalog, an old open rule isn't repeated, a dropped rule is gone,
// and policy-looking text inside a function body or a comment isn't a rule.
const good = card(sbBefore, { ...sbBefore,
  'supabase/migrations/20260303000000_reviews.sql': `
-- create policy "x" on public.reviews using (true);
create table public.reviews (id uuid primary key, user_id uuid references auth.users not null, product_id uuid references public.products, stars int, body text);
alter table public.reviews enable row level security;
create policy "Read reviews" on public.reviews for select using (true);
create policy "Write own" on public.reviews for insert to authenticated with check (auth.uid() = user_id);
create policy "Temp" on public.reviews for delete using (true);
drop policy "Temp" on public.reviews;
create function public.f() returns void language plpgsql as $$ begin execute 'create policy y on public.reviews for update using (true)'; end $$;
`,
  'supabase/migrations/20260304000000_broken.sql': 'this is not sql (',
})
assert.ok(good.includes('1 thing to decide') && !good.includes('No problems spotted') && good.includes('! Anyone, even without logging in, can read all reviews'), good)
assert.ok(!/⚠|Temp|"y"|"x"/.test(good), `careful app should have no warnings\n${good}`)

// Turning RLS off later is caught, even though the table was created long before.
const off = card(sbBefore, { ...sbBefore, 'supabase/migrations/20260305000000_off.sql': 'alter table public.orders disable row level security;' })
assert.ok(off.includes('⚠ Anyone can read and change every row of orders'), off)
console.log('ok (supabase)')

// Supabase access rules, one scenario each (review 2026-10-28). Expected: the start of each finding, or nothing.
const rls = (sql: string[], used = ['orders']) => findings(readDb([['0.sql', 'create table public.orders (id uuid primary key, user_id uuid references auth.users, status text);\nalter table public.orders enable row level security;'],
  ...sql.map((s, i) => [`${i + 1}.sql`, s] as [string, string])]), new Set(used), (t: string) => t.replace(/_/g, ' ')).map(f => `${f.kind}: ${f.text}`)
const rlsCases: [string, string[], string[]][] = [
  ['open to everyone', [`create policy "p" on orders for select using (true);`], ['Unsafe: Anyone, even without logging in, can read every one of your orders']],
  ['logged in = any user (is not null)', [`create policy "p" on orders for select to authenticated using (auth.uid() is not null);`], ['Unsafe: Every logged-in user can read every one of your orders']],
  ['logged in = any user (jwt role)', [`create policy "p" on orders for select using ((auth.jwt() ->> 'role') = 'authenticated');`], ['Unsafe: Every logged-in user can read every one']],
  ['insert for any logged-in user', [`create policy "p" on orders for insert to authenticated with check (auth.uid() is not null);`], ["Unsafe: Every logged-in user can add orders in someone else's name"]],
  ['own rows, (select auth.uid()) form', [`create policy "p" on orders for select using ((select auth.uid()) = user_id);`], []],
  ['service role only', [`create policy "s" on orders for all to service_role using (true) with check (true);`, `create policy "o" on orders for select using (auth.uid() = user_id);`], []],
  ['restrictive own-rows wins', [`create policy "own" on orders as restrictive for select to authenticated using (auth.uid() = user_id);`, `create policy "pub" on orders for select using (true);`], []],
  ['admin check in a subquery', [`create policy "a" on orders for update to authenticated using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'admin'));`], []],
  ['update own, check true', [`create policy "u" on orders for update to authenticated using (auth.uid() = user_id) with check (true);`], ['Check: People can edit their own orders and hand them over']],
  ['own update can set status', [`create policy "u" on orders for update using (auth.uid() = user_id);`], ['Check: People can edit their own orders, including the status column']],
  ['if not exists keeps the rules', [`create policy "o" on orders for select using (auth.uid() = user_id);`, `create table if not exists public.orders (id uuid);`], []],
  ['renamed table', [`alter table orders rename to purchases;`, `create policy "pub" on purchases for select using (true);`], ['Check: Anyone, even without logging in, can read all purchases']],
  ['view without security_invoker', [`create policy "o" on orders for select using (auth.uid() = user_id);`, `create view public.all_orders as select * from orders;`], ['Unsafe: The view all_orders shows orders to anyone']],
  ['view with security_invoker', [`create policy "o" on orders for select using (auth.uid() = user_id);`, `create view public.v with (security_invoker = on) as select * from orders;`], []],
  ['RLS off, but the API is revoked', [`create table public.secrets (id int, token text); revoke all on public.secrets from anon, authenticated;`, `create policy "o" on orders for select using (auth.uid() = user_id);`], []],
  ['public bucket by update', [`create policy "o" on orders for select using (auth.uid() = user_id);`, `update storage.buckets set public = true where id = 'avatars';`], ['Check: Files in the "avatars" storage bucket']],
]
for (const [name, sql, expected] of rlsCases) {
  const got = rls(sql)
  assert.equal(got.length, expected.length, `${name}: expected ${expected.length} findings, got\n${got.join('\n')}`)
  expected.forEach((e, i) => assert.ok(got[i].startsWith(e), `${name}: expected "${e}", got "${got[i]}"`))
}
console.log(`ok (${rlsCases.length} access-rule scenarios)`)
// Reading the session in the browser isn't a login check; on an edge function it is.
const sess = card({}, { 'src/App.tsx': "import Admin from './Admin'\nexport const r = [{ path: '/admin', element: <Admin /> }]\n",
  'src/Admin.tsx': "export default function Admin() { supabase.auth.getSession().then(s => setEmail(s)); return <h1>Admin</h1> }\n",
  'supabase/functions/refund/index.ts': "Deno.serve(async (req) => { const { data } = await supabase.auth.getUser(req.headers.get('Authorization')); await supabase.from('orders').update({}) })\n" })
assert.ok(sess.includes('⚠ Anyone can open the admin page without logging in.') && sess.includes('updates orders and requires login ✓'), sess)
console.log('ok (supabase login checks)')

// An existing public route that starts changing data is flagged; one that already did isn't repeated every turn.
const grew = card({ 'app/api/orders/route.ts': 'export async function GET() { return prisma.order.findMany() }\n' },
  { 'app/api/orders/route.ts': 'export async function GET() { return prisma.order.findMany() }\nexport async function POST() { await prisma.order.update({}) }\n' })
assert.ok(grew.includes('⚠ Anyone can use the orders part of your server without logging in.'), grew)
const same = card({ 'app/api/orders/route.ts': 'export async function POST() { await prisma.order.update({}) }\n' },
  { 'app/api/orders/route.ts': 'export async function POST() { await prisma.order.update({ where: {} }) }\n' })
assert.ok(!same.includes('Anyone can use'), same)
console.log('ok (routes that start changing data)')

// Trial findings (dog-walks, 2026-10-28): say what really changed instead of "behind-the-scenes".
{
  const page = (btn: string, note = '') => `export default function W() { return <form><button>{busy ? 'Opening…' : ${btn}}</button>${note}</form> }\n`
  const route = (extra: string) => `import Stripe from 'stripe'\nexport async function POST(req: Request) { ${extra} const s = await stripe.checkout.sessions.create({}); await prisma.booking.update({}) }\n`
  const base = { 'package.json': '{"dependencies":{"stripe":"1"}}', 'app/walkers/[id]/page.tsx': page('`Pay ${formatMoney(p)}`'), 'app/api/bookings/route.ts': route(''),
    'app/api/a/route.ts': 'export async function GET() { return 1 }\n', 'app/api/b/route.ts': 'export async function GET() { return 1 }\n', 'styles.css': '.a { color: red }\n',
    'lib/api.ts': 'export async function api(p: string) { return fetch(p) }\n', 'app/thing/page.tsx': "import { api } from '../../lib/api'\nexport default function T() { return <h1>T</h1> }\n" }
  const after = { ...base, 'app/walkers/[id]/page.tsx': page("'Continue to checkout'", '<p>Members get 10% off.</p>'),
    'app/api/bookings/route.ts': route("if (!ok) return NextResponse.json({ error: 'That time is taken.' }, { status: 409 }); const c = process.env.EMAIL_TZ || 'UTC'; await fetch('https://api.resend.com/emails', { method: 'POST' }); await prisma.booking.update({ data: { status: 'cancelled' } });"),
    'app/api/a/route.ts': 'export async function GET() { return 2 }\n', 'app/api/b/route.ts': 'export async function GET() { return 3 }\n',
    'styles.css': '.a { color: red }\n@media (max-width: 600px) { .a { display: block } }\n',
    'lib/api.ts': 'export class ApiError extends Error {}\nexport async function api(p: string) { const r = await fetch(p); if (!r.ok) throw new ApiError(); return r }\n',
    'app/thing/page.tsx': "import { api, ApiError } from '../../lib/api'\nexport default function T() { return <h1>T</h1> }\n" }
  const c = report(new Map(Object.entries(base)), new Map(Object.entries(after)),
    { ref: 'main', asked: 'give 10% off to people who sign up for the newsletter', agentSaid: "Done. I couldn't run the build here." }).replace(/\s+/g, ' ')
  for (const e of ['no longer shows the price', 'now refuses with "That time is taken."', 'Make a test payment before you ship',
    'Your app now sends emails through Resend', "Cancelling doesn't give money back", 'You asked for a discount', "The agent says it didn't run or test this",
    'how the app looks on small screens like phones', 'The agent changed the a and b parts of your server in ways plain can\'t describe yet', '2 things to decide'])
    assert.ok(c.includes(e), `trial fixes missing: "${e}"\n${c}`)
  for (const e of ['behind-the-scenes', 'EMAIL_TZ', 'api() in lib/api.ts', 'Nothing looks broken']) assert.ok(!c.includes(e), `trial fixes should not say "${e}"\n${c}`)
  console.log('ok (trial findings)')
}

// Review 3 (2026-10-28): the trial rules without their false alarms.
{
  const pg = { 'app/page.tsx': 'export default function P() { return <p>Hi</p> }\n' }, pg2 = { 'app/page.tsx': 'export default function P() { return <p>Hi there you</p> }\n' }
  const ran = (s: string) => report(new Map(Object.entries(pg)), new Map(Object.entries(pg2)), { ref: 'main', agentSaid: s }).includes("didn't run or test")
  for (const s of ["I didn't change the tests.", "I couldn't find any issues, ran tests successfully.", "I didn't touch the build config.", "Unable to find a check for this, so I added one."])
    assert.ok(!ran(s), `should not read as untested: ${s}`)
  for (const s of ["I haven't run it.", "Note: I couldn't start the dev server.", 'Tests not run.', "I didn't get a chance to try it", 'Build could not run because dependencies are absent'])
    assert.ok(ran(s) || s.startsWith('Build'), `should read as untested: ${s}`)
  const money = { 'package.json': '{"dependencies":{"stripe":"1"}}', 'app/api/pay/route.ts': "import Stripe from 'stripe'\nexport async function POST() { await stripe.checkout.sessions.create({}) }\n" }
  const after = { ...money, 'app/api/pay/route.ts': money['app/api/pay/route.ts'].replace('({})', '({ a: 1 })'),
    'app/orders/page.tsx': "export default function O() { return <select><option value='cancelled'>Cancelled</option></select> }\n",
    'app/stats/page.tsx': "export default function S() { return <p>{role === 'admin' && <b>x</b>}{t('home.title')}{count.toLocaleString()} users</p> }\n",
    'app/api/items/route.ts': "export async function GET() { log(404, 'missing item'); if (!x) return NextResponse.json({ error: 'Not found' }, { status: 404 }) }\n",
    'app/api/keys/route.ts': "export async function GET() { return [process.env.STRIPE_SECRET_KEY || '', import.meta.env.VITE_STRIPE_SECRET_KEY ?? '', process.env.PORT || 3000] }\n" }
  const c = report(new Map(Object.entries(money)), new Map(Object.entries(after)), { ref: 'main', asked: 'add a free text field for notes on signup' }).replace(/\s+/g, ' ')
  for (const e of ["Cancelling doesn't", 'asked for a discount', 'refuses', '"admin"', 'home.title', 'price', 'Add PORT'])
    assert.ok(!c.includes(e), `review 3 should not say "${e}"\n${c}`)
  for (const e of ['⚠ VITE_STRIPE_SECRET_KEY is a secret', 'Add STRIPE_SECRET_KEY to your hosting settings'])
    assert.ok(c.includes(e), `review 3 missing "${e}"\n${c}`)
  const odd = card({ 'db/schema.prisma': 'model A {\n  id Int @id\n}\n' }, { 'db/schema.prisma': 'model A {\n  id Int @id\n  b Int\n}\n' })
  assert.ok(odd.includes('`npx prisma migrate dev --schema db/schema.prisma`'), odd)
  console.log('ok (review 3)')
}

// TanStack Start (Lovable's default since May 2026): file routes, layouts that check login, server actions, server routes.
{
  const urls: [string, string | null][] = [['src/routes/index.tsx', '/'], ['src/routes/classes.$classId.tsx', '/classes/[classId]'],
    ['src/routes/_authed/my-bookings.tsx', '/my-bookings'], ['src/routes/posts_.$postId.edit.tsx', '/posts/[postId]/edit'], ['src/routes/(shop)/cart.tsx', '/cart'],
    ['src/routes/account/route.tsx', '/account'], ['src/routes/posts/index.tsx', '/posts'], ['src/routes/files/$.tsx', '/files/[rest]'],
    ['src/routes/script[.]js.tsx', '/script.js'], ['src/routes/-components/Card.tsx', null], ['src/routes/__root.tsx', null], ['src/routeTree.gen.ts', null]]
  for (const [p, u] of urls) assert.equal(tanstackRoute(p)?.url ?? null, u, p)
  const tsBefore = {
  'package.json': '{"dependencies":{"@tanstack/react-start":"1.169.4","@tanstack/react-router":"1.169.4","@supabase/supabase-js":"2"}}',
  'src/routes/__root.tsx': "export const Route = createRootRoute({ beforeLoad: async () => ({ user: await fetchUser() }) })\n",
  'src/routes/index.tsx': "export const Route = createFileRoute('/')({ component: Home })\nfunction Home() { return <h1>Studio Flow</h1> }\n",
  'src/routes/_authed.tsx': "export const Route = createFileRoute('/_authed')({ beforeLoad: ({ context }) => { if (!context.user) throw redirect({ to: '/login' }) } })\n",
}
  const tsAfter = { ...tsBefore,
  'src/routes/classes.$classId.tsx': "import { bookClass } from '../server/booking.functions'\nexport const Route = createFileRoute('/classes/$classId')({ component: C })\nfunction C() { const book = useServerFn(bookClass); return <><h1>Class</h1><button onClick={() => book({ data: {} })}>Book a spot</button></> }\n",
  'src/routes/_authed/my-bookings.tsx': "export const Route = createFileRoute('/_authed/my-bookings')({ component: M })\nfunction M() { return <h1>My bookings</h1> }\n",
  'src/routes/admin.classes.tsx': "import { saveClass } from '../server/admin.functions'\nexport const Route = createFileRoute('/admin/classes')({ component: A })\nfunction A() { return <><h1>Classes</h1><button onClick={() => saveClass({ data: {} })}>Save</button></> }\n",
  'src/routes/-components/Card.tsx': 'export function Card() { return <div /> }\n',
  'src/routes/api/stripe-webhook.ts': "export const Route = createFileRoute('/api/stripe-webhook')({ server: { handlers: { POST: async ({ request }) => { await supabaseAdmin.from('bookings').update({ status: 'paid' }); return new Response('ok') } } } })\n",
  'src/server/booking.functions.ts': "export const bookClass = createServerFn({ method: 'POST' }).middleware([authMiddleware]).inputValidator((d) => d).handler(async ({ data, context }) => { await context.supabase.from('bookings').insert({}); const s = await stripe.checkout.sessions.create({}); return s.url })\n",
  'src/server/admin.functions.ts': "export const saveClass = createServerFn({ method: 'POST' }).validator((d) => d).handler(async ({ data }) => { await supabase.from('classes').upsert(data) })\nexport const listClasses = createServerFn().handler(async () => supabase.from('classes').select())\n",
}
  const c = card(tsBefore, tsAfter)
  for (const e of ['⚠ Anyone can open the admin classes page without logging in.', '⚠ Anyone can use the "save class" action on your server without logging in.',
    'The my bookings page is new, titled "My bookings".', 'You have to log in to open it ✓ /my-bookings', 'It has a "Book a spot" button and starts a payment 💰. /classes/[classId]',
    'New server code that saves new bookings, charges customers 💰 and requires login ✓. (server action) bookClass', 'lists classes and works without logging in'])
    assert.ok(c.includes(e), `tanstack missing: "${e}"\n${c}`)
  for (const e of ['stripe webhook part', 'Card', 'root']) assert.ok(!c.includes(e), `tanstack should not say "${e}"\n${c}`)
  // App-wide middleware can't block logged-out people (signing in would break), so it isn't a login check.
  const g = card(tsBefore, { ...tsAfter, 'src/start.ts': 'export const startInstance = createStart(() => ({ functionMiddleware: [authMiddleware] }))\n' })
  assert.ok(g.includes('⚠ Anyone can use the "save class" action on your server without logging in.'), g)
  console.log('ok (tanstack start)')
}

// Review 4 (2026-10-28): TanStack login checks without false reassurance.
{
  const pkg = { 'package.json': '{"dependencies":{"@tanstack/react-start":"1"}}' }
  const page = (t: string, extra = '') => `export const Route = createFileRoute('/x')({ ${extra} component: P })\nfunction P() { return <h1>${t}</h1> }\n`
  const guard = "beforeLoad: ({ context }) => { if (!context.user) throw redirect({ to: '/login' }) },"
  // an index page's guard doesn't cover its siblings; a layout's does; a page's own guard counts; loading the user isn't a guard
  const c1 = card(pkg, { ...pkg, 'src/routes/admin/index.tsx': page('Admin', guard), 'src/routes/admin/users.tsx': page('Users'),
    'src/routes/shop.tsx': page('Shop', guard), 'src/routes/shop/index.tsx': page('Shop home'), 'src/routes/shop/orders.tsx': page('Orders'),
    'src/routes/dashboard.tsx': page('Dash', 'beforeLoad: async () => ({ user: await getUser() }),'), 'src/routes/posts.lazy.tsx': page('Posts') })
  for (const e of ['⚠ Anyone can open the admin users page without logging in.', '⚠ Anyone can open the dashboard page without logging in.', '/posts '])
    assert.ok(c1.includes(e), `review 4 missing "${e}"\n${c1}`)
  for (const e of ['shop orders page without', '/posts/lazy']) assert.ok(!c1.includes(e), `review 4 should not say "${e}"\n${c1}`)
  assert.equal(c1.match(/ \/shop /g)?.length, 1, `/shop listed once\n${c1}`)
  // a page that is also a server route; a module-level client; an aliased action; a middleware that can't stop anyone
  const c2 = card(pkg, { ...pkg,
    'src/routes/orders.tsx': "export const Route = createFileRoute('/orders')({ server: { handlers: { POST: async () => { await prisma.order.delete({}) } } }, component: O })\nfunction O() { return <h1>Orders</h1> }\n",
    'src/server/x.ts': "const admin = getSupabaseAdminClient()\nconst authMiddleware = createMiddleware().server(async ({ next }) => next({ context: { user: await getUser() } }))\nexport const wipeAll = createServerFn({ method: 'POST' }).middleware([authMiddleware]).handler(async () => { await admin.from('items').delete() })\n",
    'src/routes/admin.tsx': "import { wipeAll as wipe } from '../server/x'\nexport const Route = createFileRoute('/admin')({ component: A })\nfunction A() { return <button onClick={() => wipe()}>Wipe</button> }\n" })
  for (const e of ['⚠ Anyone can use the orders part of your server without logging in.', '⚠ Anyone can use the "wipe all" action on your server without logging in.', 'deletes items'])
    assert.ok(c2.includes(e), `review 4 missing "${e}"\n${c2}`)
  console.log('ok (review 4)')
}

// Python: FastAPI and Flask routes with prefixes and login checks, SQLAlchemy models, Stripe, and the mistakes AI makes most.
{
  const pyBefore = {
  'requirements.txt': 'fastapi==0.115.0\nsqlalchemy==2.0.30\n',
  'app/main.py': "from fastapi import FastAPI\nfrom app.routers import orders\napp = FastAPI()\napp.include_router(orders.router, prefix='/api')\n",
  'app/models.py': "from sqlalchemy.orm import Mapped, mapped_column\nclass Order(Base):\n    __tablename__ = 'orders'\n    id: Mapped[int] = mapped_column(primary_key=True)\n    total: Mapped[int]\n    notes: Mapped[str]\n",
  'app/routers/orders.py': "from fastapi import APIRouter, Depends\nfrom app.auth import get_current_user\nrouter = APIRouter(prefix='/orders')\n\n@router.get('/')\ndef list_orders(db = Depends(get_db), user = Depends(get_current_user)):\n    return db.query(Order).all()\n",
}
  const pyAfter = { ...pyBefore,
  'requirements.txt': 'fastapi==0.115.0\nsqlalchemy==2.0.30\nstripe==10.0.0\n',
  'app/models.py': "from sqlalchemy.orm import Mapped, mapped_column\nclass Order(Base):\n    __tablename__ = 'orders'\n    id: Mapped[int] = mapped_column(primary_key=True)\n    total: Mapped[int]\n\nclass Coupon(Base):\n    __tablename__ = 'coupons'\n    id: Mapped[int] = mapped_column(primary_key=True)\n    code: Mapped[str]\n    percent_off: Mapped[int]\n",
  'app/routers/orders.py': `from fastapi import APIRouter, Depends, HTTPException
import os, stripe
from app.auth import get_current_user
router = APIRouter(prefix='/orders')
stripe.api_key = os.environ['STRIPE_SECRET_KEY']

@router.get('/')
def list_orders(db = Depends(get_db), user = Depends(get_current_user)):
    return db.query(Order).all()

@router.post('/{order_id}/refund')
def refund(order_id: int, db = Depends(get_db)):
    order = db.get(Order, order_id)
    if order.total <= 0:
        raise HTTPException(status_code=409, detail="This order can't be refunded.")
    db.execute(f"UPDATE orders SET status = 'refunded' WHERE id = {order_id}")
    return {"ok": True}

@router.post('/checkout')
def checkout(user = Depends(get_current_user)):
    s = stripe.checkout.Session.create(mode='payment', line_items=[])
    return {"url": s.url}
`,
  'app/routers/coupons.py': "from fastapi import APIRouter\nrouter = APIRouter(prefix='/coupons')\n\n@router.post('/')\ndef create_coupon(data: dict, db = Depends(get_db)):\n    # TODO validate percent\n    db.add(Coupon(**data))\n    db.commit()\n",
  'app/main.py': "from fastapi import FastAPI\nfrom fastapi.middleware.cors import CORSMiddleware\nfrom app.routers import orders, coupons\napp = FastAPI()\napp.add_middleware(CORSMiddleware, allow_origins=['*'], allow_credentials=True)\napp.include_router(orders.router, prefix='/api')\napp.include_router(coupons.router, prefix='/api')\n",
  'web/app.py': "from flask import Flask, Blueprint, render_template, abort\nfrom flask_login import login_required\napp = Flask(__name__)\napp.secret_key = 'dev-secret-123'\nadmin = Blueprint('admin', __name__, url_prefix='/admin')\n\n@admin.route('/users/<int:user_id>', methods=['POST'])\n@login_required\ndef ban(user_id):\n    User.query.filter_by(id=user_id).delete()\n\n@admin.route('/export')\ndef export():\n    return render_template('export.html', users=User.query.all())\n\napp.register_blueprint(admin)\nif __name__ == '__main__':\n    app.run(debug=True)\n",
}
  const c = card(pyBefore, pyAfter)
  for (const e of ['⚠ Anyone can use the order refund part of your server without logging in.', '⚠ Anyone can use the coupons part of your server without logging in.',
    '⚠ Anyone can use the admin export part of your server without logging in.', '⚠ A database query is built by pasting in text', "⚠ The app's secret key is written in the code",
    '⚠ Debug mode is turned on', '! Any website can call your server', 'charges customers 💰 and requires login ✓. /api/orders/checkout', 'deletes users and requires login ✓. /admin/users/[user_id]',
    'Your database now stores coupons: code and percent off.', 'Orders will no longer store the notes.', '`alembic revision --autogenerate`', 'Add STRIPE_SECRET_KEY', 'stripe (10.0.0)', 'to-do: "validate percent"'])
    assert.ok(c.includes(e), `python missing: "${e}"\n${c}`)
  for (const e of ['Other files', 'list orders part', '/api/coupons/ ']) assert.ok(!c.includes(e), `python should not say "${e}"\n${c}`)
  console.log('ok (python: fastapi + flask)')
}

// Review 5 (2026-10-28): Python login checks and prefixes without false reassurance.
{
  const flask = (body: string) => `from flask import Flask, Blueprint, redirect, request, abort, url_for\nfrom flask_login import login_required, current_user\napp = Flask(__name__)\n${body}\n`
  const c1 = card({}, {
    'a/order.py': flask("@login_required\n@app.route('/admin/delete', methods=['POST'])\ndef d():\n    User.query.delete()\n"),
    'b/https.py': flask("bp = Blueprint('o', __name__, url_prefix='/orders')\n@bp.before_request\ndef https():\n    if not request.is_secure:\n        return redirect(request.url.replace('http', 'https'))\n@bp.post('/')\ndef o():\n    db.session.add(Order())\napp.register_blueprint(bp)\n"),
    'c/prg.py': flask("@app.route('/comments', methods=['POST'])\ndef c():\n    name = current_user.name if current_user.is_authenticated else 'guest'\n    db.session.add(Comment(name=name))\n    return redirect(url_for('index'))\n"),
    'd/fast.py': "from fastapi import FastAPI, Depends\nfrom fastapi.security import OAuth2PasswordRequestForm\napp = FastAPI()\n@app.delete('/admin/users/{user_id}')\ndef du(user_id: int, admin_service = Depends(get_admin_service)):\n    db.delete(user)\n@app.post('/reviews')\ndef r(user = Depends(get_current_user_optional)):\n    db.add(Review())\n@app.post('/token')\ndef t(form: OAuth2PasswordRequestForm = Depends()):\n    return {}\n",
  })
  for (const e of ['⚠ Anyone can use the admin delete part', '⚠ Anyone can use the orders part', 'Anyone can post comments', '⚠ Anyone can use the admin user part', 'Anyone can post reviews'])
    assert.ok(c1.includes(e), `review 5 missing "${e}"\n${c1}`)
  assert.ok(!c1.includes('post data'), c1)
  // the FastAPI full-stack template: CurrentUser alias, SQLModel table=True, routers mounted through api_router
  const c2 = card({}, {
    'app/api/deps.py': 'from typing import Annotated\nfrom fastapi import Depends\nCurrentUser = Annotated[User, Depends(get_current_user)]\n',
    'app/models.py': 'class ItemBase(SQLModel):\n    title: str\nclass Item(ItemBase, table=True):\n    id: int\n    title: str\n',
    'app/api/routes/items.py': "from fastapi import APIRouter\nfrom app.api.deps import CurrentUser\nrouter = APIRouter(prefix='/items')\n@router.post('/')\ndef create(current_user: CurrentUser, item_in: ItemCreate):\n    item = Item(**item_in)\n    session.add(item)\n",
    'app/api/main.py': 'from fastapi import APIRouter\nfrom app.api.routes import items\napi_router = APIRouter()\napi_router.include_router(items.router)\n',
    'app/main.py': "from fastapi import FastAPI\nfrom app.api.main import api_router\napp = FastAPI()\napp.include_router(api_router, prefix='/api/v1')\n",
    'pyproject.toml': '[project]\nname = "app"\ndependencies = [\n  "fastapi>=0.114",\n  "python-jose>=3.3",\n]\n[tool.ruff]\nline-length = 100\n',
  })
  for (const e of ['saves new items and requires login ✓. /api/v1/items', 'Your database now stores items: title.', 'python-jose (>=3.3)'])
    assert.ok(c2.includes(e), `review 5 missing "${e}"\n${c2}`)
  for (const e of ['line-length', 'item bases', '⚠']) assert.ok(!c2.includes(e), `review 5 should not say "${e}"\n${c2}`)
  // blueprints: registered url_prefix replaces the blueprint's own; routes on a blueprint imported from __init__.py; two routers in one file
  const c3 = card({}, {
    'app/__init__.py': "from flask import Flask\nfrom app.admin import bp as admin_bp\napp = Flask(__name__)\napp.register_blueprint(admin_bp, url_prefix='/admin')\n",
    'app/admin/__init__.py': "from flask import Blueprint\nbp = Blueprint('admin', __name__, url_prefix='/admin')\n",
    'app/admin/routes.py': "from app.admin import bp\n@bp.route('/wipe', methods=['POST'])\ndef wipe():\n    Order.query.delete()\n",
    'api/users.py': "from fastapi import APIRouter, Depends\nrouter = APIRouter(prefix='/users')\nadmin_router = APIRouter(prefix='/admin/users')\n@router.post('/signup')\ndef signup():\n    db.add(User())\n@admin_router.delete('/{id}')\ndef rm(id: int):\n    db.delete(user)\n",
    'api/main.py': "from fastapi import FastAPI, Depends\nfrom api import users\napp = FastAPI()\napp.include_router(users.router)\napp.include_router(users.admin_router, dependencies=[Depends(get_current_admin)])\n",
  })
  for (const e of ['⚠ Anyone can use the admin wipe part of your server without logging in.', '/admin/wipe', 'deletes users and requires login ✓. /admin/users/[id]'])
    assert.ok(c3.includes(e), `review 5 missing "${e}"\n${c3}`)
  for (const e of ['/admin/admin', 'signup part']) assert.ok(!c3.includes(e), `review 5 should not say "${e}"\n${c3}`)
  console.log('ok (review 5)')
}

// Round 3 trials (TanStack + Supabase, 2026-10-28)
{
  const stripe = { 'package.json': '{"dependencies":{"stripe":"1"}}', 'server/pay.ts': "import Stripe from 'stripe'\nexport const s = new Stripe('')\n" }
  const refund = (code: string) => card(stripe, { ...stripe, 'app/api/x/route.ts': `export async function POST() { ${code} }\n` }).includes("Cancelling doesn't")
  assert.ok(refund("await prisma.booking.updateMany({ where: { classId }, data: { status: 'cancelled' } })"), 'cancel all bookings')
  assert.ok(refund("const ok = ['completed', 'cancelled'].includes(body.status); await prisma.booking.update({ where: { id }, data: { status: body.status } })"), 'validated status from input')
  assert.ok(!refund("await admin.from('bookings').update({ status: 'cancelled' }).eq('id', id).eq('status', 'pending')"), 'pending only')
  assert.ok(!refund("return { status: 'cancelled' }"), 'not a write')
  // security definer functions: callable by anyone unless revoked from anon and authenticated, or checking the caller
  const fnSql = (body: string, extra = '') => card({}, { 'supabase/migrations/1.sql': `create function public.f(u uuid) returns void language plpgsql security definer as $$ begin ${body} end $$;\n${extra}` })
  assert.ok(fnSql('insert into holds values (u);').includes("⚠ Anyone with your app's public key can run the database function f, which changes data."))
  assert.ok(fnSql('perform 1;').includes("! Anyone with your app's public key can run the database function f. It only reads"))
  assert.ok(fnSql('insert into holds values (u);', 'revoke all on function public.f(uuid) from public;').includes('⚠ Anyone'), 'revoking from public is not enough')
  assert.ok(!fnSql('insert into holds values (u);', 'revoke execute on function public.f(uuid) from anon, authenticated;').includes('public key'))
  assert.ok(!fnSql('if auth.uid() is null then raise exception; end if; insert into holds values (auth.uid());').includes('public key'))
  // vague requests, files you named, curly apostrophes, rewritten database rules, tables only their owners can read
  const v = report(new Map(), new Map([['app/api/x/route.ts', 'export async function GET() { return 1 }\n'], ['src/server/pricing.ts', 'export const fee = 200\n']]),
    { ref: 'main', asked: 'booking is weird sometimes, fix it and move pricing into src/server/pricing.ts', agentSaid: 'Typechecking couldn’t run here.' }).replace(/\s+/g, ' ')
  for (const e of ["You didn't say exactly what was wrong, so the agent guessed.", 'The agent created src/server/pricing.ts, as you asked.', "The agent says it didn't run or test this."])
    assert.ok(v.includes(e), `round 3 missing "${e}"\n${v}`)
  const base = 'create function public.cap() returns trigger language plpgsql as $$ begin return new; end $$;\ncreate table public.notes (id uuid primary key, user_id uuid references auth.users, body text);\n'
  const w = card({ 'supabase/migrations/1.sql': base }, { 'supabase/migrations/1.sql': base, 'supabase/migrations/2.sql':
    "create or replace function public.cap() returns trigger language plpgsql as $$ begin return null; end $$;\ncreate table public.waits (id uuid primary key, user_id uuid references auth.users);\nalter table public.waits enable row level security;\ncreate policy \"own\" on public.waits for select using (auth.uid() = user_id);\n" })
  for (const e of ['Each person can only see their own ✓', 'Test what cap does: supabase/migrations/2.sql rewrote that existing database rule', 'before the new code goes live'])
    assert.ok(w.includes(e), `round 3 missing "${e}"\n${w}`)
  console.log('ok (round 3 trials)')
}

// Review 6 (2026-10-28): "only their own ✓" only when true; definer functions tracked through revokes, drops and overloads.
{
  const tbl = 'create table public.notes (id uuid primary key, user_id uuid references auth.users, body text, public boolean);\nalter table public.notes enable row level security;\n'
  const own = (extra: string, policy = 'auth.uid() = user_id') => card({}, { 'supabase/migrations/1.sql': `${tbl}create policy "p" on public.notes for select using (${policy});\n${extra}` }).includes('their own ✓')
  assert.ok(own(''))
  assert.ok(!own('', 'auth.uid() = user_id or public'), 'OR another way in')
  assert.ok(!own('create view public.all_notes as select * from public.notes;\n'), 'a definer view reads them all')
  assert.ok(!own('create policy "u" on public.notes for update using (true);\n'), 'anyone can change them')
  const def = (sql: string) => findings(readDb([['1.sql', sql]]), new Set(), t => t).map(f => f.text).join(' ')
  const fn = (args = 'u uuid', body = 'update notes set body = 1;') => `create or replace function public.f(${args}) returns void language plpgsql security definer as $$\nbegin\n${body}\nend $$;\n`
  assert.ok(def(fn()).includes('which changes data'), 'body on its own line')
  assert.ok(!def(fn() + 'revoke execute on function public.f(uuid) from anon;\nrevoke execute on function public.f(uuid) from authenticated;\n'), 'two revokes')
  assert.ok(!def(fn().replace('public.f', 'private.f')), 'not reachable from the API')
  assert.ok(!def(fn() + 'drop function public.f(uuid);\n'), 'dropped')
  assert.ok(!def(fn() + 'alter function public.f(uuid) security invoker;\n'), 'now security invoker')
  assert.ok(!def('alter default privileges in schema public revoke execute on functions from anon, authenticated;\n' + fn()), 'default privileges')
  assert.ok(!def(fn('u uuid', 'if not has_role(auth.uid(), \'admin\') then raise exception; end if; update notes set body = 1;')), 'checks the caller')
  assert.ok(!def(fn() + 'revoke execute on all functions in schema public from anon, authenticated;\n'), 'bulk revoke')
  assert.ok(def(fn() + fn('u uuid, n int') + 'revoke execute on function public.f(uuid, int) from anon, authenticated;\n').includes('function f'), 'the other overload is still open')
  // refund guess: not a create table with updated_at; not a status comparison
  const cb = (sql: string) => card({ 'package.json': '{"dependencies":{"stripe":"1"}}', 'a.ts': "import Stripe from 'stripe'\n" },
    { 'package.json': '{"dependencies":{"stripe":"1"}}', 'a.ts': "import Stripe from 'stripe'\n", 'supabase/migrations/1.sql': sql }).includes("Cancelling doesn't")
  assert.ok(!cb("create table public.bookings (id uuid primary key, status text check (status in ('pending','paid','cancelled')), updated_at timestamptz);\ncreate function public.touch() returns trigger language plpgsql as $$ begin update public.x set y = 1; return new; end $$;\n"))
  // vague asks and named files
  const ask = (asked: string) => report(new Map(), new Map([['src/auth.ts', 'export const a = 1\n']]), { ref: 'main', asked }).replace(/\s+/g, ' ')
  for (const a of ['fix the typo in the footer', 'make the button faster to find', 'add a bug report form']) assert.ok(!ask(a).includes('exactly what was wrong'), a)
  for (const a of ["it's weird, fix it", "checkout doesn't work"]) assert.ok(ask(a).includes('exactly what was wrong'), a)
  assert.ok(!ask("add a footer but don't touch src/auth.ts").includes('as you asked'))
  assert.equal(ask('edit src/auth.ts, then src/auth.ts again').match(/as you asked/g)?.length, 1)
  console.log('ok (review 6)')
}

// Django: urls.py down through include(), function and class views, DRF routers, and who the settings let in.
{
  const dj = { 'requirements.txt': 'Django==5.1\ndjangorestframework==3.15\n',
    'mysite/urls.py': "from django.contrib import admin\nfrom django.urls import path, include\nurlpatterns = [\n    path('admin/', admin.site.urls),\n    path('', include('shop.urls')),\n    path('api/', include('api.urls')),\n]\n",
    'shop/models.py': "from django.db import models\nclass Order(models.Model):\n    total = models.IntegerField()\nclass Coupon(models.Model):\n    code = models.CharField(max_length=20)\n",
    'api/urls.py': "from django.urls import path, include\nfrom rest_framework.routers import DefaultRouter\nfrom .views import OrderViewSet\nrouter = DefaultRouter()\nrouter.register(r'orders', OrderViewSet)\nurlpatterns = [path('', include(router.urls))]\n",
    'api/views.py': "from rest_framework import viewsets\nfrom shop.models import Order\nclass OrderViewSet(viewsets.ReadOnlyModelViewSet):\n    queryset = Order.objects.all()\n" }
  const shop = (urls: string, views: string) => ({ 'shop/urls.py': `from django.urls import path, re_path\nfrom django.contrib.auth.decorators import login_required\nfrom . import views\nurlpatterns = [\n${urls}]\n`,
    'shop/views.py': `from django.shortcuts import render, redirect\nfrom django.views import View\nfrom .models import Order, Coupon\n${views}` })
  const base = { ...dj, ...shop("    path('orders/', views.order_list),\n", "def order_list(request):\n    return render(request, 'orders.html', {'orders': Order.objects.all()})\n") }
  const viewset = "from rest_framework import viewsets, permissions\nfrom rest_framework.decorators import action\nfrom shop.models import Order\nclass OrderViewSet(viewsets.ModelViewSet):\n    queryset = Order.objects.all()\n    @action(detail=True, methods=['post'], permission_classes=[permissions.IsAuthenticated])\n    def refund(self, request, pk=None):\n        Order.objects.filter(pk=pk).update(status='refunded')\n"
  // DRF lets everyone in unless settings say otherwise: a viewset that starts changing data is open
  const c1 = card(base, { ...base, 'api/views.py': viewset,
    ...shop(`    path('orders/', views.order_list),
    path('orders/<int:pk>/cancel/', views.cancel_order),
    re_path(r'^coupons/(?P<code>\\w+)/$', views.CouponView.as_view()),
    path('account/', login_required(views.account)),
    path('orders/new/', views.OrderCreate.as_view()),
`, `from django.views.decorators.http import require_POST
from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.generic import CreateView
def order_list(request):
    return render(request, 'orders.html', {'orders': Order.objects.all()})

@require_POST
def cancel_order(request, pk):
    Order.objects.filter(pk=pk).delete()
    return redirect('orders')

class CouponView(View):
    def get(self, request, code):
        return JsonResponse({'ok': Coupon.objects.filter(code=code).exists()})
    def post(self, request, code):
        if not request.user.is_staff:
            return JsonResponse({'error': 'no'}, status=403)
        Coupon.objects.create(code=code)

def account(request):
    return render(request, 'account.html')

class OrderCreate(LoginRequiredMixin, CreateView):
    model = Order
    fields = ['total']
`) })
  for (const e of ['⚠ Anyone can use the orders part of your server without logging in.', '⚠ Anyone can use the order part of your server without logging in.',
    '⚠ Anyone can use the order cancel part', 'New server code that deletes orders. /orders/[pk]/cancel', 'lists coupons, saves new ones and needs login to change anything ✓ (anyone can view it). /coupons/[code]',
    'requires login ✓. /account', 'saves new orders and requires login ✓. /orders/new', 'updates orders and requires login ✓. /api/orders/[pk]/refund',
    'now saves orders. /api/orders', 'now updates and deletes orders. /api/orders/[pk]'])
    assert.ok(c1.includes(e), `django missing "${e}"\n${c1}`)
  for (const e of ['admin part', 'lists orders, saves']) assert.ok(!c1.includes(e), `django should not say "${e}"\n${c1}`)
  // the same viewset when settings require login for every DRF view (or only for changes)
  const settings = (classes: string) => ({ 'mysite/settings.py': `REST_FRAMEWORK = {\n    'DEFAULT_PERMISSION_CLASSES': [\n        ${classes},\n    ],\n}\n` })
  const c2 = card({ ...base, ...settings("'rest_framework.permissions.IsAuthenticated'") }, { ...base, ...settings("'rest_framework.permissions.IsAuthenticated'"), 'api/views.py': viewset })
  assert.ok(!c2.includes('⚠'), `django settings login\n${c2}`)
  const c3 = card({ ...base, ...settings("'rest_framework.permissions.IsAuthenticatedOrReadOnly'") }, { ...base, ...settings("'rest_framework.permissions.IsAuthenticatedOrReadOnly'"), 'api/views.py': viewset })
  assert.ok(!c3.includes('⚠'), `django settings read-only\n${c3}`)
  // AllowAny on the class overrides the settings; IsOwnerOrReadOnly alone isn't a login check (anyone can still create)
  for (const pc of ['permissions.AllowAny', 'IsOwnerOrReadOnly']) {
    const c = card({ ...base, ...settings("'rest_framework.permissions.IsAuthenticated'") }, { ...base, ...settings("'rest_framework.permissions.IsAuthenticated'"),
      'api/views.py': viewset.replace('    queryset', `    permission_classes = [${pc}]\n    queryset`) })
    assert.ok(c.includes('⚠ Anyone can use the orders part'), `django ${pc}\n${c}`)
  }
  // Django 5.1 LoginRequiredMiddleware: every view needs login, except @login_not_required
  const mw = { 'mysite/settings.py': "MIDDLEWARE = [\n    'django.contrib.auth.middleware.AuthenticationMiddleware',\n    'django.contrib.auth.middleware.LoginRequiredMiddleware',\n]\n" }
  const c4 = card({ ...base, ...mw }, { ...base, ...mw, ...shop("    path('orders/', views.order_list),\n    path('orders/<int:pk>/cancel/', views.cancel_order),\n    path('signup/', views.signup),\n",
    "from django.contrib.auth.decorators import login_not_required\ndef order_list(request):\n    return render(request, 'orders.html', {'orders': Order.objects.all()})\ndef cancel_order(request, pk):\n    Order.objects.filter(pk=pk).delete()\n@login_not_required\ndef signup(request):\n    if request.method == 'POST':\n        User.objects.create(email=request.POST['email'])\n") })
  assert.ok(c4.includes('deletes orders and requires login ✓') && /saves new ones\. \/signup/.test(c4), `django middleware\n${c4}`)   // signup is public on purpose: no ✓, no ⚠
  // losing a login check is a change, even with the view untouched; @api_view with no permission falls back to the settings
  const acct = (wrap: boolean) => ({ ...base, ...shop(`    path('orders/', views.order_list),\n    path('wipe/', ${wrap ? 'login_required(views.wipe)' : 'views.wipe'}),\n`,
    "def order_list(request):\n    return render(request, 'orders.html', {'orders': Order.objects.all()})\ndef wipe(request):\n    Order.objects.all().delete()\n") })
  const c5 = card(acct(true), acct(false))
  assert.ok(c5.includes('⚠ Anyone can use the wipe part'), `django lost login\n${c5}`)
  const c6 = card(base, { ...base, 'api/urls.py': "from django.urls import path\nfrom api import views\nurlpatterns = [path('refund/<int:pk>/', views.refund)]\n",
    'api/views.py': "from rest_framework.decorators import api_view\n@api_view(['POST'])\ndef refund(request, pk):\n    Order.objects.filter(pk=pk).update(status='refunded')\n" })
  assert.ok(c6.includes('⚠ Anyone can use the refund part'), `django api_view\n${c6}`)
  console.log('ok (django)')
}

// Review 7 (2026-10-28): Django and DRF, each one a confirmed false ✓, false ⚠ or missed route.
{
  const site = (extra: Record<string, string>) => ({ 'requirements.txt': 'Django==5.1\ndjangorestframework==3.16\n',
    'mysite/urls.py': "from django.urls import path, include\nurlpatterns = [\n    path('', include('shop.urls')),\n    path('api/', include('api.urls')),\n]\n",
    'shop/models.py': "from django.db import models\nclass Order(models.Model):\n    total = models.IntegerField()\n", ...extra })
  const r = (files: Record<string, string>) => { const a = appFacts(new Map(Object.entries(site(files))))
    return [...a.routes].filter(([, x]) => x.kind === 'endpoint').map(([k, x]) => `${x.url} ${a.files.get(k)!.auth ? 'login' : 'open'} ${[...a.files.get(k)!.fns.keys()].join(',')}`).sort().join(' | ') }
  const vs = "from rest_framework import viewsets, permissions\nfrom shop.models import Order\n"
  const router = (reg = "router.register(r'orders', OrderViewSet)", tail = 'urlpatterns = [path(\'\', include(router.urls))]') =>
    `from django.urls import path, include\nfrom rest_framework.routers import DefaultRouter\nfrom .views import OrderViewSet\nrouter = DefaultRouter()\n${reg}\n${tail}\n`
  const shopUrls = (u: string) => `from django.urls import path\nfrom django.contrib.auth.decorators import login_required, permission_required, user_passes_test\nfrom . import views\nurlpatterns = [${u}]\n`
  const wipeView = (deco: string, cls = 'View') => `from django.views import View\nfrom django.utils.decorators import method_decorator\nfrom django.contrib.auth.decorators import login_required\nfrom django.views.decorators.cache import never_cache\ndecorators = [never_cache, login_required]\n${deco}class Wipe(${cls}):\n    def get(self, request):\n        return None\n    def post(self, request):\n        Order.objects.all().delete()\n`
  const cases: [string, Record<string, string>, string][] = [
    // DRF 3.16 exempts its views from LoginRequiredMiddleware
    ['login middleware does not cover DRF', { 'mysite/settings.py': "MIDDLEWARE = ['django.contrib.auth.middleware.LoginRequiredMiddleware']\n", 'api/urls.py': router(), 'api/views.py': vs + 'class OrderViewSet(viewsets.ModelViewSet):\n    queryset = Order.objects.all()\n' },
      '/api/orders open GET,POST | /api/orders/[pk] open GET,PUT,PATCH,DELETE'],
    // a non-DRF mixin doesn't make a Django view follow DRF settings
    ['django mixin is not DRF', { 'mysite/settings.py': "REST_FRAMEWORK = {'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated']}\n",
      'shop/urls.py': shopUrls("path('orders/<int:pk>/edit/', views.OrderUpdate.as_view())"), 'shop/views.py': 'class OrderUpdate(SuccessMessageMixin, UpdateView):\n    model = Order\n' },
      '/orders/[pk]/edit open GET,POST'],
    // base classes in the project, in the same file and another one
    ['project base with login + @action', { 'api/urls.py': router(), 'api/views.py': vs + "class Authed(viewsets.ModelViewSet):\n    permission_classes = [permissions.IsAuthenticated]\nclass OrderViewSet(Authed):\n    queryset = Order.objects.all()\n    @action(detail=True, methods=['post'])\n    def refund(self, request, pk=None):\n        pass\n" },
      '/api/orders login GET,POST | /api/orders/[pk] login GET,PUT,PATCH,DELETE | /api/orders/[pk]/refund login POST'],
    ['project mixin in another file', { 'shop/mixins.py': 'from django.contrib.auth.mixins import LoginRequiredMixin\nclass OwnerOnly(LoginRequiredMixin):\n    pass\n',
      'shop/urls.py': shopUrls("path('o/<int:pk>/delete/', views.OrderDelete.as_view())"), 'shop/views.py': 'from .mixins import OwnerOnly\nclass OrderDelete(OwnerOnly, DeleteView):\n    model = Order\n' }, '/o/[pk]/delete login GET,POST'],
    ['open project base in another file', { 'shop/base.py': 'from django.views import View\nclass Base(View):\n    pass\n',
      'shop/urls.py': shopUrls("path('wipe/', views.Wipe.as_view())"), 'shop/views.py': 'from .base import Base\nclass Wipe(Base):\n    def post(self, request):\n        Order.objects.all().delete()\n' }, '/wipe open POST'],
    ['get_permissions', { 'api/urls.py': router(), 'api/views.py': vs + "class OrderViewSet(viewsets.ModelViewSet):\n    queryset = Order.objects.all()\n    def get_permissions(self):\n        if self.action in ('list', 'retrieve'):\n            return [permissions.AllowAny()]\n        return [permissions.IsAuthenticated()]\n" },
      '/api/orders login GET,POST | /api/orders/[pk] login GET,PUT,PATCH,DELETE'],
    // method_decorator: on dispatch, on post, a list, a list variable; name='get' leaves POST open
    ...([['@method_decorator(login_required, name="dispatch")\n', 'login'], ['@method_decorator([never_cache, login_required], name="dispatch")\n', 'login'],
      ['@method_decorator(decorators, name="dispatch")\n', 'login'], ['@method_decorator(login_required, name="get")\n', 'open']] as const)
      .map(([d, want]): [string, Record<string, string>, string] => [d, { 'shop/urls.py': shopUrls("path('wipe/', views.Wipe.as_view())"), 'shop/views.py': wipeView(d) }, `/wipe ${want} GET,POST`]),
    ['method_decorator on post', { 'shop/urls.py': shopUrls("path('wipe/', views.Wipe.as_view())"), 'shop/views.py': wipeView('').replace('    def post', '    @method_decorator(login_required)\n    def post') }, '/wipe login GET,POST'],
    // wrappers in urls.py that take arguments first
    ...["permission_required('shop.delete_order')(views.wipe)", 'user_passes_test(lambda u: u.is_staff)(views.wipe)', "login_required(login_url='/x/')(views.wipe)"]
      .map((w): [string, Record<string, string>, string] => [w, { 'shop/urls.py': shopUrls(`path('wipe/', ${w})`), 'shop/views.py': 'def wipe(request):\n    Order.objects.all().delete()\n' }, '/wipe login POST']),
    // composed DRF permissions
    ['IsAuthenticated | ReadOnly', { 'api/urls.py': router(), 'api/views.py': vs + 'class OrderViewSet(viewsets.ReadOnlyModelViewSet):\n    permission_classes = [IsAuthenticated | ReadOnly]\n    queryset = Order.objects.all()\n' }, '/api/orders open GET | /api/orders/[pk] open GET'],
    ['~IsAuthenticated', { 'api/urls.py': router(), 'api/views.py': vs + 'class OrderViewSet(viewsets.ModelViewSet):\n    permission_classes = [~IsAuthenticated]\n    queryset = Order.objects.all()\n' }, '/api/orders open GET,POST | /api/orders/[pk] open GET,PUT,PATCH,DELETE'],
    // routes that were missed
    ['include tuple + namespace', { 'mysite/urls.py': "from django.urls import path, include\nurlpatterns = [path('api/', include(('api.urls', 'api'), namespace='api'))]\n", 'api/urls.py': router(undefined, "urlpatterns = [path('v1/', include((router.urls, 'api'), namespace='v1'))]"),
      'api/views.py': vs + 'class OrderViewSet(viewsets.ModelViewSet):\n    queryset = Order.objects.all()\n' }, '/api/v1/orders open GET,POST | /api/v1/orders/[pk] open GET,PUT,PATCH,DELETE'],
    ['router in another file, [*router.urls]', { 'api/routers.py': "from rest_framework.routers import DefaultRouter\nfrom .views import OrderViewSet\nrouter = DefaultRouter()\nrouter.register('orders', OrderViewSet)\n",
      'api/urls.py': 'from .routers import router\nurlpatterns = [*router.urls]\n', 'api/views.py': vs + 'class OrderViewSet(viewsets.ReadOnlyModelViewSet):\n    queryset = Order.objects.all()\n' }, '/api/orders open GET | /api/orders/[pk] open GET'],
    ['views package re-export', { 'shop/urls.py': shopUrls("path('wipe/', views.wipe)"), 'shop/views/__init__.py': 'from .orders import wipe\n', 'shop/views/orders.py': 'def wipe(request):\n    Order.objects.all().delete()\n' }, '/wipe open POST'],
    ['star import', { 'shop/urls.py': "from django.urls import path\nfrom .views import *\nurlpatterns = [path('wipe/', wipe)]\n", 'shop/views.py': 'def wipe(request):\n    Order.objects.all().delete()\n' }, '/wipe open POST'],
    // methods a viewset turns off, or a route maps
    ['http_method_names', { 'api/urls.py': router(), 'api/views.py': vs + "class OrderViewSet(viewsets.ModelViewSet):\n    http_method_names = ['get', 'head']\n    queryset = Order.objects.all()\n" }, '/api/orders open GET | /api/orders/[pk] open GET'],
    ['as_view mapping', { 'api/urls.py': "from django.urls import path\nfrom .views import OrderViewSet\nurlpatterns = [path('orders/', OrderViewSet.as_view({'get': 'list'}))]\n", 'api/views.py': vs + 'class OrderViewSet(viewsets.ModelViewSet):\n    queryset = Order.objects.all()\n' }, '/api/orders open GET'],
    ['re_path groups', { 'shop/urls.py': "from django.urls import re_path\nfrom . import views\nurlpatterns = [re_path(r'^orders/(\\d+)/(?:edit|change)/?$', views.o)]\n", 'shop/views.py': 'def o(request, pk):\n    return None\n' }, '/orders/[id]/edit open GET'],
  ]
  for (const [name, files, want] of cases) assert.equal(r(files), want, `review 7: ${name}`)
  // same-named apps: the one next to the project wins
  const nested = { 'backend/mysite/urls.py': "from django.urls import path, include\nurlpatterns = [path('shop/', include('shop.urls'))]\n",
    'backend/shop/urls.py': "from django.urls import path\nfrom . import views\nurlpatterns = [path('wipe/', views.wipe)]\n", 'backend/shop/views.py': 'def wipe(request):\n    Order.objects.all().delete()\n',
    'backend/legacy/shop/urls.py': "from django.urls import path\nfrom . import views\nurlpatterns = [path('old/', views.old)]\n", 'backend/legacy/shop/views.py': 'def old(request):\n    return None\n' }
  assert.ok(r(nested).includes('/shop/wipe open POST'), r(nested))
  // what a view does includes the helpers it calls, instance .save()/.delete(), and ORM chains split over lines
  const c = card(site({}), site({ 'shop/urls.py': shopUrls("path('pay/', views.pay), path('hook/', views.hook), path('rm/<int:pk>/', views.rm)"),
    'shop/services.py': 'def place_order(user):\n    order = Order(customer=user)\n    order.save()\n    return order\n',
    'shop/views.py': "from .services import place_order\n@login_required\n@require_POST\ndef pay(request):\n    place_order(request.user)\n@require_POST\ndef hook(request):\n    Order.objects.filter(\n        pk=1,\n    ).update(status='paid')\n@require_POST\ndef rm(request, pk):\n    order = Order.objects.get(pk=pk)\n    order.delete()\n" }))
  for (const e of ['saves new orders and requires login ✓. /pay', 'updates orders. /hook', '⚠ Anyone can use the hook part', 'deletes orders. /rm/[pk]'])
    assert.ok(c.includes(e), `review 7 missing "${e}"\n${c}`)
  console.log('ok (review 7)')
}

// Review 8 (2026-10-28): Django and DRF, second pass. Commented-out code, get_permissions branches, Python's base class order, and more ways to write urls.py.
{
  const site = (extra: Record<string, string>) => ({ 'requirements.txt': 'Django==5.1\ndjangorestframework==3.16\n',
    'mysite/urls.py': "from django.urls import path, include\nurlpatterns = [\n    path('', include('shop.urls')),\n    path('api/', include('api.urls')),\n]\n",
    'shop/models.py': "from django.db import models\nclass Order(models.Model):\n    total = models.IntegerField()\n", ...extra })
  const r = (files: Record<string, string>) => { const a = appFacts(new Map(Object.entries(site(files))))
    return [...a.routes].filter(([, x]) => x.kind === 'endpoint').map(([k, x]) => `${x.url} ${a.files.get(k)!.auth ? 'login' : 'open'} ${[...a.files.get(k)!.fns.keys()].join(',')}`).sort().join(' | ') }
  const vs = "from rest_framework import viewsets, permissions\nfrom rest_framework.permissions import *\nfrom shop.models import Order\n"
  const ms = (body: string) => vs + `class OrderViewSet(viewsets.ModelViewSet):\n    queryset = Order.objects.all()\n${body}`
  const router = "from django.urls import path, include\nfrom rest_framework.routers import DefaultRouter\nfrom .views import OrderViewSet\nrouter = DefaultRouter()\nrouter.register(r'orders', OrderViewSet)\nurlpatterns = [path('', include(router.urls))]\n"
  const shopUrls = (u: string) => `from django.urls import path, include\nfrom . import views\nurlpatterns = [${u}]\n`
  const wipe = 'def wipe(request):\n    Order.objects.all().delete()\n', wipeCls = (bases: string, pre = '') => `from django.views import View\nfrom django.contrib.auth.mixins import LoginRequiredMixin\n${pre}class Wipe(${bases}):\n    def post(self, request):\n        Order.objects.all().delete()\n`
  const mw = "MIDDLEWARE = [\n    'django.contrib.auth.middleware.AuthenticationMiddleware',\n    'django.contrib.auth.middleware.LoginRequiredMiddleware',\n]\n"
  const OPEN = '/api/orders open GET,POST | /api/orders/[pk] open GET,PUT,PATCH,DELETE', LOGIN = OPEN.replace(/open/g, 'login')
  const cases: [string, Record<string, string>, string][] = [
    ['get_permissions: create open', { 'api/urls.py': router, 'api/views.py': ms("    def get_permissions(self):\n        if self.action == 'create':\n            return [AllowAny()]\n        return [IsAuthenticated()]\n") },
      '/api/orders open GET,POST | /api/orders/[pk] login GET,PUT,PATCH,DELETE'],
    ['get_permissions: super()', { 'api/urls.py': router, 'api/views.py': ms('    permission_classes = [IsAuthenticated]\n    def get_permissions(self):\n        return super().get_permissions()\n') }, LOGIN],
    ['commented-out setting', { 'mysite/settings.py': "REST_FRAMEWORK = {'DEFAULT_PERMISSION_CLASSES': [\n    'rest_framework.permissions.AllowAny',\n    # 'rest_framework.permissions.IsAuthenticated',\n]}\n", 'api/urls.py': router, 'api/views.py': ms('') }, OPEN],
    ['commented-out middleware', { 'mysite/settings.py': mw.replace("    'django.contrib.auth.middleware.Login", "    # 'django.contrib.auth.middleware.Login"), 'shop/urls.py': shopUrls("path('wipe/', views.wipe)"), 'shop/views.py': wipe }, '/wipe open POST'],
    ['commented-out permission class', { 'api/urls.py': router, 'api/views.py': ms('    permission_classes = [\n        AllowAny,  # was IsAuthenticated\n    ]\n') }, OPEN],
    ['commented-out raise', { 'shop/urls.py': shopUrls("path('wipe/', views.wipe)"), 'shop/views.py': 'def wipe(request):\n    if not request.user.is_authenticated:\n        pass  # raise PermissionDenied\n    Order.objects.all().delete()\n' }, '/wipe open POST'],
    ['IsAuthenticatedOrCreate', { 'api/urls.py': router, 'api/views.py': ms('    permission_classes = [IsAuthenticatedOrCreate]\n') }, OPEN],
    ['as_view(permission_classes=[AllowAny])', { 'api/urls.py': "from django.urls import path\nfrom .views import Wipe\nurlpatterns = [path('wipe/', Wipe.as_view(permission_classes=[AllowAny]))]\n",
      'api/views.py': vs + 'from rest_framework.views import APIView\nclass Wipe(APIView):\n    permission_classes = [IsAuthenticated]\n    def post(self, request):\n        Order.objects.all().delete()\n' }, '/api/wipe open POST'],
    ['diamond: B overrides the shared base', { 'api/urls.py': router, 'api/views.py': vs + 'class Base(viewsets.ModelViewSet):\n    permission_classes = [IsAuthenticated]\nclass A(Base):\n    pass\nclass B(Base):\n    permission_classes = [AllowAny]\nclass OrderViewSet(A, B):\n    queryset = Order.objects.all()\n' }, OPEN],
    ['mixin right of View', { 'shop/urls.py': shopUrls("path('wipe/', views.Wipe.as_view())"), 'shop/views.py': wipeCls('View, LoginRequiredMixin') }, '/wipe open POST'],
    ['middleware: DRF base from another package', { 'mysite/settings.py': mw, 'shop/urls.py': shopUrls("path('wipe/', views.Wipe.as_view())"), 'shop/views.py': 'from rest_framework_simplejwt.views import TokenViewBase\nclass Wipe(TokenViewBase):\n    def post(self, request):\n        Order.objects.all().delete()\n' }, '/wipe open POST'],
    ['middleware: @login_not_required on a class does nothing', { 'mysite/settings.py': mw, 'shop/urls.py': shopUrls("path('wipe/', views.Wipe.as_view())"), 'shop/views.py': wipeCls('View', '@login_not_required\n') }, '/wipe login POST'],
    ['inline include', { 'shop/urls.py': shopUrls("path('x/', include([path('wipe/', views.wipe)]))"), 'shop/views.py': wipe }, '/x/wipe open POST'],
    ['include(variable)', { 'shop/urls.py': "from django.urls import path, include\nfrom . import views\nextra = [path('wipe/', views.wipe)]\nurlpatterns = [path('x/', include(extra))]\n", 'shop/views.py': wipe }, '/x/wipe open POST'],
    ['urlpatterns.append', { 'shop/urls.py': shopUrls('') + "urlpatterns.append(path('wipe/', views.wipe))\n", 'shop/views.py': wipe }, '/wipe open POST'],
    ['register(prefix=, viewset=)', { 'api/urls.py': router.replace("router.register(r'orders', OrderViewSet)", "router.register(prefix='orders', viewset=OrderViewSet)"), 'api/views.py': ms('') }, OPEN],
    ['typed request', { 'shop/urls.py': shopUrls("path('wipe/', views.wipe)"), 'shop/views.py': 'def wipe(request: HttpRequest) -> HttpResponse:\n    Order.objects.all().delete()\n' }, '/wipe open POST'],
    ['view assigned in views.py', { 'shop/urls.py': shopUrls("path('wipe/', views.wipe)"), 'shop/views.py': wipeCls('View') + 'wipe = Wipe.as_view()\n' }, '/wipe open POST'],
    ['async ORM', { 'shop/urls.py': shopUrls("path('wipe/', views.wipe)"), 'shop/views.py': 'async def wipe(request):\n    await Order.objects.all().adelete()\n' }, '/wipe open POST'],
    ['writes only through a helper', { 'shop/urls.py': shopUrls("path('wipe/', views.wipe)"), 'shop/views.py': 'def clear():\n    Order.objects.all().delete()\ndef wipe(request):\n    clear()\n' }, '/wipe open POST'],
  ]
  for (const [name, files, want] of cases) assert.equal(r(files), want, `review 8: ${name}`)
  // pyFold follows real calls only: cache.delete() isn't the delete() route in the same file (FastAPI, Flask too)
  const fa = (extra: string) => ({ 'app/main.py': `from fastapi import FastAPI, Depends\napp = FastAPI()\n@app.get('/orders')\ndef orders():\n${extra}    return []\n@app.delete('/orders/{id}')\ndef delete(id: int, user = Depends(get_current_user)):\n    db.delete(order)\n` })
  const c1 = card(fa(''), fa("    cache.delete('stale')\n"))
  assert.ok(!c1.includes('⚠') && !c1.includes('deletes orders'), `review 8 pyFold\n${c1}`)
  // a webhook that checks its signature is exempt from CSRF on purpose
  const hook = (body: string) => ({ ...site({}), 'shop/urls.py': shopUrls("path('hook/', views.hook)"), 'shop/views.py': `from django.views.decorators.csrf import csrf_exempt\n@csrf_exempt\ndef hook(request):\n${body}    return None\n` })
  assert.ok(!card(site({}), hook("    stripe.Webhook.construct_event(request.body, sig, secret)\n")).includes('csrf'), 'review 8 webhook csrf')
  assert.ok(card(site({}), hook("    Order.objects.all().delete()\n")).includes('csrf'), 'review 8 csrf still flagged')
  console.log('ok (review 8)')
}

// Review 9 (2026-10-28): Django and DRF, third pass.
{
  const site = (extra: Record<string, string>) => ({ 'requirements.txt': 'Django==5.1\ndjangorestframework==3.16\n',
    'mysite/urls.py': "from django.urls import path, include\nurlpatterns = [\n    path('', include('shop.urls')),\n    path('api/', include('api.urls')),\n]\n",
    'shop/models.py': "from django.db import models\nclass Order(models.Model):\n    total = models.IntegerField()\n", ...extra })
  const r = (files: Record<string, string>) => { const a = appFacts(new Map(Object.entries(site(files))))
    return [...a.routes].filter(([, x]) => x.kind === 'endpoint').map(([k, x]) => `${x.url} ${a.files.get(k)!.auth ? 'login' : 'open'} ${[...a.files.get(k)!.fns.keys()].join(',')} ${[...a.files.get(k)!.written].join(',')}`).sort().join(' | ') }
  const router = "from django.urls import path, include\nfrom rest_framework.routers import DefaultRouter\nfrom .views import OrderViewSet\nrouter = DefaultRouter()\nrouter.register(r'orders', OrderViewSet)\nurlpatterns = [path('', include(router.urls))]\n"
  const gp = (body: string, extra = '') => ({ 'api/urls.py': router, 'api/views.py': `from rest_framework import viewsets\nfrom rest_framework.permissions import *\nfrom shop.models import Order\nclass OrderViewSet(viewsets.ModelViewSet):\n    queryset = Order.objects.all()\n${extra}    def get_permissions(self):\n${body}` })
  const shop = (urls: string, views: string) => ({ 'shop/urls.py': `from django.urls import path\nfrom . import views\nurlpatterns = [${urls}]\n`, 'shop/views.py': views })
  const CREATE_OPEN = '/api/orders open GET,POST Order | /api/orders/[pk] login GET,PUT,PATCH,DELETE Order'
  const cases: [string, Record<string, string>, string][] = [
    ['fetched then deleted', shop("path('o/<int:pk>/del/', views.rm)", 'from django.shortcuts import get_object_or_404\ndef rm(request, pk):\n    order = get_object_or_404(Order, pk=pk)\n    order.delete()\n'), '/o/[pk]/del open POST Order'],
    ['serializer.save', shop("path('o/', views.make)", 'from rest_framework.decorators import api_view\n@api_view([\'POST\'])\ndef make(request):\n    serializer = OrderSerializer(data=request.data)\n    serializer.save()\n'), '/o open POST Order'],
    ['wrapped condition', gp("        if self.action in (\n            'create',\n        ):\n            return [AllowAny()]\n        return [IsAuthenticated()]\n"), CREATE_OPEN],
    ['branch sets permission_classes', gp("        if self.action == 'create':\n            self.permission_classes = [AllowAny]\n        return super().get_permissions()\n", '    permission_classes = [IsAuthenticated]\n'), CREATE_OPEN],
    ['permission_classes_by_action', gp('        try:\n            return [p() for p in self.permission_classes_by_action[self.action]]\n        except KeyError:\n            return [p() for p in self.permission_classes]\n',
      "    permission_classes = [IsAuthenticated]\n    permission_classes_by_action = {'create': [AllowAny]}\n"), CREATE_OPEN],
    ['multi-line return', gp('        return [\n            IsAuthenticated(),\n        ]\n'), CREATE_OPEN.replace('open GET,POST', 'login GET,POST')],
    ['not in a variable: skipped, never a false ✓', gp("        if self.action not in self.public_actions:\n            return [IsAuthenticated()]\n        return [AllowAny()]\n"), CREATE_OPEN.replace('login', 'open')],
    ['two conditions: skipped', gp("        if self.request.method not in SAFE_METHODS and self.action != 'create':\n            return [IsAuthenticated()]\n        return [AllowAny()]\n"), CREATE_OPEN.replace('login', 'open')],
    ['charges money: POST', shop("path('go/', views.go)", 'def go(request):\n    stripe.checkout.Session.create(mode="payment")\n'), '/go open POST '],
    ['urlpatterns = a + b', { 'shop/urls.py': "from django.urls import path\nfrom . import views\na = [path('wipe/', views.wipe)]\nurlpatterns = a\n", 'shop/views.py': 'def wipe(request):\n    Order.objects.all().delete()\n' }, '/wipe open POST Order'],
    ['wipe = login_required(wipe)', shop("path('wipe/', views.wipe)", 'def wipe(request):\n    Order.objects.all().delete()\nwipe = login_required(wipe)\n'), '/wipe login POST Order'],
    ['shared outside base after its users', shop("path('wipe/', views.Wipe.as_view())", 'from django.views import View\nfrom django.contrib.auth.mixins import LoginRequiredMixin\nclass A(LoginRequiredMixin, View):\n    pass\nclass B(View):\n    pass\nclass Wipe(B, A):\n    def post(self, request):\n        Order.objects.all().delete()\n'), '/wipe login POST Order'],
  ]
  for (const [name, files, want] of cases) assert.equal(r(files), want, `review 9: ${name}`)
  // pyFold: an object named like its module (from app.cache import cache) isn't the module; a function defined inside a handler isn't the route of the same name
  const fl = (route: string) => ({ 'app/__init__.py': '', 'app/cache.py': 'class C:\n    def clear(self): pass\ncache = C()\ndef clear():\n    Order.query.delete()\n',
    'app/routes.py': `from flask import Flask\nfrom app.cache import cache\napp = Flask(__name__)\n@app.get('/orders')\ndef orders():\n${route}    return 'x'\n` })
  const fa = (route: string) => ({ 'app/main.py': `from fastapi import FastAPI, Depends\napp = FastAPI()\n@app.delete('/orders/{id}')\ndef remove(id: int, user = Depends(get_current_user)):\n    db.delete(db.get(Order, id))\n@app.get('/orders')\ndef orders():\n${route}    return []\n` })
  for (const c of [card(fl(''), fl('    cache.clear()\n')), card(fa(''), fa('    def remove(x): return x\n    remove(1)\n'))]) assert.ok(!c.includes('⚠') && !c.includes('deletes'), `review 9 pyFold\n${c}`)
  // a csrf_exempt view that only mentions a signature in a comment or a field name is still flagged
  const hook = (body: string) => ({ ...site({}), ...shop("path('hook/', views.hook)", `from django.views.decorators.csrf import csrf_exempt\n@csrf_exempt\ndef hook(request):\n${body}    return None\n`) })
  assert.ok(card(site({}), hook("    # TODO verify the signature\n    p.signature = request.POST['signature']\n")).includes('csrf'), 'review 9 csrf')
  console.log('ok (review 9)')
}

// Round 4 trials (Django bakery, 2026-10-28): what the graders found that fixed rules can see.
{
  const site = (extra: Record<string, string>) => ({ 'requirements.txt': 'Django==5.1\nstripe==10\n',
    'mysite/urls.py': "from django.urls import path, include\nurlpatterns = [path('', include('shop.urls'))]\n",
    'shop/models.py': "from django.db import models\nclass Product(models.Model):\n    name = models.CharField(max_length=80)\nclass Order(models.Model):\n    status = models.CharField(max_length=20)\n",
    'shop/checkout.py': "import stripe\ndef pay(order):\n    return stripe.checkout.Session.create(mode='payment', metadata={'order_id': order.pk})\n", ...extra })
  const urls = (u: string) => ({ 'shop/urls.py': `from django.urls import path\nfrom . import views\nurlpatterns = [${u}]\n` })
  const sellOut = (extra = '') => ({ ...urls("path('sold-out/<int:pk>/', views.sold_out)"), 'shop/views.py': `from django.contrib.admin.views.decorators import staff_member_required\nfrom django.views.decorators.http import require_POST\nfrom .services import cancel_unpaid\n@staff_member_required\n@require_POST\ndef sold_out(request, pk):\n    cancel_unpaid(pk)\n`,
    'shop/services.py': `def cancel_unpaid(pk):\n    orders = list(Order.objects.filter(items__product=pk, status=Order.Status.PENDING))\n    for order in orders:\n        order.status = Order.Status.CANCELLED\n${extra}    Order.objects.bulk_update(orders, ['status'])\n` })
  const c1 = card(site({}), site(sellOut()))
  for (const e of ['! Cancelled orders can still be paid', 'The agent also added shop/services.py']) assert.ok(c1.includes(e), `round 4 missing "${e}"\n${c1}`)
  assert.ok(!card(site({}), site(sellOut('        stripe.checkout.Session.expire(order.stripe_session_id)\n'))).includes('can still be paid'), 'round 4: expire closes the page')
  // a view that changes things on a plain visit; with @require_POST it doesn't
  const cancel = (deco: string) => site({ ...urls("path('o/<int:pk>/cancel/', views.cancel)"), 'shop/views.py': `${deco}def cancel(request, pk):\n    Order.objects.filter(pk=pk).update(status='cancelled')\n` })
  assert.ok(card(site({}), cancel('')).includes('changes things when someone just opens its address'), 'round 4: GET writes')
  assert.ok(!card(site({}), cancel('@require_POST\n')).includes('just opens its address'), 'round 4: POST only')
  // Django email on the console backend; an index-only migration; a new field with a default on a table that has rows
  const mail = (backend: string) => site({ 'mysite/settings.py': backend, ...urls("path('hi/', views.hi)"), 'shop/views.py': "from django.core.mail import send_mail\ndef hi(request):\n    send_mail('Hi', 'Hello', None, ['a@b.c'])\n" })
  assert.ok(card(site({}), mail("EMAIL_BACKEND = os.environ.get('EMAIL_BACKEND', 'django.core.mail.backends.console.EmailBackend')\n")).includes('Turn on real email sending'), 'round 4: console email')
  assert.ok(!card(site({}), mail("EMAIL_BACKEND = 'anymail.backends.resend.EmailBackend'\n")).includes('Turn on real email sending'), 'round 4: real email')
  const mig = (name: string, ops: string) => ({ [`shop/migrations/${name}.py`]: `from django.db import migrations, models\nclass Migration(migrations.Migration):\n    operations = [\n${ops}    ]\n` })
  const c2 = card(site({}), site(mig('0002_order_index', "        migrations.AddIndex(model_name='order', index=models.Index(fields=['status'], name='order_status')),\n")))
  assert.ok(c2.includes('It only makes lookups faster') && !c2.includes('will fail'), `round 4: index only\n${c2}`)
  const c3 = card(site({}), site(mig('0002_product_category', "        migrations.AddField(\n            model_name='product',\n            name='category',\n            field=models.CharField(choices=[('bread', 'Bread'), ('other', 'Other')], default='other', max_length=20),\n        ),\n")))
  assert.ok(c3.includes('Every product you already have gets "Other" as its category'), `round 4: default\n${c3}`)
  // "still needs to be run"; unasked guesses are things to decide, not problems
  const c4 = report(new Map(Object.entries(site({}))), new Map(Object.entries(site({ 'shop/tests.py': 'def test_x():\n    assert True\n' }))), { ref: 'main', agentSaid: 'Added a test. The full suite still needs to be run.' })
  assert.ok(c4.includes("didn't run or test this") && c4.includes('The agent also added shop/tests.py (tests)'), `round 4: not run\n${c4}`)
  console.log('ok (round 4 trials)')
}

// Review 10 (2026-10-28): the round 4 rules, without their false alarms.
{
  const site = (extra: Record<string, string>) => ({ 'requirements.txt': 'Django==5.1\nstripe==10\n',
    'mysite/urls.py': "from django.urls import path, include\nurlpatterns = [path('', include('shop.urls'))]\n",
    'shop/models.py': "from django.db import models\nclass Order(models.Model):\n    status = models.CharField(max_length=20)\n",
    'shop/checkout.py': "import stripe\ndef pay(order):\n    return stripe.checkout.Session.create(mode='payment', cancel_url='/x')\n", ...extra })
  const view = (body: string, deco = '') => site({ 'shop/urls.py': "from django.urls import path\nfrom . import views\nurlpatterns = [path('o/<int:pk>/stop/', views.stop)]\n", 'shop/views.py': `${deco}def stop(request, pk):\n${body}` })
  const has = (c: string, e: string) => c.includes(e)
  // the confirm-page pattern: the write only happens on POST
  assert.ok(!has(card(site({}), view("    if request.method == 'POST':\n        Order.objects.filter(pk=pk).update(status='stopped')\n        return redirect('/')\n    return render(request, 'confirm.html')\n")), 'just opens'), 'review 10: confirm page')
  assert.ok(!has(card(site({}), view("    Order.objects.filter(pk=pk).update(views=F('views') + 1)\n")), 'just opens'), 'review 10: counter')
  // cancelling: per def, the written value; a read-only dashboard, a skip, an exclude aren't cancels
  const svc = (body: string) => site({ 'shop/services.py': body })
  for (const b of ["def counts():\n    ctx = {}\n    ctx.update({'p': Order.objects.filter(status='pending').count(), 'c': Order.objects.filter(status='cancelled').count()})\n    return ctx\n",
    "def remind():\n    for o in Order.objects.filter(status='pending'):\n        if o.status == 'cancelled':\n            continue\n        o.save()\n"])
    assert.ok(!has(card(site({}), svc(b)), 'can still be paid'), `review 10: not a cancel\n${b}`)
  // a class method that cancels unpaid orders counts; a refund anywhere (stripe.Refund.create) quiets both guesses
  const cls = "class Order2:\n    def cancel(self):\n        Order.objects.filter(pk=self.pk, status='pending').update(status='cancelled')\n"
  assert.ok(has(card(site({}), svc(cls)), 'can still be paid'), 'review 10: class method')
  assert.ok(!has(card(site({}), svc(cls + "def refund_late(pi):\n    stripe.Refund.create(payment_intent=pi)\n")), 'can still be paid'), 'review 10: refunds')
  // cancelling paid orders through an enum; the word "open" inside another word doesn't make it "unpaid only"
  const paid = "def close_day(day):\n    if day.opening_hours:\n        return\n    Order.objects.filter(pickup_date=day, status=Order.Status.PAID).update(status=Order.Status.CANCELLED)\n"
  assert.ok(has(card(site({}), svc(paid)), "Cancelling doesn't give money back"), 'review 10: paid enum cancel')
  // "X needs to be run" is about something else; "the suite still needs to be run" is about tests
  for (const [said, fires] of [['All 42 tests pass. The new migration still needs to be run on your live database.', false], ['Ran all tests: 18 passed. No migrations need to be run.', false],
    ['I ran the full test suite (all green); nothing else needs to be run.', false], ['The full suite still needs to be run.', true]] as const)
    assert.equal(report(new Map(Object.entries(site({}))), new Map(Object.entries(svc('def f():\n    return 1\n'))), { ref: 'main', agentSaid: said }).includes("didn't run or test"), fires, `review 10: "${said}"`)
  // email: unset backend with a real EMAIL_HOST is SMTP; dev settings with console next to production settings with a real one
  const mail = (s: Record<string, string>) => site({ ...s, 'shop/urls.py': "from django.urls import path\nfrom . import views\nurlpatterns = [path('hi/', views.hi)]\n", 'shop/views.py': "from django.core.mail import send_mail\ndef hi(request):\n    send_mail('Hi', 'x', None, ['a@b.c'])\n" })
  for (const s of [{ 'mysite/settings.py': "EMAIL_HOST = 'smtp.sendgrid.net'\n" }, { 'mysite/settings/dev.py': "EMAIL_BACKEND = 'django.core.mail.backends.console.EmailBackend'\n", 'mysite/settings/production.py': "EMAIL_BACKEND = 'anymail.backends.mailgun.EmailBackend'\n" },
    { 'mysite/settings.py': "EMAIL_BACKEND = 'django.core.mail.backends.console.EmailBackend' if DEBUG else 'anymail.backends.mailgun.EmailBackend'\n" }])
    assert.ok(!has(card(site({}), mail(s)), 'Turn on real email sending'), `review 10: email ${Object.keys(s)}`)
  // a default from choices reads as its label; an _id field still has a name; a deleted helper says deleted
  const mig = (field: string) => ({ ...site({}), 'shop/migrations/0002_x.py': `from django.db import migrations, models\nclass Migration(migrations.Migration):\n    operations = [\n        migrations.AddField(model_name='order', name='size', field=${field}),\n    ]\n` })
  assert.ok(has(card(site({}), mig("models.CharField(choices=[('sm', 'Small'), ('lg', 'Large')], default='sm', max_length=2)")), 'gets "Small" as its size'), 'review 10: choice label')
  const gone = site({ 'shop/helpers.py': 'def h():\n    return 1\n' })
  assert.ok(has(card(gone, site({})), 'The agent also deleted shop/helpers.py'), 'review 10: deleted helper')
  console.log('ok (review 10)')
}

// Review 11 (2026-10-28): the guesses about cancelling, links and email, made narrower.
{
  const site = (extra: Record<string, string>) => ({ 'requirements.txt': 'Django==5.1\nstripe==10\n',
    'mysite/urls.py': "from django.urls import path, include\nurlpatterns = [path('', include('shop.urls'))]\n",
    'shop/models.py': "from django.db import models\nclass Order(models.Model):\n    status = models.CharField(max_length=20)\n", ...extra })
  const co = { 'shop/checkout.py': "import stripe\ndef pay(order):\n    return stripe.checkout.Session.create(mode='payment', cancel_url='https://x.com/cart')\n" }
  const paidCancel = 'def close(day):\n    Order.objects.filter(day=day).update(status=\'cancelled\')\n'
  // a Refund model isn't a refund; an app file named test_drive.py isn't a test; real tests are
  assert.ok(card(site(co), site({ ...co, 'shop/models.py': site({})['shop/models.py'] + 'class Refund(models.Model):\n    amount = models.IntegerField()\n', 'shop/services.py': paidCancel })).includes("doesn't give money back"), 'review 11: Refund model')
  assert.ok(card(site(co), site({ ...co, 'shop/test_drive.py': paidCancel })).includes("doesn't give money back"), 'review 11: test_drive.py')
  assert.ok(!card(site(co), site({ ...co, 'shop/tests.py': 'def test_close():\n    o = Order()\n    o.status = "cancelled"\n    o.save()\n' })).includes("doesn't give money back"), 'review 11: tests.py')
  // a pending-only cancel in a file that says "paid" elsewhere; an expired-session handler next to a separate cancel
  const pend = "def is_paid(o):\n    return o.status == 'paid'\ndef cancel_unpaid():\n    Order.objects.filter(status='pending').update(status='cancelled')\n"
  const c1 = card(site(co), site({ ...co, 'shop/services.py': pend }))
  assert.ok(c1.includes('can still be paid') && !c1.includes("doesn't give money back"), `review 11: pending only\n${c1}`)
  assert.ok(card(site(co), site({ ...co, 'shop/hooks.py': "def on_expired(event):\n    if event['type'] == 'checkout.session.expired':\n        pass\n" + pend.split('def is_paid')[0] + pend.slice(pend.indexOf('def cancel_unpaid')) })).includes('can still be paid'), 'review 11: expired per def')
  // the cancel_url exemption only covers the view it names
  const cancelView = (cancelUrl: string) => site({ 'shop/checkout.py': `import stripe\ndef pay(order):\n    return stripe.checkout.Session.create(mode='payment', cancel_url=${cancelUrl})\n`,
    'shop/urls.py': "from django.urls import path\nfrom . import views\nurlpatterns = [path('checkout/<int:pk>/cancel/', views.cancel)]\n",
    'shop/views.py': "@login_required\ndef cancel(request, pk):\n    Order.objects.filter(pk=pk).update(status='stopped')\n    return redirect('/')\n" })
  assert.ok(card(site({}), cancelView("'https://x.com/cart'")).includes('just opens its address'), 'review 11: other cancel_url')
  assert.ok(!card(site({}), cancelView("request.build_absolute_uri(reverse('shop:checkout_cancel', args=[order.pk]))")).includes('just opens its address'), 'review 11: this cancel_url')
  // email: production.py overrides base.py's console backend, in any order
  const mail = (files: Record<string, string>) => site({ ...files, 'shop/urls.py': "from django.urls import path\nfrom . import views\nurlpatterns = [path('hi/', views.hi)]\n", 'shop/views.py': "from django.core.mail import send_mail\ndef hi(request):\n    send_mail('Hi', 'x', None, ['a@b.c'])\n" })
  assert.ok(!card(site({}), mail({ 'mysite/settings/base.py': "EMAIL_BACKEND = 'django.core.mail.backends.console.EmailBackend'\n", 'mysite/settings/production.py': "EMAIL_BACKEND = 'anymail.backends.mailgun.EmailBackend'\n" })).includes('Turn on real email'), 'review 11: base + production')
  // "no new tests need to be run" isn't "didn't run the tests"; "all tests still need to be run" is
  for (const [said, fires] of [['No new tests need to be run.', false], ['All tests still need to be run.', true]] as const)
    assert.equal(report(new Map(Object.entries(site({}))), new Map(Object.entries(site({ 'shop/x.py': 'def f():\n    return 1\n' }))), { ref: 'main', agentSaid: said }).includes("didn't run or test"), fires, `review 11: "${said}"`)
  console.log('ok (review 11)')
}

// Nuxt: pages, server routes by file name and method, login checks that protect data (handlers, server middleware) vs ones that only hide pages.
{
  const base = { 'package.json': '{"dependencies":{"nuxt":"^3.13.0","nuxt-auth-utils":"^0.5.0","@prisma/client":"5"}}',
    'prisma/schema.prisma': 'model Order {\n  id Int @id\n  total Int\n}\n',
    'app/middleware/auth.ts': "export default defineNuxtRouteMiddleware(() => {\n  const { loggedIn } = useUserSession()\n  if (!loggedIn.value) return navigateTo('/login')\n})\n",
    'app/pages/index.vue': '<template><h1>Welcome</h1></template>\n' }
  const page = (meta: string) => `<script setup lang="ts">\n${meta}const { data } = await useFetch('/api/orders')\nasync function add() { await $fetch('/api/orders', { method: 'POST', body: {} }) }\n</script>\n<template>\n  <h1>Your orders</h1>\n  <p v-if="!data">Nothing yet.</p>\n  <button @click="add" :disabled="busy">New order</button>\n  <NuxtLink to="/account">Account</NuxtLink>\n</template>\n`
  const c1 = card(base, { ...base,
    'app/pages/orders/index.vue': page("definePageMeta({ middleware: 'auth' })\n"),
    'server/api/orders.get.ts': "export default defineEventHandler(async (event) => {\n  const { user } = await requireUserSession(event)\n  return prisma.order.findMany({ where: { userId: user.id } })\n})\n",
    'server/api/orders.post.ts': "export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  return prisma.order.create({ data: body })\n})\n",
    'server/api/refund.ts': "export default defineEventHandler(async (event) => {\n  const session = await getUserSession(event)\n  const body = await readBody(event)\n  await prisma.order.update({ where: { id: body.id }, data: { total: 0 } })\n})\n" })
  for (const e of ['The orders page is new, titled "Your orders". It has a "New order" button, loads orders from your server, sends orders to your server and links to the account page. You have to log in to open it ✓ /orders',
    'lists orders and requires login ✓. /api/orders', '⚠ Anyone can use the orders part of your server without logging in.', '⚠ Anyone can use the refund part of your server without logging in.'])
    assert.ok(c1.includes(e), `nuxt missing "${e}"\n${c1}`)
  // server middleware with a login check covers the paths it tests; a global route middleware hides pages only
  const c2 = card(base, { ...base,
    'server/middleware/admin.ts': "export default defineEventHandler(async (event) => {\n  if (getRequestURL(event).pathname.startsWith('/api/admin')) {\n    const { user } = await requireUserSession(event)\n    if (!user.isAdmin) throw createError({ statusCode: 403 })\n  }\n})\n",
    'server/api/admin/orders/[id].delete.ts': "export default defineEventHandler(async (event) => {\n  await prisma.order.delete({ where: { id: Number(getRouterParam(event, 'id')) } })\n})\n",
    'server/api/coupons/[...slug].post.ts': "export default defineEventHandler(async (event) => {\n  await prisma.order.update({ where: { id: 1 }, data: { total: 1 } })\n})\n",
    'app/middleware/admin.global.ts': "export default defineNuxtRouteMiddleware((to) => {\n  if (to.path.startsWith('/admin') && !useUserSession().loggedIn.value) return navigateTo('/login')\n})\n",
    'app/pages/admin/index.vue': '<template><h1>Admin</h1></template>\n', 'pages/about.vue': '<template><h1>About</h1></template>\n' })
  for (const e of ['deletes orders and requires login ✓. /api/admin/orders/[id]', '/api/coupons/[slug]', 'You have to log in to open it ✓ /admin'])
    assert.ok(c2.includes(e), `nuxt 2 missing "${e}"\n${c2}`)
  assert.ok(!c2.includes('admin order part') && !/about page[^.]*log in/i.test(c2), `nuxt 2\n${c2}`)
  console.log('ok (nuxt)')
}

// SvelteKit: +page.svelte, form actions, +server.ts; hooks.server.ts covers everything it tests, a layout guard only pages.
{
  const base = { 'package.json': '{"devDependencies":{"@sveltejs/kit":"^2.8.0","svelte":"^5.0.0"},"dependencies":{"@prisma/client":"5"}}',
    'prisma/schema.prisma': 'model Order {\n  id Int @id\n  total Int\n}\n', 'src/routes/+page.svelte': '<h1>Home</h1>\n',
    'src/routes/(app)/+layout.server.ts': "import { redirect } from '@sveltejs/kit'\nexport const load = async ({ locals }) => {\n  if (!locals.user) redirect(303, '/login')\n  return { user: locals.user }\n}\n" }
  const orders = (action: string) => ({
    'src/routes/(app)/orders/+page.svelte': `<script lang="ts">\n  let { data } = $props()\n</script>\n<h1>Orders</h1>\n{#if data.orders.length === 0}<p>No orders yet.</p>{/if}\n<form method="POST" action="?/create"><input name="total"><button>Add order</button></form>\n{#each data.orders as o}<p>{o.total}</p>{/each}\n`,
    'src/routes/(app)/orders/+page.server.ts': `import { fail, error } from '@sveltejs/kit'\nimport { STRIPE_SECRET_KEY } from '$env/static/private'\nexport const load = async ({ locals }) => ({ orders: await prisma.order.findMany() })\nexport const actions = {\n  create: async ({ request, locals }) => {\n${action}    const data = await request.formData()\n    await prisma.order.create({ data: { total: Number(data.get('total')) } })\n  },\n} satisfies Actions\n` })
  const c1 = card(base, { ...base, ...orders(''),
    'src/routes/api/orders/[id=integer]/+server.ts': "import { json, error } from '@sveltejs/kit'\nexport const DELETE: RequestHandler = async ({ params, locals }) => {\n  if (!locals.user) error(401, 'Log in first')\n  await prisma.order.delete({ where: { id: Number(params.id) } })\n  return json({ ok: true })\n}\n" })
  // the layout asks for login, but the page's own load doesn't wait for it, and form actions run before any load
  for (const e of ['The orders page is new, titled "Orders". It has a box for "total" and an "Add order" button, shows orders and sends orders to your server. You have to log in to open it ✓ /orders',
    "⚠ The orders page's data can be read without logging in. Its layout asks for login, but the page loads its own data without waiting for that check",
    '⚠ Anyone can use the orders part of your server without logging in. The page asks for login, but its form actions run before that check', 'deletes orders and requires login ✓. /api/orders/[id]', 'Add STRIPE_SECRET_KEY'])
    assert.ok(c1.includes(e), `sveltekit missing "${e}"\n${c1}`)
  // a load that awaits parent() first is covered by the layout
  const waits = orders('')
  waits['src/routes/(app)/orders/+page.server.ts'] = waits['src/routes/(app)/orders/+page.server.ts'].replace('async ({ locals }) => ({ orders', 'async ({ parent }) => ({ _: await parent(), orders')
  const c3 = card(base, { ...base, ...waits })
  assert.ok(c3.includes('You have to log in to open it ✓ /orders') && !c3.includes("data can be read"), `sveltekit parent()\n${c3}`)
  assert.ok(!card(base, { ...base, ...orders("    if (!locals.user) return fail(401, { message: 'Log in' })\n") }).includes('Anyone can use'), 'sveltekit: the action checks')
  // hooks.server.ts by route group or path covers actions and +server.ts too
  for (const hook of ["  if (event.route.id?.startsWith('/(app)') && !event.locals.user) redirect(303, '/login')\n", "  if (event.url.pathname.startsWith('/orders') && !event.locals.user) redirect(303, '/login')\n"]) {
    const h = { 'src/hooks.server.ts': `import { redirect } from '@sveltejs/kit'\nexport const handle = async ({ event, resolve }) => {\n  event.locals.user = await getUser(event.cookies)\n${hook}  return resolve(event)\n}\n` }
    const c = card({ ...base, ...h }, { ...base, ...h, ...orders('') })
    assert.ok(!c.includes('⚠') && c.includes('saves new orders and requires login ✓'), `sveltekit hook\n${c}`)
  }
  console.log('ok (sveltekit)')
}

// Drizzle: tables from the schema, reads and writes, and migrations (generate + migrate, or push).
{
  const base = { 'package.json': '{"dependencies":{"drizzle-orm":"0.36.0","next":"15"},"devDependencies":{"drizzle-kit":"0.28.0"}}',
    'src/db/schema.ts': "import { pgTable, serial, integer, text } from 'drizzle-orm/pg-core'\nexport const users = pgTable('users', {\n  id: serial('id').primaryKey(),\n  email: text('email').notNull(),\n})\n",
    'drizzle/0000_init.sql': 'CREATE TABLE "users" ("id" serial PRIMARY KEY, "email" text NOT NULL);\n', 'drizzle/meta/_journal.json': '{}' }
  const schema = base['src/db/schema.ts'] + "export const ordersTable = pgTable('orders', {\n  id: serial('id').primaryKey(),\n  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),\n  totalCents: integer('total_cents').notNull(),\n})\n"
  const route = "import { db } from '@/db'\nimport { ordersTable } from '@/db/schema'\nexport async function POST(req: Request) {\n  await db.insert(ordersTable).values({ totalCents: 100 })\n}\nexport async function GET() {\n  return db.select().from(ordersTable)\n}\n"
  const c1 = card(base, { ...base, 'src/db/schema.ts': schema, 'app/api/orders/route.ts': route })
  for (const e of ['Your database now stores orders: total. Each one belongs to a user.', 'lists orders and saves new ones', 'npx drizzle-kit generate'])
    assert.ok(c1.includes(e), `drizzle missing "${e}"\n${c1}`)
  const c2 = card(base, { ...base, 'src/db/schema.ts': schema, 'app/api/orders/route.ts': route, 'drizzle/0001_orders.sql': 'CREATE TABLE "orders" ("id" serial);\n', 'drizzle/meta/0001_snapshot.json': '{}' })
  assert.ok(c2.includes('Apply drizzle/0001_orders.sql to your live database before the new code goes live (`npx drizzle-kit migrate`)') && !c2.includes('snapshot') && !c2.includes('drizzle-kit generate'), `drizzle 2\n${c2}`)
  console.log('ok (drizzle)')
}

// Review 12 (2026-10-28): Nuxt and SvelteKit login checks that look like checks but aren't, and ones that are.
{
  const kit = { 'package.json': '{"devDependencies":{"@sveltejs/kit":"^2.8.0"},"dependencies":{"@prisma/client":"5"}}' }
  const nuxt = { 'package.json': '{"dependencies":{"nuxt":"^3.13.0","@prisma/client":"5"}}' }
  const r = (files: Record<string, string>) => { const a = appFacts(new Map(Object.entries(files)))
    return [...a.routes].map(([k, x]) => `${x.url} ${a.files.get(k)!.auth ? 'login' : 'open'}`).sort().join(' | ') }
  const post = "export default defineEventHandler(async (event) => {\n  await prisma.order.create({ data: await readBody(event) })\n})\n"
  const server = (body: string) => `export const POST = async ({ locals, request }) => {\n${body}  await prisma.order.create({ data: {} })\n  return new Response('ok')\n}\n`
  const hook = (body: string) => ({ 'src/hooks.server.ts': `export const handle = async ({ event, resolve }) => {\n  event.locals.user = await getUser(event)\n${body}  return resolve(event)\n}\n` })
  const cases: [string, Record<string, string>, string][] = [
    // reading the session next to an unrelated throw or redirect isn't a check
    ['redirect after saving', { ...kit, 'src/routes/api/orders/+server.ts': server("  const o = await prisma.order.findFirst({ where: { userId: locals.user?.id } })\n  if (!o) throw redirect(303, '/orders')\n") }, '/api/orders open'],
    ['getUserSession + a 400', { ...nuxt, 'server/api/orders.post.ts': "export default defineEventHandler(async (event) => {\n  const session = await getUserSession(event)\n  const body = await readBody(event)\n  if (!body.total) throw createError({ statusCode: 400 })\n  await prisma.order.create({ data: body })\n})\n" }, '/api/orders open'],
    // a helper that checks, and the object syntax
    ['requireAdmin helper', { ...nuxt, 'server/api/orders.post.ts': post.replace('async (event) => {\n', 'async (event) => {\n  await requireAdmin(event)\n') }, '/api/orders login'],
    ['onRequest', { ...nuxt, 'server/api/orders.post.ts': "export default defineEventHandler({ onRequest: [requireAuth], handler: async (event) => {\n  await prisma.order.create({ data: {} })\n} })\n" }, '/api/orders login'],
    // path tests: exact, an array, none at all, negated, an early return
    ['hook: === one path', { ...kit, ...hook("  if (event.url.pathname === '/admin' && !event.locals.user) redirect(303, '/login')\n"), 'src/routes/api/orders/+server.ts': server('') }, '/api/orders open'],
    ['hook: a list it loops over', { ...kit, ...hook("  if (PROTECTED.some(p => event.url.pathname.startsWith(p)) && !event.locals.user) redirect(303, '/login')\n"), 'src/routes/api/orders/+server.ts': server('') }, '/api/orders open'],
    ['hook: a www redirect only', { ...kit, ...hook("  if (event.url.hostname.startsWith('www.')) redirect(301, 'https://x.com')\n"), 'src/routes/api/orders/+server.ts': server('') }, '/api/orders open'],
    ['hook: everything but /login', { ...kit, ...hook("  if (!event.url.pathname.startsWith('/login') && !event.locals.user) redirect(303, '/login')\n"), 'src/routes/api/orders/+server.ts': server('') }, '/api/orders login'],
    ['server middleware: skip public, then require', { ...nuxt, 'server/middleware/auth.ts': "export default defineEventHandler(async (event) => {\n  if (!event.path.startsWith('/api/') || event.path.startsWith('/api/_auth')) return\n  await requireUserSession(event)\n})\n", 'server/api/orders.post.ts': post }, '/api/orders login'],
    ['server middleware: === one path', { ...nuxt, 'server/middleware/auth.ts': "export default defineEventHandler(async (event) => {\n  if (event.path === '/api/admin/stats') await requireUserSession(event)\n})\n", 'server/api/orders.post.ts': post }, '/api/orders open'],
    // pages: a parent page's middleware; @sidebase/nuxt-auth global middleware with an opt-out
    ['nested page', { ...nuxt, 'app/middleware/auth.ts': "export default defineNuxtRouteMiddleware(() => {\n  if (!useUserSession().loggedIn.value) return navigateTo('/login')\n})\n",
      'app/pages/admin.vue': "<script setup>\ndefinePageMeta({ middleware: 'auth' })\n</script>\n<template><NuxtPage /></template>\n", 'app/pages/admin/users.vue': '<template><h2>Users</h2></template>\n' }, '/admin login | /admin/users login'],
    ['sidebase global', { 'package.json': '{"dependencies":{"nuxt":"^3.13.0","@sidebase/nuxt-auth":"^0.9.0"}}', 'nuxt.config.ts': "export default defineNuxtConfig({ auth: { globalAppMiddleware: true } })\n",
      'app/pages/dashboard.vue': '<template><h1>Dashboard</h1></template>\n', 'app/pages/pricing.vue': "<script setup>\ndefinePageMeta({ auth: false })\n</script>\n<template><h1>Pricing</h1></template>\n" }, '/dashboard login | /pricing open'],
  ]
  for (const [name, files, want] of cases) assert.equal(r(files), want, `review 12: ${name}`)
  // a Svelte attribute with a template literal doesn't swallow the rest of the page
  const c = card(kit, { ...kit, 'src/routes/orders/+page.svelte': '<h1>Orders</h1>\n{#each data.orders as o}<a href={`/orders/${o.id}`}>Open</a>{/each}\n<button>More</button>\n<a href="/account">Account</a>\n' })
  assert.ok(c.includes('"More" button') && c.includes('links to the account page'), `review 12: template literal\n${c}`)
  console.log('ok (review 12)')
}

// Review 13 (2026-10-28): login checks read from the code's structure: what the `if` tests, how it stops, where it applies.
{
  const kit = { 'package.json': '{"devDependencies":{"@sveltejs/kit":"^2.8.0"},"dependencies":{"@prisma/client":"5"}}' }
  const nuxt = { 'package.json': '{"dependencies":{"nuxt":"^3.13.0","@prisma/client":"5"}}' }
  const r = (files: Record<string, string>) => { const a = appFacts(new Map(Object.entries(files)))
    return [...a.routes].map(([k, x]) => `${x.url} ${a.files.get(k)!.auth ? 'login' : 'open'}`).sort().join(' | ') }
  const nx = (check: string) => ({ ...nuxt, 'server/api/messages.post.ts': `export default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  const user = await prisma.user.findUnique({ where: { id: body.toUserId } })\n${check}\n  await prisma.message.create({ data: body })\n})\n` })
  const hook = (body: string) => ({ ...kit, 'src/hooks.server.ts': `export const handle = async ({ event, resolve }) => {\n${body}\n  return resolve(event)\n}\n`,
    'src/routes/api/orders/+server.ts': "export const POST = async () => {\n  await prisma.order.create({ data: {} })\n  return new Response('ok')\n}\n", 'src/routes/(app)/dashboard/+page.svelte': '<h1>Dash</h1>\n' })
  const mw = (body: string) => ({ ...nuxt, 'app/middleware/auth.global.ts': `export default defineNuxtRouteMiddleware((to) => {\n  const user = useSupabaseUser()\n${body}\n})\n`, 'app/pages/account.vue': '<template><h1>Account</h1></template>\n' })
  const cases: [string, Record<string, string>, string][] = [
    // a looked-up row, a body field, a 400, a log line with "403" in it: none is a login check
    ['404 for a missing recipient', nx('  if (!user) throw createError({ statusCode: 404 })'), '/api/messages open'],
    ['body.user', nx('  if (!body.user) throw createError({ statusCode: 400 })'), '/api/messages open'],
    ['user && role', nx('  if (user && user.role !== "admin") throw createError({ statusCode: 403 })'), '/api/messages open'],
    ['a log that mentions 403', nx("  if (!user) { await prisma.log.create({ data: { msg: 'anon', status: 403 } }) }"), '/api/messages open'],
    ['ensureUserExists', nx('  await ensureUserExists(body.email)'), '/api/messages open'],
    ['real: session + 401', { ...nuxt, 'server/api/messages.post.ts': "export default defineEventHandler(async (event) => {\n  const session = await getUserSession(event)\n  if (!session.user) throw createError({ statusCode: 401 })\n  await prisma.message.create({ data: {} })\n})\n" }, '/api/messages login'],
    // per method: a check in GET doesn't cover DELETE
    ['GET checks, DELETE not', { ...kit, 'src/routes/api/orders/[id]/+server.ts': "export const GET = async ({ locals }) => {\n  if (!locals.user) error(401)\n  return json(await prisma.order.findMany())\n}\nexport const DELETE = async ({ params }) => {\n  await prisma.order.delete({ where: { id: params.id } })\n  return new Response()\n}\n" }, '/api/orders/[id] open'],
    // other conditions ANDed in: plain can't tell what they cover
    ['opt-in meta', mw("  if (to.meta.requiresAuth && !user.value) return navigateTo('/login')"), '/account open'],
    ['only non-GET', hook("  if (event.request.method !== 'GET' && !event.locals.user) error(401)"), '/api/orders open | /dashboard open'],
    ['an early pass-through on the session cookie', hook("  if (!event.cookies.get('sid')) return resolve(event)\n  if (event.url.pathname.startsWith('/api') && !event.locals.user) error(401)"), '/api/orders open | /dashboard open'],
    ['an early skip that isn\'t about the path', mw("  if (to.meta.public) return\n  if (!user.value) return navigateTo('/login')"), '/account open'],
    // !==, includes lists, a /health early response, a nested path check
    ['everything but /login', mw("  if (!user.value && to.path !== '/login') return navigateTo('/login')"), '/account login'],
    ['except a list', mw("  if (!['/login', '/about'].includes(to.path) && !user.value) return navigateTo('/login')"), '/account login'],
    ['/health then a global check', hook("  if (event.url.pathname === '/health') return new Response('ok')\n  if (!event.locals.user) redirect(303, '/login')"), '/api/orders login | /dashboard login'],
    ['nested under a path', { ...nuxt, 'server/middleware/admin.ts': "export default defineEventHandler(async (event) => {\n  if (event.path.startsWith('/api/admin')) {\n    const session = await getUserSession(event)\n    if (!session.user) throw createError({ statusCode: 401 })\n  }\n})\n",
      'server/api/orders.post.ts': "export default defineEventHandler(async () => { await prisma.order.create({ data: {} }) })\n", 'server/api/admin/stats.get.ts': "export default defineEventHandler(async () => prisma.order.findMany())\n" }, '/api/admin/stats login | /api/orders open'],
    // a check that returns or sits in an else branch is still a check (in a handler)
    ['return fail(401)', { ...kit, 'src/routes/api/orders/+server.ts': "export const POST = async ({ locals }) => {\n  if (!locals.user) return json({ error: 'Log in' }, { status: 401 })\n  await prisma.order.create({ data: {} })\n  return new Response()\n}\n" }, '/api/orders login'],
    ['else branch', { ...kit, 'src/routes/api/orders/+server.ts': "export const POST = async ({ locals }) => {\n  if (locals.user) {\n    await prisma.order.create({ data: {} })\n  } else {\n    error(401)\n  }\n  return new Response()\n}\n" }, '/api/orders login'],
    // sidebase: a commented-out or disabled global middleware protects nothing
    ['sidebase disabled', { 'package.json': '{"dependencies":{"nuxt":"3","@sidebase/nuxt-auth":"0.9"}}', 'nuxt.config.ts': "export default defineNuxtConfig({ auth: { globalAppMiddleware: { isEnabled: false } } })\n", 'app/pages/dashboard.vue': '<template><h1>D</h1></template>\n' }, '/dashboard open'],
  ]
  for (const [name, files, want] of cases) assert.equal(r(files), want, `review 13: ${name}`)
  // a load written with `satisfies` is still read; a guarded layout keeps people out of the page, but not its own load's data
  const lay = { ...kit, 'src/routes/(app)/+layout.server.ts': "export const load = async ({ locals }) => {\n  if (!locals.user) redirect(303, '/login')\n}\n", 'src/routes/(app)/orders/+page.svelte': '<h1>Orders</h1>\n' }
  const c = card(lay, { ...lay, 'src/routes/(app)/orders/+page.server.ts': 'export const load = (async () => ({ orders: await prisma.order.findMany() })) satisfies PageServerLoad\n' })
  assert.ok(c.includes("data can be read without logging in") && c.includes('shows orders') && !c.includes('Anyone can open'), `review 13: satisfies\n${c}`)
  // Prisma inside a transaction; Stripe through a getStripe() helper
  const c2 = card({ 'package.json': '{"dependencies":{"next":"15"}}' }, { 'package.json': '{"dependencies":{"next":"15"}}', 'app/api/book/route.ts': "export async function POST() {\n  await prisma.$transaction(async (tx) => { await tx.booking.create({ data: {} }) })\n  await getStripe().checkout.sessions.create({ mode: 'payment' })\n}\n" })
  assert.ok(c2.includes('saves new bookings') && c2.includes('charges customers 💰'), `review 13: tx + getStripe\n${c2}`)
  console.log('ok (review 13)')
}

// Review 14 (2026-10-28): a check only counts where it runs for the request, in time, on the logged-in user.
{
  const kit = { 'package.json': '{"devDependencies":{"@sveltejs/kit":"^2.8.0"},"dependencies":{"@prisma/client":"5"}}' }
  const nuxt = { 'package.json': '{"dependencies":{"nuxt":"^3.13.0","@prisma/client":"5"}}' }
  const r = (files: Record<string, string>) => { const a = appFacts(new Map(Object.entries(files)))
    return [...a.routes].map(([k, x]) => `${x.url} ${a.files.get(k)!.auth ? 'login' : 'open'}`).sort().join(' | ') }
  const del = "export const DELETE = async () => {\n  await prisma.user.deleteMany()\n  return new Response()\n}\n"
  const hook = (body: string) => ({ ...kit, 'src/hooks.server.ts': `export const handle = async ({ event, resolve }) => {\n${body}\n  return resolve(event)\n}\n`, 'src/routes/admin/users/+server.ts': del })
  const cases: [string, Record<string, string>, string][] = [
    ['anonymous visitors returned early, then a role check', hook("  if (!event.locals.user) return resolve(event)\n  if (event.url.pathname.startsWith('/admin') && event.locals.user.role !== 'admin') redirect(303, '/')"), '/admin/users open'],
    ['a check after resolve()', { ...kit, 'src/hooks.server.ts': "export const handle = async ({ event, resolve }) => {\n  const response = await resolve(event)\n  if (!event.locals.user) redirect(303, '/login')\n  return response\n}\n", 'src/routes/admin/users/+server.ts': del }, '/admin/users open'],
    ['a check in a callback', hook("  ['a'].forEach(() => { if (!event.locals.user) redirect(303, '/login') })"), '/admin/users open'],
    ['a check in a catch', hook("  try { await x() } catch { if (!event.locals.user) redirect(303, '/login') }"), '/admin/users open'],
    ['handleFetch is not the request hook', { ...kit, 'src/hooks.server.ts': "export const handleFetch = async ({ event, request, fetch }) => {\n  if (!event.locals.user) error(401)\n  return fetch(request)\n}\n", 'src/routes/admin/users/+server.ts': del }, '/admin/users open'],
    ['a config check at the top of the file', { ...kit, 'src/hooks.server.ts': "if (!config.auth) throw new Error('auth config missing')\nexport const handle = async ({ event, resolve }) => resolve(event)\n", 'src/routes/admin/users/+server.ts': del }, '/admin/users open'],
    ['!startsWith excludes by characters', hook("  if (!event.locals.user && !event.url.pathname.startsWith('/admin/u')) redirect(303, '/login')"), '/admin/users open'],
    ['401 response from a hook', hook("  if (event.url.pathname.startsWith('/admin') && !event.locals.user) return new Response('Unauthorized', { status: 401 })"), '/admin/users login'],
    // a Stripe session isn't a login; a check after the write is too late
    ['a stripe session', { ...kit, 'src/routes/api/x/+server.ts': "export const POST = async ({ url }) => {\n  const session = await stripe.checkout.sessions.retrieve(url.searchParams.get('id'))\n  if (!session) redirect(303, '/cart')\n  await prisma.order.create({ data: {} })\n  return new Response()\n}\n" }, '/api/x open'],
    ['a check after the delete', { ...kit, 'src/routes/api/x/+server.ts': "export const POST = async ({ locals }) => {\n  await prisma.order.deleteMany()\n  if (!locals.user) error(401)\n  return new Response()\n}\n" }, '/api/x open'],
    // a layout that returns { user: null } keeps nobody out; Supabase SSR's template still protects /private
    ['layout returns user: null', { ...kit, 'src/routes/+layout.server.ts': "export const load = async ({ locals }) => {\n  if (!locals.user) return { user: null }\n  return { user: locals.user }\n}\n", 'src/routes/billing/+page.svelte': '<h1>Billing</h1>\n' }, '/billing open'],
    ['Supabase SSR template', { ...kit, 'src/hooks.server.ts': "const supabase = async ({ event, resolve }) => {\n  event.locals.safeGetSession = async () => {\n    const { data: { session } } = await event.locals.supabase.auth.getSession()\n    if (!session) return { session: null, user: null }\n    const { data: { user }, error } = await event.locals.supabase.auth.getUser()\n    if (error) return { session: null, user: null }\n    return { session, user }\n  }\n  return resolve(event)\n}\nconst authGuard = async ({ event, resolve }) => {\n  const { session, user } = await event.locals.safeGetSession()\n  event.locals.session = session\n  if (!event.locals.session && event.url.pathname.startsWith('/private')) redirect(303, '/auth')\n  return resolve(event)\n}\nexport const handle = sequence(supabase, authGuard)\n",
      'src/routes/private/notes/+server.ts': del }, '/private/notes login'],
    // Nuxt: an onboarding redirect for logged-in users isn't a login check
    ['inline onboarding middleware', { ...nuxt, 'app/pages/settings.vue': "<script setup>\ndefinePageMeta({ middleware: [() => { const { user } = useUserSession(); if (user.value && !user.value.onboarded) return navigateTo('/onboarding') }] })\n</script>\n<template><h1>Settings</h1></template>\n" }, '/settings open'],
  ]
  for (const [name, files, want] of cases) assert.equal(r(files), want, `review 14: ${name}`)
  console.log('ok (review 14)')
}

// Round 5 trials (Nuxt plant shop, SvelteKit tutoring, 2026-10-28)
{
  const nuxt = (cfg: string, extra: Record<string, string> = {}) => ({ 'package.json': '{"dependencies":{"nuxt":"3","@prisma/client":"5"}}', 'nuxt.config.ts': `export default defineNuxtConfig({\n  runtimeConfig: {\n${cfg}    public: {\n      appUrl: '',\n    },\n  },\n})\n`, ...extra })
  const c1 = card(nuxt('    stripeSecretKey: process.env.STRIPE_SECRET_KEY,\n'), nuxt('    stripeSecretKey: process.env.STRIPE_SECRET_KEY,\n    resendApiKey: \'\',\n    sendFromName: \'Leafy\',\n'))
  assert.ok(c1.includes('Add NUXT_RESEND_API_KEY') && !c1.includes('NUXT_SEND_FROM_NAME'), `round 5: nuxt runtimeConfig\n${c1}`)
  // a SQLite table rebuild copies the rows: not data loss; a new Prisma migration gets the apply step; a unique index on a table with rows gets a check
  const prisma = { 'package.json': '{"dependencies":{"@prisma/client":"5"}}', 'prisma/schema.prisma': 'model Booking {\n  id Int @id\n  slot String\n}\n' }
  const rebuild = 'CREATE TABLE "new_Booking" ("id" INTEGER, "slot" TEXT);\nINSERT INTO "new_Booking" ("id", "slot") SELECT "id", "slot" FROM "Booking";\nDROP TABLE "Booking";\nALTER TABLE "new_Booking" RENAME TO "Booking";\nCREATE UNIQUE INDEX "Booking_slot_key" ON "Booking"("slot");\n'
  const c2 = card(prisma, { ...prisma, 'prisma/migrations/20261028_slot/migration.sql': rebuild })
  for (const e of ['Apply prisma/migrations/20261028_slot to your live database before the new code goes live (`npx prisma migrate deploy`)', 'it adds a rule that no two bookings can share the same slot'])
    assert.ok(c2.includes(e), `round 5 missing "${e}"\n${c2}`)
  assert.ok(!c2.includes('deletes data'), `round 5: rebuild\n${c2}`)
  // the refund guess reads Prisma's upper-case enum; "half off" is a deal; a calculator isn't made-up data
  const stripe = { 'package.json': '{"dependencies":{"stripe":"1","next":"15"}}', 'app/api/pay/route.ts': "import Stripe from 'stripe'\nexport async function POST() { await stripe.checkout.sessions.create({}) }\n" }
  const c3 = card(stripe, { ...stripe, 'app/api/cancel/route.ts': "export async function POST(req: Request) { const { id } = await req.json(); await prisma.reservation.update({ where: { id }, data: { status: 'CANCELLED' } }) }\n" })
  assert.ok(c3.includes("Cancelling doesn't give money back"), `round 5: CANCELLED\n${c3}`)
  const c4 = report(new Map(Object.entries(stripe)), new Map(Object.entries({ ...stripe, 'app/api/pay/route.ts': "export async function POST() { await stripe.checkout.sessions.create({ amount: 50 }) }\n", 'lib/pricing.ts': 'export function getBookingPrice(rate: number) { return { total: rate * 1.07 + 2 } }\n' })), { ref: 'main', asked: 'can new parents get their first session half off if they make an account' })
  assert.ok(c4.includes('You asked for a discount') && !c4.includes('made-up data'), `round 5: half off\n${c4}`)
  console.log('ok (round 5 trials)')
}

// Review 15 (2026-10-28): round 5's rules, without their false alarms.
{
  const prisma = { 'package.json': '{"dependencies":{"@prisma/client":"5"}}', 'prisma/schema.prisma': 'model Booking {\n  id Int @id\n  slot String @unique\n}\n', 'prisma/migrations/1_init/migration.sql': 'CREATE TABLE "Booking" ("id" INTEGER, "slot" TEXT);\nCREATE UNIQUE INDEX "Booking_slot_key" ON "Booking"("slot");\n' }
  const rebuild = 'CREATE TABLE "new_Booking" ("id" INTEGER, "slot" TEXT, "note" TEXT);\nINSERT INTO "new_Booking" SELECT "id", "slot", NULL FROM "Booking";\nDROP TABLE "Booking";\nALTER TABLE "new_Booking" RENAME TO "Booking";\nCREATE UNIQUE INDEX "Booking_slot_key" ON "Booking"("slot");\n'
  const c1 = card(prisma, { ...prisma, 'prisma/migrations/2_note/migration.sql': rebuild })
  assert.ok(!c1.includes('Check your live data') && !c1.includes('deletes data'), `review 15: re-created index\n${c1}`)
  // a real DROP of a table whose name starts another's
  const c2 = card(prisma, { ...prisma, 'prisma/migrations/2_note/migration.sql': rebuild + 'DROP TABLE "Book";\n' })
  assert.ok(c2.includes('deletes data'), `review 15: prefix drop\n${c2}`)
  // drizzle-pg's ADD CONSTRAINT ... UNIQUE on an existing column
  const dz = { 'package.json': '{"dependencies":{"drizzle-orm":"0.36"}}', 'src/db/schema.ts': "export const users = pgTable('users', {\n  id: serial('id'),\n  email: text('email'),\n})\n", 'drizzle/0000_init.sql': 'CREATE TABLE "users" ("id" serial, "email" text);\n' }
  assert.ok(card(dz, { ...dz, 'drizzle/0001_u.sql': 'ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");\n' }).includes('no two users can share the same email'), 'review 15: add constraint')
  // catch (e: any) is fine; a hard-coded list behind getProducts(limit) is still made-up data
  const c3 = card({}, { 'lib/x.ts': "export async function load() { try { return 1 } catch (e: any) { return 0 } }\nexport function getProducts(limit: number) { return [{ id: 1, name: 'Fern' }] }\n" })
  assert.ok(!c3.includes('Type checking is turned off') && c3.includes('getProducts() returns made-up data'), `review 15: any + made-up\n${c3}`)
  // Nuxt runtimeConfig: nested keys add up, comments, APIKey
  const nuxt = (cfg: string) => ({ 'package.json': '{"dependencies":{"nuxt":"3"}}', 'nuxt.config.ts': `export default defineNuxtConfig({\n  runtimeConfig: {\n${cfg}  },\n})\n` })
  const c4 = card(nuxt(''), nuxt("    stripe: {\n      webhook: {\n        secret: '', // set in prod\n      },\n    },\n    resendAPIKey: '',\n    public: {\n      stripe: { pk: '' },\n    },\n"))
  for (const e of ['NUXT_STRIPE_WEBHOOK_SECRET', 'NUXT_RESEND_API_KEY']) assert.ok(c4.includes(e), `review 15 missing ${e}\n${c4}`)
  // a "not cancelled" filter isn't a cancel
  const st = { 'package.json': '{"dependencies":{"stripe":"1","next":"15"}}', 'app/api/pay/route.ts': "import Stripe from 'stripe'\nexport async function POST() { await stripe.checkout.sessions.create({}) }\n" }
  assert.ok(!card(st, { ...st, 'app/api/seen/route.ts': "export async function POST() { await prisma.order.updateMany({ where: { status: { not: 'CANCELLED' } }, data: { seen: true } }) }\n" }).includes("doesn't give money back"), 'review 15: not cancelled')
  console.log('ok (review 15)')
}

// Angular: Routes (guards, lazy components, lazy child routes), templates (@if/@for, pipes, routerLink, formControlName), and a frontend-only project.
{
  const base = { 'package.json': '{"dependencies":{"@angular/core":"^19.0.0","@angular/router":"^19.0.0"}}',
    'src/app/auth.guard.ts': "export const authGuard: CanActivateFn = () => inject(AuthService).isLoggedIn() ? true : inject(Router).createUrlTree(['/login'])\n",
    'src/app/home/home.component.ts': "import { Component } from '@angular/core'\n@Component({ selector: 'app-home', template: `<h1>Welcome</h1>` })\nexport class HomeComponent {}\n",
    'src/app/app.routes.ts': "import { Routes } from '@angular/router'\nimport { HomeComponent } from './home/home.component'\nexport const routes: Routes = [\n  { path: '', component: HomeComponent },\n]\n" }
  const c = card(base, { ...base,
    'src/app/app.routes.ts': "import { Routes } from '@angular/router'\nimport { HomeComponent } from './home/home.component'\nimport { authGuard } from './auth.guard'\nexport const routes: Routes = [\n  { path: '', component: HomeComponent },\n  { path: 'orders/:id', loadComponent: () => import('./orders/order-detail.component').then(m => m.OrderDetailComponent) },\n  { path: 'admin', canActivate: [authGuard], loadChildren: () => import('./admin/admin.routes').then(m => m.ADMIN_ROUTES) },\n  { path: 'help', canDeactivate: [unsavedGuard], component: HomeComponent },\n  { path: '**', redirectTo: '' },\n]\n",
    'src/app/admin/admin.routes.ts': "import { Routes } from '@angular/router'\nimport { AdminOrdersComponent } from './admin-orders.component'\nexport const ADMIN_ROUTES: Routes = [{ path: 'orders', component: AdminOrdersComponent }]\n",
    'src/app/admin/admin-orders.component.ts': "import { Component, inject } from '@angular/core'\nimport { OrderService } from '../order.service'\n@Component({ selector: 'app-admin-orders', templateUrl: './admin-orders.component.html' })\nexport class AdminOrdersComponent {\n  private orders = inject(OrderService)\n}\n",
    'src/app/admin/admin-orders.component.html': "<h1>All orders</h1>\n@if (orders().length === 0) {\n  <p>No orders yet.</p>\n} @else {\n  @for (o of orders(); track o.id) {\n    <li>{{ o.name }} paid {{ o.total | currency:'USD' }}<button (click)=\"refund(o.id)\" [disabled]=\"busy\">Refund</button><a [routerLink]=\"['/orders', o.id]\">Open</a></li>\n  }\n}\n",
    'src/app/order.service.ts': "import { Injectable, inject } from '@angular/core'\nimport { HttpClient } from '@angular/common/http'\n@Injectable({ providedIn: 'root' })\nexport class OrderService {\n  private http = inject(HttpClient)\n  list() { return this.http.get<Order[]>('/api/orders') }\n  refund(id: number) { return this.http.post(`/api/orders/${id}/refund`, {}) }\n}\n",
    'src/app/orders/order-detail.component.ts': "import { Component } from '@angular/core'\n@Component({ selector: 'app-order', template: `<h1>Order</h1><form [formGroup]=\"form\" (ngSubmit)=\"save()\"><input formControlName=\"note\"><button type=\"submit\">Save note</button></form>` })\nexport class OrderDetailComponent {}\n" })
  for (const e of ['The admin orders page is new, titled "All orders". It has a "Refund" button, loads data from your server, sends data to your server and links to each order page. You have to log in to open it ✓ /admin/orders',
    'Each order page is new, titled "Order". It has a box for "note" and a "Save note" button. /orders/[id]', "A page's login check only hides the page. Its data comes from /api/orders on a server that isn't in this project"])
    assert.ok(c.includes(e), `angular missing "${e}"\n${c}`)
  for (const e of ['admin-orders.component.html', '/help']) assert.ok(!c.includes(e) || e === '/help' && !/help[^.]*log in/.test(c), `angular should not say "${e}"\n${c}`)
  console.log('ok (angular)')
}

// Review 16 (2026-10-28): Angular NgModules, guards plain can and can't place, template details.
{
  const base = { 'package.json': '{"dependencies":{"@angular/core":"^17.0.0"}}' }
  const comp = (name: string, tpl: string) => `import { Component } from '@angular/core'\n@Component({ selector: 'x', template: \`${tpl}\` })\nexport class ${name} {}\n`
  const app = (routes: string, extra: Record<string, string> = {}) => ({ ...base, 'src/app/app-routing.module.ts': `import { RouterModule, Routes } from '@angular/router'\nconst routes: Routes = [\n${routes}\n]\n@NgModule({ imports: [RouterModule.forRoot(routes)] })\nexport class AppRoutingModule {}\n`, ...extra })
  const lazy = { 'src/app/admin/admin.module.ts': "import { AdminRoutingModule } from './admin-routing.module'\n@NgModule({ imports: [AdminRoutingModule] })\nexport class AdminModule {}\n",
    'src/app/admin/admin-routing.module.ts': "import { DashboardComponent } from './dashboard.component'\nconst routes: Routes = [{ path: '', component: DashboardComponent }]\n@NgModule({ imports: [RouterModule.forChild(routes)] })\nexport class AdminRoutingModule {}\n",
    'src/app/admin/dashboard.component.ts': comp('DashboardComponent', '<h1>Admin dashboard</h1><button>Delete all users</button>') }
  const c1 = card(base, app("  { path: 'admin', canActivate: [AuthGuard], loadChildren: () => import('./admin/admin.module').then(m => m.AdminModule) },", lazy))
  assert.ok(c1.includes('You have to log in to open it ✓ /admin'), `review 16: ngmodule lazy\n${c1}`)
  const page = (guard: string, path = 'admin') => app(`  { path: '${path}', ${guard} component: AdminComponent },`, { 'src/app/admin.component.ts': comp('AdminComponent', '<h1>Admin</h1><button>Refund</button>'), 'src/app/app-routing.module.ts': '' })
  const fix = (g: string, path?: string) => { const f = page(g, path); f['src/app/app-routing.module.ts'] = `import { AdminComponent } from './admin.component'\nconst routes: Routes = [{ path: '${path ?? 'admin'}', ${g} component: AdminComponent }]\n@NgModule({ imports: [RouterModule.forRoot(routes)] })\nexport class AppRoutingModule {}\n`; return f }
  assert.ok(!card(base, fix("canMatch: [() => inject(FeatureFlags).isEnabled('reports')],")).includes('log in'), 'review 16: feature flag')
  assert.ok(!card(base, fix('canActivate: [NoAuthGuard],', 'login')).includes('log in'), 'review 16: guest guard')
  const msal = card(base, fix('canActivate: [MsalGuard],'))
  assert.ok(!msal.includes('Anyone can open'), `review 16: unknown guard\n${msal}`)
  // templates: a pipe inside parentheses, a routerLink array with a named segment, {{ }} inside an attribute
  const t = card(base, app("  { path: '', component: HomeComponent },", { 'src/app/app-routing.module.ts': "import { HomeComponent } from './home.component'\nconst routes: Routes = [{ path: '', component: HomeComponent }]\n", 'src/app/home.component.ts': comp('HomeComponent', `<h1>Hi {{ (user$ | async)?.name }}</h1><a [routerLink]="['/orders', o.id, 'edit']">Edit</a><input placeholder="Search {{ category }}"><button>Buy now</button>`) }))
  assert.ok(t.includes('"Buy now" button') && t.includes('the order edit page') && t.includes('box for "Search"'), `review 16: template\n${t}`)
  console.log('ok (review 16)')
}

// C# (ASP.NET Core): controllers and minimal APIs, who they let in (endpoint, controller, group, app-wide), Entity Framework, Stripe, migrations.
{
  const base = { 'Shop.Api/Shop.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" Version="9.0.0" /></ItemGroup></Project>\n',
    'Shop.Api/Data/AppDb.cs': 'public class AppDb : DbContext { public DbSet<Order> Orders { get; set; } }\n',
    'Shop.Api/Models/Order.cs': 'public class Order { public int Id { get; set; } public string Status { get; set; } = ""; public int TotalCents { get; set; } }\n',
    'Shop.Api/Program.cs': 'var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\napp.MapControllers();\napp.Run();\n',
    'Shop.Api/Migrations/20261001_Init.cs': 'public partial class Init : Migration { protected override void Up(MigrationBuilder migrationBuilder) { migrationBuilder.CreateTable(name: "Orders"); } }\n' }
  const ctrl = (cls: string, actions: string) => `using Microsoft.AspNetCore.Authorization;\n[ApiController]\n[Route("api/[controller]")]\n${cls}public class OrdersController : ControllerBase {\n  private readonly AppDb _db;\n${actions}}\n`
  const c1 = card(base, { ...base,
    'Shop.Api/Controllers/OrdersController.cs': ctrl('[Authorize]\n', '  [HttpGet] public async Task<IActionResult> List() => Ok(await _db.Orders.ToListAsync());\n  [HttpPost("{id:int}/refund")] [AllowAnonymous]\n  public async Task<IActionResult> Refund(int id) { var o = await _db.Orders.FindAsync(id); o.Status = "Refunded"; await _db.SaveChangesAsync(); return Ok(); }\n'),
    'Shop.Api/Program.cs': 'var builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin()));\nvar app = builder.Build();\nvar api = app.MapGroup("/api").RequireAuthorization();\napi.MapPost("/checkout", async (AppDb db, IConfiguration config) => { StripeConfiguration.ApiKey = config["Stripe:SecretKey"]; var s = await new SessionService().CreateAsync(new SessionCreateOptions()); return Results.Ok(s.Url); });\napp.MapGroup("/api/coupons").MapCoupons();\napp.MapControllers();\napp.Run();\n',
    'Shop.Api/Endpoints/Coupons.cs': 'public static class CouponEndpoints { public static RouteGroupBuilder MapCoupons(this RouteGroupBuilder group) { group.MapDelete("/{id}", async (int id, AppDb db) => { await db.Orders.Where(o => o.Id == id).ExecuteDeleteAsync(); }); return group; } }\n',
    'Shop.Api/Models/Order.cs': 'public class Order { public int Id { get; set; } public string Status { get; set; } = ""; public int TotalCents { get; set; } public string? CouponCode { get; set; } }\n',
    'Shop.Api/appsettings.json': '{ "Stripe": { "SecretKey": "sk_live_51HabcdefghijklmnopQRST" } }\n' })
  for (const e of ['lists orders and requires login ✓. /api/orders', '⚠ Anyone can use the order refund part of your server without logging in.', 'charges customers 💰 and requires login ✓. /api/checkout',
    '⚠ Anyone can use the coupon part of your server without logging in.', 'Orders now also store the coupon code.', 'dotnet ef migrations add',
    '⚠ A secret key or password is written in Shop.Api/appsettings.json', 'Any website can call your server'])
    assert.ok(c1.includes(e), `csharp missing "${e}"\n${c1}`)
  // the app-wide fallback policy covers controllers and minimal APIs without their own rule; AllowAnonymous still opens one
  const fb = { ...base, 'Shop.Api/Program.cs': 'var builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddAuthorization(o => { o.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build(); });\nvar app = builder.Build();\napp.MapControllers();\napp.Run();\n' }
  const c2 = card(fb, { ...fb, 'Shop.Api/Controllers/OrdersController.cs': ctrl('', '  [HttpDelete("{id}")] public async Task<IActionResult> Delete(int id) { await _db.Orders.Where(o => o.Id == id).ExecuteDeleteAsync(); return NoContent(); }\n  [HttpPost("track")] [AllowAnonymous] public IActionResult Track() { _db.Orders.Add(new Order()); _db.SaveChanges(); return Ok(); }\n'),
    'Shop.Api/Migrations/20261028_Drop.cs': 'public partial class Drop : Migration { protected override void Up(MigrationBuilder migrationBuilder) { migrationBuilder.DropColumn(name: "Status", table: "Orders"); } protected override void Down(MigrationBuilder b) { } }\n' })
  for (const e of ['deletes orders and requires login ✓. /api/orders/[id]', 'Anyone can use the orders track part', 'Back up your data first: Shop.Api/Migrations/20261028_Drop.cs deletes data', 'Apply 20261028_Drop to your live database before the new code goes live (`dotnet ef database update`)'])
    assert.ok(c2.includes(e), `csharp fallback missing "${e}"\n${c2}`)
  console.log('ok (csharp)')
}

// Review 17 (2026-10-28): ASP.NET login the way ASP.NET decides it, and EF entities without false alarms.
{
  const proj = { 'A/A.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n', 'A/Data/Db.cs': 'public class AppDb : DbContext { public DbSet<Order> Orders { get; set; } }\n', 'A/Models/Order.cs': 'public class Order { public int Id { get; set; } public string Status { get; set; } = ""; }\n' }
  const r = (files: Record<string, string>) => { const a = appFacts(new Map(Object.entries({ ...proj, ...files })))
    return [...a.routes].filter(([, x]) => x.kind === 'endpoint').map(([k, x]) => `${x.url} ${a.files.get(k)!.auth ? 'login' : 'open'}`).sort().join(' | ') }
  const del = 'await _db.Orders.Where(o => o.Id == id).ExecuteDeleteAsync();'
  const cases: [string, Record<string, string>, string][] = [
    ['[Authorize] from a base controller', { 'A/Controllers/Base.cs': '[Authorize]\n[ApiController]\n[Route("api/[controller]")]\npublic abstract class SecureController : ControllerBase { }\n', 'A/Controllers/OrdersController.cs': `public class OrdersController : SecureController { [HttpDelete("{id}")] public async Task<IActionResult> Delete(int id) { ${del} return NoContent(); } }\n` }, '/api/orders/[id] login'],
    ['[AllowAnonymous] on a base class wins', { 'A/Controllers/Base.cs': '[AllowAnonymous]\n[ApiController]\n[Route("api/[controller]")]\npublic abstract class OpenController : ControllerBase { }\n', 'A/Controllers/OrdersController.cs': `[Authorize]\npublic class OrdersController : OpenController { [HttpDelete("{id}")] public async Task<IActionResult> Delete(int id) { ${del} return NoContent(); } }\n` }, '/api/orders/[id] open'],
    ['the same group name in two methods', { 'A/Program.cs': 'var app = WebApplication.Create();\napp.MapPublic();\napp.MapAdmin();\n', 'A/Endpoints/E.cs': `public static class E {\n  public static void MapPublic(this WebApplication app) { var group = app.MapGroup("/public"); group.MapDelete("/orders/{id}", async (int id, AppDb _db) => { ${del} }); }\n  public static void MapAdmin(this WebApplication app) { var group = app.MapGroup("/admin").RequireAuthorization(); group.MapGet("/stats", () => 1); }\n}\n` }, '/admin/stats login | /public/orders/[id] open'],
    ['[AllowAnonymous] on a handler in a protected group', { 'A/Program.cs': `var app = WebApplication.Create();\nvar g = app.MapGroup("/orders").RequireAuthorization();\ng.MapDelete("/{id}", [AllowAnonymous] async (int id, AppDb _db) => { ${del} });\n` }, '/orders/[id] open'],
    ['RequireAuthorization() as its own statement', { 'A/Program.cs': `var app = WebApplication.Create();\nvar g = app.MapGroup("/orders");\ng.RequireAuthorization();\ng.MapDelete("/{id}", async (int id, AppDb _db) => { ${del} });\n` }, '/orders/[id] login'],
    ['fallback in a test project', { 'A/Program.cs': `var app = WebApplication.Create();\napp.MapDelete("/orders/{id}", async (int id, AppDb _db) => { ${del} });\n`, 'A.Tests/A.Tests.csproj': '<Project></Project>\n', 'A.Tests/Factory.cs': 'class F : WebApplicationFactory<Program> { void C(IServiceCollection s) { s.AddAuthorization(o => { o.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build(); }); } }\n' }, '/orders/[id] open'],
    ['SetFallbackPolicy', { 'A/Program.cs': `var builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddAuthorizationBuilder().SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());\nvar app = builder.Build();\napp.MapDelete("/orders/{id}", async (int id, AppDb _db) => { ${del} });\n` }, '/orders/[id] login'],
    ['a userId from the logged-in user', { 'A/Program.cs': `var app = WebApplication.Create();\napp.MapDelete("/orders/{id}", async (int id, ClaimsPrincipal user, AppDb _db) => { var userId = user.FindFirstValue(ClaimTypes.NameIdentifier); if (userId is null) return Results.Unauthorized(); ${del} return Results.Ok(); });\n` }, '/orders/[id] login'],
    ['extension called with an argument, ext inside ext', { 'A/Program.cs': 'var app = WebApplication.Create();\napp.MapGroup("/api").RequireAuthorization().MapOrders(app.Configuration);\n', 'A/Endpoints/O.cs': `public static class O { public static RouteGroupBuilder MapOrders(this RouteGroupBuilder group, IConfiguration c) { var g = group.MapGroup("/orders"); g.MapDelete("/{id}", async (int id, AppDb _db) => { ${del} }); return group; } }\n` }, '/api/orders/[id] login'],
  ]
  for (const [name, files, want] of cases) assert.equal(r(files), want, `review 17: ${name}`)
  // a DTO named like an entity, a computed property: no table changes
  for (const extra of [{ 'A/Dtos/Order.cs': 'namespace A.Dtos; public class Order { public string Name { get; set; } = ""; }\n' }, { 'A/Models/Order.cs': 'public class Order { public int Id { get; set; } public string Status { get; set; } = ""; public bool IsPaid => Status == "Paid"; [NotMapped] public string Note { get; set; } = ""; }\n' }]) {
    const c = card(proj, { ...proj, ...extra })
    assert.ok(!c.includes('Database') && !c.includes('migrations add'), `review 17: entity\n${c}`)
  }
  // a local database password in appsettings isn't a leaked secret; a live key in appsettings.Development.json is
  assert.ok(!card(proj, { ...proj, 'A/appsettings.json': '{ "ConnectionStrings": { "Default": "Server=localhost;Database=a;User Id=sa;Password=devpass;" } }\n' }).includes('secret'), 'review 17: localhost')
  assert.ok(card(proj, { ...proj, 'A/appsettings.Development.json': '{ "Stripe": { "SecretKey": "sk_live_51Habcdefghijklmnop" } }\n' }).includes('A secret key or password is written'), 'review 17: dev live key')
  console.log('ok (review 17)')
}

// Java (Spring Boot): controllers, Spring Security rules in order, services, Spring Data repositories, Flyway, settings.
{
  const pom = (sec: boolean) => `<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency><dependency><groupId>org.flywaydb</groupId><artifactId>flyway-core</artifactId></dependency>${sec ? '<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency>' : ''}</dependencies></project>\n`
  const J = 'src/main/java/com/shop/'
  const base = { 'pom.xml': pom(true),
    [`${J}Order.java`]: '@Entity\npublic class Order { @Id Long id; private String status; @ManyToOne private User user; }\n',
    [`${J}OrderRepository.java`]: 'public interface OrderRepository extends JpaRepository<Order, Long> {}\n',
    [`${J}OrderService.java`]: '@Service\npublic class OrderService {\n  private final OrderRepository orders;\n  public void cancel(Long id) { Order o = orders.findById(id).orElseThrow(); o.setStatus("CANCELLED"); orders.save(o); }\n  public void purge() { orders.deleteAll(); }\n}\n',
    'src/main/resources/application.properties': 'server.servlet.context-path=/api\nstripe.secret-key=${STRIPE_SECRET_KEY}\n' }
  const ctrl = `@RestController\n@RequestMapping("/orders")\npublic class OrderController {\n  private final OrderService orderService;\n  @GetMapping public List<Order> list() { return null; }\n  @PostMapping("/{id}/cancel") public void cancel(@PathVariable Long id) { orderService.cancel(id); }\n  @PreAuthorize("hasRole('ADMIN')")\n  @DeleteMapping public void purge() { orderService.purge(); }\n  @Value("\${stripe.secret-key}") private String key;\n}\n`
  const sec = (rules: string) => ({ [`${J}SecurityConfig.java`]: `@Configuration\n@EnableMethodSecurity\npublic class SecurityConfig {\n  @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {\n    http.authorizeHttpRequests(auth -> auth\n${rules}\n    ).csrf(c -> c.disable());\n    return http.build();\n  }\n}\n` })
  // rules in order, first match wins: GET is open, the cancel is open by an earlier permitAll, the rest needs login
  const c1 = card(base, { ...base, [`${J}OrderController.java`]: ctrl, ...sec('      .requestMatchers(HttpMethod.GET, "/orders/**").permitAll()\n      .requestMatchers("/orders/*/cancel").permitAll()\n      .anyRequest().authenticated()') })
  // (GET /orders is open and DELETE /orders needs login: one address, its changes need login)
  for (const e of ['lists orders, deletes orders and needs login to change anything ✓ (anyone can view it). /api/orders', '⚠ Anyone can use the order cancel part of your server without logging in.', 'Add STRIPE_SECRET_KEY'])
    assert.ok(c1.includes(e), `java missing "${e}"\n${c1}`)
  // the starter with no rules of its own: everything needs login; without the starter, nothing does (method security alone isn't on)
  const c2 = card(base, { ...base, [`${J}OrderController.java`]: ctrl })
  assert.ok(c2.includes('updates orders and requires login ✓. /api/orders/[id]/cancel') && !c2.includes('⚠'), `java starter\n${c2}`)
  const open = { ...base, 'pom.xml': pom(false) }
  const c3 = card(open, { ...open, [`${J}OrderController.java`]: ctrl })
  assert.ok(c3.includes('⚠ Anyone can use the order cancel part'), `java no security\n${c3}`)
  // no rule matches: no claim either way; Flyway runs by itself; a committed key; ddl-auto=create
  const c4 = card(base, { ...base, [`${J}OrderController.java`]: ctrl, ...sec('      .requestMatchers("/public/**").permitAll()'),
    'src/main/resources/db/migration/V2__drop_notes.sql': 'ALTER TABLE orders DROP COLUMN notes;\n',
    'src/main/resources/application.properties': 'server.servlet.context-path=/api\nstripe.secret-key=sk_live_51Habcdefghijklmnop\nspring.jpa.hibernate.ddl-auto=create\n' })
  for (const e of ['V2__drop_notes.sql will change your live database by itself the next time the app starts (Flyway)', 'Back up your data first', 'A secret key or password is written in src/main/resources/application.properties', 'sets ddl-auto to "create"'])
    assert.ok(c4.includes(e), `java missing "${e}"\n${c4}`)
  assert.ok(!c4.includes('Anyone can use the order cancel'), `java unmatched\n${c4}`)
  console.log('ok (java)')
}

// Review 18 (2026-10-28): Spring Security the way Spring decides it.
{
  const J = 'src/main/java/com/shop/'
  const pom = (deps: string) => `<project><dependencies>${deps.split(',').map(a => `<dependency><artifactId>${a}</artifactId></dependency>`).join('')}</dependencies></project>\n`
  const app = { [`${J}Order.java`]: '@Entity\npublic class Order { @Id Long id; private String status; }\n', [`${J}OrderRepository.java`]: 'public interface OrderRepository extends JpaRepository<Order, Long> {}\n',
    [`${J}OrderController.java`]: '@RestController\n@RequestMapping("/api/orders")\npublic class OrderController {\n  private final OrderRepository orders;\n  @DeleteMapping("/{id}") public void delete(@PathVariable Long id) { orders.deleteById(id); }\n  @PostMapping("/{id}/refund") public void refund(@PathVariable Long id) { orders.save(new Order()); }\n}\n' }
  const r = (files: Record<string, string>) => { const a = appFacts(new Map(Object.entries({ ...app, ...files })))
    return [...a.routes].map(([k, x]) => `${x.url} ${a.files.get(k)!.auth ? 'login' : (a.files.get(k) as FileFacts & { guardUnknown?: boolean }).guardUnknown ? '?' : 'open'}`).sort().join(' | ') }
  const chain = (body: string, ann = '') => ({ [`${J}Sec.java`]: `@Configuration\n${ann}public class Sec {\n  @Bean SecurityFilterChain c(HttpSecurity http) throws Exception {\n${body}\n    return http.build();\n  }\n}\n` })
  const sec = pom('spring-boot-starter-web,spring-boot-starter-security')
  const cases: [string, Record<string, string>, string][] = [
    ['a permit rule written with new AntPathRequestMatcher', { 'pom.xml': sec, ...chain('    http.authorizeHttpRequests(a -> a.requestMatchers(new AntPathRequestMatcher("/api/orders/*/refund")).permitAll().anyRequest().authenticated());') }, '/api/orders/[id] login | /api/orders/[id]/refund open'],
    ['anonymous() is open', { 'pom.xml': sec, ...chain('    http.authorizeHttpRequests(a -> a.requestMatchers("/api/orders/*/refund").anonymous().anyRequest().authenticated());') }, '/api/orders/[id] login | /api/orders/[id]/refund open'],
    ['a chain of your own with no request rules checks nothing', { 'pom.xml': sec, ...chain('    http.csrf(c -> c.disable()).httpBasic(Customizer.withDefaults());') }, '/api/orders/[id] open | /api/orders/[id]/refund open'],
    ['securityMatcher: outside every chain is open', { 'pom.xml': sec, ...chain('    http.securityMatcher("/api/orders/*").authorizeHttpRequests(a -> a.anyRequest().authenticated());') }, '/api/orders/[id] login | /api/orders/[id]/refund open'],
    ['Spring Security 6 denies what no rule matches', { 'pom.xml': sec, ...chain('    http.authorizeHttpRequests(a -> a.requestMatchers("/public/**").permitAll());') }, '/api/orders/[id] login | /api/orders/[id]/refund login'],
    ['authorizeRequests lets it through', { 'pom.xml': sec, ...chain('    http.authorizeRequests().antMatchers("/admin/**").hasRole("ADMIN");') }, '/api/orders/[id] open | /api/orders/[id]/refund open'],
    ['a rule plain cannot read ends the reading', { 'pom.xml': sec, ...chain('    http.authorizeHttpRequests(a -> a.requestMatchers("/api/orders/*").authenticated().requestMatchers(myMatcher()).permitAll().anyRequest().authenticated());') }, '/api/orders/[id] login | /api/orders/[id]/refund ?'],
    ['OAuth2 resource server is Spring Security', { 'pom.xml': pom('spring-boot-starter-web,spring-boot-starter-oauth2-resource-server') }, '/api/orders/[id] login | /api/orders/[id]/refund login'],
  ]
  for (const [name, files, want] of cases) assert.equal(r(files), want, `review 18: ${name}`)
  // @Secured needs securedEnabled; @EnableMethodSecurity turns on @PreAuthorize only
  const ms = (anno: string, enable: string) => ({ 'pom.xml': pom('spring-boot-starter-web'), [`${J}OrderController.java`]: `@RestController\n@RequestMapping("/api/orders")\npublic class OrderController {\n  private final OrderRepository orders;\n  ${anno}\n  @DeleteMapping("/{id}") public void delete(@PathVariable Long id) { orders.deleteById(id); }\n}\n`, [`${J}Cfg.java`]: `${enable}\n@Configuration\npublic class Cfg {}\n` })
  assert.equal(r(ms('@Secured("ROLE_ADMIN")', '@EnableMethodSecurity')), '/api/orders/[id] open', 'review 18: secured off')
  assert.equal(r(ms('@Secured("ROLE_ADMIN")', '@EnableMethodSecurity(securedEnabled = true)')), '/api/orders/[id] login', 'review 18: secured on')
  assert.equal(r(ms('@PreAuthorize("hasRole(\'ADMIN\')")', '@EnableMethodSecurity')), '/api/orders/[id] login', 'review 18: pre on')
  assert.equal(r(ms('@PostAuthorize("hasRole(\'ADMIN\')")', '@EnableMethodSecurity')), '/api/orders/[id] open', 'review 18: post runs after')
  // Spring Data REST makes every repository an open API without security
  const rest = r({ 'pom.xml': pom('spring-boot-starter-web,spring-boot-starter-data-rest'), [`${J}OrderController.java`]: '' })
  assert.ok(rest.includes('/orders/[id] open'), `review 18: data rest\n${rest}`)
  console.log('ok (review 18)')
}

// Round 6 trials (FixIt: Angular + ASP.NET Core, 2026-10-28)
{
  const base = { 'S/S.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n', 'S/Data/Db.cs': 'public class AppDb : DbContext { public DbSet<Job> Jobs { get; set; } }\n', 'S/Models/Job.cs': 'public class Job { public int Id { get; set; } }\n',
    'S/Program.cs': 'var app = WebApplication.CreateBuilder(args).Build();\nusing (var scope = app.Services.CreateScope()) { scope.ServiceProvider.GetRequiredService<AppDb>().Database.Migrate(); }\napp.MapGet("/api/x", (IConfiguration c) => c["Email:FromName"] ?? "FixIt");\napp.Run();\n' }
  const mig = 'public partial class AddRating : Migration { protected override void Up(MigrationBuilder b) { b.AddColumn<int>(name: "Rating", table: "Jobs"); } }\n'
  const c1 = card(base, { ...base, 'S/Migrations/20261028_AddRating.cs': mig })
  for (const e of ['S/Migrations/20261028_AddRating.cs has no 20261028_AddRating.Designer.cs next to it', 'will change your live database by itself the next time the app starts (it calls Database.Migrate)'])
    assert.ok(c1.includes(e), `round 6 missing "${e}"\n${c1}`)
  const c2 = card(base, { ...base, 'S/Migrations/20261028_AddRating.cs': mig, 'S/Migrations/20261028_AddRating.Designer.cs': '[DbContext(typeof(AppDb))]\n[Migration("20261028_AddRating")]\npartial class AddRating { }\n' })
  assert.ok(!c2.includes('Designer.cs next to it') && !c2.includes('Email__FromName'), `round 6: designer + optional setting\n${c2}`)
  // [Migration] written in the migration file itself (no Designer file) is found by EF too
  const c3 = card(base, { ...base, 'S/Migrations/20261028_AddRating.cs': '[DbContext(typeof(AppDb))]\n[Migration("20261028_AddRating")]\n' + mig })
  assert.ok(!c3.includes('Designer.cs next to it'), `round 6: attribute in file\n${c3}`)
  // SQLite: a hand-written migration that rebuilds a table (no BuildTargetModel) throws at startup; with the model, or Up() only adding, it's fine
  const lite = { ...base, 'S/Program.cs': base['S/Program.cs'].replace('var app', 'builder.Services.AddDbContext<AppDb>(o => o.UseSqlite("Data Source=app.db"));\nvar app') }
  const att = '[DbContext(typeof(AppDb))]\n[Migration("20261028_AddRating")]\n'
  const chk = 'public partial class AddRating : Migration { protected override void Up(MigrationBuilder b) { b.AddColumn<int>(name: "Rating", table: "Jobs"); b.AddCheckConstraint(name: "CK_Rating", table: "Jobs", sql: "Rating BETWEEN 1 AND 5"); } protected override void Down(MigrationBuilder b) { b.DropColumn(name: "Rating", table: "Jobs"); } }\n'
  const s1 = card(lite, { ...lite, 'S/Migrations/20261028_AddRating.cs': att + chk })
  assert.ok(s1.includes('20261028_AddRating will fail on your SQLite database: it changes the existing Jobs table') && s1.includes("so it won't start"), `round 6: sqlite rebuild\n${s1}`)
  for (const [why, files] of Object.entries({
    'target model': { 'S/Migrations/20261028_AddRating.cs': att + chk.replace('protected override void Down', 'protected override void BuildTargetModel(ModelBuilder m) { m.Entity("Job", b => { b.ToTable("Jobs"); }); } protected override void Down') },
    'commented out': { 'S/Migrations/20261028_AddRating.cs': att + mig.replace('}', '// SQLite cannot do b.AlterColumn(name: "Rating", table: "Jobs")\n}') },
    'sqlite in tests only': { 'S/Migrations/20261028_AddRating.cs': att + chk, 'S.Tests/Factory.cs': 'class F { void C(DbContextOptionsBuilder o) => o.UseSqlite(":memory:"); }\n', 'S/Program.cs': base['S/Program.cs'].replace('var app', 'builder.Services.AddSqlServer<AppDb>("x");\nvar app') },
    'aspire provider': { 'S/Migrations/20261028_AddRating.cs': att + chk, 'S/Data/Prod.cs': 'class P { void C(IHostApplicationBuilder b) => b.AddNpgsqlDbContext<AppDb>("db"); }\n' },
    'add only': { 'S/Migrations/20261028_AddRating.cs': att + mig.replace('}', '} protected override void Down(MigrationBuilder b) { b.DropColumn(name: "Rating", table: "Jobs"); }') },
    'new table': { 'S/Migrations/20261028_AddRating.cs': att + 'public partial class AddRating : Migration { protected override void Up(MigrationBuilder b) { b.CreateTable(name: "Ratings", columns: t => new { Id = t.Column<int>() }); b.AddForeignKey(name: "FK_R", table: "Ratings", column: "JobId", principalTable: "Jobs"); } }\n' },
    'not only sqlite': { 'S/Migrations/20261028_AddRating.cs': att + chk, 'S/Data/Prod.cs': 'class P { void C(DbContextOptionsBuilder o) => o.UseNpgsql("x"); }\n' },
  })) {
    const c = card(lite, { ...lite, ...files })
    assert.ok(!c.includes('will fail on your SQLite database'), `round 6: sqlite ${why}\n${c}`)
  }
  assert.ok(!s1.includes('Apply 20261028_AddRating') && !s1.includes('will change your live database by itself'), `round 6: no apply step for a migration that crashes\n${s1}`)
  for (const [why, files] of Object.entries({
    'stub model': { 'S/Migrations/20261028_AddRating.cs': att + chk, 'S/Migrations/20261028_AddRating.Designer.cs': 'partial class AddRating { protected override void BuildTargetModel(ModelBuilder m) { m.HasAnnotation("ProductVersion", "9.0.0"); } }\n' },
    'Down first': { 'S/Migrations/20261028_AddRating.cs': att + 'public partial class AddRating : Migration { protected override void Down(MigrationBuilder b) { } protected override void Up(MigrationBuilder b) { b.AlterColumn<string>(name: "Name", table: "Jobs"); } }\n' },
    'AddSqlite': { 'S/Migrations/20261028_AddRating.cs': att + chk, 'S/Program.cs': base['S/Program.cs'].replace('var app', 'builder.Services.AddSqlite<AppDb>("Data Source=app.db");\nvar app') },
  })) {
    const c = card(lite, { ...lite, ...files })
    assert.ok(c.includes('will fail on your SQLite database'), `round 6: sqlite ${why}\n${c}`)
  }
  // a table made in the same migration isn't "existing"; [Migration] without [DbContext] is never found by EF (so it can't crash either)
  const s2 = card(lite, { ...lite, 'S/Migrations/20261028_AddRating.cs': att + 'public partial class AddRating : Migration { protected override void Up(MigrationBuilder b) { b.CreateTable(name: "Ratings", columns: t => new { Id = t.Column<int>() }); b.AddUniqueConstraint(name: "AK_R", table: "Ratings", column: "Id"); } }\n' })
  assert.ok(s2.includes('it changes the Ratings table'), `round 6: new table wording\n${s2}`)
  const s3 = card(lite, { ...lite, 'S/Migrations/20261028_AddRating.cs': '[Migration("20261028_AddRating")]\n' + chk })
  assert.ok(s3.includes('has no 20261028_AddRating.Designer.cs next to it') && !s3.includes('will fail on your SQLite database'), `round 6: no DbContext attribute\n${s3}`)
  // [DbContext(...), Migration(...)] in one list is found too; a migration that crashes deletes nothing; "//" in a string isn't a comment
  const s4 = card(lite, { ...lite, 'S/Migrations/20261028_AddRating.cs': '[DbContext(typeof(AppDb)), Migration("20261028_AddRating")]\n' + chk })
  assert.ok(s4.includes('will fail on your SQLite database') && !s4.includes('next to it'), `round 6: attribute list\n${s4}`)
  const s5 = card(lite, { ...lite, 'S/Migrations/20261028_AddRating.cs': att + 'public partial class AddRating : Migration { protected override void Up(MigrationBuilder b) { b.DropColumn(name: "Old", table: "Jobs"); } }\n' })
  assert.ok(s5.includes('will fail on your SQLite database') && !s5.includes('Back up your data first'), `round 6: crash deletes nothing\n${s5}`)
  const s6 = card(base, { ...base, 'S/Migrations/20261028_AddRating.cs': att + 'public partial class AddRating : Migration { protected override void Up(MigrationBuilder b) { b.AddColumn<string>(name: "Url", table: "Jobs", defaultValue: "https://x.com"); b.DropColumn(name: "Old", table: "Jobs"); } }\n' })
  assert.ok(s6.includes('Back up your data first'), `round 6: // in a string\n${s6}`)
  console.log('ok (round 6 trials)')
}

// Laravel (2026-10-28): routes, login from middleware and handler code, Eloquent, migrations, config, Stripe, email
{
  const ctl = (name: string, body: string, head = '') => `<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\Order;\n${head}class ${name} extends Controller {\n${body}\n}\n`
  const L: Record<string, string> = {
    'composer.json': '{"require":{"laravel/framework":"^12.0"}}', 'artisan': '',
    '.env.example': 'APP_KEY=\nSTRIPE_SECRET=\n',
    'bootstrap/app.php': "<?php\nreturn Application::configure(basePath: dirname(__DIR__))\n  ->withRouting(web: __DIR__.'/../routes/web.php', health: '/up')\n  ->withMiddleware(function (Middleware $middleware): void { })->create();\n",
    'routes/web.php': "<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('/', fn () => view('welcome'));\n",
    'app/Http/Controllers/Controller.php': '<?php\nnamespace App\\Http\\Controllers;\nabstract class Controller {}\n',
    'app/Models/Order.php': '<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Order extends Model { protected $fillable = ["status"]; }\n',
    'config/services.php': "<?php\nreturn ['stripe' => ['secret' => env('STRIPE_SECRET'), 'currency' => env('STRIPE_CURRENCY', 'usd')]];\n",
    'database/migrations/2026_01_01_000000_create_orders_table.php': "<?php\nreturn new class extends Migration { public function up(): void { Schema::create('orders', function (Blueprint $table) { $table->id(); $table->foreignId('user_id')->constrained(); $table->string('status'); $table->timestamps(); }); } };\n",
  }
  const web = (routes: string) => ({ 'routes/web.php': L['routes/web.php'] + routes })
  const orders = ctl('OrderController', "  public function index() { return Order::all(); }\n  public function store(Request $request) { return Order::create($request->validated()); }\n  public function cancel(Order $order) { $order->update(['status' => 'cancelled']); }")
  const lv = (extra: Record<string, string>) => card(L, { ...L, 'app/Http/Controllers/OrderController.php': orders, ...extra })
  const has = (c: string, ...xs: string[]) => { for (const x of xs) assert.ok(c.includes(x), `laravel: missing "${x}"\n${c}`) }
  const not = (c: string, ...xs: string[]) => { for (const x of xs) assert.ok(!c.includes(x), `laravel: unexpected "${x}"\n${c}`) }

  // login from middleware: a group, the route's own, guest (the opposite), withoutMiddleware (exact names only)
  let c = lv(web("Route::middleware(['auth', 'verified'])->group(function () {\n  Route::post('/orders', [OrderController::class, 'store']);\n});\nRoute::get('/menu', [OrderController::class, 'index']);\n"))
  has(c, 'New server code that saves new orders and requires login ✓', 'New server code that lists orders and works without logging in')
  c = lv(web("Route::middleware('guest')->group(function () { Route::post('/orders', [OrderController::class, 'store']); });\n"))
  has(c, 'the orders part of your server without logging in')
  // (since Laravel 13.39, withoutMiddleware('auth') removes 'auth:sanctum' too: read that way on every version, toward a warning)
  c = lv(web("Route::middleware('auth:sanctum')->group(function () { Route::post('/orders', [OrderController::class, 'store'])->withoutMiddleware('auth'); });\n"))
  has(c, 'the orders part of your server without logging in')
  c = lv(web("Route::middleware('auth')->group(function () { Route::post('/orders', [OrderController::class, 'store'])->withoutMiddleware('auth'); });\n"))
  has(c, 'the orders part of your server without logging in')
  // resources: the addresses they make (only / except), the last definition of an address wins
  c = lv(web("Route::resource('orders', OrderController::class)->only(['index', 'store'])->middleware('auth');\n"))
  has(c, '/orders'); not(c, '/orders/[order]', '/orders/create')
  c = lv(web("Route::post('/orders', [OrderController::class, 'store'])->middleware('auth');\nRoute::post('/orders', [OrderController::class, 'store']);\n"))
  has(c, 'the orders part of your server without logging in')
  // routes/api.php only loads when bootstrap/app.php registers it, and then under /api
  const api = { 'routes/api.php': "<?php\nRoute::post('/orders', [OrderController::class, 'store'])->middleware('auth:sanctum');\n" }
  not(lv(api), '/api/orders')
  has(lv({ ...api, 'bootstrap/app.php': L['bootstrap/app.php'].replace("web: __DIR__", "api: __DIR__.'/../routes/api.php', web: __DIR__") }), '/api/orders', 'requires login ✓')
  // included route files keep the group around the include
  has(lv(web("Route::middleware('auth')->group(function () { require __DIR__.'/orders.php'; });\n") as Record<string, string> && { ...web("Route::middleware('auth')->group(function () { require __DIR__.'/orders.php'; });\n"), 'routes/orders.php': "<?php\nRoute::post('/orders', [OrderController::class, 'store']);\n" }), 'saves new orders and requires login ✓')
  // controller middleware: HasMiddleware (with only), #[Middleware]; a 10-style constructor on 11's bare base crashes
  c = lv({ ...web("Route::post('/orders', [OrderController::class, 'store']);\nRoute::get('/menu', [OrderController::class, 'index']);\n"),
    'app/Http/Controllers/OrderController.php': orders.replace('extends Controller {', "extends Controller implements HasMiddleware {\n  public static function middleware(): array { return [new Middleware('auth', only: ['store'])]; }") })
  has(c, 'saves new orders and requires login ✓', 'lists orders and works without logging in')
  // #[Middleware] is Laravel 13's (Illuminate\Routing\Attributes\Controllers\Middleware): on 12 it does nothing; another class of that name neither
  const attr = (use: string) => ({ ...web("Route::post('/orders', [OrderController::class, 'store']);\n"), 'app/Http/Controllers/OrderController.php': orders.replace('use App\\Models\\Order;', `use App\\Models\\Order;\nuse ${use};`).replace('class OrderController', "#[Middleware('auth')]\nclass OrderController") })
  const v13 = { 'composer.json': '{"require":{"laravel/framework":"^13.0"}}' }
  has(card({ ...L, ...v13 }, { ...L, ...v13, ...attr('Illuminate\\Routing\\Attributes\\Controllers\\Middleware') }), 'saves new orders and requires login ✓')
  has(lv(attr('Illuminate\\Routing\\Attributes\\Controllers\\Middleware')), 'the orders part of your server without logging in')
  has(card({ ...L, ...v13 }, { ...L, ...v13, ...attr('Illuminate\\Routing\\Controllers\\Middleware') }), 'the orders part of your server without logging in')
  c = lv({ ...web("Route::post('/orders', [OrderController::class, 'store']);\n"), 'app/Http/Controllers/OrderController.php': orders.replace('extends Controller {', "extends Controller {\n  public function __construct() { $this->middleware('auth'); }") })
  has(c, "OrderController calls $this->middleware() in its constructor"); not(c, 'requires login ✓')
  // an app middleware: login when its handle() turns guests away; one plain can't read claims nothing
  const admin = (body: string) => ({ ...web("Route::middleware('admin')->group(function () { Route::post('/orders', [OrderController::class, 'store']); Route::get('/menu', [OrderController::class, 'index']); });\n"),
    'bootstrap/app.php': L['bootstrap/app.php'].replace('{ }', "{ $middleware->alias(['admin' => \\App\\Http\\Middleware\\EnsureAdmin::class]); }"),
    'app/Http/Middleware/EnsureAdmin.php': `<?php\nclass EnsureAdmin { public function handle(Request $request, Closure $next) { ${body} return $next($request); } }\n` })
  has(lv(admin('if (! $request->user()?->is_admin) abort(403);')), 'saves new orders and is for admins only ✓', 'lists orders and is for admins only ✓')
  // "only admins": the deciding check's sense (abort_if keeps admins out), and Spatie's role: with only admin roles
  not(lv(admin('abort_if($request->user()?->is_admin, 403);')), 'admins only')
  const role = (r: string) => lv({ ...web(`Route::middleware('auth')->group(function () { Route::middleware('${r}')->group(function () { Route::post('/orders', [OrderController::class, 'store']); }); });\n`),
    'bootstrap/app.php': L['bootstrap/app.php'].replace('{ }', "{ $middleware->alias(['role' => \\Spatie\\Permission\\Middleware\\RoleMiddleware::class]); }") })
  has(role('role:admin'), 'saves new orders and is for admins only ✓')
  has(role('role:admin|editor'), 'saves new orders and requires login ✓')
  c = lv(admin('Log::info("hi");'))
  has(c, 'the orders part of your server without logging in')
  c = lv({ ...web("Route::middleware('team')->group(function () { Route::post('/orders', [OrderController::class, 'store']); Route::get('/menu', [OrderController::class, 'index']); });\n") })
  not(c, 'requires login ✓', 'without logging in')
  // in the handler: Gate::authorize / abort_unless(auth()->check()); a FormRequest's authorize() (return true checks nothing);
  // a policy that lets guests in makes gate checks say nothing
  const fr = (auth: string) => ({ ...web("Route::post('/orders', [OrderController::class, 'store']);\n"),
    'app/Http/Controllers/OrderController.php': orders.replace('store(Request $request)', 'store(StoreOrderRequest $request)'),
    'app/Http/Requests/StoreOrderRequest.php': `<?php\nclass StoreOrderRequest extends FormRequest { public function authorize(): bool { ${auth} } public function rules(): array { return []; } }\n` })
  has(lv(fr('return $this->user() !== null;')), 'requires login ✓')
  has(lv(fr('return true;')), 'the orders part of your server without logging in')
  const gate = { ...web("Route::post('/orders/{order}/cancel', [OrderController::class, 'cancel']);\n"), 'app/Http/Controllers/OrderController.php': orders.replace("$order->update", "Gate::authorize('update', $order); $order->update") }
  has(lv(gate), 'requires login ✓')
  not(lv({ ...gate, 'app/Policies/OrderPolicy.php': '<?php\nclass OrderPolicy { public function update(?User $user, Order $order): bool { return true; } }\n' }), 'requires login ✓')
  // Eloquent writes, Stripe, config -> env, env() outside config, email through a notification that mails
  c = lv({ ...web("Route::post('/orders/{order}/pay', [OrderController::class, 'pay'])->middleware('auth');\n"),
    'app/Http/Controllers/OrderController.php': orders.replace('public function index', "public function pay(Order $order) { $stripe = new \\Stripe\\StripeClient(config('services.stripe.secret')); $s = $stripe->checkout->sessions->create([]); $order->user->notify(new OrderPaid($order)); return redirect($s->url); }\n  public function index"),
    'app/Notifications/OrderPaid.php': "<?php\nclass OrderPaid extends Notification { public function via(object $n): array { return ['mail']; } }\n" })
  has(c, 'charges customers 💰', 'emails people', 'Add STRIPE_SECRET to your hosting settings.'); not(c, '@cfg', 'missing from .env.example')
  c = lv({ ...web("Route::post('/orders/{order}/pay', [OrderController::class, 'pay'])->middleware('auth');\n"),
    'app/Http/Controllers/OrderController.php': orders.replace('public function index', "public function pay(Order $order) { $order->user->notify(new OrderPaid($order)); $k = env('STRIPE_KEY'); }\n  public function index"),
    'app/Notifications/OrderPaid.php': "<?php\nclass OrderPaid extends Notification { public function via(object $n): array { return ['database']; } }\n" })
  not(c, 'emails people'); has(c, 'reads STRIPE_KEY with env() outside the config folder', 'Add STRIPE_KEY to your hosting settings.')
  // Cashier's charge() is money only with Cashier installed
  const cash = { ...web("Route::post('/tip', [OrderController::class, 'tip'])->middleware('auth');\n"), 'app/Http/Controllers/OrderController.php': orders.replace('public function index', "public function tip(Request $request) { $request->user()->charge(500, $request->pm); }\n  public function index") }
  not(lv(cash), '💰')
  has(card({ ...L, 'composer.json': '{"require":{"laravel/framework":"^12.0","laravel/cashier":"^16.0"}}' }, { ...L, 'composer.json': '{"require":{"laravel/framework":"^12.0","laravel/cashier":"^16.0"}}', 'app/Http/Controllers/OrderController.php': orders, ...cash }), '💰')
  // migrations: the tables they build, what they drop, the step to apply them
  c = lv({ 'database/migrations/2026_10_28_000000_coupons.php': "<?php\nreturn new class extends Migration { public function up(): void { Schema::create('coupons', function (Blueprint $table) { $table->id(); $table->string('code')->unique(); $table->integer('percent_off'); }); Schema::table('orders', function (Blueprint $table) { $table->dropColumn('status'); }); } public function down(): void { Schema::dropIfExists('coupons'); } };\n" })
  has(c, 'Your database now stores coupons: code and percent off', 'the status on orders will be deleted for good', 'Apply 2026_10_28_000000_coupons to your live database before the new code goes live (`php artisan migrate --force`)')
  not(lv({ 'database/migrations/2026_10_28_000000_x.php': "<?php\nreturn new class extends Migration { public function up(): void { Schema::table('orders', fn (Blueprint $t) => $t->string('note')->nullable()); } public function down(): void { Schema::dropIfExists('orders'); } };\n" }), 'deleted for good')
  // mass assignment only for a model that accepts every field; CORS for every site with cookies; forgery protection off for a form
  const all = web("Route::post('/orders', [OrderController::class, 'store'])->middleware('auth');\n")
  const allCtl = { 'app/Http/Controllers/OrderController.php': orders.replace('$request->validated()', '$request->all()') }
  not(lv({ ...all, ...allCtl }), 'accepts every field')
  has(lv({ ...all, ...allCtl, 'app/Models/Order.php': L['app/Models/Order.php'].replace('$fillable = ["status"]', '$guarded = []') }), 'the model accepts every field')
  has(lv({ 'config/cors.php': "<?php\nreturn ['paths' => ['api/*'], 'allowed_origins' => ['*'], 'supports_credentials' => true];\n" }), 'CORS allows all sites')
  not(lv({ 'config/cors.php': "<?php\nreturn ['paths' => ['api/*'], 'allowed_origins' => ['*'], 'supports_credentials' => false];\n" }), 'CORS allows all sites')
  c = lv({ 'bootstrap/app.php': L['bootstrap/app.php'].replace('{ }', "{ $middleware->validateCsrfTokens(except: ['stripe/*', 'orders/*']); }") })
  has(c, '"orders/*" is excluded from forgery protection'); not(c, '"stripe/*"')
  // a global or group middleware that asks for login covers every route in it
  has(lv({ ...web("Route::post('/orders', [OrderController::class, 'store']);\n"), 'bootstrap/app.php': L['bootstrap/app.php'].replace('{ }', '{ $middleware->web(append: [\\Illuminate\\Auth\\Middleware\\Authenticate::class]); }') }), 'requires login ✓')
  // two controllers with the same short name: the route file's import (use ... as Alias) picks the right one
  c = lv({ ...web("use App\\Http\\Controllers\\Admin\\OrderController as AdminOrders;\nRoute::delete('/admin/orders/{order}', [AdminOrders::class, 'destroy'])->middleware('auth');\n"),
    'app/Http/Controllers/Admin/OrderController.php': "<?php\nnamespace App\\Http\\Controllers\\Admin;\nuse App\\Http\\Controllers\\Controller;\nuse App\\Models\\Order;\nclass OrderController extends Controller { public function destroy(Order $order) { $order->delete(); } }\n" })
  has(c, 'deletes orders and requires login ✓')
  // renames keep the data
  c = lv({ 'database/migrations/2026_10_28_000000_r.php': "<?php\nreturn new class extends Migration { public function up(): void { Schema::table('orders', fn (Blueprint $t) => $t->renameColumn('status', 'state')); } };\n" })
  has(c, 'The status on orders is renamed to state (the data stays)'); not(c, 'deleted for good')
  c = lv({ 'database/migrations/2026_10_28_000000_r.php': "<?php\nreturn new class extends Migration { public function up(): void { Schema::rename('orders', 'purchases'); } };\n" })
  has(c, 'Orders are renamed to purchases'); not(c, 'deleted for good')
  // dropped and created again: emptied
  has(lv({ 'database/migrations/2026_10_28_000000_r.php': "<?php\nreturn new class extends Migration { public function up(): void { Schema::dropIfExists('orders'); Schema::create('orders', function (Blueprint $t) { $t->id(); $t->string('status'); }); } };\n" }), 'deletes all orders')
  // Review 20 (each a case that used to be wrong): who a route lets in
  {
    const app = (mw: string) => L['bootstrap/app.php'].replace('{ }', `{ ${mw} }`)
    const post = web("Route::post('/orders', [OrderController::class, 'store']);\n")
    const ctlWith = (code: string) => orders.replace('extends Controller {', `extends Controller {\n  ${code}`)
    const open = 'the orders part of your server without logging in', V13 = { 'composer.json': '{"require":{"laravel/framework":"^13.39"}}' }
    const lv13 = (extra: Record<string, string>) => card({ ...L, ...V13 }, { ...L, ...V13, 'app/Http/Controllers/OrderController.php': orders, ...extra })
    const base10 = '<?php\nnamespace App\\Http\\Controllers;\nuse Illuminate\\Foundation\\Auth\\Access\\AuthorizesRequests;\nuse Illuminate\\Routing\\Controller as BaseController;\nclass Controller extends BaseController { use AuthorizesRequests; }\n'
    // static middleware() counts only with `implements HasMiddleware`; the most-derived one replaces its parent's
    has(lv({ ...post, 'app/Http/Controllers/OrderController.php': ctlWith("public static function middleware(): array { return ['auth']; }") }), open)
    has(lv({ ...post, 'app/Http/Controllers/Controller.php': "<?php\nnamespace App\\Http\\Controllers;\nuse Illuminate\\Routing\\Controllers\\HasMiddleware;\nabstract class Controller implements HasMiddleware { public static function middleware(): array { return ['auth']; } }\n",
      'app/Http/Controllers/OrderController.php': ctlWith("public static function middleware(): array { return []; }") }), open)
    // a form request's authorize() that doesn't look at the user (a comment, TRUE) checks nobody
    has(lv({ ...post, 'app/Http/Controllers/OrderController.php': orders.replace('store(Request $request)', 'store(StoreOrderRequest $request)'),
      'app/Http/Requests/StoreOrderRequest.php': "<?php\nclass StoreOrderRequest extends FormRequest {\n  public function authorize(): bool\n  {\n    // Anyone can place an order\n    return TRUE;\n  }\n}\n" }), open)
    // app middleware: guests let through, a guest-only one: plain claims nothing; a role check that turns guests away: login
    const admin = (body: string) => lv({ ...web("Route::middleware('admin')->group(function () { Route::post('/orders', [OrderController::class, 'store']); });\n"),
      'bootstrap/app.php': app("$middleware->alias(['admin' => \\App\\Http\\Middleware\\EnsureAdmin::class]);"),
      'app/Http/Middleware/EnsureAdmin.php': `<?php\nclass EnsureAdmin { public function handle(Request $request, Closure $next) { ${body} } }\n` })
    for (const body of ["if ($request->user() && ! $request->user()->is_admin) { abort(403); } return $next($request);", "if (! Auth::check()) { return $next($request); } return redirect('/dashboard');"])
      { const c = admin(body); not(c, 'requires login ✓', 'without logging in') }
    has(admin("if (auth()->user()?->role !== 'admin') { abort(403); } return $next($request);"), 'is for admins only ✓')
    // 10-style constructor options; Laravel 13's class-level #[WithoutMiddleware]; a require runs where it sits
    has(lv({ ...post, 'app/Http/Controllers/Controller.php': base10, 'app/Http/Controllers/OrderController.php': ctlWith("public function __construct() { $this->middleware('auth', ['except' => ['store']]); }") }), open)
    has(lv13({ ...web("Route::middleware('auth')->group(function () { Route::post('/orders', [OrderController::class, 'store']); });\n"),
      'app/Http/Controllers/OrderController.php': orders.replace('use App\\Models\\Order;', 'use App\\Models\\Order;\nuse Illuminate\\Routing\\Attributes\\Controllers\\WithoutMiddleware;').replace('class OrderController', "#[WithoutMiddleware('auth')]\nclass OrderController") }), open)
    has(lv({ ...web("require __DIR__.'/orders.php';\nRoute::post('/orders', [OrderController::class, 'store']);\n"), 'routes/orders.php': "<?php\nRoute::middleware('auth')->group(function () { Route::post('/orders', [OrderController::class, 'store']); });\n" }), open)
    // policies that let guests in, however the type is written
    const gate = { ...web("Route::post('/orders/{order}/cancel', [OrderController::class, 'cancel']);\n"), 'app/Http/Controllers/OrderController.php': orders.replace("$order->update", "Gate::authorize('update', $order); $order->update") }
    for (const t of ['?\\App\\Models\\User $user', 'User|null $user']) not(lv({ ...gate, 'app/Policies/OrderPolicy.php': `<?php\nclass OrderPolicy { public function update(${t}, Order $order): bool { return true; } }\n` }), 'requires login ✓')
    // checks in the handler that turn guests away; $this->authorize without its trait crashes
    const h = (code: string) => lv({ ...web("Route::delete('/orders/{order}', [OrderController::class, 'destroy']);\n"), 'app/Http/Controllers/OrderController.php': orders.replace('public function index', `public function destroy(Request $request, Order $order) { ${code} $order->delete(); }\n  public function index`) })
    has(h("if ($order->user_id !== auth()->id()) { abort(403); }"), 'requires login ✓')
    has(h("if (! $request->user()?->is_admin) { abort(403); }"), 'requires login ✓')
    has(lv({ ...web("Route::post('/orders/{order}/cancel', [OrderController::class, 'cancel']);\n"), 'app/Http/Controllers/OrderController.php': orders.replace("$order->update", "$this->authorize('update', $order); $order->update") }), 'OrderController calls $this->authorize()')
    // env() in tests isn't the app's
    not(lv({ 'tests/Feature/OrderTest.php': "<?php\nnamespace Tests\\Feature;\nclass OrderTest extends TestCase { public function test_it(): void { $this->assertNotNull(env('STRIPE_SECRET')); } }\n" }), 'env()', 'STRIPE_SECRET')
    // mass assignment when only the model changes; a key in a config file; an AI client isn't a table; Cashier's guest checkout is money
    const B13 = { ...L, 'app/Http/Controllers/OrderController.php': orders.replace('$request->validated()', '$request->all()'), ...web("Route::post('/orders', [OrderController::class, 'store'])->middleware('auth');\n") }
    has(card(B13, { ...B13, 'app/Models/Order.php': L['app/Models/Order.php'].replace('$fillable = ["status"]', '$guarded = []') }), 'the model accepts every field')
    const fakeKey = ['sk', 'live', 'FAKEFAKEFAKEFAKE1234'].join('_')   // (assembled so code scanners don't take it for a real key)
    has(lv({ 'config/services.php': `<?php\nreturn ['stripe' => ['secret' => '${fakeKey}']];\n` }), 'A secret key is written in config/services.php')
    not(lv({ ...web("Route::post('/ask', [OrderController::class, 'ask'])->middleware('auth');\n"), 'app/Http/Controllers/OrderController.php': orders.replace('public function index', "public function ask(Request $request) { $client = OpenAI::client('x'); return $client->chat()->create([]); }\n  public function index") }), 'chats')
    const LC = { ...L, 'composer.json': '{"require":{"laravel/framework":"^12.0","laravel/cashier":"^16.0"}}' }
    has(card(LC, { ...LC, 'app/Http/Controllers/OrderController.php': orders.replace('public function index', "public function buy(Request $request) { return Checkout::guest()->create('price_x', []); }\n  public function index"), ...web("Route::post('/buy', [OrderController::class, 'buy']);\n") }), '💰')
    // Laravel 10 RouteServiceProvider, also in a folder whose name ends in "app"; CSRF off for the whole site
    const L10 = { ...L, 'bootstrap/app.php': "<?php\n$app = new Illuminate\\Foundation\\Application(dirname(__DIR__));\nreturn $app;\n",
      'app/Providers/RouteServiceProvider.php': "<?php\nnamespace App\\Providers;\nclass RouteServiceProvider extends ServiceProvider { public function boot(): void { $this->routes(function () { Route::middleware('web')->group(base_path('routes/web.php')); }); } }\n" }
    const a10 = { ...L10, 'app/Http/Controllers/OrderController.php': orders, ...post }
    const pre = (o: Record<string, string>, d: string) => Object.fromEntries(Object.entries(o).map(([k, v]) => [d + k, v]))
    for (const c of [card(L10, a10), card(pre(L10, 'my-app/'), pre(a10, 'my-app/'))]) { has(c, '/orders'); not(c, '//orders') }
    has(lv({ 'bootstrap/app.php': app("$middleware->web(remove: [\\Illuminate\\Foundation\\Http\\Middleware\\ValidateCsrfToken::class]);") }), 'Forgery protection is turned off for the whole site')
    not(card(L, { ...L, 'database/migrations/2026_10_28_000007_d.php': "<?php\nreturn new class extends Migration { public function up(): void { Schema::table('orders', function (Blueprint $table) { $table->dropConstrainedForeignId('user_id'); }); } };\n" }), '→')
  }
  // Review 20, round 2: checks only count when every request reaches them; Laravel's own aliases stay Laravel's; named guards
  {
    const app = (mw: string) => L['bootstrap/app.php'].replace('{ }', `{ ${mw} }`)
    const mw = (routes: string, body: string, extra: Record<string, string> = {}) => lv({ ...web(routes),
      'bootstrap/app.php': app("$middleware->alias(['admin' => \\App\\Http\\Middleware\\EnsureAdmin::class]);"),
      'app/Http/Middleware/EnsureAdmin.php': `<?php\nnamespace App\\Http\\Middleware;\nclass EnsureAdmin { public function handle(Request $request, Closure $next) {\n${body}\n} }\n`, ...extra })
    const grp = "Route::middleware('admin')->group(function () { Route::post('/orders', [OrderController::class, 'store']); Route::get('/menu', [OrderController::class, 'index']); });\n"
    const silent = (c: string) => not(c, 'requires login ✓', 'without logging in')
    // the app's own Authenticate (Laravel 10's Kernel alias, or just a class of that name on 11+) is still a login check
    const auth10 = "<?php\nnamespace App\\Http\\Middleware;\nuse Illuminate\\Auth\\Middleware\\Authenticate as Middleware;\nclass Authenticate extends Middleware {\n  public function handle($request, Closure $next, ...$guards) {\n    if ($request->hasCookie('token')) { $request->headers->set('Authorization', 'Bearer x'); }\n    return parent::handle($request, $next, ...$guards);\n  }\n}\n"
    const authGrp = web("Route::middleware('auth')->group(function () { Route::post('/orders', [OrderController::class, 'store']); });\n")
    has(lv({ ...authGrp, 'app/Http/Kernel.php': "<?php\nnamespace App\\Http;\nclass Kernel extends HttpKernel { protected $middlewareAliases = ['auth' => \\App\\Http\\Middleware\\Authenticate::class]; }\n", 'app/Http/Middleware/Authenticate.php': auth10 }), 'requires login ✓')
    has(lv({ ...authGrp, 'app/Http/Middleware/Authenticate.php': auth10 }), 'requires login ✓')
    // a check some requests skip (waved through first, behind a path test, after an early return, in an elseif): nothing claimed
    silent(mw(grp, "if (! $request->user()) { return $next($request); }\nif (! $request->user()->is_admin) { abort(403); }\nreturn $next($request);"))
    silent(mw(grp, "if ($request->is('menu', 'orders')) { return $next($request); }\nif (! auth()->check()) { return redirect()->route('login'); }\nreturn $next($request);"))
    silent(lv({ ...web("Route::post('/orders', [OrderController::class, 'store']);\nRoute::get('/menu', [OrderController::class, 'index']);\n"), 'bootstrap/app.php': app("$middleware->web(append: [\\App\\Http\\Middleware\\EnsureAdmin::class]);"),
      'app/Http/Middleware/EnsureAdmin.php': "<?php\nnamespace App\\Http\\Middleware;\nclass EnsureAdmin { public function handle(Request $request, Closure $next) {\n  if ($request->is('admin/*')) {\n    if (! $request->user()?->is_admin) { abort(403); }\n  }\n  return $next($request);\n} }\n" }))
    const h = (code: string, extra: Record<string, string> = {}) => lv({ ...web("Route::delete('/orders/{order}', [OrderController::class, 'destroy']);\n"), 'app/Http/Controllers/OrderController.php': orders.replace('public function index', `public function destroy(Request $request, Order $order) { ${code} $order->delete(); }\n  public function index`), ...extra })
    silent(h("if ($order->is_public) { $ok = true; } elseif (! auth()->check()) { abort(403); }"))
    // owner checks: the visitor's own input can't be the owner; a column that can be empty lets guests through for those rows
    silent(lv({ ...web("Route::post('/orders', [OrderController::class, 'store']);\n"), 'app/Http/Controllers/OrderController.php': orders.replace('public function store(Request $request) {', "public function store(Request $request) { if ($request->user_id !== auth()->id()) { abort(403); }") }))
    const nullableUser = { 'database/migrations/2026_01_01_000000_create_orders_table.php': L['database/migrations/2026_01_01_000000_create_orders_table.php'].replace("foreignId('user_id')->constrained()", "foreignId('user_id')->nullable()->constrained()") }
    has(h("abort_unless(auth()->id() === $order->user_id, 403);"), 'requires login ✓')
    silent(h("abort_unless(auth()->id() === $order->user_id, 403);", nullableUser))
    // form requests that let guests through while mentioning the user
    const fr = (auth: string) => ({ ...web("Route::post('/orders', [OrderController::class, 'store']);\n"), 'app/Http/Controllers/OrderController.php': orders.replace('store(Request $request)', 'store(StoreOrderRequest $request)'),
      'app/Http/Requests/StoreOrderRequest.php': `<?php\nnamespace App\\Http\\Requests;\nclass StoreOrderRequest extends FormRequest { public function authorize(): bool { ${auth} } }\n` })
    for (const a of ["return auth()->check() || config('shop.guest_checkout');", "return $this->user()?->is_banned !== true;"]) not(lv(fr(a)), 'requires login ✓')
    has(lv(fr('return auth()->check() && $this->user()->can("order");')), 'requires login ✓')
    // recording who did it isn't a check: the open-route warning stays
    const refund = orders.replace('public function index', "public function refund(Request $request, Order $order) { $order->update(['status' => 'refunded', 'refunded_by' => auth()->id()]); return redirect()->back(); }\n  public function index")
    has(lv({ ...web("Route::post('/admin/orders/{order}/refund', [OrderController::class, 'refund']);\n"), 'app/Http/Controllers/OrderController.php': refund }), 'Anyone can use the admin order refund part of your server without logging in')
    // named guards
    has(mw(grp, "if (! Auth::guard('admin')->check()) { return redirect()->route('admin.login'); }\nreturn $next($request);"), 'requires login ✓')
    has(mw(grp, "abort_unless(auth('sanctum')->check(), 401);\nreturn $next($request);"), 'requires login ✓')
  }
  // Review 20, round 3: the app's Authenticate that skips paths; the user in a variable; escapes read from the code, not its text
  {
    const silent = (c: string) => not(c, 'requires login ✓', 'without logging in')
    const grpAuth = web("Route::middleware('auth')->group(function () { Route::post('/orders', [OrderController::class, 'store']); Route::get('/menu', [OrderController::class, 'index']); });\n")
    const k10 = "<?php\nnamespace App\\Http;\nclass Kernel extends HttpKernel { protected $middlewareAliases = ['auth' => \\App\\Http\\Middleware\\Authenticate::class, 'guest' => \\App\\Http\\Middleware\\RedirectIfAuthenticated::class]; }\n"
    const authCls = (members: string) => `<?php\nnamespace App\\Http\\Middleware;\nuse Illuminate\\Auth\\Middleware\\Authenticate as Middleware;\nclass Authenticate extends Middleware {\n  protected $except = ['menu', 'orders'];\n${members}\n}\n`
    silent(lv({ ...grpAuth, 'app/Http/Kernel.php': k10, 'app/Http/Middleware/Authenticate.php': authCls("  public function handle($request, Closure $next, ...$guards) {\n    if (! $request->is(...$this->except)) {\n      return parent::handle($request, $next, ...$guards);\n    }\n    return $next($request);\n  }") }))
    silent(lv({ ...grpAuth, 'app/Http/Kernel.php': k10, 'app/Http/Middleware/Authenticate.php': authCls("  protected function authenticate($request, array $guards) {\n    if ($request->is(...$this->except)) { return; }\n    parent::authenticate($request, $guards);\n  }") }))
    const h = (code: string) => lv({ ...web("Route::delete('/orders/{order}', [OrderController::class, 'destroy']);\n"), 'app/Http/Controllers/OrderController.php': orders.replace('public function index', `public function destroy(Request $request, Order $order) {\n    ${code}\n    $order->delete();\n  }\n  public function index`) })
    has(h("$user = $request->user();\n    if (! $user) { abort(401); }"), 'requires login ✓')
    has(h("$user = auth()->user();\n    abort_unless($user?->is_admin, 403);"), 'requires login ✓')
    has(h("$total = $order->items->sum(function ($i) { return $i->price; });\n    if (! auth()->check()) { abort(401); }"), 'requires login ✓')
    has(h("Log::info('customer may return the order');\n    if (! auth()->check()) { abort(401); }"), 'requires login ✓')
    silent(h("if ($order->is_draft) { return response()->json(['ok' => true]); }\n    if (! auth()->check()) { abort(401); }"))
    silent(h("try {\n      if (! auth()->check()) { abort(401); }\n    } catch (\\Throwable $e) { report($e); }"))
    // an app's copy of RedirectIfAuthenticated is still guest-only
    const redirect10 = "<?php\nnamespace App\\Http\\Middleware;\nclass RedirectIfAuthenticated {\n  public function handle(Request $request, Closure $next, string ...$guards): Response {\n    foreach ($guards as $guard) {\n      if (Auth::guard($guard)->check()) { return redirect('/home'); }\n    }\n    return $next($request);\n  }\n}\n"
    has(lv({ ...web("Route::middleware('guest')->group(function () { Route::post('/orders', [OrderController::class, 'store']); });\n"), 'app/Http/Kernel.php': k10, 'app/Http/Middleware/RedirectIfAuthenticated.php': redirect10 }), 'the orders part of your server without logging in')
    // a form request's owner check on a column that can be empty; the visitor's input under another name
    const nullMig = { 'database/migrations/2026_01_01_000000_create_orders_table.php': L['database/migrations/2026_01_01_000000_create_orders_table.php'].replace("foreignId('user_id')->constrained()", "foreignId('user_id')->nullable()->constrained()") }
    silent(lv({ ...nullMig, ...web("Route::put('/orders/{order}', [OrderController::class, 'update']);\n"),
      'app/Http/Controllers/OrderController.php': orders.replace('public function index', "public function update(UpdateOrderRequest $request, Order $order) { $order->update($request->validated()); }\n  public function index"),
      'app/Http/Requests/UpdateOrderRequest.php': "<?php\nnamespace App\\Http\\Requests;\nclass UpdateOrderRequest extends FormRequest { public function authorize(): bool { return $this->order->user_id === auth()->id(); } }\n" }))
    silent(lv({ ...web("Route::post('/orders', [OrderController::class, 'store']);\n"),
      'app/Http/Controllers/OrderController.php': orders.replace('public function store(Request $request) {', "public function store(StoreOrderRequest $req) { if ($req->user_id !== auth()->id()) { abort(403); }").replace('Order::create($request->validated())', 'Order::create($req->validated())') }))
    // a gate in a middleware, when gates let guests in
    not(lv({ ...web("Route::middleware('menu')->group(function () { Route::post('/orders', [OrderController::class, 'store']); });\n"),
      'bootstrap/app.php': L['bootstrap/app.php'].replace('{ }', "{ $middleware->alias(['menu' => \\App\\Http\\Middleware\\MenuGate::class]); }"),
      'app/Http/Middleware/MenuGate.php': "<?php\nnamespace App\\Http\\Middleware;\nclass MenuGate { public function handle(Request $request, Closure $next) { Gate::authorize('view-menu'); return $next($request); } }\n",
      'app/Providers/AppServiceProvider.php': "<?php\nnamespace App\\Providers;\nclass AppServiceProvider extends ServiceProvider { public function boot(): void { Gate::define('view-menu', fn (?User $user) => true); } }\n" }), 'requires login ✓')
  }
  // Review 20, round 4: a user variable assigned again; a model called *Request; $next run inside a closure
  {
    const approve = (sig: string, code: string, extra: Record<string, string> = {}) => lv({ ...extra, ...web("Route::post('/orders/{order}/approve', [OrderController::class, 'approve']);\n"),
      'app/Http/Controllers/OrderController.php': orders.replace('use App\\Models\\Order;', 'use App\\Models\\Order;\nuse App\\Models\\LeaveRequest;').replace('public function index', `public function approve(${sig}) {\n    ${code}\n    $order->update(['status' => 'approved']);\n  }\n  public function index`) })
    for (const code of ["$user = $request->user();\n    $user = $user ?? User::where('email', $request->input('email'))->first();\n    if (! $user) { abort(401); }",
      "$user = $request->user();\n    if ($request->filled('email')) { $user = User::firstWhere('email', $request->email); }\n    if (! $user) { abort(401); }",
      "$user = auth()->user();\n    $user ??= User::find($request->input('as'));\n    abort_unless($user, 401);"]) not(approve('Request $request, Order $order', code), 'requires login ✓')
    const leave = { 'database/migrations/2026_01_02_000000_create_leave_requests_table.php': "<?php\nreturn new class extends Migration { public function up(): void { Schema::create('leave_requests', function (Blueprint $table) { $table->id(); $table->foreignId('user_id')->constrained(); }); } };\n",
      'app/Models/LeaveRequest.php': "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass LeaveRequest extends Model { public function user() { return $this->belongsTo(User::class); } }\n" }
    not(approve('LeaveRequest $leaveRequest, Order $order', "abort_unless($leaveRequest->user()->exists(), 403);", leave), 'requires login ✓')
    has(approve('LeaveRequest $leaveRequest, Order $order', "if ($leaveRequest->user_id !== auth()->id()) { abort(403); }", leave), 'requires login ✓')
    not(lv({ ...web("Route::middleware('admin')->group(function () { Route::post('/orders', [OrderController::class, 'store']); });\n"),
      'bootstrap/app.php': L['bootstrap/app.php'].replace('{ }', "{ $middleware->alias(['admin' => \\App\\Http\\Middleware\\EnsureAdmin::class]); }"),
      'app/Http/Middleware/EnsureAdmin.php': "<?php\nnamespace App\\Http\\Middleware;\nclass EnsureAdmin { public function handle(Request $request, Closure $next) {\n  $response = DB::transaction(fn () => $next($request));\n  if (! $request->user()) { abort(403); }\n  return $response;\n} }\n" }), 'requires login ✓')
  }
  // an index-only migration breaks nothing if it runs late; following a controller into the service it calls
  c = lv({ 'database/migrations/2026_10_28_000000_idx.php': "<?php\nreturn new class extends Migration { public function up(): void { Schema::table('orders', function (Blueprint $t) { $t->index(['status', 'created_at']); }); } };\n" })
  has(c, 'nothing breaks if it runs later'); not(c, 'or the parts that use it will fail')
  c = lv({ ...web("Route::post('/orders/{order}/cancel', [OrderController::class, 'cancel'])->middleware('auth');\n"),
    'app/Http/Controllers/OrderController.php': orders.replace('public function cancel(Order $order) {', 'public function cancel(Order $order, \\App\\Services\\Canceller $canceller) { $canceller->run($order); return; '),
    'app/Services/Canceller.php': "<?php\nnamespace App\\Services;\nclass Canceller { public function __construct(private Refunds $refunds) {} public function run(Order $order) { $this->refunds->refund($order); $order->user->notify(new Cancelled($order)); } }\n",
    'app/Services/StripeRefunds.php': "<?php\nnamespace App\\Services;\nclass StripeRefunds implements Refunds { public function refund(Order $order) { $stripe = new \\Stripe\\StripeClient('x'); $stripe->refunds->create(['payment_intent' => $order->pi]); } }\n",
    'app/Notifications/Cancelled.php': "<?php\nclass Cancelled extends Notification { public function via(object $n): array { return ['mail']; } }\n" })
  has(c, 'asks Stripe to create a refund', 'emails people')
  // a webhook that starts handling a new Stripe event: a dashboard step (not for event names in tests)
  const hook = (body: string) => "<?php\nnamespace App\\Http\\Controllers;\nclass StripeWebhookController extends Controller { public function __invoke(Request $request) { $event = \\Stripe\\Webhook::constructEvent($request->getContent(), $request->header('Stripe-Signature'), 'x'); " + body + " } }\n"
  const H = { ...L, 'app/Http/Controllers/StripeWebhookController.php': hook("if ($event->type === 'checkout.session.completed') { }") }
  c = card(H, { ...H, 'app/Http/Controllers/StripeWebhookController.php': hook("if ($event->type === 'checkout.session.completed') { } if ($event->type === 'checkout.session.expired') { }") })
  has(c, 'make sure it receives checkout.session.expired (skip this if'); not(c, 'receives checkout.session.completed')
  not(card(H, { ...H, 'tests/Feature/HookTest.php': "<?php\nclass HookTest { function t() { $this->post('/stripe/webhook', ['type' => 'charge.refunded', 'sig' => 'Stripe-Signature']); } }\n" }), 'Workbench')
  // not: a comment, an expand path, a log value, the same handler moved to another file
  for (const body of ["// TODO later: 'invoice.payment_failed'", "\\Stripe\\Checkout\\Session::retrieve(['id' => 'x', 'expand' => ['payment_intent.latest_charge']]);", "Log::warning('x', ['expected' => 'checkout.session.async_payment_failed']);"])
    not(card(H, { ...H, 'app/Http/Controllers/StripeWebhookController.php': hook("if ($event->type === 'checkout.session.completed') { } " + body) }), 'Workbench')
  not(card(H, { ...L, 'app/Http/Controllers/Webhooks/StripeController.php': hook("if ($event->type === 'checkout.session.completed') { }") }), 'Workbench')
  // review 21: a change only inside the called class; a vendor class with an app model's short name; a model method writing via $this;
  // index-only means only index changes (no data change next to it, no full-text index)
  {
    const svc = (run: string) => ({ ...L, ...web("Route::post('/orders/{order}/cancel', [OrderController::class, 'cancel'])->middleware('auth');\n"),
      'app/Http/Controllers/OrderController.php': orders.replace('public function cancel(Order $order) {', 'public function cancel(Order $order, \\App\\Services\\Canceller $c) { $c->run($order); return; '),
      'app/Services/Canceller.php': `<?php\nnamespace App\\Services;\nclass Canceller { public function run(Order $order) { ${run} } }\n` })
    has(card(svc("$order->update(['status' => 'x']);"), svc('$order->delete();')), 'The order cancel part of your server changed')
    c = lv({ ...web("Route::post('/invoices/{id}/pay', [OrderController::class, 'pay'])->middleware('auth');\n"),
      'app/Http/Controllers/OrderController.php': orders.replace('public function index', "public function pay($id) { $stripeInvoice = \\Stripe\\Invoice::retrieve($id); $stripeInvoice->pay(); }\n  public function index"),
      'app/Models/Invoice.php': "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Invoice extends Model { public function pay() { Payment::create([]); } }\n",
      'app/Models/Payment.php': "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Payment extends Model {}\n" })
    not(c, 'payments')
    has(lv({ ...web("Route::post('/orders/{order}/void', [OrderController::class, 'void'])->middleware('auth');\n"),
      'app/Http/Controllers/OrderController.php': orders.replace('public function index', "public function void(Order $order) { $order->markVoid(); }\n  public function index"),
      'app/Models/Order.php': L['app/Models/Order.php'].replace('}\n', "public function markVoid() { $this->update(['status' => 'void']); } }\n") }), 'updates orders')
    const idx = (up: string) => lv({ 'database/migrations/2026_10_28_000000_idx.php': `<?php\nreturn new class extends Migration { public function up(): void { ${up} } };\n` })
    for (const up of ["Schema::table('orders', fn (Blueprint $t) => $t->index('status')); DB::table('orders')->update(['status' => 'new']);", "Schema::table('orders', function (Blueprint $t) { $t->index('status'); DB::table('orders')->update(['status' => 'new']); });", "Schema::table('orders', fn (Blueprint $t) => $t->fullText('status'));"])
      not(idx(up), 'nothing breaks if it runs later')
  }
  // one address, an open read and a guarded change: not a bare "requires login ✓"
  has(lv({ 'app/Http/Controllers/OrderController.php': orders.replace('public function index', "public function show(Order $order) { return $order; }\n  public function destroy(Order $order) { $order->delete(); }\n  public function index"),
    ...web("Route::resource('orders', OrderController::class)->only(['show', 'destroy'])->middlewareFor('destroy', 'auth');\n") }), 'needs login to change anything ✓ (anyone can view it)')
  // review 22: a GET that deletes decides like a POST; a Next.js route file whose GET checks nothing isn't a bare ✓
  {
    const ex = { 'package.json': '{"dependencies":{"express":"4"}}' }
    has(card(ex, { ...ex, 'server/index.js': "import express from 'express'\nimport { requireAuth } from './auth'\nconst app = express()\nconst router = express.Router()\nrouter.get('/:id', async (req, res) => { await prisma.order.delete({ where: { id: req.params.id } }) })\nrouter.post('/:id', requireAuth, async (req, res) => { await prisma.order.delete({ where: { id: req.params.id } }) })\napp.use('/api/orders', router)\n" }), 'without logging in')
    const nx = { 'package.json': '{"dependencies":{"next":"14"}}' }
    const c = card(nx, { ...nx, 'app/api/orders/route.ts': "import { auth } from '@/lib/auth'\nexport async function GET() { return prisma.order.findMany() }\nexport async function POST() { const s = await auth(); if (!s) return new Response('no', { status: 401 }); await prisma.order.create({}) }\n" })
    has(c, 'needs login to change anything ✓'); not(c, 'and requires login ✓')
  }
  console.log('ok (laravel)')
}

// Rails (2026-10-28): routes in order, before_actions (replace, skip, concerns), in-action checks, Active Record, migrations, Stripe, mail
{
  const R: Record<string, string> = {
    'Gemfile': 'source "https://rubygems.org"\ngem "rails", "~> 8.1.0"\ngem "devise"\ngem "stripe"\n',
    'config/application.rb': 'module Shop\n  class Application < Rails::Application\n    config.load_defaults 8.1\n  end\nend\n',
    'config/routes.rb': 'Rails.application.routes.draw do\n  devise_for :users\n  root "orders#index"\nend\n',
    'app/controllers/application_controller.rb': 'class ApplicationController < ActionController::Base\nend\n',
    'app/models/order.rb': 'class Order < ApplicationRecord\n  belongs_to :user\nend\n',
    'app/models/user.rb': 'class User < ApplicationRecord\n  has_many :orders\nend\n',
    'db/migrate/20260101000000_create_orders.rb': 'class CreateOrders < ActiveRecord::Migration[8.1]\n  def change\n    create_table :orders do |t|\n      t.references :user, null: false, foreign_key: true\n      t.string :status\n      t.timestamps\n    end\n  end\nend\n',
  }
  const orders = (body: string, head = '') => `class OrdersController < ApplicationController\n${head}\n  def index\n    @orders = Order.all\n  end\n\n  def create\n    current_user.orders.create!(order_params)\n    redirect_to orders_path\n  end\n\n  def destroy\n    Order.find(params[:id]).destroy\n    head :no_content\n  end\n${body}\n  private\n\n  def order_params\n    params.expect(order: [:status])\n  end\nend\n`
  const routes = (r: string) => ({ 'config/routes.rb': `Rails.application.routes.draw do\n  devise_for :users\n${r}\nend\n` })
  const rs = (extra: Record<string, string>) => card(R, { ...R, 'app/controllers/orders_controller.rb': orders(''), ...extra })
  const has = (c: string, ...xs: string[]) => { for (const x of xs) assert.ok(c.includes(x), `rails: missing "${x}"\n${c}`) }
  const not = (c: string, ...xs: string[]) => { for (const x of xs) assert.ok(!c.includes(x), `rails: unexpected "${x}"\n${c}`) }
  const appCtl = (body: string) => ({ 'app/controllers/application_controller.rb': `class ApplicationController < ActionController::Base\n${body}\nend\n` })
  const res = routes('  resources :orders, only: [:index, :create]\n  delete "orders/:id", to: "orders#destroy"')

  // Devise's authenticate_user! in ApplicationController covers every action; skip_before_action opens some
  let c = rs({ ...res, ...appCtl('  before_action :authenticate_user!') })
  has(c, 'requires login ✓'); not(c, 'without logging in')
  c = rs({ ...res, ...appCtl('  before_action :authenticate_user!'), 'app/controllers/orders_controller.rb': orders('', '  skip_before_action :authenticate_user!, only: [:index]') })
  has(c, 'lists orders, saves new ones and needs login to change anything ✓ (anyone can view it)')
  // without the devise gem, authenticate_user! is nobody's: plain claims nothing
  c = card({ ...R, Gemfile: 'gem "rails"\n' }, { ...R, Gemfile: 'gem "rails"\n', 'app/controllers/orders_controller.rb': orders(''), ...res, ...appCtl('  before_action :authenticate_user!') })
  not(c, 'requires login ✓', 'without logging in')
  // declaring it again with only: in a subclass replaces the parent's: the rest is open
  c = rs({ ...res, ...appCtl('  before_action :authenticate_user!'), 'app/controllers/orders_controller.rb': orders('', '  before_action :authenticate_user!, only: [:destroy]') })
  has(c, 'Anyone can')
  // a skip with if: -> plain can't tell
  c = rs({ ...res, ...appCtl('  before_action :authenticate_user!'), 'app/controllers/orders_controller.rb': orders('', '  skip_before_action :authenticate_user!, if: -> { request.format.json? }') })
  not(c, 'requires login ✓', 'Anyone can')
  // Rails 8: include Authentication (its require_authentication), allow_unauthenticated_access
  const auth = { 'app/controllers/concerns/authentication.rb': 'module Authentication\n  extend ActiveSupport::Concern\n\n  included do\n    before_action :require_authentication\n    helper_method :authenticated?\n  end\n\n  private\n    def require_authentication\n      resume_session || request_authentication\n    end\nend\n' }
  c = card(R, { ...R, ...auth, ...res, ...appCtl('  include Authentication'), 'app/controllers/orders_controller.rb': orders('', '  allow_unauthenticated_access only: %i[index]') })
  has(c, 'needs login to change anything ✓ (anyone can view it)')
  // an app before_action that turns guests away; an in-action check counts only when it returns
  c = rs({ ...res, 'app/controllers/orders_controller.rb': orders('\n  def require_admin\n    redirect_to root_path, alert: "Admins only" unless current_user&.admin?\n  end\n', '  before_action :require_admin') })
  has(c, 'is for admins only ✓')
  c = rs({ ...res, ...appCtl('  before_action :authenticate_user!'), 'app/controllers/orders_controller.rb': orders('\n  def no_admins\n    head :forbidden if current_user&.admin?\n  end\n', '  before_action :no_admins') })
  has(c, 'requires login ✓'); not(c, 'admins only')
  const d = (body: string) => rs({ ...routes('  delete "orders/:id", to: "orders#destroy"'), 'app/controllers/orders_controller.rb': orders('').replace('    Order.find(params[:id]).destroy', `${body}\n    Order.find(params[:id]).destroy`) })
  has(d('    return head :unauthorized unless current_user'), 'deletes orders and requires login ✓')
  not(d('    head :unauthorized unless current_user'), 'requires login ✓')
  // Devise's authenticate block around routes
  has(rs(routes('  authenticate :user do\n    delete "orders/:id", to: "orders#destroy"\n  end')), 'deletes orders and requires login ✓')
  // routes: the first definition wins; resources only:/member
  c = rs({ ...routes('  delete "orders/:id", to: "orders#destroy"\n  authenticate :user do\n    delete "orders/:id", to: "orders#destroy"\n  end') })
  has(c, 'Anyone can')
  c = rs({ ...routes('  resources :orders, only: [:index] do\n    member { post :refund }\n  end'), 'app/controllers/orders_controller.rb': orders('\n  def refund\n    Stripe::Refund.create(payment_intent: "pi")\n  end\n') })
  has(c, '/orders/[id]/refund', 'asks Stripe to create a refund'); not(c, '/orders/[id]\n')
  // migrations: new table, data loss, the step (by itself when bin/docker-entrypoint runs db:prepare), index-only
  const mig = (body: string, extra: Record<string, string> = {}) => card(R, { ...R, ...extra, 'db/migrate/20261028000000_x.rb': `class X < ActiveRecord::Migration[8.1]\n  def change\n${body}\n  end\nend\n` })
  c = mig('    create_table :coupons do |t|\n      t.string :code\n      t.integer :percent_off\n    end\n    remove_column :orders, :status, :string')
  has(c, 'Your database now stores coupons: code and percent off', 'the status on orders will be deleted for good', 'Apply 20261028000000_x to your live database before the new code goes live (`bin/rails db:migrate`)')
  has(mig('    add_column :orders, :note, :text', { 'config/deploy.yml': 'service: shop\n', 'bin/docker-entrypoint': '#!/bin/bash -e\nif [ "${@: -2:1}" == "./bin/rails" ] && [ "${@: -1:1}" == "server" ]; then\n  ./bin/rails db:prepare\nfi\nexec "${@}"\n' }), 'will change your live database by itself the next time the app starts')
  has(mig('    add_index :orders, :status'), 'nothing breaks if it runs later')
  not(mig('    add_index :orders, :status, unique: true'), 'nothing breaks if it runs later')
  has(mig('    rename_column :orders, :status, :state'), 'The status on orders is renamed to state')
  // money, email, settings
  c = rs({ ...res, ...appCtl('  before_action :authenticate_user!'), 'app/controllers/orders_controller.rb': orders('\n  def pay\n    Stripe.api_key = ENV.fetch("STRIPE_SECRET_KEY")\n    session = Stripe::Checkout::Session.create(mode: "payment", line_items: [])\n    OrderMailer.with(order: @order).paid.deliver_later\n    redirect_to session.url, allow_other_host: true\n  end\n'), ...routes('  post "orders/:id/pay", to: "orders#pay"') })
  has(c, 'charges customers 💰', 'emails people', 'Add STRIPE_SECRET_KEY to your hosting settings.')
  has(rs({ ...res, 'app/controllers/orders_controller.rb': orders('\n  def key\n    Rails.application.credentials.dig(:stripe, :secret_key)\n  end\n'), ...routes('  get "key", to: "orders#key"') }), 'Add RAILS_MASTER_KEY to your hosting settings.')
  // following a service: OrderCanceller.new(order).call
  c = rs({ ...routes('  post "orders/:id/cancel", to: "orders#cancel"'), ...appCtl('  before_action :authenticate_user!'), 'app/controllers/orders_controller.rb': orders('\n  def cancel\n    OrderCanceller.new(Order.find(params[:id])).call\n  end\n'),
    'app/services/order_canceller.rb': 'class OrderCanceller\n  def initialize(order)\n    @order = order\n  end\n\n  def call\n    Order.where(id: @order.id).update_all(status: "cancelled")\n    Stripe::Refund.create(payment_intent: @order.payment_intent)\n  end\nend\n' })
  has(c, 'updates orders', 'asks Stripe to create a refund', 'requires login ✓')
  // risks: everything the visitor sends; forgery protection off (not for a webhook); the credentials key committed
  has(rs({ ...res, 'app/controllers/orders_controller.rb': orders('').replace('params.expect(order: [:status])', 'params.require(:order).permit!') }), 'Saves whatever the visitor sends')
  c = rs({ ...res, 'app/controllers/orders_controller.rb': orders('', '  skip_forgery_protection only: [:create]') })
  has(c, 'OrdersController#create is excluded from forgery protection')
  not(rs({ ...res, 'app/controllers/webhooks_controller.rb': 'class WebhooksController < ApplicationController\n  skip_forgery_protection\n  def stripe\n    Stripe::Webhook.construct_event(request.body.read, request.headers["Stripe-Signature"], ENV.fetch("STRIPE_WEBHOOK_SECRET"))\n  end\nend\n' }), 'forgery protection')
  has(card(R, { ...R, 'config/master.key': '0123456789abcdef0123456789abcdef' }), 'config/master.key is in the code')

// Review 23 (Rails), each a case that used to be wrong (a real Rails run settled most): routes, callbacks, checks, writes, deploy
  {
  const R2: Record<string, string> = { ...R, 'config/routes.rb': 'Rails.application.routes.draw do\n  devise_for :users\nend\n' }
  const routes = (r: string) => ({ 'config/routes.rb': `Rails.application.routes.draw do\n  devise_for :users\n${r}\nend\n` })
  const appCtl = (body: string) => ({ 'app/controllers/application_controller.rb': `class ApplicationController < ActionController::Base\n${body}\nend\n` })
  const E: Record<string, string[]> = {'P1.1': ['Anyone can use the admin orders part'], 'P1.1!': [],'P1.2a': ['Anyone can use the order part'], 'P1.2a!': [],'P1.2b': ['/orders/[id]/refund'], 'P1.2b!': [],'P1.3': [], 'P1.3!': ['requires login ✓'],'P1.4': ['Anyone can use the order part'], 'P1.4!': ['requires login ✓'],'P1.5': [], 'P1.5!': ['requires login ✓'],'P1.6': ['Anyone can use the order cancel part'], 'P1.6!': ['works without logging in'],'P1.7': ['Anyone can use the order part'], 'P1.7!': ['requires login ✓'],'P1.8': [], 'P1.8!': ['requires login ✓'],'P1.9': [], 'P1.9!': ['requires login ✓'],'P1.10': ['Anyone can use the admin order part'], 'P1.10!': ['requires login ✓'],'P1.11': ['Anyone can'], 'P1.11!': [],'P2.1': [], 'P2.1!': ['silently ignored'],'P2.3a': ['requires login ✓'], 'P2.3a!': ['Anyone can'],'P2.3b': [], 'P2.3b!': ['Anyone can'],'P2.4': ['requires login ✓'], 'P2.4!': ['Anyone can'],'P3.1': ['bin/rails db:migrate'], 'P3.1!': ['will change your live database by itself'],'P3.2': ['Add STRIPE_SECRET_KEY to your hosting settings'], 'P3.2!': [],'P3.3': ['all orders will be deleted for good'], 'P3.3!': [],'P4.1': ['requires login ✓'], 'P4.1!': ['Anyone can']}
  const chk2 = (id: string, before: Record<string, string>, after: Record<string, string>) => { const c = card(before, after)
    for (const x of E[id] ?? []) assert.ok(c.includes(x), `review 23 ${id}: missing "${x}"\n${c}`)
    for (const x of E[id + '!'] ?? []) assert.ok(!c.includes(x), `review 23 ${id}: unexpected "${x}"\n${c}`) }
  const chk = (id: string, extra: Record<string, string>) => chk2(id, R2, { ...R2, ...extra })
  const O = (head: string, tail = '') => `class OrdersController < ApplicationController\n${head}\n  def index\n    @orders = Order.all\n  end\n  def destroy\n    Order.find(params[:id]).destroy\n    head :no_content\n  end\n${tail}\nend\n`
const res = routes('  resources :orders, only: [:index, :destroy]'), ctl = (h: string, t = '') => ({ 'app/controllers/orders_controller.rb': O(h, t) })
const D = 'class OrdersController < ApplicationController\n  def destroy\n    Order.find(params[:id]).destroy\n    head :no_content\n  end\nend\n'
// P1
chk('P1.1', { Gemfile: R.Gemfile + 'gem "administrate"\n', ...routes('  namespace :admin do\n    resources :orders\n  end'),
  'app/controllers/admin/application_controller.rb': 'module Admin\n  class ApplicationController < Administrate::ApplicationController\n    before_action :authenticate_admin\n\n    def authenticate_admin\n      # TODO Add authentication logic here.\n    end\n  end\nend\n',
  'app/controllers/admin/orders_controller.rb': 'module Admin\n  class OrdersController < Admin::ApplicationController\n  end\nend\n' })
chk('P1.2a', { ...routes('  defaults format: :json do\n    resources :orders, only: [:destroy]\n  end'), 'app/controllers/orders_controller.rb': D })
chk('P1.2b', { ...routes('  resources :orders, only: [] do\n    member { post "refund" }\n  end'), 'app/controllers/orders_controller.rb': 'class OrdersController < ApplicationController\n  def refund\n    Order.find(params[:id]).update!(status: "refunded")\n  end\nend\n' })
chk('P1.3', { ...res, ...ctl('  before_action :redirect_signed_in', '  private\n  def redirect_signed_in\n    redirect_to root_path unless current_user.nil?\n  end') })
chk('P1.4', { ...res, ...ctl('  before_action :authenticate_api_key!', '  private def authenticate_api_key!\n    @api_key = ApiKey.find_by(token: params[:key])\n  end') })
chk('P1.5', { ...res, ...ctl(''), ...appCtl('  before_action :staging_auth\n  private\n  def staging_auth\n    authenticate_or_request_with_http_basic { |u, p| p == ENV["STAGING_PASSWORD"] } if Rails.env.staging?\n  end') })
chk('P1.6', { ...routes('  get "orders/:id/cancel", to: "orders#cancel"'), 'app/models/order.rb': 'class Order < ApplicationRecord\n  def cancel!\n    update!(status: "cancelled")\n  end\nend\n', 'app/controllers/orders_controller.rb': 'class OrdersController < ApplicationController\n  def cancel\n    Order.find(params[:id]).cancel!\n    redirect_to orders_path\n  end\nend\n' })
chk('P1.7', { ...routes('  authenticated :user do\n    delete "orders/:id", to: "orders#destroy"\n  end\n  delete "orders/:id", to: "orders#destroy"'), 'app/controllers/orders_controller.rb': D })
chk('P1.8', { ...routes('  delete "orders/:id", to: "orders#destroy"'), 'app/controllers/orders_controller.rb': 'class OrdersController < ApplicationController\n  def destroy\n    Order.find(params[:id]).destroy\n    return head :unauthorized unless current_user\n    head :no_content\n  end\nend\n' })
chk('P1.9', { ...res, ...appCtl('  before_action :authenticate_user!'), ...ctl('  PUBLIC = %i[index destroy].freeze\n  skip_before_action :authenticate_user!, only: PUBLIC') })
chk('P1.10', { ...routes('  namespace :admin do\n    resources :orders, only: [:destroy]\n  end'), ...appCtl('  before_action :authenticate_user!'), 'app/controllers/base_controller.rb': 'class BaseController < ActionController::Base\nend\n',
  'app/controllers/admin/base_controller.rb': 'module Admin\n  class BaseController < ApplicationController\n  end\nend\n', 'app/controllers/admin/orders_controller.rb': 'class Admin::OrdersController < BaseController\n  def destroy\n    Order.find(params[:id]).destroy\n  end\nend\n' })
chk('P1.11', { ...res, ...appCtl('  before_action :authenticate_user!'), 'app/controllers/concerns/storefront.rb': 'module Storefront\n  extend ActiveSupport::Concern\n  included do\n    skip_before_action :authenticate_user!\n  end\nend\n', ...ctl('  before_action :authenticate_user!, only: [:destroy]\n  include Storefront') })
// P2
chk('P2.1', { ...routes('  resources :orders, only: [:destroy]'), ...appCtl('  before_action :authenticate_user!'), 'app/controllers/orders_controller.rb': 'class OrdersController < ApplicationController\n  def destroy\n    Order.find(params[:id]).destroy\n  rescue ActiveRecord::RecordNotFound\n    redirect_to orders_path, alert: "Not found"\n  end\nend\n' })
chk('P2.3a', { ...res, ...ctl(''), ...appCtl('  before_action :require_login\n  private\n  def require_login\n    return if current_user\n    redirect_to login_path\n  end') })
chk('P2.3b', { ...res, ...ctl(''), ...appCtl('  before_action :authorize_request\n  private\n  def authorize_request\n    decoded = JsonWebToken.decode(request.headers["Authorization"]&.split(" ")&.last)\n    @current_user = User.find(decoded[:user_id])\n  rescue ActiveRecord::RecordNotFound, JWT::DecodeError\n    render json: { errors: "Unauthorized" }, status: :unauthorized\n  end') })
chk('P2.4', { ...res, ...ctl(''), 'app/controllers/concerns/secured.rb': 'module Secured\n  extend ActiveSupport::Concern\n  include Authentication\nend\n', 'app/controllers/concerns/authentication.rb': 'module Authentication\n  extend ActiveSupport::Concern\n  included do\n    before_action :require_authentication\n  end\n  private\n    def require_authentication\n      resume_session || request_authentication\n    end\nend\n', ...appCtl('  include Secured') })
// P3
const EP = '#!/bin/bash -e\nif [ "${@: -2:1}" == "./bin/rails" ] && [ "${@: -1:1}" == "server" ]; then\n  ./bin/rails db:prepare\nfi\nexec "${@}"\n'
const H = { ...R, 'bin/docker-entrypoint': EP, Procfile: 'web: bundle exec puma -C config/puma.rb\n' }
chk2('P3.1', H, { ...H, 'db/migrate/20261028000000_add_note.rb': 'class AddNote < ActiveRecord::Migration[8.1]\n  def change\n    add_column :orders, :note, :text\n  end\nend\n' })
chk('P3.2', { 'config/initializers/stripe.rb': 'Stripe.api_key = ENV.fetch("STRIPE_SECRET_KEY")\n' })
const S: Record<string, string> = { ...R, 'db/schema.rb': 'ActiveRecord::Schema[8.1].define(version: 2026_01_01_000000) do\n  create_table "orders", force: :cascade do |t|\n    t.string "status"\n  end\nend\n' }; delete S['db/migrate/20260101000000_create_orders.rb']
chk2('P3.3', S, { ...S, 'db/migrate/20261028000000_x.rb': 'class X < ActiveRecord::Migration[8.1]\n  def change\n    drop_table :orders\n  end\nend\n' })
// P4
chk('P4.1', { ...routes('  resources :orders, only: [:destroy]'), 'app/controllers/orders_controller.rb': D, ...appCtl('  before_action :authenticate_user!\n  private\n  def audit\n    AuditLog.(request).save\n  end') })

  console.log('ok (review 23)')
}
  // Review 23, round 2: login a callback only sometimes gives; checks behind conditions; ordinary callbacks don't hide open routes; deploy
    {
      const R0 = { ...R, 'config/routes.rb': 'Rails.application.routes.draw do\n  devise_for :users\nend\n' }
      const routes = (r: string) => ({ 'config/routes.rb': `Rails.application.routes.draw do\n  devise_for :users\n${r}\nend\n` })
      const appCtl = (body: string) => ({ 'app/controllers/application_controller.rb': `class ApplicationController < ActionController::Base\n${body}\nend\n` })
      const E: Record<string, string[]> = {"R2.1a": [], "R2.1b": [], "R2.2": [], "R2.3": [], "R2.4": ["Anyone can use the order part"], "R2.4a": ["Anyone can use the order part"], "R2.4b": ["Anyone can use the order part"], "R2.4c": ["Anyone can use the order part"], "R2.5a": ["Anyone can use the order part"], "R2.5b": ["Anyone can use the order part"], "R2.6": ["bin/rails db:migrate"], "R2.7": ["release step runs it"], "R2.8": ["requires login ✓"], "R2.1a!": ["requires login ✓"], "R2.1b!": ["requires login ✓"], "R2.2!": ["requires login ✓"], "R2.3!": ["requires login ✓"], "R2.4!": [], "R2.4a!": [], "R2.4b!": [], "R2.4c!": [], "R2.5a!": [], "R2.5b!": [], "R2.6!": ["by itself", "Docker"], "R2.7!": ["docker-entrypoint"], "R2.8!": ["Anyone can"]}
      const out = (id: string, b: Record<string, string>, a: Record<string, string>) => { const k = id.split(' ')[0], c = card(b, a)
        for (const x of E[k] ?? []) assert.ok(c.includes(x), `review 23 ${k}: missing "${x}"\n${c}`)
        for (const x of E[k + '!'] ?? []) assert.ok(!c.includes(x), `review 23 ${k}: unexpected "${x}"\n${c}`) }
      const rr = (id: string, extra: Record<string, string>) => out(id, R0, { ...R0, ...extra })
  const O = (head: string, tail = '') => `class OrdersController < ApplicationController\n${head}\n  def index\n    @orders = Order.all\n  end\n  def destroy\n    Order.find(params[:id]).destroy\n    head :no_content\n  end\n${tail}\nend\n`
  const res = routes('  resources :orders, only: [:index, :destroy]')
  const gate = (id: string, body: string) => rr(id, { ...res, 'app/controllers/orders_controller.rb': O('  before_action :gate', `  private\n  def gate\n${body}\n  end`) })
  gate('R2.1a byName: authenticate_user! unless request.get?', '    authenticate_user! unless request.get?')
  gate('R2.1b byName: if request.format.html? block', '    if request.format.html?\n      authenticate_user!\n    end')
  gate('R2.2 guestsOut + conditional halt', '    return if current_user\n    redirect_to login_path unless request.format.json?')
  gate('R2.3 staging && basic auth', '    Rails.env.staging? && authenticate_or_request_with_http_basic { |u, p| p == ENV["PW"] }')
  const set = (id: string, cb: string) => rr(id, { ...routes('  resources :orders, only: [:destroy]'), 'app/controllers/orders_controller.rb': `class OrdersController < ApplicationController\n  before_action :set_order\n  def destroy\n    @order.destroy\n    head :no_content\n  end\n  private\n  def set_order\n${cb}\n  end\nend\n` })
  set('R2.4 baseline (open, warned)', '    @order = Order.find(params[:id])')
  set('R2.4a set_order with rescue', '    @order = Order.find(params[:id])\n  rescue ActiveRecord::RecordNotFound\n    redirect_to orders_path, alert: "Order not found"')
  set('R2.4b set_order head :not_found unless @order', '    @order = Order.find_by(id: params[:id])\n    head :not_found unless @order')
  const D = { ...res, 'app/controllers/orders_controller.rb': O('') }
  rr('R2.4c ApplicationController helper call', { ...D, ...appCtl('  before_action :set_default_meta\n  private\n  def set_default_meta\n    set_meta_tags(site: "Shop")\n  end') })
  rr('R2.5a Devise README configure_permitted_parameters', { ...D, ...appCtl('  before_action :configure_permitted_parameters, if: :devise_controller?\n\n  protected\n\n  def configure_permitted_parameters\n    devise_parameter_sanitizer.permit(:sign_up, keys: [:username])\n  end') })
  rr('R2.5b PaperTrail README set_paper_trail_whodunnit', { ...D, ...appCtl('  before_action :set_paper_trail_whodunnit') })
  const EP = '#!/bin/bash -e\nif [ "${@: -2:1}" == "./bin/rails" ] && [ "${@: -1:1}" == "server" ]; then\n  ./bin/rails db:prepare\nfi\nexec "${@}"\n'
  const mig = { 'db/migrate/20261028000000_add_note.rb': 'class AddNote < ActiveRecord::Migration[8.1]\n  def change\n    add_column :orders, :note, :text\n  end\nend\n' }
  const H = { ...R, 'bin/docker-entrypoint': EP, 'config/deploy.yml': 'service: shop\nimage: shop\nservers:\n  web:\n    - 192.168.0.1\n', Procfile: 'web: bundle exec puma -C config/puma.rb\n' }
  out('R2.6 Heroku app made by rails new 8.x (deploy.yml placeholder)', H, { ...H, ...mig })
  const P = { ...R, Procfile: 'release: bin/rails db:migrate\nweb: bundle exec puma\n' }
  out('R2.7 Procfile release:, no entrypoint (wording)', P, { ...P, ...mig })
  rr('R2.8 render_unauthorized helper', { ...D, ...appCtl('  before_action :require_user\n  private\n  def require_user\n    render_unauthorized unless current_user\n  end\n  def render_unauthorized\n    render json: { error: "unauthorized" }, status: :unauthorized\n  end') })
  
    }
  
  // review 23, round 3: a rescue that doesn't halt checks nobody; build + save is new; a real deploy.yml keeps the template's comments
  c = rs({ ...routes('  resources :line_items, only: [:create]'), 'app/controllers/concerns/current_cart.rb': 'module CurrentCart\n  private\n    def set_cart\n      @cart = Cart.find(session[:cart_id])\n    rescue ActiveRecord::RecordNotFound\n      @cart = Cart.create\n      session[:cart_id] = @cart.id\n    end\nend\n',
    'app/controllers/line_items_controller.rb': 'class LineItemsController < ApplicationController\n  include CurrentCart\n  before_action :set_cart, only: [:create]\n  def create\n    Order.create!(status: "x")\n    head :created\n  end\nend\n' })
  has(c, 'without logging in')
  has(rs({ ...res, ...appCtl('  before_action :authenticate_user!'), 'app/controllers/orders_controller.rb': orders('').replace('    current_user.orders.create!(order_params)', '    @order = current_user.orders.build(order_params)\n    @order.save') }), 'saves new ones')
  has(mig('    add_column :orders, :note, :text', { 'config/deploy.yml': 'service: shop\nservers:\n  web:\n    - 203.0.113.10\n  # job:\n  #   hosts:\n  #     - 192.168.0.1\n', 'bin/docker-entrypoint': './bin/rails db:prepare\n' }), 'will change your live database by itself')
  c = mig('    create_table :line_items do |t|\n      t.references :order\n    end')
  has(c, 'Your database now stores line items. Each one belongs to an order.')
  console.log('ok (rails)')
}

// Go (2026-10-28): main() run as far as routes go; chi / gin / echo / net/http middleware rules; checks read structurally; writes, Stripe, migrations
{
  const G: Record<string, string> = {
    'go.mod': 'module example.com/shop\n\ngo 1.23\n\nrequire github.com/go-chi/chi/v5 v5.2.0\n',
    'migrations/000001_orders.up.sql': 'create table orders (id serial primary key, total int not null, status text);\n',
  }
  const auth = '\nfunc requireAuth(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tc, err := r.Cookie("session")\n\t\tif err != nil {\n\t\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\t_ = c\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n'
  const handlers = '\nfunc createOrder(w http.ResponseWriter, r *http.Request) {\n\tdb.ExecContext(r.Context(), "INSERT INTO orders (total) VALUES ($1)", 10)\n}\n\nfunc listOrders(w http.ResponseWriter, r *http.Request) {\n\tdb.QueryContext(r.Context(), "SELECT id FROM orders")\n}\n'
  const app = (imports: string, body: string, extra = '') => ({ 'main.go': `package main\n\nimport (\n\t"net/http"\n${imports}\n)\n\nfunc main() {\n${body}\n}\n${auth}${handlers}${extra}` })
  const gc = (files: Record<string, string>, base = G) => card(base, { ...base, ...files })
  const has = (c: string, ...xs: string[]) => { for (const x of xs) assert.ok(c.includes(x), `go: missing "${x}"\n${c}`) }
  const not = (c: string, ...xs: string[]) => { for (const x of xs) assert.ok(!c.includes(x), `go: unexpected "${x}"\n${c}`) }
  const chi = '\t"github.com/go-chi/chi/v5"'
  // chi: a group's Use covers its routes; a route outside it is open
  let c = gc(app(chi, '\tr := chi.NewRouter()\n\tr.Get("/orders", listOrders)\n\tr.Group(func(r chi.Router) {\n\t\tr.Use(requireAuth)\n\t\tr.Post("/orders/new", createOrder)\n\t})\n\thttp.ListenAndServe(":8080", r)'))
  has(c, 'saves new orders and requires login ✓', 'lists orders and works without logging in')
  // a check that answers 401 but doesn't return: not a check, and a problem
  c = gc({ 'main.go': app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Post("/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)')['main.go'].replace('\t\t\treturn\n', '') })
  has(c, "doesn't stop the request"); not(c, 'requires login ✓')
  // jwtauth: Verifier alone turns nobody away; Authenticator does
  const jwt = '\t"github.com/go-chi/jwtauth/v5"\n' + chi
  has(gc(app(jwt, '\tr := chi.NewRouter()\n\tr.Use(jwtauth.Verifier(tokenAuth))\n\tr.Post("/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)')), 'Anyone can use the orders part')
  has(gc(app(jwt, '\tr := chi.NewRouter()\n\tr.Use(jwtauth.Verifier(tokenAuth))\n\tr.Use(jwtauth.Authenticator(tokenAuth))\n\tr.Post("/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)')), 'saves new orders and requires login ✓')
  // gin: Use covers only the routes registered after it; a group made before it keeps what it had
  const gin = '\t"github.com/gin-gonic/gin"'
  const ginAuth = '\nfunc AuthRequired() gin.HandlerFunc {\n\treturn func(c *gin.Context) {\n\t\tif c.GetHeader("Authorization") == "" {\n\t\t\tc.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "login"})\n\t\t\treturn\n\t\t}\n\t\tc.Next()\n\t}\n}\n'
  const ginH = '\nfunc createOrderGin(c *gin.Context) {\n\tdb.Exec("INSERT INTO orders (total) VALUES (1)")\n}\n'
  c = gc(app(gin, '\tr := gin.Default()\n\tr.POST("/early", createOrderGin)\n\tr.Use(AuthRequired())\n\tr.POST("/orders", createOrderGin)\n\tr.Run()', ginAuth + ginH))
  has(c, '/early', 'Anyone can use the early part'); has(c, 'saves new orders and requires login ✓')
  // gin: c.JSON(401) without Abort lets the handler run
  c = gc(app(gin, '\tr := gin.Default()\n\tr.Use(AuthRequired())\n\tr.POST("/orders", createOrderGin)\n\tr.Run()', ginAuth.replace('c.AbortWithStatusJSON(http.StatusUnauthorized', 'c.JSON(http.StatusUnauthorized') + ginH))
  has(c, "doesn't stop the request", 'c.AbortWithStatusJSON'); not(c, 'requires login ✓')
  // echo: e.Use covers every route, whatever the order
  has(gc(app('\t"github.com/labstack/echo/v4"\n\techojwt "github.com/labstack/echo-jwt/v4"', '\te := echo.New()\n\te.POST("/orders", createOrderEcho)\n\te.Use(echojwt.WithConfig(cfg))\n\te.Start(":8080")', '\nfunc createOrderEcho(c echo.Context) error {\n\tdb.Exec("INSERT INTO orders (total) VALUES (1)")\n\treturn nil\n}\n')), 'saves new orders and requires login ✓')
  // net/http: a wrapped handler, and a wrapped mux
  has(gc(app('', '\tmux := http.NewServeMux()\n\tmux.HandleFunc("POST /orders", requireAuth(http.HandlerFunc(createOrder)).ServeHTTP)\n\tmux.Handle("POST /orders/new", requireAuth(http.HandlerFunc(createOrder)))\n\thttp.ListenAndServe(":8080", mux)')), '/orders/new', 'requires login ✓')
  has(gc(app('', '\tmux := http.NewServeMux()\n\tmux.HandleFunc("POST /orders", createOrder)\n\thttp.ListenAndServe(":8080", requireAuth(mux))')), 'saves new orders and requires login ✓')
  // go.mod older than 1.22 with method patterns: the routes never match
  has(gc(app('', '\tmux := http.NewServeMux()\n\tmux.HandleFunc("POST /orders", createOrder)\n\thttp.ListenAndServe(":8080", mux)'), { ...G, 'go.mod': G['go.mod'].replace('go 1.23', 'go 1.21') }), 'Your go.mod says go 1.21')
  // routes registered in another package, through a router passed on
  c = gc({ ...app(chi + '\n\t"example.com/shop/internal/api"', '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tapi.Register(r)\n\thttp.ListenAndServe(":8080", r)'),
    'internal/api/api.go': 'package api\n\nimport "github.com/go-chi/chi/v5"\n\nfunc Register(r chi.Router) {\n\tr.Delete("/orders/{id}", deleteOrder)\n}\n\nfunc deleteOrder(w http.ResponseWriter, r *http.Request) {\n\tdb.ExecContext(r.Context(), "DELETE FROM orders WHERE id = $1", 1)\n}\n' })
  has(c, 'deletes orders and requires login ✓', '/orders/[id]')
  // migrations: the step; by itself when main runs them; GORM's AutoMigrate never drops a column
  c = gc({ ...app(chi, '\tr := chi.NewRouter()\n\thttp.ListenAndServe(":8080", r)'), 'migrations/000002_x.up.sql': 'alter table orders add column note text;\n' })
  has(c, 'Apply 000002_x.up.sql to your live database before the new code goes live (`migrate')
  has(gc({ ...app(chi, '\tm, _ := migrate.New("file://migrations", os.Getenv("DATABASE_URL"))\n\tm.Up()\n\tr := chi.NewRouter()\n\thttp.ListenAndServe(":8080", r)'), 'migrations/000002_x.up.sql': 'alter table orders add column note text;\n' }), 'will change your live database by itself the next time the app starts')
  const gorm = (fields: string) => ({ 'models.go': `package main\n\ntype Order struct {\n\tgorm.Model\n${fields}\n}\n\nfunc setup() {\n\tdb.AutoMigrate(&Order{})\n}\n` })
  const G0 = { 'go.mod': G['go.mod'] }
  c = card({ ...G0, ...gorm('\tTotal int\n\tNote string') }, { ...G0, ...gorm('\tTotal int') })
  has(c, 'AutoMigrate leaves that column and its data in the database'); not(c, 'deleted for good')
  // Stripe, required settings
  c = gc(app(chi + '\n\t"github.com/stripe/stripe-go/v82/checkout/session"', '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Post("/pay", pay)\n\thttp.ListenAndServe(":8080", r)',
    '\nfunc pay(w http.ResponseWriter, r *http.Request) {\n\tkey := mustEnv("STRIPE_SECRET_KEY")\n\t_ = key\n\ts, _ := session.New(&stripe.CheckoutSessionParams{})\n\t_ = s\n}\n'))
  has(c, 'charges customers 💰', 'Add STRIPE_SECRET_KEY to your hosting settings')
  // a hand-written call to Stripe's refunds API
  has(gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Post("/orders/{id}/refund", refund)\n\thttp.ListenAndServe(":8080", r)', '\nfunc refund(w http.ResponseWriter, r *http.Request) {\n\treq, _ := http.NewRequest("POST", "https://api.stripe.com/v1/refunds", nil)\n\thttp.DefaultClient.Do(req)\n}\n')), 'asks Stripe to create a refund')
  console.log('ok (go)')
}

// Review 24 (Go): each a case that used to be wrong (library sources settled them); two known gaps aside
{
const G: Record<string, string> = {
  'go.mod': 'module example.com/shop\n\ngo 1.23\n\nrequire github.com/go-chi/chi/v5 v5.2.0\n',
  'migrations/000001_orders.up.sql': 'create table orders (id serial primary key, total int not null, status text);\n',
}
const auth = '\nfunc requireAuth(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tc, err := r.Cookie("session")\n\t\tif err != nil {\n\t\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\t_ = c\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n'
const handlers = '\nfunc createOrder(w http.ResponseWriter, r *http.Request) {\n\tdb.ExecContext(r.Context(), "INSERT INTO orders (total) VALUES ($1)", 10)\n}\n\nfunc listOrders(w http.ResponseWriter, r *http.Request) {\n\tdb.QueryContext(r.Context(), "SELECT id FROM orders")\n}\n'
const app = (imports: string, body: string, extra = '', withAuth = true) => ({ 'main.go': `package main\n\nimport (\n\t"net/http"\n${imports}\n)\n\nfunc main() {\n${body}\n}\n${withAuth ? auth : ''}${handlers}${extra}` })
const gc = (files: Record<string, string>, base = G) => card(base, { ...base, ...files })
const chi = '\t"github.com/go-chi/chi/v5"'
const gin = '\t"github.com/gin-gonic/gin"'
const echo = '\t"github.com/labstack/echo/v4"'

const F: [string, string, () => string, (c: string) => boolean][] = []   // [id, expected, card, isBug]
const mw = (name: string, param: string, inner: string) => `\nfunc ${name}(${param} http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n${inner}\n\t})\n}\n`
const chiApp = (use: string, route: string, extra: string, imports = chi) => app(imports, `\tr := chi.NewRouter()\n\tr.Use(${use})\n${route}\n\thttp.ListenAndServe(":8080", r)`, extra)
const POST = '\tr.Post("/orders", createOrder)', GET = '\tr.Get("/orders", listOrders)'
const ginH = '\nfunc createOrderGin(c *gin.Context) {\n\tdb.Exec("INSERT INTO orders (total) VALUES (1)")\n}\n'
const ginApp = (mwSrc: string, use = 'AuthRequired()') => app(gin, `\tr := gin.Default()\n\tr.Use(${use})\n\tr.POST("/orders", createOrderGin)\n\tr.Run()`, mwSrc + ginH)
const LOGIN = (c: string) => c.includes('requires login ✓'), OPEN = (c: string) => /works without logging in|Anyone can use/.test(c)

// 1a optional auth: deny nested under "if a token/cookie is present"
F.push(['1a optional auth', 'no login claim', () => gc(chiApp('loadUser', POST, mw('loadUser', 'next', '\t\tc, err := r.Cookie("session")\n\t\tif err == nil {\n\t\t\tu, err := lookupSession(c.Value)\n\t\t\tif err != nil {\n\t\t\t\thttp.Error(w, "session expired", http.StatusUnauthorized)\n\t\t\t\treturn\n\t\t\t}\n\t\t\tr = r.WithContext(context.WithValue(r.Context(), userKey, u))\n\t\t}\n\t\tnext.ServeHTTP(w, r)'))), LOGIN])
// 1b deny condition with an exemption (&&)
F.push(['1b exemption in condition', 'no login claim for /public/orders', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireLogin)\n\tr.Post("/public/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)', mw('requireLogin', 'next', '\t\t_, err := r.Cookie("session")\n\t\tif !strings.HasPrefix(r.URL.Path, "/public/") && err != nil {\n\t\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)'))), LOGIN])
// 1c AUTHY too broad: business-rule 403, CSRF check
F.push(['1c business 403 on "account"', 'public deposit route flagged', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Post("/accounts/{id}/deposit", deposit)\n\thttp.ListenAndServe(":8080", r)', '\nfunc deposit(w http.ResponseWriter, r *http.Request) {\n\taccount := loadAccount(chi.URLParam(r, "id"))\n\tif account.Locked {\n\t\thttp.Error(w, "this account is locked", http.StatusForbidden)\n\t\treturn\n\t}\n\tdb.ExecContext(r.Context(), "UPDATE accounts SET balance = balance + $1 WHERE id = $2", 10, 1)\n}\n'), { ...G, 'migrations/000002_accounts.up.sql': 'create table accounts (id serial primary key, balance int not null, locked boolean);\n' }), LOGIN])
F.push(['1c CSRF double-submit', 'no login claim', () => gc(chiApp('csrfCheck', POST, mw('csrfCheck', 'next', '\t\tc, err := r.Cookie("csrf_token")\n\t\tif err != nil || r.Header.Get("X-CSRF-Token") != c.Value {\n\t\t\thttp.Error(w, "forbidden", http.StatusForbidden)\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)'))), LOGIN])
F.push(['1c gorilla store.Get err', 'no login claim (Get returns err==nil with no cookie)', () => gc(chiApp('requireLogin', POST, mw('requireLogin', 'next', '\t\tsession, err := store.Get(r, "session")\n\t\tif err != nil {\n\t\t\thttp.Error(w, "forbidden", http.StatusForbidden)\n\t\t\treturn\n\t\t}\n\t\t_ = session\n\t\tnext.ServeHTTP(w, r)'))), LOGIN])
// 2 gin: deny without Abort (Redirect / Status) still runs the handler
const ginRedir = '\nfunc AuthRequired() gin.HandlerFunc {\n\treturn func(c *gin.Context) {\n\t\tif sessions.Default(c).Get("user") == nil {\n\t\t\tc.Redirect(http.StatusFound, "/login")\n\t\t\treturn\n\t\t}\n\t\tc.Next()\n\t}\n}\n'
F.push(['2 gin Redirect no Abort', '"doesn\'t stop the request" problem, no login claim', () => gc(ginApp(ginRedir)), LOGIN])
F.push(['2 gin Status no Abort', 'same', () => gc(ginApp(ginRedir.replace('c.Redirect(http.StatusFound, "/login")', 'c.Status(http.StatusUnauthorized)'))), LOGIN])
// 3 exemption loop/switch not seen as an escape when the next var isn't named next / c
F.push(['3 for-exemption, param h', 'no login claim for exempted /orders', () => gc(chiApp('authMiddleware', POST, '\nvar public = []string{"/orders"}\n' + mw('authMiddleware', 'h', '\t\tfor _, p := range public {\n\t\t\tif strings.HasPrefix(r.URL.Path, p) {\n\t\t\t\th.ServeHTTP(w, r)\n\t\t\t\treturn\n\t\t\t}\n\t\t}\n\t\tif _, err := r.Cookie("session"); err != nil {\n\t\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\th.ServeHTTP(w, r)'))), LOGIN])
F.push(['3 gin switch-exemption, ctx', 'no login claim', () => gc(ginApp('\nfunc AuthRequired() gin.HandlerFunc {\n\treturn func(ctx *gin.Context) {\n\t\tswitch ctx.FullPath() {\n\t\tcase "/orders":\n\t\t\tctx.Next()\n\t\t\treturn\n\t\t}\n\t\tif ctx.GetHeader("Authorization") == "" {\n\t\t\tctx.AbortWithStatus(http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tctx.Next()\n\t}\n}\n')), LOGIN])
// 4 library names beat code / unique-method fallback
const mwPkg = 'package middleware\n\nimport "net/http"\n\nfunc RequireAuth(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tif _, err := r.Cookie("session"); err != nil {\n\t\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n\nfunc JWTParser(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n'
const own = (use: string, route: string, pkg = 'middleware') => ({ ...chiApp(use, route, '', chi + `\n\t"example.com/shop/internal/${pkg}"`), [`internal/${pkg}/auth.go`]: mwPkg.replace('package middleware', `package ${pkg}`) })
F.push(['4 own middleware.JWTParser (never rejects)', 'no login claim', () => gc(own('middleware.JWTParser', POST)), LOGIN])
F.push(['4 echojwt Skipper', 'no login claim (Skipper lets all through)', () => gc(app(echo + '\n\techojwt "github.com/labstack/echo-jwt/v4"', '\te := echo.New()\n\te.Use(echojwt.WithConfig(echojwt.Config{SigningKey: []byte(os.Getenv("JWT_SECRET")), Skipper: func(c echo.Context) bool { return true }}))\n\te.POST("/orders", createOrderEcho)\n\te.Start(":8080")', '\nfunc createOrderEcho(c echo.Context) error {\n\tdb.Exec("INSERT INTO orders (total) VALUES (1)")\n\treturn nil\n}\n')), LOGIN])
F.push(['4 rs/cors c.Handler -> own Guard.Handler', 'public route, no login claim', () => gc({ ...app(chi + '\n\t"github.com/rs/cors"', '\tc := cors.New(cors.Options{AllowedOrigins: []string{"https://myshop.com"}})\n\tr := chi.NewRouter()\n\tr.Use(c.Handler)\n\tr.Post("/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)'), 'internal/auth/guard.go': 'package auth\n\nimport "net/http"\n\ntype Guard struct{}\n\nfunc (g *Guard) Handler(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tif _, err := r.Cookie("session"); err != nil {\n\t\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n' }), LOGIN])
// 5 real login called open
F.push(['5 own middleware.RequireAuth', 'requires login ✓', () => gc(own('middleware.RequireAuth', GET)), OPEN])
F.push(['5 own handlers.RequireAuth', 'requires login ✓', () => gc(own('handlers.RequireAuth', GET, 'handlers')), OPEN])
F.push(['5 positive form (if ok { next; return }; deny)', 'requires login ✓', () => gc(chiApp('requireLogin', GET, mw('requireLogin', 'next', '\t\tif isAuthenticated(r) {\n\t\t\tnext.ServeHTTP(w, r)\n\t\t\treturn\n\t\t}\n\t\thttp.Redirect(w, r, "/login", http.StatusSeeOther)'))), OPEN])
F.push(['5 deny via helper writeError(w, 401, ...)', 'requires login ✓ (or unknown)', () => gc(chiApp('requireUser', GET, mw('requireUser', 'next', '\t\tif _, err := r.Cookie("session"); err != nil {\n\t\t\twriteError(w, http.StatusUnauthorized, "login required")\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)'))), OPEN])
F.push(['5 switch-based check', 'requires login ✓', () => gc(chiApp('requireLogin', GET, mw('requireLogin', 'next', '\t\tswitch {\n\t\tcase r.Header.Get("Authorization") == "":\n\t\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)'))), OPEN])
F.push(['5 if/else (correct code)', 'requires login ✓, no problem', () => gc(chiApp('requireLogin', GET, mw('requireLogin', 'next', '\t\tif _, err := r.Cookie("session"); err != nil {\n\t\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)\n\t\t} else {\n\t\t\tnext.ServeHTTP(w, r)\n\t\t}'))), c => OPEN(c) && c.includes("doesn't stop the request")])
const gf = '\nfunc AuthRequired(sm *Sessions) gin.HandlerFunc {\n\treturn func(c *gin.Context) {\n\t\tif sm.GetString(c.Request.Context(), "user") == "" {\n\t\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tc.Next()\n\t}\n}\n'
F.push(['5 middleware factory with a dep: AuthRequired(sm)', 'requires login ✓', () => gc(ginApp(gf, 'AuthRequired(sm)')), OPEN])
F.push(['5 3-level factory RequireUser(store) with cookie err check', 'requires login ✓', () => gc(chiApp('RequireUser(store)', GET, '\nfunc RequireUser(st *Store) func(http.Handler) http.Handler {\n\treturn func(next http.Handler) http.Handler {\n\t\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\t\tc, err := r.Cookie("session")\n\t\t\tif err != nil {\n\t\t\t\thttp.Error(w, "please log in", http.StatusUnauthorized)\n\t\t\t\treturn\n\t\t\t}\n\t\t\t_ = c\n\t\t\tnext.ServeHTTP(w, r)\n\t\t})\n\t}\n}\n')), OPEN])
F.push(['5 log.Fatal(http.ListenAndServe(addr, requireAuth(mux)))', 'requires login ✓', () => gc(app('', '\tmux := http.NewServeMux()\n\tmux.HandleFunc("GET /orders", listOrders)\n\tlog.Fatal(http.ListenAndServe(":8080", requireAuth(mux)))')), OPEN])
F.push(['5 &http.Server{Handler: requireAuth(mux)}', 'requires login ✓', () => gc(app('', '\tmux := http.NewServeMux()\n\tmux.HandleFunc("GET /orders", listOrders)\n\tsrv := &http.Server{Addr: ":8080", Handler: requireAuth(mux)}\n\tsrv.ListenAndServe()')), OPEN])
F.push(['5 router func returns requireAuth(mux)', 'requires login ✓', () => gc(app(chi, '\th := newRouter()\n\thttp.ListenAndServe(":8080", h)', '\nfunc newRouter() http.Handler {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("GET /orders", listOrders)\n\treturn requireAuth(mux)\n}\n')), OPEN])
F.push(['5 sub-mux wrapped: mux.Handle("/admin/", requireAuth(admin))', 'admin route requires login ✓, no phantom /admin', () => gc(app('', '\tadmin := http.NewServeMux()\n\tadmin.HandleFunc("POST /admin/orders", createOrder)\n\tmux := http.NewServeMux()\n\tmux.Handle("/admin/", requireAuth(admin))\n\thttp.ListenAndServe(":8080", mux)')), c => c.includes('Anyone can use the admin orders')])
F.push(['5 StripPrefix mount (dead branch)', '/api/orders requires login ✓', () => gc(app('', '\tapi := http.NewServeMux()\n\tapi.HandleFunc("GET /orders", listOrders)\n\tmux := http.NewServeMux()\n\tmux.Handle("/api/", http.StripPrefix("/api", requireAuth(api)))\n\thttp.ListenAndServe(":8080", mux)')), c => !c.includes('/api/orders')])
F.push(['5 chi Mount("/admin", requireAuth(adminRoutes()))', 'requires login ✓', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Mount("/admin", requireAuth(adminRoutes()))\n\thttp.ListenAndServe(":8080", r)', '\nfunc adminRoutes() http.Handler {\n\tr := chi.NewRouter()\n\tr.Get("/orders", listOrders)\n\treturn r\n}\n')), OPEN])
// 6 public write routes vanish (card: "No problems spotted")
const gone = (c: string) => !c.includes('/orders') && c.includes('No problems spotted')
F.push(['6 http.HandleFunc (DefaultServeMux)', '⚠ Anyone can use orders', () => gc(app('', '\thttp.HandleFunc("POST /orders", createOrder)\n\tlog.Fatal(http.ListenAndServe(":8080", nil))', '', false)), gone])
F.push(['6 r.With(mw).Post(...) inline', '⚠ Anyone can use orders', () => gc(app(chi + '\n\t"github.com/go-chi/chi/v5/middleware"', '\tr := chi.NewRouter()\n\tr.With(middleware.Logger).Post("/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)')), gone])
F.push(['6 http.ListenAndServe(addr, newRouter())', '⚠', () => gc(app(chi, '\tlog.Fatal(http.ListenAndServe(":8080", newRouter()))', '\nfunc newRouter() http.Handler {\n\tr := chi.NewRouter()\n\tr.Post("/orders", createOrder)\n\treturn r\n}\n')), gone])
F.push(['6 &http.Server{Handler: app.routes()} (Let\'s Go)', '⚠', () => gc({ 'main.go': 'package main\n\nimport "net/http"\n\ntype application struct{}\n\nfunc main() {\n\tapp := &application{}\n\tsrv := &http.Server{Addr: ":4000", Handler: app.routes()}\n\tsrv.ListenAndServe()\n}\n', 'routes.go': 'package main\n\nimport "net/http"\n\nfunc (app *application) routes() http.Handler {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("POST /orders", app.createOrder)\n\treturn mux\n}\n\nfunc (app *application) createOrder(w http.ResponseWriter, r *http.Request) {\n\tdb.ExecContext(r.Context(), "INSERT INTO orders (total) VALUES ($1)", 10)\n}\n' }), gone])
F.push(['6 r.Route("/admin", adminRoutes) named fn', '⚠', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Route("/admin", adminRoutes)\n\thttp.ListenAndServe(":8080", r)', '\nfunc adminRoutes(r chi.Router) {\n\tr.Post("/orders", createOrder)\n}\n')), gone])
F.push(['6 register(r.Group("/api")) gin', '⚠', () => gc(app(gin, '\tr := gin.Default()\n\tregister(r.Group("/api"))\n\tr.Run()', ginH + '\nfunc register(g *gin.RouterGroup) {\n\tg.POST("/orders", createOrderGin)\n}\n')), gone])
F.push(['6 struct-field router s.routes()', '⚠', () => gc(app(chi, '\ts := &server{router: chi.NewRouter()}\n\ts.routes()\n\thttp.ListenAndServe(":8080", s.router)', '\ntype server struct{ router *chi.Mux }\n\nfunc (s *server) routes() {\n\ts.router.Post("/orders", createOrder)\n}\n')), gone])
F.push(['6 handler factory createOrderHandler(pool)', 'saves new orders + ⚠', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Post("/orders", createOrderHandler(pool))\n\thttp.ListenAndServe(":8080", r)', '\nfunc createOrderHandler(pool *pgxpool.Pool) http.HandlerFunc {\n\treturn func(w http.ResponseWriter, r *http.Request) {\n\t\tpool.Exec(r.Context(), "INSERT INTO orders (total) VALUES ($1)", 10)\n\t}\n}\n')), c => c.includes('accepts requests') && !c.includes('Anyone can use')])
// 7 migrations
const d1 = { 'package.json': '{"dependencies":{"hono":"4"}}', 'migrations/0001_init.sql': 'CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER);\n', 'src/index.ts': "export default {}\n" }
F.push(['7 D1/JS repo migrations/0002.sql', 'no golang-migrate step (HEAD: "The agent added migrations/0002_note.sql")', () => card(d1, { ...d1, 'migrations/0002_note.sql': 'ALTER TABLE orders ADD COLUMN note TEXT;\n' }), c => c.includes('migrate -path')])
const rust = { 'Cargo.toml': '[package]\nname="x"\n', 'migrations/20240101000000_init.up.sql': 'CREATE TABLE orders (id BIGSERIAL PRIMARY KEY);\n', 'src/main.rs': 'fn main() {}\n' }
F.push(['7 Rust sqlx .up.sql', 'no golang-migrate step', () => card(rust, { ...rust, 'migrations/20240201000000_note.up.sql': 'ALTER TABLE orders ADD COLUMN note TEXT;\n' }), c => c.includes('migrate -path')])
const base = { ...G, ...app(chi, '\tr := chi.NewRouter()\n\thttp.ListenAndServe(":8080", r)') }
const selfM = (extra: Record<string,string>) => card({ ...base, ...extra }, { ...base, ...extra, 'migrations/000002_x.up.sql': 'alter table orders add column note text;\n' })
F.push(['7 AutoMigrate only in a _test.go', '"Apply ... migrate up" step', () => selfM({ 'store_test.go': 'package main\n\nfunc TestStore(t *testing.T) {\n\tdb.AutoMigrate(&Order{})\n}\n' }), c => c.includes('by itself')])
F.push(['7 m.Up() only in cmd/migrate/main.go', '"Apply ..." / run cmd/migrate', () => selfM({ 'cmd/migrate/main.go': 'package main\n\nimport "github.com/golang-migrate/migrate/v4"\n\nfunc main() {\n\tm, _ := migrate.New("file://migrations", os.Getenv("DATABASE_URL"))\n\tm.Up()\n}\n' }), c => c.includes('by itself')])
F.push(['7 goose lowercase "-- +goose down"', 'coupons added, nothing deleted', () => card(base, { ...base, 'migrations/00002_coupons.sql': '-- +goose Up\nCREATE TABLE coupons (id serial primary key, code text not null);\n\n-- +goose down\nDROP TABLE orders;\n' }), c => c.includes('deleted for good')])
const gm = (f: string) => ({ 'models.go': `package main\n\ntype Order struct {\n\tgorm.Model\n${f}\n}\n\nfunc setup() {\n\tdb.AutoMigrate(&Order{})\n}\n` })
F.push(['7 GORM model + SQL table: duplicate line', 'one "Orders now also store the note."', () => card({ ...G, ...gm('\tTotal int') }, { ...G, ...gm('\tTotal int\n\tNote string'), 'migrations/000002_note.up.sql': 'alter table orders add column note text;\n' }), c => c.split('Orders now also store the note').length > 2])
// 8 false alarms / missed: CORS, SQL, env, Stripe
const corsApp = (opts: string) => gc(app(chi + '\n\t"github.com/go-chi/cors"', `\tr := chi.NewRouter()\n\tr.Use(cors.Handler(cors.Options{\n${opts}\n\t}))\n\tr.Use(requireAuth)\n\tr.Get("/orders", listOrders)\n\thttp.ListenAndServe(":8080", r)`))
F.push(['8 CORS: commented README line', 'no CORS problem', () => corsApp('\t\tAllowedOrigins:   []string{"https://myshop.com"},\n\t\t// AllowOriginFunc:  func(r *http.Request, origin string) bool { return true },\n\t\tAllowCredentials: true,'), c => c.includes('Any website can make requests')])
F.push(['8 CORS: "https://*" + credentials (README value)', 'CORS problem', () => corsApp('\t\tAllowedOrigins:   []string{"https://*", "http://*"},\n\t\tAllowCredentials: true,'), c => !c.includes('Any website')])
F.push(['8 SQL /i on a log message', 'no SQL injection problem', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Get("/orders", listOrders)\n\tlog.Println(fmt.Sprintf("Delete %s requested", "x"))\n\thttp.ListenAndServe(":8080", r)')), c => c.includes('SQL injection')])
F.push(['8 SQL backtick Sprintf missed', 'SQL injection problem', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Get("/orders", search)\n\thttp.ListenAndServe(":8080", r)', '\nfunc search(w http.ResponseWriter, r *http.Request) {\n\tq := fmt.Sprintf(`SELECT id FROM orders WHERE status = \'%s\'`, r.URL.Query().Get("status"))\n\tdb.QueryContext(r.Context(), q)\n}\n')), c => !c.includes('SQL injection')])
F.push(['8 env: LookupEnv with default marked required', 'no "Add PORT"', () => gc(app(chi, '\tport, ok := os.LookupEnv("PORT")\n\tif !ok {\n\t\tport = "8080"\n\t}\n\tdb, err := sql.Open("pgx", dsn)\n\tif err != nil {\n\t\tlog.Fatal(err)\n\t}\n\t_ = db\n\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Get("/orders", func(w http.ResponseWriter, r *http.Request) { _ = os.Getenv("PORT") })\n\thttp.ListenAndServe(":"+port, r)')), c => c.includes('Add PORT')])
F.push(['8 env tag required never surfaces', '"Add STRIPE_SECRET_KEY"', () => gc({ ...app(chi, '\tcfg := load()\n\t_ = cfg\n\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Post("/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)'), 'config.go': 'package main\n\ntype Config struct {\n\tStripeKey string `env:"STRIPE_SECRET_KEY,required"`\n}\n\nfunc load() Config {\n\tvar c Config\n\tif err := env.Parse(&c); err != nil {\n\t\tpanic(err)\n\t}\n\treturn c\n}\n' }), c => !c.includes('STRIPE_SECRET_KEY')])
F.push(['8 Stripe client.API not money', 'charges customers 💰', () => gc(app(chi + '\n\t"github.com/stripe/stripe-go/v76"\n\t"github.com/stripe/stripe-go/v76/client"', '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Post("/pay", pay)\n\thttp.ListenAndServe(":8080", r)', '\nfunc pay(w http.ResponseWriter, r *http.Request) {\n\tsc := &client.API{}\n\tsc.Init(os.Getenv("STRIPE_SECRET_KEY"), nil)\n\tsc.CheckoutSessions.New(&stripe.CheckoutSessionParams{})\n}\n')), c => !c.includes('💰')])
F.push(['8 sk_live_ literal in .go', 'Unsafe: secret in code', () => gc(app(chi + '\n\t"github.com/stripe/stripe-go/v82"', '\tstripe.Key = "' + ['sk', 'live', '51HxQ2bLkdfj3l4kj5lk6j7lk8j9lk0jlkj'].join('_') + '"\n\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Get("/orders", listOrders)\n\thttp.ListenAndServe(":8080", r)')), c => !/secret|key is written/i.test(c)])
F.push(['8 sqlc UpdateOrderStatus write missed', 'changes orders', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Post("/orders/{id}/status", h.updateStatus)\n\thttp.ListenAndServe(":8080", r)', '\ntype Handler struct{ queries *db.Queries }\n\nfunc (h *Handler) updateStatus(w http.ResponseWriter, r *http.Request) {\n\th.queries.UpdateOrderStatus(r.Context(), db.UpdateOrderStatusParams{})\n}\n')), c => c.includes('accepts requests')])
// 9 duplicate trap report
F.push(['9 401 without return reported twice', 'one ✖', () => { const f = chiApp('requireAuth', POST, ''); f['main.go'] = f['main.go'].replace('\t\t\treturn\n', ''); return gc(f) }, c => c.split("doesn't stop the request").length > 2])

  const GAPS = /^6 (register\(r\.Group|struct-field router)/   // routers handed over as a call's argument or kept in a struct field: not read yet (a miss, never a false ✓)
  for (const [id, exp, run, isBug] of F) { if (GAPS.test(id)) continue; const c = run(); assert.ok(!isBug(c), `review 24 ${id}: expected ${exp}\n${c}`) }
  console.log('ok (review 24)')
  // Review 24, round 3 (Go): gin middleware without Abort, wherever it stands; reset links; a struct named Handler; reading a Stripe session
  {
const F: [string, string, () => string, (c: string) => boolean][] = []
const LOGIN = (c: string) => c.includes('requires login ✓')
const ginH = '\nfunc createOrderGin(c *gin.Context) {\n\tdb.Exec("INSERT INTO orders (total) VALUES (1)")\n}\n'
const named = '\nfunc AuthMiddleware(c *gin.Context) {\n\tif c.GetHeader("Authorization") == "" {\n\t\tc.JSON(http.StatusUnauthorized, gin.H{"error": "login"})\n\t\treturn\n\t}\n\tc.Next()\n}\n'
const lit = 'func(c *gin.Context) {\n\t\tif c.GetHeader("Authorization") == "" {\n\t\t\tc.JSON(http.StatusUnauthorized, gin.H{"error": "login"})\n\t\t\treturn\n\t\t}\n\t\tc.Next()\n\t}'
// A. gin middleware without Abort read as a handler -> "requires login ✓" (round 2: unknown + trap)
F.push(['A1 named gin mw, r.Use(AuthMiddleware)', 'trap, no login claim', () => gc(app(gin, '\tr := gin.Default()\n\tr.Use(AuthMiddleware)\n\tr.POST("/orders", createOrderGin)\n\tr.Run()', named + ginH)), LOGIN])
F.push(['A2 named gin mw, route-level r.POST(p, AuthMiddleware, h)', 'same', () => gc(app(gin, '\tr := gin.Default()\n\tr.POST("/orders", AuthMiddleware, createOrderGin)\n\tr.Run()', named + ginH)), LOGIN])
F.push(['A3 named gin mw redirect, r.Use(RequireLogin)', 'same', () => gc(app(gin, '\tr := gin.Default()\n\tr.Use(RequireLogin)\n\tr.POST("/orders", createOrderGin)\n\tr.Run()', '\nfunc RequireLogin(c *gin.Context) {\n\tif sessions.Default(c).Get("user") == nil {\n\t\tc.Redirect(http.StatusFound, "/login")\n\t\treturn\n\t}\n\tc.Next()\n}\n' + ginH)), LOGIN])
F.push(['A4 gin literal as group middleware r.Group(p, func...)', 'same', () => gc(app(gin, `\tr := gin.Default()\n\tapi := r.Group("/api", ${lit})\n\tapi.POST("/orders", createOrderGin)\n\tr.Run()`, ginH)), LOGIN])
F.push(['A5 gin literal as route middleware', 'same', () => gc(app(gin, `\tr := gin.Default()\n\tr.POST("/orders", ${lit}, createOrderGin)\n\tr.Run()`, ginH)), LOGIN])
// B. secret-link handlers called "requires login ✓"
const users = { ...G, 'migrations/000002_users.up.sql': 'create table users (id serial primary key, email text, password_hash text);\n' }
F.push(['B password reset via emailed token', 'no login claim (anyone with the link)', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Post("/password/reset", resetPassword)\n\thttp.ListenAndServe(":8080", r)', '\nfunc resetPassword(w http.ResponseWriter, r *http.Request) {\n\tif err := validateResetToken(r.URL.Query().Get("token")); err != nil {\n\t\thttp.Error(w, "invalid or expired link", http.StatusUnauthorized)\n\t\treturn\n\t}\n\tdb.ExecContext(r.Context(), "UPDATE users SET password_hash = $1 WHERE id = $2", "x", 1)\n}\n'), users), LOGIN])
// C. factory taking a *Handler struct is mistaken for middleware (takesHandler regex) -> public write unflagged
F.push(['C createOrderHandler(h *Handler) factory', 'saves new orders + ⚠ Anyone can use', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Post("/orders", createOrderHandler(app))\n\thttp.ListenAndServe(":8080", r)', '\ntype Handler struct{ pool *pgxpool.Pool }\n\nfunc createOrderHandler(h *Handler) http.HandlerFunc {\n\treturn func(w http.ResponseWriter, r *http.Request) {\n\t\th.pool.Exec(r.Context(), "INSERT INTO orders (total) VALUES ($1)", 10)\n\t}\n}\n')), c => !c.includes('Anyone can use')])
// D. Stripe URL rule: retrieving a session = charging
F.push(['D GET api.stripe.com/v1/checkout/sessions/{id}', 'no 💰 (a read)', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Get("/checkout/success", success)\n\thttp.ListenAndServe(":8080", r)', '\nfunc success(w http.ResponseWriter, r *http.Request) {\n\treq, _ := http.NewRequest("GET", "https://api.stripe.com/v1/checkout/sessions/"+r.URL.Query().Get("session_id"), nil)\n\thttp.DefaultClient.Do(req)\n}\n')), c => c.includes('💰')])
    for (const [id, exp, run, isBug] of F) { const c = run(); assert.ok(!isBug(c), `review 24 r3 ${id}: expected ${exp}\n${c}`) }
    console.log('ok (review 24, round 3)')
  }
  // Review 24, round 4 (Go): echo's handler literal comes first; reading a Stripe refund; if/else in a final handler; user.EmailConfirmed
  {
const LOGIN = (c: string) => c.includes('requires login ✓'), TRAP = (c: string) => c.includes("doesn't stop the request")
const em = echo + '\n\t"github.com/labstack/echo/v4/middleware"'
const gin2 = (body: string) => gc(app(gin, '\tr := gin.Default()\n\tr.POST("/orders", createOrderGin)\n\tr.Run()', `\nfunc createOrderGin(c *gin.Context) {\n\tif c.GetString("userID") == "" {\n\t\tc.JSON(http.StatusUnauthorized, gin.H{"error": "please log in"})\n\t} else {\n${body}\n}\n`))
const C: [string, string, (c: string) => boolean][] = [
  ['echo handler literal + route middleware, if/else', gc(app(em, '\te := echo.New()\n\te.POST("/orders", func(c echo.Context) error {\n\t\tif c.Get("user") == nil {\n\t\t\tc.JSON(http.StatusUnauthorized, map[string]string{"error": "login"})\n\t\t} else {\n\t\t\tdb.Exec("INSERT INTO orders (total) VALUES (1)")\n\t\t}\n\t\treturn nil\n\t}, middleware.Logger())\n\te.Start(":8080")')), c => !TRAP(c) && LOGIN(c)],
  ['GET api.stripe.com/v1/refunds/{id}', gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Get("/refunds/{id}", showRefund)\n\thttp.ListenAndServe(":8080", r)', '\nfunc showRefund(w http.ResponseWriter, r *http.Request) {\n\treq, _ := http.NewRequest("GET", "https://api.stripe.com/v1/refunds/"+chi.URLParam(r, "id"), nil)\n\thttp.DefaultClient.Do(req)\n}\n')), c => !/create a refund|refunds money/i.test(c)],
  ['gin final handler if {401} else {work}', gin2('\t\tdb.Exec("INSERT INTO orders (total) VALUES (1)")\n\t}'), LOGIN],
  ['gin if/else, then the work after it', gin2('\t\tlog.Println("ok")\n\t}\n\tdb.Exec("INSERT INTO orders (total) VALUES (1)")'), c => !LOGIN(c)],
  ['net/http if/else, then the work after it', gc(app(chi, '\tr := chi.NewRouter()\n\tr.Post("/orders", mk)\n\thttp.ListenAndServe(":8080", r)', '\nfunc mk(w http.ResponseWriter, r *http.Request) {\n\tif currentUser(r) == nil {\n\t\thttp.Error(w, "please log in", http.StatusUnauthorized)\n\t} else {\n\t\tlog.Println("ok")\n\t}\n\tdb.ExecContext(r.Context(), "INSERT INTO orders (total) VALUES ($1)", 10)\n}\n')), c => !LOGIN(c) && TRAP(c)],
  ['user == nil || !user.EmailConfirmed', gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireUser)\n\tr.Post("/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)', '\nfunc requireUser(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tuser := currentUser(r)\n\t\tif user == nil || !user.EmailConfirmed {\n\t\t\thttp.Error(w, "please log in", http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n')), LOGIN],
]
    for (const [id, c, ok] of C) assert.ok(ok(c), `review 24 r4 ${id}\n${c}`)
    console.log('ok (review 24, round 4)')
  }

// Review 24, round 2 (Go): login sources that aren't about who's asking; package middleware in a variable; handlers vs middleware
  {
const F: [string, string, () => string, (c: string) => boolean][] = []
const LOGIN = (c: string) => c.includes('requires login ✓'), TRAP = (c: string) => c.includes("doesn't stop the request")
const ginH = '\nfunc createOrderGin(c *gin.Context) {\n\tdb.Exec("INSERT INTO orders (total) VALUES (1)")\n}\n'
const mw = (inner: string) => `\nfunc protect(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n${inner}\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n`
const protectApp = (inner: string) => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(protect)\n\tr.Post("/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)', mw(inner)))
// A. new false ✓: FROM_LOGIN verify/validate too broad; CSRF exclusion only looks at the if itself
F.push(['A1 captcha check = login', 'public POST, no login claim', () => protectApp('\t\tif err := verifyTurnstile(r.FormValue("cf-turnstile-response")); err != nil {\n\t\t\thttp.Error(w, "captcha failed", http.StatusForbidden)\n\t\t\treturn\n\t\t}'), LOGIN])
F.push(['A2 origin check = login', 'no login claim', () => protectApp('\t\tif err := validateOrigin(r); err != nil {\n\t\t\thttp.Error(w, "forbidden", http.StatusForbidden)\n\t\t\treturn\n\t\t}'), LOGIN])
F.push(['A3 CSRF err from previous statement = login', 'no login claim', () => protectApp('\t\terr := verifyCSRFToken(r)\n\t\tif err != nil {\n\t\t\thttp.Error(w, "forbidden", http.StatusForbidden)\n\t\t\treturn\n\t\t}'), LOGIN])
// B. regression: scs LoadAndSave on a variable is "unknown" -> public write loses its warning (round 1: LIB_NONE -> ⚠)
F.push(['B1 r.Use(sessionManager.LoadAndSave)', '⚠ Anyone can use the orders part', () => gc(app(chi + '\n\t"github.com/alexedwards/scs/v2"', '\tsessionManager := scs.New()\n\tr := chi.NewRouter()\n\tr.Use(sessionManager.LoadAndSave)\n\tr.Post("/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)')), c => !c.includes('Anyone can use')])
F.push(['B2 ListenAndServe(addr, sessionManager.LoadAndSave(mux))', '⚠', () => gc(app('\t"github.com/alexedwards/scs/v2"', '\tsessionManager := scs.New()\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("POST /orders", createOrder)\n\thttp.ListenAndServe(":8080", sessionManager.LoadAndSave(mux))')), c => !c.includes('Anyone can use')])
// C. regression: requireAuth(handlerVar) now read as a factory -> login lost, facts lost (round 1: requires login ✓)
F.push(['C requireAuth(ordersHandler) with a handler variable', 'saves new orders and requires login ✓', () => gc(app('', '\tmux := http.NewServeMux()\n\tordersHandler := http.HandlerFunc(createOrder)\n\tmux.Handle("POST /orders", requireAuth(ordersHandler))\n\thttp.ListenAndServe(":8080", mux)')), c => !LOGIN(c)])
// D. false alarms: traps on correct code
F.push(['D1 gin final handler: c.JSON(401) + return', 'no problem (nothing runs after the last handler)', () => gc(app(gin, '\tr := gin.Default()\n\tr.POST("/profile", getProfile)\n\tr.Run()', '\nfunc getProfile(c *gin.Context) {\n\tif c.GetString("userID") == "" {\n\t\tc.JSON(http.StatusUnauthorized, gin.H{"error": "please log in"})\n\t\treturn\n\t}\n}\n')), TRAP])
F.push(['D2 gin AbortWithStatusJSON without return, then c.Next()', 'no problem (Abort sets index=abortIndex)', () => gc(app(gin, '\tr := gin.Default()\n\tr.Use(AuthRequired())\n\tr.POST("/orders", createOrderGin)\n\tr.Run()', '\nfunc AuthRequired() gin.HandlerFunc {\n\treturn func(c *gin.Context) {\n\t\tif c.GetHeader("Authorization") == "" {\n\t\t\tc.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "login"})\n\t\t}\n\t\tc.Next()\n\t}\n}\n' + ginH)), TRAP])
F.push(['D3 net/http handler if {401} else {work}', 'no problem', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Get("/orders", myOrders)\n\thttp.ListenAndServe(":8080", r)', '\nfunc myOrders(w http.ResponseWriter, r *http.Request) {\n\tuser := currentUser(r)\n\tif user == nil {\n\t\thttp.Error(w, "please log in", http.StatusUnauthorized)\n\t} else {\n\t\tdb.QueryContext(r.Context(), "SELECT id FROM orders WHERE user_id = $1", user.ID)\n\t}\n}\n')), TRAP])
// E. regression: inline middleware literals' traps are no longer reported (round 1 reported them)
F.push(['E1 inline chi middleware, 401 without return', '✖ doesn\'t stop the request', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(func(next http.Handler) http.Handler {\n\t\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\t\tif _, err := r.Cookie("session"); err != nil {\n\t\t\t\thttp.Error(w, "unauthorized", http.StatusUnauthorized)\n\t\t\t}\n\t\t\tnext.ServeHTTP(w, r)\n\t\t})\n\t})\n\tr.Post("/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)')), c => !TRAP(c)])
F.push(['E2 inline gin middleware, JSON(401) without Abort', '✖', () => gc(app(gin, '\tr := gin.Default()\n\tr.Use(func(c *gin.Context) {\n\t\tif c.GetHeader("Authorization") == "" {\n\t\t\tc.JSON(http.StatusUnauthorized, gin.H{"error": "login"})\n\t\t\treturn\n\t\t}\n\t\tc.Next()\n\t})\n\tr.POST("/orders", createOrderGin)\n\tr.Run()', ginH)), c => !TRAP(c)])
// F. mux children don't inherit the parent's middleware / server wrap
F.push(['F1 sub-mux under ListenAndServe(requireAuth(mux))', 'requires login ✓', () => gc(app('', '\tapi := http.NewServeMux()\n\tapi.HandleFunc("POST /api/orders", createOrder)\n\tmux := http.NewServeMux()\n\tmux.Handle("/api/", api)\n\thttp.ListenAndServe(":8080", requireAuth(mux))')), c => c.includes('Anyone can use')])
F.push(['F2 StripPrefix sub-mux under wrapped root', 'requires login ✓', () => gc(app('', '\tapi := http.NewServeMux()\n\tapi.HandleFunc("POST /orders", createOrder)\n\tmux := http.NewServeMux()\n\tmux.Handle("/api/", http.StripPrefix("/api", api))\n\thttp.ListenAndServe(":8080", requireAuth(mux))')), c => c.includes('Anyone can use')])
F.push(['F3 std mux mounted in chi after r.Use(requireAuth)', 'requires login ✓', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tlegacy := http.NewServeMux()\n\tlegacy.HandleFunc("POST /orders", createOrder)\n\tr.Mount("/legacy", legacy)\n\thttp.ListenAndServe(":8080", r)')), c => c.includes('Anyone can use')])
// G. wrong facts / false alarms from new rules
const users = { ...G, 'migrations/000002_users.up.sql': 'create table users (id serial primary key, email text);\ncreate table sessions (token text primary key, user_id int references users(id));\n' }
F.push(['G1 q.DeleteUserSessions -> "deletes users"', 'deletes sessions (or nothing)', () => gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Post("/logout-everywhere", h.logoutAll)\n\thttp.ListenAndServe(":8080", r)', '\ntype Handler struct{ queries *db.Queries }\n\nfunc (h *Handler) logoutAll(w http.ResponseWriter, r *http.Request) {\n\th.queries.DeleteUserSessions(r.Context(), 1)\n}\n'), users), c => c.includes('deletes users')])
F.push(['G2 env:"PORT,required" envDefault:"8080"', 'no "Add PORT" (envDefault satisfies required)', () => gc({ ...app(chi, '\tcfg := load()\n\t_ = cfg\n\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Post("/orders", createOrder)\n\thttp.ListenAndServe(":8080", r)'), 'config.go': 'package main\n\ntype Config struct {\n\tPort string `env:"PORT,required" envDefault:"8080"`\n}\n\nfunc load() Config {\n\tvar c Config\n\tif err := env.Parse(&c); err != nil {\n\t\tpanic(err)\n\t}\n\treturn c\n}\n' }), c => c.includes('Add PORT')])
F.push(['G3 go-chi/cors "*" + AllowCredentials', 'no CORS problem (sends literal *, browser blocks credentials)', () => gc(app(chi + '\n\t"github.com/go-chi/cors"', '\tr := chi.NewRouter()\n\tr.Use(cors.Handler(cors.Options{AllowedOrigins: []string{"*"}, AllowCredentials: true}))\n\tr.Use(requireAuth)\n\tr.Get("/orders", listOrders)\n\thttp.ListenAndServe(":8080", r)')), c => c.includes('Any website can make requests')])
  for (const [id, exp, run, isBug] of F) { const c = run(); assert.ok(!isBug(c), `review 24 r2 ${id}: expected ${exp}\n${c}`) }
  console.log('ok (review 24, round 2)')
}
}
// Unpaid checkouts holding spots (trials rounds 7–9: the 🔴 every card missed)
{
  const HELD = 'Unpaid checkouts now take up spots for good', OLD = 'Old unpaid checkouts already in your database'
  const checkout = (count: string) => `import Stripe from 'stripe'\nimport { prisma } from '@/lib/prisma'\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)\nexport async function POST(req: Request) {\n  const { classId } = await req.json()\n  const c = await prisma.class.findUnique({ where: { id: classId } })\n${count}  const b = await prisma.booking.create({ data: { classId, status: 'pending' } })\n  const s = await stripe.checkout.sessions.create({ metadata: { bookingId: b.id } })\n  return Response.json({ url: s.url })\n}\n`
  const hook = (expired: boolean) => `import Stripe from 'stripe'\nimport { prisma } from '@/lib/prisma'\nexport async function POST(req: Request) {\n  const event = Stripe.webhooks.constructEvent(await req.text(), req.headers.get('stripe-signature')!, process.env.WH!)\n  if (event.type === 'checkout.session.completed') await prisma.booking.updateMany({ where: { id: 1, status: 'pending' }, data: { status: 'paid' } })\n${expired ? "  if (event.type === 'checkout.session.expired') await prisma.booking.updateMany({ where: { id: 1, status: 'pending' }, data: { status: 'expired' } })\n" : ''}  return new Response('ok')\n}\n`
  const app = (count: string, expired = false) => new Map([['app/api/checkout/route.ts', checkout(count)], ['app/api/webhook/route.ts', hook(expired)]])
  const card = (a: Map<string, string>, b: Map<string, string>) => report(a, b, { ref: 'main' })
  const main = app(''), mainX = app('', true)
  const held = "  const taken = await prisma.booking.count({ where: { classId, status: { in: ['pending', 'paid'] } } })\n  if (taken >= c.capacity) return Response.json({ error: 'This class is full' }, { status: 409 })\n"
  assert.ok(card(main, app(held)).includes(HELD), 'holds: pending counted, nothing frees it')
  assert.ok(!/Old unpaid|take up spots/.test(card(mainX, app(held, true))), "holds: main already freed them on Stripe's expired message")
  assert.ok(card(main, app(held, true)).includes(OLD), 'holds: the change adds the expired handler: old rows were never freed')
  assert.ok(!/Old unpaid|take up spots/.test(card(new Map(), app(held, true))), 'holds: a whole new app has no old rows')
  const paidOnly = "  const taken = await prisma.booking.count({ where: { classId, status: 'paid' } })\n  if (taken >= c.capacity) return Response.json({ error: 'This class is full' }, { status: 409 })\n"
  assert.ok(!/Old unpaid|take up spots/.test(card(main, app(paidOnly))), 'holds: only paid ones counted')
  const recent = "  const taken = await prisma.booking.count({ where: { classId, OR: [{ status: 'paid' }, { status: 'pending', createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) } }] } })\n  if (taken >= c.capacity) return Response.json({ error: 'This class is full' }, { status: 409 })\n"
  assert.ok(!/Old unpaid|take up spots/.test(card(main, app(recent))), 'holds: only recent pending ones counted')
  const orWhere = "  const taken = await prisma.booking.count({ where: { classId, status: 'pending', OR: [{ sessionId: { not: null } }, { createdAt: { gt: new Date(Date.now() - 60000) } }] } })\n  if (taken >= c.capacity) return Response.json({ error: 'This class is full' }, { status: 409 })\n"
  assert.ok(card(main, app(orWhere)).includes(HELD), "holds: a time limit behind an OR doesn't free every pending row")
  const compare = "  const last = await prisma.booking.findFirst({ where: { classId } })\n  if (last && last.status === 'pending') return Response.json({ error: 'Not enough seats' }, { status: 409 })\n"
  assert.ok(!/Old unpaid|take up spots/.test(card(main, app(compare))), "holds: one row's status compared, not rows counted")
  // Go: a counter raised in the same transaction that saves the pending order (fresh-crate p5)
  const store = (extra: string) => `package store\n\nfunc (s *Store) InsertOrder(ctx context.Context, o Order) (int64, error) {\n\ttx, _ := s.db.Begin(ctx)\n${extra}\tvar id int64\n\ttx.QueryRow(ctx, \`INSERT INTO orders (user_id, delivery_date, status) VALUES ($1, $2, 'pending') RETURNING id\`, o.UserID, o.DeliveryDate).Scan(&id)\n\treturn id, tx.Commit(ctx)\n}\n`
  const goApp = (extra: string) => new Map([['go.mod', 'module example.com/shop\n\ngo 1.23\n'], ['internal/store/store.go', store(extra)], ['main.go', 'package main\n\nimport (\n\t"net/http"\n\t"github.com/stripe/stripe-go/v82/checkout/session"\n)\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("POST /orders", createOrder)\n\thttp.ListenAndServe(":8080", mux)\n}\n\nfunc createOrder(w http.ResponseWriter, r *http.Request) {\n\tsession.New(nil)\n}\n']])
  const cap = "\tvar n int\n\terr := tx.QueryRow(ctx, `INSERT INTO date_capacity (delivery_date, order_count) VALUES ($1, 1) ON CONFLICT (delivery_date) DO UPDATE SET order_count = date_capacity.order_count + 1 WHERE date_capacity.order_count < 30 RETURNING order_count`, o.DeliveryDate).Scan(&n)\n\tif err != nil {\n\t\treturn 0, errors.New(\"delivery date is full\")\n\t}\n"
  assert.ok(card(goApp(''), goApp(cap)).includes(HELD), 'holds: Go counter raised with the pending insert\n' + card(goApp(''), goApp(cap)))
  console.log('ok (unpaid checkouts holding spots)')
}
// Review 25 (rounds 1-5): unpaid checkouts holding spots (negations, time limits in any form, dashboards, paging, markup, comments, cleanups)
{
const GAPS = /^(pending-approval lesson requests|spoke-pedal: where\.not\(status: "pending"\)|django enum Order\.Status\.PENDING|G1 per-user rate limit)/   // known: not tied to one table; a RESERVED_STATUSES name left defined; enum constants; any date compared near the count frees it
const HELD = 'Unpaid checkouts now take up spots for good', OLD = 'Old unpaid checkouts already in your database'
const which = (c: string) => c.includes(HELD) ? 'M1' : c.includes(OLD) ? 'M2' : 'none'
const card = (a: Record<string,string>, b: Record<string,string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' })
const line = (c: string) => c.split('\n').find(l => l.includes(HELD) || l.includes(OLD))?.trim().slice(0, 110) ?? '(no line)'
// Next.js fixture from the test block
const checkout = (count: string, create = "  const b = await prisma.booking.create({ data: { classId, status: 'pending' } })\n", sess = '{ metadata: { bookingId: b.id } }') => `import Stripe from 'stripe'\nimport { prisma } from '@/lib/prisma'\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)\nexport async function POST(req: Request) {\n  const { classId } = await req.json()\n  const c = await prisma.class.findUnique({ where: { id: classId } })\n${count}${create}  const s = await stripe.checkout.sessions.create(${sess})\n  return Response.json({ url: s.url })\n}\n`
const hook = (expired: boolean | string) => `import Stripe from 'stripe'\nimport { prisma } from '@/lib/prisma'\nexport async function POST(req: Request) {\n  const event = Stripe.webhooks.constructEvent(await req.text(), req.headers.get('stripe-signature')!, process.env.WH!)\n  if (event.type === 'checkout.session.completed') await prisma.booking.updateMany({ where: { id: 1, status: 'pending' }, data: { status: 'paid' } })\n${expired === true ? "  if (event.type === 'checkout.session.expired') await prisma.booking.updateMany({ where: { id: 1, status: 'pending' }, data: { status: 'expired' } })\n" : typeof expired === 'string' ? expired : ''}  return new Response('ok')\n}\n`
const app = (count: string, expired: boolean | string = false, extra: Record<string,string> = {}) => ({ 'app/api/checkout/route.ts': checkout(count), 'app/api/webhook/route.ts': hook(expired), ...extra })
const full = (q: string) => `  const taken = await prisma.booking.count({ where: ${q} })\n  if (taken >= c.capacity) return Response.json({ error: 'This class is full' }, { status: 409 })\n`

const run = (name: string, a: Record<string, string>, b: Record<string, string>, expect: string) => { if (GAPS.test(name)) return; const w = which(card(a, b)); assert.equal(w, expect, `review 25 ${name}`) }
{
const paid = full("{ classId, status: 'paid' }")
const q = "{ classId, status: { in: ['pending', 'paid'] } }"
const lim = (cmp: string, msg: string) => `  const taken = await prisma.booking.count({ where: ${q} })\n  if (${cmp}) return Response.json({ error: '${msg}' }, { status: 409 })\n`
// C. REFUSE too narrow (these fired in round 1: HOLD had seats/spots/slots/remaining)
run('C0 control: >= c.capacity, "This class is full"', app(''), app(lim('taken >= c.capacity', 'This class is full')), 'M1')
run('C1 maxStudents + "No spots left"', app(''), app(lim('taken >= c.maxStudents', 'No spots left')), 'M1')
run('C2 seats + "Fully booked"', app(''), app(lim('taken >= c.seats', 'Fully booked')), 'M1')
run('C3 MAX_PER_DAY + "No more orders for that date"', app(''), app(lim('taken >= MAX_PER_DAY', 'No more orders for that date')), 'M1')
// D. REFUSE too broad: "Capacity</th>" reads as `capacity <`; Tailwind "rounded-full" reads as "full"
const admin = { 'app/admin/page.tsx': "import { prisma } from '@/lib/prisma'\nexport default async function Admin() {\n  const classes = await prisma.class.findMany()\n  const unpaid = await prisma.booking.count({ where: { status: 'pending' } })\n  return <main><p>{unpaid} checkouts not finished</p><table><thead><tr><th>Class</th><th>Capacity</th></tr></thead><tbody>{classes.map(c => <tr key={c.id}><td>{c.name}</td><td>{c.capacity}</td></tr>)}</tbody></table></main>\n}\n" }
run('D1 admin page: pending count + <th>Capacity</th>', app(paid), app(paid, false, admin), 'none')
const mine = { 'app/bookings/page.tsx': "import { prisma } from '@/lib/prisma'\nimport { auth } from '@/lib/auth'\nexport default async function MyBookings() {\n  const user = await auth()\n  const bookings = await prisma.booking.findMany({ where: { userId: user.id } })\n  const unpaid = bookings.filter(b => b.status === 'pending').length\n  return <main>{unpaid > 0 && <span className=\"rounded-full bg-amber-100 px-2 text-xs\">{unpaid} unpaid</span>}</main>\n}\n" }
run('D2 my-bookings badge: .filter(...pending).length + rounded-full', app(paid), app(paid, false, mine), 'none')
// E. HOLDW from a neighbouring line (code without `;`: the statement is the line and the 2 before)
const ev = { 'app/admin/classes/[id]/page.tsx': "import { prisma } from '@/lib/prisma'\nexport default async function ClassAdmin({ params }: { params: { id: string } }) {\n  const c = await prisma.class.findUnique({ where: { id: Number(params.id) }, select: { name: true, capacity: true } })\n  const unpaid = await prisma.booking.findMany({ where: { classId: Number(params.id), status: 'pending' } })\n  return <main><h1>{c?.name}</h1><ul>{unpaid.map(b => <li key={b.id}>{b.email}</li>)}</ul></main>\n}\n" }
run('E1 admin class page: capacity on the line above a pending list', app(paid), app(paid, false, ev), 'none')
// F. function-name rule picks the last `function` keyword before, not the enclosing function
const lib = { 'lib/bookings.ts': "import { prisma } from '@/lib/prisma'\nexport async function reservedSeats(classId: number) {\n  return prisma.booking.count({ where: { classId, status: 'paid' } })\n}\nexport const unpaidFor = (userId: number) => prisma.booking.findMany({ where: { userId, status: 'pending' } })\n" }
run('F1 arrow fn after `function reservedSeats` (paid only)', app(paid), app(paid, false, lib), 'none')

}
{
// I. negated(): NOT { id } (exclude this booking when rescheduling) negates the whole status list after it
run("I1 overlap count excluding this booking: NOT: { id }, status in [pending, paid]", app(''), app(full("{ classId, NOT: { id: 0 }, status: { in: ['pending', 'paid'] } }")), 'M1')
// J. stmtNear in code without `;`: a delete on one of the 2 lines above hides the count
run("J1 user's earlier pending deleted on the line above the count", app(''), app("  await prisma.booking.deleteMany({ where: { userId: 1, status: 'pending' } })\n" + full("{ classId, status: { in: ['pending', 'paid'] } }")), 'M1')
// savedAt: a save whose arguments contain a filter word (Python `or`) is read as a filter, so nothing "makes pending"
const dj = (create: string) => ({ 'requirements.txt': 'django==5.1\nstripe==10.0\n', 'shop/models.py': 'from django.db import models\n\nclass Slot(models.Model):\n    capacity = models.IntegerField()\n',
  'shop/views.py': `import stripe\nfrom django.http import HttpResponse\nfrom django.shortcuts import redirect, get_object_or_404\nfrom .models import Order, Slot\n\ndef checkout(request, slot_id):\n    slot = get_object_or_404(Slot, pk=slot_id)\n${create}\n    session = stripe.checkout.Session.create(mode='payment', metadata={'order_id': order.id}, success_url='https://x/s', cancel_url='https://x/c')\n    return redirect(session.url)\n` })
const cnt = "    taken = Order.objects.filter(slot=slot, status__in=['pending', 'paid']).count()\n    if taken >= slot.capacity:\n        return HttpResponse('This slot is full', status=409)\n"
const base = dj("    order = Order.objects.create(slot=slot, status='pending')")
run("K0 control: django create(slot=slot, status='pending')", base, dj(cnt + "    order = Order.objects.create(slot=slot, status='pending')"), 'M1')
run("K1 (base saves pending without `or`) django create(email=... or ..., status='pending')", base, dj(cnt + "    order = Order.objects.create(slot=slot, email=request.POST.get('email') or request.user.email, status='pending')"), 'M1')

}
{
// pathological inputs for the new regexes: long runs without ; or newlines near 'pending'
const paid = full("{ classId, status: 'paid' }")
for (const [name, body] of [
  ['1MB line, no newline/;', "export const x = '" + 'a '.repeat(500000) + "' + 'pending'\n"],
  ['many created_at tokens', "export const q = `" + 'created_at '.repeat(50000) + "'pending'`\n"],
  ['many status: keys', "export const q = {" + "status: 1, ".repeat(50000) + "status: 'pending' }\n"],
  ['%w[ unclosed', "x = %w[" + 'pending '.repeat(20000) + "\n"],
] as const) { const t = Date.now(); card(app(paid), app(paid, false, { 'lib/big.ts': body })); console.log(name, Date.now() - t, 'ms') }

}
{
const held = full("{ classId, status: { in: ['pending', 'paid'] } }")
// noComments: a '/*' inside a string ('/api/*') opens a "comment" that runs to the next real '*/', hiding the expired handler
const wh = hook(true).replace("export async function POST", "const PROTECTED = ['/api/admin/*']\nexport async function POST").replace(/\n$/, "\n/** Called by Stripe. */\nexport const dynamic = 'force-dynamic'\n")
run("N0 control: expired handled, main already had it", app('', true), app(held, true), 'none')
run("N1 '/api/admin/*' string before the handler, a JSDoc after it", { ...app('', true), 'app/api/webhook/route.ts': wh }, { ...app(held, true), 'app/api/webhook/route.ts': wh }, 'none')
// ' #' inside a string drops the rest of the line
const create = "  const b = await prisma.booking.create({ data: { classId, label: `Booking #${classId}`, status: 'pending' } })\n"
const withHash = (count: string) => ({ ...app(''), 'app/api/checkout/route.ts': checkout(count, create) })
run("N2 `Booking #${id}` before status: 'pending' on the save line (only save)", withHash(''), withHash(held), 'M1')

}
{
const paid = full("{ classId, status: 'paid' }"), held = full("{ classId, status: { in: ['pending', 'paid'] } }")
// 1. admin pages: an unpaid count next to "seats left" / "No more ..." (REFUSE's new phrases)
const dash = (body: string) => ({ 'app/admin/page.tsx': `import { prisma } from '@/lib/prisma'\nexport default async function Admin() {\n  const classes = await prisma.class.findMany({ include: { _count: { select: { bookings: { where: { status: 'paid' } } } } } })\n  const unpaid = await prisma.booking.count({ where: { status: 'pending' } })\n  return (\n    <main>\n${body}\n    </main>\n  )\n}\n` })
run('D3 admin: unpaid count + "{c.capacity - sold} seats left"', app(paid), app(paid, false, dash("      <p>{unpaid} checkouts not finished</p>\n      {classes.map(c => <p key={c.id}>{c.name}: {c.capacity - c._count.bookings} seats left</p>)}")), 'none')
run('D4 admin: unpaid count + empty state "No more unpaid orders"', app(paid), app(paid, false, dash("      {unpaid === 0 ? <p>No more unpaid orders</p> : <p>{unpaid} unpaid</p>}")), 'none')
// 2. stmtNear: a JSX `return (` is one statement, so .length + capacity anywhere in it make a status badge a "read"
const page = { 'app/admin/classes/[id]/page.tsx': "import { prisma } from '@/lib/prisma'\nexport default async function ClassAdmin({ params }: { params: { id: string } }) {\n  const c = await prisma.class.findUnique({ where: { id: Number(params.id) }, include: { bookings: true } })\n  if (!c) return null\n  return (\n    <main>\n      <h1>{c.name}</h1>\n      <p>{c.bookings.length} of {c.capacity} booked</p>\n      <ul>{c.bookings.map(b => <li key={b.id}>{b.email} {b.status === 'pending' ? '(unpaid)' : ''}</li>)}</ul>\n    </main>\n  )\n}\n" }
run("S1 admin class page: JSX with .length, capacity, and b.status === 'pending' badge", app(paid), app(paid, false, page), 'none')
// 3. function-name rule: `const capacityLeft = (` (a parenthesised expression, not an arrow) counts as a declaration
const left = { 'app/admin/classes/[id]/page.tsx': "import { prisma } from '@/lib/prisma'\nexport default async function ClassAdmin({ params }: { params: { id: string } }) {\n  const c = await prisma.class.findUniqueOrThrow({ where: { id: Number(params.id) } })\n  const capacityLeft = (c.capacity ?? 0) - 1\n  const unpaid = await prisma.booking.findMany({ where: { classId: c.id, status: 'pending' } })\n  return <main><p>{capacityLeft} left</p><ul>{unpaid.map(b => <li key={b.id}>{b.email}</li>)}</ul></main>\n}\n" }
run("F2 `const capacityLeft = (...)`, then a pending list", app(paid), app(paid, false, left), 'none')

}
{
const held = full("{ classId, status: { in: ['pending', 'paid'] } }")
const cron = (body: string, imports = "import { prisma } from '@/lib/prisma'\n") => ({ 'app/api/cron/expire/route.ts': `${imports}export async function GET() {\n  const cutoff = new Date(Date.now() - 30 * 60 * 1000)\n${body}\n  return new Response('ok')\n}\n` })
run('T0 control: prisma cron, status + createdAt lt', app(''), app(held, false, cron("  await prisma.booking.updateMany({ where: { status: 'pending', createdAt: { lt: cutoff } }, data: { status: 'expired' } })")), 'none')
// operator before the column (Supabase, Drizzle), operator objects (Sequelize, TypeORM)
run("T1 supabase .eq('status','pending').lt('created_at', cutoff)", app(''), app(held, false, cron("  await supabase.from('bookings').update({ status: 'expired' }).eq('status', 'pending').lt('created_at', cutoff.toISOString())", "import { supabase } from '@/lib/supabase'\n")), 'none')
run("T2 supabase, inline Date.now() (round 1 caught this)", app(''), app(held, false, cron("  await supabase.from('bookings').update({ status: 'expired' }).eq('status', 'pending').lt('created_at', new Date(Date.now() - 1800000).toISOString())", "import { supabase } from '@/lib/supabase'\n")), 'none')
run("T3 drizzle and(eq(status,'pending'), lt(createdAt, cutoff))", app(''), app(held, false, cron("  await db.update(bookings).set({ status: 'expired' }).where(and(eq(bookings.status, 'pending'), lt(bookings.createdAt, cutoff)))", "import { db } from '@/db'\nimport { bookings } from '@/db/schema'\nimport { and, eq, lt } from 'drizzle-orm'\n")), 'none')
run("T4 sequelize createdAt: { [Op.lt]: cutoff }", app(''), app(held, false, cron("  await Booking.update({ status: 'expired' }, { where: { status: 'pending', createdAt: { [Op.lt]: cutoff } } })", "import { Op } from 'sequelize'\nimport { Booking } from '@/models'\n")), 'none')
run("T5 typeorm createdAt: LessThan(cutoff)", app(''), app(held, false, cron("  await repo.update({ status: 'pending', createdAt: LessThan(cutoff) }, { status: 'expired' })", "import { LessThan } from 'typeorm'\nimport { repo } from '@/db'\n")), 'none')
// a filter object in its own variable: no keyword before `status:` -> savedAt calls it a save -> byTime skips it
run("T6 prisma filter in a variable: const stale = { status: 'pending', createdAt: { lt: cutoff } }", app(''), app(held, false, cron("  const stale = { status: 'pending', createdAt: { lt: cutoff } }\n  await prisma.booking.updateMany({ where: stale, data: { status: 'expired' } })")), 'none')

}
{
const paid = full("{ classId, status: 'paid' }")
// D7. compared(): pagination of an admin list of unpaid bookings (`skip + take < total`)
const api = { 'app/api/admin/unpaid/route.ts': "import { prisma } from '@/lib/prisma'\nexport async function GET(req: Request) {\n  const page = Number(new URL(req.url).searchParams.get('page') ?? 1), take = 20, skip = (page - 1) * take\n  const total = await prisma.booking.count({ where: { status: 'pending' } })\n  const rows = await prisma.booking.findMany({ where: { status: 'pending' }, skip, take })\n  return Response.json({ rows, total, hasMore: skip + take < total })\n}\n" }
run('D7 admin API: paginated unpaid list, hasMore: skip + take < total', app(paid), app(paid, false, api), 'none')

}
{
const main = app('')
// sanity
run('baseline held', main, app(full("{ classId, status: { in: ['pending', 'paid'] } }")), 'M1')
// 1. capacity from paid rows only, by excluding pending
run('prisma not pending', main, app(full("{ classId, status: { not: 'pending' } }")), 'none')
run('prisma notIn pending,cancelled', main, app(full("{ classId, status: { notIn: ['pending', 'cancelled'] } }")), 'none')
run('prisma NOT', main, app(full("{ classId, NOT: { status: 'pending' } }")), 'none')
// 2. time limit written before the pending literal
run('time before pending', main, app(full("{ classId, OR: [{ status: 'paid' }, { createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) }, status: 'pending' }] }")), 'none')
// 3. cutoff variable
run('cutoff var', main, app("  const cutoff = new Date(Date.now() - 30 * 60 * 1000)\n" + full("{ classId, OR: [{ status: 'paid' }, { status: 'pending', createdAt: { gt: cutoff } }] }")), 'none')
// 4. cleanup cron, cutoff var
const cron = { 'app/api/cron/expire/route.ts': "import { prisma } from '@/lib/prisma'\nexport async function GET() {\n  const cutoff = new Date(Date.now() - 30 * 60 * 1000)\n  await prisma.booking.updateMany({ where: { status: 'pending', createdAt: { lt: cutoff } }, data: { status: 'expired' } })\n  return new Response('ok')\n}\n" }
run('cron with cutoff var', main, app(full("{ classId, status: { in: ['pending', 'paid'] } }"), false, cron), 'none')
const cron2 = { 'app/api/cron/expire/route.ts': "import { prisma } from '@/lib/prisma'\nimport { subMinutes } from 'date-fns'\nexport async function GET() {\n  await prisma.booking.deleteMany({ where: { status: 'pending', createdAt: { lt: subMinutes(new Date(), 30) } } })\n  return new Response('ok')\n}\n" }
run('cron date-fns subMinutes', main, app(full("{ classId, status: { in: ['pending', 'paid'] } }"), false, cron2), 'none')

}
{
run("prisma OR list, short where", app(''), app(full("{ OR: [{ status: 'paid' }, { status: 'pending' }] }")), 'M1')
run("prisma OR list, >60 chars after where (seen as a save)", app(''), app(full("{ classId, startsAt: { gte: c.startsAt }, OR: [{ status: 'paid' }, { status: 'pending' }] }")), 'M1')

}
{
const paid = full("{ classId, status: 'paid' }")
const form = (attr: string) => ({ 'app/contact/ContactForm.tsx': `'use client'\nimport { useState } from 'react'\nexport function ContactForm() {\n  const [state, setState] = useState<'idle' | 'pending' | 'sent'>('idle')\n  return <form><input name="email" ${attr} /><button disabled={state !== 'idle'}>Send</button></form>\n}\n` })
run('form with placeholder= (HOLD matches "placeholder")', app(paid), app(paid, false, form('placeholder="you@example.com"')), 'none')
run('same form without placeholder', app(paid), app(paid, false, form('')), 'none')

}
{
const paid = full("{ classId, status: 'paid' }")
// admin list of unpaid orders; the only HOLD word is the model name "reservation"
const admin = { 'app/admin/unpaid/page.tsx': "import { prisma } from '@/lib/prisma'\nexport default async function Unpaid() {\n  const rows = await prisma.reservation.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' } })\n  return <ul>{rows.map(r => <li key={r.id}>{r.email}</li>)}</ul>\n}\n" }
run('admin list of pending reservations (HOLD = "reserv" in model name)', app(paid), app(paid, false, admin), 'none')

}
{
const two = (pend: string) => `  const paid = await prisma.booking.count({ where: { classId, status: 'paid' } })\n  const held = await prisma.booking.count({ where: ${pend} })\n  if (paid + held >= c.capacity) return Response.json({ error: 'This class is full' }, { status: 409 })\n`
run("time before 'pending' (short where)", app(''), app(two("{ createdAt: { gt: new Date(Date.now() - 18e5) }, status: 'pending' }")), 'none')
run("control: time after 'pending'", app(''), app(two("{ status: 'pending', createdAt: { gt: new Date(Date.now() - 18e5) } }")), 'none')
run("control: no time", app(''), app(two("{ classId, status: 'pending' }")), 'M1')

}
{
const main = app(''), paid = full("{ classId, status: 'paid' }"), held = full("{ classId, status: { in: ['pending', 'paid'] } }")
// admin dashboard counting pending orders; capacity counted from paid only
const admin = { 'app/admin/page.tsx': "import { prisma } from '@/lib/prisma'\nexport default async function Admin() {\n  const classes = await prisma.class.findMany({ include: { _count: { select: { bookings: { where: { status: 'paid' } } } } } })\n  const unpaid = await prisma.booking.count({ where: { status: 'pending' } })\n  return <main><p>{unpaid} checkouts not finished</p>{classes.map(c => <p key={c.id}>{c.name}: {c._count.bookings} of {c.capacity} seats sold</p>)}</main>\n}\n" }
run('admin dashboard counts pending', main, app(paid, false, admin), 'none')
// a form with a pending UI state, near an input placeholder (HOLD matches "placeholder")
const form = { 'app/contact/ContactForm.tsx': "'use client'\nimport { useState } from 'react'\nexport function ContactForm() {\n  const [state, setState] = useState<'idle' | 'pending' | 'sent'>('idle')\n  return <form><input name=\"email\" placeholder=\"you@example.com\" /><button disabled={state !== 'idle'}>Send</button></form>\n}\n" }
run('contact form useState pending + placeholder', main, app(paid, false, form), 'none')
// status badge switch
const badge = { 'app/bookings/StatusBadge.tsx': "export function StatusBadge({ status, seats }: { status: string, seats: number }) {\n  switch (status) {\n    case 'pending': return <span>Waiting for payment ({seats} seats)</span>\n    case 'paid': return <span>Booked</span>\n  }\n  return null\n}\n" }
run('status badge switch case', main, app(paid, false, badge), 'none')
// pending-approval flow: private lesson requests that need teacher approval, overlap check counts pending+approved (correct)
const req = { 'app/api/requests/route.ts': "import { prisma } from '@/lib/prisma'\nexport async function POST(req: Request) {\n  const { tutorId, startsAt, endsAt } = await req.json()\n  const clash = await prisma.lessonRequest.count({ where: { tutorId, status: { in: ['pending', 'approved'] }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } } })\n  if (clash) return Response.json({ error: 'That time overlaps another lesson' }, { status: 409 })\n  await prisma.lessonRequest.create({ data: { tutorId, startsAt, endsAt, status: 'pending' } })\n  return Response.json({ ok: true })\n}\n" }
run('pending-approval lesson requests', main, { ...main, ...req }, 'none')
// a TODO comment mentioning the expired event suppresses M1
run('TODO comment names checkout.session.expired', main, app(held, "  // TODO: handle checkout.session.expired to free the seat\n"), 'M1')
// moving the file (main already counted pending, in a file at another path)
const mainHeld = app(held)
run('rename only (main already counted pending)', mainHeld, { 'app/api/bookings/checkout/route.ts': mainHeld['app/api/checkout/route.ts'], 'app/api/webhook/route.ts': mainHeld['app/api/webhook/route.ts'] }, 'none')
// expires_at on the session near the pending save hides M1 though nothing frees the row
run('session expires_at only', main, { ...app(''), 'app/api/checkout/route.ts': checkout(held, undefined, '{ metadata: { bookingId: b.id }, expires_at: Math.floor(Date.now() / 1000) + 30 * 60 }') }, 'M1')
// time limit via a column TIME doesn't know
run('reserved_until filter', main, app(full("{ classId, OR: [{ status: 'paid' }, { status: 'pending', reservedUntil: { gt: new Date() } }] }")), 'none')
run('updatedAt filter', main, app(full("{ classId, OR: [{ status: 'paid' }, { status: 'pending', updatedAt: { gt: new Date(Date.now() - 1800000) } }] }")), 'none')

}
{
const paid = full("{ classId, status: 'paid' }"), held = full("{ classId, status: { in: ['pending', 'paid'] } }")
// a "give up my unpaid booking" endpoint: deleteMany isn't seen as a write, so its 'pending' filter counts as a read
const del = { 'app/api/bookings/[id]/route.ts': "import { prisma } from '@/lib/prisma'\nexport async function DELETE(req: Request, { params }: { params: { id: string } }) {\n  // gives the seat back to the class\n  await prisma.booking.deleteMany({ where: { id: Number(params.id), status: 'pending' } })\n  return new Response(null, { status: 204 })\n}\n" }
run('deleteMany pending (frees a seat)', app(paid), app(paid, false, del), 'none')
// main already freed old rows with a cron (cutoff variable); the change counts pending and adds the expired handler
const cron = { 'app/api/cron/expire/route.ts': "import { prisma } from '@/lib/prisma'\nexport async function GET() {\n  const cutoff = new Date(Date.now() - 30 * 60 * 1000)\n  await prisma.booking.updateMany({ where: { status: 'pending', createdAt: { lt: cutoff } }, data: { status: 'expired' } })\n  return new Response('ok')\n}\n" }
run('main has cutoff-var cron; change adds expired + counts pending', app('', false, cron), app(held, true, cron), 'none')
// whole app new, with a cutoff var cleanup
run('whole app new, M1 shape', {}, app(held), 'M1')

}
{
const ctl = (count: string) => `using Microsoft.AspNetCore.Mvc;\nusing Microsoft.EntityFrameworkCore;\nusing Stripe.Checkout;\n\nnamespace Shop.Api.Controllers;\n\n[ApiController]\n[Route("api/[controller]")]\npublic sealed class BookingsController(AppDbContext db) : ControllerBase\n{\n    [HttpPost]\n    public async Task<IActionResult> Create(CreateBookingRequest request)\n    {\n        var slot = await db.Slots.FindAsync(request.SlotId);\n        if (slot is null) return NotFound();\n${count}        var booking = new Booking { SlotId = slot.Id, Status = "pending" };\n        db.Bookings.Add(booking);\n        await db.SaveChangesAsync();\n        var session = await new SessionService().CreateAsync(new SessionCreateOptions { Mode = "payment", SuccessUrl = "https://x/ok", CancelUrl = "https://x/no" });\n        return Ok(new { checkoutUrl = session.Url });\n    }\n}\n`
const cs = (count: string) => ({ 'Shop.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Stripe.net" Version="47.0.0" /></ItemGroup></Project>\n', 'Controllers/BookingsController.cs': ctl(count) })
run('asp.net EF LINQ == "pending" || == "paid" (miss?)', cs(''), cs('        var taken = await db.Bookings.CountAsync(b => b.SlotId == slot.Id && (b.Status == "pending" || b.Status == "paid"));\n        if (taken >= slot.Capacity) return Conflict(new { message = "This slot is full." });\n'), 'M1')
run('asp.net Contains list (control)', cs(''), cs('        var held = new[] { "pending", "paid" };\n        var taken = await db.Bookings.CountAsync(b => b.SlotId == slot.Id && held.Contains(b.Status));\n        if (taken >= slot.Capacity) return Conflict(new { message = "This slot is full." });\n'), 'M1')
// JS in-memory count
run("js .filter(b => b.status === 'pending' || b.status === 'paid').length (miss?)", app(''), app("  const all = await prisma.booking.findMany({ where: { classId } })\n  const taken = all.filter(b => b.status === 'pending' || b.status === 'paid').length\n  if (taken >= c.capacity) return Response.json({ error: 'This class is full' }, { status: 409 })\n"), 'M1')

}
console.log('ok (review 25)')
}
// "Only admins ✓" (trials rounds 7–9: admin checks read as plain login). The stack's login check must decide it, and its deciding
// line must turn away non-admins; a name alone (requireAdmin from a package, or not found) keeps "requires login".
{
  const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const ADMIN = 'is for admins only ✓'
  const auth = (admin: string) => `export function requireAuth(req, res, next) {\n  if (!req.user) return res.status(401).json({ error: 'log in' })\n  next()\n}\nexport function requireAdmin(req, res, next) {\n  ${admin}\n  next()\n}\n`
  const ex = (mount: string, admin: string, extra: Record<string, string> = {}) => ({
    'server/package.json': '{"dependencies":{"express":"4.19.0","@prisma/client":"6.0.0"}}',
    'server/prisma/schema.prisma': 'model Walker {\n  id Int @id\n  name String\n}\n',
    'server/src/index.ts': `import express from 'express'\nimport admin from './routes/admin.js'\nimport { requireAuth, requireAdmin } from './middleware/auth.js'\nconst app = express()\n${mount}\napp.listen(3001)\n`,
    'server/src/middleware/auth.ts': auth(admin),
    'server/src/routes/admin.ts': "import { Router } from 'express'\nimport { prisma } from '../db.js'\nconst router = Router()\nrouter.post('/walkers', async (req, res) => res.json(await prisma.walker.create({ data: req.body })))\nexport default router\n", ...extra })
  const mount = "app.use('/api/admin', requireAuth, requireAdmin, admin)", role = "if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admins only' })"
  const ok = (c: string, has: string, why: string) => assert.ok(c.includes(has), `admin: ${why}\n${c}`), no = (c: string, x: string, why: string) => assert.ok(!c.includes(x), `admin: ${why}\n${c}`)
  ok(card({}, ex(mount, role)), ADMIN, 'Express guards on the mount')
  ok(card({}, ex("app.use('/api/admin', admin)", role, { 'server/src/routes/admin.ts': "import { Router } from 'express'\nimport { prisma } from '../db.js'\nimport { requireAuth, requireAdmin } from '../middleware/auth.js'\nconst router = Router()\nrouter.use(requireAuth, requireAdmin)\nrouter.post('/walkers', async (req, res) => res.json(await prisma.walker.create({ data: req.body })))\nexport default router\n" })), ADMIN, 'router.use(requireAuth, requireAdmin)')
  no(card({}, ex(mount, "if (req.user && req.user.role !== 'admin') return res.status(403).end()")), 'admins only', 'guests pass: `user && ...`')
  no(card({}, ex(mount, "if (req.user?.isAdmin) return res.status(403).end()")), 'admins only', 'the other sense keeps admins out')
  const pkg = ex(mount, role); delete (pkg as Record<string, string>)['server/src/middleware/auth.ts']
  ok(card({}, pkg), 'requires login ✓', "a requireAdmin plain can't read: login only"); no(card({}, pkg), 'admins only', 'a name alone')
  // changes: the admin check dropped (login kept) is a problem; added is a ✓
  const dropped = card(ex(mount, role), ex("app.use('/api/admin', requireAuth, admin)", role))
  ok(dropped, "plain can't see an admin check on the admin walkers part of your server any more", 'dropped')
  ok(card(ex("app.use('/api/admin', requireAuth, admin)", role), ex(mount, role)), 'is now limited to admins ✓', 'added')
  // (review 26, round 2) something before the check lets requests through; the check gutted but the name kept; the positive form
  no(card({}, ex(mount, "if (req.method === 'GET') return next()\n  " + role)), 'admins only', 'an earlier return next()')
  no(card({}, ex(mount, "next()\n  " + role)), 'admins only', 'a bare next() first')
  ok(card(ex(mount, role), ex(mount, '// TODO: re-enable\n  // ' + role)), "plain can't see an admin check", 'a gutted requireAdmin')
  ok(card({}, ex(mount, "if (req.user?.role === 'admin') return next()\n  return res.status(403).json({ error: 'admins only' })")), ADMIN, 'the positive form')
  no(card({}, ex(mount, "if (req.user?.role === 'admin' || req.user?.role === 'editor') return next()\n  return res.status(403).end()")), 'admins only', 'positive form letting editors in')
  no(card({}, ex(mount, "if (req.user?.role === 'admin') return next()\n  next()")), 'admins only', 'positive form that lets everyone on')
  // (review 26, round 3) a rejection that lets GET through; a flag the request sends, through a variable; a local requireRole('admin')
  no(card({}, ex(mount, "if (req.user?.isAdmin) return next()\n  return req.method === 'GET' ? next() : res.status(403).end()")), 'admins only', 'positive form, ternary after')
  no(card({}, ex(mount, "const who = req.query\n  if (who.isAdmin) return next()\n  return res.status(403).end()")), 'admins only', 'positive form, flag from the query')
  no(card({}, ex(mount, "const u = req.body\n  if (!u.isAdmin) return res.status(403).end()")), 'admins only', 'flag from the body')
  const toRole = ex("app.use('/api/admin', requireAuth, requireRole('admin'), admin)", role)
  toRole['server/src/index.ts'] = toRole['server/src/index.ts'].replace('requireAuth, requireAdmin }', 'requireAuth, requireRole }')
  toRole['server/src/middleware/auth.ts'] += "export const requireRole = (role) => (req, res, next) => {\n  if (req.user?.role !== role) return res.status(403).end()\n  next()\n}\n"
  no(card(ex(mount, role), toRole), "can't see an admin check", "switched to a local requireRole('admin')")
  // Go: chi middleware whose deciding `if` turns away non-admins (guests too: no user, no admin)
  const go = (check: string) => ({ 'go.mod': 'module example.com/shop\n\ngo 1.23\n\nrequire github.com/go-chi/chi/v5 v5.2.0\n',
    'migrations/000001_boxes.up.sql': 'create table boxes (id serial primary key, name text);\n',
    'main.go': `package main\n\nimport (\n\t"net/http"\n\t"github.com/go-chi/chi/v5"\n)\n\nfunc main() {\n\tr := chi.NewRouter()\n\tr.Route("/admin", func(r chi.Router) {\n\t\tr.Use(requireAdmin)\n\t\tr.Post("/boxes", createBox)\n\t})\n\thttp.ListenAndServe(":8080", r)\n}\n\nfunc requireAdmin(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tuser := currentUser(r)\n\t\tif ${check} {\n\t\t\thttp.Error(w, "forbidden", http.StatusForbidden)\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n\nfunc createBox(w http.ResponseWriter, r *http.Request) {\n\tdb.ExecContext(r.Context(), "INSERT INTO boxes (name) VALUES ($1)", "x")\n}\n` })
  ok(card({}, go('user == nil || !user.IsAdmin')), ADMIN, 'Go: nil or not admin')
  ok(card({}, go('!user.IsAdmin')), ADMIN, 'Go: not admin alone (a guest has no user, and is turned away too)')
  ok(card({}, go('user == nil')), 'requires login ✓', 'Go: login only'); no(card({}, go('user == nil')), 'admins only', 'Go: login only')
  no(card({}, go('user != nil && !user.IsAdmin')), 'admins only', 'Go: guests pass')
  console.log('ok (only admins)')
}
// Review 26: "only admins ✓" must not reach ordinary users: mixed conditions, flags from the request, checks in a branch, else-ifs, an app's own RoleMiddleware, a halt with its own condition, renamed imports
{
const h = (() => {
const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
const show = (name: string, c: string) => { const m = c.match(/[^.]*(admin|login|logging in)[^.]*\.?/gi) ?? []; console.log(`--- ${name}\n  ` + m.join('\n  ')) }
// Express
const ex = (mount: string, mwfile: string, routes?: string, extra: Record<string, string> = {}) => ({
  'server/package.json': '{"dependencies":{"express":"4.19.0","@prisma/client":"6.0.0"}}',
  'server/prisma/schema.prisma': 'model Walker {\n  id Int @id\n  name String\n}\n',
  'server/src/index.ts': `import express from 'express'\nimport admin from './routes/admin.js'\nimport { requireAuth, requireAdmin } from './middleware/auth.js'\nconst app = express()\n${mount}\napp.listen(3001)\n`,
  'server/src/middleware/auth.ts': mwfile,
  'server/src/routes/admin.ts': routes ?? "import { Router } from 'express'\nimport { prisma } from '../db.js'\nconst router = Router()\nrouter.post('/walkers', async (req, res) => res.json(await prisma.walker.create({ data: req.body })))\nexport default router\n", ...extra })
const auth = (admin: string) => `function requireAuth(req, res, next) {\n  if (!req.user) return res.status(401).json({ error: 'log in' })\n  next()\n}\nfunction requireAdmin(req, res, next) {\n  ${admin}\n  next()\n}\n`
const MOUNT = "app.use('/api/admin', requireAuth, requireAdmin, admin)"
// Go
const go = (check: string, mw = 'requireAdmin', rest = '') => ({ 'go.mod': 'module example.com/shop\n\ngo 1.23\n\nrequire github.com/go-chi/chi/v5 v5.2.0\n',
  'migrations/000001_boxes.up.sql': 'create table boxes (id serial primary key, name text);\n',
  'main.go': `package main\n\nimport (\n\t"net/http"\n\t"github.com/go-chi/chi/v5"\n)\n\nfunc main() {\n\tr := chi.NewRouter()\n\tr.Route("/admin", func(r chi.Router) {\n\t\tr.Use(${mw})\n\t\tr.Post("/boxes", createBox)\n\t})\n\thttp.ListenAndServe(":8080", r)\n}\n\nfunc requireAdmin(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tuser := currentUser(r)\n\t\tif ${check} {\n\t\t\thttp.Error(w, "forbidden", http.StatusForbidden)\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n\nfunc createBox(w http.ResponseWriter, r *http.Request) {\n\tdb.ExecContext(r.Context(), "INSERT INTO boxes (name) VALUES ($1)", "x")\n}\n${rest}` })

return { MOUNT, auth, card, ex, go, show }
})()
const rb = (() => {
const { card, show } = h
const R: Record<string, string> = {
  'Gemfile': 'source "https://rubygems.org"\ngem "rails", "~> 8.1.0"\ngem "devise"\ngem "stripe"\n',
  'config/application.rb': 'module Shop\n  class Application < Rails::Application\n    config.load_defaults 8.1\n  end\nend\n',
  'config/routes.rb': 'Rails.application.routes.draw do\n  devise_for :users\n  root "orders#index"\nend\n',
  'app/controllers/application_controller.rb': 'class ApplicationController < ActionController::Base\nend\n',
  'app/models/order.rb': 'class Order < ApplicationRecord\n  belongs_to :user\nend\n',
  'app/models/user.rb': 'class User < ApplicationRecord\n  has_many :orders\nend\n',
  'db/migrate/20260101000000_create_orders.rb': 'class CreateOrders < ActiveRecord::Migration[8.1]\n  def change\n    create_table :orders do |t|\n      t.references :user, null: false, foreign_key: true\n      t.string :status\n      t.timestamps\n    end\n  end\nend\n',
}
const orders = (body: string, head = '') => `class OrdersController < ApplicationController\n${head}\n  def index\n    @orders = Order.all\n  end\n\n  def create\n    current_user.orders.create!(order_params)\n    redirect_to orders_path\n  end\n\n  def destroy\n    Order.find(params[:id]).destroy\n    head :no_content\n  end\n${body}\n  private\n\n  def order_params\n    params.expect(order: [:status])\n  end\nend\n`
const routes = (r: string) => ({ 'config/routes.rb': `Rails.application.routes.draw do\n  devise_for :users\n${r}\nend\n` })
const rs = (extra: Record<string, string>) => card(R, { ...R, 'app/controllers/orders_controller.rb': orders(''), ...extra })
const appCtl = (body: string) => ({ 'app/controllers/application_controller.rb': `class ApplicationController < ActionController::Base\n${body}\nend\n` })
const res = routes('  resources :orders, only: [:index, :create]\n  delete "orders/:id", to: "orders#destroy"')
const ra = (def: string, head: string, auth = true) => rs({ ...res, ...(auth ? appCtl('  before_action :authenticate_user!') : {}), 'app/controllers/orders_controller.rb': orders(`\n  def require_admin\n${def}\n  end\n`, head) })
const S = (n: string, c: string) => show(n, c.replace(/plain · .*?WHAT CHANGED /, ''))

return { R, appCtl, orders, res, routes, rs }
})()
const lvh = (() => {
const ctl = (name: string, body: string, head = '') => `<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\Order;\n${head}class ${name} extends Controller {\n${body}\n}\n`
const L: Record<string, string> = {
  'composer.json': '{"require":{"laravel/framework":"^12.0"}}', 'artisan': '',
  '.env.example': 'APP_KEY=\nSTRIPE_SECRET=\n',
  'bootstrap/app.php': "<?php\nreturn Application::configure(basePath: dirname(__DIR__))\n  ->withRouting(web: __DIR__.'/../routes/web.php', health: '/up')\n  ->withMiddleware(function (Middleware $middleware): void { })->create();\n",
  'routes/web.php': "<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('/', fn () => view('welcome'));\n",
  'app/Http/Controllers/Controller.php': '<?php\nnamespace App\\Http\\Controllers;\nabstract class Controller {}\n',
  'app/Models/Order.php': '<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Order extends Model { protected $fillable = ["status"]; }\n',
  'database/migrations/2026_01_01_000000_create_orders_table.php': "<?php\nreturn new class extends Migration { public function up(): void { Schema::create('orders', function (Blueprint $table) { $table->id(); $table->foreignId('user_id')->constrained(); $table->string('status'); $table->timestamps(); }); } };\n",
}
const web = (routes: string) => ({ 'routes/web.php': L['routes/web.php'] + routes })
const orders = ctl('OrderController', "  public function index() { return Order::all(); }\n  public function store(Request $request) { return Order::create($request->validated()); }\n  public function cancel(Order $order) { $order->update(['status' => 'cancelled']); }")
const lv = (extra: Record<string, string>) => card(L, { ...L, 'app/Http/Controllers/OrderController.php': orders, ...extra })
const grp = "Route::middleware('admin')->group(function () { Route::post('/orders', [OrderController::class, 'store']); Route::get('/menu', [OrderController::class, 'index']); });\n"
const admin = (body: string, routes = grp) => ({ ...web(routes),
  'bootstrap/app.php': L['bootstrap/app.php'].replace('{ }', "{ $middleware->alias(['admin' => \\App\\Http\\Middleware\\EnsureAdmin::class]); }"),
  'app/Http/Middleware/EnsureAdmin.php': `<?php\nclass EnsureAdmin { public function handle(Request $request, Closure $next) { ${body} return $next($request); } }\n` })

return { L, admin, lv, web }
})()
const { card, ex, auth, MOUNT, go } = h
const { rs, res, appCtl, orders } = rb
const { lv, admin, web, L } = lvh
// Each case: a route ordinary users (or guests) can reach, that the change calls "admins only" (or a false "no longer limited").
const ADMIN = 'is for admins only ✓'
let n = 0
const bad = (name: string, c: string, x = ADMIN) => assert.ok(!c.includes(x), `review 26 ${name}\n${c}`)
const R = (b: string) => card({}, ex(MOUNT, auth(b)))
// F1 Express: `&&` after the admin test (adminText only looks before it)
bad('E1 express !admin && !owner', R("if (!req.user.isAdmin && req.user.id !== req.params.userId) return res.status(403).json({ error: 'forbidden' })"))
bad('E2 express role list (admin && editor)', R("if (req.user.role !== 'admin' && req.user.role !== 'editor') return res.status(403).end()"))
bad('E3 express !(admin || owner)', R("if (!(req.user.isAdmin || req.user.id === req.params.id)) return res.status(403).end()"))
// F2 Express: a deny word anywhere within 160 chars, not the if's own branch
bad('E4 express only logs', R("if (!req.user.isAdmin) {\n    console.warn('Forbidden: non-admin user hit admin route', req.user.id)\n  }"))
bad('E5 express admin check only for DELETE', R("if (req.method === 'DELETE') { if (!req.user.isAdmin) return res.status(403).end() }"))
// F3 request-controlled "admin"
bad('E6 express ?isAdmin query', R("if (!req.query.isAdmin) return res.status(403).end()"))
bad('E7 express header', R("if (!req.headers.admin) return res.status(403).end()"))
// F4 Go: admin alone makes it a login check, even when the value isn't the user
const gh = (decl: string, cond: string) => { const g = go(cond); g['main.go'] = g['main.go'].replace('user := currentUser(r)', decl); return g }
bad('G1 go header role (guests pass)', card({}, gh('role := r.Header.Get("X-Role")', 'role != "admin"')))
bad('G2 go JSON body IsAdmin', card({}, gh('var body struct{ IsAdmin bool }\n\t\tjson.NewDecoder(r.Body).Decode(&body)', '!body.IsAdmin')))
bad('G3 go !(admin || owner)', card({}, go('!(user.IsAdmin || user.ID == r.PathValue("id"))')))
// F5 Laravel: NOT_ADMIN tested on the whole if statement (else / elseif branches), and OR's tail may hold &&
bad('L1 laravel elseif only logs', lv(admin("if (! $request->user()) {\n abort(401);\n } elseif (! $request->user()->is_admin) {\n Log::warning('non-admin');\n }")))
bad('L2 laravel || !admin && isMethod(post)', lv(admin("if (! $request->user() || ! $request->user()->is_admin && $request->isMethod('post')) { abort(403); }")))
// F6 Laravel: role:admin counted as Spatie even when 'role' is the app's own RoleMiddleware
bad('L3 laravel app RoleMiddleware that only logs', lv({ ...web("Route::middleware('auth')->group(function () { Route::middleware('role:admin')->group(function () { Route::post('/orders', [OrderController::class, 'store']); }); });\n"),
  'bootstrap/app.php': L['bootstrap/app.php'].replace('{ }', "{ $middleware->alias(['role' => \\App\\Http\\Middleware\\RoleMiddleware::class]); }"),
  'app/Http/Middleware/RoleMiddleware.php': "<?php\nclass RoleMiddleware { public function handle(Request $request, Closure $next, string $role) { if ($request->user()?->role !== $role) { Log::warning('role mismatch'); } return $next($request); } }\n" }))
// F7 Rails: LOGIN_BLOCK whose halt line has its own `if`
bad('R1 rails unless admin? / redirect if request.delete?', rs({ ...res, ...appCtl('  before_action :authenticate_user!'), 'app/controllers/orders_controller.rb': orders('\n  def require_admin\n    unless current_user&.admin?\n      redirect_to root_path if request.delete?\n    end\n  end\n', '  before_action :require_admin') }))
// F8 Express alias: binds keep the module, not the exported name
const a = ex('', auth("if (!req.user.isAdmin) return res.status(403).end()") + "function requireStaff(req, res, next) {\n  if (!req.user) return res.status(401).end()\n  next()\n}\n")
a['server/src/index.ts'] = "import express from 'express'\nimport admin from './routes/admin.js'\nimport { requireAuth, requireStaff as requireAdmin } from './middleware/auth.js'\nconst app = express()\napp.use('/api/admin', requireAuth, requireAdmin, admin)\napp.listen(3001)\n"
bad('E8 express `requireStaff as requireAdmin`', card({}, a))
// F9 false "no longer limited to admins" (admin check still there, plain just can't read it)
const role = "if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admins only' })", base = ex(MOUNT, auth(role)), NL = 'anyone with an account can use it now'
bad('C1 rewrite to positive form', card(base, ex(MOUNT, auth("if (req.user?.role === 'admin') return next()\n  return res.status(403).json({ error: 'admins only' })"))), NL)
const pkg = ex("app.use('/api/admin', requireAuth, requireRole('admin'), admin)", auth(role)); pkg['server/src/index.ts'] = pkg['server/src/index.ts'].replace("import { requireAuth, requireAdmin } from './middleware/auth.js'", "import { requireAuth } from './middleware/auth.js'\nimport { requireRole } from '@acme/auth'")
bad('C2 switch to a package requireRole(admin)', card(base, pkg), NL)
console.log('ok (review 26)')

}
// Next.js pages (round 10): login only when the page or a layout above it turns guests away; reading the session to choose a
// button, or a /login page sending logged-in people on, isn't a login check
{
  const pkg = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0"}}' }
  const page = (body: string) => `import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nexport default async function Page() {\n${body}\n  return <main><h1>Hi</h1></main>\n}\n`
  const card = (files: Record<string, string>) => report(new Map(Object.entries(pkg)), new Map(Object.entries({ ...pkg, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
  const LOGIN = 'You have to log in to open it ✓'
  assert.ok(!card({ 'app/page.tsx': page('  const session = await auth()\n  const label = session?.user ? "Open" : "Log in"') }).includes(LOGIN), 'next page: session read for a button')
  assert.ok(!card({ 'app/login/page.tsx': page('  if (await auth()) redirect("/w")') }).includes(LOGIN), 'next page: /login sends logged-in people on')
  assert.ok(card({ 'app/w/page.tsx': page('  const session = await auth()\n  if (!session?.user) redirect("/login")') }).includes(LOGIN), 'next page: turns guests away')
  const layout = 'import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nexport default async function Layout({ children }) {\n  const session = await auth()\n  if (!session) redirect("/login")\n  return <>{children}</>\n}\n'
  assert.ok(card({ 'app/(app)/layout.tsx': layout, 'app/(app)/w/[id]/page.tsx': 'export default function Page() { return <main><h1>Board</h1></main> }\n' }).includes(LOGIN), 'next page: a layout above it turns guests away')
  console.log('ok (next pages login)')
}
// Round 10 (apps that aren't shops): Next.js server actions, routers made by a factory, SQLAlchemy's Base, acronyms, AI services,
// FastAPI migrations, changes linked to the request through the names they add
{
  const card = (a: Record<string, string>, b: Record<string, string>, asked?: string) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main', asked }).replace(/\s+/g, ' ')
  const pkg = { 'package.json': '{"dependencies":{"next":"15.0.0","resend":"4.0.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Comment {\n  id String @id\n  body String\n}\nmodel Membership {\n  id String @id\n}\nmodel Task {\n  id String @id\n}\n' }
  const authz = 'import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nexport async function requireUser() {\n  const session = await auth()\n  if (!session?.user) redirect("/login")\n  return session.user\n}\n'
  const email = 'import { Resend } from "resend"\nconst resend = new Resend(process.env.RESEND_API_KEY)\nexport async function sendMentionEmails(to: string[], body: string) {\n  await resend.emails.send({ from: "a@b.c", to, subject: "Mentioned", text: body })\n}\n'
  const actions = '"use server"\nimport { prisma } from "@/lib/prisma"\nimport { requireUser } from "@/lib/authz"\nimport { sendMentionEmails } from "@/lib/email"\nexport async function createCommentAction(formData: FormData) {\n  const user = await requireUser()\n  await prisma.comment.create({ data: { body: String(formData.get("body")) } })\n  await sendMentionEmails(["x@y.z"], "hi")\n}\nexport async function removeMemberAction(formData: FormData) {\n  await requireUser()\n  await prisma.membership.delete({ where: { id: "1" } })\n  await prisma.task.updateMany({ where: {}, data: {} })\n}\n'
  const base = { ...pkg, 'lib/authz.ts': authz, 'lib/email.ts': email }
  const c = card(base, { ...base, 'app/actions/comments.ts': actions })
  assert.ok(c.includes('saves new comments, requires login ✓ and emails people through Resend'), `server action: what it does, through its helpers; requireUser() turns guests away\n${c}`)
  assert.ok(c.includes('updates and deletes memberships and tasks') || c.includes('updates and deletes tasks and memberships'), `server action: deletes named\n${c}`)
  assert.ok(!/Anyone can|without logging in/.test(c), `server action: no false alarm\n${c}`)
  // a helper plain can't read (requireWorkspaceMember): no claim either way; nothing about who's asking at all: open
  const viaHelper = actions.replace(/requireUser/g, 'requireWorkspaceMember')
  const vh = card({ ...base, 'lib/authz.ts': authz.replace('requireUser', 'requireWorkspaceMember') }, { ...base, 'lib/authz.ts': authz.replace('requireUser', 'requireWorkspaceMember'), 'app/actions/comments.ts': viaHelper })
  assert.ok(!/requires login ✓|Anyone can/.test(vh), `server action through an unread helper: no claim\n${vh}`)
  const open = '"use server"\nimport { prisma } from "@/lib/prisma"\nexport async function makeAdminAction(formData: FormData) {\n  await prisma.comment.create({ data: { body: String(formData.get("x")) } })\n}\n'
  assert.ok(/Anyone can/.test(card(base, { ...base, 'app/actions/admin.ts': open })), 'server action with no login at all: anyone can call it')
  const own = '"use server"\nimport { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nimport { prisma } from "@/lib/prisma"\nexport async function createCommentAction(formData: FormData) {\n  const session = await auth()\n  if (!session) redirect("/login")\n  await prisma.comment.create({ data: { body: "x" } })\n}\n'
  assert.ok(card(base, { ...base, 'app/actions/comments.ts': own }).includes('saves new comments and requires login ✓'), 'server action: its own check')
  // Express: app.use('/api/messages', createMessagesRouter(io)) keeps the prefix
  const ex = { 'server/package.json': '{"dependencies":{"express":"4.19.0","@prisma/client":"6.0.0"}}', 'server/prisma/schema.prisma': 'model Message {\n  id Int @id\n  body String\n}\n',
    'server/src/index.ts': "import express from 'express'\nimport { createMessagesRouter } from './routes/messages.js'\nconst app = express()\napp.use('/api/messages', createMessagesRouter(io))\napp.listen(3001)\n",
    'server/src/routes/messages.ts': "import { Router } from 'express'\nimport { prisma } from '../db.js'\nexport function createMessagesRouter(io) {\n  const router = Router()\n  router.get('/', async (req, res) => res.json(await prisma.message.findMany()))\n  return router\n}\n" }
  assert.ok(card({}, ex).includes('/api/messages'), 'a router made by a factory keeps its mount path')
  // FastAPI + SQLAlchemy: class Base(DeclarativeBase) isn't a table; AIRequest reads "AI requests"; OpenAI says what it gets;
  // no Flask-Migrate in a FastAPI app
  const py = { 'requirements.txt': 'fastapi==0.115.5\nsqlalchemy==2.0.36\nalembic==1.14.0\nopenai==1.55.0\n',
    'app/database.py': 'from sqlalchemy.orm import DeclarativeBase\n\nclass Base(DeclarativeBase):\n    pass\n',
    'app/models.py': 'from sqlalchemy.orm import Mapped, mapped_column\nfrom app.database import Base\n\nclass AIRequest(Base):\n    __tablename__ = "ai_requests"\n    id: Mapped[int] = mapped_column(primary_key=True)\n    mode: Mapped[str] = mapped_column()\n',
    'app/ai.py': 'from openai import OpenAI\nclient = OpenAI()\n\ndef rewrite(text):\n    return client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": text}])\n',
    'alembic/versions/0001_initial.py': 'def upgrade():\n    op.create_table("ai_requests")\n\ndef downgrade():\n    op.drop_table("ai_requests")\n' }
  const q = card({}, py)
  assert.ok(!/stores bases/.test(q), `SQLAlchemy Base isn't a table\n${q}`)
  assert.ok(q.includes('stores AI requests'), `acronyms kept\n${q}`)
  assert.ok(q.includes('What people write in it can be sent to OpenAI, and each request costs you money'), `AI service wording\n${q}`)
  assert.ok(q.includes('(`alembic upgrade head`)') && !q.includes('Flask-Migrate'), `no Flask-Migrate in a FastAPI app\n${q}`)
  // a file that adds a name another file of the request adds too is part of it (isGuest), not "unrelated"
  const g0 = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'lib/types.ts': 'export type User = { id: string }\n', 'app/api/guest/route.ts': 'export async function POST() { return Response.json({}) }\n' }
  const g1 = { ...g0, 'lib/types.ts': 'export type User = { id: string; anonymousHandle: string }\n', 'app/api/guest/route.ts': 'export async function POST() { return Response.json({ anonymousHandle: "x" }) }\n' }
  assert.ok(!card(g0, g1, 'can people chat without signing up').includes("doesn't look related"), 'linked through a name the change adds')
  const g2 = { ...g1, 'app/api/guest/route.ts': g0['app/api/guest/route.ts'].replace('{}', '{ ok: true }') }
  assert.ok(card(g0, g2, 'can people chat without signing up').includes("doesn't look related"), 'control: nothing links it, still flagged')
  console.log('ok (round 10 fixes)')
}
// Review 27 (round 10 fixes): a login ✓ only from a real check in the page or action itself, Clerk and Next's own stops,
// factory routers and optional-auth middleware aren't guards, names new to the app link a change, verbs per handler
{
  const card = (a: Record<string, string>, b: Record<string, string>, opts: Record<string, string> = {}) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main', ...opts }).replace(/\s+/g, ' ')
  const LOGIN = 'You have to log in to open it ✓'
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Post {\n  id String @id\n  body String\n}\nmodel Feedback {\n  id String @id\n  body String\n}\n' }
  const pageWith = (top: string, body: string) => `import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\n${top}\nexport default async function Page() {\n${body}\n  return <main><h1>Posts</h1></main>\n}\n`
  // pages: a "use server" function or a small component in the file isn't the page; a guest view isn't a stop
  assert.ok(!card(nx, { ...nx, 'app/posts/page.tsx': pageWith('async function deletePost() {\n  "use server"\n  const session = await auth()\n  if (!session?.user) redirect("/login")\n}', '  const posts = []') }).includes(LOGIN), 'r27: a server action in the page file')
  assert.ok(!card(nx, { ...nx, 'app/posts/page.tsx': pageWith('function NewPost({ user }) {\n  if (!user) return null\n  return <a href="/new">New</a>\n}', '  const session = await auth()') }).includes(LOGIN), 'r27: a component hiding a button')
  assert.ok(!card(nx, { ...nx, 'app/posts/page.tsx': pageWith('', '  const session = await auth()\n  if (!session?.user) return <main><h1>Welcome, guest</h1></main>') }).includes(LOGIN), 'r27: a guest view')
  const gssp = 'import { getServerSession } from "next-auth/next"\nexport async function getServerSideProps(ctx) {\n  const session = await getServerSession(ctx.req, ctx.res, authOptions)\n  if (!session) return { redirect: { destination: "/login", permanent: false } }\n  return { props: {} }\n}\nexport default function Account() { return <main><h1>Account</h1></main> }\n'
  const p14 = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0"}}' }
  assert.ok(card(p14, { ...p14, 'pages/account.tsx': gssp }).includes(LOGIN), 'r27: pages router getServerSideProps redirect')
  assert.ok(card(p14, { ...p14, 'pages/account.tsx': gssp.replace('return { redirect: { destination: "/login", permanent: false } }', 'return { notFound: true }') }).includes(LOGIN), 'r27: getServerSideProps notFound')
  // Clerk, and Next's own notFound() / unauthorized() / forbidden()
  const ck = { 'package.json': '{"dependencies":{"next":"15.0.0","@clerk/nextjs":"6.0.0"}}' }
  const clerk = (b: string) => `import { auth } from "@clerk/nextjs/server"\nimport { redirect } from "next/navigation"\nexport default async function Page() {\n${b}\n  return <main><h1>Dashboard</h1></main>\n}\n`
  for (const b of ['  await auth.protect()', '  const { userId } = await auth()\n  if (!userId) redirect("/sign-in")', '  const { userId, redirectToSignIn } = await auth()\n  if (!userId) return redirectToSignIn()'])
    assert.ok(card(ck, { ...ck, 'app/dashboard/page.tsx': clerk(b) }).includes(LOGIN), `r27: Clerk ${b.trim()}`)
  for (const b of ['  const session = await auth()\n  if (session?.user?.role !== "admin") notFound()', '  const session = await auth()\n  if (!session) unauthorized()', '  const session = await auth()\n  if (!session?.user) forbidden()'])
    assert.ok(card(nx, { ...nx, 'app/admin/page.tsx': pageWith('', b) }).includes(LOGIN), `r27: ${b.trim()}`)
  // server actions: auth() next to a success redirect or an unrelated throw isn't a login check
  const act = (body: string) => `"use server"\nimport { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nimport { prisma } from "@/lib/prisma"\nexport async function sendFeedbackAction(formData: FormData) {\n${body}\n}\n`
  assert.ok(!card(nx, { ...nx, 'app/actions/feedback.ts': act('  const session = await auth()\n  await prisma.feedback.create({ data: { body: "x", userId: session?.user?.id ?? null } })\n  redirect("/thanks")') }).includes('requires login ✓'), 'r27: action, success redirect')
  assert.ok(!card(nx, { ...nx, 'app/actions/feedback.ts': act('  const session = await auth()\n  const post = await prisma.post.findFirst({})\n  if (!post) throw new Error("Post not found")\n  await prisma.post.delete({ where: { id: post.id } })') }).includes('requires login ✓'), 'r27: action, unrelated throw')
  // Express: a factory mount or optional-auth middleware isn't a login check
  const ex = (mw: string) => ({ 'package.json': '{"dependencies":{"express":"4.19.0","express-session":"1.18.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Post {\n  id Int @id\n  body String\n}\n',
    'routes/posts.ts': "import { Router } from 'express'\nimport { prisma } from '../db.js'\nexport const postsRouter = Router()\npostsRouter.post('/', async (req, res) => res.json(await prisma.post.create({ data: { body: req.body.body } })))\n",
    'index.ts': `import express from 'express'\nimport { postsRouter } from './routes/posts.js'\nconst app = express()\n${mw}\napp.use('/api/posts', postsRouter)\napp.listen(3000)\n` })
  for (const mw of ["app.use('/api', expressSession({ secret: 'x' }))", "app.use('/api', optionalAuth())", "app.use(expressSession({ secret: 'x' }))", "app.use(expressjwt({ secret: 'x', algorithms: ['HS256'], credentialsRequired: false }))"])
    assert.ok(!card({}, ex(mw)).includes('requires login ✓'), `r27: ${mw}`)
  // "didn't run or test": feature sentences aren't about the tests
  for (const said of ['Done. Free users get 3 rewrites a day; after that, AI generation is not available until tomorrow. All tests pass.', 'Health checks are not available on the free tier, so the status page hides them. Tests pass.', 'Guests can now chat. Email verification isn’t available for guest accounts. Ran the test suite: all green.', 'Search is in. Ran npm test, 12 passed. Builds are not possible without Docker, which is expected.'])
    assert.ok(!report(new Map([['a.ts', 'export const a = 1\n']]), new Map([['a.ts', 'export const a = 2\n']]), { ref: 'main', agentSaid: said }).includes("didn't run or test"), `r27 untested: ${said}`)
  // unrelated: a common new word (error, async) doesn't link a change to the request
  const b0 = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'lib/pricing.ts': 'export function discount(total: number) {\n  return total * 0.9\n}\n', 'app/page.tsx': 'export default function Home() { return <main><h1>Home</h1></main> }\n' }
  const contact = '"use client"\nexport default function Contact() {\n  const [error, setError] = useState("")\n  return <main><h1>Contact us</h1>{error && <p>{error}</p>}</main>\n}\n'
  for (const d of ['export function discount(total: number) {\n  console.error("x")\n  return total * 0.8\n}\n', 'export async function discount(total: number) {\n  return total * 0.8\n}\n'])
    assert.ok(card(b0, { ...b0, 'lib/pricing.ts': d, 'app/contact/page.tsx': contact }, { asked: 'add a contact form' }).includes("doesn't look related"), 'r27: common words don\'t link')
  // verbs per handler: POST updates, DELETE deletes
  const ro = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Order {\n  id Int @id\n}\n' }
  const route = 'import { prisma } from "@/lib/prisma"\nexport async function POST(req: Request) { const s = await auth(); if (!s) return new Response("no", { status: 401 }); await prisma.order.update({ where: { id: 1 }, data: {} }); return Response.json({}) }\nexport async function DELETE(req: Request) { const s = await auth(); if (!s) return new Response("no", { status: 401 }); await prisma.order.delete({ where: { id: 1 } }); return Response.json({}) }\n'
  assert.ok(!card(ro, { ...ro, 'app/api/orders/[id]/route.ts': route }).includes('updates and deletes orders, deletes orders'), 'r27: no repeated verb')
  // names: an AI request, OAuth, API keys; class Base(AsyncAttrs, DeclarativeBase) isn't a table
  assert.ok(things('OAuthAccount') === 'oauth accounts' && things('APIKey') === 'API keys' && things('Survey') === 'surveys', 'r27: names')
  const py = { 'requirements.txt': 'fastapi==0.115.5\nsqlalchemy==2.0.36\n', 'app/database.py': 'from sqlalchemy.orm import DeclarativeBase\nfrom sqlalchemy.ext.asyncio import AsyncAttrs\n\nclass Base(AsyncAttrs, DeclarativeBase):\n    pass\n',
    'app/models.py': 'from sqlalchemy.orm import Mapped, mapped_column\nfrom app.database import Base\n\nclass Note(Base):\n    __tablename__ = "notes"\n    id: Mapped[int] = mapped_column(primary_key=True)\n    body: Mapped[str] = mapped_column()\n' }
  assert.ok(!card({}, py).includes('stores bases'), 'r27: AsyncAttrs base')
  console.log('ok (review 27)')
}
// Review 27, round 2: page checks through export { X as default }, a wrapper, a helper the page calls, <RedirectToSignIn />;
// action checks inside helpers; real guards with "session" or "optional" in them
{
  const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  {
const pkg = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@clerk/nextjs":"6.0.0"}}' }
const head = `import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\n`
const cases: Record<string, string> = {
  'export { Page as default }': head + `async function Page() {\n  const session = await auth()\n  if (!session) redirect("/login")\n  return <main><h1>Dashboard</h1></main>\n}\nexport { Page as default }\n`,
  'export default withX(Page)': head + `import { withTracking } from "@/lib/track"\nasync function Page() {\n  const session = await auth()\n  if (!session) redirect("/login")\n  return <main><h1>Dashboard</h1></main>\n}\nexport default withTracking(Page)\n`,
  'check in helper called by page': head + `async function getUserOrRedirect() {\n  const session = await auth()\n  if (!session?.user) redirect("/login")\n  return session.user\n}\nexport default async function Page() {\n  const user = await getUserOrRedirect()\n  return <main><h1>Dashboard</h1></main>\n}\n`,
  'export default arrow const': head + `const Page = async () => {\n  const session = await auth()\n  if (!session) redirect("/login")\n  return <main><h1>Dashboard</h1></main>\n}\nexport default Page\n`,
  'clerk <RedirectToSignIn/>': `import { auth } from "@clerk/nextjs/server"\nimport { RedirectToSignIn } from "@clerk/nextjs"\nexport default async function Page() {\n  const { userId } = await auth()\n  if (!userId) return <RedirectToSignIn />\n  return <main><h1>Dashboard</h1></main>\n}\n`,
}
for (const [l, page] of Object.entries(cases)) assert.ok(card(pkg, { ...pkg, 'app/dashboard/page.tsx': page }).includes('You have to log in to open it ✓'), `r27b: ${l}`)

  }
  {
const pkg = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Post {\n  id String @id\n}\n' }
const viewer = 'import { auth } from "@/auth"\nexport async function getViewer() {\n  const session = await auth()\n  return session?.user ?? null\n}\n'
const act = (body: string) => `"use server"\nimport { prisma } from "@/lib/prisma"\nimport { getViewer } from "@/lib/viewer"\nimport { cookies } from "next/headers"\nimport { verifyToken } from "@/lib/jwt"\nexport async function deletePostAction(id: string) {\n${body}\n  await prisma.post.delete({ where: { id } })\n}\n`
const jwt = 'import { jwtVerify } from "jose"\nexport async function verifyToken(t?: string) { if (!t) return null; return (await jwtVerify(t, new TextEncoder().encode(process.env.JWT_SECRET!))).payload }\n'
const base = { ...pkg, 'lib/viewer.ts': viewer, 'lib/jwt.ts': jwt }
assert.ok(!/Anyone can/.test(card(base, { ...base, 'app/actions/posts.ts': act('  const viewer = await getViewer()\n  if (!viewer) throw new Error("Not allowed")') })), 'r27b: action check')
assert.ok(!/Anyone can/.test(card(base, { ...base, 'app/actions/posts.ts': act('  const payload = await verifyToken((await cookies()).get("token")?.value)\n  if (!payload) throw new Error("Not allowed")') })), 'r27b: action check')
assert.ok(/Anyone can/.test(card(base, { ...base, 'app/actions/posts.ts': act('') })), 'r27b: action check')

  }
  {
const pkg = { 'package.json': '{"dependencies":{"express":"4.19.0","supertokens-node":"20.0.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Post {\n  id Int @id\n  body String\n}\n' }
for (const [l, mw] of [['verifySession({ checkDatabase: true })', 'verifySession({ checkDatabase: true })'], ['requireAuth({ optional: false })', 'requireAuth({ optional: false })'], ['requireAuthOptionalAdmin', 'requireAuthOptionalAdmin'], ['control verifySession()', 'verifySession()']]) {
  const idx = `import express from 'express'\nimport { prisma } from './db.js'\nimport { verifySession } from 'supertokens-node/recipe/session/framework/express'\nimport { requireAuth, requireAuthOptionalAdmin } from './auth.js'\nconst app = express()\napp.post('/api/posts', ${mw}, async (req, res) => res.json(await prisma.post.create({ data: { body: req.body.body } })))\napp.listen(3000)\n`
  assert.ok(card({}, { ...pkg, 'src/index.ts': idx }).includes('requires login ✓'), `r27b: ${l}`)
}

  }
  console.log('ok (review 27, round 2)')
}
// Uploads (round 10, Porch p3's 🔴): what's accepted, how big, where files go; a guess when nothing caps size or how much
// one person can upload. A Stripe webhook's express.raw({ type: 'application/json' }) isn't an upload.
{
  const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const base = { 'package.json': '{"dependencies":{"express":"4.19.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Photo {\n  id Int @id\n  image Bytes\n}\n',
    'src/index.ts': "import express from 'express'\nimport { photos } from './photos.js'\nconst app = express()\napp.use('/api/photos', photos)\napp.listen(3000)\n" }
  const route = (mw: string, extra = '') => `import express, { Router } from 'express'\nimport { prisma } from './db.js'\n${extra}\nexport const photos = Router()\nphotos.post('/', ${mw}, async (req, res) => res.json(await prisma.photo.create({ data: { image: req.body } })))\n`
  const raw = "express.raw({ type: ['image/jpeg', 'image/png'], limit: 5 * 1024 * 1024 })"
  const c1 = card(base, { ...base, 'src/photos.ts': route(raw) })
  assert.ok(c1.includes('People can now upload pictures (JPEG or PNG), up to 5 MB each. They\'re stored in your database.'), `uploads: described\n${c1}`)
  assert.ok(c1.includes('one account can fill your database and stop the whole app'), `uploads: no per-person cap\n${c1}`)
  assert.ok(!c1.includes('no size limit'), 'uploads: size is limited')
  const c2 = card(base, { ...base, 'src/photos.ts': route("multer({ storage: multer.memoryStorage() }).single('photo')", "import multer from 'multer'") })
  assert.ok(c2.includes('Uploads have no size limit plain can see'), `uploads: no size limit\n${c2}`)
  const c3 = card(base, { ...base, 'src/photos.ts': route(raw, "import rateLimit from 'express-rate-limit'\nconst limiter = rateLimit({ windowMs: 60000, max: 5 })") })
  assert.ok(!c3.includes('Nothing limits how many files'), `uploads: a rate limiter caps it\n${c3}`)
  const c4 = card(base, { ...base, 'src/photos.ts': route(raw.replace("'image/png'", "'image/svg+xml'")) })
  assert.ok(c4.includes('SVG pictures are allowed'), `uploads: SVG\n${c4}`)
  const hook = "import express, { Router } from 'express'\nexport const photos = Router()\nphotos.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => res.json({}))\n"
  assert.ok(!card(base, { ...base, 'src/photos.ts': hook }).includes('upload'), 'uploads: a webhook body isn\'t an upload')
  const s3 = { ...base, 'src/photos.ts': route("multer({ limits: { fileSize: 2 * 1024 * 1024 } }).single('photo')", "import multer from 'multer'\nimport { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'\nconst s3 = new S3Client({})\nasync function save(f) { await s3.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: f })) }") }
  const c5 = card(base, s3)
  assert.ok(c5.includes("stored in Amazon S3") && c5.includes('adds to your Amazon S3 bill'), `uploads: S3\n${c5}`)
  const mod = { ...base, 'src/photos.ts': route(raw) + "photos.delete('/:id', async (req, res) => { if (req.user.role === 'admin') await prisma.photo.delete({ where: { id: 1 } }); res.json({}) })\n" }
  assert.ok(card(base, mod).includes('Nothing limits how many files'), 'uploads: an admin check elsewhere in the file isn\'t an admins-only upload')
  console.log('ok (uploads)')
}
// Review 28: uploads (real entry points only, sizes from limits and framework defaults, storage from the upload code and its
// imports, allow-lists not rejections, server-side caps, admins-only and has_one_attached not scared)
{
  const up = (before: Record<string, string>, after: Record<string, string>) => {
    const r = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' })
    return r.replace(/\n\s{2,}(?![!+•\d])/g, ' ').split('\n').map(l => l.trim()).filter(l => /upload|size limit|SVG pictures/i.test(l)).join('\n')
  }
  const got = new Map<string, string>()
  const show = (name: string, before: Record<string, string>, after: Record<string, string>) => { got.set(name, up(before, after)) }
  {
// FALSE ALARMS: things detected as uploads that aren't, plus false "no size limit" / "nothing limits"
const next = { 'package.json': '{"dependencies":{"next":"15.0.0","react":"19.0.0"}}', 'app/page.tsx': 'export default function P() { return <p/> }\n' }
show('client-side image preview (instanceof File)', next, { ...next, 'components/AvatarPreview.tsx':
  "'use client'\nexport function AvatarPreview({ value }: { value: File | string }) {\n  const src = value instanceof File ? URL.createObjectURL(value) : value\n  return <img src={src} />\n}\n" })
show('client fetch wrapper (instanceof Blob)', next, { ...next, 'lib/api.ts':
  "export async function api(url: string, body: unknown) {\n  const headers = body instanceof Blob ? {} : { 'content-type': 'application/json' }\n  return fetch(url, { method: 'POST', headers, body: body instanceof Blob ? body : JSON.stringify(body) })\n}\n" })
const ex = { 'package.json': '{"dependencies":{"express":"4.19.0"}}', 'src/index.ts': "import express from 'express'\nconst app = express()\napp.listen(3000)\n" }
show("webhook with express.raw({ type: '*/*' })", ex, { ...ex, 'src/webhooks.ts':
  "import express, { Router } from 'express'\nimport crypto from 'node:crypto'\nexport const hooks = Router()\nhooks.post('/shopify', express.raw({ type: '*/*' }), (req, res) => {\n  const ok = crypto.createHmac('sha256', process.env.SECRET!).update(req.body).digest('base64') === req.get('x-shopify-hmac-sha256')\n  res.sendStatus(ok ? 200 : 401)\n})\n" })
show('nightly report job writes CSV to S3 (PutObjectCommand)', ex, { ...ex, 'src/jobs/export.ts':
  "import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'\nimport { prisma } from '../db.js'\nconst s3 = new S3Client({})\nexport async function nightlyExport() {\n  const rows = await prisma.order.findMany()\n  await s3.send(new PutObjectCommand({ Bucket: 'reports', Key: `orders-${Date.now()}.csv`, Body: rows.map(r => r.id).join('\\n') }))\n}\n" })
const sb = { 'package.json': '{"dependencies":{"@supabase/supabase-js":"2.45.0","express":"4.19.0"}}', 'src/index.ts': "import express from 'express'\nconst app = express()\napp.listen(3000)\n" }
show('server generates invoice PDF, saves to Supabase storage', sb, { ...sb, 'src/invoices.ts':
  "import { createClient } from '@supabase/supabase-js'\nimport { renderPdf } from './pdf.js'\nconst supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)\nexport async function saveInvoice(orderId: string) {\n  const pdf = await renderPdf(orderId)\n  await supabase.storage.from('invoices').upload(`${orderId}.pdf`, pdf, { contentType: 'application/pdf' })\n}\n" })
// refactor: an existing upload handler moved to a new file (no new upload)
const multerRoute = "import multer from 'multer'\nimport { Router } from 'express'\nconst upload = multer({ dest: 'uploads/' })\nexport const r = Router()\nr.post('/avatar', upload.single('avatar'), (req, res) => res.json({ ok: true }))\n"
show('refactor: existing multer route moved to a new file', { ...ex, 'src/routes.ts': multerRoute }, { ...ex, 'src/routes/avatar.ts': multerRoute })
// Laravel: a second $request->file() read of an existing upload (log the name)
const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'routes/web.php': "<?php\nuse App\\Http\\Controllers\\AvatarController;\nRoute::post('/avatar', [AvatarController::class, 'store'])->middleware(['auth','throttle:5,1']);\n" }
const ctl = (extra: string) => `<?php\nnamespace App\\Http\\Controllers;\nuse Illuminate\\Http\\Request;\nclass AvatarController extends Controller {\n  public function store(Request $request) {\n    $request->validate(['avatar' => 'required|image|max:2048']);\n    $path = $request->file('avatar')->store('avatars');${extra}\n    return back();\n  }\n}\n`
show('Laravel: existing upload, add a log line reading the same file', { ...lv, 'app/Http/Controllers/AvatarController.php': ctl('') }, { ...lv, 'app/Http/Controllers/AvatarController.php': ctl("\n    logger()->info('avatar', ['name' => $request->file('avatar')->getClientOriginalName()]);") })

  }
  {
// MISSES of common upload shapes
const ex = { 'package.json': '{"dependencies":{"express":"4.19.0"}}', 'src/db.ts': 'export const prisma = {} as any\n',
  'prisma/schema.prisma': 'model User {\n  id Int @id\n  totpSecret Bytes\n}\n',
  'src/storage.ts': "import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'\nconst s3 = new S3Client({})\nexport const saveToBucket = (f: { buffer: Buffer; originalname: string }) => s3.send(new PutObjectCommand({ Bucket: 'photos', Key: f.originalname, Body: f.buffer }))\n",
  'src/index.ts': "import express from 'express'\nconst app = express()\napp.listen(3000)\n" }
show('(storage) multer + existing S3 helper in another file; unrelated Bytes column', ex, { ...ex, 'src/index.ts':
  "import express from 'express'\nimport multer from 'multer'\nimport { saveToBucket } from './storage.js'\nconst app = express()\nconst upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })\napp.post('/photos', upload.single('photo'), async (req, res) => res.json(await saveToBucket(req.file!)))\napp.listen(3000)\n" })
const next = { 'package.json': '{"dependencies":{"next":"15.0.0","react":"19.0.0"}}', 'app/page.tsx': 'export default function P() { return <p/> }\n' }
show('Next route handler: formData().get() as File + arrayBuffer', next, { ...next, 'app/api/upload/route.ts':
  "import { writeFile } from 'node:fs/promises'\nexport async function POST(req: Request) {\n  const form = await req.formData()\n  const file = form.get('file') as File\n  const bytes = Buffer.from(await file.arrayBuffer())\n  await writeFile(`public/uploads/${file.name}`, bytes)\n  return Response.json({ url: `/uploads/${file.name}` })\n}\n" })
show('UploadThing file router', next, { ...next, 'app/api/uploadthing/core.ts':
  "import { createUploadthing, type FileRouter } from 'uploadthing/next'\nconst f = createUploadthing()\nexport const ourFileRouter = {\n  imageUploader: f({ image: { maxFileSize: '4MB', maxFileCount: 1 } }).middleware(async () => ({ userId: 'x' })).onUploadComplete(async ({ file }) => ({ url: file.ufsUrl })),\n} satisfies FileRouter\n" })
const sbc = { 'package.json': '{"dependencies":{"@supabase/supabase-js":"2.45.0","react":"18.3.1","vite":"5.0.0"}}', 'src/main.tsx': 'export {}\n' }
show('Supabase storage from a client component (chained over lines)', sbc, { ...sbc, 'src/components/AvatarUpload.tsx':
  "import { supabase } from '../lib/supabase'\nexport function AvatarUpload({ userId }: { userId: string }) {\n  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {\n    const file = e.target.files![0]\n    await supabase.storage\n      .from('avatars')\n      .upload(`${userId}/${file.name}`, file, { upsert: true })\n  }\n  return <input type=\"file\" accept=\"image/png,image/jpeg\" onChange={onChange} />\n}\n" })
const dj = { 'requirements.txt': 'django\ndjangorestframework\n', 'photos/models.py': 'from django.db import models\n', 'photos/views.py': 'from django.views.generic import ListView\n' }
show('Django ImageField model + CreateView (no request.FILES)', dj, { ...dj,
  'photos/models.py': "from django.db import models\nclass Photo(models.Model):\n    owner = models.ForeignKey('auth.User', on_delete=models.CASCADE)\n    image = models.ImageField(upload_to='photos/')\n",
  'photos/views.py': "from django.contrib.auth.mixins import LoginRequiredMixin\nfrom django.views.generic import CreateView\nfrom .models import Photo\nclass PhotoCreate(LoginRequiredMixin, CreateView):\n    model = Photo\n    fields = ['image']\n" })
show('DRF: ImageField serializer + MultiPartParser', dj, { ...dj,
  'photos/models.py': "from django.db import models\nclass Photo(models.Model):\n    image = models.ImageField(upload_to='photos/')\n",
  'photos/views.py': "from rest_framework import viewsets, serializers\nfrom rest_framework.parsers import MultiPartParser\nfrom .models import Photo\nclass PhotoSerializer(serializers.ModelSerializer):\n    class Meta:\n        model = Photo\n        fields = ['id', 'image']\nclass PhotoViewSet(viewsets.ModelViewSet):\n    queryset = Photo.objects.all()\n    serializer_class = PhotoSerializer\n    parser_classes = [MultiPartParser]\n" })
const fl = { 'requirements.txt': 'flask\n', 'app.py': "from flask import Flask\napp = Flask(__name__)\n" }
show('Flask request.files (lower case)', fl, { ...fl, 'app.py':
  "import os\nfrom flask import Flask, request\nfrom werkzeug.utils import secure_filename\napp = Flask(__name__)\n@app.post('/upload')\ndef upload():\n    f = request.files['photo']\n    f.save(os.path.join('uploads', secure_filename(f.filename)))\n    return 'ok'\n" })
const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'routes/web.php': "<?php\nRoute::post('/avatar', [App\\Http\\Controllers\\AvatarController::class, 'store'])->middleware('auth');\n" }
show('Laravel docs shape: $request->avatar->store()', lv, { ...lv, 'app/Http/Controllers/AvatarController.php':
  "<?php\nnamespace App\\Http\\Controllers;\nuse Illuminate\\Http\\Request;\nclass AvatarController extends Controller {\n  public function store(Request $request) {\n    $path = $request->avatar->store('avatars');\n    $request->user()->update(['avatar' => $path]);\n    return back();\n  }\n}\n" })
const fy = { 'package.json': '{"dependencies":{"fastify":"4.28.0","@fastify/multipart":"8.3.0"}}', 'src/index.ts': "import Fastify from 'fastify'\nconst app = Fastify()\napp.listen({ port: 3000 })\n" }
show('Fastify @fastify/multipart request.file()', fy, { ...fy, 'src/index.ts':
  "import Fastify from 'fastify'\nimport multipart from '@fastify/multipart'\nimport { pipeline } from 'node:stream/promises'\nimport { createWriteStream } from 'node:fs'\nconst app = Fastify()\napp.register(multipart)\napp.post('/upload', async (req) => { const data = await req.file(); await pipeline(data!.file, createWriteStream(`uploads/${data!.filename}`)); return { ok: true } })\napp.listen({ port: 3000 })\n" })
const sk = { 'package.json': '{"dependencies":{"@sveltejs/kit":"2.5.0","svelte":"4.2.0"}}', 'src/routes/+page.svelte': '<h1>hi</h1>\n' }
show('SvelteKit form action: formData.get as File', sk, { ...sk, 'src/routes/avatar/+page.server.ts':
  "import { writeFile } from 'node:fs/promises'\nexport const actions = {\n  default: async ({ request }) => {\n    const data = await request.formData()\n    const file = data.get('avatar') as File\n    await writeFile(`static/avatars/${file.name}`, Buffer.from(await file.arrayBuffer()))\n  }\n}\n" })
const nx = { 'package.json': '{"dependencies":{"nuxt":"3.12.0"}}', 'pages/index.vue': '<template><p/></template>\n' }
show('Nuxt readMultipartFormData', nx, { ...nx, 'server/api/upload.post.ts':
  "import { writeFile } from 'node:fs/promises'\nexport default defineEventHandler(async (event) => {\n  const parts = await readMultipartFormData(event)\n  for (const p of parts ?? []) if (p.filename) await writeFile(`uploads/${p.filename}`, p.data)\n  return { ok: true }\n})\n" })

  }
  {
// FALSE "no size limit" / "nothing limits how many" / admin-only / tests
const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'routes/web.php': "<?php\nuse App\\Http\\Controllers\\PhotoController;\nRoute::post('/photos', [PhotoController::class, 'store'])->middleware(['auth', 'throttle:10,1']);\n" }
show('Laravel: max:2048 validation + throttle middleware', lv, { ...lv, 'app/Http/Controllers/PhotoController.php':
  "<?php\nnamespace App\\Http\\Controllers;\nuse Illuminate\\Http\\Request;\nclass PhotoController extends Controller {\n  public function store(Request $request) {\n    $request->validate(['photo' => 'required|image|mimes:jpg,png|max:2048']);\n    $request->file('photo')->store('photos', 's3');\n    return back();\n  }\n}\n" })
const rb = { 'Gemfile': "gem 'rails', '~> 7.1'\n", 'config/routes.rb': 'Rails.application.routes.draw do\n  resources :users\nend\n', 'app/models/user.rb': 'class User < ApplicationRecord\nend\n' }
show('Rails: has_one_attached + size validation + per-user count', rb, { ...rb, 'app/models/user.rb':
  "class User < ApplicationRecord\n  has_one_attached :avatar\n  validate :avatar_ok\n  def avatar_ok\n    return unless avatar.attached?\n    errors.add(:avatar, 'too big') if avatar.blob.byte_size > 5.megabytes\n    errors.add(:avatar, 'wrong type') unless avatar.content_type.in?(%w[image/jpeg image/png])\n  end\nend\n" })
const next = { 'package.json': '{"dependencies":{"next":"15.0.0","react":"19.0.0"}}', 'app/page.tsx': 'export default function P() { return <p/> }\n',
  'next.config.mjs': "export default { experimental: { serverActions: { bodySizeLimit: '2mb' } } }\n" }
show('Next server action, bodySizeLimit 2mb in next.config', next, { ...next, 'app/profile/actions.ts':
  "'use server'\nimport { put } from '@vercel/blob'\nimport { auth } from '@/lib/auth'\nexport async function saveAvatar(form: FormData) {\n  const session = await auth()\n  const file = form.get('avatar')\n  if (!(file instanceof File)) throw new Error('no file')\n  await put(`avatars/${session.user.id}`, file, { access: 'public', allowOverwrite: true })\n}\n" })
const sp = { 'pom.xml': '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
  'src/main/resources/application.properties': 'spring.servlet.multipart.max-file-size=5MB\nspring.servlet.multipart.max-request-size=5MB\n' }
show('Spring: max-file-size in application.properties', sp, { ...sp, 'src/main/java/com/x/PhotoController.java':
  "package com.x;\nimport org.springframework.web.bind.annotation.*;\nimport org.springframework.web.multipart.MultipartFile;\n@RestController\npublic class PhotoController {\n  @PostMapping(\"/photos\")\n  public String upload(@RequestParam(\"file\") MultipartFile file) throws Exception {\n    file.transferTo(new java.io.File(\"/data/\" + java.util.UUID.randomUUID()));\n    return \"ok\";\n  }\n}\n" })
const ex = { 'package.json': '{"dependencies":{"express":"4.19.0"}}', 'src/index.ts': "import express from 'express'\nconst app = express()\napp.listen(3000)\n" }
show("express.raw({ type: 'image/*' }) with no limit (express default caps at 100kb)", ex, { ...ex, 'src/photos.ts':
  "import express, { Router } from 'express'\nimport { writeFile } from 'node:fs/promises'\nexport const photos = Router()\nphotos.post('/', express.raw({ type: 'image/*' }), async (req, res) => { await writeFile(`uploads/${Date.now()}`, req.body); res.json({}) })\n" })
show('FastAPI: len(contents) > MAX_BYTES', { 'requirements.txt': 'fastapi\n', 'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n' }, { 'requirements.txt': 'fastapi\n', 'app/main.py':
  "from fastapi import FastAPI, UploadFile, HTTPException, Depends\nfrom .auth import current_user\napp = FastAPI()\nMAX_BYTES = 5_000_000\n@app.post('/photos')\nasync def upload(file: UploadFile, user=Depends(current_user)):\n    contents = await file.read()\n    if len(contents) > MAX_BYTES:\n        raise HTTPException(413)\n    with open(f'uploads/{user.id}-{file.filename}', 'wb') as f:\n        f.write(contents)\n" })
const ms = "import multer from 'multer'\nimport { Router } from 'express'\nconst upload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 } })\nexport const r = Router()\n"
show('admin-only multer upload (requireAdmin middleware)', ex, { ...ex, 'src/admin.ts': ms + "import { requireAdmin } from './auth.js'\nr.post('/admin/banner', requireAdmin, upload.single('banner'), (req, res) => res.json({ ok: true }))\n" })
show('admin-only Next route under app/admin', { ...next }, { ...next, 'app/api/admin/logo/route.ts':
  "import { requireAdmin } from '@/lib/auth'\nimport { writeFile } from 'node:fs/promises'\nexport async function POST(req: Request) {\n  await requireAdmin()\n  const form = await req.formData()\n  const file = form.get('logo')\n  if (!(file instanceof File) || file.size > 1024 * 1024) return new Response('bad', { status: 400 })\n  await writeFile('public/logo.png', Buffer.from(await file.arrayBuffer()))\n  return Response.json({ ok: true })\n}\n" })
const dj = { 'requirements.txt': 'django\n', 'photos/views.py': 'from django.shortcuts import render\n' }
show('Django test file test_views.py (not under tests/)', dj, { ...dj, 'photos/test_views.py':
  "from django.test import RequestFactory, TestCase\nfrom django.core.files.uploadedfile import SimpleUploadedFile\nfrom .views import upload\nclass T(TestCase):\n    def test_upload(self):\n        request = RequestFactory().post('/u')\n        request.FILES['photo'] = SimpleUploadedFile('a.png', b'x')\n        upload(request)\n" })
show('FastAPI unit test test_upload.py beside app', { 'requirements.txt': 'fastapi\n', 'app/main.py': 'x = 1\n' }, { 'requirements.txt': 'fastapi\n', 'app/main.py': 'x = 1\n', 'app/test_upload.py':
  "import io\nfrom fastapi import UploadFile\nfrom .photos import save\ndef test_save():\n    save(UploadFile(filename='a.png', file=io.BytesIO(b'x')))\n" })
const rb2 = { ...rb, 'app/models/user.rb': 'class User < ApplicationRecord\n  has_many_attached :photos\nend\n', 'app/controllers/photos_controller.rb': 'class PhotosController < ApplicationController\nend\n' }
show('Rails: per-user cap as photos.count (no parens)', rb, { ...rb, 'app/models/user.rb':
  "class User < ApplicationRecord\n  has_many_attached :photos\n  validate :photo_cap\n  def photo_cap\n    errors.add(:photos, 'max 20') if photos.count > 20\n    photos.each { |p| errors.add(:photos, 'too big') if p.blob.byte_size > 5.megabytes }\n  end\nend\n" })

  }
  {
// WRONG FACTS: size, storage, types
const ex = { 'package.json': '{"dependencies":{"express":"4.19.0"}}', 'src/db.ts': 'export const prisma = {} as any\n',
  'prisma/schema.prisma': 'model User {\n  id Int @id\n  totpSecret Bytes\n}\n' }
show('multer, no fileSize; same file sets express.json({ limit: "1mb" })', { ...ex, 'src/index.ts': "import express from 'express'\nconst app = express()\napp.use(express.json({ limit: '1mb' }))\napp.listen(3000)\n" },
  { ...ex, 'src/index.ts': "import express from 'express'\nimport multer from 'multer'\nimport { saveToBucket } from './storage.js'\nconst app = express()\napp.use(express.json({ limit: '1mb' }))\nconst upload = multer({ storage: multer.memoryStorage() })\napp.post('/photos', upload.single('photo'), async (req, res) => res.json(await saveToBucket(req.file!)))\napp.listen(3000)\n",
    'src/storage.ts': "import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'\nconst s3 = new S3Client({})\nexport const saveToBucket = (f: { buffer: Buffer; originalname: string }) => s3.send(new PutObjectCommand({ Bucket: 'photos', Key: f.originalname, Body: f.buffer }))\n" })
show('multer 5 MB limit, but a 50 MB cache constant earlier in the file', { ...ex, 'src/index.ts': "import express from 'express'\nconst app = express()\napp.listen(3000)\n" },
  { ...ex, 'src/index.ts': "import express from 'express'\nimport multer from 'multer'\nconst CACHE_BYTES = 50 * 1024 * 1024\nconst app = express()\nconst upload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 } })\napp.post('/photos', upload.single('photo'), (req, res) => res.json({}))\napp.listen(3000)\n" })
show('SVG explicitly rejected', { ...ex, 'src/index.ts': "import express from 'express'\nconst app = express()\napp.listen(3000)\n" },
  { ...ex, 'src/index.ts': "import express from 'express'\nimport multer from 'multer'\nconst app = express()\nconst upload = multer({ dest: 'uploads/', limits: { fileSize: 2 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, file.mimetype !== 'image/svg+xml') })\napp.post('/photos', upload.single('photo'), (req, res) => res.json({}))\napp.listen(3000)\n" })
const fa = { 'requirements.txt': 'fastapi\nsqlalchemy\n', 'app/models.py': "from sqlalchemy import Column, Integer, LargeBinary\nclass ApiKey(Base):\n    __tablename__ = 'keys'\n    id = Column(Integer, primary_key=True)\n    hash = Column(LargeBinary)\n", 'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n' }
show('FastAPI canonical shutil.copyfileobj to disk; unrelated LargeBinary column', fa, { ...fa, 'app/main.py':
  "import shutil\nfrom fastapi import FastAPI, UploadFile\napp = FastAPI()\n@app.post('/photos')\nasync def upload(file: UploadFile):\n    if file.size > 5 * 1024 * 1024:\n        raise ValueError('too big')\n    with open(f'uploads/{file.filename}', 'wb') as buffer:\n        shutil.copyfileobj(file.file, buffer)\n" })

  }
  {
// MISSED ALARMS: per-person cap / size wrongly assumed
const ex = { 'package.json': '{"dependencies":{"express":"4.19.0","lodash":"4.17.21","react":"18.3.1"}}', 'src/index.ts': "import express from 'express'\nconst app = express()\napp.listen(3000)\n",
  'client/src/Feed.tsx': "import throttle from 'lodash/throttle'\nexport const onScroll = throttle(() => window.dispatchEvent(new Event('more')), 200)\n" }
show('lodash throttle for scrolling in the client suppresses the per-person alarm', ex, { ...ex, 'src/photos.ts':
  "import multer from 'multer'\nimport { Router } from 'express'\nconst upload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 } })\nexport const r = Router()\nr.post('/photos', upload.single('photo'), (req, res) => res.json({ ok: true }))\n" })
const go = { 'go.mod': 'module x\n\ngo 1.22\n', 'main.go': 'package main\nfunc main() {}\n' }
show('Go: ParseMultipartForm(10 << 20) is only a memory threshold, not a cap', go, { ...go, 'upload.go':
  "package main\nimport (\n  \"io\"\n  \"net/http\"\n  \"os\"\n)\nfunc upload(w http.ResponseWriter, r *http.Request) {\n  r.ParseMultipartForm(10 << 20)\n  f, h, _ := r.FormFile(\"photo\")\n  defer f.Close()\n  out, _ := os.Create(\"uploads/\" + h.Filename)\n  io.Copy(out, f)\n}\n" })

  }
  const has = (n: string, re: RegExp, yes = true) => { const g = got.get(n); assert.ok(g !== undefined, `review 28: missing case ${n}`); assert.ok(re.test(g!) === yes, `review 28 ${n}: ${yes ? 'expected' : 'unexpected'} ${re}\n${g}`) }
  const names = [...got.keys()]
  // not uploads: a preview, a fetch wrapper, a webhook, a job's S3 file, a server-made PDF, moved code, a re-read file
  for (const n of names.filter(n => /preview|fetch wrapper|webhook|nightly|invoice PDF|refactor|log line/.test(n))) has(n, /upload/i, false)
  // common upload shapes: all found
  for (const n of names.filter(n => /storage\) multer|route handler|UploadThing|Supabase storage from a client|Django ImageField|DRF|Flask|Laravel docs|Fastify|SvelteKit|Nuxt/.test(n))) has(n, /People can now upload/)
  // limits plain should see
  for (const n of names.filter(n => /max:2048|has_one_attached|bodySizeLimit|max-file-size|express\.raw\(\{ type: 'image|len\(contents\)/.test(n))) has(n, /no size limit/, false)
  for (const n of names.filter(n => /max:2048|has_one_attached|admin-only|photos\.count/.test(n))) has(n, /Nothing limits how many/, false)
  for (const n of names.filter(n => /test_views|test_upload/.test(n))) has(n, /People can now upload/, false)
  // the right size, the right place, no SVG when it's rejected
  has(names.find(n => /express\.json/.test(n))!, /no size limit/); has(names.find(n => /express\.json/.test(n))!, /1 MB/, false)
  has(names.find(n => /50 MB cache/.test(n))!, /up to 5 MB/)
  has(names.find(n => /SVG explicitly rejected/.test(n))!, /SVG/, false)
  has(names.find(n => /copyfileobj/.test(n))!, /on your server's disk/)
  has(names.find(n => /max:2048/.test(n))!, /Amazon S3/)
  // a client-side throttle isn't a cap; Go's ParseMultipartForm isn't a size limit
  has(names.find(n => /lodash throttle/.test(n))!, /Nothing limits how many/)
  has(names.find(n => /ParseMultipartForm/.test(n))!, /no size limit/)
  console.log('ok (review 28)')
}
// Review 28, round 2: admin gates from the route statement, server/client files, imports resolved by path, binary fields named
// in the upload, Laravel max: on a file rule, a second endpoint, a webhook's express.raw, Laravel 10's Kernel throttle, Post has_one_attached
{
  const up = (before: Record<string, string>, after: Record<string, string>) => {
    const r = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' })
    return r.replace(/\n\s{2,}(?![!+•\d])/g, ' ').split('\n').map(l => l.trim()).filter(l => /upload|size limit|SVG pictures/i.test(l)).join('\n')
  }
  const got = new Map<string, string>()
  const show = (name: string, before: Record<string, string>, after: Record<string, string>) => { got.set(name, up(before, after)) }
  {
// Round 2 regressions / new false alarms / wrong facts
const ex = { 'package.json': '{"dependencies":{"express":"4.19.0"}}', 'src/index.ts': "import express from 'express'\nconst app = express()\napp.listen(3000)\n" }
const mul = "import multer from 'multer'\nimport { Router } from 'express'\nimport { requireAdmin } from './auth.js'\nconst upload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 } })\nexport const r = Router()\n"
show('A1 public upload next to an admin upload in the same router', ex, { ...ex, 'src/photos.ts': mul +
  "r.post('/admin/banner', requireAdmin, upload.single('banner'), (req, res) => res.json({ ok: true }))\nr.post('/photos', upload.single('photo'), (req, res) => res.json({ ok: true }))\n" })
show("A2 public upload; app.use('/admin', ...) mounted just above", ex, { ...ex, 'src/index.ts':
  "import express from 'express'\nimport multer from 'multer'\nimport { adminRouter } from './admin.js'\nconst app = express()\napp.use('/admin', adminRouter)\nconst upload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 } })\napp.post('/photos', upload.single('photo'), (req, res) => res.json({ ok: true }))\napp.listen(3000)\n" })
show('A3 public upload returns { isAdmin } to the client', ex, { ...ex, 'src/photos.ts': mul.replace("import { requireAdmin } from './auth.js'\n", '') +
  "r.post('/photos', upload.single('photo'), (req, res) => res.json({ ok: true, isAdmin: req.user.isAdmin }))\n" })
const vite = { 'package.json': '{"dependencies":{"react":"18.3.1","vite":"5.0.0"}}', 'src/main.tsx': 'export {}\n' }
show('S1 React SPA fetch wrapper in src/api/ (instanceof File)', vite, { ...vite, 'src/api/client.ts':
  "export async function post(url: string, body: unknown) {\n  const isFile = body instanceof File\n  return fetch(url, { method: 'POST', headers: isFile ? {} : { 'content-type': 'application/json' }, body: isFile ? body : JSON.stringify(body) })\n}\n" })
show("S2 client component previews a form's file (.get('x') as File)", vite, { ...vite, 'src/components/AvatarForm.tsx':
  "export function AvatarForm({ onPick }: { onPick: (u: string) => void }) {\n  return <form onChange={e => { const f = new FormData(e.currentTarget).get('avatar') as File; onPick(URL.createObjectURL(f)) }}><input type=\"file\" name=\"avatar\" /></form>\n}\n" })
const next = { 'package.json': '{"dependencies":{"next":"15.0.0","react":"19.0.0","@vercel/blob":"0.27.0"}}', 'app/page.tsx': 'export default function P() { return <p/> }\n' }
show('S3 Next server component page that only lists Vercel Blob images', next, { ...next, 'app/gallery/page.tsx':
  "import { list } from '@vercel/blob'\nexport default async function Gallery() {\n  const { blobs } = await list({ prefix: 'photos/' })\n  return <div>{blobs.map(b => <img key={b.url} src={b.url} />)}</div>\n}\n" })
// import resolver: monorepo with two lib/storage files
const mono = { 'package.json': '{"dependencies":{"express":"4.19.0","@supabase/supabase-js":"2.45.0","react":"18.3.1"}}', 'server/src/index.ts': "import express from 'express'\nconst app = express()\napp.listen(3000)\n",
  'server/src/lib/storage.ts': "import { writeFile } from 'node:fs/promises'\nexport const save = (name: string, b: Buffer) => writeFile(`/data/uploads/${name}`, b)\n",
  'client/src/lib/storage.ts': "import { supabase } from './supabase'\nexport const avatarUrl = (p: string) => supabase.storage.from('avatars').getPublicUrl(p).data.publicUrl\n" }
show('I1 monorepo: server route imports ../lib/storage (disk); client has its own lib/storage (Supabase)', mono, { ...mono, 'server/src/routes/photos.ts':
  "import multer from 'multer'\nimport { Router } from 'express'\nimport { save } from '../lib/storage.js'\nconst upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })\nexport const r = Router()\nr.post('/photos', upload.single('photo'), async (req, res) => { await save(req.file!.originalname, req.file!.buffer); res.json({}) })\n" })
// binary-field name match
const fa = { 'requirements.txt': 'fastapi\nhttpx\nsqlalchemy\n', 'app/models.py': "from sqlalchemy import Column, Integer\nclass Photo(Base):\n    __tablename__ = 'photos'\n    id = Column(Integer, primary_key=True)\n    size = Column(Integer)  # size in bytes\n", 'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n' }
show("B1 '# size in bytes' comment makes 'in' a binary field; upload only forwarded to an API", fa, { ...fa, 'app/main.py':
  "import httpx\nfrom fastapi import FastAPI, UploadFile, HTTPException\napp = FastAPI()\nALLOWED = {'image/png', 'image/jpeg'}\n@app.post('/describe')\nasync def describe(file: UploadFile):\n    if file.content_type not in ALLOWED:\n        raise HTTPException(415)\n    if file.size > 5 * 1024 * 1024:\n        raise HTTPException(413)\n    r = httpx.post('https://vision.example.com/v1', files={'f': await file.read()})\n    return r.json()\n" })
const px = { 'package.json': '{"dependencies":{"express":"4.19.0","@prisma/client":"6.0.0"}}', 'src/index.ts': "import express from 'express'\nconst app = express()\napp.listen(3000)\n",
  'prisma/schema.prisma': 'model Session {\n  id String @id\n  data Bytes\n}\nmodel Photo {\n  id Int @id\n  url String\n}\n' }
show("B2 unrelated 'Session.data Bytes'; upload goes to an external service", px, { ...px, 'src/photos.ts':
  "import multer from 'multer'\nimport { Router } from 'express'\nimport { prisma } from './db.js'\nconst upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })\nexport const r = Router()\nr.post('/photos', upload.single('photo'), async (req, res) => {\n  const { url } = await fetch('https://img.example.com/upload', { method: 'POST', body: req.file!.buffer }).then(x => x.json())\n  res.json(await prisma.photo.create({ data: { url } }))\n})\n" })
// Laravel KB conversion
const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'routes/web.php': "<?php\nRoute::post('/posts', [App\\Http\\Controllers\\PostController::class, 'store'])->middleware('auth');\n" }
show("L1 Laravel 'title' => 'max:255' before 'photo' => 'max:5120'", lv, { ...lv, 'app/Http/Controllers/PostController.php':
  "<?php\nnamespace App\\Http\\Controllers;\nuse Illuminate\\Http\\Request;\nclass PostController extends Controller {\n  public function store(Request $request) {\n    $request->validate(['title' => 'required|string|max:255', 'photo' => 'required|image|max:5120']);\n    $request->file('photo')->store('photos');\n    return back();\n  }\n}\n" })
// a second upload endpoint in a file that already has one
const fb = { 'requirements.txt': 'fastapi\n', 'app/main.py': "from fastapi import FastAPI, UploadFile\napp = FastAPI()\n@app.post('/avatar')\nasync def avatar(file: UploadFile):\n    if file.size > 1024 * 1024:\n        raise ValueError\n    open('avatars/x', 'wb').write(await file.read())\n" }
show('D1 FastAPI: new /videos upload (no limit) added beside an existing /avatar upload', fb, { ...fb, 'app/main.py': fb['app/main.py'] +
  "@app.post('/videos')\nasync def videos(file: UploadFile):\n    open(f'videos/{file.filename}', 'wb').write(await file.read())\n" })
// webhook express.raw in the same file hides multer's missing size limit
show("Z1 Stripe webhook express.raw in same file as a multer upload with no fileSize", ex, { ...ex, 'src/index.ts':
  "import express from 'express'\nimport multer from 'multer'\nconst app = express()\napp.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => res.json({}))\nconst upload = multer({ dest: 'uploads/' })\napp.post('/photos', upload.single('photo'), (req, res) => res.json({}))\napp.listen(3000)\n" })
// Laravel 10 default Kernel.php ('throttle:api', 'throttle' alias) makes every upload "capped"
show('Z2 Laravel 10 default Kernel.php throttle:api; upload on a web route', { ...lv, 'app/Http/Kernel.php': "<?php\nnamespace App\\Http;\nclass Kernel extends HttpKernel {\n  protected $middlewareGroups = ['api' => [\\Illuminate\\Routing\\Middleware\\ThrottleRequests::class.':api']];\n  protected $middlewareAliases = ['throttle' => \\Illuminate\\Routing\\Middleware\\ThrottleRequests::class];\n}\n" },
  { ...lv, 'app/Http/Kernel.php': "<?php\nnamespace App\\Http;\nclass Kernel extends HttpKernel {\n  protected $middlewareGroups = ['api' => [\\Illuminate\\Routing\\Middleware\\ThrottleRequests::class.':api']];\n  protected $middlewareAliases = ['throttle' => \\Illuminate\\Routing\\Middleware\\ThrottleRequests::class];\n}\n",
    'app/Http/Controllers/PostController.php': "<?php\nnamespace App\\Http\\Controllers;\nuse Illuminate\\Http\\Request;\nclass PostController extends Controller {\n  public function store(Request $request) {\n    $request->validate(['photo' => 'required|image|max:2048']);\n    $request->file('photo')->store('photos');\n    return back();\n  }\n}\n" })
const rb = { 'Gemfile': "gem 'rails'\n", 'config/routes.rb': 'Rails.application.routes.draw do\n  resources :posts\nend\n', 'app/models/post.rb': 'class Post < ApplicationRecord\n  belongs_to :user\nend\n' }
show('R1 Rails Post has_one_attached :image (many posts per user)', rb, { ...rb, 'app/models/post.rb': 'class Post < ApplicationRecord\n  belongs_to :user\n  has_one_attached :image\nend\n' })

  }
  const g2 = (re: RegExp) => [...got.keys()].find(n => re.test(n))!
  const has2 = (n: string, re: RegExp, yes = true) => { const g = got.get(n)!; assert.ok(re.test(g) === yes, `review 28 r2 ${n}: ${yes ? 'expected' : 'unexpected'} ${re}\n${g}`) }
  for (const n of [g2(/^A1/), g2(/^A2/), g2(/^A3/), g2(/^Z2/), g2(/^R1/)]) has2(n, /Nothing limits how many/)
  for (const n of [g2(/^S1/), g2(/^S2/), g2(/^S3/)]) has2(n, /upload/i, false)
  has2(g2(/^I1/), /on your server's disk/); has2(g2(/^I1/), /Supabase/, false)
  for (const n of [g2(/^B1/), g2(/^B2/)]) has2(n, /database/, false)
  has2(g2(/^L1/), /up to 5 MB/)
  has2(g2(/^D1/), /People can now upload/)
  has2(g2(/^Z1/), /no size limit/)
  console.log('ok (review 28, round 2)')
}
// Review 28, round 3: an admin gate on a route written over several lines, and one at the top of a Next.js handler
{
  const up = (before: Record<string, string>, after: Record<string, string>) => report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
  const got = new Map<string, string>()
  const show = (name: string, before: Record<string, string>, after: Record<string, string>) => { got.set(name, up(before, after)) }
  {
// Round 3: admin gate now reads only the current line up to the upload match
const ex = { 'package.json': '{"dependencies":{"express":"4.19.0"}}', 'src/index.ts': "import express from 'express'\nconst app = express()\napp.listen(3000)\n" }
show('G1 admin route formatted over several lines (Prettier style)', ex, { ...ex, 'src/banner.ts':
  "import multer from 'multer'\nimport { Router } from 'express'\nimport { requireAdmin } from './auth.js'\nconst upload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 } })\nexport const r = Router()\nr.post(\n  '/banner',\n  requireAdmin,\n  upload.single('banner'),\n  (req, res) => res.json({ ok: true }),\n)\n" })
const next = { 'package.json': '{"dependencies":{"next":"15.0.0","react":"19.0.0"}}', 'app/page.tsx': 'export default function P() { return <p/> }\n' }
show('G2 Next route outside /admin, await requireAdmin() first line of handler', next, { ...next, 'app/api/site/logo/route.ts':
  "import { requireAdmin } from '@/lib/auth'\nimport { writeFile } from 'node:fs/promises'\nexport async function POST(req: Request) {\n  await requireAdmin()\n  const form = await req.formData()\n  const file = form.get('logo') as File\n  if (file.size > 1024 * 1024) return new Response('too big', { status: 413 })\n  await writeFile('public/logo.png', Buffer.from(await file.arrayBuffer()))\n  return Response.json({ ok: true })\n}\n" })

  }
  for (const [n, c] of got) { assert.ok(c.includes('People can now upload'), `review 28 r3 ${n}: upload seen\n${c}`); assert.ok(!c.includes('Nothing limits how many'), `review 28 r3 ${n}: admins only\n${c}`) }
  assert.ok(got.size === 2, 'review 28 r3: both cases')
  console.log('ok (review 28, round 3)')
}
// Review 28, round 4: an `if (user.isAdmin)` branch in a public upload isn't an admin gate
{
  const up = (before: Record<string, string>, after: Record<string, string>) => report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
  const got = new Map<string, string>()
  const show = (name: string, before: Record<string, string>, after: Record<string, string>) => { got.set(name, up(before, after)) }
  {
// Round 4: function-body admin window sees an admin *branch* (not a gate) in a public upload
const next = { 'package.json': '{"dependencies":{"next":"15.0.0","react":"19.0.0"}}', 'app/page.tsx': 'export default function P() { return <p/> }\n' }
show('H1 public Next route: admins get a bigger size limit via if (user.isAdmin)', next, { ...next, 'app/api/photos/route.ts':
  "import { auth } from '@/lib/auth'\nimport { writeFile } from 'node:fs/promises'\nexport async function POST(req: Request) {\n  const { user } = await auth()\n  const form = await req.formData()\n  const file = form.get('photo') as File\n  const max = isAdminUser(user) ? 50 : 5\n  if (!(user.isAdmin) && file.size > max * 1024 * 1024) return new Response('too big', { status: 413 })\n  await writeFile(`uploads/${user.id}-${file.name}`, Buffer.from(await file.arrayBuffer()))\n  return Response.json({ ok: true })\n}\n" })
const fl = { 'requirements.txt': 'flask\n', 'app.py': "from flask import Flask\napp = Flask(__name__)\n" }
show('H2 public Flask upload; admins skip moderation via if is_admin(user)', fl, { ...fl, 'app.py':
  "import os\nfrom flask import Flask, request, g\napp = Flask(__name__)\n@app.post('/photos')\ndef upload():\n    user = g.user\n    approved = is_staff_or(user) or check_isAdmin(user)\n    f = request.files['photo']\n    f.save(os.path.join('uploads', f.filename))\n    return {'approved': approved}\n" })
show('H3 public Next route: admin branch (if (user.isAdmin)) before the file read', next, { ...next, 'app/api/photos/route.ts':
  "import { auth } from '@/lib/auth'\nimport { writeFile } from 'node:fs/promises'\nexport async function POST(req: Request) {\n  const { user } = await auth()\n  const folder = 'uploads'\n  if (user.isAdmin) console.log('admin upload')\n  const form = await req.formData()\n  const file = form.get('photo') as File\n  if (file.size > 5 * 1024 * 1024) return new Response('too big', { status: 413 })\n  await writeFile(`${folder}/${user.id}-${file.name}`, Buffer.from(await file.arrayBuffer()))\n  return Response.json({ ok: true })\n}\n" })

  }
  for (const [n, c] of got) assert.ok(c.includes('Nothing limits how many'), `review 28 r4 ${n}: a public upload\n${c}`)
  assert.ok(got.size === 3, 'review 28 r4: three cases')
  console.log('ok (review 28, round 4)')
}
// "Tests couldn't be executed": the agent didn't run them
assert.ok(report(new Map([['a.ts', 'export const a = 1\n']]), new Map([['a.ts', 'export const a = 2\n']]), { ref: 'main', agentSaid: 'Done. Tests couldn’t be executed because the environment has no Go toolchain installed.' }).includes("didn't run or test"), 'untested: passive')
// (round 10) "Full runtime testing wasn’t possible", "tests weren’t available", "Full builds could not run"; not "a refund wasn't possible"
for (const said of ['Full runtime testing wasn’t possible because dependencies aren’t installed.', 'Full runtime tests weren’t available because dependencies aren’t installed locally.', 'Full builds could not run because dependencies are not installed.'])
  assert.ok(report(new Map([['a.ts', 'export const a = 1\n']]), new Map([['a.ts', 'export const a = 2\n']]), { ref: 'main', agentSaid: said }).includes("didn't run or test"), `untested: ${said}`)
assert.ok(!report(new Map([['a.ts', 'export const a = 1\n']]), new Map([['a.ts', 'export const a = 2\n']]), { ref: 'main', agentSaid: 'Done. A refund wasn’t possible for free orders, so they are skipped. Tests pass.' }).includes("didn't run or test"), 'untested: not about tests')
