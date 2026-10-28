// One end-to-end check: a tiny repo, one change with planted issues, assert plain names each one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { report, snapshot } from '../src/plain.ts'
import { recapCli } from '../src/session.ts'

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
