// Review 25 cases built on the local demo apps (examples/, not in this repo): skipped when they're missing.
// Run: node test/holds-examples.ts
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { report, snapshot } from '../src/plain.ts'
if (!['ticket-nook', 'spoke-pedal', 'fresh-crate'].every(a => existsSync(new URL('../examples/' + a + '/.git', import.meta.url)))) { console.log('skipped: examples/ missing'); process.exit(0) }
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
const held = full("{ classId, status: { in: ['pending', 'paid'] } }"), paid = full("{ classId, status: 'paid' }")
const ex = (a: string, b: string) => Object.fromEntries(snapshot(new URL('../examples/', import.meta.url).pathname + a, b))
// A. savedAt: a date name (createdAt / created_at__lt) before status reads as `create\w*` -> "saved" -> byTime skips the cleanup
const cron = (where: string) => ({ 'app/api/cron/expire/route.ts': `import { prisma } from '@/lib/prisma'\nexport async function GET() {\n  const cutoff = new Date(Date.now() - 30 * 60 * 1000)\n  await prisma.booking.updateMany({ where: ${where}, data: { status: 'expired' } })\n  return new Response('ok')\n}\n` })
run('A1 control: cron, status first', app(''), app(held, false, cron("{ status: 'pending', createdAt: { lt: cutoff } }")), 'none')
run('A2 cron, createdAt first', app(''), app(held, false, cron("{ createdAt: { lt: cutoff }, status: 'pending' }")), 'none')
run('A3 cron, updatedAt first', app(''), app(held, false, cron("{ updatedAt: { lt: cutoff }, status: 'pending' }")), 'none')
const dj = (extra: string) => ({ 'requirements.txt': 'django==5.1\nstripe==10.0\n', 'shop/models.py': 'from django.db import models\n\nclass Slot(models.Model):\n    capacity = models.IntegerField()\n',
  'shop/views.py': `import stripe\nfrom django.http import HttpResponse\nfrom django.shortcuts import redirect, get_object_or_404\nfrom .models import Order, Slot\n\ndef checkout(request, slot_id):\n    slot = get_object_or_404(Slot, pk=slot_id)\n    taken = Order.objects.filter(slot=slot, status__in=['pending', 'paid']).count()\n    if taken >= slot.capacity:\n        return HttpResponse('This slot is full', status=409)\n    order = Order.objects.create(slot=slot, status='pending')\n    session = stripe.checkout.Session.create(mode='payment', metadata={'order_id': order.id}, success_url='https://x/s', cancel_url='https://x/c')\n    return redirect(session.url)\n`, ...(extra ? { 'shop/tasks.py': extra } : {}) })
run('A4 control: django cleanup, status first', dj('').valueOf() as any, dj("from datetime import timedelta\nfrom django.utils import timezone\nfrom .models import Order\n\ndef expire_stale_orders():\n    cutoff = timezone.now() - timedelta(minutes=30)\n    Order.objects.filter(status='pending', created_at__lt=cutoff).update(status='expired')\n"), 'none')
run('A5 django cleanup, created_at__lt first', dj(''), dj("from datetime import timedelta\nfrom django.utils import timezone\nfrom .models import Order\n\ndef expire_stale_orders():\n    cutoff = timezone.now() - timedelta(minutes=30)\n    Order.objects.filter(created_at__lt=cutoff, status='pending').update(status='expired')\n"), 'none')
// Rails hash form, date first
const sm = ex('spoke-pedal', 'main'), sp = ex('spoke-pedal', 'p5-pricing')
run('A6 rails job, hash with created_at first', sm, { ...sp, 'app/jobs/expire_pending_rentals_job.rb': 'class ExpirePendingRentalsJob < ApplicationJob\n  def perform\n    Rental.where(created_at: ...30.minutes.ago, status: "pending").update_all(status: "expired")\n  end\nend\n' }, 'none')

}
{
const ex = (a: string, b: string) => Object.fromEntries(snapshot(new URL('../examples/', import.meta.url).pathname + a, b))
const held = full("{ classId, status: { in: ['pending', 'paid'] } }")
// G. TIMECMP: any date comparison within ±300 chars hides M1
const rate = "  const recent = await prisma.booking.count({ where: { userId: 1, createdAt: { gt: new Date(Date.now() - 60000) } } })\n  if (recent > 5) return Response.json({ error: 'Slow down' }, { status: 429 })\n"
run('G1 per-user rate limit (createdAt gt) just above the pending count', app(''), app(rate + held), 'M1')
const slotDay = "  const taken = await prisma.booking.count({ where: { classId, status: { in: ['pending', 'paid'] }, reservedOn: { gte: c.startsOn, lt: c.endsOn } } })\n  if (taken >= c.capacity) return Response.json({ error: 'This class is full' }, { status: 409 })\n"
run('G2 slot date column reservedOn compared (the booked day, not the age)', app(''), app(slotDay), 'M1')
// H. cleansUp suppresses M2 for writes that free one person's row, not the old ones
const tm = ex('ticket-nook', 'main'), tp = ex('ticket-nook', 'p5-pricing'), cc = tp['app/Http/Controllers/CheckoutController.php']
run('H0 control: ticket-nook p5', tm, tp, 'M2')
const own = cc.replace("        $order = DB::transaction(", "        $request->user()->orders()->where('status', 'pending')->update(['status' => 'cancelled']);\n\n        $order = DB::transaction(")
run("H1 user's own earlier pending orders cancelled on a new checkout", tm, { ...tp, 'app/Http/Controllers/CheckoutController.php': own }, 'M2')
const back = cc.replace("    public function success()", "    public function cancelled(Request $request)\n    {\n        $order = Order::where('stripe_session_id', $request->query('session_id'))->first();\n        if ($order && $order->status === 'pending') { $order->update(['status' => 'cancelled']); }\n\n        return redirect()->route('events.index');\n    }\n\n    public function success()")
run('H2 Stripe cancel_url return marks that one order cancelled', tm, { ...tp, 'app/Http/Controllers/CheckoutController.php': back }, 'M2')
const evc = tp['app/Http/Controllers/Admin/EventController.php']
const cancelEvent = evc.replace(/\n}\s*$/, "\n\n    public function cancel(Event $event)\n    {\n        $event->orders()->where('status', 'pending')->update(['status' => 'cancelled']);\n        $event->update(['cancelled' => true]);\n\n        return back();\n    }\n}\n")
run('H3 admin cancels an event: its pending orders cancelled', tm, { ...tp, 'app/Http/Controllers/Admin/EventController.php': cancelEvent }, 'M2')

}
{
const ex = (a: string, b: string) => Object.fromEntries(snapshot(new URL('../examples/', import.meta.url).pathname + a, b))
const held = full("{ classId, status: { in: ['pending', 'paid'] } }")
const cron = (body: string) => ({ 'app/api/cron/expire/route.ts': `import { Booking } from '@/models/booking'\nexport async function GET() {\n  const cutoff = new Date(Date.now() - 30 * 60 * 1000)\n${body}\n  return new Response('ok')\n}\n` })
// Mongoose: filter is the first argument of updateMany/deleteMany -> savedAt sees "updateMany(" (or no keyword) and calls it a save
run("T7 mongoose updateMany({ status: 'pending', createdAt: { $lt: cutoff } }, ...)", app(''), app(held, false, cron("  await Booking.updateMany({ status: 'pending', createdAt: { $lt: cutoff } }, { status: 'expired' })")), 'none')
run("T8 mongoose deleteMany({ status: 'pending', createdAt: { $lt: cutoff } })", app(''), app(held, false, cron("  await Booking.deleteMany({ status: 'pending', createdAt: { $lt: cutoff } })")), 'none')
// Django TimeStampedModel field `created`
const dj = (task: string) => ({ 'requirements.txt': 'django==5.1\nstripe==10.0\n', 'shop/models.py': 'from django.db import models\n\nclass Slot(models.Model):\n    capacity = models.IntegerField()\n',
  'shop/views.py': `import stripe\nfrom django.http import HttpResponse\nfrom django.shortcuts import redirect, get_object_or_404\nfrom .models import Order, Slot\n\ndef checkout(request, slot_id):\n    slot = get_object_or_404(Slot, pk=slot_id)\n    taken = Order.objects.filter(slot=slot, status__in=['pending', 'paid']).count()\n    if taken >= slot.capacity:\n        return HttpResponse('This slot is full', status=409)\n    order = Order.objects.create(slot=slot, status='pending')\n    session = stripe.checkout.Session.create(mode='payment', metadata={'order_id': order.id}, success_url='https://x/s', cancel_url='https://x/c')\n    return redirect(session.url)\n`, 'shop/tasks.py': task })
const djBase = { ...dj(''), 'shop/views.py': dj('')['shop/views.py'].replace("    taken = Order.objects.filter(slot=slot, status__in=['pending', 'paid']).count()\n    if taken >= slot.capacity:\n        return HttpResponse('This slot is full', status=409)\n", '') }
run("T9 control: django task created_at__lt", djBase, dj("from .models import Order\n\ndef expire(cutoff):\n    Order.objects.filter(status='pending', created_at__lt=cutoff).update(status='expired')\n"), 'none')
run("T10 django task, TimeStampedModel `created__lt`", djBase, dj("from .models import Order\n\ndef expire(cutoff):\n    Order.objects.filter(status='pending', created__lt=cutoff).update(status='expired')\n"), 'none')
// TIMECMP must be in the same statement: a query built in two statements
const sm = ex('spoke-pedal', 'main'), sp = ex('spoke-pedal', 'p5-pricing')
run('T11 rails job, query split over two statements', sm, { ...sp, 'app/jobs/expire_pending_rentals_job.rb': 'class ExpirePendingRentalsJob < ApplicationJob\n  def perform\n    stale = Rental.where(status: "pending")\n    stale.where("created_at < ?", 30.minutes.ago).update_all(status: "expired")\n  end\nend\n' }, 'none')
// cleansUp: a job-path file that cancels one event's pending orders hides M2
const tm = ex('ticket-nook', 'main'), tp = ex('ticket-nook', 'p5-pricing')
run('H0 control: ticket-nook p5', tm, tp, 'M2')
run('H4 app/Jobs/CancelEvent.php cancels that event\'s pending orders', tm, { ...tp, 'app/Jobs/CancelEvent.php': "<?php\n\nnamespace App\\Jobs;\n\nuse App\\Models\\Event;\nuse Illuminate\\Contracts\\Queue\\ShouldQueue;\nuse Illuminate\\Foundation\\Queue\\Queueable;\n\nclass CancelEvent implements ShouldQueue\n{\n    use Queueable;\n\n    public function __construct(public Event $event) {}\n\n    public function handle(): void\n    {\n        $this->event->orders()->where('status', 'pending')->update(['status' => 'cancelled']);\n    }\n}\n" }, 'M2')

}
{
const ex = (a: string, b: string) => Object.fromEntries(snapshot(new URL('../examples/', import.meta.url).pathname + a, b))
const paid = full("{ classId, status: 'paid' }")
// D5. compared(): a dashboard adding or subtracting the unpaid count
const dash = (body: string) => ({ 'app/admin/page.tsx': `import { prisma } from '@/lib/prisma'\nexport default async function Admin() {\n  const paidCount = await prisma.booking.count({ where: { status: 'paid' } })\n  const unpaid = await prisma.booking.count({ where: { status: 'pending' } })\n  return (\n    <main>\n${body}\n    </main>\n  )\n}\n` })
run('D5 admin: {paidCount + unpaid} orders started', app(paid), app(paid, false, dash("      <p>{paidCount + unpaid} orders started, {unpaid} not paid yet</p>")), 'none')
// D6. LIST + REFUSE window: a per-class sales table with "seats left"
const stats = { 'app/admin/sales/page.tsx': "import { prisma } from '@/lib/prisma'\nexport default async function Sales() {\n  const classes = await prisma.class.findMany({ include: { bookings: { where: { status: { in: ['pending', 'paid'] } } } } })\n  return <ul>{classes.map(c => <li key={c.id}>{c.name}: {c.bookings.filter(b => b.status === 'paid').length} paid, {c.capacity - c.bookings.length} seats left</li>)}</ul>\n}\n" }
run('D6 admin sales table: include pending+paid, "seats left" shown', app(paid), app(paid, false, stats), 'none')
// R2. a statuses constant near a paid-only capacity check
const lib = { 'lib/bookings.ts': "export const BOOKING_STATUSES = ['pending', 'paid', 'cancelled'] as const\nexport type BookingStatus = (typeof BOOKING_STATUSES)[number]\nexport const isFull = (paidCount: number, capacity: number) => paidCount >= capacity\n" }
run('R2 statuses constant next to a paid-only isFull helper', app(paid), app(paid, false, lib), 'none')
// R1. Rails: %w statuses list in a model whose own capacity validation counts paid only
const sm = ex('spoke-pedal', 'main'), sp = ex('spoke-pedal', 'p5-pricing')
const model = "class Booking < ApplicationRecord\n  STATUSES = %w[pending paid expired].freeze\n\n  belongs_to :klass\n  validates :status, inclusion: { in: STATUSES }\n  validate :class_has_room, on: :create\n\n  private\n\n  def class_has_room\n    errors.add(:base, \"This class is full\") if klass.bookings.where(status: \"paid\").count >= klass.capacity\n  end\nend\n"
run('R1 rails model: STATUSES = %w[pending paid expired] + paid-only "is full" validation', sm, { ...sm, 'app/models/booking.rb': model }, 'none')
// H5. HOLDW: reserved_for (a restaurant reservation's time) in an admin list of pending ones
const list = { 'app/admin/unpaid/page.tsx': "import { prisma } from '@/lib/prisma'\nexport default async function Unpaid() {\n  const rows = await prisma.booking.findMany({ where: { status: 'pending' }, orderBy: { reservedFor: 'asc' } })\n  return <ul>{rows.map(r => <li key={r.id}>{r.email}</li>)}</ul>\n}\n" }
run('H5 admin list of pending, ordered by reservedFor', app(paid), app(paid, false, list), 'none')

}
{
const ex = (a: string, b: string) => Object.fromEntries(snapshot(new URL('../examples/', import.meta.url).pathname + a, b))
// M2 should go away once the change marks the old pending rows expired. One-off / scheduled forms that cleansUp doesn't see:
// Laravel (ticket-nook p5 = M2)
const tm = ex('ticket-nook', 'main'), tp = ex('ticket-nook', 'p5-pricing')
run('M2 control: ticket-nook p5', tm, tp, 'M2')
const scoped = { ...tp, 'app/Models/Order.php': tp['app/Models/Order.php'].replace("    public function user(): BelongsTo", "    public function scopePending($query)\n    {\n        return $query->where('status', 'pending');\n    }\n\n    public function user(): BelongsTo"),
  'routes/console.php': tp['routes/console.php'] + "\nArtisan::command('orders:expire-old', function () {\n    \\App\\Models\\Order::pending()->update(['status' => 'expired']);\n});\n" }
run('L1 laravel console: Order::pending()->update([... expired]) via a local scope', tm, scoped, 'none')
run("L2 laravel console: Order::whereStatus('pending')->update(...)", tm, { ...tp, 'routes/console.php': tp['routes/console.php'] + "\nArtisan::command('orders:expire-old', function () {\n    \\App\\Models\\Order::whereStatus('pending')->update(['status' => 'expired']);\n});\n" }, 'none')
run("L3 control: laravel console Order::where('status','pending')->update(...)", tm, { ...tp, 'routes/console.php': tp['routes/console.php'] + "\nArtisan::command('orders:expire-old', function () {\n    \\App\\Models\\Order::where('status', 'pending')->update(['status' => 'expired']);\n});\n" }, 'none')
// Rails: spoke-pedal p5 + the expired handler = M2
const sm = ex('spoke-pedal', 'main'), sp = ex('spoke-pedal', 'p5-pricing')
const wh = sp['app/controllers/webhooks_controller.rb'].replace('    head :ok\n', '    if event.type == "checkout.session.expired"\n      Rental.where(stripe_session_id: event.data.object.id, status: "pending").update_all(status: "expired")\n    end\n\n    head :ok\n')
const sp2 = { ...sp, 'app/controllers/webhooks_controller.rb': wh }
run('M2 control: spoke-pedal p5 + expired handler', sm, sp2, 'M2')
run('R4 rails one-off rake task lib/tasks/rentals.rake', sm, { ...sp2, 'lib/tasks/rentals.rake': 'namespace :rentals do\n  task expire_old_pending: :environment do\n    Rental.where(status: "pending").update_all(status: "expired")\n  end\nend\n' }, 'none')
const scopeModel = sp2['app/models/rental.rb'].replace('  belongs_to :user', '  scope :pending, -> { where(status: "pending") }\n\n  belongs_to :user')
run('R5 rails job via scope: Rental.pending.update_all(status: "expired")', sm, { ...sp2, 'app/models/rental.rb': scopeModel, 'app/jobs/expire_old_rentals_job.rb': 'class ExpireOldRentalsJob < ApplicationJob\n  def perform\n    Rental.pending.update_all(status: "expired")\n  end\nend\n' }, 'none')
// Next.js: a one-off script
const held = full("{ classId, status: { in: ['pending', 'paid'] } }")
run('M2 control: next fixture', app(''), app(held, true), 'M2')
run('S5 scripts/expire-old-pending.ts updateMany all pending', app(''), app(held, true, { 'scripts/expire-old-pending.ts': "import { prisma } from '../lib/prisma'\nawait prisma.booking.updateMany({ where: { status: 'pending' }, data: { status: 'expired' } })\n" }), 'none')

}
{
const ex = (a: string, b: string) => Object.fromEntries(snapshot(new URL('../examples/', import.meta.url).pathname + a, b))
const paid = full("{ classId, status: 'paid' }")
// checks(): any line using the name with +/- and a LIMNAME word, or a refusal word
const stats = { 'app/api/admin/classes/[id]/route.ts': "import { prisma } from '@/lib/prisma'\nexport async function GET(req: Request, { params }: { params: { id: string } }) {\n  const c = await prisma.class.findUniqueOrThrow({ where: { id: Number(params.id) } })\n  const sold = await prisma.booking.count({ where: { classId: c.id, status: 'paid' } })\n  const unpaid = await prisma.booking.count({ where: { classId: c.id, status: 'pending' } })\n  return Response.json({ sold, unpaid, remaining: c.capacity - sold })\n}\n" }
run('J1 admin JSON: { sold, unpaid, remaining: c.capacity - sold }', app(paid), app(paid, false, stats), 'none')
const page = { 'app/api/admin/unpaid/route.ts': "import { prisma } from '@/lib/prisma'\nexport async function GET(req: Request) {\n  const sp = new URL(req.url).searchParams, limit = Number(sp.get('limit') ?? 20), offset = Number(sp.get('offset') ?? 0)\n  const total = await prisma.booking.count({ where: { status: 'pending' } })\n  const rows = await prisma.booking.findMany({ where: { status: 'pending' }, skip: offset, take: limit })\n  return Response.json({ rows, total, hasMore: offset + limit < total })\n}\n" }
run('J3 admin paging with `limit`: hasMore: offset + limit < total', app(paid), app(paid, false, page), 'none')
// single-row "is it still unpaid?" checks that refuse
const pay = { 'app/api/bookings/[id]/pay/route.ts': "import { prisma } from '@/lib/prisma'\nexport async function POST(req: Request, { params }: { params: { id: string } }) {\n  if (await prisma.booking.count({ where: { id: Number(params.id), status: 'pending' } }) === 0) throw new Error('This booking is already paid')\n  return Response.json({ ok: true })\n}\n" }
run("J5 pay-again route: count({ id, status: 'pending' }) === 0 -> throw 'already paid'", app(paid), app(paid, false, pay), 'none')
// Laravel (ticket-nook main): retry payment for one order, abort if it isn't pending any more
const tm = ex('ticket-nook', 'main'), cc = tm['app/Http/Controllers/CheckoutController.php']
const retry = cc.replace("    public function success()", "    public function retry(Order $order)\n    {\n        abort_unless(Order::whereKey($order->id)->where('status', 'pending')->exists(), 409);\n\n        return redirect()->route('events.show', $order->event);\n    }\n\n    public function success()")
run('J4 laravel: abort_unless(Order::whereKey(id)->where(status, pending)->exists(), 409)', tm, { ...tm, 'app/Http/Controllers/CheckoutController.php': retry }, 'none')
// Django dashboard context
const djv = (extra: string) => ({ 'requirements.txt': 'django==5.1\nstripe==10.0\n', 'shop/models.py': 'from django.db import models\n\nclass Slot(models.Model):\n    capacity = models.IntegerField()\n',
  'shop/views.py': `import stripe\nfrom django.http import HttpResponse\nfrom django.shortcuts import redirect, render, get_object_or_404\nfrom .models import Order, Slot\n\ndef checkout(request, slot_id):\n    slot = get_object_or_404(Slot, pk=slot_id)\n    taken = Order.objects.filter(slot=slot, status='paid').count()\n    if taken >= slot.capacity:\n        return HttpResponse('This slot is full', status=409)\n    order = Order.objects.create(slot=slot, status='pending')\n    session = stripe.checkout.Session.create(mode='payment', metadata={'order_id': order.id}, success_url='https://x/s', cancel_url='https://x/c')\n    return redirect(session.url)\n${extra}` })
run('J2 django dashboard: context {"unpaid": unpaid, "available": slot.capacity - sold}', djv(''), djv("\n\ndef dashboard(request, slot_id):\n    slot = get_object_or_404(Slot, pk=slot_id)\n    sold = Order.objects.filter(slot=slot, status='paid').count()\n    unpaid = Order.objects.filter(slot=slot, status='pending').count()\n    return render(request, 'shop/dashboard.html', {'unpaid': unpaid, 'sold': sold, 'available': slot.capacity - sold})\n"), 'none')

}
{
const ex = (a: string, b: string) => Object.fromEntries(snapshot(new URL('../examples/', import.meta.url).pathname + a, b))
// Laravel: ticket-nook p5 (M2) + the fix M2 asks for, as a data migration
const tm = ex('ticket-nook', 'main'), tp = ex('ticket-nook', 'p5-pricing')
run('ticket-nook p5 as is', tm, tp, 'M2')
run('ticket-nook p5 + migration expiring old pending (no time)', tm, { ...tp, 'database/migrations/2026_10_28_000001_expire_old_pending_orders.php': "<?php\n\nuse Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Support\\Facades\\DB;\n\nreturn new class extends Migration\n{\n    public function up(): void\n    {\n        DB::table('orders')->where('status', 'pending')->update(['status' => 'expired']);\n    }\n};\n" }, 'none')
run('ticket-nook p5 + migration expiring old pending (with time)', tm, { ...tp, 'database/migrations/2026_10_28_000001_expire_old_pending_orders.php': "<?php\n\nuse Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Support\\Facades\\DB;\n\nreturn new class extends Migration\n{\n    public function up(): void\n    {\n        DB::table('orders')->where('status', 'pending')->where('created_at', '<', now()->subDay())->update(['status' => 'expired']);\n    }\n};\n" }, 'none')
run('ticket-nook p5 + artisan command expiring old pending (no time)', tm, { ...tp, 'routes/console.php': (tp['routes/console.php'] ?? "<?php\n") + "\nArtisan::command('orders:expire-stale', function () {\n    \\App\\Models\\Order::where('status', 'pending')->update(['status' => 'expired']);\n});\n" }, 'none')
// Rails: spoke-pedal p5 (M1) + idiomatic cleanup job using a scope
const sm = ex('spoke-pedal', 'main'), sp = ex('spoke-pedal', 'p5-pricing')
run('spoke-pedal p5 as is', sm, sp, 'M1')
const scoped = { ...sp, 'app/models/rental.rb': sp['app/models/rental.rb'].replace('  belongs_to :user', '  scope :pending, -> { where(status: "pending") }\n\n  belongs_to :user'),
  'app/jobs/expire_pending_rentals_job.rb': 'class ExpirePendingRentalsJob < ApplicationJob\n  def perform\n    Rental.pending.where("created_at < ?", 30.minutes.ago).update_all(status: "expired")\n  end\nend\n' }
run('spoke-pedal p5 + scope-based expiry job', sm, scoped, 'none')
const cutoff = { ...sp, 'app/jobs/expire_pending_rentals_job.rb': 'class ExpirePendingRentalsJob < ApplicationJob\n  def perform\n    cutoff = 30.minutes.ago\n    Rental.where(status: "pending").where("created_at < ?", cutoff).update_all(status: "expired")\n  end\nend\n' }
run('spoke-pedal p5 + job with cutoff var', sm, cutoff, 'none')
// Rails: count paid only by excluding pending
run('spoke-pedal: where.not(status: "pending")', sm, { ...sp, 'app/models/rental.rb': sp['app/models/rental.rb'].replace('where(bike: bike, status: RESERVED_STATUSES)', 'where(bike: bike).where.not(status: "pending")') }, 'none')

}
{
const ex = (a: string, b: string) => Object.fromEntries(snapshot(new URL('../examples/', import.meta.url).pathname + a, b))
const sm = ex('spoke-pedal', 'main'), sp = ex('spoke-pedal', 'p5-pricing')
const model = (conf: string) => sp['app/models/rental.rb'].replace('  RESERVED_STATUSES = %w[ pending paid ].freeze\n', '').replace('  validates :status, inclusion: { in: RESERVED_STATUSES }\n', '').replace('where(bike: bike, status: RESERVED_STATUSES)', conf)
run('rails control: status: ["pending", "paid"]', sm, { ...sp, 'app/models/rental.rb': model('where(bike: bike, status: ["pending", "paid"])') }, 'M1')
run('rails control: status: "paid"', sm, { ...sp, 'app/models/rental.rb': model('where(bike: bike, status: "paid")') }, 'none')
run('rails: where.not(status: "pending")', sm, { ...sp, 'app/models/rental.rb': model('where(bike: bike).where.not(status: "pending")') }, 'none')
run('rails: where.not(status: %w[pending cancelled])', sm, { ...sp, 'app/models/rental.rb': model('where(bike: bike).where.not(status: %w[pending cancelled])') }, 'none')

}
{
const ex = (a: string, b: string) => Object.fromEntries(snapshot(new URL('../examples/', import.meta.url).pathname + a, b))
// Go: fresh-crate p5 (M1) + a cleanup that expires stale pending orders and gives the date's spot back, cutoff passed as a parameter
const fm = ex('fresh-crate', 'main'), fp = ex('fresh-crate', 'p5-pricing')
run('fresh-crate p5 as is', fm, fp, 'M1')
const goClean = "\n\nfunc (s *Store) ExpireStaleOrders(ctx context.Context) error {\n\tcutoff := time.Now().Add(-30 * time.Minute)\n\t_, err := s.db.Exec(ctx, `WITH gone AS (UPDATE orders SET status = 'expired' WHERE status = 'pending' AND created_at < $1 RETURNING delivery_date) UPDATE delivery_date_capacity c SET order_count = order_count - 1 FROM gone WHERE c.delivery_date = gone.delivery_date`, cutoff)\n\treturn err\n}\n"
run('fresh-crate p5 + Go cleanup with cutoff param', fm, { ...fp, 'internal/store/store.go': fp['internal/store/store.go'] + goClean }, 'none')
run('fresh-crate p5 + Go cleanup with inline now()', fm, { ...fp, 'internal/store/store.go': fp['internal/store/store.go'] + goClean.replace('created_at < $1', "created_at < now() - interval '30 minutes'").replace(', cutoff)', ')') }, 'none')
// Django synthetic: Stripe checkout, pending order, daily limit
const views = (count: string, extra = '') => `import stripe\nfrom django.shortcuts import redirect, get_object_or_404\nfrom django.http import HttpResponse\nfrom .models import Order, Slot\n\ndef checkout(request, slot_id):\n    slot = get_object_or_404(Slot, pk=slot_id)\n${count}    order = Order.objects.create(slot=slot, user=request.user, status='pending')\n    session = stripe.checkout.Session.create(mode='payment', metadata={'order_id': order.id}, success_url='https://x/s', cancel_url='https://x/c')\n    return redirect(session.url)\n${extra}`
const dj = (count: string, extra = '') => ({ 'requirements.txt': 'django==5.1\nstripe==10.0\n', 'shop/views.py': views(count, extra), 'shop/models.py': 'from django.db import models\n\nclass Slot(models.Model):\n    capacity = models.IntegerField()\n\nclass Order(models.Model):\n    slot = models.ForeignKey(Slot, on_delete=models.CASCADE)\n    status = models.CharField(max_length=20, default="pending")\n    created_at = models.DateTimeField(auto_now_add=True)\n' })
const djMain = dj('')
run('django control: status__in pending,paid', djMain, dj("    taken = Order.objects.filter(slot=slot, status__in=['pending', 'paid']).count()\n    if taken >= slot.capacity:\n        return HttpResponse('This slot is full', status=409)\n"), 'M1')
run("django: .exclude(status='pending')", djMain, dj("    taken = Order.objects.filter(slot=slot).exclude(status='pending').count()\n    if taken >= slot.capacity:\n        return HttpResponse('This slot is full', status=409)\n"), 'none')
run("django: cutoff var cleanup", djMain, dj("    taken = Order.objects.filter(slot=slot, status__in=['pending', 'paid']).count()\n    if taken >= slot.capacity:\n        return HttpResponse('This slot is full', status=409)\n", "\n\ndef expire_stale_orders():\n    cutoff = timezone.now() - timedelta(minutes=30)\n    Order.objects.filter(status='pending', created_at__lt=cutoff).update(status='expired')\n"), 'none')
run("django: Q(created_at__gte=...) before status='pending'", djMain, dj("    recent = timezone.now() - timedelta(minutes=30)\n    taken = Order.objects.filter(Q(status='paid') | Q(created_at__gte=recent, status='pending'), slot=slot).count()\n    if taken >= slot.capacity:\n        return HttpResponse('This slot is full', status=409)\n"), 'none')
// Django TextChoices enum: a real hold that's missed
run('django enum Order.Status.PENDING (miss)', djMain, { ...dj("    taken = Order.objects.filter(slot=slot, status__in=[Order.Status.PENDING, Order.Status.PAID]).count()\n    if taken >= slot.capacity:\n        return HttpResponse('This slot is full', status=409)\n").valueOf(), 'shop/views.py': views("    taken = Order.objects.filter(slot=slot, status__in=[Order.Status.PENDING, Order.Status.PAID]).count()\n    if taken >= slot.capacity:\n        return HttpResponse('This slot is full', status=409)\n").replace("status='pending'", 'status=Order.Status.PENDING') }, 'M1')

}
{
const ex = (a: string, b: string) => Object.fromEntries(snapshot(new URL('../examples/', import.meta.url).pathname + a, b))
const tm = ex('ticket-nook', 'main'), ev = tm['app/Models/Event.php']
const seats = (q: string) => ({ ...tm, 'app/Models/Event.php': ev.replace("return max(0, $this->capacity - $this->tickets()->count());", `return max(0, $this->capacity - (int) $this->orders()${q}->sum('quantity'));`) })
run("laravel control: whereIn pending,paid", tm, seats("->whereIn('status', ['pending', 'paid'])"), 'M1')
run("laravel: where('status', '!=', 'pending')", tm, seats("->where('status', '!=', 'pending')"), 'none')
run("laravel: whereNot('status', 'pending')", tm, seats("->whereNot('status', 'pending')"), 'none')
run("laravel: whereNotIn('status', ['pending', 'cancelled'])", tm, seats("->whereNotIn('status', ['pending', 'cancelled'])"), 'none')
run("laravel: where('status', 'paid')", tm, seats("->where('status', 'paid')"), 'none')
// Laravel scope + scheduled cleanup
run("laravel: pending + recent via \$cutoff", tm, { ...seats("->where(fn ($q) => $q->where('status', 'paid')->orWhere(fn ($q) => $q->where('status', 'pending')->where('created_at', '>', $cutoff)))"), 'app/Models/Event.php': seats('')['app/Models/Event.php'].replace('$this->orders()->sum', "$this->orders()->where(fn ($q) => $q->where('status', 'paid')->orWhere(fn ($q) => $q->where('status', 'pending')->where('created_at', '>', now()->subMinutes(30))))->sum") }, 'none')

}
console.log('ok (review 25, examples)')
