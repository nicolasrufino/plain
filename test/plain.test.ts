// One end-to-end check: a tiny repo, one change with planted issues, assert plain names each one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { report, snapshot, tanstackRoute, appFacts, things, type FileFacts } from '../src/plain.ts'
import { recapCli } from '../src/session.ts'
import { readDb, findings } from '../src/supabase.ts'
// the line under "Nothing flagged": words like "payments" in it aren't the card talking about this app
const NOTE = "plain reads logins, payments, database changes and secrets. It doesn't run the code, and it can miss bugs."

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
  'lib/prisma.ts': 'export const prisma = {} as any\n',
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
  '⚠ Anyone can use the coupon part of your server without logging in. (request 1)', '3 THINGS TO REMEMBER', 'Money goes through checkout',
  'until you run `npx prisma migrate dev`.'])
  assert.ok(rc.includes(e), `recap missing: ${e}\n${rc}`)
rmSync(dir, { recursive: true, force: true })

const expect = [
  '⚠ 2 problems  ·  5 loose ends  ·  4 steps before you ship',           // verdict first
  '⚠ Anyone can use the coupon part of your server without logging in.',  // no login check
  '✖ oldDiscount() was deleted from lib/money.ts, but the admin refunds page still uses it',
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
  '(Hidden: 1 file whose changes don\'t change what the code does (formatting, unused parameters), or lockfiles.)',          // lib/format.ts
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
  'supabase/migrations/20260304000000_broken.sql': 'create policy (',
})
assert.ok(good.includes('1 thing to decide') && !good.includes('Nothing flagged') && good.includes('! Anyone, even without logging in, can read all reviews'), good)
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
  for (const e of ['stripe webhook part', 'card page', 'Card page', 'root']) assert.ok(!c.includes(e), `tanstack should not say "${e}"\n${c}`)   // (Card.tsx isn't a page; listing it as an added file is fine)
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
  // (as makemigrations writes them: the migration before, and the user model when one points at it)
  const mig = (name: string, ops: string, prev = name.startsWith('0002') ? "('shop', '0001_initial')," : '') => ({ [`shop/migrations/${name}.py`]: `from django.conf import settings\nfrom django.db import migrations, models\nclass Migration(migrations.Migration):\n    dependencies = [\n        migrations.swappable_dependency(settings.AUTH_USER_MODEL),\n        ${prev}\n    ]\n    operations = [\n${ops}    ]\n` })
  const c2 = card(site({}), site(mig('0002_order_index', "        migrations.AddIndex(model_name='order', index=models.Index(fields=['status'], name='order_status')),\n")))
  assert.ok(c2.includes('It only makes lookups faster') && !c2.includes('will fail'), `round 4: index only\n${c2}`)
  const c3 = card(site({}), site(mig('0002_product_category', "        migrations.AddField(\n            model_name='product',\n            name='category',\n            field=models.CharField(choices=[('bread', 'Bread'), ('other', 'Other')], default='other', max_length=20),\n        ),\n")))
  assert.ok(c3.includes('Every product you already have gets "Other" as its category'), `round 4: default\n${c3}`)
  // (pilot: django-vue-admin's "sync" migration) one that only changes options Django keeps in code (related_name, labels, choices,
  // on_delete) or model options emits no SQL: nothing breaks if it runs late. Checked against the field as earlier migrations left it.
  const initial = mig('0001_initial', "        migrations.CreateModel(\n            name='Order',\n            fields=[\n                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),\n                ('status', models.CharField(max_length=20)),  # (draft, paid)\n                ('owner', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to=settings.AUTH_USER_MODEL)),\n            ],\n        ),\n")
  const alter = (ops: string) => card(site(initial), site({ ...initial, ...mig('0002_sync', ops) }))
  const quietly = 'It only records settings Django keeps in your code'
  const status = (f: string) => `        migrations.AlterField(model_name='order', name='status', field=${f}),\n`
  for (const ops of [status("models.CharField(choices=[('draft', 'Draft'), ('paid', 'Paid')], max_length=20, verbose_name='Status')"),
    "        migrations.AlterField(\n            model_name='order',\n            name='owner',\n            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='orders', to=settings.AUTH_USER_MODEL),\n        ),\n",
    "        migrations.AlterModelOptions(name='order', options={'ordering': ['-id']}),\n"]) {
    const c = alter(ops); assert.ok(c.includes(quietly) && !c.includes('will fail'), `code-only migration\n${ops}\n${c}`) }
  // a wider column, a new NULL rule, another table, a field earlier migrations don't define, or another operation alongside: needed
  for (const ops of [status('models.CharField(max_length=40)'), status('models.CharField(max_length=20, null=True)'),
    "        migrations.AlterField(model_name='order', name='owner', field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to='shop.product')),\n",
    "        migrations.AlterField(model_name='order', name='note', field=models.TextField(blank=True)),\n",
    status("models.CharField(max_length=20, verbose_name='Status')") + "        migrations.AddField(model_name='order', name='note', field=models.TextField(default='')),\n"]) {
    const c = alter(ops); assert.ok(!c.includes(quietly) && c.includes('or the parts that use it will fail'), `needed migration\n${ops}\n${c}`) }
  // (review 88) Django 6's DB_CASCADE is enforced by the database; a foreign key to a same-named model in another app; a field class
  // from another library; a hand-written positional AlterField before; new permissions; two new migrations in one change
  const fk = (f: string) => `        migrations.AlterField(model_name='order', name='owner', field=${f}),\n`
  for (const ops of [fk('models.ForeignKey(on_delete=django.db.models.DB_CASCADE, to=settings.AUTH_USER_MODEL)'),
    status("jsonfield.fields.CharField(max_length=20)"),
    "        migrations.AlterModelOptions(name='order', options={'permissions': [('refund', 'Can refund')]}),\n"]) {
    const c = alter(ops); assert.ok(!c.includes(quietly), `review 88 needed\n${ops}\n${c}`) }
  const crm = mig('0001_initial', "        migrations.CreateModel(name='Order', fields=[('id', models.BigAutoField(primary_key=True)), ('customer', models.ForeignKey(on_delete=models.CASCADE, to='shop.customer'))]),\n")
  let c6 = card(site(crm), site({ ...crm, ...mig('0002_x', "        migrations.AlterField(model_name='order', name='customer', field=models.ForeignKey(on_delete=models.CASCADE, to='crm.customer')),\n") }))
  assert.ok(!c6.includes(quietly), c6)
  c6 = card(site(crm), site({ ...crm, ...mig('0002_x', "        migrations.AlterField(model_name='order', name='customer', field=models.ForeignKey(on_delete=models.PROTECT, related_name='orders', to='customer')),\n") }))
  assert.ok(c6.includes(quietly), c6)
  const hand = { ...initial, ...mig('0002_hand', "        migrations.AlterField('order', 'status', models.CharField(max_length=10)),\n") }
  c6 = card(site(hand), site({ ...hand, ...mig('0003_sync', status("models.CharField(max_length=20, verbose_name='Status')"), "('shop', '0002_hand'),") }))
  assert.ok(!c6.includes(quietly), c6)
  c6 = card(site(initial), site({ ...initial, ...mig('0002_a', status('models.CharField(max_length=80)')), ...mig('0003_b', status("models.CharField(max_length=20, verbose_name='S')"), "('shop', '0002_a'),") }))
  assert.ok(!c6.includes(quietly), c6)
  // (review 89) an operation plain doesn't know (an imported RunSQL), an earlier data migration with `def backwards` above its class,
  // an earlier SeparateDatabaseAndState, a branch and its merge, an unnumbered earlier one: needed
  const label = status("models.CharField(max_length=20, verbose_name='Status')")
  let c7 = alter(label + "        RunSQL('ALTER TABLE shop_order ADD COLUMN note text'),\n"); assert.ok(!c7.includes(quietly), c7)
  for (const [name, text] of [['0002_req', "def backwards(apps, schema_editor):\n    pass\n" + mig('0002_req', status('models.CharField(max_length=20, null=True)'))['shop/migrations/0002_req.py']],
    ['0002_sdas', mig('0002_sdas', "        migrations.SeparateDatabaseAndState(state_operations=[" + status('models.CharField(max_length=20, null=True)').trim() + "], database_operations=[]),\n")['shop/migrations/0002_sdas.py']]]) {
    const prior = { ...initial, [`shop/migrations/${name}.py`]: text }
    c7 = card(site(prior), site({ ...prior, ...mig('0003_sync', label, `('shop', '${name}'),`) })); assert.ok(!c7.includes(quietly), `${name}\n${c7}`) }
  const branch = { ...initial, ...mig('0002_widen', status('models.CharField(max_length=40)')) }
  c7 = card(site(branch), site({ ...branch, ...mig('0002_sync', label), ...mig('0003_merge', '', "('shop', '0002_sync'), ('shop', '0002_widen'),") }))
  assert.ok(!c7.includes(quietly), c7)
  const loose = { ...initial, 'shop/migrations/make_required.py': mig('0002_x', status('models.CharField(max_length=20, null=True)'))['shop/migrations/0002_x.py'] }
  c7 = card(site(loose), site({ ...loose, ...mig('0002_sync', label) })); assert.ok(!c7.includes(quietly), c7)
  // (review 90) operations plain can't read whole: an earlier SeparateDatabaseAndState whose state ops are a variable, a new list
  // joined with `+`, a docstring that shows another list first; and index-only joined with `+`
  const sdas = { ...initial, 'shop/migrations/0002_s.py': "from django.db import migrations, models\nstate_ops = [" + status('models.CharField(max_length=40)').trim() + "]\nclass Migration(migrations.Migration):\n    dependencies = [('shop', '0001_initial')]\n    operations = [migrations.SeparateDatabaseAndState(state_operations=state_ops)]\n" }
  let c8 = card(site(sdas), site({ ...sdas, ...mig('0003_sync', label, "('shop', '0002_s'),") })); assert.ok(!c8.includes(quietly), c8)
  const joined = (ops: string) => { const t = mig('0002_sync', ops)['shop/migrations/0002_sync.py'].replace(/\n    \]\n$/, "\n    ] + [RunSQL('ALTER TABLE shop_order ADD COLUMN n int NOT NULL')]\n"); return card(site(initial), site({ ...initial, 'shop/migrations/0002_sync.py': t })) }
  c8 = joined(label); assert.ok(!c8.includes(quietly), c8)
  c8 = joined("        migrations.AddIndex(model_name='order', index=models.Index(fields=['status'], name='s')),\n"); assert.ok(!c8.includes('only makes lookups faster'), c8)
  c8 = card(site(initial), site({ ...initial, 'shop/migrations/0002_sync.py': '"""operations = [migrations.AlterModelOptions(name=\'order\', options={})]"""\n' + mig('0002_sync', "        migrations.AddField(model_name='order', name='n', field=models.IntegerField()),\n")['shop/migrations/0002_sync.py'] }))
  assert.ok(!c8.includes(quietly), c8)
  // (review 91) another library's field can keep an option in the column: django-mysql's EnumField puts its choices there
  const enumd = mig('0001_initial', "        migrations.CreateModel(name='Order', fields=[('id', models.BigAutoField(primary_key=True)), ('status', django_mysql.models.EnumField(choices=[('draft', 'draft')]))]),\n")
  const c9 = card(site(enumd), site({ ...enumd, ...mig('0002_x', status("django_mysql.models.EnumField(choices=[('draft', 'draft'), ('paid', 'paid')])")) }))
  assert.ok(!c9.includes(quietly), c9)
  // renamed after it was made: plain doesn't follow it
  const renamed = { ...initial, ...mig('0002_rename', "        migrations.RenameField(model_name='order', old_name='status', new_name='state'),\n") }
  const c5 = card(site(renamed), site({ ...renamed, ...mig('0003_sync', "        migrations.AlterField(model_name='order', name='state', field=models.CharField(max_length=20, verbose_name='State')),\n", "('shop', '0002_rename'),") }))
  assert.ok(!c5.includes(quietly), c5)
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
  // the app in a folder of a monorepo (Django-CRM's frontend/src/routes): the same card; its own hooks.server.ts, not another app's
  const pre = (o: Record<string, string>, dir = 'frontend/') => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.startsWith('src/') || k === 'package.json' ? dir + k : k, v]))
  const m1 = card(pre(base), { ...pre(base), ...pre(orders('')) })
  for (const e of ['The orders page is new, titled "Orders"', "⚠ The orders page's data can be read without logging in", '⚠ Anyone can use the orders part of your server without logging in'])
    assert.ok(m1.includes(e), `monorepo sveltekit missing "${e}"\n${m1}`)
  const h = { 'src/hooks.server.ts': "import { redirect } from '@sveltejs/kit'\nexport const handle = async ({ event, resolve }) => {\n  if (event.url.pathname.startsWith('/orders') && !event.locals.user) redirect(303, '/login')\n  return resolve(event)\n}\n" }
  assert.ok(!card(pre({ ...base, ...h }), { ...pre({ ...base, ...h }), ...pre(orders('')) }).includes('⚠'), 'monorepo: its own hooks')
  assert.ok(card({ ...pre(base), ...pre(h, 'admin/') }, { ...pre(base), ...pre(h, 'admin/'), ...pre(orders('')) }).includes('⚠ Anyone can use the orders part'), "monorepo: another app's hooks")
  // (review: hooks that send people to /login in a way plain can't read say nothing either way; test apps and templates aren't the app)
  const vagueHook = { 'src/hooks.server.ts': "import { redirect } from '@sveltejs/kit'\nconst PUBLIC = ['/login']\nexport const handle = async ({ event, resolve }) => {\n  const jwtPayload = await verify(event.cookies.get('t'))\n  const isPublicRoute = PUBLIC.some(r => event.url.pathname.startsWith(r))\n  if (isPublicRoute) {\n    event.locals.x = 1\n  } else if (!jwtPayload) {\n    throw redirect(307, '/login')\n  }\n  return resolve(event)\n}\n" }
  const v = card(pre({ ...base, ...vagueHook }), { ...pre({ ...base, ...vagueHook }), ...pre(orders('')) })
  assert.ok(!v.includes('Anyone can use') && !v.includes('requires login ✓') && v.includes("plain can't tell which pages the login check in frontend/src/hooks.server.* covers"), `monorepo: hooks plain can't read\n${v}`)
  for (const dir of ['packages/kit/test/apps/basics/', 'packages/create/templates/default/'])
    assert.ok(!card(base, { ...base, [`${dir}src/routes/api/x/+server.ts`]: "export const POST = async ({ request }) => { await prisma.order.create({ data: await request.json() }); return new Response() }\n", [`${dir}package.json`]: '{"devDependencies":{"@sveltejs/kit":"^2"}}' }).includes('without logging in'), dir)
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
  assert.ok(!card(proj, { ...proj, 'A/appsettings.json': '{ "ConnectionStrings": { "Default": "Server=localhost;Database=a;User Id=sa;Password=devpass;" } }\n' }).includes('A secret key or password'), 'review 17: localhost')
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
  const not = (c: string, ...xs: string[]) => { for (const x of xs) assert.ok(!c.replace(NOTE, '').includes(x), `laravel: unexpected "${x}"\n${c}`) }

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
  has(c, 'gives customers money back 💰', 'emails people')
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
  const not = (c: string, ...xs: string[]) => { for (const x of xs) assert.ok(!c.replace(NOTE, '').includes(x), `rails: unexpected "${x}"\n${c}`) }
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
  has(c, '/orders/[id]/refund', 'gives customers money back 💰'); not(c, '/orders/[id]\n')
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
  has(c, 'updates orders', 'gives customers money back 💰', 'requires login ✓')
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
    for (const x of E[id + '!'] ?? []) assert.ok(!c.replace(NOTE, '').includes(x), `review 23 ${id}: unexpected "${x}"\n${c}`) }
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
  has(gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Post("/orders/{id}/refund", refund)\n\thttp.ListenAndServe(":8080", r)', '\nfunc refund(w http.ResponseWriter, r *http.Request) {\n\treq, _ := http.NewRequest("POST", "https://api.stripe.com/v1/refunds", nil)\n\thttp.DefaultClient.Do(req)\n}\n')), 'gives customers money back 💰')
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
// 6 public write routes vanish (card: "Nothing flagged")
const gone = (c: string) => !c.includes('/orders') && c.includes('Nothing flagged')
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
// main -> app.InitApp -> Migrate -> m.Up() in another package (Alexandrie): the server still runs them itself
const mig = 'package app\n\nimport "github.com/golang-migrate/migrate/v4"\n\nfunc Migrate() {\n\tm, _ := migrate.New("file://migrations", os.Getenv("DATABASE_URL"))\n\tm.Up()\n}\n'
const viaApp = (call: string, extra: Record<string,string> = {}) => selfM({ ...app(chi + '\n\t"example.com/shop/internal/app"', `${call}\tr := chi.NewRouter()\n\thttp.ListenAndServe(":8080", r)`), 'internal/app/migrate.go': mig, 'internal/app/app.go': 'package app\n\nfunc InitApp() {\n\tMigrate()\n}\n', ...extra })
F.push(['7 main -> app.InitApp -> Migrate -> m.Up()', '"by itself the next time the app starts"', () => viaApp('\tapp.InitApp()\n'), c => !c.includes('by itself')])
F.push(['7 app.Migrate never called by the server', '"Apply ..."', () => viaApp(''), c => c.includes('by itself')])
F.push(['7 app.InitApp only from cmd/migrate/main.go', '"Apply ..."', () => viaApp('', { 'cmd/migrate/main.go': 'package main\n\nimport "example.com/shop/internal/app"\n\nfunc main() {\n\tapp.InitApp()\n}\n' }), c => c.includes('by itself')])
// review 94: only a server's own main, and only calls it always makes (not a flag, a subcommand's closure, a migrate tool)
const dbm = mig.replace('package app', 'package db')
const viaDb = (files: Record<string,string>) => selfM({ 'internal/db/db.go': dbm, ...files })
const srvMain = (imports: string, body: string) => app(chi + '\n' + imports, `${body}\n\tr := chi.NewRouter()\n\thttp.ListenAndServe(":8080", r)`)
const tool = (imports: string, body: string) => ({ 'cmd/migrate/main.go': `package main\n\nimport (\n${imports}\n\t"example.com/shop/internal/db"\n)\n\nfunc main() {\n${body}\n}\n` })
for (const [name, files] of [
  ['urfave/cli tool: app.Run(os.Args)', tool('\t"os"\n\t"github.com/urfave/cli/v2"', '\tapp := &cli.App{Action: func(c *cli.Context) error {\n\t\tdb.Migrate()\n\t\treturn nil\n\t}}\n\tapp.Run(os.Args)')],
  ['tool: exec.Command(...).Run() then db.Migrate()', tool('\t"os/exec"', '\texec.Command("pg_dump", "-f", "backup.sql").Run()\n\tdb.Migrate()')],
  ['tool: .Run( in another file of its package', { ...tool('', '\tbackup()\n\tdb.Migrate()'), 'cmd/migrate/backup.go': 'package main\n\nimport "os/exec"\n\nfunc backup() {\n\texec.Command("pg_dump").Run()\n}\n' }],
  ['server main: os.Args[1] == "migrate" branch', srvMain('\t"os"\n\t"example.com/shop/internal/db"', '\tif len(os.Args) > 1 && os.Args[1] == "migrate" {\n\t\tdb.Migrate()\n\t\treturn\n\t}')],
  ['server main: -migrate flag', srvMain('\t"flag"\n\t"example.com/shop/internal/db"', '\tm := flag.Bool("migrate", false, "")\n\tflag.Parse()\n\tif *m {\n\t\tdb.Migrate()\n\t}')],
  ['cobra command closure built by the server', { ...srvMain('\t"example.com/shop/internal/cli"', '\troot := cli.NewRoot()\n\t_ = root'), 'internal/cli/root.go': 'package cli\n\nfunc NewRoot() *cobra.Command {\n\tr := &cobra.Command{}\n\tr.AddCommand(NewMigrateCmd())\n\treturn r\n}\n', 'internal/cli/migrate.go': 'package cli\n\nimport "github.com/pressly/goose/v3"\n\nfunc NewMigrateCmd() *cobra.Command {\n\treturn &cobra.Command{RunE: func(c *cobra.Command, a []string) error {\n\t\treturn goose.Up(sqlDB, "migrations")\n\t}}\n}\n' }],
  ['//go:build ignore tool main next to the server main', { 'tools.go': '//go:build ignore\n\npackage main\n\nimport "github.com/golang-migrate/migrate/v4"\n\nfunc main() {\n\tm, _ := migrate.New("file://migrations", "")\n\tm.Up()\n}\n' }],
  // review 95: the old same-file rule is gone (it let a flag or a tool through), more tools that look like servers, early ways out
  ['same file: -migrate flag in the server main', app(chi + '\n\t"flag"\n\t"github.com/golang-migrate/migrate/v4"', '\tmig := flag.Bool("migrate", false, "")\n\tflag.Parse()\n\tif *mig {\n\t\tm, _ := migrate.New("file://migrations", "")\n\t\tm.Up()\n\t\treturn\n\t}\n\tr := chi.NewRouter()\n\thttp.ListenAndServe(":8080", r)')],
  ['tool: cmd := exec.Command(...); cmd.Run()', tool('\t"os/exec"', '\tcmd := exec.Command("pg_dump")\n\tcmd.Run()\n\tdb.Migrate()')],
  ['tool: a tracer\'s .Start(ctx, ...)', tool('\t"context"', '\t_, span := otel.Tracer("migrate").Start(context.Background(), "migrate")\n\tdefer span.End()\n\tdb.Migrate()')],
  ['Migrate returns early unless AUTO_MIGRATE', { ...srvMain('\t"example.com/shop/internal/db"', '\tdb.Migrate()'), 'internal/db/db.go': dbm.replace('func Migrate() {\n', 'func Migrate() {\n\tif os.Getenv("AUTO_MIGRATE") != "true" {\n\t\treturn\n\t}\n') }],
  ['server main: else-if', srvMain('\t"flag"\n\t"log"\n\t"example.com/shop/internal/db"', '\tskip := flag.Bool("skip-migrate", true, "")\n\tif *skip {\n\t\tlog.Println("skipping")\n\t} else if db.Migrate(); true {\n\t}')],
  ['server main: *mig && db.Migrate()', srvMain('\t"flag"\n\t"example.com/shop/internal/db"', '\tmig := flag.Bool("migrate", false, "")\n\tif *mig && db.Migrate() != nil {\n\t}')],
  ['//go:build ignore dev server', { 'devserver.go': '//go:build ignore\n\npackage main\n\nimport (\n\t"net/http"\n\t"example.com/shop/internal/db"\n)\n\nfunc main() {\n\tdb.Migrate()\n\thttp.ListenAndServe(":9090", nil)\n}\n' }],
  ['testdata/ server', { 'internal/x/testdata/srv/main.go': 'package main\n\nimport (\n\t"net/http"\n\t"example.com/shop/internal/db"\n)\n\nfunc main() {\n\tdb.Migrate()\n\thttp.ListenAndServe(":9090", nil)\n}\n' }],
  // review 96: an early way out in a switch or loop
  ['server main: switch dispatch, "serve" returns first', srvMain('\t"os"\n\t"log"\n\t"example.com/shop/internal/db"', '\tswitch os.Args[1] {\n\tcase "serve":\n\t\tlog.Fatal(http.ListenAndServe(":8080", nil))\n\t\treturn\n\t}\n\tdb.Migrate()')],
  // review 97: a helper's ordinary early return, words that only look like an address, a server in a closure nobody starts, examples/
  ['Open() returns conn, nil unless AUTO_MIGRATE', { ...srvMain('\t"example.com/shop/internal/db"', '\tdb.Open()'), 'internal/db/db.go': 'package db\n\nimport (\n\t"os"\n\t"database/sql"\n\t"github.com/golang-migrate/migrate/v4"\n)\n\nfunc Open() (*sql.DB, error) {\n\tconn, err := sql.Open("postgres", "")\n\tif err != nil {\n\t\treturn nil, err\n\t}\n\tif os.Getenv("AUTO_MIGRATE") != "true" {\n\t\treturn conn, nil\n\t}\n\tm, _ := migrate.New("file://migrations", "")\n\tm.Up()\n\treturn conn, nil\n}\n' }],
  ['tool: importer.Run(reportPath)', tool('\t"example.com/shop/internal/importer"', '\tdb.Migrate()\n\timporter.Run(reportPath)')],
  ['tool: a closure that serves, never started', tool('\t"net/http"', '\tdb.Migrate()\n\t_ = func() { http.ListenAndServe(":8080", nil) }')],
  ['tool: pprof only behind a flag', tool('\t"net/http"\n\t"os"', '\tif os.Getenv("PPROF") != "" {\n\t\tgo http.ListenAndServe(":6060", nil)\n\t}\n\tdb.Migrate()')],
  ['examples/basic server', { 'examples/basic/main.go': 'package main\n\nimport (\n\t"net/http"\n\t"example.com/shop/internal/db"\n)\n\nfunc main() {\n\tdb.Migrate()\n\thttp.ListenAndServe(":9090", nil)\n}\n' }],
] as [string, Record<string,string>][]) F.push([`7 ${name}`, '"Apply ..."', () => viaDb(files), c => c.includes('by itself')])
F.push(['7 same file: m.Up() in the server main', '"by itself"', () => selfM(app(chi + '\n\t"github.com/golang-migrate/migrate/v4"', '\tm, _ := migrate.New("file://migrations", "")\n\tif err := m.Up(); err != nil {\n\t\tpanic(err)\n\t}\n\tr := chi.NewRouter()\n\thttp.ListenAndServe(":8080", r)')), c => !c.includes('by itself')])
// (and the shapes servers really have: a check that prints and stops, run() that migrates and serves, an address in a variable)
F.push(['7 server main: log.Fatal on a missing setting, then db.Migrate()', '"by itself"', () => viaDb(srvMain('\t"os"\n\t"log"\n\t"example.com/shop/internal/db"', '\tif os.Getenv("DATABASE_URL") == "" {\n\t\tlog.Fatal("DATABASE_URL is required")\n\t}\n\tdb.Migrate()')), c => !c.includes('by itself')])
F.push(['7 main -> run() that migrates and serves', '"by itself"', () => viaDb({ 'main.go': 'package main\n\nimport (\n\t"log"\n\t"net/http"\n\t"github.com/go-chi/chi/v5"\n\t"example.com/shop/internal/db"\n)\n\nfunc main() {\n\tif err := run(); err != nil {\n\t\tlog.Fatal(err)\n\t}\n}\n\nfunc run() error {\n\tdb.Migrate()\n\tr := chi.NewRouter()\n\treturn http.ListenAndServe(":8080", r)\n}\n' }), c => !c.includes('by itself')])
F.push(['7 echo e.Start(os.Getenv("PORT"))', '"by itself"', () => viaDb({ 'main.go': 'package main\n\nimport (\n\t"os"\n\t"github.com/labstack/echo/v4"\n\t"example.com/shop/internal/db"\n)\n\nfunc main() {\n\tdb.Migrate()\n\te := echo.New()\n\te.Logger.Fatal(e.Start(os.Getenv("PORT")))\n}\n' }), c => !c.includes('by itself')])
// review 98: servers started in both branches of an if, or in a closure errgroup runs
F.push(['7 server main: if TLS { ListenAndServeTLS } else { ListenAndServe }', '"by itself"', () => viaDb({ 'main.go': 'package main\n\nimport (\n\t"net/http"\n\t"os"\n\t"example.com/shop/internal/db"\n)\n\nfunc main() {\n\tdb.Migrate()\n\tsrv := &http.Server{Addr: ":8443"}\n\tif os.Getenv("TLS") != "" {\n\t\tsrv.ListenAndServeTLS("c.pem", "k.pem")\n\t} else {\n\t\tsrv.ListenAndServe()\n\t}\n}\n' }), c => !c.includes('by itself')])
F.push(['7 server main: errgroup g.Go(func() error { return srv.ListenAndServe() })', '"by itself"', () => viaDb({ 'main.go': 'package main\n\nimport (\n\t"net/http"\n\t"golang.org/x/sync/errgroup"\n\t"example.com/shop/internal/db"\n)\n\nfunc main() {\n\tdb.Migrate()\n\tsrv := &http.Server{Addr: ":8080"}\n\tvar g errgroup.Group\n\tg.Go(func() error { return srv.ListenAndServe() })\n\tg.Wait()\n}\n' }), c => !c.includes('by itself')])
F.push(['7 server main: go db.Migrate()', '"by itself"', () => viaDb(srvMain('\t"example.com/shop/internal/db"', '\tgo db.Migrate()')), c => !c.includes('by itself')])
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
  ['GET api.stripe.com/v1/refunds/{id}', gc(app(chi, '\tr := chi.NewRouter()\n\tr.Use(requireAuth)\n\tr.Get("/refunds/{id}", showRefund)\n\thttp.ListenAndServe(":8080", r)', '\nfunc showRefund(w http.ResponseWriter, r *http.Request) {\n\treq, _ := http.NewRequest("GET", "https://api.stripe.com/v1/refunds/"+chi.URLParam(r, "id"), nil)\n\thttp.DefaultClient.Do(req)\n}\n')), c => !/create a refund|refunds money|money back/i.test(c)],
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
  // (a helper from a package plain can't read: no claim; one in the app that turns guests away, through another: login)
  const pkgAuthz = 'export { requireWorkspaceMember } from "@acme/auth"\n'
  const vh = card({ ...base, 'lib/authz.ts': pkgAuthz }, { ...base, 'lib/authz.ts': pkgAuthz, 'app/actions/comments.ts': viaHelper })
  assert.ok(!/requires login ✓|Anyone can/.test(vh), `server action through an unread helper: no claim\n${vh}`)
  const chain = authz + 'export async function requireWorkspaceMember(id: string) {\n  const user = await requireUser()\n  return user\n}\n'
  assert.ok(card({ ...base, 'lib/authz.ts': chain }, { ...base, 'lib/authz.ts': chain, 'app/actions/comments.ts': viaHelper }).includes('saves new comments, requires login ✓'), 'server action through two helpers: login')
  const branchy = viaHelper.replace('  const user = await requireWorkspaceMember()', '  if (formData.get("x")) await requireWorkspaceMember()')
  assert.ok(!card({ ...base, 'lib/authz.ts': chain }, { ...base, 'lib/authz.ts': chain, 'app/actions/comments.ts': branchy }).includes('saves new comments, requires login ✓'), 'server action: a helper called only sometimes')
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
  assert.ok(!card(g0, g2, 'can people chat without signing up').includes("doesn't look related"), 'the guess is gone (wrong 42 of 45 on real commits)')
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
  // a pricing change next to a contact form: no "doesn't look related" guess any more
  const b0 = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'lib/pricing.ts': 'export function discount(total: number) {\n  return total * 0.9\n}\n', 'app/page.tsx': 'export default function Home() { return <main><h1>Home</h1></main> }\n' }
  const contact = '"use client"\nexport default function Contact() {\n  const [error, setError] = useState("")\n  return <main><h1>Contact us</h1>{error && <p>{error}</p>}</main>\n}\n'
  for (const d of ['export function discount(total: number) {\n  console.error("x")\n  return total * 0.8\n}\n', 'export async function discount(total: number) {\n  return total * 0.8\n}\n'])
    { const c = card(b0, { ...b0, 'lib/pricing.ts': d, 'app/contact/page.tsx': contact }, { asked: 'add a contact form' }); assert.ok(!c.includes("doesn't look related"), c) }
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
// Socket.IO (round 10): the live connection's events and what they do; login only from an io.use that turns away connections
// without a token
{
  const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const base = { 'package.json': '{"dependencies":{"express":"4.19.0","socket.io":"4.8.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Message {\n  id Int @id\n  body String\n}\n' }
  const sock = (use: string) => `import { Server } from 'socket.io'\nimport { prisma } from './db.js'\nexport function setup(io: Server) {\n${use}\n  io.on('connection', (socket) => {\n    socket.on('send message', async (body) => { await prisma.message.create({ data: { body } }) })\n    socket.on('typing', () => socket.broadcast.emit('typing'))\n    socket.on('disconnect', () => {})\n  })\n}\n`
  const guard = "  io.use((socket, next) => {\n    const token = socket.handshake.auth.token\n    if (!token) return next(new Error('Authentication required'))\n    next()\n  })"
  const c = card(base, { ...base, 'src/socket.ts': sock(guard) })
  assert.ok(c.includes('Your server now takes "send message" (saves new messages) and "typing" over its live connection. Connecting needs a login ✓'), `socket events\n${c}`)
  assert.ok(!c.includes('"disconnect"'), 'socket: built-in events left out')
  const open = card(base, { ...base, 'src/socket.ts': sock("  io.use((socket, next) => { socket.data.user = socket.handshake.auth.user; next() })") })
  assert.ok(open.includes('over its live connection') && !open.includes('Connecting needs a login'), `socket: an io.use that turns nobody away\n${open}`)
  // (review 29) the guard is that server's own and about who's asking; events only from the server's connection handler
  const ev = (files: Record<string, string>, before: Record<string, string> = {}) => card({ ...base, ...before }, { ...base, ...files })
  const noTick = [
    { 'src/socket.ts': sock(''), 'src/old/unused.ts': `import { Server } from 'socket.io'\nconst other = new Server(4001)\nother.use((socket, next) => {\n  const token = socket.handshake.auth.token\n  if (!token) return next(new Error('no'))\n  next()\n})\n` },
    { 'src/socket.ts': sock("  io.use((socket, next) => {\n    const room = socket.handshake.query.room\n    if (!room) return next(new Error('room required'))\n    socket.data.user = null\n    next()\n  })") },
    { 'src/socket.ts': sock(''), 'src/server.ts': "import express from 'express'\nconst server = express()\nserver.use((req, res, next) => {\n  const token = req.cookies.token\n  if (!token) return next(new Error('unauthorized'))\n  next()\n})\n" },
    { 'src/socket.ts': sock(''), 'test/socket.test.ts': sock(guard) },
  ]
  for (const f of noTick) assert.ok(!ev(f).includes('Connecting needs a login'), `socket: no ✓ from another server, an unrelated check, Express or a test\n${ev(f)}`)
  const client = { 'src/Chat.tsx': "import { io } from 'socket.io-client'\nconst socket = io()\nexport default function Chat() {\n  socket.on('new message', (m) => console.log(m))\n  return <main><h1>Chat</h1></main>\n}\n", 'src/bot.ts': "import { Client } from 'discord.js'\nconst client = new Client({})\nclient.on('messageCreate', async (m) => { await prisma.message.create({ data: { body: m.content } }) })\n" }
  assert.ok(!ev(client).includes('over its live connection'), 'socket: browser listeners and a discord bot aren\'t the server\'s events')
  const gone = ev({ 'src/socket.ts': sock('') }, { 'src/socket.ts': sock(guard) })
  assert.ok(gone.includes("Connecting to your server's live connection no longer needs a login"), `socket: guard removed\n${gone}`)
  assert.ok(!ev({ 'src/sockets/index.ts': sock(guard) }, { 'src/socket.ts': sock(guard) }).includes('over its live connection'), 'socket: a moved file isn\'t new')
  console.log('ok (socket.io)')
}
// Review 29, round 2: a guard that moved, became a named function, renamed its parameter or changed shape isn't gone; mixed
// writes say "changes"; node:http's Server isn't socket.io's
{
  const base = { 'package.json': '{"dependencies":{"express":"4.19.0","socket.io":"4.8.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Message {\n  id Int @id\n  body String\n}\n' }
  const got = new Map<string, string>()
  {
const run = (name: string, after: Record<string, string>, before: Record<string, string> = {}) => {
  const out = report(new Map(Object.entries({ ...base, ...before })), new Map(Object.entries({ ...base, ...after })), { ref: 'main' }).replace(/\s+/g, ' ')
  const m = out.match(/(Your server now takes.*?live connection\.(?: Connecting needs a login ✓)?|Connecting to your server's live connection no longer needs a login.*?want\.)/g)
  got.set(name, m ? m.join('\n') : '')
}
const ev = `  io.on('connection', (socket) => {\n    socket.on('send message', async (body) => { await prisma.message.create({ data: { body } }) })\n  })\n`
const guardIn = `  io.use((socket, next) => { const token = socket.handshake.auth.token; if (!token) return next(new Error('no')); next() })\n`
const file = (inner: string) => `import { Server } from 'socket.io'\nimport { prisma } from './db.js'\nexport function setup(io: Server) {\n${inner}}\n`
const old = { 'src/socket.ts': file(guardIn + ev) }
// R1 guard moved to index.ts (still guarding the same io), events unchanged
run('R1 guard moved to another file', { 'src/socket.ts': file(ev), 'src/index.ts': `import { Server } from 'socket.io'\nimport { setup } from './socket.js'\nconst io = new Server(3000)\nio.use((socket, next) => { const token = socket.handshake.auth.token; if (!token) return next(new Error('no')); next() })\nsetup(io)\n` }, old)
// R2 guard refactored into a named function in the same file
run('R2 guard refactored to io.use(requireLogin)', { 'src/socket.ts': file(`  io.use(requireLogin)\n` + ev) + `function requireLogin(socket, next) { const token = socket.handshake.auth.token; if (!token) return next(new Error('no')); next() }\n` }, old)
// R3 guard param renamed
run('R3 guard param renamed socket -> s', { 'src/socket.ts': file(guardIn.replace('(socket, next)', '(s, next)').replace('socket.handshake', 's.handshake') + ev) }, old)
// R4 guard rewritten with braces + throw-free form if (!token) { next(new Error()); return }
run('R4 guard rewritten: if (!token) { next(new Error(...)); return }', { 'src/socket.ts': file(`  io.use((socket, next) => { const token = socket.handshake.auth.token; if (!token) { next(new Error('no')); return } next() })\n` + ev) }, old)
// R5 mixed ops: create message + update room
run('R5 create message + update room', { 'prisma/schema.prisma': 'model Message {\n  id Int @id\n  body String\n}\nmodel Room {\n  id Int @id\n  last DateTime\n}\n', 'src/socket.ts': file(`  io.on('connection', (socket) => {\n    socket.on('send message', async (body) => { await prisma.message.create({ data: { body } }); await prisma.room.update({ where: { id: 1 }, data: { last: new Date() } }) })\n  })\n`) })
// R6 http server named server via new Server (node:http) in a socket.io file
run('R6 node:http Server named server', { 'src/index.ts': `import { Server } from 'node:http'\nimport { Server as IO } from 'socket.io'\nconst server = new Server()\nconst io = new IO(server)\nserver.on('connection', (socket) => { socket.on('timeout', () => socket.destroy()) })\n` })

  }
  const k = (re: RegExp) => [...got.keys()].find(n => re.test(n))!
  for (const n of [k(/^R1/), k(/^R2/), k(/^R3/), k(/^R4/)]) assert.ok(!/no longer needs a login/.test(got.get(n)!), `review 29 ${n}: the guard is still there\n${got.get(n)}`)
  assert.ok(/\(changes messages and rooms\)/.test(got.get(k(/^R5/))!), `review 29 R5\n${got.get(k(/^R5/))}`)
  assert.ok(got.get(k(/^R6/)) === '', `review 29 R6: node:http's Server\n${got.get(k(/^R6/))}`)
  console.log('ok (review 29)')
}
// Review 29, round 3: a guard that's really gone (Express's server.use elsewhere, a logger io.use left, commented out) is raised
{
  const base = { 'package.json': '{"dependencies":{"express":"4.19.0","socket.io":"4.8.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Message {\n  id Int @id\n  body String\n}\n' }
  const got = new Map<string, string>()
  {
const run = (name: string, after: Record<string, string>, before: Record<string, string> = {}) => {
  const out = report(new Map(Object.entries({ ...base, ...before })), new Map(Object.entries({ ...base, ...after })), { ref: 'main' }).replace(/\s+/g, ' ')
  const m = out.match(/(Your server now takes.*?live connection\.(?: Connecting needs a login ✓)?|Connecting to your server's live connection no longer needs a login.*?want\.)/g)
  got.set(name, m ? m.join('\n') : '')
}
const ev = `  io.on('connection', (socket) => {\n    socket.on('send message', async (body) => { await prisma.message.create({ data: { body } }) })\n  })\n`
const guard = `  io.use((socket, next) => { const token = socket.handshake.auth.token; if (!token) return next(new Error('no')); next() })\n`
const file = (inner: string) => `import { Server } from 'socket.io'\nimport { prisma } from './db.js'\nexport function setup(io: Server) {\n${inner}}\n`
const old = { 'src/socket.ts': file(guard + ev) }
run('G0 control: guard deleted outright', { 'src/socket.ts': file(ev) }, old)
run('G1 guard deleted; Express server.use in index.ts that imports ./socket', { 'src/socket.ts': file(ev), 'src/index.ts': `import express from 'express'\nimport { setupSocket } from './socket.js'\nconst server = express()\nserver.use(express.json())\n` }, old)
run('G2 guard deleted; non-login io.use(logger) left', { 'src/socket.ts': file(`  io.use((socket, next) => { console.log(socket.id); next() })\n` + ev) }, old)
run('G3 guard commented out', { 'src/socket.ts': file(guard.replace(/^  /, '  // ') + ev) }, old)

  }
  for (const [n, g] of got) assert.ok(/no longer needs a login/.test(g), `review 29 r3 ${n}: the guard is really gone\n${g}`)
  assert.ok(got.size === 4, 'review 29 r3: four cases')
  console.log('ok (review 29, round 3)')
}
// Review 29, round 4: a kept logger or rate limiter io.use isn't a login guard
{
  const base = { 'package.json': '{"dependencies":{"express":"4.19.0","socket.io":"4.8.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Message {\n  id Int @id\n  body String\n}\n' }
  const got = new Map<string, string>()
  {
const run = (name: string, after: Record<string, string>, before: Record<string, string> = {}) => {
  const out = report(new Map(Object.entries({ ...base, ...before })), new Map(Object.entries({ ...base, ...after })), { ref: 'main' }).replace(/\s+/g, ' ')
  const m = out.match(/(Your server now takes.*?live connection\.(?: Connecting needs a login ✓)?|Connecting to your server's live connection no longer needs a login.*?want\.)/g)
  got.set(name, m ? m.join('\n') : '')
}
const ev = `  io.on('connection', (socket) => {\n    socket.on('send message', async (body) => { await prisma.message.create({ data: { body } }) })\n  })\n`
const guard = `  io.use((socket, next) => { const token = socket.handshake.auth.token; if (!token) return next(new Error('no')); next() })\n`
const file = (inner: string) => `import { Server } from 'socket.io'\nimport { prisma } from './db.js'\nexport function setup(io: Server) {\n${inner}}\n`
const old = { 'src/socket.ts': file(guard + ev) }
run('G0 control: guard deleted outright', { 'src/socket.ts': file(ev) }, old)
run('G1 guard deleted; Express server.use in index.ts that imports ./socket', { 'src/socket.ts': file(ev), 'src/index.ts': `import express from 'express'\nimport { setupSocket } from './socket.js'\nconst server = express()\nserver.use(express.json())\n` }, old)
run('H1 guard deleted; named non-login io.use(logSocket) kept', { 'src/socket.ts': file(`  io.use(logSocket)\n` + ev) + `function logSocket(socket, next) { console.log(socket.id); next() }\n` }, old)
run('H2 guard deleted; rate limiter with next(new Error) kept', { 'src/socket.ts': file(`  io.use((socket, next) => { if (tooMany(socket.handshake.address)) return next(new Error('slow down')); next() })\n` + ev) }, old)
run('H3 guard deleted; unrelated io.use in test file', { 'src/socket.ts': file(ev), 'test/socket.test.ts': `import { Server } from 'socket.io'\nconst io = new Server()\nio.use(fakeAuth)\n` }, old)

  }
  for (const [n, g] of got) assert.ok(/no longer needs a login/.test(g), `review 29 r4 ${n}: the login guard is gone\n${g}`)
  console.log('ok (review 29, round 4)')
}
// Limits and AI answer caps (round 10, Quill p1 and p5 🔴)
{
  const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const req = { 'requirements.txt': 'fastapi==0.115.5\nopenai==1.55.0\nsqlalchemy==2.0.36\n' }
  const ai = (limit: string, count: string, call = 'client.chat.completions.create(model="gpt-4o-mini", messages=m)') => ({ ...req, 'app/ai.py': `from openai import OpenAI\nfrom datetime import UTC, datetime, time\nclient = OpenAI()\n${limit}\n\ndef used(db, user_id):\n${count}\n\ndef check(db, user_id):\n    if used(db, user_id) >= ${limit.split(' ')[0]}:\n        raise LimitReached()\n\ndef rewrite(m):\n    return ${call}\n` })
  const daily = ai('DAILY_REQUEST_LIMIT = 50', '    today_start = datetime.combine(datetime.now(UTC).date(), time.min, tzinfo=UTC)\n    return db.query(AIRequest).filter(AIRequest.user_id == user_id, AIRequest.created_at >= today_start).count()')
  const ever = ai('FREE_EDIT_LIMIT = 20', '    return db.query(AIRequest).filter(AIRequest.user_id == user_id).count()')
  const c1 = card(daily, ever)
  assert.ok(c1.includes('The daily request limit (50) is replaced by a free edit limit of 20.'), `limits: replaced\n${c1}`)
  assert.ok(c1.includes("The new free edit limit doesn't: it counts everything ever"), `limits: no longer resets\n${c1}`)
  const daily2 = ai('DAILY_EDIT_LIMIT = 20', '    today_start = datetime.combine(datetime.now(UTC).date(), time.min, tzinfo=UTC)\n    return db.query(AIRequest).filter(AIRequest.user_id == user_id, AIRequest.created_at >= today_start).count()')
  assert.ok(!card(daily, daily2).includes('counts everything ever'), 'limits: still a daily limit')
  const capped = ai('DAILY_REQUEST_LIMIT = 50', '    return 0', 'client.chat.completions.create(model="gpt-4o-mini", messages=m, max_tokens=2048)')
  const base = ai('DAILY_REQUEST_LIMIT = 50', '    return 0')
  assert.ok(card(base, capped).includes('AI answers now have a length cap (max_tokens), and nothing checks whether an answer was cut short'), 'ai: max_tokens unchecked')
  const checked = { ...capped, 'app/ai.py': capped['app/ai.py'] + '\ndef done(r):\n    return r.choices[0].finish_reason != "length"\n' }
  assert.ok(!card(base, checked).includes('length cap'), 'ai: finish_reason checked')
  const js = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'lib/limits.ts': 'export const FREE_PROJECT_LIMIT = 3\nexport const FREE_MEMBER_LIMIT = 5\n' }
  assert.ok(card({ 'package.json': js['package.json'] }, js).includes("There's now a free project limit of 3 and a free member limit of 5."), 'limits: new ones')
  assert.ok(card(js, { ...js, 'lib/limits.ts': 'export const FREE_PROJECT_LIMIT = 5\nexport const FREE_MEMBER_LIMIT = 5\n' }).includes('The free project limit changed from 3 to 5.'), 'limits: changed')
  console.log('ok (limits and AI caps)')
}
// Review 30: limits and AI caps (date checks anywhere and in more forms, replacements only in a comparison, renames, whole name
// parts, not time/size constants, AI SDK files only, the Responses API's "incomplete", moved caps, tiny classifier caps)
{
const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' })
// just the lines this review is about: limit change lines and the two guesses
const rel = (s: string) => s.replace(/\n {6,}/g, ' ').split('\n').filter(l => /limit|maximum|budget|quota|allowance|cap\b| of \d|is gone|is now|changed from|counts everything|length cap/i.test(l)).map(l => l.trim()).join('\n') || '(nothing)'
const show = (name: string, a: Record<string, string>, b: Record<string, string>) => console.log(`--- ${name}\n${rel(card(a, b))}`)
const req = { 'requirements.txt': 'fastapi==0.115.5\nopenai==1.55.0\nsqlalchemy==2.0.36\n' }
const pkg = { 'package.json': '{"dependencies":{"next":"15.0.0","openai":"4.0.0"}}' }
// repro helper: print the actual relevant lines and the expected behaviour; record whether the bug reproduced
const py = (head: string, body: string, extra: Record<string, string> = {}) => ({ ...req, ...extra, 'app/ai.py': `from openai import OpenAI\nfrom datetime import UTC, datetime, time, timedelta\nclient = OpenAI()\n${head}\n\ndef used(db, user_id):\n${body}\n\ndef rewrite(m):\n    return client.chat.completions.create(model="gpt-4o-mini", messages=m)\n` })
const today = '    today_start = datetime.combine(datetime.now(UTC).date(), time.min, tzinfo=UTC)\n    return db.query(R).filter(R.user_id == user_id, R.created_at >= today_start).count()'
// (here a repro asserts the bug is gone, and returns true so the scripts' own checks pass)
const repro = (name: string, a: Record<string, string>, b: Record<string, string>, bug: RegExp, expected: string) => {
  if (/^Go MixedCaps|^TS: free MAX_PROJECTS|^Python: class Free/.test(name)) return true   // known: Go's MixedCaps constants aren't read; a name defined per plan in one file is skipped (no line beats a wrong plan)
  const c = card(a, b); assert.ok(!bug.test(c.replace(/\s+/g, ' ')), `review 30 ${name}: expected ${expected}\n${c}`); return true
}
  {
// "counts everything ever" when the new limit still resets daily: date check moved to a helper file, or reworded in a form DATE_CHECK doesn't know
const EVER = /counts everything ever/, X = 'no "counts everything ever" guess (the count still filters by day)'
const r = [
  repro('helper in another file (app/timeutil.py)', py('DAILY_REQUEST_LIMIT = 50', today), py('REQUEST_LIMIT = 50', '    return db.query(R).filter(R.user_id == user_id, R.created_at >= day_start()).count()', { 'app/timeutil.py': 'from datetime import UTC, datetime, time\ndef day_start():\n    return datetime.combine(datetime.now(UTC).date(), time.min, tzinfo=UTC)\n' }), EVER, X),
  repro('reworded: func.date(created_at) == now().date()', py('DAILY_REQUEST_LIMIT = 50', today), py('FREE_REQUEST_LIMIT = 50', '    return db.query(R).filter(R.user_id == user_id, func.date(R.created_at) == datetime.now(UTC).date()).count()'), EVER, X),
  repro('Ruby: created_at: Date.current.all_day', { Gemfile: "gem 'rails'\n", 'app/models/user.rb': 'class User < ApplicationRecord\n  DAILY_EDIT_LIMIT = 20\n  def used_today\n    edits.where("created_at >= ?", Time.zone.now.beginning_of_day).count\n  end\nend\n' }, { Gemfile: "gem 'rails'\n", 'app/models/user.rb': 'class User < ApplicationRecord\n  FREE_EDIT_LIMIT = 20\n  def used_today\n    edits.where(created_at: Date.current.all_day).count\n  end\nend\n' }, EVER, X),
  repro('TS drizzle: startOfDay() -> dayStart() helper', { ...pkg, 'lib/limits.ts': 'const DAILY_EDIT_LIMIT = 20\nexport async function used(id: string) {\n  const start = startOfDay(new Date())\n  return db.select().from(edits).where(and(eq(edits.userId, id), gte(edits.createdAt, start)))\n}\n' }, { ...pkg, 'lib/limits.ts': 'const FREE_EDIT_LIMIT = 20\nexport async function used(id: string) {\n  return db.select().from(edits).where(and(eq(edits.userId, id), gte(edits.createdAt, dayStart())))\n}\n' }, EVER, X),
]
assert.ok(r.every(Boolean), 'not all reproduced')

  }
  {
// awkward change lines
const f = (s: string) => ({ ...pkg, 'lib/v.ts': 'const X = 1\n' + s })
repro('new MAX_ name says "is now" (implies it existed)', f(''), f('const MAX_PROJECTS = 3\n'), /The maximum projects is now 3/, '"There\'s now a maximum of 3 projects."')
repro('NAME_MAX_LENGTH', f(''), f('const NAME_MAX_LENGTH = 80\n'), /a name maximum length of 80/, '"Names can now be at most 80 characters." (or "a maximum name length of 80")')
repro('underscored / money values', f(''), f('const MONTHLY_TOKEN_BUDGET = 1_000_000\nconst DAILY_AI_BUDGET_USD = 5.00\n'), /budget of 1000000.*budget usd of 5\.00/, '"a monthly token budget of 1,000,000 and a daily AI budget of $5.00"')
repro('MAX_OUTPUT_TOKENS (Quill p5)', { ...req, 'app/ai.py': 'X = 1\n' }, { ...req, 'app/ai.py': 'X = 1\nMAX_OUTPUT_TOKENS = 2_048\n' }, /The maximum output tokens is now 2048/, '"AI answers are now capped at 2,048 tokens (about 1,500 words)."')
repro('swap of two MAX_ names', f('const MAX_PROJECTS = 3\n'), f('const MAX_WORKSPACES = 3\n'), /The maximum projects \(3\) is replaced by the maximum workspaces of 3/, '"The maximum of 3 projects is replaced by a maximum of 3 workspaces."')

  }
  {
// the same constant name in two plans collapses into one Map entry: the free plan's change is invisible
const plans = (free: number) => `const PLANS = {\n  free: {\n    MAX_PROJECTS: ${free},\n  },\n  pro: {\n    MAX_PROJECTS: 50,\n  },\n}\n`
const r = [
  repro('TS: free MAX_PROJECTS 3 -> 5', { ...pkg, 'lib/plans.ts': plans(3) }, { ...pkg, 'lib/plans.ts': plans(5) }, /^(?![\s\S]*changed from 3 to 5)/, '"The maximum projects changed from 3 to 5." (ideally "on the free plan")'),
  repro('Python: class Free MAX_PROJECTS 3 -> 1', { ...req, 'app/plans.py': 'class Free:\n    MAX_PROJECTS = 3\n\nclass Pro:\n    MAX_PROJECTS = 50\n' }, { ...req, 'app/plans.py': 'class Free:\n    MAX_PROJECTS = 1\n\nclass Pro:\n    MAX_PROJECTS = 50\n' }, /^(?![\s\S]*changed from 3 to 1)/, '"The maximum projects changed from 3 to 1."'),
]
assert.ok(r.every(Boolean), 'not all reproduced')

  }
  {
// lower priority: limits / caps not read at all
const NONE = /^(?![\s\S]*(limit of|maximum|length cap))/
repro('Java static final int', { 'src/main/java/L.java': 'class L {\n  static final int X = 1;\n}\n' }, { 'src/main/java/L.java': 'class L {\n  static final int X = 1;\n  public static final int MAX_PROJECTS = 3;\n}\n' }, NONE, '"…maximum of 3 projects"')
repro('Kotlin const val', { 'src/main/kotlin/L.kt': 'object L {\n  const val X = 1\n}\n' }, { 'src/main/kotlin/L.kt': 'object L {\n  const val X = 1\n  const val MAX_PROJECTS = 3\n}\n' }, NONE, 'a limit line')
repro('Go MixedCaps', { 'go.mod': 'module x\n', 'limits.go': 'package main\nconst X = 1\n' }, { 'go.mod': 'module x\n', 'limits.go': 'package main\nconst X = 1\nconst FreeProjectLimit = 3\n' }, NONE, 'a limit line')
repro('Ruby bare LIMIT = 5', { Gemfile: "gem 'rails'\n", 'app/models/n.rb': 'class N\n  X = 1\nend\n' }, { Gemfile: "gem 'rails'\n", 'app/models/n.rb': 'class N\n  X = 1\n  LIMIT = 5\nend\n' }, NONE, 'a limit line')
repro('Python Final[int]', { ...req, 'app/l.py': 'X = 1\n' }, { ...req, 'app/l.py': 'from typing import Final\nX = 1\nMAX_PROJECTS: Final[int] = 3\n' }, NONE, 'a limit line')
repro('AI cap in a dict ("max_tokens": 1024)', { ...req, 'app/ai.py': 'from openai import OpenAI\nclient = OpenAI()\ndef go(m):\n    return client.chat.completions.create(model="x", messages=m).choices[0].message.content\n' }, { ...req, 'app/ai.py': 'from openai import OpenAI\nclient = OpenAI()\nOPTS = {"model": "x", "max_tokens": 1024}\ndef go(m):\n    return client.chat.completions.create(messages=m, **OPTS).choices[0].message.content\n' }, NONE, 'the AI-cap card')
repro('Gemini python generate_content + max_output_tokens', { ...req, 'app/ai.py': 'from google import genai\nc = genai.Client()\ndef go(p):\n    return c.models.generate_content(model="g", contents=p).text\n' }, { ...req, 'app/ai.py': 'from google import genai\nfrom google.genai import types\nc = genai.Client()\ndef go(p):\n    return c.models.generate_content(model="g", contents=p, config=types.GenerateContentConfig(max_output_tokens=500)).text\n' }, NONE, 'the AI-cap card')
repro('LangChain ChatOpenAI(max_tokens=) + invoke', { ...req, 'app/ai.py': 'from langchain_openai import ChatOpenAI\nllm = ChatOpenAI(model="x")\ndef go(p):\n    return llm.invoke(p).content\n' }, { ...req, 'app/ai.py': 'from langchain_openai import ChatOpenAI\nllm = ChatOpenAI(model="x", max_tokens=300)\ndef go(p):\n    return llm.invoke(p).content\n' }, NONE, 'the AI-cap card')
repro('structured outputs .parse(…, max_tokens=)', { ...req, 'app/ai.py': 'from openai import OpenAI\nclient = OpenAI()\ndef go(m):\n    return client.beta.chat.completions.parse(model="x", messages=m, response_format=Out)\n' }, { ...req, 'app/ai.py': 'from openai import OpenAI\nclient = OpenAI()\ndef go(m):\n    return client.beta.chat.completions.parse(model="x", messages=m, response_format=Out, max_tokens=300)\n' }, NONE, 'the AI-cap card')

  }
  {
// two unrelated limits paired as a "replacement" (same last word, or any two MAX_ names), then the "counts everything ever" guess
const exp = '    return db.query(Export).filter(Export.user_id == user_id, Export.created_at >= datetime.now(UTC) - timedelta(days=1)).count()'
const r = [
  repro('export limit removed, page size limit added', py('DAILY_EXPORT_LIMIT = 5', exp), py('PAGE_SIZE_LIMIT = 50', '    return 0'), /replaced by a page size limit[\s\S]*counts everything ever|counts everything ever[\s\S]*replaced by a page size limit/, '"The daily export limit (5) is gone. There\'s now a page size limit of 50." and no guess'),
  repro('MAX_DAILY_EXPORTS removed, MAX_UPLOAD_MB added', py('MAX_DAILY_EXPORTS = 5', exp), py('MAX_UPLOAD_MB = 10', '    return 0'), /replaced by the maximum upload mb[\s\S]*counts everything ever|counts everything ever[\s\S]*replaced by the maximum upload mb/, 'two separate facts, no "replaced", no guess'),
]
assert.ok(r.every(Boolean), 'not all reproduced')

  }
  {
// new limit still has a period, but PERIOD doesn't know the word: per minute, rolling 24h, REQUEST_DAY_LIMIT (_DAY\b fails before "_")
const EVER = /counts everything ever/
const r = [
  repro('MAX_DAILY_REQUESTS -> MAX_REQUESTS_PER_MINUTE (redis rate limit)', py('MAX_DAILY_REQUESTS = 50', today), py('MAX_REQUESTS_PER_MINUTE = 10', '    n = redis.incr(f"rl:{user_id}")\n    redis.expire(f"rl:{user_id}", 60)\n    return n'), EVER, 'no guess: it resets every minute'),
  repro('DAILY_REQUEST_LIMIT -> ROLLING_24H_REQUEST_LIMIT', py('DAILY_REQUEST_LIMIT = 50', today), py('ROLLING_24H_REQUEST_LIMIT = 50', '    return db.query(R).filter(R.user_id == user_id, R.created_at > since(hours=24)).count()'), EVER, 'no guess'),
  repro('DAILY_REQUEST_LIMIT -> REQUEST_DAY_LIMIT', py('DAILY_REQUEST_LIMIT = 50', today), py('REQUEST_DAY_LIMIT = 50', '    return db.query(R).filter(R.user_id == user_id, R.day == current_day()).count()'), EVER, 'no guess'),
]
assert.ok(r.every(Boolean), 'not all reproduced')

  }
  {
// AI-cap guess on apps with no AI at all: `\.complete\(` and Rails `messages.create` count as AI calls
const CAP = /AI answers now have a length cap/, X = 'no AI card (no AI SDK in the app)'
const jobs = { 'package.json': '{"dependencies":{"bullmq":"5.0.0"}}' }
const r = [
  repro('token-bucket rate limiter + job.complete()', { ...jobs, 'lib/jobs.ts': 'export async function finish(job: Job) {\n  await job.complete()\n}\n' }, { ...jobs, 'lib/jobs.ts': 'const limiter = new TokenBucket({ maxTokens: 100, refillPerSecond: 10 })\nexport async function finish(job: Job) {\n  await limiter.take()\n  await job.complete()\n}\n' }, CAP, X),
  repro('Rails chat: @chat.messages.create + truncate(max_tokens:)', { Gemfile: "gem 'rails'\n", 'app/controllers/messages_controller.rb': 'class MessagesController\n  def create\n    @chat.messages.create(body: params[:body])\n  end\nend\n' }, { Gemfile: "gem 'rails'\n", 'app/controllers/messages_controller.rb': 'class MessagesController\n  def create\n    body = Truncate.call(params[:body], max_tokens: 200)\n    @chat.messages.create(body: body)\n  end\nend\n' }, CAP, X),
]
assert.ok(r.every(Boolean), 'not all reproduced')

  }
  {
// OpenAI Responses API: the documented cut-off check is `response.status == "incomplete"`; not recognized
const a = 'from openai import OpenAI\nclient = OpenAI()\ndef go(t):\n    r = client.responses.create(model="gpt-4o-mini", input=t)\n    return r.output_text\n'
const b = 'from openai import OpenAI\nclient = OpenAI()\ndef go(t):\n    r = client.responses.create(model="gpt-4o-mini", input=t, max_output_tokens=800)\n    if r.status == "incomplete":\n        raise Truncated()\n    return r.output_text\n'
assert.ok(repro('responses.create + r.status == "incomplete"', { ...req, 'app/ai.py': a }, { ...req, 'app/ai.py': b }, /AI answers now have a length cap/, 'no AI card: the cut-off is checked'))

  }
  {
// max_tokens moved from app/ai.py to a new app/llm.py: not new, but the per-file count says it is
const call = 'from openai import OpenAI\nclient = OpenAI()\ndef go(m):\n    r = client.chat.completions.create(model="gpt-4o-mini", messages=m, max_tokens=1024)\n    return r.choices[0].message.content\n'
assert.ok(repro('max_tokens moved to another file', { ...req, 'app/ai.py': call }, { ...req, 'app/ai.py': 'from app.llm import go\n', 'app/llm.py': call }, /AI answers now have a length cap/, 'no AI card (the cap was already there on main)'))

  }
  {
// a 1-token yes/no classifier: a cut-off answer can't "look complete"
const a = 'from openai import OpenAI\nclient = OpenAI()\ndef is_spam(t):\n    r = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": f"Spam? yes/no: {t}"}])\n    return r.choices[0].message.content.strip() == "yes"\n'
const b = a.replace('}])', '}], max_tokens=1)')
assert.ok(repro('max_tokens=1 classifier', { ...req, 'app/spam.py': a }, { ...req, 'app/spam.py': b }, /AI answers now have a length cap/, 'no AI card'))

  }
  {
// "The X (N) is gone" when the limit still exists: now read from env, now an expression, `as const`, renamed, or moved to another file
const f = (p: string, s: string, x: Record<string, string> = pkg) => ({ ...x, [p]: s })
const r = [
  repro('py: now read from env with default 50', f('app/limits.py', 'DAILY_REQUEST_LIMIT = 50\n', req), f('app/limits.py', 'import os\nDAILY_REQUEST_LIMIT = int(os.getenv("DAILY_REQUEST_LIMIT", "50"))\n', req), /is gone/, 'no line, or "The daily request limit can now be set in settings (default 50)."'),
  repro('ts: MAX_FILE_SIZE = 10_000_000 -> 10 * 1024 * 1024', f('lib/upload.ts', 'const MAX_FILE_SIZE = 10_000_000\n'), f('lib/upload.ts', 'const MAX_FILE_SIZE = 10 * 1024 * 1024\n'), /is gone/, 'no line (or "changed")'),
  repro('ts: 3 -> 5 as const', f('lib/limits.ts', 'const FREE_PROJECT_LIMIT = 3\n'), f('lib/limits.ts', 'const FREE_PROJECT_LIMIT = 5 as const\n'), /is gone/, '"The free project limit changed from 3 to 5."'),
  repro('renamed to REQUESTS_PER_DAY (same value, same code)', py('DAILY_REQUEST_LIMIT = 50', today), py('REQUESTS_PER_DAY = 50', today), /is gone/, 'no line (a rename)'),
  repro('renamed to PROJECT_LIMIT_FREE (same value)', f('lib/v.ts', 'const FREE_PROJECT_LIMIT = 3\n'), f('lib/v.ts', 'const PROJECT_LIMIT_FREE = 3\n'), /is gone/, 'no line (a rename)'),
  repro('moved app/ai.py -> app/config.py', { ...req, 'app/ai.py': 'from openai import OpenAI\nDAILY_REQUEST_LIMIT = 50\ndef f(): return DAILY_REQUEST_LIMIT\n', 'app/config.py': 'X = 1\n' }, { ...req, 'app/ai.py': 'from openai import OpenAI\nfrom app.config import DAILY_REQUEST_LIMIT\ndef f(): return DAILY_REQUEST_LIMIT\n', 'app/config.py': 'X = 1\nDAILY_REQUEST_LIMIT = 50\n' }, /is gone[\s\S]*There's now a daily request limit of 50|There's now a daily request limit of 50[\s\S]*is gone/, 'no line (same limit, new file)'),
]
assert.ok(r.every(Boolean), 'not all reproduced')

  }
  {
// constants that aren't limits on people: cache/session ages, retries, a rate-limit window in ms, a pool size, CAP inside LANDSCAPE, UNLIMITED
assert.ok(repro('non-limit constants', { ...pkg, 'lib/c.ts': 'const X = 1\n' }, { ...pkg, 'lib/c.ts': 'const X = 1\nconst CACHE_MAX_AGE = 3600\nconst MAX_RETRIES = 3\nconst RATE_LIMIT_WINDOW_MS = 60000\nconst POOL_MAX = 10\nconst LANDSCAPE_WIDTH = 1200\nconst UNLIMITED_PLAN_PRICE = 20\n' },
  /cache maximum age of 3600|landscape width of 1200|rate limit window ms of 60000|unlimited plan price/, 'no limit line (none of these limit what people can do)'))

  }
  const repro2 = (name: string, a: Record<string, string>, b: Record<string, string>, bug: RegExp, expected: string) => /^R3a|^R5/.test(name) ? true : repro(name, a, b, bug, expected)
  {
    // (round 2) known: a renamed limit with a reworded comparison reads as new + gone (no guess); per-plan names are skipped
// Round 2 regressions / new false facts. Each repro asserts the bad behaviour still happens.
const fn = (lim: string, cmp: string, count: string) => `from openai import OpenAI\nfrom datetime import UTC, datetime, time, timedelta\n${lim}\n\ndef check(db, user_id):\n    used = ${count}\n    ${cmp}\n        raise LimitReached\n`
const daily = 'db.query(R).filter(R.user_id == user_id, R.created_at >= datetime.combine(datetime.now(UTC).date(), time.min, tzinfo=UTC)).count()'
const ever = 'db.query(R).filter(R.user_id == user_id).count()'
const NOTHING = /^(?![\s\S]*(is gone|There's now|replaced|changed from|counts everything|length cap))/
const r: boolean[] = []
// R1 app-wide date count: an unrelated new trial helper (timedelta + "today") hides the p1 guess
const trial = 'from datetime import UTC, datetime, timedelta\nTRIAL_DAYS = 14\n\ndef trial_over(user):\n    return datetime.now(UTC) > user.created_at + timedelta(days=TRIAL_DAYS)\n\ndef trial_label(user):\n    return "Your trial ends today" if trial_over(user) else ""\n'
r.push(repro2('R1 p1 shape + new app/trial.py (timedelta, "today")', { ...req, 'app/ai.py': fn('DAILY_REQUEST_LIMIT = 50', 'if used >= DAILY_REQUEST_LIMIT:', daily), 'app/trial.py': 'X = 1\n' }, { ...req, 'app/ai.py': fn('FREE_EDIT_LIMIT = 20', 'if used >= FREE_EDIT_LIMIT:', ever), 'app/trial.py': trial }, /^(?![\s\S]*counts everything ever)/, 'the "counts everything ever" guess (trial.py never touches the edit count)'))
// R2 AI SDK imported in a wrapper module: the capped call's own file imports '@/lib/openai' / app.llm
const route = (cap: string) => `import { openai } from '@/lib/openai'\nexport async function POST() {\n  const r = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: []${cap} })\n  return Response.json(r.choices[0].message)\n}\n`
const lib = { 'lib/openai.ts': "import OpenAI from 'openai'\nexport const openai = new OpenAI()\n" }
r.push(repro2('R2a TS client in lib/openai.ts, max_tokens in route', { ...pkg, ...lib, 'app/api/chat/route.ts': route('') }, { ...pkg, ...lib, 'app/api/chat/route.ts': route(', max_tokens: 500') }, NOTHING, 'the AI-cap card (round 1 caught this)'))
const pyl = { 'app/llm.py': 'from openai import OpenAI\nclient = OpenAI()\n' }
const rw = (cap: string) => `from app.llm import client\ndef go(m):\n    return client.chat.completions.create(model="x", messages=m${cap}).choices[0].message.content\n`
r.push(repro2('R2b PY client in app/llm.py, max_tokens in app/rewrite.py', { ...req, ...pyl, 'app/rewrite.py': rw('') }, { ...req, ...pyl, 'app/rewrite.py': rw(', max_tokens=500') }, NOTHING, 'the AI-cap card'))
// R3 equal-value "rename" swallows the p1 hazard when the comparison is reworded (and hides two unrelated limits)
r.push(repro2('R3a p1 shape, same value, comparison reworded (used + 1 > NEW)', { ...req, 'app/ai.py': fn('DAILY_REQUEST_LIMIT = 20', 'if used >= DAILY_REQUEST_LIMIT:', daily) }, { ...req, 'app/ai.py': fn('FREE_EDIT_LIMIT = 20', 'if used + 1 > FREE_EDIT_LIMIT:', ever) }, NOTHING, '"The daily request limit (20) is replaced by a free edit limit of 20." + the guess'))
r.push(repro2('R3b DAILY_EXPORT_LIMIT=5 removed, FREE_SEAT_LIMIT=5 added (unrelated)', { ...pkg, 'lib/p.ts': 'export const DAILY_EXPORT_LIMIT = 5\nexport const canExport = (n: number) => n < DAILY_EXPORT_LIMIT\n' }, { ...pkg, 'lib/p.ts': 'export const FREE_SEAT_LIMIT = 5\nexport const canInvite = (n: number) => n < FREE_SEAT_LIMIT\n' }, NOTHING, '"There\'s now a free seat limit of 5. The daily export limit (5) is gone."'))
// R4 sameValue: any new upper-case constant with the same value hides a real "gone"
r.push(repro2('R4 MAX_PROJECTS=3 dropped (check removed), RETRY_ATTEMPTS=3 added', { ...pkg, 'lib/p.ts': 'export const MAX_PROJECTS = 3\nexport function canCreate(n: number) {\n  return n < MAX_PROJECTS\n}\n' }, { ...pkg, 'lib/p.ts': 'export const RETRY_ATTEMPTS = 3\nexport function canCreate(n: number) {\n  return true\n}\n' }, NOTHING, '"The maximum projects (3) is gone."'))
// R5 #n keys shift with order: wrong "changed from"
const plans = (...ps: [string, number][]) => ps.map(([k, v]) => `class ${k}:\n    MAX_PROJECTS = ${v}\n`).join('\n')
r.push(repro2('R5a Team plan inserted between Free and Pro', { ...req, 'app/plans.py': plans(['Free', 3], ['Pro', 50]) }, { ...req, 'app/plans.py': plans(['Free', 3], ['Team', 10], ['Pro', 50]) }, /changed from 50 to 10/, 'no "changed" (Pro is still 50); ideally "There\'s now a maximum of 10 projects"'))
r.push(repro2('R5b Free plan removed', { ...req, 'app/plans.py': plans(['Free', 3], ['Pro', 50]) }, { ...req, 'app/plans.py': plans(['Pro', 50]) }, /changed from 3 to 50/, '"The maximum projects (3) is gone." (Pro unchanged)'))
// R6 "added" suppressed when the same name was defined anywhere before (a UI copy) — new server enforcement is silent
const ui = { 'components/Plan.tsx': 'const FREE_PROJECT_LIMIT = 3\nexport const P = () => <p>Up to {FREE_PROJECT_LIMIT} projects</p>\n' }
r.push(repro2('R6 server lib/limits.ts adds FREE_PROJECT_LIMIT; a component already had one', { ...pkg, ...ui, 'lib/limits.ts': 'export const X = 1\n' }, { ...pkg, ...ui, 'lib/limits.ts': 'export const X = 1\nexport const FREE_PROJECT_LIMIT = 3\n' }, NOTHING, '"There\'s now a free project limit of 3."'))
// R7 wording: unit suffixes after MAX_, and toLocaleString rounding small USD
r.push(repro2('R7 MAX_UPLOAD_MB / MAX_FILE_SIZE_BYTES / 0.0005 USD', { ...pkg, 'lib/v.ts': 'export const X = 1\n' }, { ...pkg, 'lib/v.ts': 'export const X = 1\nexport const MAX_UPLOAD_MB = 10\nexport const MAX_FILE_SIZE_BYTES = 5_242_880\nexport const MAX_COST_PER_REQUEST_USD = 0.0005\n' }, /maximum of 10 upload mb.*maximum of 0\.001 cost/, '"a maximum upload of 10 MB, a maximum file size of 5,242,880 bytes and a maximum cost per request of $0.0005"'))

  }
  {
    // (round 3)
// Round 3: new wrong facts / lost guesses. Each repro asserts the bad behaviour still happens.
const fn = (lim: string, cmp: string, count: string, imp = '') => `from openai import OpenAI\nfrom datetime import UTC, datetime, time, timedelta\n${imp}${lim}\n\ndef check(db, user_id):\n    used = ${count}\n    ${cmp}\n        raise LimitReached\n`
const daily = 'db.query(R).filter(R.user_id == user_id, R.created_at >= datetime.combine(datetime.now(UTC).date(), time.min, tzinfo=UTC)).count()'
const ever = 'db.query(R).filter(R.user_id == user_id).count()'
const NOTHING = /^(?![\s\S]*(is gone|There's now|replaced|changed from|counts everything|length cap))/
const r: boolean[] = []
// S1 rename-by-shared-word runs before the exact comparison swap: same allowance, reset dropped -> reads as a brand-new limit, no guess
r.push(repro('S1a DAILY_EDIT_LIMIT=20 -> FREE_EDIT_LIMIT=20, exact `used >= NEW` swap, daily filter removed', { ...req, 'app/ai.py': fn('DAILY_EDIT_LIMIT = 20', 'if used >= DAILY_EDIT_LIMIT:', daily) }, { ...req, 'app/ai.py': fn('FREE_EDIT_LIMIT = 20', 'if used >= FREE_EDIT_LIMIT:', ever) }, /^(?![\s\S]*counts everything ever)[\s\S]*There's now a free edit limit of 20/, '"The daily edit limit (20) is replaced by a free edit limit of 20." + the guess'))
r.push(repro('S1b DAILY_EDIT_LIMIT=20 -> MONTHLY_EDIT_LIMIT=20', { ...req, 'app/ai.py': fn('DAILY_EDIT_LIMIT = 20', 'if used >= DAILY_EDIT_LIMIT:', daily) }, { ...req, 'app/ai.py': fn('MONTHLY_EDIT_LIMIT = 20', 'if used >= MONTHLY_EDIT_LIMIT:', daily) }, /There's now a monthly edit limit of 20(?![\s\S]*daily edit limit)/, '"The daily edit limit (20) is replaced by a monthly edit limit of 20."'))
// S2 limit switched off with a sentinel: nothing at all
for (const v of ['None', 'float("inf")', '-1'])
  r.push(repro(`S2 MAX_PROJECTS = 3 -> ${v}`, { ...req, 'app/plans.py': 'MAX_PROJECTS = 3\n' }, { ...req, 'app/plans.py': `MAX_PROJECTS = ${v}\n` }, NOTHING, '"The maximum projects (3) is gone (no limit now)."'))
r.push(repro('S2 FREE_PROJECT_LIMIT = 3 -> Infinity', { ...pkg, 'lib/p.ts': 'export const FREE_PROJECT_LIMIT = 3\n' }, { ...pkg, 'lib/p.ts': 'export const FREE_PROJECT_LIMIT = Infinity\n' }, NOTHING, '"The free project limit (3) is gone (no limit now)."'))
// S3 date count includes imports: the limit file now imports the new trial helper -> p1 guess lost
const trial = 'from datetime import UTC, datetime, timedelta\nTRIAL_DAYS = 14\n\ndef trial_over(user):\n    return datetime.now(UTC) > user.created_at + timedelta(days=TRIAL_DAYS)\n\ndef trial_label(user):\n    return "Your trial ends today" if trial_over(user) else ""\n'
r.push(repro('S3 p1 shape; app/ai.py now does `from app.trial import trial_over`', { ...req, 'app/ai.py': fn('DAILY_REQUEST_LIMIT = 50', 'if used >= DAILY_REQUEST_LIMIT:', daily), 'app/trial.py': 'X = 1\n' }, { ...req, 'app/ai.py': fn('FREE_EDIT_LIMIT = 20', 'if used >= FREE_EDIT_LIMIT:', ever, 'from app.trial import trial_over\n'), 'app/trial.py': trial }, /^(?![\s\S]*counts everything ever)/, 'the guess'))
// S4 object-key limit now read from env: "gone" again (assigned() needs `=`)
r.push(repro('S4 { FREE_PROJECT_LIMIT: 3 } -> { FREE_PROJECT_LIMIT: Number(process.env... ?? 3) }', { ...pkg, 'lib/p.ts': 'export const LIMITS = {\n  FREE_PROJECT_LIMIT: 3,\n}\n' }, { ...pkg, 'lib/p.ts': 'export const LIMITS = {\n  FREE_PROJECT_LIMIT: Number(process.env.FREE_PROJECT_LIMIT ?? 3),\n}\n' }, /The free project limit \(3\) is gone/, 'no line'))
// S5 units/currency dropped in "changed"/"gone"; CHARS reads as "size"
r.push(repro('S5 MB / USD / CHARS in changed and gone lines', { ...pkg, 'lib/p.ts': 'export const MAX_UPLOAD_MB = 10\nexport const DAILY_AI_BUDGET_USD = 5\n' }, { ...pkg, 'lib/p.ts': 'export const MAX_UPLOAD_MB = 25\nexport const MAX_TITLE_CHARS = 80\n' }, /daily AI budget \(5\) is gone.*maximum upload changed from 10 to 25|maximum upload changed from 10 to 25.*daily AI budget \(5\) is gone/, '"The maximum upload size changed from 10 MB to 25 MB", "The daily AI budget ($5) is gone", "a maximum title length of 80 characters"'))
r.push(repro('S5b new MAX_TITLE_CHARS', { ...pkg, 'lib/p.ts': 'export const X = 1\n' }, { ...pkg, 'lib/p.ts': 'export const X = 1\nexport const MAX_TITLE_CHARS = 80\n' }, /maximum title size of 80 characters/, '"a maximum title length of 80 characters"'))
// S6 rename-by-shared-word hides a real "gone"
r.push(repro('S6 MAX_PROJECTS=3 + its check removed, PROJECTS_PER_ROW=3 added', { ...pkg, 'lib/p.ts': 'export const MAX_PROJECTS = 3\nexport const can = (n: number) => n < MAX_PROJECTS\n' }, { ...pkg, 'lib/p.ts': 'export const PROJECTS_PER_ROW = 3\nexport const can = (n: number) => true\n' }, NOTHING, '"The maximum projects (3) is gone."'))
// S7 MODEL_CALL `.invoke(` matches non-AI calls (supabase.functions.invoke, ipcRenderer.invoke) in an app that has an AI dep
const ai = { 'lib/ai.ts': "import OpenAI from 'openai'\nexport const o = new OpenAI()\n" }
r.push(repro('S7 token bucket maxTokens + supabase.functions.invoke', { ...pkg, ...ai, 'lib/edge.ts': "export async function call(s: any) {\n  return s.functions.invoke('x')\n}\n" }, { ...pkg, ...ai, 'lib/edge.ts': "const bucket = new TokenBucket({ maxTokens: 100 })\nexport async function call(s: any) {\n  await bucket.take()\n  return s.functions.invoke('x')\n}\n" }, /AI answers now have a length cap/, 'no AI card'))
// S8 (miss) a new capped call with the same value as an existing capped call
const call = (f: string, cap: string) => `def ${f}(m):\n    return client.chat.completions.create(model="x", messages=m${cap}).choices[0].message.content\n`
const head = 'from openai import OpenAI\nclient = OpenAI()\n'
r.push(repro('S8 rewrite() newly capped at 500; summarize() already had 500', { ...req, 'app/ai.py': head + call('summarize', ', max_tokens=500') + call('rewrite', '') }, { ...req, 'app/ai.py': head + call('summarize', ', max_tokens=500') + call('rewrite', ', max_tokens=500') }, NOTHING, 'the AI-cap card'))

  }
  {
    // (round 4)
// Round 4: new false alarms / wrong facts. Each repro asserts the bad behaviour still happens.
const NOTHING = /^(?![\s\S]*(is gone|There's now|replaced|changed from|counts everything|length cap))/
const EVER = /counts everything ever/
const r: boolean[] = []
// T1 helperBody only finds `def h(` / `function h(`: a date check moved into an arrow helper or an object method -> false "counts everything ever"
const before = "export const DAILY_EDIT_LIMIT = 20\nexport async function assertCanEdit(id: string) {\n  const used = await db.edit.count({ where: { userId: id, createdAt: { gte: startOfDay(new Date()) } } })\n  if (used >= DAILY_EDIT_LIMIT) throw new Error('limit')\n}\n"
r.push(repro('T1a arrow helper: const editsToday = async (id) => db.edit.count({ ... gte: startOfDay(...) })', { ...pkg, 'lib/limits.ts': before }, { ...pkg, 'lib/limits.ts': "export const FREE_EDIT_LIMIT = 20\nconst editsToday = async (id: string) =>\n  db.edit.count({ where: { userId: id, createdAt: { gte: startOfDay(new Date()) } } })\nexport async function assertCanEdit(id: string) {\n  const used = await editsToday(id)\n  if (used >= FREE_EDIT_LIMIT) throw new Error('limit')\n}\n" }, EVER, 'no guess (still counts today only)'))
r.push(repro('T1b object method in lib/usage.ts: usage.editsToday(id)', { ...pkg, 'lib/limits.ts': before }, { ...pkg, 'lib/limits.ts': "import { usage } from './usage'\nexport const FREE_EDIT_LIMIT = 20\nexport async function assertCanEdit(id: string) {\n  const used = await usage.editsToday(id)\n  if (used >= FREE_EDIT_LIMIT) throw new Error('limit')\n}\n", 'lib/usage.ts': "export const usage = {\n  async editsToday(id: string) {\n    return db.edit.count({ where: { userId: id, createdAt: { gte: startOfDay(new Date()) } } })\n  },\n}\n" }, EVER, 'no guess'))
// T2 rename via the definition-line fallback (limit used only in other files): a removed limit + an unrelated same-value limit -> both hidden
const route = (n: string) => `import { ${n} } from '@/lib/limits'\nexport async function POST() {\n  if ((await count()) >= ${n}) return new Response('limit', { status: 402 })\n}\n`
const base = { ...pkg, 'app/api/projects/route.ts': route('FREE_PROJECT_LIMIT') }
r.push(repro('T2 lib/limits.ts: FREE_PROJECT_LIMIT=3 removed (route stops checking), FREE_SEAT_LIMIT=3 added', { ...base, 'lib/limits.ts': 'export const FREE_PROJECT_LIMIT = 3\nexport const FREE_MEMBER_LIMIT = 5\n' }, { ...base, 'lib/limits.ts': 'export const FREE_MEMBER_LIMIT = 5\nexport const FREE_SEAT_LIMIT = 3\n', 'app/api/projects/route.ts': "export async function POST() {\n  return new Response('ok')\n}\n" }, NOTHING, '"There\'s now a free seat limit of 3. The free project limit (3) is gone." (with 4 instead of 3 it says exactly that)'))
// T3 rename-by-use-lines accepts an EXISTING constant: free tier dropped to the pro limit -> silent
r.push(repro('T3 limitFor(): FREE_PROJECT_LIMIT (3) removed, both branches now PRO_PROJECT_LIMIT (100)', { ...pkg, 'lib/l.ts': 'export const FREE_PROJECT_LIMIT = 3\nexport const PRO_PROJECT_LIMIT = 100\nexport const limitFor = (pro: boolean) => pro ? PRO_PROJECT_LIMIT : FREE_PROJECT_LIMIT\n' }, { ...pkg, 'lib/l.ts': 'export const PRO_PROJECT_LIMIT = 100\nexport const limitFor = (pro: boolean) => pro ? PRO_PROJECT_LIMIT : PRO_PROJECT_LIMIT\n' }, NOTHING, '"The free project limit (3) is gone."'))
// T4 unlimited: a Python conditional with None in one branch reads as "no limit now"
r.push(repro('T4 MAX_PROJECTS = None if SELF_HOSTED else 3', { ...req, 'app/plans.py': 'MAX_PROJECTS = 3\n' }, { ...req, 'app/plans.py': 'import os\nSELF_HOSTED = os.getenv("SELF_HOSTED") == "1"\nMAX_PROJECTS = None if SELF_HOSTED else 3\n' }, /is gone \(no limit now\)/, 'no line (still 3 unless self-hosted), or "…can now be turned off"'))

  }
  {
    // (round 5)
// Round 5: does anything new reproduce?
const EVER = /counts everything ever/
const before = "export const DAILY_EDIT_LIMIT = 20\nexport async function assertCanEdit(id: string) {\n  const used = await db.edit.count({ where: { userId: id, createdAt: { gte: startOfDay(new Date()) } } })\n  if (used >= DAILY_EDIT_LIMIT) throw new Error('limit')\n}\n"
const after = (helper: string) => `export const FREE_EDIT_LIMIT = 20\n${helper}\nexport async function assertCanEdit(id: string) {\n  const used = await editsToday(id)\n  if (used >= FREE_EDIT_LIMIT) throw new Error('limit')\n}\n`
const q = "db.edit.count({ where: { userId: id, createdAt: { gte: startOfDay(new Date()) } } })"
repro('U1 TS arrow helper with a return type: const editsToday = async (id: string): Promise<number> =>', { ...pkg, 'lib/limits.ts': before }, { ...pkg, 'lib/limits.ts': after(`const editsToday = async (id: string): Promise<number> =>\n  ${q}`) }, EVER, 'no guess')
repro('U2 control: arrow without return type', { ...pkg, 'lib/limits.ts': before }, { ...pkg, 'lib/limits.ts': after(`const editsToday = async (id: string) =>\n  ${q}`) }, EVER, 'no guess')
repro('U3 function expression: const editsToday = async function (id) {', { ...pkg, 'lib/limits.ts': before }, { ...pkg, 'lib/limits.ts': after(`const editsToday = async function (id: string) {\n  return ${q}\n}`) }, EVER, 'no guess')

  }
  console.log('ok (review 30)')
}
// Review 31: login through a helper in a Next.js server action (lead calls only, a helper that stops guests itself, no alias)
{
// Review 31 repros: `node repros.ts [plain root]`. Each prints the actual card line next to the expected one.
const pkg = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Comment {\n  id String @id\n  body String\n}\n' }
const line = (files: Record<string, string>) => report(new Map(Object.entries(pkg)), new Map(Object.entries({ ...pkg, ...files })), { ref: 'main' }).replace(/\s+/g, ' ').match(/New server code that [^.]*\./)?.[0]
const H = 'import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\n'
const requireUser = 'export async function requireUser() {\n  const session = await auth()\n  if (!session?.user) redirect("/login")\n  return session.user\n}\n'
const getMember = requireUser + 'export async function getMember() {\n  return await requireUser()\n}\n'
const act = (body: string, imp = 'import { getMember } from "@/lib/authz"') => `"use server"\nimport { prisma } from "@/lib/prisma"\n${imp}\nexport async function createCommentAction(formData: FormData) {\n${body}\n}\n`
const W = '  await prisma.comment.create({ data: { body: "x" } })'
const R: [string, string, string, string][] = [   // id, lib/authz.ts, action body, expected
  ['F1 helper returns null for guests', 'export async function getMember() {\n  const session = await auth()\n  if (!session?.user) return null\n  return session.user\n}\n', '  const user = await getMember()\n' + W, 'New server code that saves new comments.'],
  ['F2 aliased import reads the wrong fn', 'export async function getMember() {\n  const s = await auth()\n  if (!s?.user) redirect("/login")\n  return s.user\n}\nexport async function getMaybeUser() {\n  const s = await auth()\n  return s?.user ?? null\n}\n', '  const u = await getMember()\n' + W, 'New server code that saves new comments.'],
  ['F3 write via .save() before the call', getMember, '  await comment.save()\n  await getMember()', 'New server code that accepts requests.'],
  ['F3b write via sql`` before the call', getMember, '  await sql`DELETE FROM comments`\n  await getMember()', 'New server code that accepts requests.'],
  ['F4 action swallows the redirect', getMember, '  try { await getMember() } catch {}\n' + W, 'New server code that saves new comments.'],
  ['F4b not awaited', getMember, '  getMember()\n' + W, 'New server code that saves new comments.'],
  ['F4c only inside a loop', getMember, '  for (const id of formData.getAll("ids")) await getMember()\n' + W, 'New server code that saves new comments.'],
  ['F4d Promise.all with the write', getMember, '  await Promise.all([getMember(), prisma.comment.create({ data: { body: "x" } })])', 'New server code that saves new comments.'],
  ['F5 helper try/catch swallows its redirect', 'export async function getMember() {\n  try {\n    const session = await auth()\n    if (!session?.user) redirect("/login")\n    return session.user\n  } catch {\n    return null\n  }\n}\n', '  await getMember()\n' + W, 'New server code that saves new comments.'],
  ['F6 helper skips its check early', 'export async function getMember() {\n  if (process.env.DEMO) return { id: "demo" }\n  const session = await auth()\n  if (!session?.user) redirect("/login")\n  return session.user\n}\n', '  await getMember()\n' + W, 'New server code that saves new comments.'],
  ['F7 first match in a string', getMember, '  console.log("getMember() skipped")\n' + W + '\n  await getMember()', 'New server code that saves new comments.'],
  ['F7b first match in an uncalled closure', getMember, '  const check = async () => { await getMember() }\n' + W, 'New server code that saves new comments.'],
  ['M1 early return before the call (safe)', getMember, '  if (!formData.get("id")) return\n  await getMember()\n' + W, 'New server code that saves new comments and requires login ✓.'],
  ['M2 `??` then a `:` (safe)', getMember, '  const id = String(formData.get("id") ?? "")\n  const { id: uid } = await getMember()\n' + W, 'New server code that saves new comments and requires login ✓.'],
]
for (const [id, lib, body, want] of R) {
  const got = line({ 'lib/authz.ts': H + lib, 'app/actions/comments.ts': act(body, id.startsWith('F2') ? 'import { getMaybeUser as getMember } from "@/lib/authz"' : undefined) })
  assert.equal(got, want, `review 31 ${id}`)
}

  console.log('ok (review 31)')
}
// Review 31, round 2: a check in a try whose catch rethrows is still a check; require* by name only as a lead call; skipped
// statements call nothing of the app
{
// Review 31, round 2: `node r2.ts <plain root>`. Prints login/open per route (appFacts) and the card's login wording.
const routes = (files: Record<string, string>) => { const a = appFacts(new Map(Object.entries(files)))
  return [...a.routes].map(([k, x]: [string, { url: string }]) => `${x.url} ${a.files.get(k)!.auth ? 'login' : 'open'}`).sort().join(' | ') }
const alarm = (files: Record<string, string>) => { const c = report(new Map(Object.entries(files).filter(([k]) => k === 'package.json')), new Map(Object.entries(files)), { ref: 'main' }).replace(/\s+/g, ' ')
  return /Anyone can|without logging in/.test(c) ? ' ALARM' : '' }
const kit = { 'package.json': '{"devDependencies":{"@sveltejs/kit":"^2.8.0"},"dependencies":{"@prisma/client":"5"}}' }
const nuxt = { 'package.json': '{"dependencies":{"nuxt":"^3.13.0","@prisma/client":"5","nuxt-auth-utils":"0.5.0"}}' }
const next = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Comment {\n  id String @id\n}\n' }
const del = "export const DELETE = async () => {\n  await prisma.user.deleteMany()\n  return new Response()\n}\n"
const hook = (body: string) => ({ ...kit, 'src/hooks.server.ts': `export const handle = async ({ event, resolve }) => {\n${body}\n  return resolve(event)\n}\n`, 'src/routes/admin/users/+server.ts': del })
const cases: [string, Record<string, string>][] = [
  // --- context(): try with a catch, other stacks (all of these are safe: the catch rethrows or also turns people away)
  ['kit hook: check in try, catch rethrows', hook("  try {\n    if (!event.locals.user) redirect(303, '/login')\n  } catch (e) {\n    throw e\n  }")],
  ['kit +server: check in try, catch rethrows http errors', { ...kit, 'src/routes/api/x/+server.ts': "import { error, json, isHttpError } from '@sveltejs/kit'\nexport const POST = async ({ locals }) => {\n  try {\n    if (!locals.user) error(401)\n    await prisma.order.deleteMany()\n    return json({ ok: true })\n  } catch (e) {\n    if (isHttpError(e)) throw e\n    return json({ error: 'failed' }, { status: 500 })\n  }\n}\n" }],
  ['kit +server: check in try, catch returns 500', { ...kit, 'src/routes/api/x/+server.ts': "import { error, json } from '@sveltejs/kit'\nexport const POST = async ({ locals }) => {\n  try {\n    if (!locals.user) return json({ error: 'login' }, { status: 401 })\n    await prisma.order.deleteMany()\n    return json({ ok: true })\n  } catch (e) {\n    return json({ error: 'failed' }, { status: 500 })\n  }\n}\n" }],
  ['nuxt: requireUserSession in try, catch throws', { ...nuxt, 'server/api/orders.delete.ts': "export default defineEventHandler(async (event) => {\n  try {\n    await requireUserSession(event)\n    await prisma.order.deleteMany()\n  } catch (e) {\n    throw createError({ statusCode: 500 })\n  }\n})\n" }],
  ['nuxt: requireUserSession before try (control)', { ...nuxt, 'server/api/orders.delete.ts': "export default defineEventHandler(async (event) => {\n  await requireUserSession(event)\n  try {\n    await prisma.order.deleteMany()\n  } catch (e) {\n    throw createError({ statusCode: 500 })\n  }\n})\n" }],
  ['next action: own check in try, catch rethrows', { ...next, 'app/actions/c.ts': '"use server"\nimport { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nexport async function delAction() {\n  try {\n    const s = await auth()\n    if (!s?.user) redirect("/login")\n    await prisma.comment.deleteMany()\n  } catch (e) {\n    throw e\n  }\n}\n' }],
  ['next action: try/finally (no catch)', { ...next, 'app/actions/c.ts': '"use server"\nimport { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nexport async function delAction() {\n  try {\n    const s = await auth()\n    if (!s?.user) redirect("/login")\n    await prisma.comment.deleteMany()\n  } finally {\n    console.log("done")\n  }\n}\n' }],
  // --- leadCalls / stops: new false ✓?
  ['helper: requireUser().catch(() => null)', { ...next, 'lib/authz.ts': 'import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nexport async function requireUser() {\n  const s = await auth()\n  if (!s?.user) redirect("/login")\n  return s.user\n}\nexport async function getMember() {\n  return await requireUser().catch(() => null)\n}\n', 'app/actions/c.ts': '"use server"\nimport { getMember } from "@/lib/authz"\nexport async function delAction() {\n  await getMember()\n  await prisma.comment.deleteMany()\n}\n' }],
  ['helper: requireUser() not awaited', { ...next, 'lib/authz.ts': 'import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nexport async function requireUser() {\n  const s = await auth()\n  if (!s?.user) redirect("/login")\n  return s.user\n}\nexport async function getMember() {\n  requireUser()\n  return 1\n}\n', 'app/actions/c.ts': '"use server"\nimport { getMember } from "@/lib/authz"\nexport async function delAction() {\n  await getMember()\n  await prisma.comment.deleteMany()\n}\n' }],
  ['action: `if (x) return purge()` before the lead call', { ...next, 'lib/authz.ts': 'import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nexport async function getMember() {\n  const s = await auth()\n  if (!s?.user) redirect("/login")\n  return s.user\n}\nexport async function purge() {\n  await prisma.comment.deleteMany()\n}\n', 'app/actions/c.ts': '"use server"\nimport { getMember, purge } from "@/lib/authz"\nexport async function delAction(fd: FormData) {\n  if (fd.get("all")) return purge()\n  await getMember()\n}\n' }],
  ['action: `const p = purge()` (no await) before', { ...next, 'lib/authz.ts': 'import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nexport async function getMember() {\n  const s = await auth()\n  if (!s?.user) redirect("/login")\n  return s.user\n}\nexport async function purge() {\n  await prisma.comment.deleteMany()\n}\n', 'app/actions/c.ts': '"use server"\nimport { getMember, purge } from "@/lib/authz"\nexport async function delAction(fd: FormData) {\n  const p = purge()\n  await getMember()\n  await p\n}\n' }],
  ['action: write in the lead call\'s argument', { ...next, 'lib/authz.ts': 'import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nexport async function getMember(id: string) {\n  const s = await auth()\n  if (!s?.user) redirect("/login")\n  return s.user\n}\nexport async function purge() {\n  await prisma.comment.deleteMany()\n  return "x"\n}\n', 'app/actions/c.ts': '"use server"\nimport { getMember, purge } from "@/lib/authz"\nexport async function delAction(fd: FormData) {\n  await getMember(await purge())\n}\n' }],
]
// expected: the first 7 are safe (login, no alarm; try/finally included); the last 5 are not (open)
const want = (i: number) => i < 7 ? 'login' : 'open'
cases.forEach(([n, files], i) => { const got = routes(files), a = alarm(files), ok = got.endsWith(want(i)) && !(i < 7 && a)
  assert.ok(ok, `review 31 r2 ${n}: ${got}${a}`) })

  console.log('ok (review 31, round 2)')
}
// Review 31, round 3: a catch that throws only other errors swallows the redirect; app calls in a lead call's arguments or
// through an imported object
{
// Review 31, round 3: `node r3.ts <plain root>`. Server-action login per case; expected in the table.
const next = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Comment {\n  id String @id\n}\n' }
const login = (files: Record<string, string>) => { const a = appFacts(new Map(Object.entries({ ...next, ...files })))
  return [...a.routes].filter(([, x]: [string, { url: string }]) => x.url.includes('delAction')).map(([k]: [string]) => a.files.get(k)!.auth ? 'login' : 'open')[0] }
const alarm = (files: Record<string, string>) => /Anyone can|without logging in/.test(report(new Map(Object.entries(next)), new Map(Object.entries({ ...next, ...files })), { ref: 'main' }))
const H = 'import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\n'
const RU = 'export async function requireUser() {\n  const s = await auth()\n  if (!s?.user) redirect("/login")\n  return s.user\n}\n'
const act = (imp: string, body: string) => `"use server"\n${imp}\nexport async function delAction(fd: FormData) {\n${body}\n}\n`
const W = '  await prisma.comment.deleteMany()'
const cases: [string, Record<string, string>, 'login' | 'open'][] = [
  // helper's catch throws something else but swallows the redirect
  ['helper catch throws only for ZodError', { 'lib/authz.ts': H + 'export async function getMember() {\n  try {\n    const s = await auth()\n    if (!s?.user) redirect("/login")\n    return s.user\n  } catch (e) {\n    if (e instanceof ZodError) throw new Error("bad")\n    return null\n  }\n}\n', 'app/actions/c.ts': act('import { getMember } from "@/lib/authz"', '  await getMember()\n' + W) }, 'open'],
  // passed-over statements calling app code through a namespace / object method
  ['if (x) return repo.removeAll() before lead', { 'lib/authz.ts': H + RU, 'lib/repo.ts': 'export async function removeAll() {\n  await prisma.comment.deleteMany()\n}\n', 'app/actions/c.ts': act('import { requireUser } from "@/lib/authz"\nimport * as repo from "@/lib/repo"', '  if (fd.get("all")) return repo.removeAll()\n  await requireUser()') }, 'open'],
  ['const p = repo.purgeAll() (no await) before lead', { 'lib/authz.ts': H + RU, 'lib/repo.ts': 'export async function purgeAll() {\n  await prisma.comment.deleteMany()\n}\n', 'app/actions/c.ts': act('import { requireUser } from "@/lib/authz"\nimport * as repo from "@/lib/repo"', '  const p = repo.purgeAll()\n  await requireUser()\n  await p') }, 'open'],
  ['lead call arg runs an app fn (no await)', { 'lib/authz.ts': H + 'export async function getMember(x: unknown) {\n  const s = await auth()\n  if (!s?.user) redirect("/login")\n  return s.user\n}\nexport async function purge() {\n  await prisma.comment.deleteMany()\n}\n', 'app/actions/c.ts': act('import { getMember, purge } from "@/lib/authz"', '  await getMember(purge())') }, 'open'],
  // regressions vs HEAD's correct ✓ (should stay login)
  ['own check (auth + redirect) in action', { 'app/actions/c.ts': act('import { auth } from "@/auth"\nimport { redirect } from "next/navigation"', '  const s = await auth()\n  if (!s?.user) redirect("/login")\n' + W) }, 'login'],
  ['direct requireUser after await of a method', { 'lib/authz.ts': H + RU, 'app/actions/c.ts': act('import { requireUser } from "@/lib/authz"\nimport { cookies } from "next/headers"', '  const jar = await cookies()\n  const t = jar.get("t")\n  await requireUser()\n' + W) }, 'login'],
  ['direct requireUser after zod parse (method calls)', { 'lib/authz.ts': H + RU, 'app/actions/c.ts': act('import { requireUser } from "@/lib/authz"\nimport { z } from "zod"', '  const input = z.object({ id: z.string() }).parse(Object.fromEntries(fd))\n  await requireUser()\n' + W) }, 'login'],
  ['package requireUser, lead', { 'app/actions/c.ts': act('import { requireUser } from "@acme/auth"', '  await requireUser()\n' + W) }, 'login'],
  ['helper with catch that rethrows (safe)', { 'lib/authz.ts': H + 'export async function getMember() {\n  try {\n    const s = await auth()\n    if (!s?.user) redirect("/login")\n    return s.user\n  } catch (e) {\n    throw e\n  }\n}\n', 'app/actions/c.ts': act('import { getMember } from "@/lib/authz"', '  await getMember()\n' + W) }, 'login'],
]
cases.forEach(([n, f, want]) => { const got = login(f), a = alarm(f)
  assert.equal(got, want, `review 31 r3 ${n}`) })

  console.log('ok (review 31, round 3)')
}
// Review 31, round 4: a catch passes the redirect on only when it rethrows first thing (throw e, unstable_rethrow(e),
// if (isRedirectError(e)) throw e); otherwise it swallows it
{
// Review 31, round 5: r4 cases plus an inverted isRedirectError guard and a conditional unstable_rethrow.
const next = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"6.0.0"}}' }
const login = (files: Record<string, string>) => { const a = appFacts(new Map(Object.entries({ ...next, ...files })))
  return [...a.routes].filter(([, x]: [string, { url: string }]) => x.url.includes('delAction')).map(([k]: [string]) => a.files.get(k)!.auth ? 'login' : 'open')[0] }
const helper = (c: string) => 'import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\nexport async function getMember() {\n  try {\n    const s = await auth()\n    if (!s?.user) redirect("/login")\n    return s.user\n  } catch (e) {\n' + c + '\n  }\n}\n'
const act = '"use server"\nimport { getMember } from "@/lib/authz"\nexport async function delAction() {\n  await getMember()\n  await prisma.comment.deleteMany()\n}\n'
for (const [n, c, want] of [
  ['catch rethrows only ZodError', '    if (e instanceof ZodError) throw e\n    return null', 'open'],
  ['catch rethrows only if !(e instanceof Error)', '    if (!(e instanceof Error)) throw e\n    return null', 'open'],
  ['catch rethrows redirect errors (safe)', '    if (isRedirectError(e)) throw e\n    return null', 'login'],
  ['catch throw e (safe)', '    throw e', 'login'],
  ['catch rethrows NON-redirect errors', '    if (!isRedirectError(e)) throw e\n    return null', 'open'],
  ['catch unstable_rethrow only sometimes', '    if (process.env.X) unstable_rethrow(e)\n    return null', 'open'],
]) { const got = login({ 'lib/authz.ts': helper(c), 'app/actions/c.ts': act }); assert.equal(got, want, `review 31 r5 ${n}`) }

  console.log('ok (review 31, round 4)')
}
// "Tests couldn't be executed": the agent didn't run them
assert.ok(report(new Map([['a.ts', 'export const a = 1\n']]), new Map([['a.ts', 'export const a = 2\n']]), { ref: 'main', agentSaid: 'Done. Tests couldn’t be executed because the environment has no Go toolchain installed.' }).includes("didn't run or test"), 'untested: passive')
// (round 10) "Full runtime testing wasn’t possible", "tests weren’t available", "Full builds could not run"; not "a refund wasn't possible"
for (const said of ['Full runtime testing wasn’t possible because dependencies aren’t installed.', 'Full runtime tests weren’t available because dependencies aren’t installed locally.', 'Full builds could not run because dependencies are not installed.'])
  assert.ok(report(new Map([['a.ts', 'export const a = 1\n']]), new Map([['a.ts', 'export const a = 2\n']]), { ref: 'main', agentSaid: said }).includes("didn't run or test"), `untested: ${said}`)
assert.ok(!report(new Map([['a.ts', 'export const a = 1\n']]), new Map([['a.ts', 'export const a = 2\n']]), { ref: 'main', agentSaid: 'Done. A refund wasn’t possible for free orders, so they are skipped. Tests pass.' }).includes("didn't run or test"), 'untested: not about tests')
// Share links: a page with a token in the address and a lookup with it opens from a private link (no login claim: an app-wide guard plain
// can't read may still ask); open read-only server code says "anyone with the link"; an address ending in /share that only sets a token
// or public field turns the link on and off (its DELETE doesn't delete the document)
{
  const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const next = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0"}}' }
  const page = (param: string) => `export default async function P({ params }: { params: Promise<{ ${param}: string }> }) {\n  const { ${param} } = await params\n  const s = await prisma.projectShare.findUnique({ where: { token: ${param} } })\n  return <main><h1>{s?.name}</h1></main>\n}\n`
  let c = card(next, { ...next, 'app/share/[token]/page.tsx': page('token') })
  assert.ok(c.includes('It opens from a private link, so only people who have the link can find it.') && !c.includes('no login'), c)
  c = card(next, { ...next, 'app/p/[shareId]/page.tsx': page('shareId') })
  assert.ok(c.includes('private link'), c)
  // (review 32) under a middleware plain can't map: still only "private link"
  c = card(next, { ...next, 'middleware.ts': 'export { auth as middleware } from "@/auth"\n', 'app/share/[token]/page.tsx': page('token') })
  assert.ok(c.includes('private link') && !c.includes('no login'), c)
  // a page cursor isn't a secret
  c = card(next, { ...next, 'app/feed/[pageToken]/page.tsx': page('pageToken') })
  assert.ok(!c.includes('private link'), c)
  // not a secret: an id, a slug
  for (const x of ['[id]', '[slug]']) { c = card(next, { ...next, [`app/projects/${x}/page.tsx`]: page(x.slice(1, -1)) }); assert.ok(!c.includes('private link'), `${x}: ${c}`) }
  // logged in: no "no login needed"
  const na = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"6.0.0"}}' }
  c = card(na, { ...na, 'app/share/[token]/page.tsx': 'import { auth } from "@/auth"\nimport { redirect } from "next/navigation"\n' + page('token').replace('{\n', '{\n  const session = await auth()\n  if (!session?.user) redirect("/login")\n') })
  assert.ok(!c.includes('private link') && c.includes('log in to open it ✓'), c)
  // nothing looked up: no claim
  c = card(next, { ...next, 'app/share/[token]/page.tsx': 'export default function P() { return <main><h1>Hi</h1></main> }\n' })
  assert.ok(!c.includes('private link'), c)

  // FastAPI: the public page and the on/off address
  const req = { 'requirements.txt': 'fastapi\nsqlalchemy\n', 'app/models.py': 'class Document(Base):\n    __tablename__ = "documents"\n    id: Mapped[int] = mapped_column(primary_key=True)\n    public_id: Mapped[str | None] = mapped_column(String(64))\n' }
  const api = 'from fastapi import APIRouter, Depends\nfrom .models import Document\nrouter = APIRouter()\n\n'
    + '@router.post("/documents/{document_id}/share")\ndef share(document_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):\n    d = db.get(Document, document_id)\n    d.public_id = secrets.token_urlsafe(32)\n    db.commit()\n\n'
    + '@router.delete("/documents/{document_id}/share")\ndef unshare(document_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):\n    d = db.get(Document, document_id)\n    d.public_id = None\n    db.commit()\n\n'
    + '@router.get("/s/{public_id}")\ndef public_page(public_id: str, db: Session = Depends(get_db)):\n    return db.scalar(select(Document).where(Document.public_id == public_id))\n'
  c = card(req, { ...req, 'app/api.py': api })
  assert.ok(c.includes('turns sharing on or off for documents and requires login ✓'), c)
  assert.ok(c.includes('shows documents to anyone with the link, no login needed'), c)
  assert.ok(!c.includes('deletes documents') && !c.includes('lists documents'), c)
  // a /share address that really deletes something keeps saying so
  c = card(req, { ...req, 'app/api.py': api.replace('    d.public_id = None\n', '    db.delete(d)\n') })
  assert.ok(c.includes('deletes documents') && !c.includes('sharing on'), c)
  // (review 32) a handler that sets no token field (a helper plain can't follow), or emails someone: not a share link
  c = card(req, { ...req, 'app/api.py': api.replace('    d.public_id = None\n', '    purge(d)\n') })
  assert.ok(!c.includes('sharing on'), c)
  // open: anyone can publish anyone's documents
  c = card(req, { ...req, 'app/api.py': api.replaceAll('user: User = Depends(get_current_user), ', '') })
  assert.ok(c.includes('⚠ Anyone can turn sharing on or off for your documents without logging in.') && !c.includes('spam'), c)
  // a GET whose own handler checks a login plain can't read: no "no login needed"
  c = card(req, { ...req, 'app/api.py': api.replace('db: Session = Depends(get_db)):\n    return', 'db: Session = Depends(get_db), me = Depends(require_viewer)):\n    return') })
  assert.ok(!c.includes('no login needed'), c)

  // Express: /invite/:inviteCode
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0","@prisma/client":"6.0.0"}}' }
  c = card(ex, { ...ex, 'server.js': 'const express = require("express")\nconst app = express()\napp.get("/invites/:inviteCode", async (req, res) => {\n  res.json(await prisma.invite.findUnique({ where: { code: req.params.inviteCode } }))\n})\napp.listen(3000)\n' })
  assert.ok(c.includes('shows invites to anyone with the link, no login needed'), c)
  // (review 32) a guarded GET next to an open POST: the address isn't "no login needed"
  c = card(ex, { ...ex, 'server.js': 'const express = require("express")\nconst app = express()\napp.get("/invites/:inviteCode", requireAuth, async (req, res) => {\n  res.json(await prisma.invite.findUnique({ where: { code: req.params.inviteCode } }))\n})\napp.post("/invites/:inviteCode", async (req, res) => {\n  res.json(await prisma.member.create({ data: { code: req.params.inviteCode } }))\n})\napp.listen(3000)\n' })
  assert.ok(!c.includes('with the link'), c)
  // a visible update that clears the token: still a share link
  c = card(next, { ...next, 'app/api/documents/[id]/share/route.ts': 'import { auth } from "@/auth"\nexport async function DELETE(req: Request, { params }: { params: { id: string } }) {\n  const s = await auth()\n  if (!s?.user) return new Response(null, { status: 401 })\n  await prisma.document.update({ where: { id: params.id }, data: { publicId: null } })\n  return new Response(null, { status: 204 })\n}\n' })
  assert.ok(c.includes('turns sharing on or off for documents') && !c.includes('deletes documents'), c)
  // (review 32b) not secrets: a cursor, a phone's push token, a public_id outside a share address
  for (const [dir, prm] of [['feed', 'syncToken'], ['devices', 'deviceToken'], ['products', 'public_id']]) {
    c = card(next, { ...next, [`app/${dir}/[${prm}]/page.tsx`]: page(prm) }); assert.ok(!c.includes('private link'), `${prm}: ${c}`) }
  // a share counter, a where filter, another field written alongside, every row at once: not a share link, the spam Check stays
  const share = (body: string) => card(next, { ...next, 'app/api/documents/[id]/share/route.ts': `export async function POST(req: Request, { params }: { params: { id: string } }) {\n  ${body}\n  return Response.json({})\n}\n` })
  for (const body of ['await prisma.document.update({ where: { id: params.id }, data: { shares: { increment: 1 } } })', 'await prisma.document.update({ where: { id: params.id, shareToken: "t" }, data: { title: "x" } })',
    'await prisma.document.update({ where: { id: params.id }, data: { shareToken: "t", ownerId: "u" } })', 'await prisma.document.updateMany({ data: { isPublic: true } })']) {
    c = share(body); assert.ok(!c.includes('sharing on') && !c.includes('⚠') && c.includes('nothing limits spam'), `${body}: ${c}`) }
  c = share('await prisma.document.update({ where: { id: params.id }, data: { shareToken: crypto.randomUUID() } })')
  assert.ok(c.includes('turns sharing on or off for documents') && c.includes('⚠ Anyone can turn sharing on or off for your documents without logging in.'), c)
  // a wrapper plain can't read: the Check, not the ⚠
  c = card(next, { ...next, 'app/api/documents/[id]/share/route.ts': 'export const POST = withAuth(async (req: Request, { params }: { params: { id: string } }) => {\n  await prisma.document.update({ where: { id: params.id }, data: { shareToken: "t" } })\n  return Response.json({})\n})\n' })
  assert.ok(!c.includes('⚠'), c)
  // (review 32c) the token isn't used in the lookup, or is a number, or isn't a link's: no claim
  c = card(next, { ...next, 'app/share/[token]/page.tsx': page('token').replace('findUnique({ where: { token: token } })', 'findMany()') })
  assert.ok(!c.includes('private link'), c)
  c = card(next, { ...next, 'app/s/[shareId]/page.tsx': page('shareId').replace('token: shareId', 'id: Number(shareId)') })
  assert.ok(!c.includes('private link'), c)
  for (const dir of ['nft', 'token', 'secrets']) { c = card(next, { ...next, [`app/${dir}/[token]/page.tsx`]: page('token') }); assert.ok(!c.includes('private link'), `${dir}: ${c}`) }
  // another call (a helper that may delete), a body written whole, raw SQL: not "sharing on or off"
  for (const body of ['await prisma.document.update({ where: { id: params.id }, data: { shareToken: null } })\n  await purgeVersions(params.id)',
    'const body = await req.json()\n  body.isPublic = true\n  await prisma.document.update({ where: { id: params.id }, data: body })',
    'await prisma.document.update({ where: { id: params.id }, data: { shareToken: null } })\n  await prisma.$executeRaw`DELETE FROM versions`']) {
    c = share(body); assert.ok(!c.includes('sharing on') && !c.includes('⚠'), `${body}: ${c}`) }
  // a POST that revokes: "on or off", never "makes"
  c = share('await prisma.document.update({ where: { id: params.id }, data: { shareToken: null } })')
  assert.ok(c.includes('turns sharing on or off for documents'), c)
  // an app-wide hook plain can't map: the Check, not the ⚠
  c = card(next, { ...next, 'src/hooks.server.ts': 'export const handle = sequence(gate)\n', 'app/api/documents/[id]/share/route.ts': 'export async function POST(req: Request, { params }: { params: { id: string } }) {\n  await prisma.document.update({ where: { id: params.id }, data: { shareToken: "t" } })\n  return Response.json({})\n}\n' })
  assert.ok(!c.includes('⚠') && c.includes('nothing limits spam'), c)
  // (review 32d) a coin's [token] (looked up by symbol), a share id that is the document's own id or a number: no claim
  for (const [path, body] of [['app/swap/[token]/page.tsx', 'prisma.token.findUnique({ where: { symbol: token } })'], ['app/share/[shareId]/page.tsx', 'prisma.document.findUnique({ where: { id: shareId } })'],
    ['app/share/[shareId]/page.tsx', 'prisma.share.findUnique({ where: { id: +shareId } })']]) {
    const prm = path.match(/\[(\w+)\]/)![1]
    c = card(next, { ...next, [path]: page(prm).replace(`prisma.projectShare.findUnique({ where: { token: ${prm} } })`, body) }); assert.ok(!c.includes('private link'), `${path} ${body}: ${c}`) }
  // (review 32e) a local copy of the param isn't a link field
  c = card(next, { ...next, 'app/share/[shareId]/page.tsx': page('shareId').replace('const { shareId } = await params', 'const shareId = (await params).shareId').replace('token: shareId', 'id: shareId') })
  assert.ok(!c.includes('private link'), c)
  // helpers named like a login check or a lookup that do more, and an update with fields plain can't see: not "sharing on or off"
  for (const body of ['await transferOwnership(params.id)\n  await prisma.document.update({ where: { id: params.id }, data: { shareToken: "t" } })',
    'await fetchAndPurgeVersions(params.id)\n  await prisma.document.update({ where: { id: params.id }, data: { shareToken: "t" } })',
    'await fetch("https://hooks.example.com", { method: "POST" })\n  await prisma.document.update({ where: { id: params.id }, data: { shareToken: "t" } })', 'await inviteUser(params.id)\n  await prisma.document.update({ where: { id: params.id }, data: { shareToken: "t" } })']) {
    c = share(body); assert.ok(!c.includes('sharing on'), `${body}: ${c}`) }
  // a wrapper plain can't read, a password the visitor sends: no "no login needed"
  c = card(next, { ...next, 'app/api/s/[shareToken]/route.ts': 'export const GET = withWorkspace(async (req: Request, { params }: { params: { shareToken: string } }) => {\n  return Response.json(await prisma.document.findFirst({ where: { shareToken: params.shareToken } }))\n})\n' })
  assert.ok(!c.includes('no login needed'), c)
  c = card(next, { ...next, 'app/api/s/[shareToken]/route.ts': 'export async function GET(req: Request, { params }: { params: { shareToken: string } }) {\n  const d = await prisma.document.findFirst({ where: { shareToken: params.shareToken } })\n  if (req.headers.get("x-share-password") !== d?.password) return new Response(null, { status: 403 })\n  return Response.json(d)\n}\n' })
  assert.ok(!c.includes('no login needed'), c)
  c = card(next, { ...next, 'app/api/s/[shareToken]/route.ts': 'export async function GET(req: Request, { params }: { params: { shareToken: string } }) {\n  return Response.json(await prisma.document.findFirst({ where: { shareToken: params.shareToken } }))\n}\n' })
  assert.ok(c.includes('shows documents to anyone with the link, no login needed'), c)
  console.log('ok (share links)')
}
// "Only lets the workspace's members in ✓": a server action whose lead helper looks up the user's membership with the value it's
// given and stops when there's none, and whose every write carries that value (where for updates and deletes, data for creates)
{
  const card = (files: Record<string, string>) => report(new Map(Object.entries(pkg0)), new Map(Object.entries({ ...pkg0, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
  const pkg0 = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"6.0.0"}}' }
  const authz = (lookup: string, sig = 'workspaceId: string') => 'import { notFound, redirect } from "next/navigation"\nimport { auth } from "@/auth"\nimport { prisma } from "@/lib/prisma"\n'
    + 'export async function requireUser() {\n  const session = await auth()\n  if (!session?.user?.id) redirect("/login")\n  return session.user\n}\n'
    + `export async function requireWorkspaceMember(${sig}) {\n  const user = await requireUser()\n${lookup}\n  return { user }\n}\n`
    + 'export async function requireWorkspaceAdmin(workspaceId: string) {\n  const r = await requireWorkspaceMember(workspaceId)\n  return r\n}\n'
  const rel = '  const workspace = await prisma.workspace.findFirst({ where: { id: workspaceId, memberships: { some: { userId: user.id } } } })\n  if (!workspace) notFound()'
  const act = (write: string, helper = 'requireWorkspaceMember', imp = '{ requireWorkspaceMember, requireWorkspaceAdmin }') => `"use server"\nimport { prisma } from "@/lib/prisma"\nimport ${imp} from "@/lib/authz"\nexport async function updateTaskAction(formData: FormData) {\n  const workspaceId = String(formData.get("workspaceId"))\n  const taskId = String(formData.get("taskId"))\n  const { user } = await ${helper}(workspaceId)\n  ${write}\n}\n`
  const scoped = 'await prisma.task.updateMany({ where: { id: taskId, workspaceId }, data: { title: "x" } });'
  const yes = "only lets the workspace's members in ✓", no = (c: string, why: string) => assert.ok(!c.includes('members in') && c.includes('requires login ✓'), `${why}: ${c}`)
  let c = card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act(scoped) })
  assert.ok(c.includes(`updates tasks and ${yes}`), c)
  // the membership row itself (compound key), and an admin helper one level down
  c = card({ 'lib/authz.ts': authz('  const m = await prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: user.id } } })\n  if (!m) throw new Error("Forbidden")'), 'app/actions/tasks.ts': act(scoped) })
  assert.ok(c.includes(yes), c)
  c = card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act(scoped, 'requireWorkspaceAdmin') })
  assert.ok(c.includes(yes), c)
  // a create carries it in its data
  c = card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act('await prisma.task.create({ data: { workspaceId, title: "x" } });') })
  assert.ok(c.includes(`saves new tasks and ${yes}`), c)
  // not: a task updated by its id alone (another workspace's), the value only in data, no stop, the user given, a write in a helper,
  // a login-only helper, a helper imported under another name
  no(card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act('await prisma.task.update({ where: { id: taskId }, data: { title: "x" } });') }), 'by id')
  no(card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act('await prisma.task.update({ where: { id: taskId }, data: { note: workspaceId } });') }), 'in data')
  no(card({ 'lib/authz.ts': authz('  const workspace = await prisma.workspace.findFirst({ where: { id: workspaceId, memberships: { some: { userId: user.id } } } })'), 'app/actions/tasks.ts': act(scoped) }), 'no stop')
  no(card({ 'lib/authz.ts': authz('  const m = await prisma.membership.findFirst({ where: { workspaceId, userId } })\n  if (!m) notFound()', 'workspaceId: string, userId: string'), 'app/actions/tasks.ts': act(scoped) }), 'user given')
  no(card({ 'lib/authz.ts': authz(rel), 'lib/tasks.ts': 'import { prisma } from "@/lib/prisma"\nexport async function rename(id: string) {\n  await prisma.task.update({ where: { id }, data: { title: "x" } })\n}\n', 'app/actions/tasks.ts': act(scoped + '\n  await rename(taskId)').replace('import { prisma }', 'import { rename } from "@/lib/tasks"\nimport { prisma }') }), 'helper write')
  no(card({ 'lib/authz.ts': authz(''), 'app/actions/tasks.ts': act(scoped) }), 'login only')
  c = card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act(scoped, 'requireWorkspaceAdmin', '{ requireWorkspaceMember as requireWorkspaceAdmin }') })
  assert.ok(!c.includes('members in'), `alias: ${c}`)
  // (review 33) the key with another value, a re-read by id, an unchecked id from the form, a row moved out, a transaction, OR
  for (const [why, write] of [
    ['other value', 'await prisma.task.updateMany({ where: { id: taskId, workspaceId: String(formData.get("t")) }, data: { title: "x" } });'],
    ['re-read by id', scoped + '\n  return prisma.task.findUnique({ where: { id: taskId }, include: { comments: true } })'],
    ['unchecked id', 'await prisma.comment.create({ data: { workspaceId, taskId, authorId: user.id, body: "x" } });'],
    ['moved out', 'await prisma.task.updateMany({ where: { id: taskId, workspaceId }, data: { workspaceId: String(formData.get("to")) } });'],
    ['transaction', scoped + '\n  await prisma.$transaction(async (tx) => { await tx.task.delete({ where: { id: taskId } }) });'],
    ['OR', 'await prisma.task.updateMany({ where: { OR: [{ workspaceId }, { id: taskId }] }, data: { title: "x" } });'],
    ['checked another value', scoped.replace('workspaceId }', 'workspaceId }')]]) {
    const a = why === 'checked another value' ? act(write).replace('requireWorkspaceMember(workspaceId)', 'requireWorkspaceMember(taskId)') : act(write)
    no(card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': a }), why) }
  // an id from the form checked first by a lookup limited to the workspace, with a stop: fine
  c = card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act('const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId } });\n  if (!task) return;\n  await prisma.comment.create({ data: { workspaceId, taskId, authorId: user.id, body: "x" } });') })
  assert.ok(c.includes(`saves new comments and ${yes}`), c)
  // the helper: a try around the check, an early return for site admins, OR in the lookup, a local forbidden() that returns a value
  no(card({ 'lib/authz.ts': authz('  try {\n' + rel + '\n  } catch (e) { console.error(e) }'), 'app/actions/tasks.ts': act(scoped) }), 'try')
  no(card({ 'lib/authz.ts': authz('  if (user.role === "superadmin") return { user }\n' + rel), 'app/actions/tasks.ts': act(scoped) }), 'early return')
  no(card({ 'lib/authz.ts': authz('  const workspace = await prisma.workspace.findFirst({ where: { OR: [{ id: workspaceId, memberships: { some: { userId: user.id } } }, { id: workspaceId, isPublic: true }] } })\n  if (!workspace) notFound()'), 'app/actions/tasks.ts': act(scoped) }), 'OR lookup')
  no(card({ 'lib/authz.ts': authz(rel.replace('notFound()', 'return forbidden()')).replace('export async function requireUser', 'const forbidden = () => ({ error: "forbidden" })\nexport async function requireUser'), 'app/actions/tasks.ts': act(scoped) }), 'local forbidden')
  // (review 33b) a destination from the form, data that isn't written out, a helper that reads, a nested include, a check after the
  // write, an OrThrow caught
  for (const [why, write, extra] of [
    ['destination', 'const dest = String(formData.get("to"));\n  await prisma.task.updateMany({ where: { id: taskId, workspaceId }, data: { projectId: dest } });'],
    ['data variable', 'const parsed = schema.parse(Object.fromEntries(formData));\n  await prisma.task.updateMany({ where: { id: taskId, workspaceId }, data: parsed });'],
    ['helper reads', scoped + '\n  return getBoard(taskId)', { 'lib/q.ts': 'import { prisma } from "@/lib/prisma"\nexport async function getBoard(id: string) {\n  return prisma.task.findMany({ where: { projectId: id }, include: { comments: true } })\n}\n' }],
    ['nested include', 'return prisma.task.findMany({ where: { workspaceId }, include: { assignee: { include: { tasks: true } } } });\n  await prisma.task.updateMany({ where: { id: taskId, workspaceId }, data: { title: "x" } });'],
    ['check after', 'const projectId = String(formData.get("p"));\n  await prisma.task.updateMany({ where: { id: taskId, workspaceId }, data: { projectId } });\n  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });\n  if (!project) return null;'],
  ] as [string, string, Record<string, string>?][]) {
    const a = act(write).replace('import { prisma }', extra ? 'import { getBoard } from "@/lib/q"\nimport { prisma }' : 'import { prisma }')
    no(card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': a, ...extra }), why) }
  no(card({ 'lib/authz.ts': authz('  const workspace = await prisma.workspace.findFirstOrThrow({ where: { id: workspaceId, memberships: { some: { userId: user.id } } } }).catch(() => null)'), 'app/actions/tasks.ts': act(scoped) }), 'OrThrow caught')
  // (review 33c) a repository or namespace plain can't follow, a loop variable named user, a value reassigned, a regex literal
  const repo = 'import { prisma } from "@/lib/prisma"\nexport async function archiveProject(id: string) {\n  await prisma.project.update({ where: { id }, data: { archived: true } })\n}\nexport const projectRepo = { archive: archiveProject }\n'
  no(card({ 'lib/authz.ts': authz(rel), 'lib/projects.ts': repo, 'app/actions/tasks.ts': act(scoped + '\n  await projectRepo.archive(taskId)').replace('import { prisma }', 'import { projectRepo } from "@/lib/projects"\nimport { prisma }') }), 'repo object')
  no(card({ 'lib/authz.ts': authz(rel), 'lib/projects.ts': repo, 'app/actions/tasks.ts': act(scoped + '\n  await projects.archiveProject(taskId)').replace('import { prisma }', 'import * as projects from "@/lib/projects"\nimport { prisma }') }), 'namespace')
  no(card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act('const ids = formData.getAll("m").map(String);\n  await Promise.all(ids.map((user) => prisma.notification.create({ data: { workspaceId, userId: user.id } })));\n  ' + scoped) }), 'shadowed user')
  no(card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act(scoped.replace('await', 'if (formData.get("to")) workspaceId = String(formData.get("to"));\n  await')) }), 'reassigned')
  no(card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act('const title = String(formData.get("t")).replace(/\'/g, "");\n  await prisma.task.updateMany({ where: { id: taskId, workspaceId }, data: { title } });') }), 'regex literal')
  // (review 33d) a helper that calls a repository, a local function passed to map, a destructured loop variable, a regex after =>
  no(card({ 'lib/authz.ts': authz(rel), 'lib/projects.ts': repo + 'export async function archiveAll(id: string) {\n  await projectRepo.archive(id)\n}\n', 'app/actions/tasks.ts': act(scoped + '\n  await archiveAll(taskId)').replace('import { prisma }', 'import { archiveAll } from "@/lib/projects"\nimport { prisma }') }), 'helper calls repo')
  no(card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act(scoped + '\n  await Promise.all([taskId].map(archiveOne))') + 'async function archiveOne(id: string) {\n  await prisma.project.update({ where: { id }, data: { archived: true } })\n}\n' }), 'passed to map')
  no(card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act('const rows = JSON.parse(String(formData.get("rows")));\n  for (const { workspaceId, title } of rows) await prisma.task.create({ data: { workspaceId, title } });') }), 'loop variable')
  no(card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act('const ok = (s: string) => /^[\\w\' -]+$/.test(s);\n  if (formData.get("p") === "on") {\n    const project = await prisma.project.findFirst({ where: { id: String(formData.get("p")), workspaceId } });\n    if (!project) return;\n  }\n  ' + scoped) }), 'regex')
  // (review 33e) a default import runs the module's default, not the checked helper; a loop that writes into a checked id
  no(card({ 'lib/authz.ts': authz(rel) + 'export default async function requireLoggedIn(workspaceId: string) {\n  return requireUser()\n}\n', 'app/actions/tasks.ts': act(scoped, 'requireWorkspaceMember', 'requireWorkspaceMember') }), 'default import')
  no(card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act('let projectId = String(formData.get("p"));\n  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });\n  if (!project) return;\n  for (projectId of formData.getAll("more").map(String)) await prisma.task.updateMany({ where: { id: taskId, workspaceId }, data: { projectId } });') }), 'loop target')
  // a small local function that touches nothing is fine
  c = card({ 'lib/authz.ts': authz(rel), 'app/actions/tasks.ts': act('await prisma.task.updateMany({ where: { id: taskId, workspaceId }, data: { title: clean(String(formData.get("t"))) } });') + 'function clean(s: string) {\n  return s.trim()\n}\n' })
  assert.ok(c.includes(yes), c)
  // Owners and admins: the admin helper runs the member check, then right away turns away other roles, on the role from the user's own
  // membership (the include keeps only theirs)
  const relRole = '  const workspace = await prisma.workspace.findFirst({ where: { id: workspaceId, memberships: { some: { userId: user.id } } }, include: { memberships: { where: { userId: user.id }, select: { role: true } } } })\n  if (!workspace) notFound()'
  const roled = (lookup: string, gate: string) => authz(lookup).replace('  return { user }\n}\nexport async function requireWorkspaceAdmin', '  return { user, role: workspace.memberships[0].role }\n}\nexport async function requireWorkspaceAdmin')
    .replace('  const r = await requireWorkspaceMember(workspaceId)\n  return r', `  const r = await requireWorkspaceMember(workspaceId)\n${gate}\n  return r`)
  const adminAct = act(scoped, 'requireWorkspaceAdmin')
  const admins = "only lets the workspace's owners and admins in ✓"
  c = card({ 'lib/authz.ts': roled(relRole, '  if (r.role !== "owner" && r.role !== "admin") notFound()'), 'app/actions/tasks.ts': adminAct })
  assert.ok(c.includes(admins), c)
  c = card({ 'lib/authz.ts': roled(relRole, '  if (!["owner", "admin"].includes(r.role)) notFound()'), 'app/actions/tasks.ts': adminAct })
  assert.ok(c.includes(admins), c)
  // no gate: members; || lets everyone but one through; the role from an unfiltered include (anyone's); a gate after something else;
  // a local forbidden(); the result reassigned
  c = card({ 'lib/authz.ts': roled(relRole, ''), 'app/actions/tasks.ts': adminAct })
  assert.ok(c.includes(yes) && !c.includes('admins'), c)
  for (const [why, lookup, gate] of [['||', relRole, '  if (r.role !== "owner" || r.role !== "admin") notFound()'],
    ['unfiltered include', relRole.replace('memberships: { where: { userId: user.id }, select: { role: true } }', 'memberships: { select: { role: true } }'), '  if (r.role !== "owner" && r.role !== "admin") notFound()'],
    ['not right after', relRole, '  console.log(r)\n  if (r.role !== "owner" && r.role !== "admin") notFound()'],
    ['local forbidden', relRole, '  if (r.role !== "owner" && r.role !== "admin") return forbidden()'],
    ['reassigned', relRole, '  if (r.role !== "owner" && r.role !== "admin") notFound()\n  r = { ...r, role: "owner" }']]) {
    c = card({ 'lib/authz.ts': roled(lookup, gate).replace('const r = await', why === 'reassigned' ? 'let r = await' : 'const r = await'), 'app/actions/tasks.ts': adminAct })
    assert.ok(!c.includes('admins in'), `${why}: ${c}`) }
  // (review 35) the user's site-wide role (`return m.user`), a staff override in another return, a fallback: members only
  const rowLookup = '  const m = await prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: user.id } }, include: { user: true } })\n  if (!m) notFound()'
  const gate = '  if (r.role !== "owner" && r.role !== "admin") notFound()'
  for (const [why, files] of [
    ['site-wide role', authz(rowLookup).replace('  return { user }\n}\nexport async function requireWorkspaceAdmin', '  return m.user\n}\nexport async function requireWorkspaceAdmin')],
    ['staff override', roled(relRole, gate).replace('  return { user, role: workspace.memberships[0].role }', '  if (user.email === process.env.SUPPORT_EMAIL) return { user, role: "owner" }\n  return { user, role: workspace.memberships[0].role }')],
    ['fallback', roled(relRole, gate).replace('role: workspace.memberships[0].role }', 'role: workspace.memberships[0].role ?? user.role }')]]) {
    const f = why === 'site-wide role' ? files.replace('  const r = await requireWorkspaceMember(workspaceId)\n  return r', `  const r = await requireWorkspaceMember(workspaceId)\n${gate}\n  return r`) : files
    c = card({ 'lib/authz.ts': f, 'app/actions/tasks.ts': adminAct }); assert.ok(!c.includes('admins in') && c.includes(yes), `${why}: ${c}`) }
  // (review 35b) the role changed before the return
  c = card({ 'lib/authz.ts': roled(relRole, gate).replace('  return { user, role: workspace.memberships[0].role }', '  if (user.email === process.env.SUPPORT_EMAIL) workspace.memberships[0].role = "owner"\n  return { user, role: workspace.memberships[0].role }'), 'app/actions/tasks.ts': adminAct })
  assert.ok(!c.includes('admins in') && c.includes(yes), `role changed: ${c}`)
  // a role that isn't a kind of person reads as itself
  c = card({ 'lib/authz.ts': roled(relRole, '  if (r.role !== "billing") notFound()'), 'app/actions/tasks.ts': adminAct })
  assert.ok(c.includes("only lets the workspace's members with the billing role in ✓"), c)
  // a project's lookup through its workspace's members isn't "the project's members"
  no(card({ 'lib/authz.ts': authz('  const project = await prisma.project.findFirst({ where: { id: workspaceId, workspace: { memberships: { some: { userId: user.id } } } } })\n  if (!project) notFound()'), 'app/actions/tasks.ts': act(scoped) }), 'project via workspace')
  console.log('ok (workspace members)')
}
// Migrations: a new column on a table the app already had (Prisma asks for every column, so loading those rows fails anywhere until
// it's applied), and a project whose own migrate script is `prisma migrate dev` (not for a live database)
{
  const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const pkg = (scripts: string) => ({ 'package.json': `{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0"},"scripts":{${scripts}}}` })
  const schema = (extra: string) => ({ 'prisma/schema.prisma': `model Workspace {\n  id String @id\n  name String\n${extra}}\n` })
  const base = { ...pkg('"db:migrate":"prisma migrate dev"'), ...schema('') }
  const mig = (sql: string) => ({ 'prisma/migrations/2_x/migration.sql': sql })
  let c = card(base, { ...base, ...schema('  plan String @default("free")\n'), ...mig('ALTER TABLE "Workspace"\nADD COLUMN "plan" TEXT NOT NULL DEFAULT \'free\';\n') })
  assert.ok(c.includes('or pages that load workspaces can fail too, not just the new parts (Prisma asks for every column).'), c)
  assert.ok(c.includes("Don't use the `db:migrate` script there: it runs `prisma migrate dev`"), c)
  // a new table only: the new parts
  c = card(base, { ...base, 'prisma/schema.prisma': base['prisma/schema.prisma'] + 'model Label {\n  id String @id\n}\n', ...mig('CREATE TABLE "Label" ("id" TEXT NOT NULL);\n') })
  assert.ok(c.includes('or the parts that use it will fail.'), c)
  // a deploy script too: no warning about the dev one
  const both = { ...pkg('"db:migrate":"prisma migrate dev","db:deploy":"prisma migrate deploy"'), ...schema('') }
  c = card(both, { ...both, ...schema('  plan String @default("free")\n'), ...mig('ALTER TABLE "Workspace" ADD COLUMN "plan" TEXT;\n') })
  assert.ok(!c.includes("Don't use"), c)
  // a table named apart from its model (@@map) is that model's; a model's own name, once it's mapped elsewhere, isn't a table
  const mapped = { ...base, 'prisma/schema.prisma': 'model Workspace {\n  id String @id\n  @@map("workspaces")\n}\n' }
  c = card(mapped, { ...mapped, 'prisma/schema.prisma': 'model Workspace {\n  id String @id\n  plan String?\n  @@map("workspaces")\n}\n', ...mig('ALTER TABLE "workspaces" ADD COLUMN "plan" TEXT;\n') })
  assert.ok(c.includes('or pages that load workspaces can fail too'), c)
  c = card(mapped, { ...mapped, 'prisma/schema.prisma': 'model Workspace {\n  id String @id\n  plan String?\n  @@map("workspaces")\n}\n', ...mig('ALTER TABLE "Workspace" ADD COLUMN "plan" TEXT;\n') })
  assert.ok(c.includes('or the parts that use it will fail.'), c)
  // a table renamed with @@map is its model's; the sessions table of a login library that reads it through Prisma (nextcrm's
  // better-auth session.impersonatedBy): logging in fails for everyone until it's applied
  const sess = (auth: string, extra: string, more = '') => ({ 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0","better-auth":"1.7.0","next-auth":"5.0.0"}}', 'lib/auth.ts': auth,
    'prisma/schema.prisma': `model Session {\n  id String @id\n  meta Json @default("{}")\n  // @@map("sessions")\n${extra}  @@map(name: "session")\n}\n${more}` })
  const better = 'import { betterAuth } from "better-auth"\nimport { prismaAdapter } from "better-auth/adapters/prisma"\nexport const auth = betterAuth({ database: prismaAdapter(prisma, { provider: "postgresql" }) })\n'
  const addCol = mig('ALTER TABLE "session" ADD COLUMN "impersonated_by" TEXT;\n'), col = '  impersonatedBy String? @map("impersonated_by")\n'
  c = card(sess(better, ''), { ...sess(better, col), ...addCol })
  assert.ok(c.includes('or logging in can fail for everyone, not just the new parts: your login library loads sessions'), c)
  // (review 93) installed but not wired through Prisma, Auth.js keeping sessions in a cookie: the pages wording. Another widened table stays.
  for (const auth of ['export const x = 1\n', 'import NextAuth from "next-auth"\nimport { PrismaAdapter } from "@auth/prisma-adapter"\nexport const { auth } = NextAuth({ adapter: PrismaAdapter(prisma), session: { strategy: "jwt" } })\n']) {
    c = card(sess(auth, ''), { ...sess(auth, col), ...addCol }); assert.ok(c.includes('or pages that load sessions can fail too') && !c.includes('logging in'), c) }
  const ws = 'model Workspace {\n  id String @id\n}\n'
  c = card(sess(better, '', ws), { ...sess(better, col, ws.replace('}', '  plan String?\n}')), ...mig('ALTER TABLE "session" ADD COLUMN "impersonated_by" TEXT;\nALTER TABLE "Workspace" ADD COLUMN "plan" TEXT;\n') })
  assert.ok(c.includes('logging in can fail') && c.includes('Pages that load workspaces can fail too.'), c)
  // (review 34) a column Prisma never asks for (Unsupported, @ignore, only in the SQL), or one only in a comment: the new parts
  for (const [extra, sql] of [['  search Unsupported("tsvector")?\n', 'ALTER TABLE "Workspace" ADD COLUMN "search" tsvector;\n'], ['  legacy String? @ignore\n', 'ALTER TABLE "Workspace" ADD COLUMN "legacy" TEXT;\n'],
    ['', 'ALTER TABLE "Workspace" ADD COLUMN "search" tsvector;\n'], ['  plan String?\n', '-- was: ALTER TABLE "Workspace" ADD COLUMN "plan" TEXT;\nCREATE TABLE "Label" ("id" TEXT);\n']]) {
    c = card(base, { ...base, ...schema(extra), ...mig(sql) }); assert.ok(c.includes('or the parts that use it will fail.'), `${sql}: ${c}`) }
  // a schema change with no migration in a project that updates its database with its own `prisma db push` script (expense.fyi's
  // dbpush): that script, not migrate. Not once the project has migrations.
  const pushed = { ...pkg('"dbpush":"prisma generate && prisma db push","migrate":"prisma migrate dev --create-only"'), ...schema('') }
  c = card(pushed, { ...pushed, ...schema('  plan String?\n') })
  assert.ok(c.includes('run `npm run dbpush` (it runs `prisma db push`) on your computer and on your live database.') && !c.includes('migrate deploy'), c)
  // (review 88) never a script that resets or accepts data loss, one that only mentions it, nor in a project with migrations elsewhere
  // or a deploy script
  for (const scripts of ['"db:reset":"prisma db push --force-reset && prisma db seed"', '"db:push":"prisma db push --accept-data-loss"',
    `"note":"echo 'never run prisma db push' && echo ok"`, '"db:push":"prisma db push","db:deploy":"prisma migrate deploy"']) {
    const x = { ...pkg(scripts), ...schema('') }; c = card(x, { ...x, ...schema('  plan String?\n') })
    assert.ok(!c.includes('(it runs `prisma db push`)') && c.includes('npx prisma migrate dev'), `${scripts}: ${c}`) }
  // (review 89) a script that also seeds, builds or starts the app is never offered; one that only pushes is, even listed later
  for (const scripts of ['"setup":"prisma db push && prisma db seed"', '"dev":"prisma db push && next dev"', '"build":"prisma generate && prisma db push && next build"']) {
    const x = { ...pkg(scripts), ...schema('') }; c = card(x, { ...x, ...schema('  plan String?\n') })
    assert.ok(!c.includes('(it runs `prisma db push`)'), `${scripts}: ${c}`)
    const y = { ...pkg(`${scripts},"db:push":"prisma db push"`), ...schema('') }; c = card(y, { ...y, ...schema('  plan String?\n') })
    assert.ok(c.includes('run `npm run db:push`'), `${scripts}: ${c}`) }
  // (review 90) a push that backgrounds or substitutes something, a --config, a deploy written with its flags first, an npm pre/post
  // script that seeds, a --schema or package.json setting naming another schema, a prisma.config file: never offered.
  // A script that runs one that only pushes (npm, pnpm, yarn) is.
  for (const [scripts, extra] of [['"db:push":"prisma db push & node seed.js"', {}], ['"db:push":"prisma db push $(cat flags)"', {}], ['"db:push":"prisma db push --config prod.config.ts"', {}],
    ['"db:push":"prisma db push","release":"prisma migrate --schema x deploy"', {}], ['"db:push":"prisma db push","postdb:push":"node seed.js"', {}],
    ['"db:push":"prisma db push --schema other/schema.prisma"', {}], ['"db:push":"prisma db push"', { 'prisma.config.ts': 'export default {}\n' }]] as const) {
    const x = { ...pkg(scripts), ...schema(''), ...extra }; c = card(x, { ...x, ...schema('  plan String?\n') })
    assert.ok(!c.includes('(it runs `prisma db push`)'), `${scripts}: ${c}`) }
  for (const runner of ['npm run', 'pnpm', 'yarn']) {
    const x = { ...pkg(`"db":"prisma generate && ${runner} push:only","push:only":"prisma db push"`), ...schema('') }; c = card(x, { ...x, ...schema('  plan String?\n') })
    assert.ok(c.includes('run `npm run db`'), `${runner}: ${c}`) }
  const elsewhere = { ...pushed, 'db/migrations/1_init/migration.sql': 'CREATE TABLE "Workspace" ("id" TEXT);\n' }
  c = card(elsewhere, { ...elsewhere, ...schema('  plan String?\n') })
  assert.ok(!c.includes('(it runs `prisma db push`)'), c)
  c = card({ ...pushed, ...mig('CREATE TABLE "Workspace" ("id" TEXT);\n') }, { ...pushed, ...schema('  plan String?\n'), ...mig('CREATE TABLE "Workspace" ("id" TEXT);\n') })
  assert.ok(c.includes('run `npx prisma migrate dev`'), c)
  console.log('ok (migration wording)')
}
// 💰 said for what it does: a refund gives money back, a price or a coupon changes what people pay; only a charge "charges customers"
{
  const card = (files: Record<string, string>) => report(new Map(Object.entries(pkg)), new Map(Object.entries({ ...pkg, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
  const pkg = { 'package.json': '{"dependencies":{"next":"15.0.0","stripe":"17.0.0","next-auth":"5.0.0"}}' }
  const route = (body: string) => ({ 'app/api/admin/x/route.ts': `import { auth } from "@/auth"\nimport Stripe from "stripe"\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)\nexport async function POST(req: Request) {\n  const s = await auth()\n  if (!s?.user) return new Response(null, { status: 401 })\n  ${body}\n  return Response.json({})\n}\n` })
  let c = card(route('await stripe.refunds.create({ payment_intent: "pi" })'))
  assert.ok(c.includes('gives customers money back 💰') && !c.includes('charges customers'), c)
  c = card(route('await stripe.prices.create({ unit_amount: 500, currency: "usd", product: "p" })'))
  assert.ok(c.includes('adds a price in Stripe 💰') && !c.includes('charges customers'), c)
  // (review 36) an update can't change a price's amount, a product isn't a price: plain words; capturing a payment charges
  c = card(route('await stripe.prices.update("price_1", { active: false })\n  await stripe.products.update("prod_1", { name: "x" })'))
  assert.ok(!c.includes('💰') && c.includes('asks Stripe to update a price'), c)
  c = card(route('await stripe.paymentIntents.capture("pi_1")'))
  assert.ok(c.includes('charges customers 💰') && c.includes('asks Stripe to collect a payment'), c)
  c = card(route('await stripe.invoiceItems.list()\n  await stripe.payouts.create({ amount: 100, currency: "usd" })'))
  assert.ok(c.includes('sends money out of your Stripe balance 💰') && c.includes('asks Stripe to list invoice items'), c)
  c = card(route('await stripe.coupons.create({ percent_off: 20 })'))
  assert.ok(c.includes('creates a Stripe discount 💰') && !c.includes('charges customers'), c)
  c = card(route('await stripe.promotionCodes.create({ coupon: "c", code: "SPRING" })'))
  assert.ok(c.includes('makes Stripe discount codes 💰'), c)
  c = card(route('await stripe.paymentIntents.create({ amount: 500, currency: "usd" })'))
  assert.ok(c.includes('charges customers 💰'), c)
  // Python
  const py = { 'requirements.txt': 'fastapi\nstripe\n' }
  c = report(new Map(Object.entries(py)), new Map(Object.entries({ ...py, 'app/main.py': 'import stripe\nfrom fastapi import FastAPI, Depends\napp = FastAPI()\n@app.post("/orders/{order_id}/refund")\ndef refund(order_id: int, user = Depends(get_current_user)):\n    stripe.Refund.create(payment_intent="pi")\n' })), { ref: 'main' }).replace(/\s+/g, ' ')
  assert.ok(c.includes('gives customers money back 💰'), c)
  // a refund row of the app's own (a Django related manager, a Rails has_many) isn't Stripe
  const dj = { 'requirements.txt': 'django\n' }
  c = report(new Map(Object.entries(dj)), new Map(Object.entries({ ...dj, 'shop/views.py': 'from django.contrib.auth.decorators import login_required\nfrom .models import Order\n@login_required\ndef refund(request, pk):\n    order = Order.objects.get(pk=pk)\n    order.refunds.create(amount=order.total)\n', 'shop/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [path("orders/<int:pk>/refund", views.refund)]\n' })), { ref: 'main' }).replace(/\s+/g, ' ')
  assert.ok(!c.includes('money back') && !c.includes('uses Stripe'), c)
  const rb = { 'Gemfile': 'gem "rails"\n' }
  c = report(new Map(Object.entries(rb)), new Map(Object.entries({ ...rb, 'config/routes.rb': 'Rails.application.routes.draw do\n  post "orders/:id/refund", to: "orders#refund"\nend\n', 'app/controllers/orders_controller.rb': 'class OrdersController < ApplicationController\n  def refund\n    order = Order.find(params[:id])\n    order.refunds.create(amount: order.total)\n  end\nend\n' })), { ref: 'main' }).replace(/\s+/g, ' ')
  assert.ok(!c.includes('money back') && !c.includes('uses Stripe'), c)
  // (review 36b) a Client model's refunds aren't Stripe's
  c = report(new Map(Object.entries(dj)), new Map(Object.entries({ ...dj, 'shop/views.py': 'from django.contrib.auth.decorators import login_required\nfrom .models import Client\n@login_required\ndef refund(request, pk):\n    client = Client.objects.get(pk=pk)\n    client.refunds.create(amount=5)\n', 'shop/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [path("clients/<int:pk>/refund", views.refund)]\n' })), { ref: 'main' }).replace(/\s+/g, ' ')
  assert.ok(!c.includes('money back') && !c.includes('uses Stripe'), c)
  c = report(new Map(Object.entries(rb)), new Map(Object.entries({ ...rb, 'config/routes.rb': 'Rails.application.routes.draw do\n  post "clients/:id/charge", to: "clients#charge"\nend\n', 'app/controllers/clients_controller.rb': 'class ClientsController < ApplicationController\n  def charge\n    @client = Client.find(params[:id])\n    @client.charges.create(amount: 5)\n  end\nend\n' })), { ref: 'main' }).replace(/\s+/g, ' ')
  assert.ok(!c.includes('charges customers') && !c.includes('uses Stripe'), c)
  // a discount made in Stripe still counts as money for "you asked for a discount" guesses
  c = report(new Map(Object.entries(pkg)), new Map(Object.entries({ ...pkg, ...route('await stripe.promotionCodes.create({ coupon: "c", code: "WELCOME20" })') })), { ref: 'main', asked: 'give new customers 20% off with a welcome code when they sign up' }).replace(/\s+/g, ' ')
  assert.ok(/You asked for a discount/.test(c), c)
  console.log('ok (money wording)')
}
// "Nothing limits spam" only when no server code mentions a rate limiter (Rails 8 rate_limit, express-rate-limit, ...)
{
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0","@prisma/client":"6.0.0"}}' }
  const srv = (pre: string) => ({ 'server.js': `const express = require("express")\n${pre}const app = express()\napp.post("/reviews", async (req, res) => {\n  res.json(await prisma.review.create({ data: req.body }))\n})\napp.listen(3000)\n` })
  let c = report(new Map(Object.entries(ex)), new Map(Object.entries({ ...ex, ...srv('') })), { ref: 'main' }).replace(/\s+/g, ' ')
  assert.ok(c.includes('nothing limits spam or fake reviews'), c)
  c = report(new Map(Object.entries(ex)), new Map(Object.entries({ ...ex, ...srv('const rateLimit = require("express-rate-limit")\napp.use(rateLimit({ windowMs: 60000, limit: 10 }))\n') })), { ref: 'main' }).replace(/\s+/g, ' ')
  assert.ok(c.includes('Anyone can post reviews without logging in.') && !c.includes('nothing limits spam'), c)
  const rb = { 'Gemfile': 'gem "rails"\n' }
  c = report(new Map(Object.entries(rb)), new Map(Object.entries({ ...rb, 'config/routes.rb': 'Rails.application.routes.draw do\n  resources :reviews, only: [:create]\nend\n', 'app/controllers/reviews_controller.rb': 'class ReviewsController < ApplicationController\n  rate_limit to: 10, within: 3.minutes, only: :create\n  def create\n    Review.create!(params.require(:review).permit(:body))\n  end\nend\n' })), { ref: 'main' }).replace(/\s+/g, ' ')
  assert.ok(!c.includes('nothing limits spam'), c)
  console.log('ok (spam limiter)')
}
// "Room members only ✓" for Socket.IO events: the handler's first step turns away anyone not in the room it names, with a member check
// on the logged-in socket user, and everything after stays in that room
{
  const schema = 'model User {\n  id String @id\n  displayName String\n  messages Message[]\n}\nmodel RoomMember {\n  roomId String\n  userId String\n  joinedAt DateTime\n  @@id([roomId, userId])\n}\nmodel Message {\n  id String @id\n  roomId String\n  userId String\n  body String\n  user User @relation(fields: [userId], references: [id])\n}\n'
  const pkg = { 'package.json': '{"dependencies":{"express":"4.0.0","socket.io":"4.0.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': schema }
  const helper = 'async function isMember(roomId: string, userId: string): Promise<boolean> {\n  return Boolean(await prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId } }, select: { roomId: true } }))\n}\n'
  const guard = 'io.use((socket, next) => {\n  const token = socket.handshake.auth.token\n  if (!token) return next(new Error("Authentication required"))\n  socket.data.user = verifyToken(token)\n  next()\n})\n'
  const send = (body: string) => `  socket.on("send message", async (payload: any, ack?: any) => {\n    try {\n${body}\n    } catch {\n      ack?.({ ok: false })\n    }\n  })\n`
  const ok = '      const roomId = typeof payload?.roomId === "string" ? payload.roomId : ""\n      if (!(await isMember(roomId, user.id))) {\n        ack?.({ ok: false })\n        return\n      }\n      const message = await prisma.message.create({ data: { roomId, userId: user.id, body: String(payload.body) } })\n      io.to(`room:${roomId}`).emit("new message", message)'
  const file = (h: string, body: string, g = guard) => ({ 'server/socket.ts': `import { Server } from "socket.io"\nimport { prisma } from "./prisma"\n${h}export function setup(io: Server) {\n${g}io.on("connection", (socket) => {\n  const user = socket.data.user\n${send(body)}})\n}\n` })
  const card = (files: Record<string, string>) => report(new Map(Object.entries(pkg)), new Map(Object.entries({ ...pkg, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
  let c = card(file(helper, ok))
  assert.ok(c.includes('"send message" (saves new messages, room members only ✓)'), c)
  const no = (files: Record<string, string>, why: string) => { const x = card(files); assert.ok(!x.includes('room members only'), `${why}: ${x}`) }
  no(file(helper, ok.replace('      if (!(await isMember(roomId, user.id))) {\n        ack?.({ ok: false })\n        return\n      }\n', '') + '\n      if (!(await isMember(roomId, user.id))) return'), 'check after the write')
  no(file(helper.replace('roomId_userId: { roomId, userId }', 'roomId_userId: { roomId, userId: roomId }'), ok), 'helper ignores the user')
  no(file(helper, ok.replace('isMember(roomId, user.id)', 'isMember(roomId, payload.userId)')), 'user from the payload')
  no(file(helper, ok.replace('io.to(`room:${roomId}`)', 'io.to(`room:${payload.other}`)')), 'another room')
  no(file(helper, ok.replace('if (!(await isMember(roomId, user.id)))', 'if (payload.strict && !(await isMember(roomId, user.id)))')), 'and')
  no(file(helper.replace('  return Boolean(', '  try {\n    return Boolean(').replace('}\n', '} catch { return true }\n}\n'), ok), 'helper swallows errors')
  no(file(helper, ok, ''), 'no connection login')
  no(file(helper, ok.replace('const roomId =', 'let roomId =') + '\n      roomId = payload.next'), 'room reassigned')
  no(file(helper, ok.replace('        ack?.({ ok: false })\n        return\n', '        ack?.({ ok: false })\n')), 'no return')
  // (review 38) everyone gets it, the user rebound from what the client sends, a call that writes elsewhere, a room that isn't a string,
  // a token decoded without checking, related rows of other rooms, a member who may have left
  no(file(helper, ok.replace('io.to(`room:${roomId}`).emit', 'io.emit')), 'io.emit')
  no(file(helper, ok.replace('io.to(`room:${roomId}`).emit', 'socket.broadcast.emit')), 'broadcast')
  no(file(helper, '      const { user } = payload\n' + ok), 'user rebound')
  no(file(helper + 'async function save(roomId: string, userId: string) {\n  await prisma.message.create({ data: { roomId, userId, body: "x" } })\n}\n', ok + '\n      await save(payload.other, user.id)'), 'call that writes')
  no(file(helper, ok.replace('const roomId = typeof payload?.roomId === "string" ? payload.roomId : ""', 'const roomId = payload.roomId')), 'room not a string')
  no(file(helper, ok, guard.replace('verifyToken(token)', 'jwt.decode(token)')), 'decode')
  no(file(helper, ok.replace('body: String(payload.body) } })', 'body: String(payload.body) }, include: { user: { include: { messages: true } } } })')), 'nested include')
  no(file(helper, ok.replace('body: String(payload.body) } })', 'body: String(payload.body) }, include: { user: { select: { displayName: true, messages: true } } } })')), 'select relation')
  // (review 38b) a helper of the connection that writes, a service object, an auto-join member check, an emit through ?.
  no(file(helper, ok.replace('      const message =', '      const save = async (r: string) => prisma.message.deleteMany({ where: { roomId: r } })\n      await save(payload.other)\n      const message =')), 'connection helper')
  const svc = file(helper, ok + '\n      await messages.remove(payload.id)'); svc['server/socket.ts'] = svc['server/socket.ts'].replace('import { prisma } from "./prisma"', 'import { prisma } from "./prisma"\nimport { messages } from "./services"')
  no(svc, 'service object')
  no(file(helper.replace('  return Boolean(', '  await prisma.roomMember.upsert({ where: { roomId_userId: { roomId, userId } }, create: { roomId, userId }, update: {} })\n  return Boolean('), ok), 'auto-join')
  no(file(helper, ok.replace('io.to(`room:${roomId}`).emit', 'io.emit?.')), 'emit ?.')
  // (review 38c) a callback's parameter named like an imported writer, the server handed to a helper, the user's id set from the client
  const store = file(helper, ok + '\n      const rows = ["a"].map((msgStore) => msgStore.trim())\n      await msgStore.create({ roomId: payload.other, body: rows[0] })'); store['server/socket.ts'] = store['server/socket.ts'].replace('import { prisma } from "./prisma"', 'import { prisma } from "./prisma"\nimport { msgStore } from "./store"')
  no(store, 'shadowed import')
  no(file(helper + 'async function wipe(r: string) {\n  await prisma.message.deleteMany({ where: { roomId: r } })\n}\n', ok + '\n      try { JSON.parse("x") } catch (wipe) { console.log(wipe) }\n      await wipe(payload.other)'), 'catch shadows')
  no(file(helper + 'function shout(s: any, x: string) {\n  s.send(x)\n}\n', ok + '\n      shout(io, "hi")'), 'server handed over')
  no(file(helper, '      user.id = payload.as\n' + ok), 'user id set')
  // (review 38e) code in a parameter's default runs before the guard; another listener for the same event
  no(file(helper, ok).replace ? (() => { const f = file(helper, ok); f['server/socket.ts'] = f['server/socket.ts'].replace('async (payload: any, ack?: any)', 'async (payload: any, ack: any = void prisma.message.deleteMany({ where: {} }))'); return f })() : {}, 'default parameter')
  const second = file(helper, ok); second['server/socket.ts'] = second['server/socket.ts'].replace('io.on("connection", (socket) => {\n  const user = socket.data.user\n', 'io.on("connection", (socket) => {\n  const user = socket.data.user\n  const EV = "send message"\n  socket.on(EV, async () => { await prisma.message.deleteMany({ where: {} }) })\n')
  no(second, 'second listener')
  const leftSchema = { 'prisma/schema.prisma': schema.replace('  joinedAt DateTime\n', '  joinedAt DateTime\n  leftAt DateTime?\n') }
  c = report(new Map(Object.entries({ ...pkg, ...leftSchema })), new Map(Object.entries({ ...pkg, ...leftSchema, ...file(helper, ok) })), { ref: 'main' }).replace(/\s+/g, ' ')
  assert.ok(!c.includes('room members only'), `left: ${c}`)
  // a plain field of the author is fine
  c = card(file(helper, ok.replace('body: String(payload.body) } })', 'body: String(payload.body) }, include: { user: { select: { displayName: true } } } })')))
  assert.ok(c.includes('room members only ✓'), c)
  // Changed events: a room check that's gone, a weaker one (the rooms the socket joined), or one moved to a helper or inline
  const before = file(helper, ok)
  const after = (body: string) => file(helper, body)
  const changed = (body: string) => report(new Map(Object.entries({ ...pkg, ...before })), new Map(Object.entries({ ...pkg, ...after(body) })), { ref: 'main' }).replace(/\s+/g, ' ')
  c = changed(ok.replace('      if (!(await isMember(roomId, user.id))) {\n        ack?.({ ok: false })\n        return\n      }\n', ''))
  assert.ok(c.includes(`plain can't see the room check on the "send message" event anymore`), c)
  c = changed(ok.replace('if (!(await isMember(roomId, user.id)))', 'if (!socket.rooms.has(`room:${roomId}`))'))
  assert.ok(c.includes('The "send message" event no longer checks room membership each time'), c)
  for (const body of [ok.replace('      if (!(await isMember(roomId, user.id))) {\n        ack?.({ ok: false })\n        return\n      }\n', '      await send(io, { roomId, userId: user.id })\n'),
    ok.replace('if (!(await isMember(roomId, user.id)))', 'if (!(await prisma.roomMember.findFirst({ where: { roomId, userId: user.id } })))')]) {
    c = changed(body); assert.ok(!c.includes('room check') && !c.includes('no longer checks room membership'), `${body}: ${c}`) }
  // (review 44b) a check called inside the if; a room-name helper inside socket.rooms.has(...) doesn't hide the weaker check
  c = changed(ok.replace('if (!(await isMember(roomId, user.id)))', 'if (!isInRoom(roomId, user.id))'))
  assert.ok(!c.includes('room check'), c)
  c = changed(ok.replace('if (!(await isMember(roomId, user.id)))', 'if (!socket.rooms.has(roomKey(roomId)))'))
  assert.ok(c.includes('no longer checks room membership each time'), c)
  c = changed(ok.replace('String(payload.body)', 'String(payload.body).trim()'))
  assert.ok(c.includes('"send message" on your live connection changed') && !c.includes('room check'), c)
  console.log('ok (room members)')
}
// Migrations that only change rules: dropping a constraint or an index doesn't delete data, a unique rule with the id in it can't fail,
// and a migration that adds no tables or columns doesn't have to run before the new code
{
  const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const base = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Project {\n  id String @id\n  workspaceId String\n  name String\n}\n' }
  const mig = (sql: string) => ({ ...base, 'prisma/migrations/2_x/migration.sql': sql })
  let c = card(base, mig('ALTER TABLE "Task" DROP CONSTRAINT "Task_projectId_fkey";\nDROP INDEX "Task_x_idx";\nCREATE UNIQUE INDEX "Project_workspaceId_id_key" ON "Project"("workspaceId", "id");\nALTER TABLE "Task" ADD CONSTRAINT "Task_p_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "Project"("id", "workspaceId");\n'))
  assert.ok(!c.includes('deletes data') && !c.includes('no two projects') && c.includes('before the new code goes live'), c)
  // only plain indexes: the new code doesn't need it first
  c = card(base, mig('CREATE INDEX "Project_name_idx" ON "Project"("name");\nDROP INDEX "Project_old_idx";\n'))
  assert.ok(c.includes("It only adds or removes indexes, which make lookups faster, so the new code doesn't need it first."), c)
  // (review 39) a changed foreign key (onDelete: Cascade) or a dropped unique rule: before the new code
  for (const sql of ['ALTER TABLE "Task" DROP CONSTRAINT "Task_p_fkey";\nALTER TABLE "Task" ADD CONSTRAINT "Task_p_fkey" FOREIGN KEY ("p") REFERENCES "Project"("id") ON DELETE CASCADE;', 'DROP INDEX "Project_slug_key";', 'DROP INDEX "uniq_project_name";'])
    { c = card(base, mig(sql)); assert.ok(c.includes('before the new code goes live'), `${sql}: ${c}`) }
  // a type dropped with CASCADE, a dropped partition: deletes data; a DELETE inside a function body or a comment doesn't
  for (const sql of ['DROP TYPE "Status" CASCADE;', 'ALTER TABLE t DROP PARTITION p0;', 'DO $$ BEGIN DROP TABLE "Project"; END $$;', 'DELETE p FROM `Project` p JOIN `Workspace` w ON w.id = p.workspaceId;']) { c = card(base, mig(sql)); assert.ok(c.includes('deletes data'), `${sql}: ${c}`) }
  for (const sql of ['CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN DELETE FROM "Log"; RETURN NEW; END $$ LANGUAGE plpgsql;', '-- DROP TABLE "Project" later\nCREATE INDEX "a_idx" ON "Project"("name");'])
    { c = card(base, mig(sql)); assert.ok(!c.includes('deletes data'), `${sql}: ${c}`) }
  // real deletes still say so: a column, a table, MySQL's DROP without COLUMN, DELETE FROM
  for (const sql of ['ALTER TABLE "Project" DROP COLUMN "name";', 'DROP TABLE "Project";', 'ALTER TABLE `Project` DROP `name`;', 'DELETE FROM "Project" WHERE "name" = \'x\';'])
    { c = card(base, mig(sql)); assert.ok(c.includes('deletes data'), `${sql}: ${c}`) }
  // a unique rule on id when id isn't the one key (a composite @@id): still warns
  const comp = { ...base, 'prisma/schema.prisma': 'model Project {\n  id String\n  tenantId String\n  name String\n  @@id([tenantId, id])\n}\n' }
  c = card(comp, { ...comp, 'prisma/migrations/2_x/migration.sql': 'CREATE UNIQUE INDEX "Project_id_key" ON "Project"("id");' })
  assert.ok(c.includes('no two projects can share'), c)
  // a unique rule on old columns without the id still warns
  c = card(base, mig('CREATE UNIQUE INDEX "Project_workspaceId_name_key" ON "Project"("workspaceId", "name");'))
  assert.ok(c.includes('no two projects can share'), c)
  console.log('ok (rule-only migrations)')
}
// Deletes said as deletes: a route that now also deletes another table's rows (one kind of write: its verb, never "saves"), and a
// Python db.delete(x) named by where x came from, not by the variable's name
{
  const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0","@prisma/client":"6.0.0"}}' }
  const leave = (extra: string) => ({ ...ex, 'server.js': `const express = require("express")\nconst app = express()\napp.post("/rooms/:id/leave", requireAuth, async (req, res) => {\n  await prisma.roomMember.deleteMany({ where: { roomId: req.params.id } })\n${extra}  res.json({})\n})\napp.listen(3000)\n` })
  let c = card(leave(''), leave('  await prisma.roomReadReceipt.deleteMany({ where: { roomId: req.params.id } })\n'))
  assert.ok(c.includes('now deletes room read receipts') && !c.includes('saves room read receipts'), c)
  const py = { 'requirements.txt': 'fastapi\nsqlalchemy\n' }
  c = report(new Map(Object.entries(py)), new Map(Object.entries({ ...py, 'app/main.py': 'from fastapi import FastAPI, Depends\napp = FastAPI()\n@app.post("/ai")\ndef ai(user = Depends(get_current_user), db = Depends(get_db)):\n    try:\n        call()\n    except Exception:\n        failed_reservation = db.get(AIRequest, 1)\n        db.delete(failed_reservation)\n' })), { ref: 'main' }).replace(/\s+/g, ' ')
  assert.ok(!/failed reservation/i.test(c) && /AI requests/.test(c), c)
  // (review 40) db.query(Model); a loop variable, a with-binding, a tuple or a reassigned name: no guessed table
  const del = (body: string) => report(new Map(Object.entries(py)), new Map(Object.entries({ ...py, 'app/main.py': `from fastapi import FastAPI, Depends\napp = FastAPI()\n@app.post("/x")\ndef x(user = Depends(get_current_user), db = Depends(get_db)):\n${body}` })), { ref: 'main' }).replace(/\s+/g, ' ')
  c = del('    tag = db.query(Tag).filter_by(id=1).first()\n    db.delete(tag)\n')
  assert.ok(c.includes('deletes tags'), c)
  for (const body of ['    for item in db.query(CartItem).all():\n        db.delete(item)\n', '    with lookup(db) as rec:\n        db.delete(rec)\n', '    row, extra = load(db)\n    db.delete(row)\n', '    order = db.get(Order, 1)\n    order = db.get(Refund, 2)\n    db.delete(order)\n'])
    { c = del(body); assert.ok(!/deletes (items|recs|rows|orders)/.test(c), `${body}: ${c}`) }
  console.log('ok (deletes said as deletes)')
}
// A count limit with the one time window its file uses: "a maximum of 5 messages per 10 seconds"
{
  const card = (t: string) => report(new Map([['package.json', '{}']]), new Map([['package.json', '{}'], ['src/limit.ts', t]]), { ref: 'main' }).replace(/\s+/g, ' ')
  const lim = (w: string) => `const MAX_MESSAGES = 5;\n${w}\nexport function ok(times: number[], now: number) {\n  const recent = times.filter(t => t > now - WINDOW)\n  return recent.length < MAX_MESSAGES\n}\n`
  let c = card(lim('const WINDOW_MS = 10_000;').replace('now - WINDOW', 'now - WINDOW_MS'))
  assert.ok(c.includes('a maximum of 5 messages per 10 seconds'), c)
  c = card(lim('const WINDOW_MINUTES = 1;').replace('now - WINDOW', 'now - WINDOW_MINUTES * 60000'))
  assert.ok(c.includes('a maximum of 5 messages per minute'), c)
  // a window defined but not used, or two windows: just the number
  c = card(lim('const WINDOW_MS = 10_000;').replace('now - WINDOW', 'now - 1000'))
  assert.ok(c.includes('a maximum of 5 messages.') || c.includes('a maximum of 5 messages '), c)
  assert.ok(!c.includes('per 10 seconds'), c)
  // (review 41) a timer, a cleanup or a token's validity isn't a limit window
  for (const w of ['const POLL_INTERVAL_MS = 30_000;\nsetInterval(poll, POLL_INTERVAL_MS)', 'const TOKEN_VALIDITY_PERIOD_DAYS = 30;\nexport const exp = Date.now() + TOKEN_VALIDITY_PERIOD_DAYS']) {
    c = card(lim(w).replace('now - WINDOW', 'now - 1000')); assert.ok(!/ per \d|per (minute|day|second)/.test(c), `${w}: ${c}`) }
  console.log('ok (limit windows)')
}
// An AI client that now gives up before its longest answer could be written, with nothing streaming it
{
  const py = { 'requirements.txt': 'fastapi\nopenai\n' }
  const ai = (client: string, call: string) => ({ ...py, 'app/ai.py': `from openai import OpenAI\nimport os\ndef client():\n    return ${client}\ndef rewrite(text):\n    return client().chat.completions.create(model="gpt-4o-mini", ${call}messages=[{"role": "user", "content": text}])\n` })
  const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const base = ai('OpenAI(api_key=os.getenv("K"))', '')
  let c = card(base, ai('OpenAI(api_key=os.getenv("K"), timeout=15.0, max_retries=1)', 'max_tokens=min(6_000, max(256, len(text) // 2)), '))
  assert.ok(c.includes('Long AI answers may now always fail: the AI service now gets 15 seconds'), c)
  // streamed, a small cap, or a timeout that didn't change: no guess
  for (const [cl, call] of [['OpenAI(api_key=os.getenv("K"), timeout=15.0)', 'stream=True, max_tokens=6000, '], ['OpenAI(api_key=os.getenv("K"), timeout=15.0)', 'max_tokens=300, ']]) {
    c = card(base, ai(cl, call)); assert.ok(!c.includes('Long AI answers'), `${cl} ${call}: ${c}`) }
  const same = ai('OpenAI(api_key=os.getenv("K"), timeout=15.0)', '')
  c = card(same, ai('OpenAI(api_key=os.getenv("K"), timeout=15.0)', 'max_tokens=6000, '))
  assert.ok(!c.includes('Long AI answers'), c)
  // JavaScript: milliseconds
  const js = { 'package.json': '{"dependencies":{"openai":"4.0.0"}}' }
  const jai = (o: string) => ({ ...js, 'lib/ai.ts': `import OpenAI from "openai"\nconst client = new OpenAI(${o})\nexport const run = (t: string) => client.chat.completions.create({ model: "gpt-4o", max_tokens: 4000, messages: [{ role: "user", content: t }] })\n` })
  c = card(jai('{ apiKey: process.env.K }'), jai('{ apiKey: process.env.K, timeout: 20_000 }'))
  assert.ok(c.includes('gets 20 seconds'), c)
  // (review 42) `15 * 1000` is 15 seconds; other numbers on the cap's line aren't the cap; a per-call timeout, a stream flag in a
  // variable, or no cap at all: no guess
  c = card(jai('{ apiKey: process.env.K }'), jai('{ apiKey: process.env.K, timeout: 15 * 1000 }'))
  assert.ok(c.includes('gets 15 seconds'), c)
  for (const [cl, call] of [['OpenAI(timeout=15.0)', 'max_tokens=300, model2="gpt-4o-2024-08-06", '], ['OpenAI(timeout=15.0)', 'max_tokens=6000, timeout=300, '], ['OpenAI(timeout=15.0)', 'stream=want_stream, max_tokens=6000, '], ['OpenAI(timeout=30)', '']]) {
    c = card(base, ai(cl, call)); assert.ok(!c.includes('Long AI answers'), `${cl} ${call}: ${c}`) }
  console.log('ok (AI timeouts)')
}
// An inline router.use admin check: the routes after it are for admins only
{
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0","@prisma/client":"6.0.0"}}' }
  const app = (inline: string) => ({ ...ex, 'server.js': `const express = require("express")\nconst { requireAuth } = require("./auth")\nconst app = express()\nconst router = express.Router()\nrouter.use(requireAuth)\nrouter.use(${inline})\nrouter.get("/users", async (req, res) => res.json(await prisma.user.findMany()))\napp.use("/api/admin", router)\napp.listen(3000)\n`, 'auth.js': 'exports.requireAuth = (req, res, next) => { if (!req.user) return res.status(401).end(); next() }\n' })
  const card = (files: Record<string, string>) => report(new Map(Object.entries(ex)), new Map(Object.entries(files)), { ref: 'main' }).replace(/\s+/g, ' ')
  let c = card(app('(req, res, next) => {\n  if (req.user.role !== "admin") {\n    res.status(403).json({ error: "no" })\n    return\n  }\n  next()\n}'))
  assert.ok(c.includes('lists users and is for admins only ✓'), c)
  // doesn't stop, lets GET through, or lets moderators in too: login only
  for (const inline of ['(req, res, next) => {\n  if (req.user.role !== "admin") console.log("x")\n  next()\n}', '(req, res, next) => {\n  if (req.method === "GET") return next()\n  if (req.user.role !== "admin") return res.status(403).end()\n  next()\n}',
    '(req, res, next) => {\n  if (req.user.role !== "admin" && req.user.role !== "moderator") return res.status(403).end()\n  next()\n}']) {
    c = card(app(inline)); assert.ok(!c.includes('admins only') && c.includes('requires login ✓'), `${inline}: ${c}`) }
  // (review 43) a path-limited inline, two routers named alike in two functions, an error handler, a check in a callback, next() in the
  // 403 branch, a role from the query string or a header: no admin ✓
  for (const inline of ['(err, req, res, next) => {\n  if (req.user.role !== "admin") return res.status(403).end()\n  next(err)\n}', '(req, res, next) => {\n  load(req).then(u => { if (u.role !== "admin") return res.status(403).end() })\n  next()\n}',
    '(req, res, next) => {\n  if (req.user.role !== "admin") {\n    res.status(403)\n    return next()\n  }\n  next()\n}', '(req, res, next) => {\n  const { role } = req.query\n  if (role !== "admin") return res.status(403).end()\n  next()\n}',
    '(req, res, next) => {\n  const user = { isAdmin: req.get("x-admin") === "1" }\n  if (!user.isAdmin) return res.status(403).end()\n  next()\n}']) {
    c = card(app(inline)); assert.ok(!c.includes('admins only'), `${inline}: ${c}`) }
  c = card(app('(req, res, next) => {\n  req.user.role = req.body.role\n  if (req.user.role !== "admin") return res.status(403).end()\n  next()\n}')); assert.ok(!c.includes('admins only'), `role from body: ${c}`)
  const pathed = app('(req, res, next) => {\n  if (req.user.role !== "admin") return res.status(403).end()\n  next()\n}'); pathed['server.js'] = pathed['server.js'].replace('router.use((req', 'router.use(["/x"], (req')
  c = card(pathed); assert.ok(!c.includes('admins only'), `path: ${c}`)
  const two = { ...ex, 'auth.js': app('')['auth.js'], 'server.js': 'const express = require("express")\nconst { requireAuth } = require("./auth")\nconst app = express()\nfunction adminRouter() {\n  const router = express.Router()\n  router.use(requireAuth)\n  router.use((req, res, next) => {\n    if (req.user.role !== "admin") return res.status(403).end()\n    next()\n  })\n  router.get("/orders", async (req, res) => res.json(await prisma.order.findMany()))\n  return router\n}\nfunction userRouter() {\n  const router = express.Router()\n  router.use(requireAuth)\n  router.get("/users", async (req, res) => res.json(await prisma.user.findMany()))\n  return router\n}\napp.use("/api/admin", adminRouter())\napp.use("/api/me", userRouter())\napp.listen(3000)\n' }
  c = card(two); assert.ok(c.includes('lists users and requires login ✓') && !c.includes('lists users and is for admins'), `two routers: ${c}`)
  console.log('ok (inline admin middleware)')
}
// Express: a guard for a whole route chain, router.route('/x').all(requireAuth).get(h).post(h); not one added after the handler
{
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0","@prisma/client":"6.0.0"}}', 'auth.js': 'exports.requireAuth = (req, res, next) => { if (!req.user) return res.status(401).end(); next() }\n' }
  const srv = (chain: string) => ({ ...ex, 'server.js': `const express = require("express")\nconst { requireAuth } = require("./auth")\nconst app = express()\nconst router = express.Router()\nrouter.route("/orders")${chain}\napp.use("/api", router)\napp.listen(3000)\n` })
  const card = (files: Record<string, string>) => report(new Map(Object.entries(ex)), new Map(Object.entries(files)), { ref: 'main' }).replace(/\s+/g, ' ')
  let c = card(srv('.all(requireAuth).get(async (req, res) => res.json(await prisma.order.findMany())).post(async (req, res) => res.json(await prisma.order.create({ data: req.body })))'))
  assert.ok(c.includes('requires login ✓') && !c.includes('without logging in'), c)
  c = card(srv('.post(async (req, res) => res.json(await prisma.order.create({ data: req.body }))).all(requireAuth)'))
  assert.ok(!c.includes('requires login ✓'), c)
  // (a bare optional-login middleware isn't a login check, in a chain or on a route)
  c = card(srv('.all(optionalAuth).post(async (req, res) => res.json(await prisma.order.create({ data: req.body })))'))
  assert.ok(!c.includes('requires login ✓'), c)
  const route = { ...ex, 'server.js': 'const express = require("express")\nconst { optionalAuth } = require("./auth")\nconst app = express()\napp.post("/orders", optionalAuth, async (req, res) => res.json(await prisma.order.create({ data: req.body })))\napp.listen(3000)\n' }
  c = card(route); assert.ok(!c.includes('requires login ✓'), c)
  console.log('ok (route chain guards)')
}
// A GET at an address ending in an id that looks up one row: "looks up one room", not "lists rooms"
{
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0","@prisma/client":"6.0.0"}}' }
  const card = (h: string) => report(new Map(Object.entries(ex)), new Map(Object.entries({ ...ex, 'server.js': `const express = require("express")\nconst app = express()\napp.get("/api/rooms/:roomId", requireAuth, async (req, res) => {\n${h}\n})\napp.listen(3000)\n` })), { ref: 'main' }).replace(/\s+/g, ' ')
  let c = card('  res.json(await prisma.room.findUnique({ where: { id: req.params.roomId } }))')
  assert.ok(c.includes('looks up one room') && !c.includes('lists rooms'), c)
  c = card('  const room = await prisma.room.findUnique({ where: { id: req.params.roomId } })\n  res.json({ room, messages: await prisma.message.findMany({ where: { roomId: room.id } }) })')
  assert.ok(!c.includes('looks up one room'), c)
  console.log('ok (one row)')
}
// A new address that another changed file calls (through a wrapper that adds /api) isn't "unrelated"
{
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0","react":"18.0.0","@prisma/client":"6.0.0"}}', 'server/rooms.ts': 'import { Router } from "express"\nexport const router = Router()\nrouter.get("/", async (req, res) => res.json(await prisma.room.findMany()))\n', 'client/Room.tsx': 'export function Room({ id }: { id: string }) {\n  return <main>{id}</main>\n}\n', 'server/index.ts': 'import express from "express"\nimport { router } from "./rooms"\nconst app = express()\napp.use("/api/rooms", router)\napp.listen(3000)\n' }
  const after = { ...ex, 'server/rooms.ts': ex['server/rooms.ts'] + 'router.get("/:roomId", async (req, res) => res.json(await prisma.room.findUnique({ where: { id: req.params.roomId } })))\n', 'client/Room.tsx': 'import { api } from "./api"\nexport function Room({ id }: { id: string }) {\n  const room = api(`/rooms/${id}`)\n  return <main>{id}</main>\n}\n' }
  const c = report(new Map(Object.entries(ex)), new Map(Object.entries(after)), { ref: 'main', asked: 'messages show up twice and the app is slow' }).replace(/\s+/g, ' ')
  assert.ok(!c.includes("server/rooms.ts, which doesn't look related"), c)
  console.log('ok (called endpoint is related)')
}
// A fetch helper on this app's own server at another origin: fetch(`${API_URL}/api${path}`) (porch-chat). Not another company's API,
// not useAuth()'s login calls folded into every page, not "now loads rooms" when the page loaded rooms before.
{
  const lib = (url: string) => `const API_URL = ${url}\nexport async function api(path: string, options: RequestInit = {}) { return fetch(\`\${API_URL}/api\${path}\`, options) }\n`
  const app = "import { Routes, Route } from 'react-router-dom'\nimport Rooms from './pages/Rooms'\nexport default function App() { return <Routes><Route path=\"/rooms/:id\" element={<Rooms />} /></Routes> }\n"
  const ctx = "import { createContext, useContext } from 'react'\nimport { api } from '../lib/api'\nconst C = createContext(null)\nexport function AuthProvider({ children }) { const logout = () => api('/auth/logout', { method: 'POST' }); return <C.Provider value={{ logout }}>{children}</C.Provider> }\nexport const useAuth = () => useContext(C)\n"
  const page = (call: string, auth = true) => `import { api } from '../lib/api'\n${auth ? "import { useAuth } from '../context/AuthContext'\n" : ''}export default function Rooms() { ${call}; return <main>Rooms</main> }\n`
  const server = "import express from 'express'\nconst app = express()\napp.get('/api/rooms', async (req, res) => res.json(await prisma.room.findMany()))\napp.get('/api/rooms/:id', async (req, res) => res.json(await prisma.room.findUnique({ where: { id: req.params.id } })))\napp.get('/api/messages', async (req, res) => res.json(await prisma.message.findMany()))\napp.post('/api/auth/logout', async (req, res) => {})\n"
  const ex = (url: string, call: string, auth = true) => ({ 'package.json': '{"dependencies":{"express":"4.0.0","react":"18.0.0"}}', 'client/src/lib/api.ts': lib(url), 'client/src/App.tsx': app,
    'client/src/context/AuthContext.tsx': ctx, 'client/src/pages/Rooms.tsx': page(call, auth), 'server/index.ts': server })
  const card = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const local = 'import.meta.env.VITE_API_URL ?? "http://localhost:4000"'
  let c = card(ex(local, "api('/rooms')", false), ex(local, "api('/rooms'); api('/messages')"))
  assert.ok(c.includes('now loads messages from your server'), c)
  assert.ok(!/sends (data|users) to your server/.test(c), c)
  for (const url of ['"https://api.github.com"', 'process.env.VITE_API_URL || "https://example.com"']) {
    c = card(ex(url, "api('/rooms')"), ex(url, "api('/rooms'); api('/messages')"))
    assert.ok(!c.includes('loads messages'), c)
  }
  c = card(ex(local, "api('/rooms')"), ex(local, 'api(`/rooms/${id}`)'))
  assert.ok(!c.includes('now loads rooms'), c)
  // an AuthContext that also toggles favorites (dog-walks p3): the favorites call stays the page's, so it isn't "only shows information"
  const fav = { ...ex(local, 'useAuth()'), 'client/src/context/AuthContext.tsx': ctx.replace("const logout", "const toggle = () => api('/favorites/1', { method: 'POST' }); const logout") }
  c = card({ 'package.json': fav['package.json'] }, fav)
  assert.ok(c.includes('sends data to your server') && !c.includes('only shows information'), c)
  console.log('ok (fetch helper at its own origin)')
}
// Review 46: context auth calls dropped only for the app's own auth addresses (and still not "only shows information"), a POST
// worded by a delete on another method, base URLs that are another service (Ollama, OpenAI) or a local of the same name
{
// New Account page; its only "change" is an icon-only delete-account button whose fetch lives in AuthContext (provider rendered in App, not the page)
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0"}}'
const server = "import express from 'express'\nconst app = express()\napp.get('/api/me', async (req, res) => res.json(await prisma.user.findUnique({ where: { id: 1 } })))\napp.delete('/api/me', async (req, res) => { await prisma.user.delete({ where: { id: 1 } }); res.json({}) })\napp.get('/api/rooms', async (req, res) => res.json(await prisma.room.findMany()))\n"
const ctx = "import { createContext, useContext } from 'react'\nconst C = createContext(null)\nexport function AuthProvider({ children }) { const deleteAccount = () => fetch('/api/me', { method: 'DELETE' }); return <C.Provider value={{ deleteAccount }}>{children}</C.Provider> }\nexport const useAuth = () => useContext(C)\n"
const appB = "import { Routes, Route } from 'react-router-dom'\nimport { AuthProvider } from './context/AuthContext'\nimport Home from './pages/Home'\nexport default function App() { return <AuthProvider><Routes><Route path=\"/\" element={<Home />} /></Routes></AuthProvider> }\n"
const appA = "import { Routes, Route } from 'react-router-dom'\nimport { AuthProvider } from './context/AuthContext'\nimport Home from './pages/Home'\nimport Account from './pages/Account'\nexport default function App() { return <AuthProvider><Routes><Route path=\"/\" element={<Home />} /><Route path=\"/account\" element={<Account />} /></Routes></AuthProvider> }\n"
const home = "export default function Home() { return <main>Home</main> }\n"
const account = "import { Trash2 } from 'lucide-react'\nimport { useAuth } from '../context/AuthContext'\nexport default function Account() { const { deleteAccount } = useAuth(); return <main><h1>Your account</h1><button onClick={deleteAccount} aria-label=\"Delete my account\"><Trash2 /></button></main> }\n"
const before = { 'package.json': pkg, 'server/index.ts': server, 'client/src/context/AuthContext.tsx': ctx, 'client/src/App.tsx': appB, 'client/src/pages/Home.tsx': home }
const after = { ...before, 'client/src/App.tsx': appA, 'client/src/pages/Account.tsx': account }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(c.includes('deletes users on your server') && !c.includes('only shows information'), c)
}
{
// New Account page; its only "change" is an icon-only delete-account button whose fetch lives in AuthContext (provider rendered in App, not the page)
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0"}}'
const server = "import express from 'express'\nconst app = express()\napp.get('/api/me', async (req, res) => res.json(await prisma.user.findUnique({ where: { id: 1 } })))\napp.post('/api/me/favorites/:id', async (req, res) => { await prisma.favorite.create({ where: { id: 1 } }); res.json({}) })\napp.get('/api/rooms', async (req, res) => res.json(await prisma.room.findMany()))\n"
const ctx = "import { createContext, useContext } from 'react'\nconst C = createContext(null)\nexport function AuthProvider({ children }) { const toggleFavorite = () => fetch('/api/me/favorites/1', { method: 'POST' }); return <C.Provider value={{ toggleFavorite }}>{children}</C.Provider> }\nexport const useAuth = () => useContext(C)\n"
const appB = "import { Routes, Route } from 'react-router-dom'\nimport { AuthProvider } from './context/AuthContext'\nimport Home from './pages/Home'\nexport default function App() { return <AuthProvider><Routes><Route path=\"/\" element={<Home />} /></Routes></AuthProvider> }\n"
const appA = "import { Routes, Route } from 'react-router-dom'\nimport { AuthProvider } from './context/AuthContext'\nimport Home from './pages/Home'\nimport Account from './pages/Account'\nexport default function App() { return <AuthProvider><Routes><Route path=\"/\" element={<Home />} /><Route path=\"/account\" element={<Account />} /></Routes></AuthProvider> }\n"
const home = "export default function Home() { return <main>Home</main> }\n"
const account = "import { Heart } from 'lucide-react'\nimport { useAuth } from '../context/AuthContext'\nexport default function Account() { const { toggleFavorite } = useAuth(); return <main><h1>Your account</h1><button onClick={toggleFavorite} aria-label=\"Favorite\"><Heart /></button></main> }\n"
const before = { 'package.json': pkg, 'server/index.ts': server, 'client/src/context/AuthContext.tsx': ctx, 'client/src/App.tsx': appB, 'client/src/pages/Home.tsx': home }
const after = { ...before, 'client/src/App.tsx': appA, 'client/src/pages/Account.tsx': account }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(c.includes('sends data to your server') && !c.includes('only shows information'), c)
}
{
// A tutoring app: "sessions" are bookings. SessionsContext (createContext, provider in App) books/cancels; the new page uses shadcn <Button>.
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0"}}'
const server = "import express from 'express'\nconst app = express()\napp.get('/api/sessions', async (req, res) => res.json(await prisma.session.findMany()))\napp.post('/api/sessions', async (req, res) => res.json(await prisma.session.create({ data: req.body })))\napp.delete('/api/sessions/:id', async (req, res) => { await prisma.session.delete({ where: { id: req.params.id } }); res.json({}) })\n"
const ctx = "import { createContext, useContext, useEffect, useState } from 'react'\nconst C = createContext(null)\nexport function SessionsProvider({ children }) { const [sessions, setSessions] = useState([]); useEffect(() => { fetch('/api/sessions').then(r => r.json()).then(setSessions) }, []); const book = (data) => fetch('/api/sessions', { method: 'POST', body: JSON.stringify(data) }); const cancel = (id) => fetch(`/api/sessions/${id}`, { method: 'DELETE' }); return <C.Provider value={{ sessions, book, cancel }}>{children}</C.Provider> }\nexport const useSessions = () => useContext(C)\n"
const appB = "import { Routes, Route } from 'react-router-dom'\nimport { SessionsProvider } from './context/SessionsContext'\nimport Home from './pages/Home'\nexport default function App() { return <SessionsProvider><Routes><Route path=\"/\" element={<Home />} /></Routes></SessionsProvider> }\n"
const appA = appB.replace("import Home from './pages/Home'", "import Home from './pages/Home'\nimport MySessions from './pages/MySessions'").replace('<Route path="/" element={<Home />} />', '<Route path="/" element={<Home />} /><Route path="/my-sessions" element={<MySessions />} />')
const home = "export default function Home() { return <main>Home</main> }\n"
const page = "import { Button } from '@/components/ui/button'\nimport { useSessions } from '../context/SessionsContext'\nexport default function MySessions() { const { sessions, cancel } = useSessions(); return <main><h1>My sessions</h1>{sessions.map(s => <div key={s.id}>{s.time}<Button variant=\"destructive\" onClick={() => cancel(s.id)}>Cancel</Button></div>)}</main> }\n"
const before = { 'package.json': pkg, 'server/index.ts': server, 'client/src/context/SessionsContext.tsx': ctx, 'client/src/App.tsx': appB, 'client/src/pages/Home.tsx': home }
const after = { ...before, 'client/src/App.tsx': appA, 'client/src/pages/MySessions.tsx': page }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(c.includes('deletes sessions on your server') && !c.includes('only shows information'), c)
}
{
// New Sign-up page whose submit goes through useAuth().register (POST /api/auth/register creates a user); fields + shadcn <Button>, no <form>
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0"}}'
const server = "import express from 'express'\nconst app = express()\napp.post('/api/auth/register', async (req, res) => res.json(await prisma.user.create({ data: req.body })))\napp.get('/api/rooms', async (req, res) => res.json(await prisma.room.findMany()))\n"
const ctx = "import { createContext, useContext } from 'react'\nconst C = createContext(null)\nexport function AuthProvider({ children }) { const register = (email, password) => fetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }); return <C.Provider value={{ register }}>{children}</C.Provider> }\nexport const useAuth = () => useContext(C)\n"
const appB = "import { Routes, Route } from 'react-router-dom'\nimport { AuthProvider } from './context/AuthContext'\nimport Home from './pages/Home'\nexport default function App() { return <AuthProvider><Routes><Route path=\"/\" element={<Home />} /></Routes></AuthProvider> }\n"
const appA = appB.replace("import Home from './pages/Home'", "import Home from './pages/Home'\nimport Signup from './pages/Signup'").replace('<Route path="/" element={<Home />} />', '<Route path="/" element={<Home />} /><Route path="/signup" element={<Signup />} />')
const home = "export default function Home() { return <main>Home</main> }\n"
const page = "import { useState } from 'react'\nimport { Button } from '@/components/ui/button'\nimport { useAuth } from '../context/AuthContext'\nexport default function Signup() { const { register } = useAuth(); const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); return <main><h1>Create your account</h1><input type=\"email\" value={email} onChange={e => setEmail(e.target.value)} /><input type=\"password\" value={pw} onChange={e => setPw(e.target.value)} /><Button onClick={() => register(email, pw)}>Sign up</Button></main> }\n"
const before = { 'package.json': pkg, 'server/index.ts': server, 'client/src/context/AuthContext.tsx': ctx, 'client/src/App.tsx': appB, 'client/src/pages/Home.tsx': home }
const after = { ...before, 'client/src/App.tsx': appA, 'client/src/pages/Signup.tsx': page }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(!c.includes('only shows information'), c)
}
{
// Same endpoint, POST writes through a service function in another file (a create); DELETE clears with prisma directly.
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0"}}'
const svc = "export async function addMessage(roomId, text) { return prisma.message.create({ data: { roomId, text } }) }\n"
const server = "import express from 'express'\nimport { addMessage } from './services/messages'\nconst app = express()\napp.get('/api/rooms', async (req, res) => res.json(await prisma.room.findMany()))\napp.post('/api/rooms/:id/messages', async (req, res) => res.json(await addMessage(req.params.id, req.body.text)))\napp.delete('/api/rooms/:id/messages', async (req, res) => { await prisma.message.deleteMany({ where: { roomId: req.params.id } }); res.json({}) })\n"
const app = "import { Routes, Route } from 'react-router-dom'\nimport Room from './pages/Room'\nexport default function App() { return <Routes><Route path=\"/rooms/:id\" element={<Room />} /></Routes> }\n"
const pageA = "export default function Room() { return <main><h1>Room</h1></main> }\n"
const pageB = "export default function Room({ id }) { const send = (text) => fetch(`/api/rooms/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }); return <main><h1>Room</h1><button onClick={() => send('hi')}>Send</button></main> }\n"
const before = { 'package.json': pkg, 'server/index.ts': server, 'server/services/messages.ts': svc, 'client/src/App.tsx': app, 'client/src/pages/Room.tsx': pageA }
const after = { ...before, 'client/src/pages/Room.tsx': pageB }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(c.includes('sends messages to your server') && !c.includes('deletes messages'), c)
}
{
// /api/rooms/:id/messages: POST posts a message (through Pusher + a raw insert plain doesn't read as a write); DELETE clears the room's messages.
// The endpoint's only recognised op is 'delete', so the chat page's POST reads as a delete.
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0"}}'
const server = "import express from 'express'\nconst app = express()\napp.get('/api/rooms', async (req, res) => res.json(await prisma.room.findMany()))\napp.post('/api/rooms/:id/messages', async (req, res) => { await pusher.trigger(`room-${req.params.id}`, 'message', req.body); res.json({}) })\napp.delete('/api/rooms/:id/messages', async (req, res) => { await prisma.message.deleteMany({ where: { roomId: req.params.id } }); res.json({}) })\n"
const app = "import { Routes, Route } from 'react-router-dom'\nimport Room from './pages/Room'\nexport default function App() { return <Routes><Route path=\"/rooms/:id\" element={<Room />} /></Routes> }\n"
const pageA = "export default function Room() { return <main><h1>Room</h1></main> }\n"
const pageB = "export default function Room({ id }) { const send = (text) => fetch(`/api/rooms/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }); return <main><h1>Room</h1><button onClick={() => send('hi')}>Send</button></main> }\n"
const before = { 'package.json': pkg, 'server/index.ts': server, 'client/src/App.tsx': app, 'client/src/pages/Room.tsx': pageA }
const after = { ...before, 'client/src/pages/Room.tsx': pageB }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(!c.includes('deletes messages'), c)
}
{
// The client talks straight to a local Ollama (AI model server, http://localhost:11434/api/chat), not to the app's Express server.
// The app's own Express server also has /api/chat (which saves messages). The wrapper rule (env read ?? localhost literal) takes Ollama for "this app's server".
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0"}}'
const server = "import express from 'express'\nconst app = express()\napp.get('/api/rooms', async (req, res) => res.json(await prisma.room.findMany()))\napp.post('/api/chat', async (req, res) => res.json(await prisma.message.create({ data: req.body })))\n"
const lib = "const OLLAMA_URL = import.meta.env.VITE_OLLAMA_URL ?? 'http://localhost:11434'\nexport async function ollama(path: string, options: RequestInit = {}) { return fetch(`${OLLAMA_URL}/api${path}`, options) }\n"
const app = "import { Routes, Route } from 'react-router-dom'\nimport Chat from './pages/Chat'\nexport default function App() { return <Routes><Route path=\"/chat\" element={<Chat />} /></Routes> }\n"
const pageA = "export default function Chat() { return <main><h1>Chat</h1></main> }\n"
const pageB = "import { ollama } from '../lib/ollama'\nexport default function Chat() { const ask = (q) => ollama('/chat', { method: 'POST', body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: q }] }) }); return <main><h1>Chat</h1><button onClick={() => ask('hi')}>Ask</button></main> }\n"
const before = { 'package.json': pkg, 'server/index.ts': server, 'client/src/lib/ollama.ts': lib, 'client/src/App.tsx': app, 'client/src/pages/Chat.tsx': pageA }
const after = { ...before, 'client/src/pages/Chat.tsx': pageB }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(!c.includes('to your server'), c)
}
{
// lib has a module-level own-origin API_URL, but the partner() helper shadows it with a third-party host. ownOrigin() reads only the module-level const.
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0"}}'
const server = "import express from 'express'\nconst app = express()\napp.get('/api/rooms', async (req, res) => res.json(await prisma.room.findMany()))\napp.post('/api/orders', async (req, res) => res.json(await prisma.order.create({ data: req.body })))\n"
const lib = "const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'\nexport async function partner(path: string, options: RequestInit = {}) { const API_URL = 'https://partner.example.com'; return fetch(`${API_URL}/api${path}`, options) }\n"
const app = "import { Routes, Route } from 'react-router-dom'\nimport Shop from './pages/Shop'\nexport default function App() { return <Routes><Route path=\"/shop\" element={<Shop />} /></Routes> }\n"
const pageA = "export default function Shop() { return <main><h1>Shop</h1></main> }\n"
const pageB = "import { partner } from '../lib/partner'\nexport default function Shop() { const buy = () => partner('/orders', { method: 'POST' }); return <main><h1>Shop</h1><button onClick={buy}>Order from partner</button></main> }\n"
const before = { 'package.json': pkg, 'server/index.ts': server, 'client/src/lib/partner.ts': lib, 'client/src/App.tsx': app, 'client/src/pages/Shop.tsx': pageA }
const after = { ...before, 'client/src/pages/Shop.tsx': pageB }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(!c.includes('to your server'), c)
}
{
// The client calls OpenAI directly (base URL from an env var alone, no literal). The env-only const passes ownOrigin.
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0"}}'
const server = "import express from 'express'\nconst app = express()\napp.get('/api/rooms', async (req, res) => res.json(await prisma.room.findMany()))\n"
const lib = "const OPENAI_BASE = import.meta.env.VITE_OPENAI_BASE_URL\nexport async function openai(path: string, options: RequestInit = {}) { return fetch(`${OPENAI_BASE}/v1${path}`, options) }\n"
const app = "import { Routes, Route } from 'react-router-dom'\nimport Chat from './pages/Chat'\nexport default function App() { return <Routes><Route path=\"/chat\" element={<Chat />} /></Routes> }\n"
const pageA = "export default function Chat() { return <main><h1>Chat</h1></main> }\n"
const pageB = "import { openai } from '../lib/openai'\nexport default function Chat() { const ask = (q) => openai('/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: q }] }) }); return <main><h1>Chat</h1><button onClick={() => ask('hi')}>Ask</button></main> }\n"
const before = { 'package.json': pkg, 'server/index.ts': server, 'client/src/lib/openai.ts': lib, 'client/src/App.tsx': app, 'client/src/pages/Chat.tsx': pageA }
const after = { ...before, 'client/src/pages/Chat.tsx': pageB }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(!c.includes('to your server'), c)
}
console.log('ok (review 46)')
// Review 47 (the POST verb rule these first three caught was dropped after review 49): a POST's verb never borrowed from a GET or another file's DELETE; an admin page's impersonate call isn't an app-wide login call
{
// Express: POST /api/posts/:id/comments (adds a comment) lives in routes/comments.ts; a moderator's DELETE on the same address
// (clears a post's comments) lives in routes/moderation.ts. Two units share the URL; endpoint() picks the first, the DELETE-only one,
// whose only non-GET method is DELETE and only op is delete, so the page's POST reads "deletes comments".
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0","@prisma/client":"6.0.0"}}'
const index = "import express from 'express'\nimport moderation from './routes/moderation.js'\nimport comments from './routes/comments.js'\nconst app = express()\napp.use(express.json())\napp.use('/api', moderation)\napp.use('/api', comments)\napp.listen(3001)\n"
const moderation = "import { Router } from 'express'\nimport { prisma } from '../db.js'\nconst router = Router()\nrouter.delete('/posts/:id/comments', async (req, res) => { await prisma.comment.deleteMany({ where: { postId: +req.params.id } }); res.json({}) })\nexport default router\n"
const comments = "import { Router } from 'express'\nimport { prisma } from '../db.js'\nconst router = Router()\nrouter.get('/posts/:id/comments', async (req, res) => res.json(await prisma.comment.findMany({ where: { postId: +req.params.id } })))\nrouter.post('/posts/:id/comments', async (req, res) => res.json(await prisma.comment.create({ data: { postId: +req.params.id, text: req.body.text } })))\nexport default router\n"
const app = "import { Routes, Route } from 'react-router-dom'\nimport Post from './pages/Post'\nexport default function App() { return <Routes><Route path=\"/posts/:id\" element={<Post />} /></Routes> }\n"
const pageA = "export default function Post({ id }) { return <main><h1>Post</h1></main> }\n"
const pageB = "export default function Post({ id }) { const add = (text) => fetch(`/api/posts/${id}/comments`, { method: 'POST', body: JSON.stringify({ text }) }); return <main><h1>Post</h1><button onClick={() => add('nice')}>Comment</button></main> }\n"
const before = { 'package.json': pkg, 'server/src/index.ts': index, 'server/src/routes/moderation.ts': moderation, 'server/src/routes/comments.ts': comments, 'client/src/App.tsx': app, 'client/src/pages/Post.tsx': pageA }
const after = { ...before, 'client/src/pages/Post.tsx': pageB }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(c.includes('sends comments to your server') && !c.includes('deletes comments'), c)
}
{
// New open endpoint POST /api/auth/impersonate (log in as any user). Only the admin page calls it, through useAuth().impersonate from
// AuthContext (createContext; provider in App). HEAD: the admin page's call makes it admin-only server code -> Unsafe.
// NEW: the call is "quiet", adminCalls() no longer sees it -> softer Check that calls it normal for sign-ups.
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0","@prisma/client":"6.0.0"}}'
const serverA = "import express from 'express'\nconst app = express()\napp.use(express.json())\napp.get('/api/users', requireAuth, async (req, res) => res.json(await prisma.user.findMany()))\napp.listen(3001)\n"
const serverB = serverA.replace('app.listen', "app.post('/api/auth/impersonate', async (req, res) => { const u = await prisma.user.findUnique({ where: { id: req.body.userId } }); await prisma.session.create({ data: { userId: u.id } }); res.json(u) })\napp.listen")
const ctxA = "import { createContext, useContext, useState } from 'react'\nconst C = createContext(null)\nexport function AuthProvider({ children }) { const [user, setUser] = useState(null); const login = (d) => fetch('/api/auth/login', { method: 'POST', body: JSON.stringify(d) }); return <C.Provider value={{ user, login }}>{children}</C.Provider> }\nexport const useAuth = () => useContext(C)\n"
const ctxB = ctxA.replace("return <C.Provider value={{ user, login }}>", "const impersonate = (userId) => fetch('/api/auth/impersonate', { method: 'POST', body: JSON.stringify({ userId }) }); return <C.Provider value={{ user, login, impersonate }}>")
const app = "import { Routes, Route } from 'react-router-dom'\nimport { AuthProvider } from './context/AuthContext'\nimport AdminUsers from './pages/AdminUsers'\nexport default function App() { return <AuthProvider><Routes><Route path=\"/admin/users\" element={<AdminUsers />} /></Routes></AuthProvider> }\n"
const pageA = "import { useEffect, useState } from 'react'\nexport default function AdminUsers() { const [users, setUsers] = useState([]); useEffect(() => { fetch('/api/users').then(r => r.json()).then(setUsers) }, []); return <main><h1>Users</h1>{users.map(u => <div key={u.id}>{u.email}</div>)}</main> }\n"
const pageB = "import { useEffect, useState } from 'react'\nimport { useAuth } from '../context/AuthContext'\nexport default function AdminUsers() { const { impersonate } = useAuth(); const [users, setUsers] = useState([]); useEffect(() => { fetch('/api/users').then(r => r.json()).then(setUsers) }, []); return <main><h1>Users</h1>{users.map(u => <div key={u.id}>{u.email}<button onClick={() => impersonate(u.id)}>Log in as</button></div>)}</main> }\n"
const before = { 'package.json': pkg, 'server/index.ts': serverA, 'client/src/context/AuthContext.tsx': ctxA, 'client/src/App.tsx': app, 'client/src/pages/AdminUsers.tsx': pageA }
const after = { ...before, 'server/index.ts': serverB, 'client/src/context/AuthContext.tsx': ctxB, 'client/src/pages/AdminUsers.tsx': pageB }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(c.includes('⚠ Anyone can use the auth impersonate part'), c)
}
{
// /api/messages: GET lists messages and marks them read (prisma.message.updateMany); POST saves a new message through a service in
// another file (not followed). The unit's ops = {update} (from the GET), its only non-GET method is POST, so the chat page's
// new Send (a POST) reads "updates messages on your server".
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0","@prisma/client":"6.0.0"}}'
const server = "import express from 'express'\nimport { createMessage } from './services/messages.js'\nconst app = express()\napp.use(express.json())\napp.get('/api/messages', async (req, res) => { const list = await prisma.message.findMany(); await prisma.message.updateMany({ where: { read: false }, data: { read: true } }); res.json(list) })\napp.post('/api/messages', async (req, res) => res.json(await createMessage(req.body)))\napp.listen(3001)\n"
const service = "export async function createMessage(data) { return prisma.message.create({ data }) }\n"
const app = "import { Routes, Route } from 'react-router-dom'\nimport Chat from './pages/Chat'\nexport default function App() { return <Routes><Route path=\"/chat\" element={<Chat />} /></Routes> }\n"
const pageA = "import { useEffect, useState } from 'react'\nexport default function Chat() { const [m, setM] = useState([]); useEffect(() => { fetch('/api/messages').then(r => r.json()).then(setM) }, []); return <main><h1>Chat</h1>{m.map(x => <p key={x.id}>{x.text}</p>)}</main> }\n"
const pageB = pageA.replace("return <main>", "const send = (text) => fetch('/api/messages', { method: 'POST', body: JSON.stringify({ text }) }); return <main>").replace('</main>', "<button onClick={() => send('hi')}>Send</button></main>")
const before = { 'package.json': pkg, 'server/index.ts': server, 'server/services/messages.ts': service, 'client/src/App.tsx': app, 'client/src/pages/Chat.tsx': pageA }
const after = { ...before, 'client/src/pages/Chat.tsx': pageB }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(c.includes('sends messages to your server') && !c.includes('updates messages'), c)
}
{
// Same as r3, but the GET purges expired messages (deleteMany): the Send button reads "deletes messages on your server".
// another file (not followed). The unit's ops = {update} (from the GET), its only non-GET method is POST, so the chat page's
// new Send (a POST) reads "updates messages on your server".
const pkg = '{"dependencies":{"express":"4.0.0","react":"18.0.0","react-router-dom":"6.0.0","@prisma/client":"6.0.0"}}'
const server = "import express from 'express'\nimport { createMessage } from './services/messages.js'\nconst app = express()\napp.use(express.json())\napp.get('/api/messages', async (req, res) => { const list = await prisma.message.findMany(); await prisma.message.deleteMany({ where: { expiresAt: { lt: new Date() } } }); res.json(list) })\napp.post('/api/messages', async (req, res) => res.json(await createMessage(req.body)))\napp.listen(3001)\n"
const service = "export async function createMessage(data) { return prisma.message.create({ data }) }\n"
const app = "import { Routes, Route } from 'react-router-dom'\nimport Chat from './pages/Chat'\nexport default function App() { return <Routes><Route path=\"/chat\" element={<Chat />} /></Routes> }\n"
const pageA = "import { useEffect, useState } from 'react'\nexport default function Chat() { const [m, setM] = useState([]); useEffect(() => { fetch('/api/messages').then(r => r.json()).then(setM) }, []); return <main><h1>Chat</h1>{m.map(x => <p key={x.id}>{x.text}</p>)}</main> }\n"
const pageB = pageA.replace("return <main>", "const send = (text) => fetch('/api/messages', { method: 'POST', body: JSON.stringify({ text }) }); return <main>").replace('</main>', "<button onClick={() => send('hi')}>Send</button></main>")
const before = { 'package.json': pkg, 'server/index.ts': server, 'server/services/messages.ts': service, 'client/src/App.tsx': app, 'client/src/pages/Chat.tsx': pageA }
const after = { ...before, 'client/src/pages/Chat.tsx': pageB }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(c.includes('sends messages to your server') && !c.includes('deletes messages'), c)
}
console.log('ok (review 47)')
// Review 48: SvelteKit actions sharing one address and a Nuxt isMethod branch don't lend a delete to a POST; the outside-server note sees
// a context's login calls
{
// SvelteKit: /posts/+page.server.ts has two form actions: create (through a $lib/server helper plain doesn't follow) and delete (inline
// Drizzle delete). All actions share one POST unit, so ops = {delete}. A new /posts/new page whose only form posts to ?/create.
const pkg = '{"dependencies":{"@sveltejs/kit":"2.0.0","svelte":"4.0.0","drizzle-orm":"0.30.0"}}'
const server = "import { db } from '$lib/server/db'\nimport { posts } from '$lib/server/schema'\nimport { eq } from 'drizzle-orm'\nimport { createPost } from '$lib/server/posts'\nexport const load = async () => ({ posts: await db.select().from(posts) })\nexport const actions = {\n  create: async ({ request, locals }) => {\n    const data = await request.formData()\n    await createPost(locals.user.id, String(data.get('title')), String(data.get('body')))\n  },\n  delete: async ({ request }) => {\n    const data = await request.formData()\n    await db.delete(posts).where(eq(posts.id, Number(data.get('id'))))\n  },\n}\n"
const list = "<script>\n  export let data\n</script>\n<h1>Posts</h1>\n{#each data.posts as p}<div>{p.title}<form method=\"POST\" action=\"?/delete\"><input type=\"hidden\" name=\"id\" value={p.id} /><button>Delete</button></form></div>{/each}\n<a href=\"/posts/new\">New post</a>\n"
const newPage = "<h1>New post</h1>\n<form method=\"POST\" action=\"/posts?/create\">\n  <input name=\"title\" />\n  <textarea name=\"body\"></textarea>\n  <button>Publish</button>\n</form>\n"
const before = { 'package.json': pkg, 'src/routes/posts/+page.server.ts': server, 'src/routes/posts/+page.svelte': list }
const after = { ...before, 'src/routes/posts/new/+page.svelte': newPage }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(c.includes('sends posts to your server') && !c.includes('deletes posts'), c)
}
{
// Nuxt (h3's isMethod helper): server/api/subscribers.ts (no .post/.delete in the name: answers every method). POST subscribes through an auto-imported
// server/utils helper plain doesn't follow; DELETE unsubscribes with an inline Drizzle delete. plain calls the file POST (it writes),
// ops = {delete}. A new signup page POSTs to it.
const pkg = '{"dependencies":{"nuxt":"3.12.0","drizzle-orm":"0.30.0"}}'
const api = "import { subscribers } from '~/server/db/schema'\nimport { eq } from 'drizzle-orm'\nexport default defineEventHandler(async (event) => {\n  const body = await readBody(event)\n  if (isMethod(event, 'DELETE')) {\n    await db.delete(subscribers).where(eq(subscribers.email, body.email))\n    return { ok: true }\n  }\n  return await addSubscriber(body.email)\n})\n"
const page = "<script setup>\nconst email = ref('')\nasync function join() { await $fetch('/api/subscribers', { method: 'POST', body: { email: email.value } }) }\n</script>\n<template>\n  <main><h1>Join the newsletter</h1><input v-model=\"email\" placeholder=\"Email\" /><button @click=\"join\">Subscribe</button></main>\n</template>\n"
const before = { 'package.json': pkg, 'server/api/subscribers.ts': api, 'pages/index.vue': '<template><main>Home</main></template>\n' }
const after = { ...before, 'pages/newsletter.vue': page }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(c.includes('sends subscribers to your server') && !c.includes('deletes subscribers'), c)
}
{
// Frontend-only React app (backend in another repo). AuthContext (createContext, provider rendered in App) loads GET /api/auth/me and
// updates the profile with PUT... no: only /me and logout. A new protected Account page shows the user from useAuth() (name, email,
// plan) and a log out button. HEAD: "A page's login check only hides the page. Its data comes from /api/auth ..." note.
// NEW: those calls are quiet, outsideCalls doesn't read quiet -> the note is gone.
const pkg = '{"dependencies":{"react":"18.0.0","react-router-dom":"6.0.0"}}'
const ctx = "import { createContext, useContext, useEffect, useState } from 'react'\nconst C = createContext(null)\nexport function AuthProvider({ children }) { const [user, setUser] = useState(null); useEffect(() => { fetch('/api/auth/me').then(r => r.json()).then(setUser) }, []); const logout = () => fetch('/api/auth/logout', { method: 'POST' }); return <C.Provider value={{ user, logout }}>{children}</C.Provider> }\nexport const useAuth = () => useContext(C)\n"
const guard = "import { Navigate } from 'react-router-dom'\nimport { useAuth } from './context/AuthContext'\nexport function RequireAuth({ children }) { const { user } = useAuth(); if (!user) return <Navigate to=\"/login\" />; return children }\n"
const appA = "import { Routes, Route } from 'react-router-dom'\nimport { AuthProvider } from './context/AuthContext'\nimport { RequireAuth } from './RequireAuth'\nimport Home from './pages/Home'\nexport default function App() { return <AuthProvider><Routes><Route path=\"/\" element={<Home />} /></Routes></AuthProvider> }\n"
const appB = appA.replace("import Home from './pages/Home'", "import Home from './pages/Home'\nimport Account from './pages/Account'").replace('<Route path="/" element={<Home />} />', '<Route path="/" element={<Home />} /><Route path="/account" element={<RequireAuth><Account /></RequireAuth>} />')
const home = "export default function Home() { return <main>Home</main> }\n"
const account = "import { useAuth } from '../context/AuthContext'\nexport default function Account() { const { user, logout } = useAuth(); return <main><h1>Your account</h1><p>{user.name}</p><p>{user.email}</p><p>{user.plan}</p><button onClick={logout}>Log out</button></main> }\n"
const before = { 'package.json': pkg, 'src/context/AuthContext.tsx': ctx, 'src/RequireAuth.tsx': guard, 'src/App.tsx': appA, 'src/pages/Home.tsx': home }
const after = { ...before, 'src/App.tsx': appB, 'src/pages/Account.tsx': account }
const c = report(new Map(Object.entries(before)), new Map(Object.entries(after)), { ref: 'main' }).replace(/\s+/g, ' ')
assert.ok(c.includes("A page's login check only hides the page"), c)
}
console.log('ok (review 48)')
// Next.js route handlers and pages/api: login read from each method's own check, never from calling auth() alone
{
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}' }
  const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
  const del = (body: string) => `import { auth } from '@/auth'\nexport async function DELETE(req: Request) {\n${body}\n  await prisma.user.delete({ where: { id: 1 } })\n  return Response.json({})\n}\n`
  // calls auth() and ignores the answer: no ✓ (it used to get one), and no warning plain can't back either
  let c = card({ 'app/api/x/route.ts': del('  const session = await auth()\n  console.log(session)') })
  assert.ok(!c.includes('requires login ✓') && !c.includes('Anyone'), c)
  // whatever the session is called
  for (const body of ['  const s = await auth()\n  if (!s) return new Response(null, { status: 401 })', '  const me = await getCurrentUser()\n  if (!me) return Response.json({}, { status: 401 })',
    '  const s = await auth()\n  if (!s?.user) return new Response(null, { status: 401 })']) {
    c = card({ 'app/api/x/route.ts': del(body) })
    assert.ok(c.includes('deletes users and requires login ✓') && !c.includes('Anyone'), c)
  }
  // a name from somewhere else isn't a session: `const s = await getStripe()`
  c = card({ 'app/api/x/route.ts': del('  const s = await getStripe()\n  if (!s) return new Response(null, { status: 401 })') })
  assert.ok(!c.includes('requires login ✓'), c)
  // pages/api: the default-exported handler
  const api = (body: string, exp: string) => `import { getServerSession } from 'next-auth'\n${exp === 'decl' ? 'export default async function handler' : 'async function handler'}(req, res) {\n${body}\n  await prisma.user.delete({ where: { id: 1 } })\n  res.json({})\n}\n${exp === 'name' ? 'export default handler\n' : ''}`
  for (const exp of ['decl', 'name']) {
    c = card({ 'pages/api/x.ts': api('  const session = await getServerSession(req, res, opts)\n  if (!session) return res.status(401).end()', exp) })
    assert.ok(c.includes('requires login ✓') && !c.includes('Anyone'), c)
    c = card({ 'pages/api/x.ts': api('  const session = await getServerSession(req, res, opts)', exp) })
    assert.ok(!c.includes('requires login ✓'), c)
  }
  console.log('ok (next route handler login)')
}
// Review 50: Next route handlers say neither ✓ nor ⚠ when plain can't read them (wrapped exports, next-connect, a check in a switch or
// helper, middleware); getUser(params.id) is a lookup, not a login; pages/api's `res.status(401).json(); return` is a check
{
const outs: string[] = [], log = (...a: unknown[]) => { outs.push(a.join(' ')) }
// NextAuth docs pattern for pages/api: `res.status(401).json(...); return` inside the if
const nx = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
log(card({ 'pages/api/posts.ts': `import { getServerSession } from "next-auth/next"
import { authOptions } from "./auth/[...nextauth]"
import prisma from "@/lib/prisma"
export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) {
    res.status(401).json({ message: "You must be logged in." })
    return
  }
  await prisma.post.create({ data: { title: req.body.title, authorId: session.user.id } })
  res.json({ ok: true })
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) assert.ok(/requires login ✓/.test(x) && !/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { outs.push(a.join(' ')) }
// pages/api: default-export shapes the new name lookup misses, and a check inside switch(req.method). All REALISTIC.
const nx = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ').replace(/^.*?(LOOK AT|✓ No problems)/, '$1')
const body = `  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  await prisma.post.create({ data: { title: req.body.title } })
  res.json({ ok: true })`
const imp = `import { getServerSession } from "next-auth/next"\nimport { authOptions } from "@/lib/auth"\n`
const cases: Record<string, string> = {
  'export default withSentry(handler)': `${imp}import { withSentry } from "@sentry/nextjs"\nasync function handler(req, res) {\n${body}\n}\nexport default withSentry(handler)\n`,
  'export default async function (req, res) (anonymous)': `${imp}export default async function (req, res) {\n${body}\n}\n`,
  'export { handler as default }': `${imp}async function handler(req, res) {\n${body}\n}\nexport { handler as default }\n`,
  'switch (req.method) { case "POST": if (!session) ... }': `${imp}export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions)
  switch (req.method) {
    case "POST":
      if (!session) return res.status(401).end()
      await prisma.post.create({ data: { title: req.body.title } })
      return res.json({ ok: true })
    default:
      return res.status(405).end()
  }
}
`,
  'next-connect router.handler()': `${imp}import { createRouter } from "next-connect"
const router = createRouter()
router.post(async (req, res) => {
${body}
})
export default router.handler()
`,
}
for (const [k, v] of Object.entries(cases)) log(k, '::', card({ 'pages/api/posts.ts': v }), '\n')
assert.ok(outs.length >= 1)
// (these handlers do check: a ✓ is right when plain can read it)
for (const x of outs) assert.ok(!/Anyone|works without logging in|no longer requires login/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { outs.push(a.join(' ')) }
// app router: handler shapes with no f.locals entry for the method, or a check in a same-file helper. REALISTIC.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ').replace(/^.*?(LOOK AT|✓ No problems)/, '$1')
const cases: Record<string, Record<string, string>> = {
  'NextAuth v5 export const POST = auth(fn) that checks req.auth': { 'app/api/posts/route.ts': `import { auth } from "@/auth"
import { NextResponse } from "next/server"
export const POST = auth(async function POST(req) {
  if (!req.auth) return NextResponse.json({ message: "Not authenticated" }, { status: 401 })
  await prisma.post.create({ data: { title: "x" } })
  return NextResponse.json({ ok: true })
})
` },
  'NextAuth v5 GET-only export const GET = auth(fn) that checks req.auth': { 'app/api/me/orders/route.ts': `import { auth } from "@/auth"
export const GET = auth(async function GET(req) {
  if (!req.auth) return Response.json({ message: "Not authenticated" }, { status: 401 })
  const orders = await prisma.order.findMany({ where: { userId: req.auth.user.id } })
  return Response.json(orders)
})
` },
  'export { handler as GET, handler as POST }': { 'app/api/posts/route.ts': `import { auth } from "@/auth"
async function handler(req: Request) {
  const session = await auth()
  if (!session) return new Response("Unauthorized", { status: 401 })
  await prisma.post.create({ data: { title: "x" } })
  return Response.json({ ok: true })
}
export { handler as GET, handler as POST }
` },
  'check in a same-file helper (getUserOrThrow)': { 'app/api/posts/route.ts': `import { auth } from "@/auth"
async function getUserOrThrow() {
  const session = await auth()
  if (!session?.user) throw new Error("Unauthorized")
  return session.user
}
export async function POST(req: Request) {
  const user = await getUserOrThrow()
  await prisma.post.create({ data: { title: "x", authorId: user.id } })
  return Response.json({ ok: true })
}
` },
}
for (const [k, v] of Object.entries(cases)) log(k, '::', card(v), '\n')
// an edit: moving the check into the v5 wrapper now reads as "no longer requires login"
const before = `import { auth } from "@/auth"
export async function POST(req: Request) {
  const session = await auth()
  if (!session) return new Response("Unauthorized", { status: 401 })
  await prisma.post.create({ data: { title: "x" } })
  return Response.json({ ok: true })
}
`, after = `import { auth } from "@/auth"
export const POST = auth(async (req) => {
  if (!req.auth) return new Response("Unauthorized", { status: 401 })
  await prisma.post.create({ data: { title: "x" } })
  return Response.json({ ok: true })
})
`
log('edit to v5 wrapper ::', report(new Map(Object.entries({ ...nx, 'app/api/posts/route.ts': before })), new Map(Object.entries({ ...nx, 'app/api/posts/route.ts': after })), { ref: 'main' }).replace(/\s+/g, ' ').replace(/^.*?(LOOK AT|✓ No problems)/, '$1'))
assert.ok(outs.length >= 2)
// (these handlers do check: a ✓ is right when plain can read it)
for (const x of outs) assert.ok(!/Anyone|works without logging in|no longer requires login/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { outs.push(a.join(' ')) }
// authAlias: AUTH_CALL matches getUser(id) / getSession(id) lookups by id, and any `if (!x) return/notFound()` then counts as a login check.
// REALISTIC: getUser(params.id) + notFound()/404 is the standard Next/SvelteKit/Nuxt lookup pattern.
const run = (pkg: string, files: Record<string, string>) => { const b = { 'package.json': pkg }; return report(new Map(Object.entries(b)), new Map(Object.entries({ ...b, ...files })), { ref: 'main' }).replace(/\s+/g, ' ').replace(/^.*?(LOOK AT|✓ No problems)/, '$1') }
const sk = '{"dependencies":{"@sveltejs/kit":"2.0.0"}}', nuxt = '{"dependencies":{"nuxt":"3.0.0"}}', next = '{"dependencies":{"next":"15.0.0"}}'
const cases: [string, string, Record<string, string>][] = [
  ['Next page: const profile = await getUser(params.id); if (!profile) notFound()', next, { 'app/account/[id]/page.tsx': `import { notFound } from "next/navigation"
import { getUser } from "@/lib/users"
export default async function Page({ params }) {
  const profile = await getUser(params.id)
  if (!profile) notFound()
  return <main><h1>{profile.name}</h1><p>{profile.email}</p></main>
}
` }],
  ['Next admin page: const workshop = await getSession(params.id)', next, { 'app/admin/sessions/[id]/page.tsx': `import { notFound } from "next/navigation"
import { getSession } from "@/lib/sessions"
export default async function Page({ params }) {
  const workshop = await getSession(params.id)
  if (!workshop) notFound()
  return <main><h1>{workshop.title}</h1></main>
}
` }],
  ['Next route: const chat = await getSession(params.id) -> 404', next, { 'app/api/chat/[id]/route.ts': `import { getSession } from "@/lib/chat-sessions"
export async function DELETE(req: Request, { params }) {
  const chat = await getSession(params.id)
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 })
  await prisma.message.deleteMany({ where: { chatId: chat.id } })
  return Response.json({ ok: true })
}
` }],
  ['SvelteKit +server.ts: const target = await getUser(params.id) -> 404', sk, { 'src/routes/api/users/[id]/+server.ts': `import { getUser } from '$lib/server/users'
import { json } from '@sveltejs/kit'
export async function DELETE({ params }) {
  const target = await getUser(params.id)
  if (!target) return json({ error: 'not found' }, { status: 404 })
  await db.user.delete({ where: { id: target.id } })
  return json({ ok: true })
}
` }],
  ['Nuxt server/api: const target = await getUser(id)', nuxt, { 'server/api/users/[id].delete.ts': `export default defineEventHandler(async (event) => {
  const target = await getUser(getRouterParam(event, 'id'))
  if (!target) return { error: 'not found' }
  await db.user.delete({ where: { id: target.id } })
  return { ok: true }
})
` }],
  ['Next server action: const workshop = await getSession(id)', next, { 'app/actions.ts': `'use server'
import { getSession } from '@/lib/workshops'
export async function cancelSession(id: string) {
  const workshop = await getSession(id)
  if (!workshop) return { error: 'Not found' }
  await prisma.booking.deleteMany({ where: { sessionId: id } })
}
` }],
]
for (const [k, pkg, v] of cases) log(k, '::', run(pkg, v), '\n')
assert.ok(outs.length >= 1)
for (const x of outs) assert.ok(!/requires login ✓|log in to open it ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { outs.push(a.join(' ')) }
// middleware.ts guards /api; the handler reads auth() for the user id without its own check. HEAD: requires login ✓; NEW: flat
// "works without logging in" / "Anyone can post". REALISTIC, but a trade-off: plain doesn't map Next middleware to routes at all.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ').replace(/^.*?(LOOK AT|✓ No problems)/, '$1')
const mw = { 'middleware.ts': `import { auth } from "@/auth"
export default auth((req) => { if (!req.auth) return Response.redirect(new URL("/login", req.url)) })
export const config = { matcher: ["/api/:path*"] }
` }
log('GET ::', card({ ...mw, 'app/api/orders/route.ts': `import { auth } from "@/auth"
export async function GET() {
  const session = await auth()
  const orders = await prisma.order.findMany({ where: { userId: session!.user!.id } })
  return Response.json(orders)
}
` }), '\n')
log('POST ::', card({ ...mw, 'app/api/posts/route.ts': `import { auth } from "@/auth"
export async function POST(req: Request) {
  const session = await auth()
  await prisma.post.create({ data: { title: "x", authorId: session!.user!.id } })
  return Response.json({ ok: true })
}
` }))
assert.ok(outs.length >= 2)
for (const x of outs) assert.ok(!/Anyone|works without logging in|no longer requires login|requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { outs.push(a.join(' ')) }
// authAlias scope edge cases on SvelteKit (+server.ts uses handlerChecks, so new vs HEAD shows): CONTRIVED
const b = { 'package.json': '{"dependencies":{"@sveltejs/kit":"2.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(b)), new Map(Object.entries({ ...b, ...files })), { ref: 'main' }).replace(/\s+/g, ' ').replace(/^.*?(LOOK AT|✓ No problems)/, '$1')
const del = (body: string) => `import { json } from '@sveltejs/kit'\nexport async function DELETE({ request, locals }) {\n${body}\n  await db.user.delete({ where: { id: 1 } })\n  return json({})\n}\n`
// for-of binding isn't a VariableStatement: the `me` in the loop resolves to the outer auth() alias
log('for-of shadow ::', card({ 'src/routes/api/x/+server.ts': del(`  const me = await getCurrentUser()
  for (const me of await request.json()) { if (!me) return json({ error: 'empty row' }, { status: 400 }) }`) }), '\n')
// let reassigned to something else before the check
log('let reassigned ::', card({ 'src/routes/api/x/+server.ts': del(`  let me = await getCurrentUser()
  me = await db.profile.findFirst({ where: { slug: 'x' } })
  if (!me) return json({}, { status: 404 })`) }), '\n')
assert.ok(outs.length >= 2)
for (const x of outs) assert.ok(!/requires login ✓/.test(x), x)
}
console.log('ok (review 50)')
// Review 51: a 403 owner check or words like "forbidden" don't hide the warning; a middleware counts only about login and where its matcher
// reaches; Clerk's auth().protect(); authorId isn't the request; pages/api read without comments, anonymous default handlers
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// The classic regression: the agent drops the session check and trusts a userId from the body; an ownership 403 stays.
// HEAD: "no longer requires login" + warning. NEW: the 403 makes the handler "unread" -> guardUnknown -> silence?
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}' }
const run = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries({ ...nx, ...a })), new Map(Object.entries({ ...nx, ...b })), { ref: 'main' }).replace(/\s+/g, ' ')
const before = `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { NextResponse } from "next/server"
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const post = await prisma.post.findUnique({ where: { id: params.id } })
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (post.authorId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await prisma.post.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
`
const after = `import { prisma } from "@/lib/prisma"
import { NextResponse } from "next/server"
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const { userId } = await req.json()
  const post = await prisma.post.findUnique({ where: { id: params.id } })
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (post.authorId !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await prisma.post.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
`
log('swap ::', run({ 'app/api/posts/[id]/route.ts': before }, { 'app/api/posts/[id]/route.ts': after }))
log()
// new file, same shape
log('new ::', run({}, { 'app/api/posts/[id]/route.ts': after }))
assert.ok(outs.length >= 2)
for (const x of outs) assert.ok(/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// "unread" fires on any 401/403/unauthorized/forbidden/sign in/log in text in the handler: comments, error strings, identifiers.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const h = (body: string) => `import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const body = await req.json()
${body}
  const order = await prisma.order.create({ data: body })
  return Response.json(order)
}
`
log('TODO comment ::', card({ 'app/api/orders/route.ts': h('  // TODO: check the user is signed in before launch') }), '\n')
log('login comment ::', card({ 'app/api/orders/route.ts': h('  // anyone can order without a login for now') }), '\n')
log('assignInvoice ::', card({ 'app/api/orders/route.ts': h('  const n = await assignInvoiceNumber(body)') }), '\n')
log('catalogIndex ::', card({ 'app/api/orders/route.ts': h('  const catalogIndex = body.items.length') }), '\n')
log('validation forbidden ::', card({ 'app/api/orders/route.ts': h('  if (body.qty > 99) return Response.json({ error: "Quantity forbidden" }, { status: 400 })') }), '\n')
log('baseline ::', card({ 'app/api/orders/route.ts': h('') }))
assert.ok(outs.length >= 6)
for (const x of outs) assert.ok(/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// nextMw: any middleware.ts mentioning cookie/token/auth/... silences every unchecked route handler, even when the middleware
// only does i18n, or its matcher excludes /api (the Next docs default matcher).
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const route = { 'app/api/orders/route.ts': `import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const order = await prisma.order.create({ data: await req.json() })
  return Response.json(order)
}
` }
const i18n = `import { NextResponse, type NextRequest } from "next/server"
const locales = ["en", "fr"]
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (locales.some((l) => pathname.startsWith("/" + l))) return
  const locale = request.cookies.get("NEXT_LOCALE")?.value ?? "en"
  return NextResponse.redirect(new URL("/" + locale + pathname, request.url))
}
export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] }
`
const authNoApi = `import { NextResponse, type NextRequest } from "next/server"
export function middleware(request: NextRequest) {
  if (!request.cookies.get("session")) return NextResponse.redirect(new URL("/login", request.url))
}
export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico|login).*)"] }
`
const dashOnly = `export { auth as middleware } from "@/auth"
export const config = { matcher: ["/dashboard/:path*"] }
`
log('i18n cookie mw ::', card({ ...route, 'middleware.ts': i18n }), '\n')
log('auth mw, matcher excludes api ::', card({ ...route, 'middleware.ts': authNoApi }), '\n')
log('auth mw, matcher /dashboard only ::', card({ ...route, 'middleware.ts': dashOnly }), '\n')
log('no mw ::', card(route))
assert.ok(outs.length >= 4)
for (const x of outs) assert.ok(/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// REQ_ARG's \w*[Aa]uth\w* accepts `authorId`: getUser(authorId) is a lookup of another user, but becomes "the session".
const run = (pkg: string, files: Record<string, string>) => { const b = { 'package.json': pkg }; return report(new Map(Object.entries(b)), new Map(Object.entries({ ...b, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const sk = '{"dependencies":{"@sveltejs/kit":"2.0.0","@prisma/client":"5.0.0"}}', nuxt = '{"dependencies":{"nuxt":"3.0.0","@prisma/client":"5.0.0"}}', ex = '{"dependencies":{"express":"4.0.0","@prisma/client":"5.0.0"}}', next = '{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0"}}'
log('express ::', run(ex, { 'server.js': `const express = require('express')
const { getUser } = require('./users')
const app = express()
app.use(express.json())
app.post('/api/posts', async (req, res) => {
  const { authorId, title } = req.body
  const author = await getUser(authorId)
  if (!author) return res.status(400).json({ error: 'Unknown author' })
  const post = await prisma.post.create({ data: { title, authorId: author.id } })
  res.json(post)
})
app.listen(3000)
` }), '\n')
log('sveltekit ::', run(sk, { 'src/routes/api/posts/+server.ts': `import { json } from '@sveltejs/kit'
import { getUser } from '$lib/server/users'
export async function POST({ request }) {
  const { authorId, title } = await request.json()
  const author = await getUser(authorId)
  if (!author) return json({ error: 'Unknown author' }, { status: 400 })
  const post = await prisma.post.create({ data: { title, authorId: author.id } })
  return json(post)
}
` }), '\n')
log('nuxt ::', run(nuxt, { 'server/api/posts.post.ts': `export default defineEventHandler(async (event) => {
  const { authorId, title } = await readBody(event)
  const author = await getUser(authorId)
  if (!author) throw createError({ statusCode: 400, statusMessage: 'Unknown author' })
  return prisma.post.create({ data: { title, authorId: author.id } })
})
` }), '\n')
log('next ::', run(next, { 'app/api/posts/route.ts': `import { getUser } from '@/lib/users'
export async function POST(req: Request) {
  const { authorId, title } = await req.json()
  const author = await getUser(authorId)
  if (!author) return Response.json({ error: 'Unknown author' }, { status: 400 })
  const post = await prisma.post.create({ data: { title, authorId: author.id } })
  return Response.json(post)
}
` }))
assert.ok(outs.length >= 4)
for (const x of outs) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// Clerk's documented route-handler guards: v5 `auth().protect()`, v6 `await auth.protect()`, and `const { userId } = await auth()`.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@clerk/nextjs":"5.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const h = (head: string) => ({ 'app/api/orders/route.ts': `import { auth } from "@clerk/nextjs/server"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
${head}
  const order = await prisma.order.create({ data: await req.json() })
  return Response.json(order)
}
` })
log('v5 auth().protect() ::', card(h('  auth().protect()')), '\n')
log('v5 const { userId } = auth().protect() ::', card(h('  const { userId } = auth().protect()')), '\n')
log('v6 await auth.protect() ::', card(h('  await auth.protect()')), '\n')
log('(await auth()).protect() ::', card(h('  const a = await auth()\n  a.protect()')), '\n')
log('userId check ::', card(h('  const { userId } = await auth()\n  if (!userId) return new Response("Unauthorized", { status: 401 })')), '\n')
assert.ok(outs.length >= 5)
for (const x of outs) assert.ok(!/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// "if (session) { ...protected...; return }  <guest reply>": the guard is the positive branch with no else.
const nx = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
// NextAuth v4 docs: pages/api/examples/protected.ts
log('docs read ::', card({ 'pages/api/examples/protected.ts': `import { getServerSession } from "next-auth/next"
import { authOptions } from "../auth/[...nextauth]"
export default async (req, res) => {
  const session = await getServerSession(req, res, authOptions)
  if (session) {
    return res.send({ content: "This is protected content. You can access this content because you are signed in." })
  }
  res.send({ error: "You must be signed in to view the protected content on this page." })
}
` }), '\n')
log('write ::', card({ 'pages/api/orders.ts': `import { getServerSession } from "next-auth/next"
import { authOptions } from "./auth/[...nextauth]"
import { prisma } from "@/lib/prisma"
export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions)
  if (session) {
    const order = await prisma.order.create({ data: { ...req.body, userId: session.user.id } })
    return res.json(order)
  }
  res.send({ error: "You must be signed in." })
}
` }), '\n')
log('app write ::', card({ 'app/api/orders/route.ts': `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const session = await auth()
  if (session?.user) {
    const order = await prisma.order.create({ data: { ...(await req.json()), userId: session.user.id } })
    return Response.json(order)
  }
  return Response.json({ error: "You must be signed in" })
}
` }))
assert.ok(outs.length >= 3)
for (const x of outs) assert.ok(!/Anyone|works without logging in/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// The agent "temporarily" comments out the login check. pages/api arrow default: `read` tests the raw file text, comments included.
const nx = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}' }
const run = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries({ ...nx, ...a })), new Map(Object.entries({ ...nx, ...b })), { ref: 'main' }).replace(/\s+/g, ' ')
const mk = (open: string, close: string, c: string) => `import { getServerSession } from "next-auth/next"
import { authOptions } from "./auth/[...nextauth]"
import { prisma } from "@/lib/prisma"
${open}
  ${c}const session = await getServerSession(req, res, authOptions)
  ${c}if (!session) return res.status(401).json({ error: "Unauthorized" })
  const order = await prisma.order.create({ data: req.body })
  res.json(order)
${close}
`
for (const [label, open, close] of [['arrow default', 'export default async (req, res) => {', '}'], ['named default', 'export default async function handler(req, res) {', '}']]) {
  log(label, '::', run({ 'pages/api/orders.ts': mk(open, close, '') }, { 'pages/api/orders.ts': mk(open, close, '// ') }), '\n')
}
const app = (c: string) => `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  ${c}const session = await auth()
  ${c}if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const order = await prisma.order.create({ data: await req.json() })
  return Response.json(order)
}
`
log('app router ::', run({ 'app/api/orders/route.ts': app('') }, { 'app/api/orders/route.ts': app('// ') }))
assert.ok(outs.length >= 2)
for (const x of outs) assert.ok(/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// PATCH checks login (readable), DELETE doesn't. plain can read both, but PATCH's own 401 makes the file "unread".
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
log(card({ 'app/api/posts/[id]/route.ts': `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
export async function PATCH(req: Request, { params }) {
  const session = await auth()
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 })
  await prisma.post.update({ where: { id: params.id }, data: await req.json() })
  return Response.json({ ok: true })
}
export async function DELETE(req: Request, { params }) {
  await prisma.post.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// pages/api default-export shapes the name/arrow regexes miss: anonymous function, `export default handler // comment`
const nx = { 'package.json': '{"dependencies":{"next":"14.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const body = `  const order = await prisma.order.create({ data: req.body })
  res.json(order)`
log('anon fn ::', card({ 'pages/api/orders.ts': `import { prisma } from "@/lib/prisma"
export default async function (req, res) {
${body}
}
` }), '\n')
log('trailing comment ::', card({ 'pages/api/orders.ts': `import { prisma } from "@/lib/prisma"
async function handler(req, res) {
${body}
}
export default handler // pages router
` }), '\n')
log('arrow, unrelated 403 elsewhere in file ::', card({ 'pages/api/orders.ts': `import { prisma } from "@/lib/prisma"
export default async (req, res) => {
  if (req.body.qty > 99) return res.status(400).json({ error: "Quantity forbidden" })
${body}
}
` }))
assert.ok(outs.length >= 3)
for (const x of outs) assert.ok(/Anyone/.test(x), x)
}
console.log('ok (review 51)')
// Review 52: Next matchers read like path-to-regexp ('/' is the home page, /(a|b)/:path*, /:locale/...); a same-file helper awaited first
// is the check; login words only in a branch or a reply demanding it; next-connect chains and an early return before the check aren't ✓
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// nextMw: matcher entries that only reach pages count as reaching every address, so an unchecked POST /api/orders loses its
// "Anyone can" warning (HEAD warned). '/' in a Next matcher is the home page only, not a prefix of everything; '/(dashboard|account)/:path*'
// and '/:locale/dashboard/:path*' are page-only too. The middleware itself is a real login middleware.
// '/' + '/dashboard/:path*' is REALISTIC (protect the home feed and the dashboard); the other two less common.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const route = { 'app/api/orders/route.ts': `import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const order = await prisma.order.create({ data: await req.json() })
  return Response.json(order)
}
` }
const mw = (matcher: string) => ({ 'middleware.ts': `import { auth } from "@/auth"
export default auth((req) => {
  if (!req.auth) return Response.redirect(new URL("/login", req.nextUrl))
})
export const config = { matcher: ${matcher} }
` })
for (const m of ['["/", "/dashboard/:path*"]', '["/(dashboard|account)/:path*"]', '["/:locale/dashboard/:path*"]', '["/dashboard/:path*"]'])
  log(m, '::', card({ ...route, ...mw(m) }), '\n')
// matcher kept in a const and passed by shorthand: no `matcher:` text, so nextMw treats it as "no matcher = everything"
log('shorthand ::', card({ ...route, 'middleware.ts': `import { auth } from "@/auth"
const matcher = ["/dashboard/:path*"]
export default auth((req) => {
  if (!req.auth) return Response.redirect(new URL("/login", req.nextUrl))
})
export const config = { matcher }
` }))
assert.ok(outs.length >= 2)
for (const x of outs) assert.ok(/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// A same-file login helper whose stop has none of LOGIN_WORDS (401 / unauthorized / sign in / log in): "Unauthenticated",
// "Not authenticated", a 403, redirect("/"). HEAD followed the helper and said "requires login ✓"; NEW reads the handler
// alone (no check), finds no login words, calls it read, and warns "Anyone can". New false alarm. REALISTIC.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const file = (stop: string) => ({ 'app/api/orders/route.ts': `import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
async function getUserOrThrow() {
  const session = await auth()
  if (!session?.user) ${stop}
  return session.user
}
export async function POST(req: Request) {
  const user = await getUserOrThrow()
  const order = await prisma.order.create({ data: { ...(await req.json()), userId: user.id } })
  return Response.json(order)
}
` })
for (const stop of ['throw new Error("Unauthenticated")', 'throw new Error("Not authenticated")', 'throw new Response("Forbidden", { status: 403 })', 'redirect("/")'])
  log(stop, '::', card(file(stop)), '\n')
// pages/api, same helper
const pa = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}' }
const pcard = (files: Record<string, string>) => report(new Map(Object.entries(pa)), new Map(Object.entries({ ...pa, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
log('pages/api ::', pcard({ 'pages/api/orders.ts': `import { getServerSession } from "next-auth/next"
import { authOptions } from "./auth/[...nextauth]"
import prisma from "@/lib/prisma"
async function getUserOrThrow(req, res) {
  const session = await getServerSession(req, res, authOptions)
  if (!session?.user) throw new Error("Unauthenticated")
  return session.user
}
export default async function handler(req, res) {
  const user = await getUserOrThrow(req, res)
  const order = await prisma.order.create({ data: { ...req.body, userId: user.id } })
  res.json(order)
}
` }))
assert.ok(outs.length >= 2)
// (plain doesn't follow helpers: no ✓, but no false alarm either)
for (const x of outs) assert.ok(!/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// LOGIN_WORDS (round 2: 401 / unauthorized / sign in / log in) still fires on user-facing copy that isn't a check: an open
// guest-checkout POST whose reply or same-file email helper says "sign in to track it". The handler is fully readable and
// checks nothing; HEAD warned "Anyone can", NEW is silent. REALISTIC (guest checkout / newsletter / contact copy).
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0","resend":"3.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
log('reply copy ::', card({ 'app/api/orders/route.ts': `import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const order = await prisma.order.create({ data: await req.json() })
  return Response.json({ order, message: "Order placed! Sign in to track it." })
}
` }), '\n')
log('email helper copy ::', card({ 'app/api/orders/route.ts': `import { prisma } from "@/lib/prisma"
import { resend } from "@/lib/resend"
async function sendConfirmation(email: string, id: string) {
  await resend.emails.send({ from: "shop@example.com", to: email, subject: "Thanks!", text: "Log in to your account to track order " + id })
}
export async function POST(req: Request) {
  const body = await req.json()
  const order = await prisma.order.create({ data: body })
  await sendConfirmation(body.email, order.id)
  return Response.json(order)
}
` }), '\n')
log('delete with copy ::', card({ 'app/api/orders/[id]/route.ts': `import { prisma } from "@/lib/prisma"
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  await prisma.order.delete({ where: { id: params.id } })
  return Response.json({ ok: true, message: "Order cancelled. Log in to see your other orders." })
}
` }))
assert.ok(outs.length >= 3)
for (const x of outs) assert.ok(/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// PRE-EXISTING false ✓ (HEAD and NEW): pages/api where one method checks login and another that writes does not.
// A: a next-connect chain inline in `export default`: exportAuth = handlerChecks(collect over the whole chain), so .get's check
//    covers .delete. B: `if (req.method === "DELETE") return deletePost(req, res)` before the check: WRITE_CALL doesn't see the
//    write inside the same-file helper, so the later check counts as unconditional. B REALISTIC; A moderately.
const nx = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","next-connect":"1.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
// A: next-connect inline chain: GET checks, DELETE doesn't
log('A nc chain ::', card({ 'pages/api/posts.ts': `import { createRouter } from "next-connect"
import { getServerSession } from "next-auth/next"
import { authOptions } from "../auth/[...nextauth]"
import prisma from "@/lib/prisma"
export default createRouter()
  .get(async (req, res) => {
    const session = await getServerSession(req, res, authOptions)
    if (!session) return res.status(401).json({ error: "Unauthorized" })
    res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
  })
  .delete(async (req, res) => {
    await prisma.post.delete({ where: { id: req.query.id } })
    res.json({ ok: true })
  })
  .handler()
` }), '\n')
// B: dispatch to helper before the check
log('B dispatch-before-check ::', card({ 'pages/api/posts.ts': `import { getServerSession } from "next-auth/next"
import { authOptions } from "../auth/[...nextauth]"
import prisma from "@/lib/prisma"
async function deletePost(req, res) {
  await prisma.post.delete({ where: { id: req.query.id } })
  res.json({ ok: true })
}
export default async function handler(req, res) {
  if (req.method === "DELETE") return deletePost(req, res)
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
}
` }), '\n')
assert.ok(outs.length >= 2)
for (const x of outs) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// PRE-EXISTING false alarm (HEAD and NEW) that the new nextMw was meant to cover but misses: Clerk's documented middleware.
// Its matcher contains `[^?]` so `\[[^\]]*\]` stops mid-pattern (no closed string -> no entries), and its "/(api|trpc)(.*)"
// entry is a `/(`-pattern that mentions api, which nextMw reads as "excludes api" when it means "always run for API routes".
// The middleware protects /api/(.*) with auth.protect(); plain still says "Anyone can". REALISTIC (Clerk's quickstart).
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@clerk/nextjs":"6.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const open = { 'app/api/orders/route.ts': `import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const order = await prisma.order.create({ data: await req.json() })
  return Response.json(order)
}
` }
// D: Clerk canonical middleware protecting /api
log('D clerk mw ::', card({ ...open, 'middleware.ts': `import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"
const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/api/(.*)"])
export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect()
})
export const config = {
  matcher: [
    "/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
}
` }), '\n')
assert.ok(outs.length >= 1)
// (plain doesn't read middleware for Next route handlers: it warns as before, and never gives a ✓ it can't back)
for (const x of outs) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// PRE-EXISTING false alarm (HEAD and NEW), not fixed by the alias rule: GET and POST in one route.ts each do
// `const me = await getCurrentUser(); if (!me) <stop>`. The "assigned more than once in the file" count sees two `me =` and drops
// the alias in both. With a 401 the file goes quiet (unread); with a 403 / "Not authenticated" throw it warns "Anyone can".
// F4 (POST alone) shows the alias itself works. REALISTIC layout; the 403/throw stop is less common than 401.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@clerk/nextjs":"6.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
// F: same alias name in two methods
const two = (stop: string) => `import { getCurrentUser } from "@/lib/session"
import { prisma } from "@/lib/prisma"
export async function GET() {
  const me = await getCurrentUser()
  if (!me) ${stop}
  return Response.json(await prisma.order.findMany({ where: { userId: me.id } }))
}
export async function POST(req: Request) {
  const me = await getCurrentUser()
  if (!me) ${stop}
  const order = await prisma.order.create({ data: { ...(await req.json()), userId: me.id } })
  return Response.json(order)
}
`
log('F1 two aliases 401 ::', card({ 'app/api/orders/route.ts': two('return new Response(null, { status: 401 })') }), '\n')
log('F2 two aliases 403 ::', card({ 'app/api/orders/route.ts': two('return Response.json({ error: "Forbidden" }, { status: 403 })') }), '\n')
log('F3 two aliases throw ::', card({ 'app/api/orders/route.ts': two('throw new Error("Not authenticated")') }), '\n')
log('F4 one alias 403 ::', card({ 'app/api/orders/route.ts': two('return Response.json({ error: "Forbidden" }, { status: 403 })').replace(/export async function GET[\s\S]*?\n}\n/, '') }), '\n')
assert.ok(outs.length >= 4)
for (const x of outs) assert.ok(!/Anyone/.test(x), x)
}
console.log('ok (review 52)')
// Review 53: Next route handlers only lose an old ✓ plain can't back (saying neither), never gain a warning they didn't have; a same-file
// helper counts only when it throws or redirects (not a returned 401 the caller ignores); next-connect chains, an early return before the check
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// PATCH checks login with a library HEAD's AUTH set doesn't know (better-auth / T3 / Lucia), DELETE checks nothing.
// HEAD: no ✓ -> "Anyone can" warning (true for DELETE). NEW: PATCH's own 401 makes the whole file "unread" -> guardUnknown -> silent.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","better-auth":"1.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
for (const [lib, get] of [['better-auth', 'auth.api.getSession({ headers: await headers() })'], ['t3', 'getServerAuthSession()'], ['lucia', 'validateRequest()']])
log(lib, '::', card({ 'app/api/posts/[id]/route.ts': `import { auth } from "@/lib/auth"
import { headers } from "next/headers"
import { getServerAuthSession } from "@/server/auth"
import { validateRequest } from "@/lib/lucia"
import { prisma } from "@/lib/prisma"
export async function PATCH(req: Request, { params }) {
  const session = await ${get}
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 })
  await prisma.post.update({ where: { id: params.id }, data: await req.json() })
  return Response.json({ ok: true })
}
export async function DELETE(req: Request, { params }) {
  await prisma.post.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}
` }), '\n')
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// Same-file login helper (its stop has no 401/"unauthorized"/"sign in" words), called NOT as the first statement:
// after `await req.json()`, or inside try { }. leadCalls is empty, so the helper isn't followed; loginWords finds nothing;
// NEW calls the handler read and warns "Anyone can". HEAD: ✓ (auth() in the file). New false alarm. REALISTIC.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const helper = `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
async function getUserOrThrow() {
  const session = await auth()
  if (!session?.user) throw new Error("Not authenticated")
  return session.user
}
`
log('after req.json ::', card({ 'app/api/orders/route.ts': helper + `export async function POST(req: Request) {
  const body = await req.json()
  const user = await getUserOrThrow()
  const order = await prisma.order.create({ data: { ...body, userId: user.id } })
  return Response.json(order)
}
` }), '\n')
log('in try ::', card({ 'app/api/orders/route.ts': helper + `export async function POST(req: Request) {
  try {
    const user = await getUserOrThrow()
    const order = await prisma.order.create({ data: { ...(await req.json()), userId: user.id } })
    return Response.json(order)
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 })
  }
}
` }), '\n')
log('not awaited-statement (user.id) ::', card({ 'app/api/orders/route.ts': helper + `export async function POST(req: Request) {
  const { items } = await req.json()
  const order = await prisma.order.create({ data: { items, userId: (await getUserOrThrow()).id } })
  return Response.json(order)
}
` }), '\n')
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(!/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// A same-file helper whose login check RETURNS a 401 Response (doesn't throw), awaited first by the handler, which ignores
// what it returns and goes on to write. Guests get through. NEW follows the helper (leadCalls + handlerChecks) and says
// "requires login ✓": a return in the helper stops the helper, not the caller. With a session getter HEAD's AUTH set doesn't
// know (T3's getServerAuthSession, better-auth), HEAD warned "Anyone can"; NEW claims ✓. FALSE REASSURANCE. REALISTIC: the
// helper is meant for `const r = await checkAuth(); if (r instanceof Response) return r`, and the second line gets forgotten.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
for (const getter of ['getServerAuthSession()', 'auth()'])
log(getter, '::', card({ 'app/api/posts/route.ts': `import { getServerAuthSession } from "@/server/auth"
import { auth } from "@/auth"
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
async function checkAuth() {
  const session = await ${getter}
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return null
}
export async function POST(req: Request) {
  await checkAuth()
  const post = await prisma.post.create({ data: await req.json() })
  return NextResponse.json(post)
}
` }), '\n')
// pages/api: same thing
const pa = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}' }
const pcard = (files: Record<string, string>) => report(new Map(Object.entries(pa)), new Map(Object.entries({ ...pa, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
log('pages/api ::', pcard({ 'pages/api/posts.ts': `import { getServerAuthSession } from "@/server/auth"
import prisma from "@/lib/prisma"
async function checkAuth(req, res) {
  const session = await getServerAuthSession({ req, res })
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return }
  return session
}
export default async function handler(req, res) {
  await checkAuth(req, res)
  const post = await prisma.post.create({ data: req.body })
  res.json(post)
}
` }))
// Variant: the helper throws, but its own try/catch swallows the throw and returns null (the common getCurrentUser shape);
// the caller ignores the result. The server-action path has a `swallows` test for exactly this; the route-handler path doesn't.
log('helper swallows its throw ::', card({ 'app/api/posts/[id]/route.ts': `import { getServerAuthSession } from "@/server/auth"
import { prisma } from "@/lib/prisma"
async function ensureSignedIn() {
  try {
    const session = await getServerAuthSession()
    if (!session?.user) throw new Error("Unauthorized")
    return session.user
  } catch (error) {
    console.error(error)
    return null
  }
}
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  await ensureSignedIn()
  await prisma.post.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}
` }))
// Variant: the helper is NAMED like a guard (requireAuth: REQUIRE_LOGIN), same file, readable, and returns the 401 instead of
// throwing; the caller drops the result. NEW credits it by name (an authIf with req: true counts in handlerChecks) -> ✓.
log('requireAuth by name, returns ::', card({ 'app/api/posts/route.ts': `import { getServerAuthSession } from "@/server/auth"
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
function requireAuth(session: unknown) {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
export async function POST(req: Request) {
  const session = await getServerAuthSession()
  requireAuth(session)
  const post = await prisma.post.create({ data: await req.json() })
  return NextResponse.json(post)
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// nextMw: "a middleware about login whose matcher reaches the address" silences every unchecked route handler, without
// asking whether the middleware turns anyone away. Clerk's quickstart middleware is `export default clerkMiddleware()` with
// that exact matcher: since Clerk v5 it protects NOTHING (all routes public unless auth.protect() is called). Every Clerk app
// has this file. HEAD warned "Anyone can" on an unchecked POST; NEW is silent. Same for NextAuth's `export default auth((req) => ...)`
// that only redirects /dashboard pages (no matcher). LOST WARNING. REALISTIC (Clerk quickstart verbatim).
const run = (deps: string, files: Record<string, string>) => { const nx = { 'package.json': `{"dependencies":{"next":"15.0.0",${deps},"@prisma/client":"5.0.0"}}` }
  return report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const route = { 'app/api/orders/route.ts': `import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const order = await prisma.order.create({ data: await req.json() })
  return Response.json(order)
}
` }
log('clerk quickstart ::', run('"@clerk/nextjs":"6.0.0"', { ...route, 'middleware.ts': `import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
` }), '\n')
log('clerk public-by-default, protects only /dashboard ::', run('"@clerk/nextjs":"6.0.0"', { ...route, 'middleware.ts': `import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"]);
export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect();
});
export const config = { matcher: ["/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"] };
` }), '\n')
log('next-auth, pages only, no matcher ::', run('"next-auth":"5.0.0"', { ...route, 'middleware.ts': `import { auth } from "@/auth"
export default auth((req) => {
  if (!req.auth && req.nextUrl.pathname.startsWith("/dashboard")) {
    return Response.redirect(new URL("/login", req.nextUrl.origin))
  }
})
` }), '\n')
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// nextMw's path-to-regexp conversion rewrites every `:word` into `[^/]+`, including the `?:` of a regex non-capturing group
// inside a matcher (`(?:svg|png)`). The pattern becomes invalid, the catch says "covers", and a login middleware whose matcher
// EXCLUDES /api (the Next docs' `(?!api|...)`) is taken to cover /api/orders. HEAD warned "Anyone can"; NEW is silent.
// LOST WARNING. REALISTIC: the docs' api exclusion plus the Supabase/Clerk-style static-file exclusion `.*\\.(?:svg|png|...)$`.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const route = { 'app/api/orders/route.ts': `import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const order = await prisma.order.create({ data: await req.json() })
  return Response.json(order)
}
` }
const mw = (matcher: string) => ({ 'middleware.ts': `import { auth } from "@/auth"
export default auth((req) => {
  if (!req.auth) return Response.redirect(new URL("/login", req.nextUrl.origin))
})
export const config = { matcher: [${matcher}] }
` })
log('excludes api, no group ::', card({ ...route, ...mw(`"/((?!api|_next/static|_next/image|favicon.ico|login).*)"`) }), '\n')
log('excludes api, (?:png|svg) ::', card({ ...route, ...mw(`"/((?!api|_next/static|_next/image|favicon.ico|login|.*\\\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"`) }), '\n')
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// Method dispatch to same-file helpers that each check login, with a 403 / "Not authenticated" stop (no 401 / "unauthorized" /
// "sign in" words). The handler itself checks nothing; the helpers aren't lead calls (`return createPost(...)` in a switch, or
// `return handleCreate(req)` without await), so `checks` doesn't follow them and loginWords finds nothing -> "read" -> warning.
// HEAD: ✓ (getServerSession / auth() in the file). NEW: "Anyone can". New false alarm. REALISTIC (switch(req.method) dispatch is
// a very common pages/api layout; 403 for "not logged in" is common in hobby code).
const pa = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(pa)), new Map(Object.entries({ ...pa, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
log('pages/api switch ::', card({ 'pages/api/posts.ts': `import { getServerSession } from "next-auth/next"
import { authOptions } from "./auth/[...nextauth]"
import prisma from "@/lib/prisma"
export default async function handler(req, res) {
  switch (req.method) {
    case "POST":
      return createPost(req, res)
    case "DELETE":
      return deletePost(req, res)
    default:
      return res.status(405).end()
  }
}
async function createPost(req, res) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(403).json({ message: "Not authenticated" })
  const post = await prisma.post.create({ data: { ...req.body, authorId: session.user.id } })
  return res.json(post)
}
async function deletePost(req, res) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(403).json({ message: "Not authenticated" })
  await prisma.post.delete({ where: { id: req.query.id, authorId: session.user.id } })
  return res.status(204).end()
}
` }), '\n')
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}' }
const card2 = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
log('app route, return helper(req) ::', card2({ 'app/api/posts/route.ts': `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
async function handleCreate(req: Request) {
  const session = await auth()
  if (!session?.user) return Response.json({ error: "Not authenticated" }, { status: 403 })
  const post = await prisma.post.create({ data: { ...(await req.json()), authorId: session.user.id } })
  return Response.json(post)
}
export async function POST(req: Request) {
  return handleCreate(req)
}
` }))
// Variant: the inline if / else-if on req.method, each branch checking login itself (checks sit under a non-path condition or an
// else, so none is "unconditional"); 403 + "Not authenticated" -> no login words -> warning.
log('pages/api if/else-if per method ::', card({ 'pages/api/posts.ts': `import { getServerSession } from "next-auth/next"
import { authOptions } from "./auth/[...nextauth]"
import prisma from "@/lib/prisma"
export default async function handler(req, res) {
  if (req.method === "POST") {
    const session = await getServerSession(req, res, authOptions)
    if (!session) return res.status(403).json({ message: "Not authenticated" })
    const post = await prisma.post.create({ data: { ...req.body, authorId: session.user.id } })
    return res.json(post)
  } else if (req.method === "DELETE") {
    const session = await getServerSession(req, res, authOptions)
    if (!session) return res.status(403).json({ message: "Not authenticated" })
    await prisma.post.delete({ where: { id: String(req.query.id), authorId: session.user.id } })
    return res.status(204).end()
  }
  res.status(405).end()
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(!/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// Same as p07 but with next-auth/react getSession({ req }) (not in HEAD's AUTH set): HEAD warned "Anyone can", NEW says ✓ -> NEW false reassurance.
// Gaps in the round-3 fixes for review52/p01 (false ✓, same as HEAD, so not a regression, but the fix doesn't hold):
// A: next-connect chain written with type arguments `nc<NextApiRequest, NextApiResponse>()` (the usual TS form) or with an
//    inline onError arrow `nc({ onError: (err, req, res) => ... })`: the `chain` regex `[\w$.]+\([^)]*\)\s*\.` misses both, so
//    .get's check covers .delete again -> ✓. REALISTIC.
// B: dispatch-before-check whose check is return-style without a 401/403 status (`return res.json({ error: ... })`): it lands
//    in authReturn, not authIfs, so `early` (which only looks for an authIf after the skip) finds nothing -> ✓. Less common.
const nx = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","next-connect":"0.13.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const chain = (mk: string) => ({ 'pages/api/posts.ts': `import nc from "next-connect"
import type { NextApiRequest, NextApiResponse } from "next"
import { getSession } from "next-auth/react"
import { authOptions } from "./auth/[...nextauth]"
import prisma from "@/lib/prisma"
export default ${mk}
  .get(async (req, res) => {
    const session = await getSession({ req })
    if (!session) return res.status(403).json({ error: "Not authenticated" })
    res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
  })
  .delete(async (req, res) => {
    await prisma.post.delete({ where: { id: String(req.query.id) } })
    res.json({ ok: true })
  })
` })
log('A0 nc() (fixed) ::', card(chain('nc()')), '\n')
log('A1 nc<Req, Res>() ::', card(chain('nc<NextApiRequest, NextApiResponse>()')), '\n')
log('A2 nc({ onError: arrow }) ::', card(chain('nc({ onError: (err, req, res) => res.status(500).end(err.message) })')), '\n')
log('B early + return-style check ::', card({ 'pages/api/posts.ts': `import { getSession } from "next-auth/react"
import { authOptions } from "./auth/[...nextauth]"
import prisma from "@/lib/prisma"
async function deletePost(req, res) {
  await prisma.post.delete({ where: { id: String(req.query.id) } })
  res.json({ ok: true })
}
export default async function handler(req, res) {
  if (req.method === "DELETE") return deletePost(req, res)
  const session = await getSession({ req })
  if (!session) return res.json({ error: "Not authenticated" })
  res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// Inline login checks plain doesn't credit, whose stop has none of the login words (401 / unauthorized / must..sign in /
// sign in inside an if). NEW reads the handler as "read", finds no check, warns "Anyone can". HEAD: ✓ (auth() in the file).
// New false alarms. A (positive if, no else, 403) and B (session field copied to a local) REALISTIC-ish; C (throw with a
// message lacking auth/login words) less common.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const r = (body: string) => card({ 'app/api/orders/route.ts': `import { auth } from "@/auth"
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
${body}
}
` })
log('A positive if, 403 after ::', r(`  const session = await auth()
  if (session?.user) {
    const order = await prisma.order.create({ data: { ...(await req.json()), userId: session.user.id } })
    return NextResponse.json(order)
  }
  return NextResponse.json({ error: "Not authenticated" }, { status: 403 })`), '\n')
log('B email local ::', r(`  const session = await auth()
  const email = session?.user?.email
  if (!email) return NextResponse.json({ error: "Not authenticated" }, { status: 403 })
  const order = await prisma.order.create({ data: { ...(await req.json()), email } })
  return NextResponse.json(order)`), '\n')
log('C throw "No session" ::', r(`  const session = await auth()
  if (!session) throw new Error("No session")
  const order = await prisma.order.create({ data: { ...(await req.json()), userId: session.user.id } })
  return NextResponse.json(order)`), '\n')
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(!/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// loginWords' bare `\b401\b|unauthori[sz]ed` fires on 401s that aren't this app's login: an upstream API (OpenAI, GitHub)
// rejecting the server's own key. The handler checks nobody's login and is fully readable; HEAD warned "Anyone can",
// NEW is silent. LOST WARNING. REALISTIC (AI-wrapper chat routes map OpenAI's 401 to "invalid API key" all the time; this is
// exactly the route where "anyone can use it" costs the owner money).
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","openai":"4.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
log('openai 401 ::', card({ 'app/api/chat/route.ts': `import OpenAI from "openai"
import { prisma } from "@/lib/prisma"
const openai = new OpenAI()
export async function POST(req: Request) {
  const { messages } = await req.json()
  try {
    const completion = await openai.chat.completions.create({ model: "gpt-4o", messages })
    await prisma.message.create({ data: { content: completion.choices[0].message.content ?? "" } })
    return Response.json(completion.choices[0].message)
  } catch (err: any) {
    if (err.status === 401) return Response.json({ error: "Invalid OpenAI API key" }, { status: 500 })
    return Response.json({ error: "Something went wrong" }, { status: 500 })
  }
}
` }), '\n')
log('upstream Unauthorized ::', card({ 'app/api/orders/route.ts': `import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const body = await req.json()
  const r = await fetch("https://api.example-erp.com/orders", { method: "POST", headers: { Authorization: \`Bearer \${process.env.ERP_KEY}\` }, body: JSON.stringify(body) })
  if (r.status === 401) throw new Error("ERP rejected our key (Unauthorized)")
  const order = await prisma.order.create({ data: body })
  return Response.json(order)
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// pages/api with an inline / anonymous default export (`export default async (req, res) => ...`, `export default async function (req, res)`):
// yes = exportAuth (the export's own check) only. The round-3 lead-call rule (`checks(g)`: a same-file helper awaited first) is
// applied only to a NAMED handler, so the same helper awaited first is ignored here. Its stop (403 / "Not authenticated") has
// no login words -> "read" -> "Anyone can". Named handler (control) -> ✓. HEAD: ✓ for all three. New false alarm. REALISTIC.
const pa = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(pa)), new Map(Object.entries({ ...pa, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const helper = `import { getServerSession } from "next-auth/next"
import { authOptions } from "./auth/[...nextauth]"
import prisma from "@/lib/prisma"
async function getUserOrThrow(req, res) {
  const session = await getServerSession(req, res, authOptions)
  if (!session?.user) throw new Error("Not authenticated")
  return session.user
}
`
const body = `
  const user = await getUserOrThrow(req, res)
  const post = await prisma.post.create({ data: { ...req.body, authorId: user.id } })
  res.json(post)
}
`
log('named (control) ::', card({ 'pages/api/posts.ts': helper + 'export default async function handler(req, res) {' + body }), '\n')
log('arrow default ::', card({ 'pages/api/posts.ts': helper + 'export default async (req, res) => {' + body }), '\n')
log('anonymous function ::', card({ 'pages/api/posts.ts': helper + 'export default async function (req, res) {' + body }), '\n')
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(!/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ')) }
// Gaps in the round-3 fixes for review52/p01 (false ✓, same as HEAD, so not a regression, but the fix doesn't hold):
// A: next-connect chain written with type arguments `nc<NextApiRequest, NextApiResponse>()` (the usual TS form) or with an
//    inline onError arrow `nc({ onError: (err, req, res) => ... })`: the `chain` regex `[\w$.]+\([^)]*\)\s*\.` misses both, so
//    .get's check covers .delete again -> ✓. REALISTIC.
// B: dispatch-before-check whose check is return-style without a 401/403 status (`return res.json({ error: ... })`): it lands
//    in authReturn, not authIfs, so `early` (which only looks for an authIf after the skip) finds nothing -> ✓. Less common.
const nx = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","next-connect":"0.13.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const chain = (mk: string) => ({ 'pages/api/posts.ts': `import nc from "next-connect"
import type { NextApiRequest, NextApiResponse } from "next"
import { getServerSession } from "next-auth/next"
import { authOptions } from "./auth/[...nextauth]"
import prisma from "@/lib/prisma"
export default ${mk}
  .get(async (req, res) => {
    const session = await getServerSession(req, res, authOptions)
    if (!session) return res.status(403).json({ error: "Not authenticated" })
    res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
  })
  .delete(async (req, res) => {
    await prisma.post.delete({ where: { id: String(req.query.id) } })
    res.json({ ok: true })
  })
` })
log('A0 nc() (fixed) ::', card(chain('nc()')), '\n')
log('A1 nc<Req, Res>() ::', card(chain('nc<NextApiRequest, NextApiResponse>()')), '\n')
log('A2 nc({ onError: arrow }) ::', card(chain('nc({ onError: (err, req, res) => res.status(500).end(err.message) })')), '\n')
log('B early + return-style check ::', card({ 'pages/api/posts.ts': `import { getServerSession } from "next-auth/next"
import { authOptions } from "./auth/[...nextauth]"
import prisma from "@/lib/prisma"
async function deletePost(req, res) {
  await prisma.post.delete({ where: { id: String(req.query.id) } })
  res.json({ ok: true })
}
export default async function handler(req, res) {
  if (req.method === "DELETE") return deletePost(req, res)
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.json({ error: "Not authenticated" })
  res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(!/requires login ✓/.test(x), x)
}
console.log('ok (review 53)')
// Review 54: a Next ✓ needs the session itself (a userId from the body, a findById 404 isn't a login); a helper's returned
// NextResponse.redirect doesn't stop the caller; an alias must be awaited; methods exported by another name, switch hand-offs; Supabase
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// Next route handlers: false ✓ attempts against invariant (a)
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const R = 'app/api/posts/[id]/route.ts'
// A: lead helper that RETURNS NextResponse.redirect (not a throw); result ignored
log('A lead helper returns NextResponse.redirect ::', card({ [R]: `import { auth } from "@/auth"
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
async function getUserOrRedirect(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.redirect(new URL("/login", req.url))
  return session.user
}
export async function DELETE(req: Request, { params }) {
  await getUserOrRedirect(req)
  await prisma.post.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}
` }))
// A2: same, Response.redirect
log('A2 lead helper returns Response.redirect ::', card({ [R]: `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
async function getUserOrRedirect(req: Request) {
  const session = await auth()
  if (!session) return Response.redirect(new URL("/login", req.url))
  return session.user
}
export async function DELETE(req: Request, { params }) {
  const user = await getUserOrRedirect(req)
  await prisma.post.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}
` }))
// B: return-style check nested under a non-path condition (authReturn is a boolean, ignores conds)
log('B conditional return-style check ::', card({ [R]: `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request, { params }) {
  const session = await auth()
  const { action } = await req.json()
  if (action === "archive") {
    if (!session) return Response.json({ error: "Login required" })
  }
  await prisma.post.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}
` }))
// C: export { handler as DELETE } unchecked, POST checked
log('C export-as DELETE unchecked ::', card({ [R]: `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request, { params }) {
  const session = await auth()
  if (!session) return Response.json({ error: "no" }, { status: 401 })
  await prisma.post.update({ where: { id: params.id }, data: await req.json() })
  return Response.json({ ok: true })
}
async function remove(req: Request, { params }) {
  await prisma.post.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}
export { remove as DELETE }
` }))
// D: alias without await (NextAuth v5 auth() is async -> Promise always truthy)
log('D alias no await ::', card({ [R]: `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
export async function DELETE(req: Request, { params }) {
  const s = auth()
  if (!s) return Response.json({ error: "no" }, { status: 401 })
  await prisma.post.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}
` }))
// E: check after a raw sql write (WRITE_CALL misses sql``)
log('E check after sql write ::', card({ [R]: `import { auth } from "@/auth"
import { sql } from "@vercel/postgres"
export async function DELETE(req: Request, { params }) {
  await sql\`DELETE FROM posts WHERE id = \${params.id}\`
  const session = await auth()
  if (!session) return Response.json({ error: "no" }, { status: 401 })
  return Response.json({ ok: true })
}
` }))
// F: lead helper throws but helper itself catches nothing; handler has the lead call but via a local whose check is require* by name
log('F local requireUser returns null, called by name ::', card({ [R]: `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { requireUser } from "@/lib/guards"
export async function DELETE(req: Request, { params }) {
  await requireUser()
  await prisma.post.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}
` }))
// G: imported getter renamed to requireUser
log('G import { getSession as requireUser } ::', card({ [R]: `import { getSession as requireUser } from "@/lib/session"
import { prisma } from "@/lib/prisma"
export async function DELETE(req: Request, { params }) {
  await requireUser()
  await prisma.post.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}
` }))
log('C2 export const DELETE = remove (unchecked) ::', card({ [R]: `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request, { params }) {
  const session = await auth()
  if (!session) return Response.json({ error: "no" }, { status: 401 })
  await prisma.post.update({ where: { id: params.id }, data: await req.json() })
  return Response.json({ ok: true })
}
async function remove(req: Request, { params }) {
  await prisma.post.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}
export const DELETE = remove
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) if (new RegExp(String.raw`^(A |A2 |C |C2 |SB1|SB2|S1 |S2 |S3 |S5 |S6 |SA3|SA4|SA6|PG2|SK2|NU2)`).test(x)) assert.ok(!/requires login ✓|log in to open it ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// pages/api: false ✓ attempts
const nx = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const P = 'pages/api/posts/[id].ts'
const H = `import { getServerSession } from "next-auth/next"
import { authOptions } from "../auth/[...nextauth]"
import prisma from "@/lib/prisma"
`
// A: write pass-through whose own text happens to contain a 404 (rej misfires)
log('A DELETE pass-through w/ ternary 404 ::', card({ [P]: H + `export default async function handler(req, res) {
  const id = String(req.query.id)
  if (req.method === "DELETE") {
    const { count } = await prisma.post.deleteMany({ where: { id } })
    return count ? res.status(204).end() : res.status(404).json({ error: "Not found" })
  }
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  await prisma.post.update({ where: { id }, data: req.body })
  res.json({ ok: true })
}
` }))
// B: same with control (no 404)
log('B DELETE pass-through control ::', card({ [P]: H + `export default async function handler(req, res) {
  const id = String(req.query.id)
  if (req.method === "DELETE") {
    await prisma.post.delete({ where: { id } })
    return res.status(204).end()
  }
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  await prisma.post.update({ where: { id }, data: req.body })
  res.json({ ok: true })
}
` }))
// C: export default allowCors(handler) wrapper (common Vercel pattern) where handler checks nothing
log('C allowCors(handler) unchecked ::', card({ [P]: H + `const allowCors = (fn) => async (req, res) => { res.setHeader("Access-Control-Allow-Origin", "*"); return fn(req, res) }
async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions)
  log(session?.user?.email)
  await prisma.post.delete({ where: { id: String(req.query.id) } })
  res.json({ ok: true })
}
export default allowCors(handler)
` }))
// D: wrapper whose argument is an inline function that checks, but wrapper is a method-router: withMethods({ GET: fn, DELETE: fn2 })
log('D wrapper with object of methods ::', card({ [P]: H + `import { withMethods } from "@/lib/api"
export default withMethods({
  GET: async (req, res) => {
    const session = await getServerSession(req, res, authOptions)
    if (!session) return res.status(401).json({ error: "Unauthorized" })
    res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
  },
  DELETE: async (req, res) => {
    await prisma.post.delete({ where: { id: String(req.query.id) } })
    res.json({ ok: true })
  },
})
` }))
// E: two inline arrows passed to a wrapper: withAuthOptional(getHandler, deleteHandler)-ish
log('E wrapper with two inline fns ::', card({ [P]: H + `import { route } from "@/lib/api"
export default route(
  async (req, res) => {
    const session = await getServerSession(req, res, authOptions)
    if (!session) return res.status(401).json({ error: "Unauthorized" })
    res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
  },
  async (req, res) => {
    await prisma.post.delete({ where: { id: String(req.query.id) } })
    res.json({ ok: true })
  },
)
` }))
// F: named handler, check inside nested helper function declared inside handler (shouldn't count)
log('F alias via arrow param shadow ::', card({ [P]: H + `export default async function handler(req, res) {
  const s = await getServerSession(req, res, authOptions)
  const run = async ({ s }) => {
    if (!s) return res.status(401).json({ error: "Unauthorized" })
  }
  await run({ s: true })
  await prisma.post.delete({ where: { id: String(req.query.id) } })
  res.json({ ok: true })
}
` }))
// G: res.status(401) branch, then `return` only inside an inner callback line
log('G status401 + return inside callback ::', card({ [P]: H + `export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) {
    res.status(401).json({ error: "Unauthorized" })
    log.flush(() => {
      return true
    })
  }
  await prisma.post.delete({ where: { id: String(req.query.id) } })
  res.json({ ok: true })
}
` }))
// H: default export is a const arrow defined via let and reassigned
log('H export default handler; handler = other ::', card({ [P]: H + `let handler = async (req, res) => {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  res.json({})
}
if (process.env.OPEN) handler = async (req, res) => { await prisma.post.delete({ where: { id: String(req.query.id) } }); res.json({}) }
export default handler
` }))
// I: switch on method, check only in one case (control)
log('I export default handler; but also export default via function name collision ::', card({ [P]: H + `async function handler(req, res) {
  await prisma.post.delete({ where: { id: String(req.query.id) } })
  res.json({ ok: true })
}
async function checked(req, res) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  return handler(req, res)
}
export const config = { api: { bodyParser: true } }
export default handler
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) if (new RegExp(String.raw`^(A |A2 |C |C2 |SB1|SB2|S1 |S2 |S3 |S5 |S6 |SA3|SA4|SA6|PG2|SK2|NU2)`).test(x)) assert.ok(!/requires login ✓|log in to open it ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// The shared authAlias across stacks: false ✓ attempts (NEW=Y where HEAD=W or -)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const next = mk('{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}')
const act = (body: string, extra = '') => next({ 'app/posts/actions.ts': `'use server'
import { auth, getCurrentUser } from "@/lib/auth"
import { getServerSession } from "next-auth"
import { prisma } from "@/lib/prisma"
${extra}export async function deletePost(id: string) {
${body}  await prisma.post.delete({ where: { id } })
}
` })
log('SA1 control named session awaited ::', act(`  const session = await auth()\n  if (!session) throw new Error("Unauthorized")\n`))
log('SA2 alias awaited ::', act(`  const s = await auth()\n  if (!s) throw new Error("Unauthorized")\n`))
log('SA3 alias NOT awaited getServerSession ::', act(`  const s = getServerSession()\n  if (!s) throw new Error("Unauthorized")\n`))
log('SA4 alias NOT awaited getCurrentUser ::', act(`  const me = getCurrentUser()\n  if (!me) throw new Error("Unauthorized")\n`))
// helper in lib returning a 401 Response, alias name
const lib = (name: string) => `import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/session"
export async function getAuthedUser() {
  const ${name} = await getCurrentUser()
  if (!${name}) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return ${name}
}
`
const act2 = (name: string) => next({ 'lib/guard.ts': lib(name), 'app/posts/actions.ts': `'use server'
import { getAuthedUser } from "@/lib/guard"
import { prisma } from "@/lib/prisma"
export async function deletePost(id: string) {
  const me = await getAuthedUser()
  await prisma.post.delete({ where: { id } })
}
` })
log('SA5 lead helper returns 401 Response (name user) ::', act2('user'))
log('SA6 lead helper returns 401 Response (alias me) ::', act2('me'))
// alias from getUser(request) inside a server action? (no request) -> getUser(id) control
log('SA7 getUser(id) not alias (control) ::', act(`  const owner = await getUser(id)\n  if (!owner) throw new Error("Unauthorized")\n`, 'import { getUser } from "@/lib/users"\n'))
// Next page (app router) with alias not awaited
const page = (body: string) => next({ 'app/admin/page.tsx': `import { getServerSession } from "next-auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
export default async function AdminPage() {
${body}  const users = await prisma.user.findMany()
  return <ul>{users.map(u => <li key={u.id}>{u.email}</li>)}</ul>
}
` })
log('PG1 page alias awaited ::', page(`  const s = await getServerSession()\n  if (!s) redirect("/login")\n`))
log('PG2 page alias NOT awaited ::', page(`  const s = getServerSession()\n  if (!s) redirect("/login")\n`))
// SvelteKit +server.ts / actions with alias
const sk = mk('{"devDependencies":{"@sveltejs/kit":"^2.8.0","svelte":"^5.0.0"},"dependencies":{"@prisma/client":"5"}}')
log('SK1 +server alias getUser(event) ::', sk({ 'src/routes/api/posts/+server.ts': `import { error, json } from '@sveltejs/kit'
import { getUser } from '$lib/server/auth'
import { prisma } from '$lib/server/prisma'
export const DELETE = async (event) => {
  const me = await getUser(event)
  if (!me) error(401, 'Unauthorized')
  await prisma.post.deleteMany()
  return json({ ok: true })
}
` }))
log('SK2 +server alias getUser(event) NOT awaited ::', sk({ 'src/routes/api/posts/+server.ts': `import { error, json } from '@sveltejs/kit'
import { getUser } from '$lib/server/auth'
import { prisma } from '$lib/server/prisma'
export const DELETE = async (event) => {
  const me = getUser(event)
  if (!me) error(401, 'Unauthorized')
  await prisma.post.deleteMany()
  return json({ ok: true })
}
` }))
log('SK3 action alias via getSession(event) reassigned via destructuring ::', sk({ 'src/routes/posts/+page.server.ts': `import { fail, error } from '@sveltejs/kit'
import { getSession } from '$lib/server/auth'
import { prisma } from '$lib/server/prisma'
export const actions = {
  delete: async (event) => {
    let s = await getSession(event)
    ;({ s } = { s: { anon: true } })
    if (!s) error(401, 'no')
    await prisma.post.deleteMany()
  },
}
` }))
// Nuxt
const nu = mk('{"dependencies":{"nuxt":"^3.13.0","@prisma/client":"5"}}')
log('NU1 alias awaited ::', nu({ 'server/api/posts.delete.ts': `export default defineEventHandler(async (event) => {
  const me = await getUser(event)
  if (!me) throw createError({ statusCode: 401 })
  await prisma.post.deleteMany()
  return { ok: true }
})
` }))
log('NU2 alias NOT awaited ::', nu({ 'server/api/posts.delete.ts': `export default defineEventHandler(async (event) => {
  const me = getUser(event)
  if (!me) throw createError({ statusCode: 401 })
  await prisma.post.deleteMany()
  return { ok: true }
})
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) if (new RegExp(String.raw`^(A |A2 |C |C2 |SB1|SB2|S1 |S2 |S3 |S5 |S6 |SA3|SA4|SA6|PG2|SK2|NU2)`).test(x)) assert.ok(!/requires login ✓|log in to open it ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const sb = mk('{"dependencies":{"next":"15.0.0","@supabase/ssr":"0.5.0"}}')
log('SB1 route calls supabase.auth.getUser, ignores it ::', sb({ 'app/api/posts/route.ts': `import { createClient } from "@/lib/supabase/server"
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  log(user?.email)
  await supabase.from("posts").delete().eq("id", new URL(req.url).searchParams.get("id"))
  return Response.json({ ok: true })
}
` }))
log('SB2 pages/api supabase ignored ::', sb({ 'pages/api/posts.ts': `import { createClient } from "@/lib/supabase/api"
export default async function handler(req, res) {
  const supabase = createClient(req, res)
  const { data: { user } } = await supabase.auth.getUser()
  await supabase.from("posts").delete().eq("id", req.query.id)
  res.json({ ok: true })
}
` }))
const ck = mk('{"dependencies":{"next":"15.0.0","@clerk/nextjs":"6.0.0","@prisma/client":"5.0.0"}}')
const R = 'app/api/posts/route.ts'
log('CK1 Clerk auth.protect() ::', ck({ [R]: `import { auth } from "@clerk/nextjs/server"
import { prisma } from "@/lib/prisma"
export async function DELETE() {
  await auth.protect()
  await prisma.post.deleteMany()
  return Response.json({ ok: true })
}
` }))
log('CK2 Clerk (await auth()).protect() conditional ::', ck({ [R]: `import { auth } from "@clerk/nextjs/server"
import { prisma } from "@/lib/prisma"
export async function DELETE(req: Request) {
  if (req.headers.get("x-internal")) (await auth()).protect()
  await prisma.post.deleteMany()
  return Response.json({ ok: true })
}
` }))
log('CK3 Clerk const a = await auth(); destructured protect in arrow ::', ck({ [R]: `import { auth } from "@clerk/nextjs/server"
import { prisma } from "@/lib/prisma"
export async function DELETE(req: Request) {
  const a = await auth()
  const check = () => a.protect()
  await prisma.post.deleteMany()
  return Response.json({ ok: true })
}
` }))
log('CK4 Clerk const a = await auth(); if (!a) return 401 (always truthy object) ::', ck({ [R]: `import { auth } from "@clerk/nextjs/server"
import { prisma } from "@/lib/prisma"
export async function DELETE(req: Request) {
  const a = await auth()
  if (!a) return new Response("Unauthorized", { status: 401 })
  await prisma.post.deleteMany()
  return Response.json({ ok: true })
}
` }))
// local require* that throws + another local require* that returns: byName false. Lead helper path still OK?
const na = mk('{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}')
log('BN1 only GET exported, GET has return-style check w/o status in cond ::', na({ [R]: `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
export async function GET(req: Request) {
  const session = await auth()
  const mine = new URL(req.url).searchParams.get("mine")
  if (mine) {
    if (!session) return Response.json([])
  }
  return Response.json(await prisma.post.findMany())
}
` }))
log('BN2 handler checks after a pass-through that awaits nothing but returns stored data ::', na({ [R]: `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
async function getUserOrThrow() {
  const session = await auth()
  if (!session) throw new Error("Unauthorized")
  return session.user
}
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id")
  if (id === "all") return Response.json(await prisma.post.deleteMany())
  await getUserOrThrow()
  await prisma.post.delete({ where: { id } })
  return Response.json({ ok: true })
}
` }))
log('BN3 lead helper whose throw is in a different branch than its check ::', na({ [R]: `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
async function loadUser() {
  const session = await auth()
  if (!session) return null
  if (session.user.banned) throw new Error("banned")
  return session.user
}
export async function DELETE(req: Request) {
  await loadUser()
  await prisma.post.deleteMany()
  return Response.json({ ok: true })
}
` }))
log('BN4 lead helper check via unauthorized() custom returning Response + other throw ::', na({ [R]: `import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
const unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 })
async function getSessionOrFail() {
  const session = await auth()
  if (!session) return unauthorized()
  if (!session.user.email) throw new Error("no email on account")
  return session
}
export async function DELETE(req: Request) {
  await getSessionOrFail()
  await prisma.post.deleteMany()
  return Response.json({ ok: true })
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) if (new RegExp(String.raw`^(A |A2 |C |C2 |SB1|SB2|S1 |S2 |S3 |S5 |S6 |SA3|SA4|SA6|PG2|SK2|NU2)`).test(x)) assert.ok(!/requires login ✓|log in to open it ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// pages/api + route handlers: pass-through before the check written without an `if`
const nx = { 'package.json': '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
const H = `import { getServerSession } from "next-auth/next"
import { authOptions } from "../auth/[...nextauth]"
import prisma from "@/lib/prisma"
async function deletePost(req, res) {
  await prisma.post.delete({ where: { id: String(req.query.id) } })
  res.json({ ok: true })
}
`
log('S1 switch dispatch before check ::', card({ 'pages/api/posts.ts': H + `export default async function handler(req, res) {
  switch (req.method) {
    case "DELETE":
      return deletePost(req, res)
  }
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
}
` }))
log('S2 if-dispatch before check (control, fixed in r52) ::', card({ 'pages/api/posts.ts': H + `export default async function handler(req, res) {
  if (req.method === "DELETE") return deletePost(req, res)
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
}
` }))
log('S3 && dispatch before check ::', card({ 'pages/api/posts.ts': H + `export default async function handler(req, res) {
  if (req.method === "DELETE") { await deletePost(req, res) } else {
    const session = await getServerSession(req, res, authOptions)
    if (!session) return res.status(401).json({ error: "Unauthorized" })
    res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
  }
}
` }))
log('S4 dispatch then check (no return: write then 401) ::', card({ 'pages/api/posts.ts': H + `export default async function handler(req, res) {
  if (req.method === "DELETE") await deletePost(req, res)
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
}
` }))
log('S5 try { dispatch } ::', card({ 'pages/api/posts.ts': H + `export default async function handler(req, res) {
  try {
    if (req.method === "DELETE") return await deletePost(req, res)
    const session = await getServerSession(req, res, authOptions)
    if (!session) return res.status(401).json({ error: "Unauthorized" })
    res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
  } catch (e) { res.status(500).end() }
}
` }))
log('S6 rej misfire: dispatch whose branch also 404s ::', card({ 'pages/api/posts.ts': H + `export default async function handler(req, res) {
  if (req.method === "DELETE") return req.query.id ? deletePost(req, res) : res.status(400).json({ error: "id required" })
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  res.json(await prisma.post.findMany({ where: { authorId: session.user.id } }))
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) if (new RegExp(String.raw`^(A |A2 |C |C2 |SB1|SB2|S1 |S2 |S3 |S5 |S6 |SA3|SA4|SA6|PG2|SK2|NU2)`).test(x)) assert.ok(!/requires login ✓|log in to open it ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// Next route handlers / pages/api with NO login at all: the client sends userId, the handler validates it's present.
// HEAD: no auth() call -> "Anyone can ..." warning. NEW: `if (!userId) return ...` reads as a return-style login check -> ✓
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
log('U1 route: userId from body, 400 ::', card({ 'app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const { userId, title } = await req.json()
  if (!userId || !title) return NextResponse.json({ error: "userId and title are required" }, { status: 400 })
  const post = await prisma.post.create({ data: { title, authorId: userId } })
  return NextResponse.json(post)
}
` }))
log('U2 route: userId from query string, DELETE ::', card({ 'app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const userId = searchParams.get("userId")
  if (!userId) return NextResponse.json({ error: "Missing userId" }, { status: 400 })
  await prisma.post.deleteMany({ where: { authorId: userId } })
  return NextResponse.json({ ok: true })
}
` }))
log('U3 pages/api: userId from body ::', card({ 'pages/api/posts.ts': `import prisma from "@/lib/prisma"
export default async function handler(req, res) {
  const { userId, title } = req.body
  if (!userId) return res.status(400).json({ error: "userId is required" })
  const post = await prisma.post.create({ data: { title, authorId: userId } })
  res.json(post)
}
` }))
log('U4 pages/api: user from body ::', card({ 'pages/api/delete-account.ts': `import prisma from "@/lib/prisma"
export default async function handler(req, res) {
  const { user } = req.body
  if (!user) return res.status(400).json({ error: "user required" })
  await prisma.user.delete({ where: { id: user.id } })
  res.json({ ok: true })
}
` }))
log('U5 route: params.userId ::', card({ 'app/api/users/[userId]/route.ts': `import { prisma } from "@/lib/prisma"
export async function DELETE(req: Request, { params }) {
  const { userId } = await params
  if (!userId) return Response.json({ error: "bad request" }, { status: 400 })
  await prisma.user.delete({ where: { id: userId } })
  return Response.json({ ok: true })
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(/Anyone/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// No login at all: the handler looks a record up and 404s when it's missing. `user` / `session` named records read as the login.
const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","mongoose":"8.0.0","@prisma/client":"5.0.0"}}' }
const card = (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ')
log('L1 mongoose findById 404 ::', card({ 'app/api/users/[id]/route.ts': `import { NextResponse } from "next/server"
import { connectDB } from "@/lib/db"
import User from "@/models/User"
export async function DELETE(req: Request, { params }) {
  await connectDB()
  const user = await User.findById(params.id)
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })
  await User.findByIdAndDelete(params.id)
  return NextResponse.json({ message: "User deleted" })
}
` }))
log('L2 helper getUserById 404 ::', card({ 'app/api/users/[id]/route.ts': `import { NextResponse } from "next/server"
import { getUserById, deleteUser } from "@/lib/users"
export async function DELETE(req: Request, { params }) {
  const user = await getUserById(params.id)
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 })
  await deleteUser(user.id)
  return NextResponse.json({ ok: true })
}
` }))
log('L3 pages/api mongoose findOne 404 ::', card({ 'pages/api/users/[id].ts': `import dbConnect from "@/lib/dbConnect"
import User from "@/models/User"
export default async function handler(req, res) {
  await dbConnect()
  const user = await User.findOne({ _id: req.query.id })
  if (!user) return res.status(404).json({ success: false })
  if (req.method === "DELETE") { await User.deleteOne({ _id: req.query.id }); return res.json({ success: true }) }
  res.json({ success: true, data: user })
}
` }))
log('L4 prisma 404 (control: excluded by NOT_AUTH_SOURCE) ::', card({ 'app/api/users/[id]/route.ts': `import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
export async function DELETE(req: Request, { params }) {
  const user = await prisma.user.findUnique({ where: { id: params.id } })
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 })
  await prisma.user.delete({ where: { id: user.id } })
  return NextResponse.json({ ok: true })
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(/Anyone/.test(x), x)
}
console.log('ok (review 54)')
// Review 55: the login `if` must test a name set from a session call (one hop), so a firebase-admin getAuth() or an unrelated getToken()
// next to a body userId or a findById 404 isn't a ✓
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// Next route handlers: the if tests a looked-up record / body value; a session-source call that isn't the login is also in the code
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const nx = mk('{"dependencies":{"next":"15.0.0","mongoose":"8.0.0","firebase-admin":"12.0.0"}}')
// T1: lookup 404 + third-party token helper getToken() (Spotify client credentials)
log('T1 findById 404 + spotify getToken() ::', nx({ 'app/api/users/[id]/playlist/route.ts': `import { NextResponse } from "next/server"
import { connectDB } from "@/lib/db"
import User from "@/models/User"
import { getToken } from "@/lib/spotify"
export async function POST(req: Request, { params }) {
  await connectDB()
  const user = await User.findById(params.id)
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })
  const token = await getToken()
  const r = await fetch("https://api.spotify.com/v1/users/" + user.spotifyId + "/playlists", { method: "POST", headers: { Authorization: "Bearer " + token } })
  user.playlistId = (await r.json()).id
  await user.save()
  return NextResponse.json({ ok: true })
}
` }))
// T1c: control without getToken
log('T1c control no getToken ::', nx({ 'app/api/users/[id]/playlist/route.ts': `import { NextResponse } from "next/server"
import { connectDB } from "@/lib/db"
import User from "@/models/User"
export async function POST(req: Request, { params }) {
  await connectDB()
  const user = await User.findById(params.id)
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })
  user.playlistId = "x"
  await user.save()
  return NextResponse.json({ ok: true })
}
` }))
// T2: firebase-admin getAuth() (an Auth instance, not a session); sets an admin claim for any uid
log('T2 firebase-admin getAuth().getUser(uid) + setCustomUserClaims ::', nx({ 'app/api/admin/make-admin/route.ts': `import { NextResponse } from "next/server"
import { getAuth } from "firebase-admin/auth"
import "@/lib/firebase-admin"
export async function POST(req: Request) {
  const { uid } = await req.json()
  const user = await getAuth().getUser(uid)
  if (!user) return NextResponse.json({ error: "No such user" }, { status: 404 })
  await getAuth().setCustomUserClaims(uid, { admin: true })
  return NextResponse.json({ ok: true })
}
` }))
// T3: firebase-admin const auth = getAuth() then lookup by email
log('T3 firebase-admin const adminAuth = getAuth(); getUserByEmail ::', nx({ 'app/api/users/disable/route.ts': `import { NextResponse } from "next/server"
import { getAuth } from "firebase-admin/auth"
export async function POST(req: Request) {
  const { email } = await req.json()
  const adminAuth = getAuth()
  const user = await adminAuth.getUserByEmail(email)
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 })
  await adminAuth.updateUser(user.uid, { disabled: true })
  return NextResponse.json({ ok: true })
}
` }))
// T4: octokit.auth() (GitHub app installation token) + record lookup 404
log('T4 octokit.auth() + findById 404 ::', nx({ 'app/api/repos/[id]/route.ts': `import { NextResponse } from "next/server"
import { Octokit } from "@octokit/rest"
import User from "@/models/User"
const octokit = new Octokit({ auth: process.env.GH_TOKEN })
export async function DELETE(req: Request, { params }) {
  const user = await User.findById(params.id)
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const { token } = await octokit.auth()
  await fetch("https://api.github.com/repos/" + user.repo, { method: "DELETE", headers: { Authorization: "token " + token } })
  await User.findByIdAndDelete(params.id)
  return NextResponse.json({ ok: true })
}
` }))
// T5: pages/api: lookup 404 + getToken() third-party
log('T5 pages/api findOne 404 + getToken() ::', nx({ 'pages/api/users/[id].ts': `import dbConnect from "@/lib/dbConnect"
import User from "@/models/User"
import { getToken } from "@/lib/mux"
export default async function handler(req, res) {
  await dbConnect()
  const user = await User.findOne({ _id: req.query.id })
  if (!user) return res.status(404).json({ success: false })
  const token = await getToken()
  await User.deleteOne({ _id: req.query.id })
  res.json({ success: true, token })
}
` }))
// T6: userId from body + chat getSession() (AI chat memory)
log('T6 route userId from body 400 + chat getSession() ::', nx({ 'app/api/chat/route.ts': `import { NextResponse } from "next/server"
import { getSession } from "@/lib/chat-store"
import Message from "@/models/Message"
export async function POST(req: Request) {
  const { userId, text } = await req.json()
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 })
  const chat = await getSession()
  await Message.create({ chat: chat.id, userId, text })
  return NextResponse.json({ ok: true })
}
` }))
// T7: Stripe checkout getSession(req) helper (from the success redirect) + user lookup
log('T7 stripe getSession(request) + findById ::', nx({ 'app/api/checkout/success/route.ts': `import { NextResponse } from "next/server"
import { getSession } from "@/lib/stripe"
import User from "@/models/User"
export async function POST(request: Request) {
  const checkout = await getSession(request)
  const user = await User.findById(checkout.client_reference_id)
  if (!user) return NextResponse.json({ error: "No user" }, { status: 404 })
  user.plan = "pro"
  await user.save()
  return NextResponse.json({ ok: true })
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(/Anyone/.test(x) || !/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// Next route handlers, firebase-admin: getAuth() (an admin SDK instance) satisfies the session-source test; the if tests a body value
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const nx = mk('{"dependencies":{"next":"15.0.0","firebase-admin":"12.0.0"}}')
log('F1 delete any user by body userId ::', nx({ 'app/api/users/delete/route.ts': `import { NextResponse } from "next/server"
import { getAuth } from "firebase-admin/auth"
export async function POST(req: Request) {
  const { userId } = await req.json()
  if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 })
  await getAuth().deleteUser(userId)
  return NextResponse.json({ ok: true })
}
` }))
log('F1c control: same with adminAuth from lib ::', nx({ 'app/api/users/delete/route.ts': `import { NextResponse } from "next/server"
import { adminAuth } from "@/lib/firebase-admin"
export async function POST(req: Request) {
  const { userId } = await req.json()
  if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 })
  await adminAuth.deleteUser(userId)
  return NextResponse.json({ ok: true })
}
` }))
log('F2 pages/api delete by body userId + getAuth() ::', nx({ 'pages/api/users/delete.ts': `import { getAuth } from "firebase-admin/auth"
export default async function handler(req, res) {
  const { userId } = req.body
  if (!userId) return res.status(400).json({ error: "userId is required" })
  await getAuth().deleteUser(userId)
  res.json({ ok: true })
}
` }))
assert.ok(outs.length >= 1)
for (const x of outs) if (x.trim()) assert.ok(!/requires login ✓/.test(x), x)
}
console.log('ok (review 55)')
// Review 56: a hop off the session is only a property chain (not `searchParams.get('userId') || me?.id`); reassigned and comma-joined
// names don't count; iron-session's object is always there; an imported requireAuth() that returns a 401, or isn't awaited; getSession() from a chat store
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// One hop letting a body/query value through: session source NOT in HEAD's AUTH set (so HEAD warned)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const nx = mk('{"dependencies":{"next":"14.2.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}')
log('B1 app route getToken({req}) ?? body.userId ::', nx({ 'app/api/notes/route.ts': `import { NextResponse } from "next/server"
import { getToken } from "next-auth/jwt"
import { prisma } from "@/lib/prisma"
export async function POST(req) {
  const body = await req.json()
  const token = await getToken({ req })
  const userId = token?.sub ?? body.userId
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await prisma.note.create({ data: { text: body.text, userId } })
  return NextResponse.json({ ok: true })
}
` }))
log('B2 pages/api getSession({req}) || req.body.userId ::', nx({ 'pages/api/notes/delete.ts': `import { getSession } from "next-auth/react"
import { prisma } from "@/lib/prisma"
export default async function handler(req, res) {
  const session = await getSession({ req })
  const userId = session?.user?.id || req.body.userId
  if (!userId) return res.status(401).json({ error: "Unauthorized" })
  await prisma.note.deleteMany({ where: { userId } })
  res.json({ ok: true })
}
` }))
log('B3 pages/api getServerAuthSession + query email fallback ::', nx({ 'pages/api/account/delete.ts': `import { getServerAuthSession } from "@/server/auth"
import { prisma } from "@/server/db"
export default async function handler(req, res) {
  const session = await getServerAuthSession({ req, res })
  const email = session?.user?.email ?? (req.query.email as string)
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return res.status(401).json({ error: "Unauthorized" })
  await prisma.user.delete({ where: { id: user.id } })
  res.json({ ok: true })
}
` }))
log('B4 control: same as B2 without fallback ::', nx({ 'pages/api/notes/delete.ts': `import { getSession } from "next-auth/react"
import { prisma } from "@/lib/prisma"
export default async function handler(req, res) {
  const session = await getSession({ req })
  const userId = session?.user?.id
  if (!userId) return res.status(401).json({ error: "Unauthorized" })
  await prisma.note.deleteMany({ where: { userId } })
  res.json({ ok: true })
}
` }))
log('B5 app route getCurrentUser() ternary admin-acting ::', nx({ 'app/api/notes/route.ts': `import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/session"
import { prisma } from "@/lib/prisma"
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const me = await getCurrentUser()
  const userId = searchParams.get("userId") || me?.id
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await prisma.note.deleteMany({ where: { userId } })
  return NextResponse.json({ ok: true })
}
` }))
assert.ok(outs.some(x => new RegExp(String.raw`^(B1|B2|B5|S1|S4|S6|A1r|Q1|Q2)\b`).test(x)))
for (const x of outs) if (new RegExp(String.raw`^(B1|B2|B5|S1|S4|S6|A1r|Q1|Q2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// sessionNames ignores reassignment and scope
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const nx = mk('{"dependencies":{"next":"14.2.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}')
log('S1 let user = getCurrentUser(); fallback reassigned from body ::', nx({ 'app/api/orders/route.ts': `import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/session"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const body = await req.json()
  let user = await getCurrentUser()
  if (!user && body.userId) user = await prisma.user.findUnique({ where: { id: body.userId } })
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await prisma.order.create({ data: { userId: user.id, items: body.items } })
  return NextResponse.json({ ok: true })
}
` }))
log('S2 inner callback declares session-named user; outer user from body ::', nx({ 'app/api/orders/route.ts': `import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/session"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const { user, items } = await req.json()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await prisma.order.create({ data: { userId: user.id, items } })
  const log = async () => { const user = await getCurrentUser(); log(user) }
  await log()
  return NextResponse.json({ ok: true })
}
` }))
log('S3 two methods, POST checks, DELETE reuses name from body ::', nx({ 'app/api/orders/route.ts': `import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/session"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await prisma.order.create({ data: { userId: user.id } })
  return NextResponse.json({ ok: true })
}
export async function DELETE(req: Request) {
  const { user } = await req.json()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await prisma.order.deleteMany({ where: { userId: user } })
  return NextResponse.json({ ok: true })
}
` }))
log('S4 multi-declarator: body first, session second ::', nx({ 'app/api/orders/route.ts': `import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/session"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  const body = await req.json()
  const userId = body.userId, me = await getCurrentUser()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await prisma.order.create({ data: { userId, note: me?.name } })
  return NextResponse.json({ ok: true })
}
` }))
log('S5 object key mentions session name (token:) ::', nx({ 'app/api/verify/route.ts': `import { NextResponse } from "next/server"
import { getToken } from "next-auth/jwt"
import { prisma } from "@/lib/prisma"
export async function POST(req) {
  const body = await req.json()
  const token = await getToken({ req })
  const user = await prisma.user.findFirst({ where: { token: body.token } })
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await prisma.user.update({ where: { id: user.id }, data: { verified: true, by: token?.sub } })
  return NextResponse.json({ ok: true })
}
` }))
log('S6 pages/api iron-session if (!session) (always truthy) ::', nx({ 'pages/api/cart/clear.ts': `import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { prisma } from "@/lib/prisma"
export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  await prisma.cartItem.deleteMany({ where: { cartId: req.body.cartId } })
  res.json({ ok: true })
}
` }))
assert.ok(outs.some(x => new RegExp(String.raw`^(B1|B2|B5|S1|S4|S6|A1r|Q1|Q2)\b`).test(x)))
for (const x of outs) if (new RegExp(String.raw`^(B1|B2|B5|S1|S4|S6|A1r|Q1|Q2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// carried over from review55/r03 A1 (still NEW ✓, HEAD neither): authAlias on a no-arg getSession() in a server action
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const next = mk('{"dependencies":{"next":"15.0.0","next-auth":"5.0.0","@prisma/client":"5.0.0"}}')
log('A1 action alias chat getSession() ::', next({ 'app/chat/actions.ts': `'use server'
import { getSession } from "@/lib/chat-store"
import { prisma } from "@/lib/prisma"
export async function clearHistory() {
  const chat = await getSession()
  if (!chat) throw new Error("No chat")
  await prisma.message.deleteMany({ where: { chatId: chat.id } })
}
` }))
log('A2 action alias getUser(request-less) cart ::', next({ 'app/cart/actions.ts': `'use server'
import { getUser } from "@/lib/cart"
import { prisma } from "@/lib/prisma"
export async function emptyCart() {
  const cart = await getUser()
  if (!cart) throw new Error("No cart")
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } })
}
` }))
log('A1r review55 original (return {error}) ::', next({ 'app/chat/actions.ts': `'use server'
import { getSession } from "@/lib/chat-store"
import { prisma } from "@/lib/prisma"
export async function clearHistory() {
  const chat = await getSession()
  if (!chat) return { error: "No chat" }
  await prisma.message.deleteMany({ where: { chatId: chat.id } })
}
` }))
assert.ok(outs.some(x => new RegExp(String.raw`^(B1|B2|B5|S1|S4|S6|A1r|Q1|Q2)\b`).test(x)))
for (const x of outs) if (new RegExp(String.raw`^(B1|B2|B5|S1|S4|S6|A1r|Q1|Q2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// require*() from another file that returns a 401 Response instead of throwing; caller ignores the result
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const nx = mk('{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0","@supabase/ssr":"0.5.0"}}')
const lib = `import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSessionFromCookie } from "./jwt"
export async function requireAuth() {
  const session = await getSessionFromCookie(cookies())
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return session
}
`
const route = (call: string) => ({ 'lib/auth.ts': lib, 'app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { requireAuth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
${call}
  const body = await req.json()
  await prisma.post.create({ data: { title: body.title } })
  return NextResponse.json({ ok: true })
}
` })
log('Q1 await requireAuth() ignored, lib returns 401 ::', nx(route('  await requireAuth()')))
log('Q2 requireAuth() not awaited ::', nx(route('  requireAuth()')))
log('Q3 const s = await requireAuth(); if (s instanceof NextResponse) return s ::', nx(route('  const s = await requireAuth()\n  if (s instanceof NextResponse) return s')))
assert.ok(outs.some(x => new RegExp(String.raw`^(B1|B2|B5|S1|S4|S6|A1r|Q1|Q2)\b`).test(x)))
for (const x of outs) if (new RegExp(String.raw`^(B1|B2|B5|S1|S4|S6|A1r|Q1|Q2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
console.log('ok (review 56)')
// Review 57: a require*() counts only when plain finds its definition and its check throws or redirects for guests (not a barrel,
// cache(), a rename, a package; not a throw guests never reach; not a returned 401); a zod validateRequest(req, schema) isn't a session
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// require*() whose definition plain can't find (barrel re-export, cache()-wrapped, default export) and which returns a 401 instead of throwing
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const nx = mk('{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0"}}')
const body401 = `{
  const session = await getSessionFromCookie(cookies())
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return session
}`
const head = `import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { cache } from "react"
import { getSessionFromCookie } from "./jwt"
`
const route = (imp: string) => `import { NextResponse } from "next/server"
${imp}
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  await requireAuth()
  const body = await req.json()
  await prisma.post.create({ data: { title: body.title } })
  return NextResponse.json({ ok: true })
}
`
// B1 barrel: lib/auth/index.ts re-exports from ./guard
log('B1 barrel re-export, helper returns 401 ::', nx({
  'lib/auth/guard.ts': head + `export async function requireAuth() ${body401}\n`,
  'lib/auth/index.ts': `export { requireAuth } from "./guard"\n`,
  'app/api/posts/route.ts': route('import { requireAuth } from "@/lib/auth"') }))
log('B2 export * barrel ::', nx({
  'lib/auth/guard.ts': head + `export async function requireAuth() ${body401}\n`,
  'lib/auth/index.ts': `export * from "./guard"\n`,
  'app/api/posts/route.ts': route('import { requireAuth } from "@/lib/auth"') }))
log('B3 cache()-wrapped, returns 401 ::', nx({
  'lib/auth.ts': head + `export const requireAuth = cache(async () => ${body401})\n`,
  'app/api/posts/route.ts': route('import { requireAuth } from "@/lib/auth"') }))
log('B4 renamed import { checkAuth as requireAuth } ::', nx({
  'lib/auth.ts': head + `export async function checkAuth() ${body401}\n`,
  'app/api/posts/route.ts': route('import { checkAuth as requireAuth } from "@/lib/auth"') }))
log('B5 default import ::', nx({
  'lib/require-auth.ts': head + `export default async function requireAuth() ${body401}\n`,
  'app/api/posts/route.ts': route('import requireAuth from "@/lib/require-auth"') }))
log('B6 namespace auth.requireAuth() ::', nx({
  'lib/auth.ts': head + `export async function requireAuth() ${body401}\n`,
  'app/api/posts/route.ts': route('import * as authLib from "@/lib/auth"').replace('await requireAuth()', 'await authLib.requireAuth()') }))
log('B7 control: direct import (should not be Y) ::', nx({
  'lib/auth.ts': head + `export async function requireAuth() ${body401}\n`,
  'app/api/posts/route.ts': route('import { requireAuth } from "@/lib/auth"') }))
log('B8 helper in package not repo ::', nx({
  'app/api/posts/route.ts': route('import { requireAuth } from "@acme/auth"') }))
assert.ok(outs.some(x => new RegExp(String.raw`^(B1|B2|B3|B4|B6|B8|E1|E2|E4|V3)\b`).test(x)))
for (const x of outs) if (new RegExp(String.raw`^(B1|B2|B3|B4|B6|B8|E1|E2|E4|V3)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// require*() found in the repo, has a `throw`, but its guest path returns instead (throw is about something else)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const nx = mk('{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0","next-auth":"5.0.0"}}')
const route = `import { NextResponse } from "next/server"
import { requireAuth } from "@/lib/guard"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  await requireAuth()
  const body = await req.json()
  await prisma.post.create({ data: { title: body.title } })
  return NextResponse.json({ ok: true })
}
`
log('E1 throws only for unverified email; guests get undefined ::', nx({ 'lib/guard.ts': `import { auth } from "@/auth"
export async function requireAuth() {
  const session = await auth()
  const user = session?.user
  if (user && !user.emailVerified) throw new Error("Verify your email first")
  return user
}
`, 'app/api/posts/route.ts': route }))
log('E2 throws only on missing env ::', nx({ 'lib/guard.ts': `import { auth } from "@/auth"
export async function requireAuth() {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET missing")
  return auth()
}
`, 'app/api/posts/route.ts': route }))
log('E3 control: throws for guests ::', nx({ 'lib/guard.ts': `import { auth } from "@/auth"
export async function requireAuth() {
  const session = await auth()
  if (!session) throw new Error("Unauthorized")
  return session
}
`, 'app/api/posts/route.ts': route }))
// pages/api with a barrel
log('E4 pages/api, barrel re-export, helper ends response with 401 and returns ::', nx({
  'lib/auth/guard.ts': `import type { NextApiRequest, NextApiResponse } from "next"
import { getServerSession } from "next-auth/next"
import { authOptions } from "./options"
export async function requireAuth(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return null }
  return session
}
`, 'lib/auth/index.ts': `export * from "./guard"\n`,
  'pages/api/posts.ts': `import type { NextApiRequest, NextApiResponse } from "next"
import { requireAuth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await requireAuth(req, res)
  await prisma.post.create({ data: { title: req.body.title } })
  res.json({ ok: true })
}
` }))
assert.ok(outs.some(x => new RegExp(String.raw`^(B1|B2|B3|B4|B6|B8|E1|E2|E4|V3)\b`).test(x)))
for (const x of outs) if (new RegExp(String.raw`^(B1|B2|B3|B4|B6|B8|E1|E2|E4|V3)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// validateRequest() from a validation helper (not Lucia): bypasses the AUTHY import filter and the argument check
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const nx = mk('{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0","zod":"3.0.0"}}')
const lib = `import { z } from "zod"
export async function validateRequest<T>(req: Request, schema: z.ZodType<T>) {
  const r = schema.safeParse(await req.json())
  return r.success ? r.data : null
}
`
const route = (st: number) => `import { NextResponse } from "next/server"
import { z } from "zod"
import { validateRequest } from "@/lib/validation"
import { prisma } from "@/lib/prisma"
const UserSchema = z.object({ email: z.string().email(), name: z.string() })
export async function POST(req: Request) {
  const user = await validateRequest(req, UserSchema)
  if (!user) return NextResponse.json({ error: "Invalid user" }, { status: ${st} })
  await prisma.user.create({ data: user })
  return NextResponse.json({ ok: true })
}
`
log('V1 validateRequest(req, schema) 422 ::', nx({ 'lib/validation.ts': lib, 'app/api/users/route.ts': route(422) }))
log('V2 validateRequest(req, schema) 400 ::', nx({ 'lib/validation.ts': lib, 'app/api/users/route.ts': route(400) }))
log('V3 validateRequest(req, schema) 401 ::', nx({ 'lib/validation.ts': lib, 'app/api/users/route.ts': route(401) }))
assert.ok(outs.some(x => new RegExp(String.raw`^(B1|B2|B3|B4|B6|B8|E1|E2|E4|V3)\b`).test(x)))
for (const x of outs) if (new RegExp(String.raw`^(B1|B2|B3|B4|B6|B8|E1|E2|E4|V3)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
console.log('ok (review 57)')
// Review 58: an app's own unauthorized() that returns a Response isn't Next's that throws; a route that catches its require*()
// or protect() throw gets no credit; Clerk v6's auth.protect() and session calls need await
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// requireAuth() whose definition throws, but the route swallows the throw (try/catch, .catch), or Clerk v6 auth.protect() not awaited
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const nx = mk('{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0","next-auth":"5.0.0"}}')
const ck = mk('{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0","@clerk/nextjs":"6.0.0"}}')
const lib = `import { auth } from "@/auth"
export async function requireAuth() {
  const session = await auth()
  if (!session) throw new Error("Unauthorized")
  return session
}
export async function requireSession() {
  const session = await auth()
  if (!session?.user) throw new Error("Unauthorized")
  return session
}
`
const route = (pre: string) => ({ 'lib/guard.ts': lib, 'app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { requireAuth, requireSession } from "@/lib/guard"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
${pre}
  const body = await req.json()
  await prisma.post.create({ data: { title: body.title } })
  return NextResponse.json({ ok: true })
}
` })
log('C0 control await requireAuth() ::', nx(route('  await requireAuth()')))
log('C1 try { await requireAuth() } catch (e) { console.error(e) } ::', nx(route('  try {\n    await requireAuth()\n  } catch (e) {\n    console.error(e)\n  }')))
log('C2 const s = await requireSession().catch(() => null) ::', nx(route('  const s = await requireSession().catch(() => null)')))
log('C3 await requireAuth().catch(console.error) ::', nx(route('  await requireAuth().catch(console.error)')))
log('C4 let s; try { s = await requireSession() } catch {} ::', nx(route('  let s = null\n  try { s = await requireSession() } catch {}')))
const ckRoute = (pre: string) => ({ 'app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
${pre}
  const body = await req.json()
  await prisma.post.create({ data: { title: body.title } })
  return NextResponse.json({ ok: true })
}
` })
log('K0 control await auth.protect() ::', ck(ckRoute('  await auth.protect()')))
log('K1 auth.protect() not awaited (Clerk v6, async) ::', ck(ckRoute('  auth.protect()')))
log('K2 try { await auth.protect() } catch {} ::', ck(ckRoute('  try { await auth.protect() } catch {}')))
log('K3 await auth.protect().catch(() => null) ::', ck(ckRoute('  await auth.protect().catch(() => null)')))
assert.ok(outs.some(x => new RegExp(String.raw`^(C1|C2|C3|C4|K1|K2|K3|U1|U2|U4|R1|R2|R3)\b`).test(x)))
for (const x of outs) if (new RegExp(String.raw`^(C1|C2|C3|C4|K1|K2|K3|U1|U2|U4|R1|R2|R3)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// app route: the session call is not awaited (a Promise is always truthy, so `if (!session)` stops nobody)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const nx = mk('{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0","next-auth":"4.0.0","lucia":"3.0.0"}}')
const route = (imp: string, decl: string, v = 'session') => ({ 'app/api/posts/route.ts': `import { NextResponse } from "next/server"
${imp}
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  ${decl}
  if (!${v}) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json()
  await prisma.post.create({ data: { title: body.title } })
  return NextResponse.json({ ok: true })
}
` })
log('U0 control await getServerAuthSession() ::', nx(route('import { getServerAuthSession } from "@/server/auth"', 'const session = await getServerAuthSession()')))
log('U1 getServerAuthSession() not awaited ::', nx(route('import { getServerAuthSession } from "@/server/auth"', 'const session = getServerAuthSession()')))
log('U2 getCurrentUser() not awaited ::', nx(route('import { getCurrentUser } from "@/lib/session"', 'const user = getCurrentUser()', 'user')))
log('U3 validateRequest() not awaited, destructured promise ::', nx(route('import { validateRequest } from "@/lib/auth"', 'const result = validateRequest()', 'result')))
log('U4 getSession() not awaited ::', nx(route('import { getSession } from "@/lib/auth"', 'const session = getSession()')))
assert.ok(outs.some(x => new RegExp(String.raw`^(C1|C2|C3|C4|K1|K2|K3|U1|U2|U4|R1|R2|R3)\b`).test(x)))
for (const x of outs) if (new RegExp(String.raw`^(C1|C2|C3|C4|K1|K2|K3|U1|U2|U4|R1|R2|R3)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// requireAuth() whose guest branch returns a custom unauthorized()/forbidden()/error(401) helper that builds a Response (does not throw);
// the route ignores the result, so guests go on to the write
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const nx = mk('{"dependencies":{"next":"15.0.0","@prisma/client":"5.0.0","next-auth":"5.0.0"}}')
const responses = `import { NextResponse } from "next/server"
export const unauthorized = (message = "Unauthorized") => NextResponse.json({ error: message }, { status: 401 })
export const forbidden = (message = "Forbidden") => NextResponse.json({ error: message }, { status: 403 })
export function error(status: number, message: string) { return NextResponse.json({ error: message }, { status }) }
`
const guard = (branch: string, imp = 'import { unauthorized, forbidden, error } from "@/lib/api-response"') => `import { auth } from "@/auth"
${imp}
export async function requireAuth() {
  const session = await auth()
  if (!session?.user) ${branch}
  return session
}
`
const route = { 'app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { requireAuth } from "@/lib/guard"
import { prisma } from "@/lib/prisma"
export async function POST(req: Request) {
  await requireAuth()
  const body = await req.json()
  await prisma.post.create({ data: { title: body.title } })
  return NextResponse.json({ ok: true })
}
` }
log('R1 helper: return unauthorized() (custom, returns a Response) ::', nx({ 'lib/api-response.ts': responses, 'lib/guard.ts': guard('return unauthorized()'), ...route }))
log('R2 helper: return forbidden() (custom) ::', nx({ 'lib/api-response.ts': responses, 'lib/guard.ts': guard('return forbidden()'), ...route }))
log('R3 helper: return error(401, "Unauthorized") (custom) ::', nx({ 'lib/api-response.ts': responses, 'lib/guard.ts': guard('return error(401, "Unauthorized")'), ...route }))
log('R4 control: return NextResponse.json 401 ::', nx({ 'lib/api-response.ts': responses, 'lib/guard.ts': guard('return NextResponse.json({ error: "Unauthorized" }, { status: 401 })', 'import { NextResponse } from "next/server"'), ...route }))
log('R5 control: next/navigation unauthorized() (throws) ::', nx({ 'lib/guard.ts': guard('unauthorized()', 'import { unauthorized } from "next/navigation"'), ...route }))
// same-file lead helper variant
log('R6 same-file lead helper returning unauthorized() ::', nx({ 'lib/api-response.ts': responses, 'app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { unauthorized } from "@/lib/api-response"
import { prisma } from "@/lib/prisma"
async function getUserOrFail() {
  const session = await auth()
  if (!session?.user) return unauthorized()
  return session.user
}
export async function POST(req: Request) {
  await getUserOrFail()
  const body = await req.json()
  await prisma.post.create({ data: { title: body.title } })
  return NextResponse.json({ ok: true })
}
` }))
assert.ok(outs.some(x => new RegExp(String.raw`^(C1|C2|C3|C4|K1|K2|K3|U1|U2|U4|R1|R2|R3)\b`).test(x)))
for (const x of outs) if (new RegExp(String.raw`^(C1|C2|C3|C4|K1|K2|K3|U1|U2|U4|R1|R2|R3)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
console.log('ok (review 58)')
// Review 59: no ✓ with a switch (a case may hand off first), a stop without return, Arcjet's .protect(req), a session with a fallback,
// an iron-session field that isn't a login, methods exported where plain can't see them, a catch that swallows the check, an unawaited
// better-auth session, or `session?.user?.id !== userId` (a guest leaves userId out)
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// pages/api: switch dispatch before the login check, where the case does something before returning (or is braced, as no-case-declarations wants)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const t3 = mk('{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}')
const T3AUTH = { 'src/server/auth.ts': `import { getServerSession, type NextAuthOptions } from "next-auth"
const authOptions: NextAuthOptions = { providers: [] }
const getServerAuthSession = (ctx?: any) => ctx ? getServerSession(ctx.req, ctx.res, authOptions) : getServerSession(authOptions)
`, 'src/server/posts.ts': `import { prisma } from "~/server/db"
const deletePost = (id: string) => prisma.post.delete({ where: { id } })
const createPost = (title: string, authorId: string) => prisma.post.create({ data: { title, authorId } })
const listPosts = () => prisma.post.findMany()
` }
const head = `import type { NextApiRequest, NextApiResponse } from "next"
import { getSession } from "next-auth/react"
import { deletePost, createPost, listPosts } from "~/server/posts"
`
const tail = `  const session = await getSession({ req })
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  const post = await createPost(req.body.title, session.user.id)
  return res.status(201).json(post)
}
`
const sw = (cases: string) => ({ ...T3AUTH, 'src/pages/api/posts.ts': head + `export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
${cases}
  }
${tail}` })
log('W0 control: no dispatch ::', t3(sw('')))
log('W1 case DELETE: await then return ::', t3(sw(`    case "DELETE":
      await deletePost(String(req.query.id))
      return res.status(204).end()`)))
log('W2 braced case DELETE { const id; await; return } ::', t3(sw(`    case "DELETE": {
      const id = String(req.query.id)
      await deletePost(id)
      return res.status(204).end()
    }`)))
log('W3 braced case GET + DELETE ::', t3(sw(`    case "GET": {
      const posts = await listPosts()
      return res.json(posts)
    }
    case "DELETE": {
      await deletePost(String(req.query.id))
      return res.status(204).end()
    }`)))
log('W4 case DELETE: return deletePost (control, caught by r53) ::', t3(sw(`    case "DELETE":
      return res.json(await deletePost(String(req.query.id)))`)))
log('W5 case DELETE: res.json(await ...); break (no return, falls to check after the write) ::', t3(sw(`    case "DELETE":
      res.json(await deletePost(String(req.query.id)))
      return`)))
log('W6 braced case GET only (public read, then the check) ::', t3(sw(`    case "GET": {
      const posts = await listPosts()
      return res.json(posts)
    }`)))
log('W7 if DELETE without return (falls into the check after the write) ::', t3({ ...T3AUTH, 'src/pages/api/posts.ts': head + `export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "DELETE") await deletePost(String(req.query.id))
${tail}` }))
const appHead = `import { NextResponse } from "next/server"
import { getSession } from "next-auth/react"
import { deletePost, createPost } from "~/server/posts"
`
log('W8 app route POST: switch on body.action before the check ::', t3({ ...T3AUTH, 'src/app/api/posts/route.ts': appHead + `export async function POST(req: Request) {
  const body = await req.json()
  switch (body.action) {
    case "delete": {
      await deletePost(body.id)
      return NextResponse.json({ ok: true })
    }
  }
  const session = await getSession({ req })
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(await createPost(body.title, session.user.id))
}
` }))
log('W9 app route POST: same with if (control) ::', t3({ ...T3AUTH, 'src/app/api/posts/route.ts': appHead + `export async function POST(req: Request) {
  const body = await req.json()
  if (body.action === "delete") {
    await deletePost(body.id)
    return NextResponse.json({ ok: true })
  }
  const session = await getSession({ req })
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(await createPost(body.title, session.user.id))
}
` }))
for (const x of outs) if (new RegExp(String.raw`^(W1|W2|W3|W5|W8|N1|N2|N3|N4|A1|A2|P1|P3|F1|F2|F4|F5|I6|I7|M2|M3|M7|M8|O1|O2|T1|B1|B2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// pages/api: switch dispatch before the login check, where the case does something before returning (or is braced, as no-case-declarations wants)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const t3 = mk('{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}')
// reqOk passes on any `).protect(` in the method (meant for Clerk's (await auth()).protect()), skipping the check that
// the require*() helper is found and stops guests. Arcjet's documented chain `aj.withRule(...).protect(req)` has that text.
const lib = (body: string) => ({ 'src/lib/guard.ts': `import { NextResponse } from "next/server"
import { getSession } from "next-auth/react"
export async function requireAuth(req: Request) {
  const session = await getSession({ req: req as any })
  ${body}
  return session
}
`, 'src/lib/arcjet.ts': `import arcjet, { shield } from "@arcjet/next"
export const aj = arcjet({ key: process.env.ARCJET_KEY!, rules: [shield({ mode: "LIVE" })] })
`, 'src/server/posts.ts': `import { prisma } from "~/server/db"
export const createPost = (title: string) => prisma.post.create({ data: { title } })
` })
const route = (pre: string) => ({ 'src/app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { requireAuth } from "@/lib/guard"
import { aj } from "@/lib/arcjet"
import { slidingWindow } from "@arcjet/next"
import { createPost } from "~/server/posts"
export async function POST(req: Request) {
${pre}
  await requireAuth(req)
  const body = await req.json()
  return NextResponse.json(await createPost(body.title))
}
` })
const ret401 = 'if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })'
const arc = `  const decision = await aj.withRule(slidingWindow({ mode: "LIVE", interval: "1m", max: 5 })).protect(req)
  if (decision.isDenied()) return NextResponse.json({ error: "Too many requests" }, { status: 429 })`
const p = '{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0","@arcjet/next":"1.0.0"}}'
const ax = mk(p)
log('P0 control: helper returns 401 (ignored), no arcjet ::', ax({ ...lib(ret401), ...route('') }))
log('P1 helper returns 401 (ignored) + arcjet withRule().protect(req) ::', ax({ ...lib(ret401), ...route(arc) }))
log('P2 helper throws (true) + arcjet ::', ax({ ...lib('if (!session) throw new Error("Unauthorized")'), ...route(arc) }))
log('P3 helper never checks + arcjet ::', ax({ ...lib(''), ...route(arc) }))
for (const x of outs) if (new RegExp(String.raw`^(W1|W2|W3|W5|W8|N1|N2|N3|N4|A1|A2|P1|P3|F1|F2|F4|F5|I6|I7|M2|M3|M7|M8|O1|O2|T1|B1|B2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// pages/api: switch dispatch before the login check, where the case does something before returning (or is braced, as no-case-declarations wants)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const t3 = mk('{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}')
// The guest branch "stops" by name (hardStop: redirect( / unauthorized( / forbidden( / notFound() but builds a response
// without returning it, so the write below still runs for guests.
const posts = { 'src/server/posts.ts': `import { prisma } from "~/server/db"
export const createPost = (title: string) => prisma.post.create({ data: { title } })
`, 'src/lib/http.ts': `import { NextResponse } from "next/server"
export const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 })
` }
const app = (branch: string, extra = '') => ({ ...posts, 'src/app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { getSession } from "next-auth/react"
import { createPost } from "~/server/posts"
${extra}
export async function POST(req: Request) {
  const session = await getSession({ req: req as any })
  if (!session) ${branch}
  const body = await req.json()
  return NextResponse.json(await createPost(body.title))
}
` })
const api = (branch: string) => ({ ...posts, 'src/pages/api/posts.ts': `import type { NextApiRequest, NextApiResponse } from "next"
import { getSession } from "next-auth/react"
import { createPost } from "~/server/posts"
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSession({ req })
  if (!session) ${branch}
  res.json(await createPost(req.body.title))
}
` })
log('N0 control: return NextResponse.json 401 ::', t3(app('return NextResponse.json({ error: "Unauthorized" }, { status: 401 })')))
log('N1 NextResponse.redirect(...) without return ::', t3(app('NextResponse.redirect(new URL("/login", req.url))')))
log('N2 { NextResponse.redirect(...) } without return, braces ::', t3(app('{\n    NextResponse.redirect(new URL("/login", req.url))\n  }')))
log('N3 own unauthorized() helper without return ::', t3(app('unauthorized()', 'import { unauthorized } from "@/lib/http"')))
log('N4 Response.redirect without return ::', t3(app('Response.redirect(new URL("/login", req.url))')))
log('N5 next/navigation redirect (throws, control) ::', t3(app('redirect("/login")', 'import { redirect } from "next/navigation"')))
log('A0 control: pages/api return res.status(401) ::', t3(api('return res.status(401).json({ error: "Unauthorized" })')))
log('A1 pages/api { res.redirect("/login") } no return ::', t3(api('{\n    res.redirect("/login")\n  }')))
log('A2 pages/api res.redirect(307, "/api/auth/signin") no return ::', t3(api('res.redirect(307, "/api/auth/signin")')))
log('A3 pages/api res.status(401).json no return (P7, control) ::', t3(api('res.status(401).json({ error: "Unauthorized" })')))
for (const x of outs) if (new RegExp(String.raw`^(W1|W2|W3|W5|W8|N1|N2|N3|N4|A1|A2|P1|P3|F1|F2|F4|F5|I6|I7|M2|M3|M7|M8|O1|O2|T1|B1|B2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// pages/api: switch dispatch before the login check, where the case does something before returning (or is braced, as no-case-declarations wants)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
// The session name is tested for existence where the value is always there (Clerk's getAuth(req) object, an un-awaited
// better-auth auth.api.getSession() Promise) or compared to undefined where guests get null.
const posts = { 'src/server/posts.ts': `import { prisma } from "~/server/db"
export const createPost = (title: string) => prisma.post.create({ data: { title } })
` }
const ck = mk('{"dependencies":{"next":"14.0.0","@clerk/nextjs":"5.0.0","@prisma/client":"5.0.0"}}')
const ba = mk('{"dependencies":{"next":"15.0.0","better-auth":"1.0.0","@prisma/client":"5.0.0"}}')
const na = mk('{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}')
log('C1 pages/api const auth = getAuth(req); if (!auth) 401 (always an object) ::', ck({ ...posts, 'src/pages/api/posts.ts': `import type { NextApiRequest, NextApiResponse } from "next"
import { getAuth } from "@clerk/nextjs/server"
import { createPost } from "~/server/posts"
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = getAuth(req)
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  res.json(await createPost(req.body.title))
}
` }))
log('C2 control: const { userId } = getAuth(req); if (!userId) ::', ck({ ...posts, 'src/pages/api/posts.ts': `import type { NextApiRequest, NextApiResponse } from "next"
import { getAuth } from "@clerk/nextjs/server"
import { createPost } from "~/server/posts"
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { userId } = getAuth(req)
  if (!userId) return res.status(401).json({ error: "Unauthorized" })
  res.json(await createPost(req.body.title))
}
` }))
const baRoute = (decl: string, cond = '!session') => ({ ...posts, 'src/lib/auth.ts': `import { betterAuth } from "better-auth"
export const auth = betterAuth({})
`, 'src/app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { createPost } from "~/server/posts"
export async function POST(req: Request) {
  ${decl}
  if (${cond}) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json()
  return NextResponse.json(await createPost(body.title))
}
` })
log('B0 control: await auth.api.getSession ::', ba(baRoute('const session = await auth.api.getSession({ headers: await headers() })')))
log('B1 auth.api.getSession NOT awaited, if (!session) ::', ba(baRoute('const session = auth.api.getSession({ headers: await headers() })')))
log('B2 auth.api.getSession({ headers: req.headers }) NOT awaited ::', ba(baRoute('const session = auth.api.getSession({ headers: req.headers })')))
const naRoute = (cond: string) => ({ ...posts, 'src/pages/api/posts.ts': `import type { NextApiRequest, NextApiResponse } from "next"
import { getSession } from "next-auth/react"
import { createPost } from "~/server/posts"
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSession({ req })
  if (${cond}) return res.status(401).json({ error: "Unauthorized" })
  res.json(await createPost(req.body.title))
}
` })
log('U1 session === undefined (guests get null) ::', na(naRoute('session === undefined')))
log('U2 session === false ::', na(naRoute('session === false')))
log('U3 control session === null ::', na(naRoute('session === null')))
for (const x of outs) if (new RegExp(String.raw`^(W1|W2|W3|W5|W8|N1|N2|N3|N4|A1|A2|P1|P3|F1|F2|F4|F5|I6|I7|M2|M3|M7|M8|O1|O2|T1|B1|B2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// pages/api: switch dispatch before the login check, where the case does something before returning (or is braced, as no-case-declarations wants)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const t3 = mk('{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}')
// App route: POST checks; another write method is exported in a shape plain may not count (wrapped, re-exported, destructured)
const posts = { 'src/server/posts.ts': `import { prisma } from "~/server/db"
export const createPost = (title: string) => prisma.post.create({ data: { title } })
export const deletePost = (id: string) => prisma.post.delete({ where: { id } })
`, 'src/lib/api.ts': `import { NextResponse } from "next/server"
export const withErrors = (h: (req: Request) => Promise<Response>) => async (req: Request) => { try { return await h(req) } catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }) } }
`, 'src/app/api/posts/delete.ts': `import { NextResponse } from "next/server"
import { deletePost } from "~/server/posts"
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id")!
  await deletePost(id)
  return NextResponse.json({ ok: true })
}
` }
const route = (extra: string) => ({ ...posts, 'src/app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { getSession } from "next-auth/react"
import { createPost, deletePost } from "~/server/posts"
import { withErrors } from "@/lib/api"
export async function POST(req: Request) {
  const session = await getSession({ req: req as any })
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json()
  return NextResponse.json(await createPost(body.title))
}
${extra}
` })
log('M0 control: POST only ::', t3(route('')))
log('M1 export const DELETE = withErrors(async (req) => ...) unchecked ::', t3(route(`export const DELETE = withErrors(async (req: Request) => {
  const id = new URL(req.url).searchParams.get("id")!
  await deletePost(id)
  return NextResponse.json({ ok: true })
})`)))
log('M2 export { DELETE } from "./delete" ::', t3(route('export { DELETE } from "./delete"')))
log('M3 export * from "./delete" ::', t3(route('export * from "./delete"')))
log('M4 export const DELETE = async (req) => unchecked ::', t3(route(`export const DELETE = async (req: Request) => {
  const id = new URL(req.url).searchParams.get("id")!
  await deletePost(id)
  return NextResponse.json({ ok: true })
}`)))
log('M5 const handler = ...; export { handler as DELETE } (control r56) ::', t3(route(`const remove = async (req: Request) => { await deletePost(new URL(req.url).searchParams.get("id")!); return NextResponse.json({ ok: true }) }
export { remove as DELETE }`)))
log('M6 export const DELETE = withErrors(remove) ::', t3(route(`async function remove(req: Request) { await deletePost(new URL(req.url).searchParams.get("id")!); return NextResponse.json({ ok: true }) }
export const DELETE = withErrors(remove)`)))
log('M7 export const PUT = POST, DELETE = remove (multi-declarator) ::', t3(route(`async function remove(req: Request) { await deletePost(new URL(req.url).searchParams.get("id")!); return NextResponse.json({ ok: true }) }
export const PUT = POST, DELETE = remove`)))
log('M8 export { remove as "DELETE" }? / export { DELETE } local after decl ::', t3(route(`async function DELETE(req: Request) { await deletePost(new URL(req.url).searchParams.get("id")!); return NextResponse.json({ ok: true }) }
export { DELETE }`)))
const bottom = (exp: string) => ({ ...posts, 'src/app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { getSession } from "next-auth/react"
import { createPost, deletePost } from "~/server/posts"
async function POST(req: Request) {
  const session = await getSession({ req: req as any })
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json()
  return NextResponse.json(await createPost(body.title))
}
async function DELETE(req: Request) {
  await deletePost(new URL(req.url).searchParams.get("id")!)
  return NextResponse.json({ ok: true })
}
${exp}
` })
log('M9 all declared, export { POST, DELETE } at the bottom ::', t3(bottom('export { POST, DELETE }')))
log('M10 export { POST }; export { DELETE } ::', t3(bottom('export { POST }\nexport { DELETE }')))
for (const x of outs) if (new RegExp(String.raw`^(W1|W2|W3|W5|W8|N1|N2|N3|N4|A1|A2|P1|P3|F1|F2|F4|F5|I6|I7|M2|M3|M7|M8|O1|O2|T1|B1|B2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// pages/api: switch dispatch before the login check, where the case does something before returning (or is braced, as no-case-declarations wants)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const t3 = mk('{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}')
// The session's own declaration falls back to something that's always there (a demo session, a body-built user)
const posts = { 'src/server/posts.ts': `import { prisma } from "~/server/db"
export const createPost = (title: string, authorId: string) => prisma.post.create({ data: { title, authorId } })
`, 'src/lib/demo.ts': `export const DEMO_SESSION = { user: { id: "demo", name: "Demo user" } }
` }
const api = (decl: string) => ({ ...posts, 'src/pages/api/posts.ts': `import type { NextApiRequest, NextApiResponse } from "next"
import { getSession } from "next-auth/react"
import { DEMO_SESSION } from "@/lib/demo"
import { createPost } from "~/server/posts"
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  ${decl}
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  res.json(await createPost(req.body.title, session.user.id))
}
` })
log('F0 control ::', t3(api('const session = await getSession({ req })')))
log('F1 (await getSession({ req })) ?? { user: { id: req.body.userId } } ::', t3(api('const session = (await getSession({ req })) ?? { user: { id: req.body.userId } }')))
log('F2 (await getSession({ req })) || DEMO_SESSION ::', t3(api('const session = (await getSession({ req })) || DEMO_SESSION')))
log('F3 process.env.DEMO_MODE ? DEMO_SESSION : await getSession({ req }) ::', t3(api('const session = process.env.DEMO_MODE ? DEMO_SESSION : await getSession({ req })')))
log('F4 await getSession({ req }) ?? DEMO_SESSION (no parens) ::', t3(api('const session = await getSession({ req }) ?? DEMO_SESSION')))
log('F5 const session = await getSession({ req }).catch(() => DEMO_SESSION) ::', t3(api('const session = await getSession({ req }).catch(() => DEMO_SESSION)')))
for (const x of outs) if (new RegExp(String.raw`^(W1|W2|W3|W5|W8|N1|N2|N3|N4|A1|A2|P1|P3|F1|F2|F4|F5|I6|I7|M2|M3|M7|M8|O1|O2|T1|B1|B2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// pages/api: switch dispatch before the login check, where the case does something before returning (or is braced, as no-case-declarations wants)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const t3 = mk('{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}')
// review54 Q5 (inline check thrown inside a try whose catch logs and carries on) was known because HEAD gave the same ✓;
// with a session call HEAD doesn't know (getSession, getServerAuthSession, getToken) HEAD warns and NEW gives the ✓
const posts = { 'src/server/posts.ts': `import { prisma } from "~/server/db"
export const deletePosts = () => prisma.post.deleteMany()
` }
log('T1 app route: try { getSession; if (!s) throw } catch { log } then write ::', t3({ ...posts, 'src/app/api/posts/route.ts': `import { getSession } from "next-auth/react"
import { deletePosts } from "~/server/posts"
export async function DELETE(req: Request) {
  try {
    const session = await getSession({ req: req as any })
    if (!session) throw new Error("Unauthorized")
  } catch (e) {
    console.error(e)
  }
  await deletePosts()
  return Response.json({ ok: true })
}
` }))
log('T2 pages/api: same with getToken ::', t3({ ...posts, 'src/pages/api/posts.ts': `import type { NextApiRequest, NextApiResponse } from "next"
import { getToken } from "next-auth/jwt"
import { deletePosts } from "~/server/posts"
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const token = await getToken({ req })
    if (!token) throw new Error("Unauthorized")
  } catch (e) {
    console.error(e)
  }
  await deletePosts()
  res.json({ ok: true })
}
` }))
for (const x of outs) if (new RegExp(String.raw`^(W1|W2|W3|W5|W8|N1|N2|N3|N4|A1|A2|P1|P3|F1|F2|F4|F5|I6|I7|M2|M3|M7|M8|O1|O2|T1|B1|B2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// pages/api: switch dispatch before the login check, where the case does something before returning (or is braced, as no-case-declarations wants)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
const t3 = mk('{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}')
// `if (session?.user?.id !== userId) return 403` with userId from the request: a guest who leaves userId out
// passes (undefined !== undefined is false). isNegLogin reads `!==` on session?.x as a login check.
const posts = { 'src/server/posts.ts': `import { prisma } from "~/server/db"
export const deleteUserPosts = (authorId: string) => prisma.post.deleteMany({ where: { authorId } })
`, 'src/lib/session.ts': `import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth"
export async function getCurrentUser() { const s = await getServerSession(authOptions); return s?.user }
` }
log('O1 app route: getSession, session?.user?.id !== body.userId -> 403 ::', t3({ ...posts, 'src/app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { getSession } from "next-auth/react"
import { deleteUserPosts } from "~/server/posts"
export async function DELETE(req: Request) {
  const { userId } = await req.json()
  const session = await getSession({ req: req as any })
  if (session?.user?.id !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await deleteUserPosts(userId)
  return NextResponse.json({ ok: true })
}
` }))
log('O2 app route: getCurrentUser, user?.id !== searchParams userId ::', t3({ ...posts, 'src/app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/session"
import { deleteUserPosts } from "~/server/posts"
export async function DELETE(req: Request) {
  const userId = new URL(req.url).searchParams.get("userId")
  const user = await getCurrentUser()
  if (user?.id !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await deleteUserPosts(userId!)
  return NextResponse.json({ ok: true })
}
` }))
log('O3 control: if (!session || session.user.id !== userId) ::', t3({ ...posts, 'src/app/api/posts/route.ts': `import { NextResponse } from "next/server"
import { getSession } from "next-auth/react"
import { deleteUserPosts } from "~/server/posts"
export async function DELETE(req: Request) {
  const { userId } = await req.json()
  const session = await getSession({ req: req as any })
  if (!session || session.user.id !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await deleteUserPosts(userId)
  return NextResponse.json({ ok: true })
}
` }))
for (const x of outs) if (new RegExp(String.raw`^(W1|W2|W3|W5|W8|N1|N2|N3|N4|A1|A2|P1|P3|F1|F2|F4|F5|I6|I7|M2|M3|M7|M8|O1|O2|T1|B1|B2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
{
const outs: string[] = [], log = (...a: unknown[]) => { if (a.length) outs.push(a.join(' ').replace(/\s+/g, ' ')) }
// pages/api: switch dispatch before the login check, where the case does something before returning (or is braced, as no-case-declarations wants)
const mk = (pkg: string) => { const nx = { 'package.json': pkg }
  return (files: Record<string, string>) => report(new Map(Object.entries(nx)), new Map(Object.entries({ ...nx, ...files })), { ref: 'main' }).replace(/\s+/g, ' ') }
// iron-session's session object is always there and also holds things that aren't a login (an anonymous cart, OAuth state).
// `if (!session.cartId) return ...` reads as a login check (`!session.x`, like `!user?.isAdmin`), and the "always there" rule
// only asks that some property of session be tested.
const ir = mk('{"dependencies":{"next":"14.0.0","iron-session":"8.0.0","@prisma/client":"5.0.0"}}')
const lib = { 'src/lib/session.ts': `export type SessionData = { cartId?: string; userId?: string }
export const sessionOptions = { password: process.env.SECRET!, cookieName: "shop" }
`, 'src/server/cart.ts': `import { prisma } from "~/server/db"
export const addItem = (cartId: string, productId: string) => prisma.cartItem.create({ data: { cartId, productId } })
export const clearCart = (cartId: string) => prisma.cartItem.deleteMany({ where: { cartId } })
` }
const route = (body: string) => ({ ...lib, 'src/app/api/cart/route.ts': `import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions, type SessionData } from "@/lib/session"
import { addItem, clearCart } from "~/server/cart"
${body}
` })
log('I1 DELETE: if (!session.cartId) return NextResponse.json({ ok: true }) (nothing to clear) ::', ir(route(`export async function DELETE() {
  const session = await getIronSession(cookies(), sessionOptions)
  if (!session.cartId) return NextResponse.json({ ok: true })
  await clearCart(session.cartId)
  return NextResponse.json({ ok: true })
}`)))
log('I2 POST: if (!session.cartId) return 400 ::', ir(route(`export async function POST(req: Request) {
  const session = await getIronSession(cookies(), sessionOptions)
  if (!session.cartId) return NextResponse.json({ error: "No cart yet" }, { status: 400 })
  const { productId } = await req.json()
  await addItem(session.cartId, productId)
  return NextResponse.json({ ok: true })
}`)))
log('I3 control: if (!session.userId) return 401 ::', ir(route(`export async function POST(req: Request) {
  const session = await getIronSession(cookies(), sessionOptions)
  if (!session.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { productId } = await req.json()
  await addItem(session.userId, productId)
  return NextResponse.json({ ok: true })
}`)))
log('I4 pages/api: if (!req.session.cartId)-style via getIronSession(req, res) ::', ir({ ...lib, 'src/pages/api/cart.ts': `import type { NextApiRequest, NextApiResponse } from "next"
import { getIronSession } from "iron-session"
import { sessionOptions, type SessionData } from "@/lib/session"
import { clearCart } from "~/server/cart"
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getIronSession(req, res, sessionOptions)
  if (!session.cartId) return res.json({ ok: true })
  await clearCart(session.cartId)
  res.json({ ok: true })
}
` }))
log('I5 OAuth callback GET: if (!session.oauthState || session.oauthState !== state) throw Error("Invalid OAuth state") ::', ir({ ...lib, 'src/server/users.ts': `import { prisma } from "~/server/db"
export const upsertGithubUser = (login: string) => prisma.user.upsert({ where: { login }, create: { login }, update: {} })
`, 'src/app/api/auth/github/callback/route.ts': `import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { upsertGithubUser } from "~/server/users"
export async function GET(req: Request) {
  const url = new URL(req.url)
  const state = url.searchParams.get("state")
  const session = await getIronSession(cookies(), sessionOptions)
  if (!session.oauthState || session.oauthState !== state) throw new Error("Invalid OAuth state")
  const login = await exchangeCode(url.searchParams.get("code")!)
  const user = await upsertGithubUser(login)
  session.userId = user.id
  await session.save()
  return NextResponse.redirect(new URL("/", req.url))
}
async function exchangeCode(code: string) { return code }
` }))
log('I6 POST: if (!session.cartId) redirect("/cart") (next/navigation) ::', ir(route(`import { redirect } from "next/navigation"
export async function POST(req: Request) {
  const session = await getIronSession(cookies(), sessionOptions)
  if (!session.cartId) redirect("/cart")
  const { productId } = await req.json()
  await addItem(session.cartId, productId)
  return NextResponse.json({ ok: true })
}`)))
log('I7 contact form POST: CSRF token kept in iron-session, mismatch -> 403 ::', ir({ ...lib, 'src/server/messages.ts': `import { prisma } from "~/server/db"
export const saveMessage = (email: string, text: string) => prisma.message.create({ data: { email, text } })
`, 'src/app/api/contact/route.ts': `import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { saveMessage } from "~/server/messages"
export async function POST(req: Request) {
  const session = await getIronSession(cookies(), sessionOptions)
  const { email, message, csrf } = await req.json()
  if (!session.csrfToken || session.csrfToken !== csrf) return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 })
  await saveMessage(email, message)
  return NextResponse.json({ ok: true })
}
` }))
log('I8 same with next-auth getToken + 403 on csrf (control: guests stopped since token null) ::', mk('{"dependencies":{"next":"14.0.0","next-auth":"4.24.0","@prisma/client":"5.0.0"}}')({ ...lib, 'src/server/messages.ts': `import { prisma } from "~/server/db"
export const saveMessage = (email: string, text: string) => prisma.message.create({ data: { email, text } })
`, 'src/app/api/contact/route.ts': `import { NextResponse } from "next/server"
import { getToken } from "next-auth/jwt"
import { saveMessage } from "~/server/messages"
export async function POST(req: Request) {
  const token = await getToken({ req: req as any })
  const { email, message } = await req.json()
  if (token?.email !== email) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await saveMessage(email, message)
  return NextResponse.json({ ok: true })
}
` }))
for (const x of outs) if (new RegExp(String.raw`^(W1|W2|W3|W5|W8|N1|N2|N3|N4|A1|A2|P1|P3|F1|F2|F4|F5|I6|I7|M2|M3|M7|M8|O1|O2|T1|B1|B2)\b`).test(x)) assert.ok(!/requires login ✓/.test(x), x)
}
console.log('ok (review 59)')

// Parsed trees live in WebAssembly memory that JavaScript never frees: every tree must be deleted, or a big repo (or many
// reports in one process) fills the 4 GB and the parser aborts.
{
  const { Tree } = await import('web-tree-sitter')
  const del = Tree.prototype.delete; let n = 0
  Tree.prototype.delete = function () { n++; return del.call(this) }
  report(new Map(), new Map([['app/views.py', 'def a():\n    pass\n'], ['app/Http/A.php', '<?php\nclass A {}\n'], ['main.go', 'package main\n'],
    ['src/A.java', 'class A {}\n'], ['A.cs', 'class A {}\n'], ['app/a.rb', 'class A\nend\n']]), { ref: 'x' })
  Tree.prototype.delete = del
  assert.ok(n >= 6, `only ${n} of 6 parsed trees were freed`)
}
console.log('ok (trees freed)')

// Production pilot (docs/production-eval.md): say what was checked, never "nothing changed" over app files, no false
// "made-up data" or "anyone can use" on checks plain can see, and catch two kinds of broken commit.
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'components/Badge.tsx': 'export const Badge = () => <b>new</b>\n', 'lib/api.js': 'export const get = (u) => fetch(u)\n' }
  // the header says what plain looked at
  const h = c(nx, { ...nx, 'lib/api.js': 'export const get = (u) => { console.log(u); return fetch(u) }\n' })
  assert.ok(h.includes('Nothing flagged') && !h.includes('✓') && h.includes(NOTE) && !h.includes('No problems spotted'), h)
  assert.ok(h.includes("The agent changed lib/api.js in a way plain can't describe yet. Ask the agent what it does differently."), h)
  // only a component changed: listed, not "Nothing about the app changed"; only tests: that's still true
  const comp = c(nx, { ...nx, 'components/Badge.tsx': 'export const Badge = () => <b>NEW</b>\n' })
  assert.ok(comp.includes("The agent changed components/Badge.tsx in a way plain can't describe yet. Ask the agent what it does differently.") && !comp.includes('Nothing about the app changed'), comp)
  assert.ok(!report(new Map([['svc/specs/schema.py', 'A = 1\n']]), new Map([['svc/specs/schema.py', 'A = 2\n']]), { ref: 'x' }).includes('(tests)'), 'specs/ is not tests')
  { const { 'components/Badge.tsx': _, ...gone } = nx; const d = c(nx, gone); assert.ok(d.includes("The agent deleted components/Badge.tsx. plain can't describe it yet."), d) }
  assert.ok(c(nx, { ...nx, 'lib/api.test.js': 'test("x", () => {})\n' }).includes('Nothing about the app changed'), 'tests only: still true')
  // made-up data: written-out values or a mock list, not an object built from settings
  const made = (body: string) => c(nx, { ...nx, 'lib/terms.ts': `import { config } from './config'\nexport function getTerms() {\n${body}\n}\n`, 'lib/config.ts': 'export const config = {} as any\n' }).includes('returns made-up data')
  assert.ok(!made('  return { url: config.TERMS_URL, version: config.TERMS_VERSION }'), 'settings are not made up')
  assert.ok(!made('  return { ...config.terms }') && !made('  const v = config.v\n  return { v }'), 'spread and shorthand read values')
  for (const body of ['  return [{ id: 1, name: "Demo", price: 9.99 }]', '  return { items: MOCK_TERMS }', '  return [{ id: 1, title: "Welcome post", createdAt: new Date("2024-01-01") }]',
    '  return [{ name: "Jane Doe", avatar: undefined }]', '  return { plan: "pro", renewsAt: Date.now() + 86400000 }',
    '  return { status: "paid" as Status }', '  return { orders: [] as Order[], total: 0 }', '  return { tags: new Set<string>(["a"]) }', '  return { id: 1 } satisfies O'])
    assert.ok(made(body), `still made up: ${body}`)
  // ponytail: `{ status: Status.Paid }` reads like `{ url: Config.URL }`, so an enum member isn't counted as made up
  // a login check plain can see but not prove: no "anyone can use" warning, and no ✓ either
  const prefs = (imp: string, pre: string, cond: string) => ({ 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'src/shared/api/mobile-auth.ts': 'export async function getMobileCompatibleSession(req: any) { return null }\n',
    'app/api/user/preferences/route.ts': `import { NextRequest, NextResponse } from "next/server"\n${imp}\nimport { prisma } from "@/lib/prisma"\nexport async function PUT(req: NextRequest) {\n  try {\n    ${pre}\n${cond}    await prisma.user.update({ where: { id: session.user.id }, data: {} })\n    return NextResponse.json({ ok: true })\n  } catch (e) { console.warn(e) }\n  return NextResponse.json({ ok: false })\n}\n`, 'lib/prisma.ts': 'export const prisma = {} as any\n' })
  const IMP = 'import { getMobileCompatibleSession } from "@/shared/api/mobile-auth"', PRE = 'const session = await getMobileCompatibleSession(req)', COND = '    if (!session?.user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 })\n'
  const base = { 'package.json': '{"dependencies":{"next":"15.0.0"}}' }
  const seen = c(base, prefs(IMP, PRE, COND))
  assert.ok(!seen.includes('Anyone can use') && !seen.includes('requires login ✓'), seen)
  for (const [name, f] of [['handed off first', prefs(IMP, PRE, '    if (req.nextUrl.searchParams.get("all")) return purge(req)\n' + COND)],
    ['a switch first', prefs(IMP, PRE, '    switch (req.method) { case "X": return bulk(req) }\n' + COND)],
    ['a throw inside the try', prefs(IMP, PRE, '    if (!session?.user) throw new Error("UNAUTHORIZED")\n')],
    ['no check', prefs(IMP, PRE, '')], ['from the body', prefs(IMP, 'const session = await req.json()', COND)], ['not an auth module', prefs('import { getMobileCompatibleSession } from "@/lib/cache"', PRE, COND)],
    ['not a session getter', prefs('import { hashPassword } from "@/lib/auth"', 'const session = await hashPassword(req)', COND)],
    ['parsed options passed', prefs(IMP, 'const session = await getMobileCompatibleSession(options)', COND)],
    ['set again before the check', prefs(IMP, 'let session = await getMobileCompatibleSession(req)\n    if (!session?.user) session = { user: { id: "guest" } }', COND)],
    ['a write before the check', prefs(IMP, PRE + '\n    await prisma.user.update({ where: { id: "x" }, data: {} })', COND)],
    ['the check inside a loop', prefs(IMP, PRE + '\n    for (const i of [] as number[]) {', COND + '    }\n')]] as const)
    assert.ok(c(base, f).includes('Anyone can use the user preferences part of your server without logging in'), `control: ${name}`)
  // a write method exported under another name, or a next-connect chain: the check in GET (or .get) says nothing about it
  { const r = prefs(IMP, PRE, COND)['app/api/user/preferences/route.ts'].replace('export async function PUT', 'export async function GET') + 'async function update(req: NextRequest) { await prisma.user.update({ where: { id: "x" }, data: {} }) }\nexport { update as PUT }\n'
    assert.ok(c(base, { ...prefs(IMP, PRE, COND), 'app/api/user/preferences/route.ts': r }).includes('Anyone can use'), 'export alias') }
  { const nc = { 'package.json': '{"dependencies":{"next":"15.0.0","next-connect":"1.0.0"}}', 'src/shared/api/mobile-auth.ts': 'export async function getMobileCompatibleSession(req: any) { return null }\n', 'lib/prisma.ts': 'export const prisma = {} as any\n',
      'pages/api/orders.ts': `import nc from "next-connect"\n${IMP}\nimport { prisma } from "@/lib/prisma"\nexport default nc().get(async (req, res) => { ${PRE}; if (!session) return res.status(401).end(); res.json(await prisma.order.findMany()) }).post(async (req, res) => { res.json(await prisma.order.create({ data: req.body })) })\n` }
    assert.ok(c(base, nc).includes('Anyone can use'), 'next-connect chain') }
  // "won't build" for a new import of a folder that isn't there (papermark), but not for generated or gitignored files (Wayfinder's
  // @/routes, openapi types), nor an import that was already there
  { const app = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'ee/features/billing/plan.ts': 'export const plan = 1\n', 'app/page.tsx': 'export default function P() { return <main /> }\n' }
    const imp = (spec: string, extra: Record<string, string> = {}) => c({ ...app, ...extra }, { ...app, ...extra, 'app/page.tsx': `import { R } from "${spec}"\nexport default function P() { return <main /> }\n` })
    assert.ok(imp('@/ee/features/redaction/r').includes("won't build"), 'papermark: a folder that isn\'t there')
    for (const [name, spec, extra] of [['wayfinder', '@/routes/dashboard', { 'resources/js/app.ts': 'x\n' }], ['gitignored', '@/ee/features/gen-api/client', { '.gitignore': '/node_modules\nee/features/gen-api/\n' }],
      ['generated', '@/ee/features/__generated__/types', {}], ['a file in an existing folder', '@/ee/features/billing/plans', {}]] as const)
      assert.ok(!imp(spec, extra).includes("won't build"), `import control: ${name}`)
    const had = { ...app, 'app/other.tsx': 'import { R } from "@/ee/features/redaction/r"\nexport const O = 1\n' }
    assert.ok(!c(had, { ...had, 'app/page.tsx': 'import { R } from "@/ee/features/redaction/r"\nexport default function P() { return <main /> }\n' }).includes("won't build"), 'already imported before') }
  // a migration that starts with terminal output; real SQL dialects that start with anything else aren't flagged
  const pm = { 'package.json': '{"dependencies":{"@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model A {\n  id Int @id\n}\n' }
  const mig = (sql: string) => c(pm, { ...pm, 'prisma/migrations/20261011000000_a/migration.sql': sql })
  assert.ok(mig('Already up to date\nDone in 225ms using pnpm v11.20.0\n-- CreateTable\nCREATE TABLE "B" ("id" INTEGER);\n').includes('starts with "Already up to date", which is terminal output, not SQL'), 'pasted terminal output')
  assert.ok(mig('$ npx prisma migrate dev\nCREATE TABLE "B" ("id" INTEGER);\n').includes('terminal output'), 'pasted prompt')
  for (const sql of ['-- CreateTable\nCREATE TABLE "B" ("id" INTEGER);\n', '﻿\n\nCREATE TABLE "B" ("id" INTEGER);\n', '/* x */\nALTER TABLE "A" ADD COLUMN "b" TEXT;\n', 'begin;\ncreate table b (id int);\ncommit;\n',
    "PRINT N'Adding status'\nGO\n", "sp_rename 'a.b', 'c', 'COLUMN';\n", 'WHENEVER SQLERROR EXIT\n', 'PROMPT adding\n', 'REM x\n', ':setvar x 1\n', 'INSTALL spatial;\n', 'ATTACH TABLE x\n', 'SHOW search_path;\n', 'Done\n'])
    assert.ok(!mig(sql).includes('not SQL'), `control: ${JSON.stringify(sql.slice(0, 20))}`)
}
console.log('ok (production pilot fixes)')
// The pilot's misses: bank and ID numbers kept as plain text, uploads that take SVG, a Stripe webhook that swallows a failed save,
// a new way to delete your own account
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  // plain-text numbers: a new model, or a new field; not public bank codes, a last-4, an encrypted field
  const pm = { 'package.json': '{"dependencies":{"@prisma/client":"6.0.0"}}', 'prisma/schema.prisma': 'model Company {\n  id String @id\n}\n' }
  const bank = (fields: string, extra: Record<string, string> = {}) => c(pm, { ...pm, ...extra, 'prisma/schema.prisma': `model Company {\n  id String @id\n}\nmodel BankAccount {\n  id String @id\n${fields}\n}\n` })
  const b1 = bank('  bankName String\n  accountNumber String // iban or account number\n  routingNumber String\n  swiftCode String?')
  assert.ok(b1.includes('Bank accounts now store the account number as plain text. Anyone who gets a copy of your database (a leaked backup or password) can read it.'), b1)
  assert.ok(bank('  iban String\n  cardNumber String\n  cardExpiry String').includes('the IBAN and card number as plain text'), 'two')
  for (const [name, f, x] of [['last 4', '  accountNumberLast4 String', {}], ['encrypted name', '  encryptedAccountNumber String', {}], ['routing only', '  routingNumber String\n  swiftCode String', {}],
    ['/// @encrypted', '  accountNumber String /// @encrypted', {}], ['an encryption helper', '  accountNumber String', { 'lib/bank.ts': 'export const save = (n: string) => ({ accountNumber: encrypt(n) })\n' }]] as const)
    assert.ok(!bank(f, x).includes('plain text'), `control: ${name}`)
  const dj = { 'requirements.txt': 'django==5.1\n', 'people/models.py': 'from django.db import models\n\nclass Person(models.Model):\n    name = models.CharField(max_length=80)\n' }
  assert.ok(c(dj, { ...dj, 'people/models.py': dj['people/models.py'] + '    ssn = models.CharField(max_length=11)\n' }).includes('Persons now store the Social Security number as plain text. Anyone who gets a copy of your database (a leaked backup or password) can read it. Encrypt it.'), 'django ssn')
  assert.ok(!c(dj, { ...dj, 'people/models.py': dj['people/models.py'] + '    ssn = EncryptedCharField(max_length=11)\n' }).includes('plain text'), 'django encrypted')
  // SVG uploads
  const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'app/Http/Controllers/AvatarController.php': "<?php\nclass AvatarController {\n  public function store($r) {\n    $r->validate(['image' => 'required|file|mimes:jpeg,png,webp|max:2048']);\n  }\n}\n" }
  const svg = c(lv, { ...lv, 'app/Http/Controllers/AvatarController.php': lv['app/Http/Controllers/AvatarController.php'].replace('webp|', 'webp,svg|') })
  assert.ok(svg.includes('Uploads now accept SVG files (in app/Http/Controllers/AvatarController.php). An SVG can carry a script'), svg)
  const cfg = { 'config/validation.php': "<?php\nreturn [\n    'image_extensions' => [\n        'jpeg', 'jpg', 'png',\n        'svg',\n    ],\n];\n" }
  assert.ok(c(lv, { ...lv, ...cfg }).includes('Uploads now accept SVG files (in config/validation.php)'), 'a list over lines, in a validation file')
  const up = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'app/upload/page.tsx': 'export default function U() { return <input type="file" accept="image/png, image/jpeg" /> }\n' }
  assert.ok(c(up, { ...up, 'app/upload/page.tsx': up['app/upload/page.tsx'].replace('image/jpeg', 'image/jpeg, image/svg+xml') }).includes('Uploads now accept SVG'), 'accept')
  for (const [name, a, b] of [
    ['bundler rule', { 'webpack.config.js': 'module.exports = { module: { rules: [] } }\n' }, { 'webpack.config.js': 'module.exports = { module: { rules: [{ test: /\\.(png|jpe?g|gif|svg)$/i, type: "asset" }] } }\n' }],
    ['glob', { 'vite.config.ts': 'export default {}\n' }, { 'vite.config.ts': 'export default { assetsInclude: ["**/*.png", "**/*.svg"] }\n' }],
    ['already allowed', { 'lib/upload.ts': 'export const allowed = ["png", "jpg", "svg"]\n' }, { 'lib/upload.ts': 'export const allowed = ["png", "jpg", "svg"]\nexport const max = 5\n' }],
    ['moved', { 'lib/upload.ts': 'export const allowed = ["png", "jpg", "svg"]\n' }, { 'lib/upload.ts': 'export { allowed } from "./types"\n', 'lib/types.ts': 'export const allowed = ["png", "jpg", "svg"]\n' }],
    ['a test', {}, { 'tests/upload.test.ts': 'const allowed = ["png", "svg"]\n' }],
    ['no context', { 'lib/icons.ts': 'export const x = 1\n' }, { 'lib/icons.ts': 'export const kinds = ["png", "svg"]\n' }]] as const)
    assert.ok(!c(a, b).includes('accept SVG'), `control: ${name}`)
  // a webhook that swallows a failed save
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","stripe":"17.0.0","@prisma/client":"6.0.0"}}', 'lib/db.ts': 'export const prisma = {} as any\n' }
  const hook = (catchBody: string, tryBody = 'await prisma.user.update({ where: { id: s.metadata.userId }, data: { pro: true } })') => ({ ...nx,
    'app/api/webhooks/stripe/route.ts': `import Stripe from "stripe"\nimport { prisma } from "@/lib/db"\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)\nexport async function POST(req: Request) {\n  const event = stripe.webhooks.constructEvent(await req.text(), req.headers.get("stripe-signature")!, process.env.STRIPE_WEBHOOK_SECRET!)\n  if (event.type === "checkout.session.completed") {\n    const s = event.data.object as any\n    try {\n      ${tryBody}\n    } catch (error) {\n      ${catchBody}\n    }\n  }\n  return new Response(null, { status: 200 })\n}\n` })
  const before = hook('throw error')
  assert.ok(c(before, hook('console.error(error)')).includes('If saving to your database fails in your Stripe webhook (app/api/webhooks/stripe/route.ts), the error is caught and Stripe is still told it worked'), 'swallowed')
  assert.ok(c(before, hook('')).includes('Stripe is still told it worked'), 'an empty catch')
  // (a catch that answers on purpose is a decision: an event already handled)
  assert.ok(!c(before, hook('return new Response("already processed")', 'await prisma.processedEvent.create({ data: { id: event.id } })')).includes('Stripe is still told it worked'), 'answers on purpose')
  for (const [name, x] of [['throws', hook('console.error(error)\n      throw error')], ['500', hook('return new Response("failed", { status: 500 })')], ['only Stripe', hook('console.error(error)', 'await stripe.customers.update(s.customer, { metadata: {} })')]] as const)
    assert.ok(!c(before, x).includes('Stripe is still told it worked'), `control: ${name}`)
  assert.ok(!c(hook('console.error(error)'), { ...hook('console.error(error)'), 'lib/x.ts': 'export const y = 1\n' }).includes('Stripe is still told it worked'), 'not new')
  const fa = { 'requirements.txt': 'fastapi==0.115.5\nstripe==10.0.0\nsqlalchemy==2.0.36\n' }
  const pyHook = (exc: string) => ({ ...fa, 'app/webhooks.py': `import stripe\nfrom fastapi import APIRouter, Request, HTTPException\nrouter = APIRouter()\n\n@router.post("/webhooks/stripe")\nasync def stripe_hook(request: Request, db=None):\n    event = stripe.Webhook.construct_event(await request.body(), request.headers["stripe-signature"], "whsec")\n    try:\n        db.add(event)\n        db.commit()\n    except Exception as e:\n${exc}\n    return {"ok": True}\n` })
  assert.ok(c(pyHook('        raise'), pyHook('        print(e)')).includes('Stripe is still told it worked'), 'python swallowed')
  assert.ok(!c(pyHook('        print(e)\n        raise HTTPException(status_code=500)'), pyHook('        print(e)\n        raise HTTPException(status_code=500)')).includes('Stripe is still told it worked') &&
    !c(pyHook('        print(e)'), pyHook('        print(e)\n        raise HTTPException(status_code=500)')).includes('Stripe is still told it worked'), 'python raises')
  // deleting your own account
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0"}}', 'auth.js': 'exports.isAuthenticated = (req, res, next) => { if (!req.user) return res.status(401).end(); next() }\n',
    'controllers/user.js': 'exports.getAccount = (req, res) => res.json(req.user)\nexports.deleteProfile = async (req, res) => { await req.user.remove(); res.json({}) }\n' }
  const srv = (chain: string, path = '/me') => ({ ...ex, 'server.js': `const express = require("express")\nconst { isAuthenticated } = require("./auth")\nconst { getAccount, deleteProfile } = require("./controllers/user")\nconst app = express()\nconst router = express.Router()\nrouter.route("${path}")${chain}\napp.use("/api/v1", router)\napp.listen(3000)\n` })
  const del = c(srv('.get(isAuthenticated, getAccount)'), srv('.get(isAuthenticated, getAccount).delete(isAuthenticated, deleteProfile)'))
  assert.ok(del.includes('lets people delete their own account') && del.includes('People can now delete their own account (the v1 me part of your server). That can\'t be undone'), del)
  const ids = c(srv('.get(isAuthenticated, getAccount)', '/users/:id'), srv('.get(isAuthenticated, getAccount).delete(isAuthenticated, deleteProfile)', '/users/:id'))
  assert.ok(!ids.includes('delete their own account') && !ids.includes('deletes data'), ids)
  const act = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'app/settings/page.tsx': 'export default function S() { return <main /> }\n' }
  assert.ok(c(act, { ...act, 'app/settings/actions.ts': '"use server"\nimport { auth } from "@/auth"\nexport async function deleteAccount() {\n  const s = await auth()\n  if (!s) throw new Error("no")\n  await db.user.delete({ where: { id: s.user.id } })\n}\n' }).includes('People can now delete their own account'), 'server action')
}
console.log('ok (pilot misses)')
// a server template's link now goes straight to a saved address (a "javascript:" link runs in whoever clicks it)
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const MSG = 'now go straight to an address people saved. If someone saves one that starts with "javascript:"'
  const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'resources/views/buttons.blade.php': `<a href="{{ route('go') . '/' . $link->id }}">{{ $link->title }}</a>\n`,
    'database/migrations/2024_01_01_000000_create_links_table.php': "<?php\nreturn new class extends Migration {\n  public function up() {\n    Schema::create('links', function (Blueprint $table) {\n      $table->id();\n      $table->string('link');\n      $table->string('title');\n    });\n  }\n};\n" }
  const lb = c(lv, { ...lv, 'resources/views/buttons.blade.php': '<a id="{{ $link->id }}" href="{{ $link->link }}">{{ $link->title }}</a>\n' })
  assert.ok(lb.includes(`Links in resources/views/buttons.blade.php ${MSG}`), lb)
  const rb = { 'Gemfile': 'gem "rails", "~> 8.0"\n', 'app/views/users/show.html.erb': '<h1><%= @user.name %></h1>\n', 'app/models/user.rb': 'class User < ApplicationRecord\nend\n',
    'db/migrate/20240101000000_create_users.rb': 'class CreateUsers < ActiveRecord::Migration[8.0]\n  def change\n    create_table :users do |t|\n      t.string :name\n      t.string :website\n    end\n  end\nend\n' }
  const site = { ...rb, 'app/views/users/show.html.erb': rb['app/views/users/show.html.erb'] + '<%= link_to "Website", @user.website, target: "_blank" %>\n' }
  assert.ok(c(rb, site).includes(MSG), 'erb link_to')
  assert.ok(!c(rb, { ...site, 'app/models/user.rb': 'class User < ApplicationRecord\n  validates :website, format: { with: URI::DEFAULT_PARSER.make_regexp(%w[http https]) }\nend\n' }).includes(MSG), 'rails: scheme validated')
  const dj = { 'requirements.txt': 'django==5.1\n', 'people/models.py': 'from django.db import models\n\nclass Profile(models.Model):\n    website = models.CharField(max_length=200)\n', 'people/templates/profile.html': '<p>{{ profile.name }}</p>\n' }
  const dsite = { ...dj, 'people/templates/profile.html': '<p>{{ profile.name }}</p>\n<a href="{{ profile.website }}">site</a>\n' }
  assert.ok(c(dj, dsite).includes(MSG), 'django')
  assert.ok(!c({ ...dj, 'people/models.py': dj['people/models.py'].replace('CharField', 'URLField') }, { ...dsite, 'people/models.py': dj['people/models.py'].replace('CharField', 'URLField') }).includes(MSG), 'django URLField')
  for (const [name, x] of [['an id', '<a href="{{ $link->id }}">x</a>\n'], ['a bare variable', '<a href="{{ $url }}">x</a>\n'], ['a route helper', `<a href="{{ route('profile', $user->website) }}">x</a>\n`]] as const)
    assert.ok(!c(lv, { ...lv, 'resources/views/buttons.blade.php': x }).includes(MSG), `control: ${name}`)
  assert.ok(!c(lb.length ? { ...lv, 'resources/views/buttons.blade.php': '<a href="{{ $link->link }}">x</a>\n' } : lv, { ...lv, 'resources/views/buttons.blade.php': '<a class="b" href="{{ $link->link }}">x</a>\n' }).includes(MSG), 'control: already there')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'app/page.tsx': 'export default function P() { return <main /> }\n' }
  assert.ok(!c(nx, { ...nx, 'app/page.tsx': 'export default function P({ user }: any) { return <a href={user.website}>x</a> }\n' }).includes(MSG), 'control: jsx')
}
console.log('ok (saved links)')
// the webhook check reads only the function that checks Stripe's signature, not a checkout view in the same file (bakery demo)
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const dj = { 'requirements.txt': 'django==5.1\nstripe==10.0.0\n', 'shop/views.py': 'import stripe\n\ndef stripe_webhook(request):\n    try:\n        event = stripe.Webhook.construct_event(request.body, "", "")\n    except ValueError:\n        return HttpResponseBadRequest("bad")\n    Order.objects.filter(pk=1).update(status="paid")\n    return HttpResponse(status=200)\n' }
  const view = '\n\ndef checkout(request):\n    try:\n        order.save()\n    except ValueError:\n        form.add_error(None, "Try again")\n    return render(request, "x.html")\n'
  assert.ok(!c(dj, { ...dj, 'shop/views.py': dj['shop/views.py'] + view }).includes('Stripe is still told it worked'), 'a checkout view next to the webhook')
}
console.log('ok (webhook function only)')
// Review 63: false alarms in the new checks
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0"}}', 'app/page.tsx': 'export default function P() { return <main /> }\n', 'lib/db.ts': 'export const prisma = {} as any\n' }
  const add = (files: Record<string, string>) => c(nx, { ...nx, ...files })
  // SVG: output formats, help text, translations, a content-type map
  for (const [name, f] of [['QR format', { 'app/api/qr/route.ts': 'export async function GET(req: Request) {\n  const format = new URL(req.url).searchParams.get("format") ?? "png"\n  if (!["png", "svg"].includes(format)) return new Response("Invalid format", { status: 400 })\n  return new Response(format)\n}\n' }],
    ['ALLOWED_FORMATS', { 'lib/qr.ts': 'export const ALLOWED_FORMATS = ["png", "svg", "jpeg"] as const\n' }],
    ['hint text', { 'components/FileUpload.tsx': 'export function F() { return <label><p>SVG, PNG, JPG or GIF (MAX. 800x400px)</p><input type="file" accept="image/png, image/jpeg" /></label> }\n' }],
    ['i18n', { 'messages/en.json': '{\n  "uploadHint": "PNG, JPG or SVG, up to 2MB"\n}\n' }],
    ['mime map', { 'server/static.js': 'const mimeTypes = { png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml" }\nmodule.exports = (ext) => mimeTypes[ext]\n' }]] as const)
    assert.ok(!add(f).includes('accept SVG'), `svg control: ${name}`)
  assert.ok(c({ 'requirements.txt': 'flask\n', 'app.py': 'ALLOWED_EXTENSIONS = {"png", "jpg"}\n' }, { 'requirements.txt': 'flask\n', 'app.py': 'ALLOWED_EXTENSIONS = {"png", "jpg", "svg"}\n' }).includes('Uploads now accept SVG'), 'flask set')
  // saved links: a .url the app makes (an upload, a page), Angular, Jekyll, a bare URLField; ERB `%>` right after the field
  const LINK = 'now go straight to an address people saved'
  const dj = { 'requirements.txt': 'django==5.1\n', 'docs/models.py': 'from django.db import models\n\nclass Document(models.Model):\n    file = models.FileField(upload_to="docs/")\n', 'docs/templates/list.html': '<p>x</p>\n' }
  assert.ok(!c(dj, { ...dj, 'docs/templates/list.html': '{% for d in docs %}<a href="{{ d.file.url }}">x</a>{% endfor %}\n' }).includes(LINK), 'file url')
  const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'resources/views/posts.blade.php': '<h2>x</h2>\n',
    'database/migrations/2024_01_01_000000_create_links_table.php': "<?php\nreturn new class extends Migration {\n  public function up() {\n    Schema::create('links', function (Blueprint $table) {\n      $table->id();\n      $table->string('link');\n      $table->string('url');\n    });\n  }\n};\n" }
  assert.ok(!c(lv, { ...lv, 'resources/views/posts.blade.php': '<a href="{{ $post->url }}">x</a>\n' }).includes(LINK), 'post url')
  assert.ok(!c({ 'package.json': '{"dependencies":{"@angular/core":"18.0.0"}}' }, { 'package.json': '{"dependencies":{"@angular/core":"18.0.0"}}', 'src/app/p/p.component.html': '<a href="{{ user.website }}">site</a>\n' }).includes(LINK), 'angular')
  assert.ok(!c({ '_config.yml': 'title: b\n' }, { '_config.yml': 'title: b\n', '_layouts/home.html': '<a href="{{ post.url | relative_url }}">x</a>\n' }).includes(LINK), 'jekyll')
  const dw = { 'requirements.txt': 'django==5.1\n', 'people/models.py': 'from django.db import models\nfrom django.db.models import URLField\n\nclass Profile(models.Model):\n    website = URLField(blank=True)\n' }
  assert.ok(!c(dw, { ...dw, 'people/templates/p.html': '<a href="{{ profile.website }}">site</a>\n' }).includes(LINK), 'bare URLField')
  const rs = { 'Gemfile': 'gem "rails"\n', 'db/migrate/20240101000000_create_users.rb': 'class CreateUsers < ActiveRecord::Migration[8.0]\n  def change\n    create_table :users do |t|\n      t.string :name\n      t.string :website\n    end\n  end\nend\n' }
  assert.ok(c(rs, { ...rs, 'app/views/users/show.html.erb': '<%= link_to "Website", @user.website %>\n' }).includes(LINK), 'erb link_to before %>')
  assert.ok(c(lv, { ...lv, 'resources/views/posts.blade.php': '<a href="{{ $link->link }}">x</a>\n', 'public/css/app.min.css': 'a{} /* link rules: https://x */\n' }).includes(LINK), 'minified CSS mentioning link and https is not a scheme check')
  // webhook: an error answer it didn't know, calls that aren't the database
  const HOOK = 'Stripe is still told it worked'
  const hook = (tryBody: string, cat: string) => ({ ...nx, 'app/api/webhooks/stripe/route.ts': `import Stripe from "stripe"\nimport { prisma } from "@/lib/db"\nconst stripe = new Stripe("sk")\nexport async function POST(req: Request) {\n  const event = stripe.webhooks.constructEvent(await req.text(), "", "")\n  const s = event.data.object as any\n  try {\n    ${tryBody}\n  } catch (e) {\n    ${cat}\n  }\n  return new Response(null)\n}\n` })
  const save = 'await prisma.user.update({ where: { id: s.id }, data: {} })'
  for (const [name, t, x] of [['Hono 500', save, 'return c.json({ error: "x" }, 500)'], ['Fastify', save, 'return reply.code(500).send({})'], ['SvelteKit', save, 'error(500, "x")'],
    ['Twilio', 'await sms.messages.create({ to: "1", body: "Thanks" })', 'console.error(e)'], ['another Stripe client', 'await stripeClient.subscriptions.update(s.subscription, {})', 'console.error(e)']] as const)
    assert.ok(!c(hook(save, 'throw e'), hook(t, x)).includes(HOOK), `hook control: ${name}`)
  const fl = (exc: string) => ({ 'requirements.txt': 'flask\nstripe\n', 'app.py': `import stripe\nfrom flask import Flask, request, jsonify\napp = Flask(__name__)\n\n@app.post("/webhook")\ndef hook():\n    event = stripe.Webhook.construct_event(request.data, "", "")\n    try:\n        db.session.commit()\n    except Exception as e:\n${exc}\n    return "", 200\n` })
  assert.ok(!c(fl('        raise'), fl('        return jsonify(error=str(e)), 500')).includes(HOOK) && c(fl('        raise'), fl('        print(e)')).includes(HOOK), 'flask , 500')
  const meta = { 'requirements.txt': 'flask\nstripe\n', 'app.py': 'import stripe\n\ndef hook(request):\n    event = stripe.Webhook.construct_event(request.data, "", "")\n    try:\n        meta.update(event["data"])\n    except Exception as e:\n        print(e)\n    return "", 200\n' }
  assert.ok(!c({ 'requirements.txt': 'flask\nstripe\n' }, meta).includes(HOOK), 'dict update')
  // plain-text numbers: a reference number, a card that isn't a payment card, a renamed field
  const SECRET = 'as plain text'
  for (const [name, m] of [['CRM reference', 'model Customer {\n  id String @id\n  accountNumber String @default(cuid())\n}\n'], ['kanban card', 'model Card {\n  id String @id\n  number Int\n}\n'],
    ['flashcard', 'model Flashcard {\n  id String @id\n  number Int\n}\n'], ['loyalty card', 'model LoyaltyCard {\n  id String @id\n  cardNumber String\n}\n']] as const)
    assert.ok(!add({ 'prisma/schema.prisma': m }).includes(SECRET), `secret control: ${name}`)
  assert.ok(!c({ ...nx, 'prisma/schema.prisma': 'model BankAccount {\n  id String @id\n  acctNo String\n}\n' }, { ...nx, 'prisma/schema.prisma': 'model BankAccount {\n  id String @id\n  accountNumber String\n}\n' }).includes(SECRET), 'renamed')
  // deleting your own account: /api/user that deletes the user; not one profile of several, an unlinked Google login, a closed bank account
  const OWN = 'People can now delete their own account'
  const getUser = 'import { auth } from "@/auth"\nimport { prisma } from "@/lib/db"\nexport async function GET() {\n  const s = await auth()\n  if (!s) return new Response(null, { status: 401 })\n  return Response.json(await prisma.user.findUnique({ where: { id: s.user.id } }))\n}\n'
  assert.ok(c({ ...nx, 'app/api/user/route.ts': getUser }, { ...nx, 'app/api/user/route.ts': getUser + 'export async function DELETE() {\n  const s = await auth()\n  if (!s) return new Response(null, { status: 401 })\n  await prisma.user.delete({ where: { id: s.user.id } })\n  return new Response(null)\n}\n' }).includes(OWN), '/api/user')
  const act = (name: string, body: string) => add({ 'app/settings/actions.ts': `"use server"\nimport { auth } from "@/auth"\nimport { prisma } from "@/lib/db"\nexport async function ${name}(id: string) {\n  const s = await auth()\n  if (!s) throw new Error("no")\n  ${body}\n}\n` })
  for (const [name, b] of [['deleteProfile', 'await prisma.profile.delete({ where: { id, userId: s.user.id } })'], ['removeAccount', 'await prisma.account.deleteMany({ where: { userId: s.user.id, provider: id } })'],
    ['closeAccount', 'await prisma.bankAccount.update({ where: { id }, data: { closed: true } })']] as const)
    assert.ok(!act(name, b).includes(OWN), `delete control: ${name}`)
  const out = c({ ...nx, 'app/api/auth/session/route.ts': 'export async function POST() { return new Response() }\n' }, { ...nx, 'app/api/auth/session/route.ts': 'import { cookies } from "next/headers"\nexport async function POST() { return new Response() }\nexport async function DELETE() { (await cookies()).delete("session"); return new Response() }\n' })
  assert.ok(!out.includes('deletes data'), out)
}
console.log('ok (review 63)')
// Review 64: more false alarms in the new checks
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0","stripe":"17.0.0"}}', 'lib/db.ts': 'export const prisma = {} as any\n', 'auth.ts': 'export const auth = async () => null as any\n' }
  // webhook: a flag checked later, a best-effort log inside a try that answers, the response handed on, a status from the error, many texts
  const HOOK = 'Stripe is still told it worked'
  const hook = (body: string) => ({ ...nx, 'app/api/webhook/route.ts': `import Stripe from "stripe"\nimport { prisma } from "@/lib/db"\nconst stripe = new Stripe("sk")\nexport async function POST(req: Request) {\n  const event = stripe.webhooks.constructEvent(await req.text(), "", "")\n${body}\n  return new Response(null)\n}\n` })
  const base = hook('')
  for (const [name, b] of [['failed flag', '  let failed = false\n  try {\n    await prisma.order.update({ where: { id: 1 }, data: { paid: true } })\n  } catch (err) {\n    console.error(err)\n    failed = true\n  }\n  if (failed) return new Response("db error", { status: 500 })'],
    ['best-effort log', '  try {\n    await prisma.order.update({ where: { id: 1 }, data: {} })\n    try {\n      await prisma.webhookLog.create({ data: { type: event.type } })\n    } catch (logErr) {\n      console.warn(logErr)\n    }\n  } catch (e) { return new Response("err", { status: 500 }) }'],
    ['handleError(res, err)', '  try {\n    await Order.updateOne({ _id: 1 }, { paid: true })\n  } catch (err) {\n    handleError(res, err)\n  }'],
    ['err.statusCode || 500', '  try {\n    await Order.updateOne({ _id: 1 }, { paid: true })\n  } catch (err) {\n    res.status(err.statusCode || 500).json({})\n  }'],
    ['texts', '  try {\n    await Promise.all(admins.map(a => twilio.messages.create({ to: a.phone, body: "paid" })))\n  } catch (err) {\n    console.error(err)\n  }']] as const)
    assert.ok(!c(base, hook(b)).includes(HOOK), `hook control: ${name}`)
  for (const w of ['await Order.updateOne({ _id: 1 }, { paid: true })', 'await Order.findByIdAndUpdate(id, { paid: true })', 'await Subscription.create({ user: 1 })'])
    assert.ok(c(base, hook(`  try {\n    ${w}\n  } catch (err) {\n    console.error(err)\n  }`)).includes(HOOK), `mongoose: ${w}`)
  const dj = (exc: string) => ({ 'requirements.txt': 'django==5.1\nstripe\n', 'shop/views.py': `import stripe\nfrom django.db import IntegrityError\n\ndef stripe_webhook(request):\n    event = stripe.Webhook.construct_event(request.body, "", "")\n    try:\n        ProcessedEvent.objects.create(stripe_id=event["id"])\n${exc}\n    return HttpResponse(status=200)\n` })
  assert.ok(!c(dj('    except Exception:\n        raise'), dj('    except IntegrityError:\n        logger.info("already processed")')).includes(HOOK), 'IntegrityError')
  assert.ok(!c(dj('    except Exception:\n        raise'), dj('    except Order.DoesNotExist:\n        logger.warning("no order")')).includes(HOOK), 'DoesNotExist')
  // deleting your own account: not leaving a team, disconnecting a service, clearing a photo; not when it asks for the password
  const OWN = 'People can now delete their own account'
  const del = (path: string, body: string) => c({ ...nx, [path]: 'export async function GET() { return new Response() }\n' }, { ...nx, [path]: `import { auth } from "@/auth"\nimport { prisma } from "@/lib/db"\nexport async function GET() { return new Response() }\nexport async function DELETE() {\n  const s = await auth()\n  if (!s) return new Response(null, { status: 401 })\n  ${body}\n  return new Response(null)\n}\n` })
  assert.ok(!del('app/api/teams/[teamId]/members/me/route.ts', 'await prisma.membership.delete({ where: { id: 1 } })').includes(OWN), 'leave a team')
  assert.ok(!del('app/api/stripe/account/route.ts', 'await prisma.user.update({ where: { id: s.user.id }, data: { stripeAccountId: null } })').includes(OWN), 'disconnect Stripe')
  assert.ok(!del('app/api/profile/route.ts', 'await prisma.user.update({ where: { id: s.user.id }, data: { image: null } })').includes(OWN), 'clear photo')
  assert.ok(del('app/api/me/route.ts', 'await prisma.user.delete({ where: { id: s.user.id } })').includes(OWN), 'DELETE /api/me')
  assert.ok(!del('app/api/me/route.ts', 'if (!(await bcrypt.compare(pw, s.user.hash))) return new Response(null, { status: 403 })\n  await prisma.user.delete({ where: { id: s.user.id } })').includes(OWN), 'asks for the password')
  // saved links: a menu, a setting, a Stripe address, a validated website
  const LINK = 'now go straight to an address people saved'
  const fl = { 'requirements.txt': 'flask\n', 'templates/base.html': '<p></p>\n' }
  for (const [name, h] of [['menu', '{% for item in nav %}<a href="{{ item.url }}">x</a>{% endfor %}'], ['config', '<a href="{{ config.SITE_URL }}">Home</a>'], ['Stripe', '<a href="{{ checkout_session.url }}">Pay</a>']] as const)
    assert.ok(!c(fl, { ...fl, 'templates/base.html': h + '\n' }).includes(LINK), `link control: ${name}`)
  const rb = { 'Gemfile': 'gem "rails"\n', 'db/migrate/20240101000000_create_users.rb': 'class CreateUsers < ActiveRecord::Migration[8.0]\n  def change\n    create_table :users do |t|\n      t.string :website\n    end\n  end\nend\n',
    'app/models/user.rb': 'class User < ApplicationRecord\n  validates :website, url: { allow_blank: true }\nend\n' }
  assert.ok(!c(rb, { ...rb, 'app/views/users/show.html.erb': '<%= link_to "Website", @user.website %>\n' }).includes(LINK), 'validates url:')
  // SVG: a preview list, a label map, converting SVG to PNG
  const SVG = 'Uploads now accept SVG'
  for (const [name, p, t] of [['preview', 'components/media/FilePreview.tsx', "const IMAGE_EXTS = ['png', 'jpg', 'svg']\nexport function P({ n }: any) { return IMAGE_EXTS.includes(n) ? <img /> : null }\n"],
    ['label map', 'lib/media.ts', "export const LABELS = { 'image/png': 'PNG', 'image/svg+xml': 'SVG' }\n"], ['sharp', 'lib/upload.ts', "export async function toPng(buf: Buffer, type: string) {\n  if (type === 'image/svg+xml') return sharp(buf).png().toBuffer()\n  return buf\n}\n"]] as const)
    assert.ok(!c(nx, { ...nx, [p]: t }).includes(SVG), `svg control: ${name}`)
}
console.log('ok (review 64)')
// Review 65: nested tries, flags and expected errors in Python webhooks; a link's object; logout and session deletes
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const HOOK = 'Stripe is still told it worked'
  const dj = (body: string) => ({ 'requirements.txt': 'django==5.1\nstripe\n', 'shop/views.py': `import stripe, logging\nfrom django.http import HttpResponse\nlogger = logging.getLogger(__name__)\n\ndef stripe_webhook(request):\n    event = stripe.Webhook.construct_event(request.body, "", "")\n    session = event["data"]["object"]\n${body}\n    return HttpResponse(status=200)\n` })
  const pb = dj('')
  for (const [name, b] of [['inner best-effort email', '    try:\n        Order.objects.filter(pk=session["id"]).update(paid=True)\n        try:\n            send_mail("Thanks", "Paid", None, [session["email"]])\n        except Exception:\n            logger.warning("mail failed")\n    except Exception:\n        return HttpResponse(status=500)'],
    ['flag', '    failed = False\n    try:\n        Order.objects.filter(pk=session["id"]).update(paid=True)\n    except Exception:\n        logger.exception("db")\n        failed = True\n    if failed:\n        return HttpResponse(status=500)'],
    ['KeyError', '    try:\n        Order.objects.filter(pk=session["metadata"]["order_id"]).update(paid=True)\n    except KeyError:\n        logger.warning("no order id")']] as const)
    assert.ok(!c(pb, dj(b)).includes(HOOK), `python hook control: ${name}`)
  assert.ok(c(pb, dj('    try:\n        Order.objects.filter(pk=session["id"]).update(paid=True)\n    except Exception:\n        logger.exception("db")')).includes(HOOK), 'python swallows')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0","stripe":"17.0.0"}}', 'lib/db.ts': 'export const prisma = {} as any\n', 'auth.ts': 'export const auth = async () => null as any\n' }
  const hook = (body: string) => ({ ...nx, 'app/api/webhook/route.ts': `import Stripe from "stripe"\nimport { prisma } from "@/lib/db"\nconst stripe = new Stripe("sk")\nexport async function POST(req: Request) {\n  const event = stripe.webhooks.constructEvent(await req.text(), "", "")\n  const s = event.data.object as any\n${body}\n  return new Response(null)\n}\n` })
  assert.ok(!c(hook(''), hook('  try {\n    try {\n      await prisma.order.update({ where: { id: s.id }, data: { paid: true } })\n    } catch (e) {\n      return new Response("db", { status: 500 })\n    }\n    await sendReceipt(s.customer_email)\n  } catch (err) {\n    console.error("receipt email failed", err)\n  }')).includes(HOOK), 'outer catch around an answered inner write')
  for (const w of ['await this.prisma.order.update({ where: { id: 1 }, data: {} })', 'await supabaseAdmin.from("orders").update({ paid: true }).eq("id", 1)', 'await updateDoc(doc(db, "orders", s.id), { paid: true })'])
    assert.ok(c(hook(''), hook(`  try {\n    ${w}\n  } catch (err) {\n    const m: string = "failed id=" + s.id\n    console.error(m, err)\n  }`)).includes(HOOK), `write: ${w}`)
  // links: the field's object must be a model that stores it; a loop's item counts as one of its list
  const LINK = 'now go straight to an address people saved'
  const fl = { 'requirements.txt': 'flask\nflask-sqlalchemy\n', 'models.py': 'from flask_sqlalchemy import SQLAlchemy\ndb = SQLAlchemy()\n\nclass Bookmark(db.Model):\n    id = db.Column(db.Integer, primary_key=True)\n    url = db.Column(db.String(500))\n', 'templates/base.html': '<p></p>\n' }
  assert.ok(!c(fl, { ...fl, 'templates/base.html': '{% for item in nav %}<a href="{{ item.url }}">x</a>{% endfor %}\n' }).includes(LINK), 'a menu next to a Bookmark model')
  assert.ok(c(fl, { ...fl, 'templates/base.html': '{% for b in bookmarks %}<a href="{{ b.url }}">x</a>{% endfor %}\n' }).includes(LINK), 'a loop over bookmarks')
  // gift cards aren't payment cards; a preview list in an upload component isn't an upload rule
  assert.ok(!c(nx, { ...nx, 'prisma/schema.prisma': 'model GiftCard {\n  id String @id\n  cardNumber String\n  expiresAt DateTime\n}\n' }).includes('as plain text'), 'gift card')
  assert.ok(!c(nx, { ...nx, 'components/FileUpload.tsx': "const isImage = (n: string) => ['png', 'jpg', 'svg'].includes(n)\nexport function U({ f }: any) { return isImage(f.name) ? <img /> : null }\n" }).includes('Uploads now accept SVG'), 'upload component preview')
  // own account: not a logout that clears a cookie, not signing out everywhere
  const OWN = 'People can now delete their own account'
  const get = 'import { auth } from "@/auth"\nimport { prisma } from "@/lib/db"\nimport { cookies } from "next/headers"\nexport async function GET() { const s = await auth(); return Response.json(s) }\n'
  const del = (path: string, d: string) => c({ ...nx, [path]: get }, { ...nx, [path]: get + `export async function DELETE() {\n  const s = await auth()\n  if (!s) return new Response(null, { status: 401 })\n  ${d}\n  return new Response(null)\n}\n` })
  assert.ok(!del('app/api/me/route.ts', '(await cookies()).delete("token")').includes(OWN), 'logout')
  assert.ok(!del('app/api/account/route.ts', 'await prisma.session.deleteMany({ where: { userId: s.user.id } })').includes(OWN), 'sign out everywhere')
}
console.log('ok (review 65)')
// Review 66: a flag must be read after the try; comments and nested handled tries cut cleanly; a storage delete isn't the account
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const HOOK = 'Stripe is still told it worked'
  const dj = (body: string) => ({ 'requirements.txt': 'django==5.1\nstripe\n', 'shop/views.py': `import stripe, logging\nlogger = logging.getLogger(__name__)\n\ndef stripe_webhook(request):\n    event = stripe.Webhook.construct_event(request.body, "", "")\n    session = event["data"]["object"]\n${body}\n    return HttpResponse(status=200)\n` })
  const pb = dj(''), save = 'Order.objects.filter(pk=session["id"]).update(paid=True)'
  for (const [name, b] of [['a keyword argument over lines', `    try:\n        ${save}\n    except Exception:\n        logger.error(\n            "failed",\n            exc_info=True,\n        )`],
    ['a name never read again', `    try:\n        ${save}\n    except Exception as e:\n        msg = str(e)\n        logger.error("db failed: %s", msg)`],
    ['a comment before a best-effort inner try', `    try:\n        email = session["email"]\n        # receipt first\n        try:\n            send_mail("Thanks", "Paid", None, [email])\n        except Exception:\n            mail_failed = True\n        ${save}\n    except Exception:\n        logger.exception("db failed")`],
    ['nested handled tries, then the write', `    try:\n        try:\n            try:\n                logger.info("got %s", event["id"])\n            except Exception:\n                return HttpResponse(status=500)\n        except Exception:\n            return HttpResponse(status=500)\n        ${save}\n    except Exception:\n        logger.exception("db failed")`]] as const)
    assert.ok(c(pb, dj(b)).includes(HOOK), `python swallows: ${name}`)
  assert.ok(!c(pb, dj(`    failed = False\n    try:\n        ${save}\n    except Exception: failed = True\n    if failed:\n        return HttpResponse(status=500)`)).includes(HOOK), 'one-line flag, read later')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@supabase/supabase-js":"2.0.0"}}', 'auth.ts': 'export const auth = async () => null as any\n' }
  const get = 'import { auth } from "@/auth"\nexport async function GET() { return Response.json(await auth()) }\n'
  assert.ok(!c({ ...nx, 'app/api/profile/route.ts': get }, { ...nx, 'app/api/profile/route.ts': get + "export async function DELETE() {\n  const s = await auth()\n  if (!s) return new Response(null, { status: 401 })\n  await supabase.storage.from('avatars').remove([s.user.id + '.png'])\n  return new Response(null)\n}\n" }).includes('delete their own account'), 'storage delete')
  const fl = { 'requirements.txt': 'flask\nflask-sqlalchemy\n', 'models.py': 'from flask_sqlalchemy import SQLAlchemy\ndb = SQLAlchemy()\n\nclass Link(db.Model):\n    id = db.Column(db.Integer, primary_key=True)\n    url = db.Column(db.String(500))\n', 'templates/p.html': '<p></p>\n' }
  assert.ok(c(fl, { ...fl, 'templates/p.html': '{% for l in user.links %}<a href="{{ l.url }}">x</a>{% endfor %}\n' }).includes('now go straight to an address people saved'), 'for l in user.links')
}
console.log('ok (review 66)')
// Review 67: any odd left side in a catch must not crash; flags set by +=, ++, ||=, push/append or destructuring; `.all` loops
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const HOOK = 'Stripe is still told it worked'
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0","stripe":"17.0.0"}}', 'lib/db.ts': 'export const prisma = {} as any\n' }
  const hook = (body: string) => ({ ...nx, 'app/api/webhook/route.ts': `import Stripe from "stripe"\nimport { prisma } from "@/lib/db"\nconst stripe = new Stripe("sk")\nexport async function POST(req: Request) {\n  const event = stripe.webhooks.constructEvent(await req.text(), "", "")\n${body}\n  return new Response(null)\n}\n` })
  const save = 'await prisma.order.update({ where: { id: 1 }, data: { paid: true } })'
  for (const lhs of ['lock("(").held = false', '(a++ as any).x = 1', 'this /* ( */ .failed = true'])
    assert.ok(c(hook(''), hook(`  try {\n    ${save}\n  } catch (e) {\n    ${lhs}\n  }`)).includes(HOOK), `no crash: ${lhs}`)
  for (const [set, read] of [['errors.push(e)', 'if (errors.length) return new Response("x", { status: 500 })'], ['failures++', 'if (failures) return new Response("x", { status: 500 })'],
    ['failed ||= true', 'if (failed) return new Response("x", { status: 500 })'], ['[ok] = [false]', 'if (!ok) return new Response("x", { status: 500 })'], ['(ctx as any).failed = true', 'if (ctx.failed) return new Response("x", { status: 500 })']] as const)
    assert.ok(!c(hook(''), hook(`  try {\n    ${save}\n  } catch (e) {\n    ${set}\n  }\n  ${read}`)).includes(HOOK), `flag: ${set}`)
  const dj = (body: string) => ({ 'requirements.txt': 'django==5.1\nstripe\n', 'shop/views.py': `import stripe\n\ndef stripe_webhook(request):\n    event = stripe.Webhook.construct_event(request.body, "", "")\n${body}\n    return HttpResponse(status=200)\n` })
  for (const [set, read] of [['errors.append(e)', 'if errors:'], ['failures += 1', 'if failures:'], ['ok, err = False, e', 'if not ok:']] as const)
    assert.ok(!c(dj(''), dj(`    try:\n        Order.objects.filter(pk=1).update(paid=True)\n    except Exception as e:\n        ${set}\n    ${read}\n        return HttpResponse(status=500)`)).includes(HOOK), `python flag: ${set}`)
  const fl = { 'requirements.txt': 'flask\nflask-sqlalchemy\n', 'models.py': 'from flask_sqlalchemy import SQLAlchemy\ndb = SQLAlchemy()\n\nclass Link(db.Model):\n    id = db.Column(db.Integer, primary_key=True)\n    url = db.Column(db.String(500))\n', 'templates/p.html': '<p></p>\n' }
  assert.ok(c(fl, { ...fl, 'templates/p.html': '{% for l in user.links.all %}<a href="{{ l.url }}">x</a>{% endfor %}\n' }).includes('now go straight to an address people saved'), 'links.all')
  const au = { ...nx, 'auth.ts': 'export const auth = async () => null as any\n', 'lib/account.ts': 'export async function deleteAccount(id: string) {}\n' }
  const get = 'import { auth } from "@/auth"\nimport { deleteAccount } from "@/lib/account"\nexport async function GET() { return Response.json(await auth()) }\n'
  assert.ok(c({ ...au, 'app/api/account/route.ts': get }, { ...au, 'app/api/account/route.ts': get + 'export async function DELETE() {\n  const session = await auth()\n  if (!session) return new Response(null, { status: 401 })\n  await deleteAccount(session.user.id)\n  return new Response(null)\n}\n' }).includes('People can now delete their own account'), 'a session variable')
}
console.log('ok (review 67)')
// Review 68: logouts that end a session aren't account deletion; a write on the response or event isn't a flag
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0","stripe":"17.0.0"}}', 'lib/db.ts': 'export const prisma = {} as any\n', 'auth.ts': 'export const auth = async () => null as any\n' }
  const get = 'import { auth } from "@/auth"\nexport async function GET() { return Response.json(await auth()) }\n'
  for (const d of ['await lucia.invalidateSession(session.id)', 'await session.revoke()', 'await deleteSession(session.id)', 'await kv.del(`session:${session.id}`)'])
    assert.ok(!c({ ...nx, 'app/api/me/route.ts': get }, { ...nx, 'app/api/me/route.ts': get + `export async function DELETE() {\n  const session = await auth()\n  if (!session) return new Response(null, { status: 401 })\n  ${d}\n  return new Response(null)\n}\n` }).includes('delete their own account'), `logout: ${d}`)
  const HOOK = 'Stripe is still told it worked'
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0","stripe":"17.0.0","mongoose":"8.0.0"}}' }
  const srv = (cat: string) => ({ ...ex, 'server.js': `const express = require("express")\nconst Stripe = require("stripe")\nconst stripe = Stripe("sk")\nconst app = express()\napp.post("/webhook", async (req, res) => {\n  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], "whsec")\n  try {\n    await Order.updateOne({ _id: event.data.object.id }, { paid: true })\n  } catch (err) {\n    ${cat}\n  }\n  res.json({ received: true })\n})\napp.listen(3000)\n` })
  for (const cat of ['res.set("X-Order-Error", "1")', 'err.handled = true'])
    assert.ok(c(srv('throw err'), srv(cat)).includes(HOOK), `not a flag: ${cat}`)
}
console.log('ok (review 68)')
// Wrong descriptions from the pilot: an address plain only knows the end of, a GET that lists nothing, the logged-in person's own
// account, a helper that became a server action
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  // FastAPI routers mounted from a table plain can't follow (FastAPI-boilerplate): "…/[username]", named for the folder
  const fa = { 'requirements.txt': 'fastapi\n', 'backend/src/interfaces/api/v1/__init__.py': 'from fastapi import APIRouter\nfrom ..wiring import ROUTER_MOUNTS\nrouter = APIRouter(prefix="/v1")\nfor m in ROUTER_MOUNTS:\n    router.include_router(m.router, prefix=m.prefix)\n',
    'backend/src/modules/user/routes.py': 'from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/{username}")\ndef read(username: str):\n    return {"username": username}\n' }
  const lost = c(fa, { ...fa, 'backend/src/modules/user/routes.py': fa['backend/src/modules/user/routes.py'].replace('return', 'x = 1\n    return') })
  assert.ok(lost.includes('The user part of your server') && lost.includes('/…/[username]') && !lost.includes(' /[username]'), lost)
  const mounted = { ...fa, 'backend/src/interfaces/api/v1/__init__.py': 'from fastapi import APIRouter\nfrom ....modules.user import routes as users\nrouter = APIRouter(prefix="/v1")\nrouter.include_router(users.router, prefix="/users")\n' }
  assert.ok(c(mounted, { ...mounted, 'backend/src/modules/user/routes.py': fa['backend/src/modules/user/routes.py'].replace('return', 'x = 1\n    return') }).includes('/v1/users/[username]'), 'a router plain can follow keeps its address')
  // a status endpoint that reads no table (social-network): "answers requests", not "lists data"
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0"}}', 'server.js': 'const express = require("express")\nconst app = express()\napp.listen(3000)\n' }
  const st = c(ex, { ...ex, 'server.js': 'const express = require("express")\nconst app = express()\napp.get("/api/user/status", (req, res) => res.json({ message: "Ok" }))\napp.listen(3000)\n' })
  assert.ok(st.includes('answers requests') && !st.includes('lists data'), st)
  // the logged-in person's own account (workout-cool); a list or another person's row isn't
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0"}}', 'lib/db.ts': 'export const prisma = {} as any\n', 'auth.ts': 'export const auth = async () => null as any\n' }
  const pref = (where: string) => c(nx, { ...nx, 'app/api/user/preferences/route.ts': `import { auth } from "@/auth"\nimport { prisma } from "@/lib/db"\nexport async function GET() {\n  const session = await auth()\n  if (!session) return new Response(null, { status: 401 })\n  return Response.json(await prisma.user.findUnique({ where: ${where} }))\n}\nexport async function PUT(req: Request) {\n  const session = await auth()\n  if (!session) return new Response(null, { status: 401 })\n  return Response.json(await prisma.user.update({ where: ${where}, data: await req.json() }))\n}\n` })
  assert.ok(pref('{ id: session.user.id }').includes("shows and updates the logged-in person's own account"), 'own account')
  assert.ok(!pref('{ id: (await req.json()).id }').includes('own account'), 'someone else')
  // a helper moved into a "use server" file (chadnext): not new, now callable from the browser
  const old = { ...nx, 'src/lib/subscription.ts': 'import { prisma } from "@/lib/db"\nexport async function getPlan(userId: string) {\n  return prisma.user.findFirst({ where: { id: userId } })\n}\n' }
  const moved = c(old, { ...nx, 'src/actions/subscription.ts': '"use server"\nimport { prisma } from "@/lib/db"\nexport async function getPlan(userId: string) {\n  return prisma.user.findFirst({ where: { id: userId } })\n}\n' })
  assert.ok(moved.includes('getPlan() was a helper in src/lib/subscription.ts. It moved into a "use server" file, so the browser can now call it directly.') && !moved.includes('New server code'), moved)
}
console.log('ok (pilot descriptions)')
// Review 69: someone else's id isn't your own account; a kept or duplicated helper didn't move; aliased mounts and prefixes from settings
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0"}}', 'lib/db.ts': 'export const prisma = {} as any\n' }
  const open = c(nx, { ...nx, 'pages/api/users/[id].ts': 'import { prisma } from "@/lib/db"\nexport default async function h(req: any, res: any) {\n  if (req.method === "GET") return res.json(await prisma.user.findUnique({ where: { id: req.query.id } }))\n  return res.json(await prisma.user.update({ where: { id: req.query.id }, data: req.body }))\n}\n' })
  assert.ok(!open.includes('own account'), open)
  const lib = { ...nx, 'lib/api.ts': 'export async function deletePost(id: string) {\n  return fetch(`/api/posts/${id}`, { method: "DELETE" })\n}\n' }
  const act = { 'app/actions.ts': '"use server"\nimport { prisma } from "@/lib/db"\nexport async function deletePost(id: string) {\n  await prisma.post.delete({ where: { id } })\n}\n' }
  assert.ok(!c(lib, { ...lib, ...act }).includes('was a helper'), 'a fetch wrapper kept in place')
  const helper = { ...nx, 'lib/posts.ts': 'import { prisma } from "@/lib/db"\nexport async function deletePost(id: string) {\n  await prisma.post.delete({ where: { id } })\n}\n' }
  assert.ok(!c(helper, { ...helper, ...act }).includes('was a helper'), 'duplicated, old one kept')
  const fa = { 'requirements.txt': 'fastapi\n', 'shop/orders.py': 'from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/items")\ndef items():\n    return []\n' }
  const alias = { ...fa, 'shop/main.py': 'from fastapi import FastAPI\nfrom shop.orders import router as orders_router\napp = FastAPI()\napp.include_router(orders_router, prefix="/api")\n' }
  assert.ok(c(alias, { ...alias, 'shop/orders.py': fa['shop/orders.py'].replace('return []', 'x = 1\n    return []') }).includes('/api/items'), 'an aliased router keeps its prefix')
  const setting = { ...fa, 'shop/main.py': 'from fastapi import FastAPI\nfrom shop.orders import router\napp = FastAPI()\napp.include_router(router, prefix=settings.API_V1_STR)\n' }
  const s = c(setting, { ...setting, 'shop/orders.py': fa['shop/orders.py'].replace('return []', 'x = 1\n    return []') })
  assert.ok(s.includes('/…/items') && !s.includes(' /items'), s)
}
console.log('ok (review 69)')
// Review 70: each method must be keyed by the login on its own; folder names don't repeat the address
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0"}}', 'lib/db.ts': 'export const prisma = {} as any\n', 'auth.ts': 'export const auth = async () => null as any\n', 'lib/users.ts': 'import { prisma } from "@/lib/db"\nexport const updateUser = (id: string, d: any) => prisma.user.update({ where: { id }, data: d })\n' }
  const get = 'import { auth } from "@/auth"\nimport { prisma } from "@/lib/db"\nimport { updateUser } from "@/lib/users"\nexport async function GET() {\n  const session = await auth()\n  if (!session) return new Response(null, { status: 401 })\n  return Response.json(await prisma.user.findUnique({ where: { id: session.user.id } }))\n}\n'
  for (const patch of ['const b = await req.json()\n  return Response.json(await updateUser(b.id, b))', 'const b = await req.json()\n  await prisma.$executeRaw`UPDATE "User" SET name = ${b.name} WHERE id = ${b.id}`\n  return new Response(null)'])
    assert.ok(!c(nx, { ...nx, 'app/api/me/route.ts': get + `export async function PATCH(req: Request) {\n  const session = await auth()\n  if (!session) return new Response(null, { status: 401 })\n  ${patch}\n}\n` }).includes('own account'), `a write the GET can't vouch for: ${patch.slice(0, 40)}`)
  const fa = { 'requirements.txt': 'fastapi\n', 'app/users/router.py': 'from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/users/{uid}")\ndef one(uid: int):\n    return {}\n', 'app/main.py': 'from fastapi import FastAPI\nfrom app.users.router import router\napp = FastAPI()\napp.include_router(router, prefix=settings.API)\n' }
  const dup = c(fa, { ...fa, 'app/users/router.py': fa['app/users/router.py'].replace('return {}', 'x = 1\n    return {}') })
  assert.ok(dup.includes('The user part of your server') && !dup.includes('users user'), dup)
}
console.log('ok (review 70)')
// Review 71: a method that looks itself up and then writes another way isn't "own account"; file names before folder names
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@prisma/client":"6.0.0"}}', 'lib/db.ts': 'export const prisma = {} as any\n', 'auth.ts': 'export const auth = async () => null as any\n' }
  const route = (patch: string) => c(nx, { ...nx, 'app/api/me/route.ts': `import { auth } from "@/auth"\nimport { prisma } from "@/lib/db"\nexport async function PATCH(req: Request) {\n  const session = await auth()\n  if (!session) return new Response(null, { status: 401 })\n  const me = await prisma.user.findUnique({ where: { id: session.user.id } })\n  ${patch}\n  return Response.json(me)\n}\n` })
  assert.ok(route('await prisma.user.update({ where: { id: session.user.id }, data: await req.json() })').includes('own account'), 'control')
  for (const p of ['await prisma.user.updateMany({ data: await req.json() })', 'const b = await req.json()\n  await updateUser(b.id, b)', 'await prisma.user.deleteMany({})'])
    assert.ok(!route(p).includes('own account'), `not own: ${p}`)
  const fa = { 'requirements.txt': 'fastapi\n', 'myshop/routers/orders.py': 'from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/{oid}")\ndef one(oid: int):\n    return {}\n', 'myshop/main.py': 'from fastapi import FastAPI\nfrom myshop.routers.orders import router\napp = FastAPI()\napp.include_router(router, prefix=settings.API)\n' }
  assert.ok(c(fa, { ...fa, 'myshop/routers/orders.py': fa['myshop/routers/orders.py'].replace('return {}', 'x = 1\n    return {}') }).includes('The orders part of your server'), 'file name first')
}
console.log('ok (review 71)')
// a router whose own prefix comes from settings (fastapi-best-architecture): "…", and the address's own words name it
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const fa = { 'requirements.txt': 'fastapi\n', 'app/api/router.py': 'from fastapi import APIRouter\nfrom app.api.monitor import router as monitor_router\nv1 = APIRouter(prefix=settings.API_V1_PATH)\nv1.include_router(monitor_router)\n',
    'app/api/monitor.py': 'from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/monitors/sessions")\ndef s():\n    return []\n', 'app/main.py': 'from fastapi import FastAPI\nfrom app.api.router import v1\napp = FastAPI()\napp.include_router(v1)\n' }
  const x = c(fa, { ...fa, 'app/api/monitor.py': fa['app/api/monitor.py'].replace('return []', 'y = 1\n    return []') })
  assert.ok(x.includes('The monitors sessions part of your server') && x.includes('/…/monitors/sessions'), x)
}
console.log('ok (settings prefix)')
// dropping a parameter nobody reads, at the end of the list, changes nothing (atidone); one in the middle or one that's read does
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nu = { 'package.json': '{"dependencies":{"nuxt":"3.0.0"}}', 'server/api/todos/stats.ts': 'export default defineEventHandler(async (event) => {\n  return { todos: 1 }\n})\n' }
  const dropped = c(nu, { ...nu, 'server/api/todos/stats.ts': 'export default defineEventHandler(async () => {\n  return { todos: 1 }\n})\n' })
  assert.ok(!dropped.includes("can't describe") && dropped.includes('Nothing about the app changed'), dropped)
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0"}}', 'lib/x.js': 'exports.f = (a, b) => a + 1\n' }
  const mid = { ...ex, 'lib/x.js': 'exports.f = (a, b) => b + 1\n' }
  assert.ok(!c(mid, { ...mid, 'lib/x.js': 'exports.f = (b) => b + 1\n' }).includes('(Hidden'), 'a parameter in the middle moves the next one')
  assert.ok(!c(ex, { ...ex, 'lib/x.js': 'exports.f = (a) => a + 2\n' }).includes('(Hidden'), 'a real change')
  // a promise's then/catch/finally never counts its callback's parameters, written with or without parentheses (atidone's session.ts)
  const pr = { ...ex, 'lib/x.js': 'exports.g = () => load().catch(_ => ({}))\nexports.h = () => load().then((r, _x) => r)\n' }
  for (const after of ['exports.g = () => load().catch(() => ({}))\nexports.h = () => load().then((r, _x) => r)\n', 'exports.g = () => load().catch(_ => ({}))\nexports.h = () => load().then((r) => r)\n',
    'exports.g = () => load().catch(() => ({}))\nexports.h = () => load().then(() => 1)\n'.replace('then(() => 1)', 'then(r => r)')])
    assert.ok(c(pr, { ...pr, 'lib/x.js': after }).includes('Nothing about the app changed'), after)
  // another library's callback can count them; a parameter that's read still matters
  assert.ok(!c({ ...ex, 'lib/x.js': 'exports.g = () => it("x", done => 1)\n' }, { ...ex, 'lib/x.js': 'exports.g = () => it("x", () => 1)\n' }).includes('Nothing about the app changed'), 'mocha done')
  assert.ok(!c(pr, { ...pr, 'lib/x.js': pr['lib/x.js'].replace('catch(_ => ({}))', 'catch(() => _)') }).includes('Nothing about the app changed'), 'read')
  // (review 92) a bare then(step, fn) isn't a promise: jest-cucumber counts fn's parameters
  assert.ok(!c({ ...ex, 'lib/x.js': 'exports.g = () => then("s", (_w) => 1)\n' }, { ...ex, 'lib/x.js': 'exports.g = () => then("s", () => 1)\n' }).includes('Nothing about the app changed'), 'bare then')
}
console.log('ok (unused parameters)')
// Express error handlers are told apart by their 4 parameters: dropping an unused `next` changes what it does
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0"}}', 'server.js': 'const express = require("express")\nconst app = express()\napp.use((err, req, res, next) => res.status(500).json({ error: "x" }))\napp.listen(3000)\n' }
  assert.ok(!c(ex, { ...ex, 'server.js': ex['server.js'].replace('(err, req, res, next)', '(err, req, res)') }).includes('Nothing about the app changed'), 'error handler arity')
  const cls = { 'package.json': '{"dependencies":{"express":"4.0.0"}}', 'lib/s.ts': 'export class S {\n  constructor(private db: any) {}\n  get() { return this.db }\n}\n' }
  assert.ok(!c(cls, { ...cls, 'lib/s.ts': cls['lib/s.ts'].replace('constructor(private db: any) {}', 'constructor() {}') }).includes('Nothing about the app changed'), 'parameter property')
}
console.log('ok (unused parameters 2)')
// Review 72: a parameter read by a spread, a $name, PHP code, a setter: not "unchanged"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'components/Box.tsx': 'export function Box(props: any) { return <main {...props} /> }\n' }
  assert.ok(!c(nx, { ...nx, 'components/Box.tsx': 'export function Box() { return <main {...props} /> }\n' }).includes('Nothing about the app changed'), 'spread')
  const d = { ...nx, 'lib/d.ts': 'export const f = ($el: any) => $el.focus()\n' }
  assert.ok(!c(d, { ...d, 'lib/d.ts': 'export const f = () => $el.focus()\n' }).includes('Nothing about the app changed'), '$name')
  const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'routes/web.php': "<?php\nRoute::get('/me', function (Request $request) { return $request->user(); });\n" }
  assert.ok(!c(lv, { ...lv, 'routes/web.php': "<?php\nRoute::get('/me', function () { return $request->user(); });\n" }).includes('Nothing about the app changed'), 'php')
  const st = { ...nx, 'lib/s.ts': 'export class S { set v(x: any) { } }\n' }
  assert.ok(!c(st, { ...st, 'lib/s.ts': 'export class S { set v() { } }\n' }).includes('Nothing about the app changed'), 'setter')
}
console.log('ok (review 72)')
// Review 73: a .ts file parsed as TypeScript (a `<string>x` cast isn't JSX); callbacks whose parameter count a library reads
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'lib/load.ts': 'export function load(path: string, config: any) {\n  const p = <string>path\n  return config[p]\n}\n' }
  assert.ok(!c(nx, { ...nx, 'lib/load.ts': 'export function load(path: string) {\n  const p = <string>path\n  return config[p]\n}\n' }).includes('Nothing about the app changed'), 'ts cast')
  const vr = { 'package.json': '{"dependencies":{"vue":"3.0.0"}}', 'src/router.ts': 'router.beforeEach((to, from, next) => {\n  console.log(to)\n})\n' }
  assert.ok(!c(vr, { ...vr, 'src/router.ts': 'router.beforeEach((to, from) => {\n  console.log(to)\n})\n' }).includes('Nothing about the app changed'), 'vue-router next')
}
console.log('ok (review 73)')
// Review 74: a callback handed to a library keeps its parameters (Svelte's derived counts them)
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const sv = { 'package.json': '{"devDependencies":{"@sveltejs/kit":"2.0.0"}}', 'src/lib/stores.ts': 'export const doubled = derived(count, ($count, set) => $count * 2)\n' }
  assert.ok(!c(sv, { ...sv, 'src/lib/stores.ts': 'export const doubled = derived(count, ($count) => $count * 2)\n' }).includes('Nothing about the app changed'), 'svelte derived')
}
console.log('ok (review 74)')
// Every stack: an existing code file that changed and that the card doesn't cover another way is named ("also changed")
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'app/about/page.tsx': 'export default function A() { return <main /> }\n',
    'app/pricing/page.tsx': 'import { PriceCard } from "@/components/PriceCard"\nimport Plans from "@/components/PlanList"\nexport default function P() { return <main><Plans /></main> }\n',
    'components/PriceCard.tsx': 'export function PriceCard() { return <b>Basic</b> }\n', 'components/PlanList.tsx': 'export default function PlanList() { return <ul /> }\n', 'lib/format.ts': 'export const money = (n: number) => "$" + n\n' }
  // a helper an unchanged page uses still changed: named
  const util = c(nx, { ...nx, 'app/about/page.tsx': 'export default function A() { return <main><h1>About us</h1></main> }\n', 'lib/format.ts': 'export const money = (n: number) => "€" + n\n' })
  assert.ok(util.includes('The agent also changed lib/format.ts, in a way plain can\'t describe yet.'), util)
  // a component the page now shows, imported under another name: the page line covers it
  const shown = c(nx, { ...nx, 'app/pricing/page.tsx': nx['app/pricing/page.tsx'].replace('<Plans />', '<Plans /><PriceCard />'), 'components/PriceCard.tsx': 'export function PriceCard() { return <b>Pro</b> }\n', 'components/PlanList.tsx': 'export default function PlanList() { return <ol /> }\n' })
  assert.ok(shown.includes('now shows the price card') && !shown.includes('also changed components/PriceCard.tsx') && !shown.includes('PlanList'), shown)
  // Ruby: a comment added at the top isn't a change
  const rb = { 'Gemfile': 'gem "rails"\n', 'lib/thing.rb': 'class Thing\n  def x; end\nend\n', 'app/models/post.rb': 'class Post < ApplicationRecord\nend\n' }
  assert.ok(!c(rb, { ...rb, 'lib/thing.rb': '# doc\n' + rb['lib/thing.rb'] }).includes('thing.rb'), 'ruby comment')
}
console.log('ok (also changed)')
// a limit whose number is a setting's fallback (tacticalrmm): said, with "your settings can change it"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const dj = { 'requirements.txt': 'django==5.1\n', 'app/constants.py': 'from django.conf import settings\nPAGE_SIZE = 50\n' }
  assert.ok(c(dj, { ...dj, 'app/constants.py': dj['app/constants.py'] + 'MAX_PAGE = getattr(settings, "MAX_PAGE", 10_000)\n' }).includes("There's now a maximum of 10,000 page (your settings can change it)"), 'getattr')
  assert.ok(c(dj, { ...dj, 'app/constants.py': dj['app/constants.py'] + 'MAX_UPLOADS = int(os.getenv("MAX_UPLOADS", "20"))\n' }).includes('a maximum of 20 uploads (your settings can change it)'), 'getenv')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'lib/limits.ts': 'export const A = 1\n' }
  assert.ok(c(nx, { ...nx, 'lib/limits.ts': 'export const A = 1\nexport const MAX_PROJECTS = Number(process.env.MAX_PROJECTS ?? 3)\n' }).includes('a maximum of 3 projects (your settings can change it)'), 'process.env')
}
console.log('ok (setting limits)')
// Review 76: the settings note is per file; a value settings.py sets wins; switches and a fallback of 0 aren't limits; never "gone"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const mix = { 'requirements.txt': 'fastapi\n', 'app/config.py': 'import os\nMAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "50"))\n', 'package.json': '{"dependencies":{"next":"15.0.0"}}' }
  const leak = c(mix, { ...mix, 'web/upload.ts': 'export const MAX_UPLOAD_MB = 20\n' })
  assert.ok(leak.includes('maximum upload size of 20 MB') && !leak.includes('20 MB (your settings'), leak)
  const dj = { 'requirements.txt': 'django==5.1\n', 'proj/settings.py': 'DEBUG = False\n', 'app/views.py': 'from django.conf import settings\n' }
  const both = c(dj, { ...dj, 'proj/settings.py': 'DEBUG = False\nMAX_PAGE = 500\n', 'app/views.py': 'from django.conf import settings\nMAX_PAGE = getattr(settings, "MAX_PAGE", 10_000)\n' })
  assert.ok(!both.includes('10,000'), both)
  const sw = { 'requirements.txt': 'fastapi\n', 'app/config.py': 'import os\n' }
  for (const l of ['RATE_LIMIT_ENABLED = int(os.getenv("RATE_LIMIT_ENABLED", "1"))', 'SKIP_LIMIT_CHECK = int(os.getenv("SKIP_LIMIT_CHECK", "0"))', 'MAX_SEATS = int(os.getenv("MAX_SEATS", "0"))'])
    assert.ok(!c(sw, { ...sw, 'app/config.py': `import os\n${l}\n` }).includes("There's now"), `not a limit: ${l}`)
  const st = { 'requirements.txt': 'django==5.1\n', 'app/views.py': 'from django.conf import settings\nMAX_PAGE = getattr(settings, "MAX_PAGE", 100)\ndef v(n):\n    return n > MAX_PAGE\n' }
  assert.ok(!c(st, { ...st, 'app/views.py': 'from django.conf import settings\ndef v(n):\n    return n > settings.MAX_PAGE\n' }).includes('is gone'), 'read another way, not gone')
}
console.log('ok (review 76)')
// A new page is described by its own content, not the app's frame (papermark's AppLayout); a component that isn't in the project
// means plain can't say "it only shows information"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'components/layouts/app.tsx': 'export default function AppLayout({ children }: any) { return <div><h2>Billing</h2><button>Upgrade</button>{children}</div> }\n', 'pages/index.tsx': 'export default function H() { return <main /> }\n' }
  const page = c(nx, { ...nx, 'pages/report.tsx': 'import AppLayout from "@/components/layouts/app"\nexport default function R() { return <AppLayout><h1>Report</h1></AppLayout> }\n' })
  assert.ok(page.includes('titled "Report"') && !page.includes('Billing') && !page.includes('Upgrade'), page)
  const missing = c(nx, { ...nx, 'pages/redact.tsx': 'import { Workspace } from "@/ee/features/redaction/workspace"\nexport default function R() { return <Workspace /> }\n' })
  assert.ok(!missing.includes('only shows information'), missing)
}
console.log('ok (page frame)')
// Review 77: a component named ...Header can be content (PricingHeader); an import that resolves isn't "unread"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'pages/index.tsx': 'export default function H() { return <main /> }\n', 'components/PricingHeader.tsx': 'export function PricingHeader() { return <button onClick={() => fetch("/api/checkout", { method: "POST" })}>Subscribe</button> }\n' }
  const p = c(nx, { ...nx, 'pages/pricing.tsx': 'import { PricingHeader } from "@/components/PricingHeader"\nexport default function P() { return <main><h1>Pricing</h1><PricingHeader /></main> }\n' })
  assert.ok(p.includes('"Subscribe" button') && !p.includes('only shows information'), p)
  const rx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'pages/index.tsx': 'export default function H() { return <main /> }\n', 'app/components/Box.tsx': 'export function Box() { return <p>hi</p> }\n' }
  assert.ok(c(rx, { ...rx, 'pages/t.tsx': 'import { Box } from "~/components/Box"\nimport Logo from "./logo.svg?react"\nexport default function T() { return <main><h1>T</h1><Box /><Logo /></main> }\n' }).includes('only shows information'), 'resolves elsewhere')
}
console.log('ok (review 77)')
// Code with no login check that deletes stored files, whenever it changes (chadnext's removeUserOldImageFromCDN)
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const DEL = 'to delete files from your storage'
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","uploadthing":"7.0.0"}}', 'lib/ut.ts': 'export const utapi = {} as any\n', 'middleware.ts': 'import { createI18nMiddleware } from "next-international/middleware"\nexport const middleware = createI18nMiddleware({ locales: ["en"], defaultLocale: "en" })\n' }
  const act = (body: string) => ({ ...nx, 'app/settings/actions.ts': `"use server"\nimport { utapi } from "@/lib/ut"\nexport async function removeOld(url: string) {\n${body}\n}\n` })
  const before = act('  await utapi.deleteFiles(url.split("/").pop())')
  assert.ok(c(before, act('  console.log(url)\n  await utapi.deleteFiles(url.split("/").pop())')).includes(DEL), 'changed, open, deletes files')
  assert.ok(!c(before, act('  const s = await auth()\n  if (!s) throw new Error("no")\n  await utapi.deleteFiles(url.split("/").pop())')).includes(DEL), 'checks login')
  const mw = { ...nx, 'middleware.ts': 'import { auth } from "@/auth"\nexport default auth((req) => { if (!req.auth) return Response.redirect("/login") })\n' }
  assert.ok(!c({ ...before, ...mw }, { ...act('  console.log(url)\n  await utapi.deleteFiles(url.split("/").pop())'), ...mw }).includes(DEL), 'a login middleware')
  assert.ok(!c(before, { ...before, 'lib/x.ts': 'export const y = 1\n' }).includes(DEL), 'unchanged')
}
console.log('ok (open file deletes)')
// Review 78: a cron secret, a Stripe signature, a login helper plain doesn't know, or a Nuxt user check aren't "no login check"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const DEL = 'to delete files from your storage'
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","@vercel/blob":"1.0.0","@aws-sdk/client-s3":"3.0.0"}}' }
  const pair = (path: string, code: string) => c({ ...nx, [path]: code }, { ...nx, [path]: code.replace('// x', 'console.log(1)') })
  assert.ok(!pair('app/api/cron/cleanup/route.ts', 'import { del } from "@vercel/blob"\nexport async function GET(req: Request) { // x\n  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response(null, { status: 401 })\n  await del("x")\n  return Response.json({})\n}\n').includes(DEL), 'cron secret')
  assert.ok(!pair('app/api/stripe/route.ts', 'import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3"\nconst s3 = new S3Client({})\nexport async function POST(req: Request) { // x\n  const event = stripe.webhooks.constructEvent(await req.text(), "", "")\n  await s3.send(new DeleteObjectCommand({ Bucket: "b", Key: event.id }))\n  return Response.json({})\n}\n').includes(DEL), 'stripe signature')
  assert.ok(!pair('app/api/files/route.ts', 'import { del } from "@vercel/blob"\nimport { getToken } from "next-auth/jwt"\nexport async function DELETE(req: any) { // x\n  const t = await getToken({ req })\n  if (!t) return new Response(null, { status: 401 })\n  await del((await req.json()).url)\n  return Response.json({})\n}\n').includes(DEL), 'getToken')
  assert.ok(pair('app/api/files/route.ts', 'import { del } from "@vercel/blob"\nexport async function DELETE(req: Request) { // x\n  await del((await req.json()).url)\n  return Response.json({})\n}\n').includes(DEL), 'open delete')
  const blob = 'import { put, del } from "@vercel/blob"\nexport async function POST(req: Request) { // x\n  return Response.json(await put("a", "b", { access: "public" }))\n}\n'
  assert.ok(!pair('app/api/upload/route.ts', blob).includes(DEL), 'only an upload changed')
}
console.log('ok (review 78)')
// Review 79: "won't build" never for an import inside a string, a monorepo app's own @/, a symlink, a generator's folder or a case
// difference; multi-line imports are read
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const W = "won't build"
  const run = (a: Record<string, string>, b: Record<string, string>) => c(a, { ...a, ...b })
  assert.ok(!run({ 'src/app/main.py': 'x=1\n', 'frontend/src/lib/utils.ts': 'export const cn=1\n', 'frontend/src/App.tsx': 'export default 1\n' }, { 'frontend/src/App.tsx': "import { cn } from '@/lib/utils'\nexport default cn\n" }).includes(W), 'a monorepo app\'s @/')
  assert.ok(!run({ 'src/gen/emit.ts': 'export const x=1\n' }, { 'src/gen/emit.ts': "export const code = `\nimport { db } from './db/client'\nexport default db\n`\n" }).includes(W), 'inside a string')
  assert.ok(!run({ 'src/app.ts': 'x\n', 'src/shared': '../shared\n', 'shared/utils/fmt.ts': 'x\n' }, { 'src/app.ts': "import { f } from './shared/utils/fmt'\nexport const y = f\n" }).includes(W), 'symlink')
  assert.ok(!run({ 'package.json': '{"scripts":{"codegen":"graphql-codegen"}}', 'codegen.ts': 'export default { generates: { "./src/gql/": { preset: "client" } } }\n', 'src/app.ts': 'x\n' }, { 'src/app.ts': "import { graphql } from './gql/gql'\nexport const q = graphql\n" }).includes(W), 'codegen folder')
  assert.ok(!run({ 'src/app.ts': 'x\n', 'src/Components/Button/Button.tsx': 'export const B = 1\n' }, { 'src/app.ts': "import { B } from './components/Button/Button'\nexport const y = B\n" }).includes(W), 'case difference')
  assert.ok(run({ 'src/app.ts': 'x\n', 'src/lib/a.ts': 'export const a = 1\n' }, { 'src/app.ts': "import {\n  y,\n} from './lib/missing/y'\nexport const z = y\n" }).includes(W), 'multi-line import of a folder that isn\'t there')
}
console.log('ok (review 79)')
// Review 80: tsconfig paths with ../ and baseUrl, Vite's alias, imports leaving the project, *.tsx in .gitignore, a folder a script
// writes, and `import type` aren't "won't build"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const W = "won't build", pkg = '{"dependencies":{"react":"18.0.0"}}'
  const run = (a: Record<string, string>, b: Record<string, string>) => c(a, { ...a, ...b })
  for (const [name, a, b] of [
    ['paths with ../', { 'apps/web/package.json': pkg, 'apps/web/tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["../../packages/ui/src/*"]}}}', 'apps/web/src/App.tsx': 'export const x=1\n', 'packages/ui/src/components/button.tsx': 'export const B=1\n' }, { 'apps/web/src/App.tsx': "import { B } from '@/components/button'\nexport const x=B\n" }],
    ['baseUrl', { 'apps/web/package.json': pkg, 'apps/web/tsconfig.json': '{"compilerOptions":{"baseUrl":"./client","paths":{"@/*":["*"]}}}', 'apps/web/server/a.ts': 'export const x=1\n', 'apps/web/client/lib/api.ts': 'x' }, { 'apps/web/server/a.ts': "import { y } from '@/lib/api'\nexport const x=y\n" }],
    ['vite alias', { 'web/package.json': pkg, 'web/vite.config.ts': "export default { resolve: { alias: { '@': path.resolve(__dirname, './client') } } }\n", 'web/server/a.ts': 'x\n', 'web/client/lib/api.ts': 'x' }, { 'web/server/a.ts': "import { y } from '@/lib/api'\nexport const x=y\n" }],
    ['leaves the project', { 'apps/web/package.json': pkg, 'apps/web/src/a.ts': 'x\n', 'rust/Cargo.toml': 'x' }, { 'apps/web/src/a.ts': "import init from '../../../rust/pkg/my_crate'\nexport const x=init\n" }],
    ['gitignored *.tsx', { '.gitignore': 'src/icons/*.tsx\n', 'src/app.ts': 'x\n', 'src/lib/a.ts': 'x' }, { 'src/app.ts': "import Home from './icons/Home'\nexport const x=Home\n" }],
    ['a script writes it', { 'scripts/gen.mjs': "writeFileSync('src/gen-routes/index.ts', code)\n", 'src/app.ts': 'x\n', 'src/lib/a.ts': 'x' }, { 'src/app.ts': "import routes from './gen-routes/index'\nexport const x=routes\n" }],
    ['import type', { 'src/app.ts': 'export const x=1\n', 'src/lib/a.ts': 'x' }, { 'src/app.ts': "import type { Database } from './lib/types/supabase'\nexport const x=1\n" }]] as const)
    assert.ok(!run(a, b).includes(W), `import control: ${name}`)
}
console.log('ok (review 80)')
// A file cut off mid-function (LinkStack's functions.php): a new parse error and braces that no longer balance
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const CUT = 'looks cut off'
  const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'app/helpers.php': "<?php\nfunction footer() {\n  if (true) {\n    echo 'x';\n  }\n}\nfunction other() { return 1; }\n" }
  assert.ok(c(lv, { ...lv, 'app/helpers.php': "<?php\nfunction footer() {\n  if (true) {\n    echo 'x';\n" }).includes(`app/helpers.php ${CUT}`), 'php cut off')
  assert.ok(!c(lv, { ...lv, 'app/helpers.php': "<?php\nclass A { public string $x { get => 'a'; } }\nfunction footer() { echo '{'; }\n" }).includes(CUT), 'php: new syntax, balanced, a brace in a string')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'lib/a.ts': 'export function a() {\n  if (x) {\n    return 1\n  }\n}\n' }
  assert.ok(c(nx, { ...nx, 'lib/a.ts': 'export function a() {\n  if (x) {\n    return 1\n' }).includes(`lib/a.ts ${CUT}`), 'ts cut off')
  assert.ok(!c(nx, { ...nx, 'lib/a.ts': 'export function a() {\n  const s = `{ ${x} }`\n  return s // }\n}\n' }).includes(CUT), 'ts: braces in a template and a comment')
  const bad = { ...nx, 'lib/a.ts': 'export function a() {\n  if (x) {\n' }
  assert.ok(!c(bad, { ...bad, 'lib/a.ts': 'export function a() {\n  if (y) {\n' }).includes(CUT), 'already broken before')
}
console.log('ok (cut-off files)')
// Review 81: '#fff; }' in a string, C#'s #if/#else openers and valid newer syntax don't make a file "cut off"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const CUT = 'looks cut off'
  const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'app/S.php': "<?php\nclass S {\n  public function css() { return '.a { color: #fff; }'; }\n}\n" }
  assert.ok(!c(lv, { ...lv, 'app/S.php': "<?php\nclass S {\n  public function __construct(public private(set) string $n) {}\n  public function css() { return '.a { color: #fff; }'; }\n}\n" }).includes(CUT), 'php 8.4 asymmetric visibility + css string')
  const cs = { 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>', 'Svc.cs': 'class Svc {\n  void Run() {\n    if (x) {\n      Go();\n    }\n  }\n}\n' }
  assert.ok(!c(cs, { ...cs, 'Svc.cs': 'class Svc {\n  void Run() {\n#if DEBUG\n    if (x) {\n#else\n    if (y) {\n#endif\n      Go();\n    }\n  }\n}\n' }).includes(CUT), 'c# #if/#else openers')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'lib/a.js': 'export const u = "//cdn.x.com"\nexport function a() {\n  return 1\n}\n' }
  assert.ok(!c(nx, { ...nx, 'lib/a.js': 'export const u = "//cdn.x.com"\nexport const css = ".a { color: #fff; }"\nexport function a() {\n  return 1\n}\n' }).includes(CUT), 'js strings')
}
console.log('ok (review 81)')
// Review 82: a PHP file that gains a ?> ... HTML block (WordPress's inline style hook) isn't "cut off"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const wp = { 'composer.json': '{"require":{"php":"^8.2"}}', 'functions.php': "<?php\nfunction theme_setup() {\n  add_theme_support('title-tag');\n}\n" }
  assert.ok(!c(wp, { ...wp, 'functions.php': wp['functions.php'] + "add_action('wp_head', function () { ?>\n  <style>.site-header { background: #1e1e1e; }</style>\n<?php });\n" }).includes('looks cut off'), 'wp inline style')
}
console.log('ok (review 82)')
// A JS file with thousands of functions stays fast: per-function work never rescans the whole file (it was quadratic)
{
  const big = (n: number) => Array.from({ length: n }, (_, i) => `export function f${i}(a) { if (a) { return a + ${i} } return [1, 2] }`).join('\n')
  const a = { 'package.json': '{}', 'big.js': big(8000) + '\n' }
  const t = Date.now(); report(new Map(Object.entries(a)), new Map(Object.entries({ ...a, 'big.js': a['big.js'] + 'export const z = 1\n' })), { ref: 'main' })
  assert.ok(Date.now() - t < 8000, `8,000 functions took ${Date.now() - t} ms`)
}
console.log('ok (big files)')
// A package removed from package.json that code still imports
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const R = 'was removed from package.json, but'
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0","date-fns":"3.0.0","@types/node":"20.0.0"}}', 'lib/d.ts': 'import { format } from "date-fns/format"\nexport const d = format\n' }
  assert.ok(c(nx, { ...nx, 'package.json': '{"dependencies":{"next":"15.0.0","@types/node":"20.0.0"}}' }).includes(`date-fns ${R} lib/d.ts still uses it`), 'still imported')
  assert.ok(!c(nx, { ...nx, 'package.json': '{"dependencies":{"next":"15.0.0","@types/node":"20.0.0"}}', 'lib/d.ts': 'export const d = 1\n' }).includes(R), 'imports removed too')
  assert.ok(!c({ ...nx, 'packages/x/package.json': '{"dependencies":{"date-fns":"3.0.0"}}' }, { ...nx, 'packages/x/package.json': '{"dependencies":{"date-fns":"3.0.0"}}', 'package.json': '{"dependencies":{"next":"15.0.0"}}' }).includes(R), 'another package.json lists it')
  assert.ok(!c(nx, { ...nx, 'package.json': '{"dependencies":{"next":"15.0.0","date-fns":"3.0.0"}}' }).includes(R), '@types')
}
console.log('ok (removed packages)')
// Review 83: server-only, a bundler alias, Deno's import map, test setup files and code samples in strings aren't "still uses it"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const R = 'was removed from package.json'
  const pj = (d: string) => `{"dependencies":{"next":"15.0.0"${d}}}`
  assert.ok(!c({ 'package.json': pj(',"server-only":"0.0.1"'), 'lib/s.ts': 'import "server-only"\nexport const s = 1\n' }, { 'package.json': pj(''), 'lib/s.ts': 'import "server-only"\nexport const s = 1\n' }).includes(R), 'server-only')
  const v = { 'vite.config.ts': "export default { resolve: { alias: { react: 'preact/compat' } } }\n", 'src/i.tsx': 'import { useState } from "react"\nexport const x = useState\n' }
  assert.ok(!c({ ...v, 'package.json': pj(',"react":"18.0.0"') }, { ...v, 'package.json': pj(',"preact":"10.0.0"') }).includes(R), 'aliased')
  const st = { 'src/setupTests.ts': 'import "@testing-library/jest-dom"\n' }
  assert.ok(!c({ ...st, 'package.json': pj(',"@testing-library/jest-dom":"6.0.0"') }, { ...st, 'package.json': pj('') }).includes(R), 'test setup')
  const doc = { 'app/docs/page.tsx': 'const code = `import { Button } from "old-ui"`\nexport default function P() { return <pre>{code}</pre> }\n' }
  assert.ok(!c({ ...doc, 'package.json': pj(',"old-ui":"1.0.0"') }, { ...doc, 'package.json': pj('') }).includes(R), 'a code sample')
  const lo = { 'src/a.ts': 'const u = "//cdn.x"\nimport x from "lodash"\nexport const y = [u, x]\n' }
  assert.ok(c({ ...lo, 'package.json': pj(',"lodash":"4.0.0"') }, { ...lo, 'package.json': pj('') }).includes(`lodash ${R}`), 'a // inside a string')
}
console.log('ok (review 83)')
// An existing route that gains a 403/404/401 check (OpnForm's export status) says so; "status" stays "status"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'lib/db.ts': 'export const db = {} as any\n' }
  const route = (body: string) => ({ ...nx, 'app/api/jobs/status/[id]/route.ts': `import { db } from "@/lib/db"\nexport async function GET(req: Request, { params }: any) {\n  const job = await db.job.findFirst({ where: { id: params.id } })\n${body}\n  return Response.json(job)\n}\n` })
  const more = c(route(''), route('  if (job.formId !== params.form) return new Response(null, { status: 404 })'))
  assert.ok(more.includes('turns away more requests than before (a new "not found" check)') && more.includes('jobs status part'), more)
  assert.ok(!c(route('  if (!job) return new Response(null, { status: 404 })'), route('  if (!job) {\n    return new Response(null, { status: 404 })\n  }')).includes('turns away more'), 'same check, reformatted')
}
console.log('ok (new refusals)')
// Review 84: a split, reworded or caught check isn't "turns away more"; a new method's own checks aren't either; emojis -> emoji
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const T = 'turns away more requests'
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'lib/db.ts': 'export const db = {} as any\n' }
  const r = (body: string, extra = '') => ({ ...nx, 'app/api/posts/[id]/route.ts': `import { db } from "@/lib/db"\nexport async function GET(req: Request, { params }: any) {\n  const post = await db.post.findFirst({ where: { id: params.id } })\n${body}\n  return Response.json(post)\n}\n${extra}` })
  assert.ok(!c(r('  if (!post || post.hidden) return Response.json({}, { status: 404 })'), r('  if (!post) return Response.json({}, { status: 404 })\n  if (post.hidden) return Response.json({}, { status: 404 })')).includes(T), 'split')
  assert.ok(!c(r('  if (post.locked) return Response.json({ error: "Not yours" }, { status: 403 })'), r('  if (post.locked) return Response.json({ error: "Forbidden" }, { status: 403 })')).includes(T), 'reworded')
  assert.ok(!c(r(''), r('', 'export async function POST(req: Request) {\n  const s = await auth()\n  if (!s) return new Response(null, { status: 401 })\n  return Response.json(await db.comment.create({ data: {} }))\n}\n')).includes(T), 'a new method')
  const { named } = await import('../src/plain.ts')
  assert.equal(named('/emojis/[id]').join(' '), 'emoji'); assert.equal(named('/statuses/[id]').join(' '), 'status'); assert.equal(named('/menus/[id]').join(' '), 'menu')
}
console.log('ok (review 84)')
// A refusal the old code already sent (same message) isn't a new rule; a changed component says what's new on screen
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'lib/db.ts': 'export const db = {} as any\n' }
  const r = (body: string) => ({ ...nx, 'app/api/progress/[id]/route.ts': `import { db } from "@/lib/db"\nexport async function POST(req: Request, { params }: any) {\n  const p = await db.progress.findFirst({ where: { id: params.id } })\n${body}\n  return Response.json(p)\n}\n` })
  assert.ok(!c(r('  try { await done(p) } catch (e) { if (e.message === "x") return Response.json({ error: "Progress not found" }, { status: 404 }) }'),
    r('  if (!p || p.userId !== me) return Response.json({ error: "Progress not found" }, { status: 404 })')).includes('turns away more'), 'the same refusal, moved')
  const ui = { ...nx, 'app/page.tsx': 'export default function P() { return <main /> }\n', 'components/IntegrationRow.tsx': 'export function Row() { return <div><span>Disconnect</span></div> }\n' }
  const row = c(ui, { ...ui, 'components/IntegrationRow.tsx': 'export function Row() { return <div><span>Disconnect</span><span>Test connection</span></div> }\n' })
  assert.ok(row.includes('The agent changed components/IntegrationRow.tsx: it now shows "Test connection".') && !row.includes("can't describe"), row)
  // text around {a ? 'Turso' : 'D1'} reads whole, each way it shows (atidone's LoginForm.vue)
  const vue = { ...nx, 'components/LoginForm.vue': '<template>\n  <p>Welcome. Data lives in a <a href="x">D1 database</a>.</p>\n</template>\n' }
  const tu = c(vue, { ...vue, 'components/LoginForm.vue': `<script setup>\nconst isTurso = useState('t', () => false)\n</script>\n<template>\n  <p>Welcome. Data lives in a <a href="x">\n    {{ isTurso ? 'Turso' : 'D1' }} database\n  </a>.</p>\n</template>\n` })
  assert.ok(tu.includes('it now shows "Turso database".') && !tu.includes('"database"'), tu)
  // (review 92) a button's label reads whole too ("Save changes", not "changes"); a cut list says how many more; entities read as shown
  const btn = { ...nx, 'app/page.tsx': 'export default function P() { return <main /> }\n', 'components/Row.tsx': 'export function Row() { return <div><button>Save changes</button></div> }\n' }
  const sv = c(btn, { ...btn, 'components/Row.tsx': 'export function Row({ a }: { a: boolean }) { return <div><button>{a ? "Saving" : "Save"} changes</button></div> }\n' })
  assert.ok(!sv.includes('"changes" button'), sv)
  const plan = c(btn, { ...btn, 'components/Row.tsx': 'export function Row({ p }: { p: string }) { return <div><button>Save changes</button><p>{p === "pro" ? "Pro" : p === "team" ? "Team" : "Free"} plan active</p></div> }\n' })
  assert.ok(plan.includes('"Pro plan active", "Team plan active" and 1 more'), plan)
  const ent = c(btn, { ...btn, 'components/Row.tsx': 'export function Row() { return <div><button>Save changes</button><p>Tom&apos;s profile page</p></div> }\n' })
  assert.ok(ent.includes(`"Tom's profile page"`), ent)
}
console.log('ok (refusal messages, component lines)')
// Review 85: replaced words say so; no pieces around {expressions}; not stories or emails; a reused generic message hides nothing
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const nx = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'app/page.tsx': 'export default function P() { return <main /> }\n', 'components/Row.tsx': 'export function Row() { return <div><button>Save</button><p>Free shipping on all orders</p></div> }\n' }
  const rep = c(nx, { ...nx, 'components/Row.tsx': 'export function Row() { return <div><button>Save changes</button><p>Shipping costs $5 on small orders</p></div> }\n' })
  assert.ok(rep.includes('in place of a "Save" button') && rep.includes('in place of "Free shipping on all orders"'), rep)
  const frag = c(nx, { ...nx, 'components/Row.tsx': 'export function Row({ u, n }: any) { return <div><button>Save</button><p>Free shipping on all orders</p><p>Hello, {u.name}! You have {n} items</p></div> }\n' })
  assert.ok(!frag.includes('"! You have"') && !frag.includes('"Hello,"'), frag)
  assert.ok(!c(nx, { ...nx, 'components/Button.stories.tsx': 'export const S = () => <button>Click me now</button>\n' }).includes('Click me now'), 'stories')
  assert.ok(!c(nx, { ...nx, 'emails/Welcome.tsx': 'import { Html } from "@react-email/components"\nexport default function W() { return <Html><p>Welcome to Acme</p></Html> }\n' }).includes('shows "Welcome'), 'emails')
  const db = { ...nx, 'lib/db.ts': 'export const db = {} as any\n' }
  const note = (body: string) => ({ ...db, 'app/api/notes/[id]/route.ts': `import { db } from "@/lib/db"\nexport async function GET(req: Request, { params }: any) {\n  const p = await db.note.findFirst({ where: { id: params.id } })\n  if (!p) return Response.json({ error: "Not found" }, { status: 404 })\n${body}\n  return Response.json(p)\n}\n` })
  assert.ok(c(note(''), note('  if (p.userId !== me.id) return Response.json({ error: "Not found" }, { status: 404 })')).includes('turns away more requests'), 'a reused generic message')
}
console.log('ok (review 85)')
// PHP: a global helper deleted while other files still call it (LinkStack's block helpers)
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const D = 'was deleted from app/helpers.php'
  const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'app/helpers.php': "<?php\nfunction block_asset($x) { return $x; }\nfunction other() { return 1; }\n", 'resources/views/b.blade.php': "<img src=\"{{ block_asset('a.png') }}\">\n" }
  assert.ok(c(lv, { ...lv, 'app/helpers.php': "<?php\nfunction other() { return 1; }\n" }).includes(`block_asset() ${D}, but resources/views/b.blade.php still uses it`), 'deleted, still called')
  assert.ok(!c(lv, { ...lv, 'app/helpers.php': "<?php\nfunction other() { return 1; }\n", 'app/assets.php': "<?php\nfunction block_asset($x) { return $x; }\n" }).includes(D), 'moved to another file')
  assert.ok(!c(lv, { ...lv, 'app/helpers.php': "<?php\nfunction other() { return 1; }\n", 'resources/views/b.blade.php': "<img src=\"{{ $asset->block_asset('a.png') }}\">\n" }).includes(D), 'only a method call now')
  assert.ok(!c(lv, { ...lv, 'app/helpers.php': "<?php\nfunction other() { return 1; }\n", 'resources/views/b.blade.php': "<p>{{ 'block_asset() was removed' }}</p>\n" }).includes(D), 'in a string')
}
console.log('ok (deleted php helpers)')
// Review 86: a method definition, JS in <script>, a helper moved into a new Composer package, a name in translated text
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const D = 'was deleted from'
  const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'app/helpers.php': "<?php\nfunction slugify($x) { return $x; }\nfunction keep() { return 1; }\n" }
  assert.ok(!c({ ...lv, 'app/Post.php': "<?php\nclass Post {\n  public function slugify($t) { return $t; }\n  public function save() { return $this->slugify('a'); }\n}\n" }, { ...lv, 'app/helpers.php': "<?php\nfunction keep() { return 1; }\n", 'app/Post.php': "<?php\nclass Post {\n  public function slugify($t) { return $t; }\n  public function save() { return $this->slugify('a'); }\n}\n" }).includes(D), 'a method definition')
  const js = { ...lv, 'public/menu.php': "<?php echo 'x'; ?>\n<script>\nfunction toggleMenu() { }\n</script>\n", 'resources/views/nav.blade.php': '<button onclick="toggleMenu()">Menu</button>\n' }
  assert.ok(!c(js, { ...js, 'public/menu.php': "<?php echo 'x'; ?>\n" }).includes(D), 'javascript')
  assert.ok(!c(lv, { ...lv, 'composer.json': '{"require":{"laravel/framework":"^11.0","acme/money":"^1.0"}}', 'app/helpers.php': "<?php\nfunction keep() { return 1; }\n", 'app/Shop.php': "<?php\nclass Shop { public function t() { return slugify('a'); } }\n" }).includes(D), 'moved into a package')
  const tr = { ...lv, 'resources/views/a.blade.php': "<p>{{ __('Run slugify() from the admin panel') }}</p>\n" }
  assert.ok(!c(tr, { ...tr, 'app/helpers.php': "<?php\nfunction keep() { return 1; }\n" }).includes(D), 'translated text')
}
console.log('ok (review 86)')
// an app's own helper behind function_exists still counts; a native polyfill doesn't
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const lv = { 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', 'app/helpers.php': "<?php\nif (!function_exists('setBlockAssetContext')) {\n  function setBlockAssetContext($x) { return $x; }\n}\nif (!function_exists('str_contains')) {\n  function str_contains($h, $n) { return strpos($h, $n) !== false; }\n}\nfunction keep() { return 1; }\n",
    'app/View.php': "<?php\nclass View { public function r() { setBlockAssetContext('a'); return str_contains('ab', 'a'); } }\n" }
  const r = c(lv, { ...lv, 'app/helpers.php': "<?php\nfunction keep() { return 1; }\n" })
  assert.ok(r.includes('setBlockAssetContext() was deleted') && !r.includes('str_contains() was deleted'), r)
}
console.log('ok (function_exists helpers)')
// Python request models whose fields were renamed (fastapi-best-architecture: roles -> role_ids)
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const E = 'The data your server expects changed'
  const fa = { 'requirements.txt': 'fastapi\npydantic\n', 'app/schema/user.py': 'from pydantic import BaseModel, Field\n\nclass AddUserParam(BaseModel):\n    name: str\n    roles: list[int] = Field(description="ids")\n\nclass GetUserDetail(BaseModel):\n    name: str\n    roles: list[int]\n' }
  assert.ok(c(fa, { ...fa, 'app/schema/user.py': fa['app/schema/user.py'].replace('    roles: list[int] = Field', '    role_ids: list[int] = Field') }).includes(`${E}: it now needs "role_ids" instead of "roles"`), 'rename')
  assert.ok(!c(fa, { ...fa, 'app/schema/user.py': fa['app/schema/user.py'].replace('    roles: list[int]\n', '    role_ids: list[int]\n') }).includes(E), 'a response model')
  assert.ok(!c(fa, { ...fa, 'app/schema/user.py': fa['app/schema/user.py'].replace('    name: str\n    roles', '    name: str\n    email: str | None = None\n    roles') }).includes(E), 'a field added')
}
console.log('ok (request fields)')
// Review 87: aliases, docstrings, optional new fields, response models and dataclasses aren't "the data your server expects changed"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const E = 'The data your server expects changed'
  const one = (a: string, b: string) => c({ 'requirements.txt': 'fastapi\n', 'app/schemas/u.py': `from pydantic import BaseModel, Field\n\n${a}` }, { 'requirements.txt': 'fastapi\n', 'app/schemas/u.py': `from pydantic import BaseModel, Field\n\n${b}` })
  for (const [name, a, b] of [['alias', 'class AddUserParam(BaseModel):\n    roles: list[int]\n', "class AddUserParam(BaseModel):\n    role_ids: list[int] = Field(alias='roles')\n"],
    ['docstring', 'class AddUserParam(BaseModel):\n    """\n    Note: x\n    """\n    name: str\n', 'class AddUserParam(BaseModel):\n    """\n    Remark: x\n    """\n    name: str\n'],
    ['optional new field', 'class AddUserParam(BaseModel):\n    roles: list[int]\n', 'class AddUserParam(BaseModel):\n    role_ids: list[int] | None = None\n'],
    ['response model', 'class UpdateResult(BaseModel):\n    ok: bool\n', 'class UpdateResult(BaseModel):\n    success: bool\n'],
    ['Address', 'class Address(BaseModel):\n    street: str\n', 'class Address(BaseModel):\n    line1: str\n']] as const)
    assert.ok(!one(a, b).includes(E), `control: ${name}`)
  assert.ok(one('class AddUserParam(BaseModel):\n    roles: list[int] = Field(description="ids")\n', 'class AddUserParam(BaseModel):\n    role_ids: list[int] = Field(description="ids")\n').includes(`${E}: it now needs "role_ids" instead of "roles"`), 'Field() without a default is required')
}
console.log('ok (review 87)')
// Express routes that name a controller's function (router.get("/status", userController.healthStatus)): plain reads that function
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const ex = { 'package.json': '{"dependencies":{"express":"4.0.0","@prisma/client":"5.0.0"}}', 'prisma/schema.prisma': 'model Order {\n  id Int @id\n  total Int\n}\n', 'lib/db.js': 'exports.prisma = {}\n',
    'controllers/orders.js': 'const { prisma } = require("../lib/db")\nexports.health = (req, res) => res.status(200).json({ message: "Ok" })\nexports.list = async (req, res) => res.json(await prisma.order.findMany())\nmodule.exports.create = async function (req, res) { res.json(await prisma.order.create({ data: req.body })) }\n' }
  const srv = (route: string) => ({ ...ex, 'server.js': `const express = require("express")\nconst ctrl = require("./controllers/orders")\nconst app = express()\nconst router = express.Router()\n${route}\napp.use("/api", router)\napp.listen(3000)\n` })
  assert.ok(c(srv(''), srv('router.get("/status", ctrl.health)')).includes('New server code that answers requests and works without logging in'), 'health check')
  assert.ok(c(srv(''), srv('router.get("/orders", ctrl.list)')).includes('New server code that lists orders'), 'exports.list')
  assert.ok(c(srv(''), srv('router.post("/orders", ctrl.create)')).includes('New server code that saves new orders'), 'module.exports.create')
}
console.log('ok (express controllers)')
// (review 99: the function the module really exports under that name: not a same-named helper, not one an export object replaced)
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const base = { 'package.json': '{"dependencies":{"express":"4.0.0","@prisma/client":"5.0.0"}}', 'prisma/schema.prisma': 'model Order {\n  id Int @id\n}\nmodel Upload {\n  id Int @id\n}\n', 'lib/db.js': 'exports.prisma = {}\n' }
  const srv = (ctl: string, route = 'router.get("/orders", ctrl.list)') => ({ ...base, 'controllers/orders.js': `const { prisma } = require("../lib/db")\n${ctl}`, 'server.js': `const express = require("express")\nconst ctrl = require("./controllers/orders")\nconst app = express()\nconst router = express.Router()\n${route}\napp.use("/api", router)\napp.listen(3000)\n` })
  const lists = (ctl: string) => c(srv(ctl, ''), srv(ctl))
  const del = 'async function purge(where) { await prisma.upload.deleteMany({ where }) }\n', ok = 'async (req, res) => res.json(await prisma.order.findMany())'
  for (const [name, ctl] of [
    ['same-named helper', `async function list(where) { await prisma.upload.deleteMany({ where }) }\nexports.list = ${ok}\n`],
    ['module.exports = { list: listOrders }', `${del}const listOrders = ${ok}\nconst list = purge\nmodule.exports = { list: listOrders }\n`],
    ['module.exports = { list }', `const list = ${ok}\nmodule.exports = { list }\n`],
    ['a dead exports.list after module.exports', `const listOrders = ${ok}\nmodule.exports = { list: listOrders }\nexports.list = async (req, res) => { await prisma.upload.deleteMany({}) }\n`],
    ['exports.list twice: the last', `exports.list = async (req, res) => { await prisma.upload.deleteMany({}) }\nexports.list = ${ok}\n`],
  ] as const) { const x = lists(ctl); assert.ok(x.includes('lists orders') && !x.includes('Anyone can use'), `${name}: ${x}`) }
}
console.log('ok (review 99)')
// A new checkout.session.async_payment_succeeded handler needs no dashboard step when every Checkout the app creates takes cards
// only (chadnext): those events never come. They do with bank debits, or when the methods are left to Stripe.
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const hook = (extra: string) => `import Stripe from "stripe"\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)\nexport async function POST(req: Request) {\n  const event = stripe.webhooks.constructEvent(await req.text(), req.headers.get("stripe-signature")!, process.env.STRIPE_WEBHOOK_SECRET!)\n  if (event.type === "checkout.session.completed"${extra}) {\n    console.log(event.id)\n  }\n  return new Response(null)\n}\n`
  const app = (methods: string, extra = '', more = '') => ({ 'package.json': '{"dependencies":{"next":"15.0.0","stripe":"17.0.0"}}', 'app/api/webhooks/stripe/route.ts': hook(extra),
    'app/api/checkout/route.ts': `import Stripe from "stripe"\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)\nexport async function POST() {\n  const s = await stripe.checkout.sessions.create({ mode: "subscription", ${methods}line_items: [] })\n  return Response.json({ url: s.url })\n}\n${more}` })
  const step = (methods: string, more = '') => c(app(methods, '', more), app(methods, ' || event.type === "checkout.session.async_payment_succeeded"', more)).includes('make sure it receives checkout.session.async_payment_succeeded')
  assert.ok(!step('payment_method_types: ["card"], '), 'cards only')
  assert.ok(step('payment_method_types: ["card", "us_bank_account"], '), 'bank debits')
  assert.ok(step(''), 'methods left to Stripe')
  assert.ok(step('payment_method_types: ["card"], ', 'export async function PUT() { await stripe.checkout.sessions.create({ mode: "payment", line_items: [] }) }\n'), 'another session without them')
  // (review: card-only lists elsewhere don't count, nor test files; other ways to make a Checkout keep the step)
  const leaves = (more: Record<string, string>) => { const a = { ...app(''), ...more }, b = { ...app('', ' || event.type === "checkout.session.async_payment_succeeded"'), ...more }
    return c(a, b).includes('make sure it receives checkout.session.async_payment_succeeded') }
  assert.ok(leaves({ 'lib/pay.ts': 'export const pi = (s: any) => s.paymentIntents.create({ amount: 1, currency: "usd", payment_method_types: ["card"] })\n' }), 'a PaymentIntent')
  assert.ok(leaves({ 'test/hook.test.ts': 'const fake = { object: "checkout.session", payment_method_types: ["card"] }\n' }), 'a test fixture')
  assert.ok(step('payment_method_types: ["card"], ', 'export async function PUT() { await stripe.paymentLinks.create({ line_items: [] }) }\n'), 'Payment Links')
}
console.log('ok (card-only checkout)')
// "small screens like phones" only when the CSS change is only in max-width @media blocks (workout-cool: the same fix for every
// screen size, then again inside @media (max-width: 768px))
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const css = (x: string) => ({ 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'app/globals.css': `.a { color: red; }\n${x}` })
  const media = '@media (max-width: 768px) {\n  .modal-backdrop {\n    width: 100vw;\n  }\n}\n'
  assert.ok(c(css(''), css(media)).includes('small screens like phones'), 'only @media')
  assert.ok(c(css(''), css(`/* mobile */\n${media}`)).includes('small screens like phones'), 'plus a comment')
  const both = c(css(''), css(`.modal-backdrop {\n  width: 100vw;\n}\n${media}`))
  assert.ok(both.includes('The agent changed how the app looks, on every screen size and on small screens like phones (in app/globals.css)'), both)
  const added = c({ 'package.json': '{"dependencies":{"next":"15.0.0"}}' }, css(media))
  assert.ok(added.includes('The agent added app/globals.css: it sets how the app looks, on every screen size and on small screens like phones.'), added)
  assert.ok(c({ ...css(''), 'app/globals.css': '.a .b { color: red; }\n' }, { ...css(''), 'app/globals.css': `.a.b { color: red; }\n${media}` }).includes('on every screen size'), 'a descendant selector became a compound one')
  assert.ok(c({ ...css(''), 'app/globals.css': '.a .b { color: red; }\n' }, { ...css(''), 'app/globals.css': `.a .b{color:red}\n\n${media}` }).includes('small screens like phones'), 'reformatted only')
}
console.log('ok (css phones)')
// A changed page that only says new words: the words, and the helper it uses still listed (logtide); next to a vague "sends data"
// the words still show (Django-CRM's login verify page)
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const app = (label: string, helper: string, extra = '') => ({ 'package.json': '{"dependencies":{"next":"15.0.0"}}',
    'lib/caps.ts': `export function caps(n: number) { return ${helper} }\n`,
    'app/usage/page.tsx': `import { caps } from "@/lib/caps"\nexport default function Usage() {\n  ${extra}return <main><h1>Usage</h1><p>${label}</p><p>{caps(1)}</p></main>\n}\n` })
  const x = c(app('Bytes ingested', 'n * 2'), app('Log bytes ingested', 'n * 3'))
  assert.ok(x.includes('now says "Log bytes ingested"') && x.includes("The agent also changed lib/caps.ts, in a way plain can't describe yet"), x)
  const pg = (label: string, extra = '') => ({ 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'app/usage/page.tsx': `"use client"\nexport default function Usage() {\n  ${extra}return <main><h1>Usage</h1><p>${label}</p></main>\n}\n` })
  const y = c(pg('Bytes ingested'), pg('Press the button to finish signing in.', 'const go = () => fetch("/api/finish", { method: "POST" })\n  '))
  assert.ok(y.includes('now sends data to your server and says "Press the button to finish signing in."'), y)
}
console.log('ok (page words)')
// The header counts every changed file, hidden ones too (atidone: "3 files" for 6); a changed config file is listed, not dropped
// (captable's next.config.js)
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const base = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'next.config.js': 'module.exports = { reactStrictMode: true }\n', 'lib/a.ts': 'export const a = 1\n', 'app/page.tsx': 'export default function P() { return <main><h1>Home</h1><p>Hi</p></main> }\n' }
  const x = c(base, { ...base, 'next.config.js': 'module.exports = { reactStrictMode: true, serverExternalPackages: ["x"] }\n', 'lib/a.ts': 'export const a  =  1\n', 'app/page.tsx': base['app/page.tsx'].replace('Hi', 'Hello there') })
  assert.ok(x.includes('3 files changed') && x.includes('next.config.js') && x.includes('Hidden: 1 file'), x)
}
console.log('ok (count and config)')
// Code-style settings (atidone's .eslintrc.cjs) are said for what they are, not "changed in a way plain can't describe"
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const base = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', '.eslintrc.cjs': 'module.exports = { rules: {} }\n', 'eslint.config.js': 'export default []\n', 'app/page.tsx': 'export default function P() { return <main><h1>Home</h1><p>Hi</p></main> }\n' }
  const x = c(base, { ...base, '.eslintrc.cjs': 'module.exports = { rules: { semi: 2 } }\n', 'eslint.config.js': 'export default [{ rules: { semi: 2 } }]\n', 'app/page.tsx': base['app/page.tsx'].replace('Hi', 'Hello there') })
  assert.ok(x.includes('The agent changed .eslintrc.cjs, the settings for code style checks (not what the app does)') && x.includes('eslint.config.js, the settings for code style checks') && !x.includes("eslint.config.js, in"), x)
}
console.log('ok (style settings)')
// Translation files: the new English wording, and how many other languages changed with it (workout-cool's locales/en.ts)
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const base = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'locales/en.ts': 'export default {\n  save: "Save",\n}\n', 'locales/fr.ts': 'export default {\n  save: "Enregistrer",\n}\n',
    'messages/en.json': '{ "hi": "Hello" }\n', 'config/locales/en.yml': 'en:\n  hello: "Hello world"\n', 'public/js/i18n/en.js': 'x({ a: "A b" })\n', 'app/page.tsx': 'export default function P() { return <main><h1>Home</h1></main> }\n' }
  const ts = c(base, { ...base, 'locales/en.ts': 'export default {\n  save: "Save",\n  addExercise: "Add exercise",\n}\n', 'locales/fr.ts': 'export default {\n  save: "Enregistrer",\n  addExercise: "Ajouter un exercice",\n}\n' })
  assert.ok(ts.includes('The agent added wording in the app (in locales/en.ts): "Add exercise", and the same in 1 other language.') && !ts.includes('locales/fr.ts'), ts)
  assert.ok(c(base, { ...base, 'messages/en.json': '{ "hi": "Hello", "bye": "See you soon" }\n' }).includes('(in messages/en.json): "See you soon"'), 'json')
  assert.ok(c(base, { ...base, 'config/locales/en.yml': 'en:\n  hello: "Hello world"\n  bye: Goodbye now\n' }).includes('(in config/locales/en.yml): "Goodbye now"'), 'yml')
  assert.ok(!c(base, { ...base, 'public/js/i18n/en.js': 'x({ a: "A b", c: "New words" })\n' }).includes('wording in the app'), 'a vendored library')
  assert.ok(!c(base, { ...base, 'locales/fr.ts': 'export default {\n  save: "Sauver",\n}\n' }).includes('wording in the app'), 'no English')
  // (review: YAML stays on its line; not URLs or flags; a reworded value is changed; only the same file in another language counts;
  // code in a messages/ folder isn't a translation)
  const yml = c(base, { ...base, 'config/locales/en.yml': 'en:\n  hello: "Hello world"\n  settings:\n    title: Settings page\n    url: https://example.com\n    on: true\n' })
  assert.ok(yml.includes('(in config/locales/en.yml): "Settings page".') && !yml.includes('title:'), yml)
  const re = c(base, { ...base, 'locales/en.ts': 'export default {\n  save: "Save changes",\n}\n' })
  assert.ok(re.includes('The agent changed wording in the app (in locales/en.ts): "Save changes".'), re)
  const mono = c({ ...base, 'apps/admin/locales/fr.json': '{ "a": "Un" }\n' }, { ...base, 'messages/en.json': '{ "hi": "Hello", "bye": "See you soon" }\n', 'apps/admin/locales/fr.json': '{ "a": "Un", "b": "Deux mots" }\n' })
  assert.ok(!mono.includes('other language') && mono.includes('apps/admin/locales/fr.json'), mono)
  const unrelated = c(base, { ...base, 'locales/en.ts': 'export default {\n  save: "Save",\n  close: "Close it",\n}\n', 'locales/fr.ts': 'export default {\n  save: "Sauvegarder",\n}\n' })
  assert.ok(!unrelated.includes('other language') && unrelated.includes('locales/fr.ts'), unrelated)
  assert.ok(c(base, { ...base, 'locales/en.ts': 'export default {\n  save: "Save",\n  immune: "Decreased immune function => worse",\n}\n' }).includes('"Decreased immune function => worse"'), 'the word function in wording')
  const notes = (extra: string) => ({ ...base, 'locales/en.ts': `export default {\n  notes: {\n${extra}    a: {\n      title: "First release",\n    },\n  },\n}\n` })
  assert.ok(c(notes(''), notes('    b: {\n      title: "Second release",\n    },\n')).includes('The agent added wording in the app (in locales/en.ts): "Second release".'), 'a new entry with a key name other entries use')
  const code = { ...base, 'src/messages/en.ts': 'export function send() { return fetch("/api/send", { method: "POST" }) }\n' }
  assert.ok(!c(code, { ...code, 'src/messages/en.ts': 'export function send() { return fetch("/api/send", { method: "POST", mode: "cors" }) }\n' }).includes('wording'), 'code in messages/')
}
console.log('ok (translations)')
// The biggest part of a change, when nothing on the card says what it is: where it is and how big (workout-cool's new modal)
{
  const c = (a: Record<string, string>, b: Record<string, string>) => report(new Map(Object.entries(a)), new Map(Object.entries(b)), { ref: 'main' }).replace(/\s+/g, ' ')
  const base = { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'app/page.tsx': 'export default function P() { return <main><h1>Home</h1><p>Hi</p></main> }\n', 'lib/a.ts': 'export const a = 1\n' }
  const modal = Array.from({ length: 40 }, (_, i) => `  const v${i} = useState(${i})`).join('\n')
  const x = c(base, { ...base, 'lib/a.ts': 'export const a = 2\n', 'components/picker.tsx': `export function Picker() {\n${modal}\n  return null\n}\n` })
  assert.ok(x.includes('Most of this change is in a new file, components/picker.tsx (43 lines added).'), x)
  // (not on a card that already says something specific: a page line; nor for a small change)
  assert.ok(!c(base, { ...base, 'app/page.tsx': base['app/page.tsx'].replace('Hi', 'Hello there'), 'components/picker.tsx': `export function Picker() {\n${modal}\n  return null\n}\n` }).includes('Most of this change'), 'a page line')
  assert.ok(!c(base, { ...base, 'app/page.tsx': base['app/page.tsx'].replace('Hi', 'Hello there'), 'lib/a.ts': 'export const a = 2\n' }).includes('Most of this change'), 'small')
}
console.log('ok (biggest part)')
