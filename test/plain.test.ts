// One end-to-end check: a tiny repo, one change with planted issues, assert plain names each one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { report, snapshot } from '../src/plain.ts'
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
  '⚠ 3 problems  ·  5 loose ends  ·  4 steps before you ship',           // verdict first
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
  'an email box and a password box', '⚠ VITE_SUPABASE_SERVICE_ROLE_KEY is a secret', 'Anyone can change bookings'])
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
  'deletes every row of messages', 'run `supabase db push`', "Add STRIPE_SECRET_KEY to your Supabase project's secrets", "aren't visible to plain"])
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
assert.ok(good.includes('✓ Nothing looks broken') && good.includes('! Anyone, even without logging in, can read all reviews'), good)
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
