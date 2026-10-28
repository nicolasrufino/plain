# Trials, round 7: Laravel (TicketNook)

A ticket shop for a 120-seat venue on Laravel 12: Blade pages, SQLite, an admin area behind `auth`
plus an `admin` middleware, Stripe Checkout through stripe-php, and a webhook that issues the tickets
and emails them. The app is in `examples/ticket-nook`. The method is the same as rounds
[1](trials.md) to [6](trials-angular-aspnet.md): six personas asked Codex for a feature; a separate
grader worked out the truth from the code before reading Codex's explanation or plain's card.
Nothing was run (no PHP on this Mac, and Codex had none either).

| # | Persona | Request |
|---|---|---|
| 1 | Non-technical owner | "can people get a free drink voucher with their first ticket if they make an account" |
| 2 | Student, first project | "add search and filters by date and price on the events page, make it look good on phones" |
| 3 | Knows the basics | "let people who went to a show leave a rating after it and show the average rating on each event page" |
| 4 | Junior developer | "Admins should be able to cancel an event from the admin page, refund everyone who paid through Stripe, and email them." |
| 5 | Experienced developer | "Move pricing into a PricingService, add a $1.50 booking fee per ticket and 8.875% tax, keep the Stripe amount matching, and never sell more tickets than the venue holds even if two people check out at the same time." |
| 6 | Vague and frustrated | "buying tickets is buggy and the admin page is slow, fix it" |

Facts for all six: Laravel doesn't migrate by itself, so "apply the migration before the new code goes
live" is the right step here. Every abandoned checkout on `main` stays a `pending` order forever,
which matters for p5 and p6.

The cards graded below are plain's from **before** this round's fixes. What changed is at the end.

---

## Trial 1: Curious owner floating a promo idea
> "can people get a free drink voucher with their first ticket if they make an account"

Codex first answered the question ("No—not currently"). Told to go ahead, it built the feature.

**What was built:** A `drink_vouchers` table (migration, one voucher per user and per order, unique code, `redeemed_at`). In the Stripe webhook, after the order is marked paid and the tickets are created, the app checks whether this is the user's lowest-id paid order and whether the user has no voucher yet. If both are true, it creates a `DRINK-XXXXXXXX` code. The code is shown on My tickets and in the confirmation email. Promo text was added to the register page and the event page, for logged-out visitors and for logged-in users with no paid order. There is one voucher per first order, whatever the ticket count.

**Ground truth: problems in the real code**
- 🟡 **Nobody can redeem or check a voucher.** `redeemed_at` is never set anywhere. There is no admin or bar screen to look a code up. Bar staff can't tell a real code from a made-up one, and a code can be shown again and again. The "Redeemed …" line on My tickets can never appear.
- 🟡 **Deploy order matters.** If the code goes live before the migration, the webhook crashes after it has marked the order paid and created the tickets, but before the email. Stripe retries, but the order is no longer `pending`, so the email is never sent. My tickets also errors.
- 🟡 **One per account, not one per person.** A new email address plus a paid ticket gets another drink. Low risk, since each one needs a real purchase.
- 🟡 **"If they make an account" adds no rule.** Buying already requires an account.
- ✅ The voucher is only created after Stripe confirms payment, never on signup or for abandoned checkouts. People who bought before the deploy don't get one. The unique `user_id` blocks a second voucher.

**Access:** No new addresses. `/tickets` still needs a login and shows only your own vouchers (`$request->user()->drinkVouchers()`). The event page and register page are public and show the promo to logged-out visitors. The webhook needs a Stripe signature.
**Money:** Prices are unchanged. The webhook (the payment-confirmation path) is changed, and the cost is free drinks.
**Database / deploy:** New table. Run `php artisan migrate --force` before or together with the code.
**Settings:** None new. A real mailer is needed for the voucher email, as it already was for tickets.

| | Codex reply2 / explain | plain |
|---|---|---|
| Voucher is created in the webhook, after the first paid order | ✅ clear, step by step | ✅ "saves drink vouchers" (thin) |
| One per account (unique in the database) | ✅ | 🟡 lists the table's fields, not the one-per-user rule |
| No way to redeem or check a code | ❌ "Optional redemption date", without saying nothing sets it | ❌ lists "redeemed date" as if it works |
| Repeatable with a new account | ❌ | ❌ |
| "If they make an account" adds no rule | 🟡 "Creating an account alone does not issue the voucher" | ❌ |
| My tickets change | ✅ | ❌ "can't describe" (it just loads the user's own vouchers) |
| Promo text on three pages | ✅ | 🟡 file names only |
| Migration before deploy | ✅ | ✅ correct, and it matters (the webhook breaks without it) |
| Testing status | ✅ | ✅ |
| Verdict | — | 🟡 "No problems spotted" misses the missing redemption |

**False statements:**
- Codex reply2: "Database uniqueness prevents repeat vouchers." This holds per account only. A new email address gets another one.
- plain: none found.

**Notes for plain**
1. **Dead field.** A migration adds a column, a view reads it (`$voucher->redeemed_at`), and no code in the app ever assigns it (no `'redeemed_at' =>` and no `->redeemed_at =`). Wording: 🟡 "Vouchers have a 'redeemed' date, but nothing in the app sets it. Staff can't check a code or mark it used."
2. **New step in the payment webhook.** Code added in a webhook handler between the status change (`update(['status' => 'paid'])`) and the email (`Mail::…send`) gets this line: "If this new step fails, the customer's confirmation email is skipped for good. Apply the database change first."
3. **Own-records reads.** `$request->user()->X()->get()` passed to a view → "My tickets now also shows your free drink vouchers (each person sees only their own ✓)." Use this instead of "can't describe".
4. **Promo text on public pages.** When new Blade text contains free/voucher/discount and sits outside `@auth`, quote it and add: "Logged-out visitors see this too."

---

## Trial 2: Owner asking for search and filters
> "add search and filters by date and price on the events page, make it look good on phones"

Codex first asked three design questions. Told "use your best judgement", it built the feature and added `PRODUCT.md`.

**What was built:** The home page (`GET /`) reads `q`, `date_from`, `date_to`, `min_price` and `max_price` from the URL. It validates them (Y-m-d dates, prices 0 to 10000, to ≥ from, max ≥ min). The search checks title or description with LIKE (bound values, no SQL injection). The date filters are inclusive, and prices in dollars are turned into cents. It is a plain GET form with "Show events" and "Clear filters" buttons, a result count, an error box and empty states. The event cards were redone, with responsive CSS at 700px and 420px.

**Ground truth: problems in the real code**
- 🟡 **The restyle hits every page.** The base CSS in `layouts/app.blade.php` was replaced. Buttons are now 44px tall and bold (the header's "Log out" too), the page is wider, and the header and heading spacing changed. Admin, checkout, My tickets and the event page all change. The owner asked only about the events page.
- 🟡 **The card looks tappable but isn't.** Each card has a chevron and a hover lift, but only the title is a link. On a phone, tapping the card or the price does nothing.
- 🟡 A search can match on description text, which the list doesn't show. Some results will look unrelated (minor).
- ✅ Read-only and public, as before. Bad filters redirect back with one message. Past shows stay hidden.

**Access:** `GET /` is public: anyone, logged in or not, read-only. No new addresses.
**Money:** None. **Database:** None. **Settings:** None.

| | Codex reply2 / explain | plain |
|---|---|---|
| Search over title and description | ✅ | ❌ "can't describe" |
| Date and price filters, validated, kept in the URL | ✅ with an example URL | ❌ |
| Public page, read-only | ✅ implied | 🟡 no access line at all |
| Layout CSS changes every page | 🟡 "made spacing… more polished", no warning that other pages change | 🟡 lists `app.blade.php`, doesn't say it is site-wide |
| Card looks clickable, only the title is | ❌ | ❌ |
| Phone layout | ✅ (one small slip, below) | ❌ |
| Testing status | ✅ | ✅ |
| Verdict | — | ✅ "No problems spotted" is fair, but the card is nearly empty |

**False statements:**
- Codex explain: "Two columns on tablets." The two-column layout starts at 700px and below. Most tablets are wider, so they get four columns. Minor.
- plain: none found.

**Notes for plain**
1. **GET filters.** `$request->validate([...])` in a GET action, plus `->when($filters['x'] …)` → "The events page can now be filtered by:" followed by the `<label for>` texts ("Search shows, From, To, Minimum price, Maximum price").
2. **Shared layout.** When `resources/views/layouts/*.blade.php` changes → "This file styles every page. Check a few other pages too (admin, My tickets, buying a ticket), not only the one you asked about."
3. **Public GET.** A GET route outside any `auth` group → "Anyone can use this, logged in or not. It only shows information ✓." That is correct here and worth saying.

---

## Trial 3: Owner asking for ratings
> "let people who went to a show leave a rating after it and show the average rating on each event page"

Codex first asked design questions. Told "use your best judgement", it built the feature.

**What was built:** A `ratings` table (event, user, 1–5, one per user per event). The new `POST /events/{event}/rating` is in the `auth` group. The controller returns 403 unless the show's start time has passed and the user holds a ticket for that event, validates 1–5, then creates or updates that user's rating. The event page shows "Audience rating 4.3 / 5 ★ from N ratings", or "No ratings yet". After the start time the buy form is hidden, and eligible users get a five-star form.

**Ground truth: problems in the real code**
- 🟡 **Blade nesting bug** (`show.blade.php`, a missing `@else` before the second `@auth`). The `@auth…@else…@endauth` block sits inside the `@elseif ($canRate)` branch. Result:
  - Ticket holders see the rating form *and* the line "Only attendees can rate this show."
  - Logged-out visitors and logged-in non-holders see nothing on a past show. The "Log in to rate this show if you attended" prompt never appears.
- 🟡 **Missing table breaks every event page.** `loadAvg('ratings', …)` runs on every event page, so all of them error until the migration is applied. That is wider than "the parts that use it".
- 🟡 **"After it" means after the start time.** Ratings open when the show starts, not when it ends. "Went to" means "holds a paid ticket": there is no check-in, so no-shows can rate.
- 🟡 Side change: the buy form is now hidden for past shows. That's good, but the checkout address still accepts past shows if someone posts to it directly (this was already true on main).
- ✅ The rules are enforced on the server. A user can write only their own rating (it is keyed on `$request->user()->id`). There is one rating per person (unique index plus `updateOrCreate`). The average is public by design.

**Access:** New `POST /events/{event}/rating` needs a login, and the server also requires a ticket for this event and a past start time. The user can't touch other people's ratings. `GET /events/{event}` is public and shows the average to everyone.
**Money:** None. **Database / deploy:** New table. Migrate before or together with the code. **Settings:** None.

| | Codex reply2 / explain | plain |
|---|---|---|
| Rating route: login, ticket and past show, checked on the server | ✅ | 🟡 "requires login ✓" is **correct** but misses the ticket and past-show checks |
| One rating per person, can be changed | ✅ | 🟡 "updates ratings" |
| Average and count on the event page, public | ✅ with an example | ❌ "can't describe" |
| Blade bug: confusing line for attendees, nothing for everyone else | ❌ | ❌ |
| Opens at start, not end | ✅ "the show has started" | ❌ |
| Buy form hidden after the show | ❌ not mentioned | ❌ |
| Migration | ✅ | ✅ step is right; "parts that use it" understates it (every event page) |
| Testing status | ✅ | ✅ |
| Verdict | — | 🟡 "No problems spotted" misses the display bug |

**False statements:**
- Codex: none found. It describes the attendee form correctly but never mentions the contradictory line under it.
- plain: none found.

**Notes for plain**
1. **Say the extra checks.** When the controller has `abort_unless(...)`, `abort_if(...)`, `$this->authorize(...)` or `Gate::` on the user's own relation (`$request->user()->tickets()->where(...)->exists()`), upgrade the line to "requires login, and only people with a ticket for this show, after it starts ✓".
2. **Name the blast radius of a missing table.** If a public GET controller reads the new table (`loadAvg`, `withCount`, `->ratings()`), word the step as "Every event page will show an error until you apply this."
3. **Branch check step.** When a new form sits inside `@if`/`@auth` branches, list the branch conditions as a test step: "Open a past show three ways: logged out, as a ticket holder, as someone without a ticket. Each should show something sensible." This would have caught the nesting bug without plain needing to parse Blade.
4. **Aggregates.** `loadAvg`/`withAvg` + `loadCount` → "Event pages now show the average rating and how many people rated."

---

## Trial 4: Owner asking to cancel an event with refunds
> "Admins should be able to cancel an event from the admin page, refund everyone who paid through Stripe, and email them."

**What was built:** The new `POST /admin/events/{event}/cancel` (admin group), with buttons on the admin list (with a confirm dialog) and on the edit page. `CancelEvent` sets `canceled_at`, then works through every paid order. It fetches the Checkout Session, refunds the full PaymentIntent with an idempotency key (`event-{id}-order-{id}-refund`), and marks the order `refunded` with `stripe_refund_id` and `refunded_at`. It then emails `EventCanceled` and sets `cancellation_notified_at`. Failures are logged, the loop continues, the admin sees an error, and a "Retry refunds & emails" button appears. Checkout is blocked for canceled events. If a payment completes after the cancel, the webhook marks it paid, issues no tickets and runs the refund flow. Canceled shows are hidden from the home page and labeled on the event page, and My tickets hides their codes.

**Ground truth: problems in the real code**
- 🟡 **Everything runs in one web request.** That is two Stripe calls plus one email per order while the admin waits. A full house (up to 120 orders) can exceed PHP's usual 30-second limit and stop partway. Retry and the idempotency keys make that recoverable without double refunds, but the admin sees an error page.
- 🟡 **Email needs a real mailer.** With the default `MAIL_MAILER=log`, nothing reaches customers, yet each order is marked "notified", so Retry won't resend.
- 🟡 **Stripe keeps its processing fees on refunds.** The venue pays them. Worth telling the owner.
- 🟡 Two clicks at the same moment can send two emails. Refunds stay single thanks to the status check and the idempotency key. An admin can also cancel a show that already happened and refund everyone (only a confirm dialog protects this).
- ✅ Admin-only, with CSRF. Retries are safe. Late payments get refunded. The refund email is sent only after the refund succeeded.

**Access:** New `POST /admin/events/{event}/cancel` needs a login and `is_admin` (403 otherwise). The checkout (login) now refuses canceled events. The webhook needs a Stripe signature. `/` and `/events/{event}` stay public. `/tickets` still shows only your own tickets.
**Money:** 💰 **New money going out:** full Stripe refunds, from the admin button and from the webhook. Checkout only gains a block. Admin "Revenue" drops to $0 for a canceled show, because refunded orders aren't counted.
**Database / deploy:** New `events.canceled_at` and `orders.stripe_refund_id`, `refunded_at`, `cancellation_notified_at`. Migrate first. Without it the home page itself errors (`whereNull('canceled_at')`).
**Settings:** `STRIPE_SECRET` must be allowed to create refunds (matters for restricted keys). A real `MAIL_MAILER` is required.

| | Codex reply / explain | plain |
|---|---|---|
| Admin-only cancel address | ✅ | 🟡 "requires login ✓" is **correct** but should say admins only; "looks up events" is wrong |
| Full Stripe refunds, retry-safe | ✅ clear | ❌ no 💰 on refunds; the 💰 sits on checkout, which only gained a block |
| Emails customers | ✅ | ❌ |
| Late payments refunded by the webhook | ✅ | ❌ "can't describe" |
| Retry for partial failures | ✅ | ❌ |
| One long request, timeout risk | ❌ | ❌ |
| Needs a real mailer; `log` marks people "emailed" | ❌ | ❌ |
| Stripe fees not returned | ❌ | ❌ |
| Canceled shows hidden, checkout blocked, codes hidden | ✅ | ❌ (view files listed by name only) |
| Migration | ✅ | ✅ step is right; the database line leaves out `stripe_refund_id` |
| Testing status | ✅ ("PHP isn't installed… Docker access is unavailable") | ✅ |
| Verdict | — | ❌ "No problems spotted" on a button that sends money back |

**False statements:**
- plain: "New server code that looks up events". It cancels the event, refunds every paid order through Stripe and emails customers. This is the most dangerous address on the card, described as a read.
- Codex: none found. "Already-notified customers are not emailed again" holds for one-at-a-time retries.

**Notes for plain**
1. **Refunds are money.** Detect `->refunds->create(`, `Refund::create(` or a `refund(` method on a Stripe client. Wording: 💰 "This sends money back to customers through Stripe. Try it in Stripe test mode on a test event first." This is the biggest miss on this card.
2. **Admin wording.** A route in a group with an `admin` middleware (or `can:`, `role:`) → "only admins ✓", not "requires login ✓".
3. **Name a POST from its URL, not its route parameter.** `/admin/events/{event}/cancel` → "cancels an event". Route-model binding is not "looks up".
4. **Email needs setup.** New `Mail::to(...)->send(...)` with `MAIL_MAILER=log` in `.env.example` → a step: "Emails only go out if mail is set up on your live server (MAIL_MAILER isn't 'log')."
5. **External calls in a loop inside a request.** `->each(`/`foreach` whose body calls a Stripe client or `Mail::send`, in a controller path → 🟡 "This makes one Stripe call per order while the admin waits. A sold-out show may time out; press Retry if it does."

---

## Trial 5: Technical owner asking for a pricing service and no overselling
> "Move pricing into a PricingService, add a $1.50 booking fee per ticket and 8.875% tax, keep the Stripe amount matching, and never sell more tickets than the venue holds even if two people check out at the same time."

**What was built:**
- **Pricing.** `PricingService`: tickets + $1.50 × quantity, then 8.875% tax on that sum (so the fee is taxed too), rounded half-up in whole cents. The order stores the total only. Stripe gets three line items (tickets, booking fee, tax) that add up to the stored total. The event page adds "$1.50 booking fee per ticket, plus 8.875% sales tax."
- **Seats.** A new `events.reserved_tickets` counter. Checkout claims seats with a single conditional UPDATE (`reserved_tickets + qty <= capacity`) in a transaction, then creates the order. Seats are given back if creating the Stripe session fails, and when Stripe sends `checkout.session.expired`.
- **Webhook.** It returns 400 if Stripe's `amount_total` or currency doesn't match the order. Otherwise it changes the order from pending to paid in one step and creates the tickets once.
- **Migration.** It backfills `reserved_tickets` from all `pending` and `paid` orders.

**Ground truth: problems in the real code**
- 🔴 **Old abandoned checkouts become permanently held seats.** The backfill counts every `pending` order. On main those are all the abandoned checkouts ever made. Their Stripe sessions expired long ago, so no "expired" message will ever release them. Upcoming shows can show "0 seats left" with empty seats, and admin "Sold" won't explain why. Fix: mark old pending orders as expired before or during the migration.
- 🔴 **Releasing seats depends on a Stripe setting nobody mentions.** Seats come back only when Stripe sends `checkout.session.expired`. A live webhook endpoint sends only the events it is subscribed to, and this app only ever needed `checkout.session.completed`. Without the change in the Stripe dashboard, every abandoned checkout takes its seats off sale for good. Even with it, the session has no `expires_at`, so seats are held for Stripe's default 24 hours.
- 🟡 **A mismatched amount means the customer paid and got nothing.** The webhook answers 400 with no log or alert. The order stays pending and the seats stay held. That shouldn't happen while Stripe's line items come from the same quote. It will happen if Stripe promo codes or Stripe Tax are turned on later.
- 🟡 **The advertised price leaves out a mandatory fee.** The home page and event page still say "$X per ticket", and the fee is a separate line. US rules on live-event ticket pricing (the FTC fee rule in force since May 2025; New York's ticket law) expect the total with mandatory fees shown upfront. The owner should check this. The fee text in the page is also typed by hand, separately from the constant, so it can drift.
- 🟡 **Accounting.** Tax is charged on the booking fee too, which is an owner or accountant decision. Tax and fee aren't stored apart from the total, so admin "Revenue" now includes sales tax and the tax collected can't be reported from the data.
- 🟡 The admin "Sold" column counts tickets, while public "seats left" counts holds, so the two disagree.
- ✅ The conditional UPDATE does stop two buyers from taking the same last seat (SQLite also allows one writer at a time). The Stripe total matches the order total. Duplicate webhooks no longer create duplicate tickets. A failed session creation gives the seats back.

**Access:** No new addresses. Checkout still needs a login. The webhook needs a Stripe signature. The event page is public.
**Money:** 💰 Customers pay more: the fee plus tax. 💰 The webhook can now refuse a paid session (answers 400). Seat holds can block sales.
**Database / deploy:** New `events.reserved_tickets` plus the backfill. Migrate before the code; checkout errors without the column. Clean up old pending orders before running it (see 🔴).
**Settings:** In the Stripe dashboard, subscribe the live webhook to `checkout.session.expired`. Mentioned nowhere.

| | Codex reply / explain | plain |
|---|---|---|
| Fee and tax math, Stripe total matches | ✅ clear, with a worked example | ❌ "can't describe" (🟡 the 💰 test-payment line is good) |
| Customers now pay more | ✅ | 🟡 only "make a test payment" |
| No overselling (one conditional update) | ✅ clear | ❌ |
| Backfill turns old abandoned checkouts into held seats 🔴 | ❌ presents the backfill as a safeguard | ❌ "Events now also store the reserved tickets" |
| Needs `checkout.session.expired` in Stripe; 24h holds 🔴 | ❌ | ❌ |
| Amount mismatch: paid, no tickets, no alert | 🟡 "refuses to create tickets", framed as a safety feature | ❌ |
| Advertised price leaves out the mandatory fee | ❌ | ❌ |
| Fee is taxed; tax not stored; revenue includes tax | 🟡 the example shows the fee taxed, not flagged | ❌ |
| Migration | ✅ | ✅ step is right |
| Testing status | ✅ | ✅ |
| Verdict | — | ❌ "No problems spotted" with two 🔴 |

**False statements:**
- Codex reply: "Pending reservations affect displayed availability and are released when Stripe sessions expire." That only happens if the live webhook is subscribed to `checkout.session.expired`, and only after 24 hours. Neither is said.
- Codex explain: "[the backfill] prevents existing sales from being forgotten." True for paid orders. For pending orders it does the opposite of what's wanted: dead checkouts hold seats forever.
- plain: none found. The card is mostly silent.

**Notes for plain**
1. **New webhook event types mean a dashboard setting.** A webhook controller that newly compares `$event->type === '<x>'` → a required step: "In Stripe's dashboard, your live webhook must also send '<x>', or <what it does> won't happen." This would have caught the 🔴 here.
2. **Backfill or hold logic that counts a `pending` status.** A migration or query scope that sums or counts rows `whereIn('status', ['pending', …])` without a time limit → 🟡 "Old unfinished orders count too. If your shop has old abandoned checkouts, they will block seats. Ask the agent to clear them first." This applies to p6 as well.
3. **Webhook refusals.** A non-2xx `return response(...)` after the signature check, not the signature failure itself → 🟡 "If this check fails, the customer has paid but gets no tickets, and nothing alerts you."
4. **Read price constants.** `const *_FEE_CENTS = 150`, `TAX_RATE*` → "Customers now pay $1.50 more per ticket, plus 8.875% tax on the ticket and the fee."
5. **Price text duplicated in a view.** Hard-coded "$1.50" in Blade next to a constant of 150 → "If you change the fee, change this text too."

---

## Trial 6: Frustrated owner with a vague complaint
> "buying tickets is buggy and the admin page is slow, fix it"

**What was built:**
- **Buying.** Checkout locks the event (`lockForUpdate`), counts paid orders plus open pending ones (`holdingSeats`), throws "Not enough seats" if full, creates the order (3 attempts), then creates a Stripe session that expires after 31 minutes, with an idempotency key. If Stripe fails, the order is deleted.
- **Webhook.** It checks that the session id matches the order and `payment_status === 'paid'`, changes the order from pending to paid in one step, creates the tickets once, and emails. The new `checkout.session.expired` marks the order `expired`.
- **Admin.** `withCount` + `withSum` give one query instead of 1 + 2 per event. A new index on `orders(event_id, status)`.
- **README.** It now says to subscribe the live webhook to `checkout.session.expired`.

**Ground truth: problems in the real code**
- 🔴 **Old abandoned checkouts now hold seats forever.** `holdingSeats` counts every `pending` order that has a `stripe_session_id`, with no age limit. On main that is every abandoned checkout ever made. Sessions older than 24 hours at deploy already expired, so no message will release them. Shows can look sold out. Same root cause as p5. Fix: expire old pending orders on deploy, or only count pending orders from the last 31 minutes.
- 🟡 **The Stripe setting is needed.** Without `checkout.session.expired` on the live webhook, new abandoned checkouts hold seats forever too. Codex documented it in the README; the owner still has to do it.
- 🟡 **The cause was guessed.** Nothing was reproduced. The guesses are reasonable: overselling while people are on the Stripe page, duplicate webhooks, and N+1 queries on the admin page.
- 🟡 Admin "Sold" counts tickets while "seats left" counts holds, so the two disagree.
- Note: `lockForUpdate()` adds nothing on SQLite. Overselling is still prevented, because SQLite allows one writer at a time, and the 3 attempts retry a "database is locked" error.
- ✅ Duplicate webhooks are safe. Admin access is unchanged. The index migration is harmless.

**Access:** No new addresses. Checkout needs a login. `/admin` needs an admin. The webhook needs a Stripe signature. The event page is public.
**Money:** 💰 Checkout and the webhook changed (seat holds, 31-minute expiry, stricter checks before tickets are issued). Prices are unchanged.
**Database / deploy:** Index only. Migrate when convenient; nothing breaks without it. Clean up old pending orders (see 🔴).
**Settings:** Subscribe the live Stripe webhook to `checkout.session.expired` (in the README).

| | Codex reply / explain | plain |
|---|---|---|
| Buying fix: seat holds, 31-minute expiry | ✅ | ❌ "can't describe" (the 💰 flag is right) |
| Duplicate-webhook safety | ✅ | ❌ "can't describe" |
| Admin: 1 query instead of 1 + 2N | ✅ with numbers | ❌ "can't describe" |
| It was a guess | 🟡 explains what it fixed; never says it couldn't reproduce | ✅ "You didn't say exactly what was wrong, so the agent guessed" |
| Old pending orders hold seats forever 🔴 | ❌ | ❌ |
| Stripe `expired` event setting | ✅ in the README and the explanation | ❌ README listed as "a notes file" |
| Index migration is harmless | 🟡 just says "run migrate" | ❌ "or the parts that use it will fail" |
| Testing status | ✅ | ✅ |
| Verdict | — | 🟡 |

**False statements:**
- plain: "Apply 2026_10_28_000000_add_order_lookup_index … or the parts that use it will fail." It only adds an index. Nothing fails without it.
- Codex explain: "Lock the event record inside a database transaction." On this app's SQLite, `lockForUpdate()` does nothing. The outcome is still safe for the reason in the note above.
- Codex explain: "Old incomplete orders without a Stripe session also stop reserving seats after a short grace period." True, but it reads as if old orders are handled. The ones with a session, which is nearly all of them, never stop.

**Notes for plain**
1. **Index-only migrations.** A migration whose `up()` only calls `$table->index(...)` → "Speeds up the admin page. Safe to apply any time; nothing breaks if it's late." Don't use this for `unique()`, which can fail on duplicate rows.
2. **Read added README lines.** Added README lines that mention webhook, subscribe, env or "set" → turn them into a "Before you ship" step. Here it was the exact Stripe setting.
3. **N+1 fix.** `withCount`/`withSum` replacing per-row `->count()`/`->sum()` inside a `map` → "The admin page now gets its totals in one database query instead of two per event."
4. **Pending-status holds.** Same rule as p5 note 2.

---

## Cross-trial summary for plain (priority order)
1. **Money in, money out.** 💰 for Stripe refunds (p4, missed entirely). Read price constants and say what customers now pay (p5). A non-2xx return in a verified webhook means "paid but no tickets, no alert" (p5). A new step between "mark paid" and the email means "if it fails the email is lost" (p1).
2. **Webhook event types mean a Stripe dashboard step** (p5 🔴 missed; p6 missed even though the README spelled it out). Also turn added README setup lines into steps.
3. **Old data under new rules.** Counting `pending` orders as held seats with no age limit, in a backfill (p5) or a scope (p6), blocks seats forever. Both 🔴 were missed by plain and by Codex.
4. **Migration wording, by type.** Keep the "apply before the code" step: Laravel doesn't auto-migrate, so it is right here. Say "nothing breaks" for index-only migrations (p6, false today). Say "every event page / the home page will error" when a public page reads the new table or column (p3, p4).
5. **Access wording.** "only admins ✓" for the `admin` middleware (p4). Add the controller checks (`abort_unless` on the user's tickets: "only ticket holders, after the show starts", p3). "Anyone, logged in or not, read-only" for public GET filters (p2).
6. **Name actions from the URL.** `…/cancel` → "cancels an event", never "looks up events" (p4).
7. **Email setup step** when new `Mail::send` code ships and `.env.example` has `MAIL_MAILER=log` (p4; p1 email).
8. **Dead fields.** A column that is read but never written (p1 `redeemed_at`, which means no redemption flow).
9. **Shared layout warning** (p2), and a **branch check step** for new forms inside `@if`/`@auth` (p3's nesting bug).
10. **Fewer "can't describe" lines.** Use labels, button text, aggregates (`loadAvg`, `withCount`) and own-records reads. Every card had 1–3 of these, often for the change the owner asked for.
11. **The verdict line.** "No problems spotted" appeared on all six cards, including p5 and p6 with 🔴 problems. Until plain detects these, the safe line is "plain checked access and database changes only".

Login claims checked: p3 "requires login ✓" for `/events/[event]/rating` is **correct**; the server also requires a ticket and a past show, which plain didn't say. p4 "requires login ✓" for `/admin/events/[event]/cancel` is **correct** but understated; it should say admins only. No "works without logging in" or "Anyone can" claims were made. **2 login claims, both correct, none wrong.**

---

## Scorecard (plain at the start of this round)

| | Codex "explain" | plain |
|---|---|---|
| Login claims | accurate | **2 made, both correct** (p3 and p4 "requires login ✓"; p4 should say admins only). None wrong |
| 🔴 problems caught (2: abandoned checkouts hold seats forever, p5 and p6) | 0 | 0 |
| Money | refunds explained | ❌ p4's refunds read as "looks up events": the work happens in a service class plain didn't follow |
| Deploy steps | – | ✅ "apply before the code goes live" (right for Laravel); ❌ said the same for an index-only migration |
| Verdict line | – | "No problems spotted" on all six |

**The honest result.** Laravel's login reading held on its first real app: two claims, both right.
But the cards said little about what the changes do, because Codex put the work in service classes
(`CancelEvent`, `StripeOrderRefunder`, `PricingService`), and plain only read the controller. Both 🔴
were about old data meeting a new rule, which no reader catches yet.

## What we changed in plain (same day)

| Gap | Fix | Result |
|---|---|---|
| Work done in service classes was invisible (p4) | plain follows a controller's calls into the classes it uses: injected services, constructor-promoted properties, interfaces (to the classes that implement them), `app(X::class)`, its own helpers | p4: "updates events, requires login ✓, emails people and asks Stripe to create a refund" |
| A new webhook event that Stripe never sends (p5 🔴, p6) | For every stack: when a Stripe webhook starts handling one of Stripe's event types it didn't handle before, a step to make sure the endpoint receives it (Stripe sends an endpoint only the events picked for it, unless it's set to all); for a brand-new webhook, to create the endpoint | p5, p6; and on the bracelet shop's p5 from round 1 |
| "Or it will fail" for an index-only migration (p6) | "It only changes indexes, so nothing breaks if it runs later" (only when the whole migration is plain index changes: no data changes, no full-text index) | p6 |

## Still open

1. **Old data under new rules** (the two 🔴): `pending` orders counted as held seats with no age limit.
2. **"Only admins ✓"** for the `admin` middleware, and the controller's own extra checks (p3: ticket holders, after the show).
3. **💰 for refunds** and for price changes (p4, p5); a webhook that drops a payment whose amount doesn't match (p5).
4. **Blade pages** aren't read yet: layout changes, forms inside `@auth` / `@if` (p2, p3).
5. Email that only reaches the log (`MAIL_MAILER=log` in `.env.example`) when new email code ships.
