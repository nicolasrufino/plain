// One end-to-end check: a tiny repo, one change with planted issues, assert plain names each one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { report, snapshot, tanstackRoute, appFacts, type FileFacts } from '../src/plain.ts'
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
    '⚠ Anyone can use the order cancel part', 'New server code that deletes orders. /orders/[pk]/cancel', 'lists coupons, saves new ones and requires login ✓. /coupons/[code]',
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
  for (const e of ['lists orders, deletes orders and requires login ✓. /api/orders', '⚠ Anyone can use the order cancel part of your server without logging in.', 'Add STRIPE_SECRET_KEY'])
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
