# Trials, round 8: Ruby on Rails (Spoke & Pedal)

Hourly bike rentals on Rails 8.1: Rails' built-in authentication (`include Authentication`), an admin
area behind a `require_admin` before_action, Stripe Checkout through stripe-ruby and its webhook, SQLite,
ERB views, and the Docker entrypoint `rails new` writes (it migrates when the app starts). The app is in
`examples/spoke-pedal`. The method is the same as rounds [1](trials.md) to [7](trials-laravel.md): six
personas asked Codex for a feature; a separate grader worked out the truth from the code before reading
Codex's explanation or plain's card. Nothing was run (no Rails setup here; Codex hit a Bundler error).

| # | Persona | Request |
|---|---|---|
| 1 | Non-technical owner | "can people get their first hour free if they make an account" |
| 2 | Student, first project | "add filters by bike type and price on the bikes page and make it look good on phones" |
| 3 | Knows the basics | "let riders leave a rating after their rental ends and show the average rating on each bike" |
| 4 | Junior developer | "Admins should be able to cancel a rental from the admin page, refund the payment through Stripe if it was paid, and email the rider." |
| 5 | Experienced developer | "Move pricing into a PricingService, add a $5 helmet add-on and 9.5% tax, keep the Stripe amount matching, and never let two people rent the same bike for overlapping times even if they check out at the same time." |
| 6 | Vague and frustrated | "renting a bike is buggy and the admin page is slow, fix it" |

The cards graded below are plain's from **before** this round's fixes. What changed is at the end.

---

## Trial 1: Curious owner floating a promo idea
> "can people get their first hour free if they make an account"

Codex first asked two rule questions: once per account, and should one-hour rentals skip Stripe? It was told "use your best judgement" and built the feature, plus `PRODUCT.md`.

**What was built:** A migration adds `users.first_hour_credit_available`. It adds the column with default `false`, so existing accounts get `false`, then changes the default to `true` for new accounts. In `RentalsController#create`, inside `Current.user.with_lock`, the app checks the flag. If it is set, it sets the flag to `false` and creates the rental with `amount_cents = rate × (hours − 1)`. A 1-hour rental is created as `status: "paid"` at $0. It skips Stripe, queues the confirmation email and goes to the success page. Longer rentals go to Stripe with quantity `hours − 1`. Promo text was added: "Create an account and your first hour is free" for logged-out visitors on `/` and `/bikes/:id`, and a "Your first hour is free" banner plus the button "Book with free first hour" for eligible users. My rentals now shows the amount. There is a README line.

**Ground truth: problems in the real code**
- 🟡 **The free hour is spent when checkout starts, not when they pay.** The flag is cleared before the rider reaches Stripe. The form defaults to 2 hours, so most first bookings go to Stripe. If the rider presses Back on Stripe's page (the `cancel_url` returns to the bike page), the free hour is gone. The banner disappears, and their next try costs full price. The same happens if creating the Stripe session fails. This will happen often.
- 🟡 **A free hour needs no payment at all, and new emails get more.** A 1-hour booking with a fresh account is confirmed with no card. Signup is open and emails aren't verified, so one person can book a free hour again and again with new addresses. The only check is the photo ID at the shop.
- 🟡 **Existing customers are excluded.** Only accounts created after the deploy get the hour. That's a fair reading of "if they make an account", but the owner should know.
- 🟡 Free rentals are recorded as `paid` with $0 and no Stripe record. Anything that later treats "paid" as "paid through Stripe", such as refunds or revenue, has to allow for this.
- 🟡 Email: the free booking's confirmation needs mail set up on the live server (see the header).
- ✅ The discount is computed on the server, and Stripe's quantity matches `amount_cents`. Two clicks at once can't spend the credit twice: the `FOR UPDATE` part of `with_lock` does nothing on SQLite, but the IMMEDIATE transaction serializes them. A failed rental save rolls the credit back.

**Access:** No new addresses. `POST /bikes/:bike_id/rentals` still needs a login. `/` and `/bikes/:id` are public and show the signup promo to logged-out visitors. `/rentals` still shows only your own rentals.
**Money:** 💰 Checkout changed. First bookings are charged for one hour less, and 1-hour first bookings skip Stripe entirely and are marked paid.
**Database / deploy:** New `users.first_hour_credit_available` column. It's additive and low risk, and it is applied by itself on start.
**Settings:** None new. Mail delivery is needed for the free-booking email, as it already was for paid ones.

| | Codex reply2 / explain | plain |
|---|---|---|
| Free first hour; 1-hour rentals skip Stripe | ✅ clear, with price examples | 🟡 "saves users and emails people… charges your customers 💰" (right flags, no description) |
| Repeatable with a new email (no card needed for 1 hour) | ❌ | ✅ "people can usually get it again by signing up with another email" (marked "a guess"; the code proves it) |
| Credit spent at checkout start, lost on Back | ❌ | ❌ |
| Existing accounts excluded | ✅ | ❌ "Users now also store the first hour credit available" |
| Free rentals marked "paid" | ✅ "The rental is marked paid" | ❌ |
| Promo text for logged-out visitors | ✅ | ❌ file names only |
| My rentals shows the amount | ✅ | ❌ |
| Migration applies itself on start | 🟡 "run migrate" (local step) | ✅ |
| Testing status | ✅ | ✅ |
| Verdict | — | ✅ the "decide" item is the right headline |

**False statements:**
- Codex explain: "After someone uses the credit, it becomes `false`." It becomes `false` when they start checkout, whether or not they pay.
- Codex reply2: "The credit is applied once, safely under a database lock." The outcome is true, but the row lock does nothing on SQLite. SQLite's one-writer transactions are what make it safe. (Misleading, not wrong.)
- Codex explain: "Rental history now displays the amount charged." Abandoned checkouts also show an amount that was never charged. Minor.
- plain: none found.

**Notes for plain**
1. **Credit spent before payment.** In the action that creates a Stripe Checkout session, look for a write that clears a user's credit, coupon or flag (`update!(<x>_available: false)`, `decrement!`, `coupon.update!(used: true)`) before the redirect to Stripe, rather than in the webhook. Wording: 🟡 "The free hour is used up when checkout starts, not when they pay. If they leave the payment page, they lose it."
2. **Zero-amount path that skips payment.** In a checkout action, look for a branch that returns before `Stripe::Checkout::Session.create` when the amount is 0, and that writes `status: "paid"` outside the webhook. Wording: 💰 "Some bookings now skip payment and are marked paid." When signup is open (a registrations controller with `allow_unauthenticated_access` and no email confirmation), drop "(This is a guess.)" from the repeat-signup warning and add: "No card is needed, so each new email gets a free hour."
3. **Two defaults in one migration.** `add_column … default: false` followed by `change_column_default … to: true` means "Existing accounts get `false`. Only accounts made after this get the free hour."
4. **Promo text outside `authenticated?`.** When new ERB text containing free, discount or voucher sits in the `else` / `!authenticated?` branch of a public action, quote it and add "Logged-out visitors see this."

---

## Trial 2: Owner asking for filters and a phone layout
> "add filters by bike type and price on the bikes page and make it look good on phones"

Codex first asked three design questions. Told "use your best judgement", it built the feature and added `PRODUCT.md`.

**What was built:** `GET /` (bikes#index) reads `kind` and `max_price` from the URL. `kind` must be one of `Bike::KINDS` (`presence_in`). `max_price` must be 1200, 1800 or 2500 cents, and anything else is ignored. The page is a GET form with type chips (radio buttons), a "Hourly price" select ("Up to $12/$18/$25"), "Show bikes" and "Clear filters", a result count, an empty state, and redesigned cards with a "View bike" button and a one-line description per type. There is a new `app/assets/stylesheets/app.css` with breakpoints at 52rem and 38rem. Three controller tests were added but not run. `.impeccable/live/config.json` (a design-tool settings file) was committed.

**Ground truth: problems in the real code**
- 🟡 **The new stylesheet styles every page.** Main had no `app.css` at all, even though the layout links it (`stylesheet_link_tag :app`). This is the app's first stylesheet. Its top-level `body`, `header`, `a`, `main`, `.notice` and `.alert` rules change fonts, the header, page width and flash messages on every page (admin, login, My rentals, bike page), on all screen sizes. The header's "Log out" button is restyled too. That is probably an improvement, but it isn't limited to the bikes page. Side note, not verified: under Propshaft, a linked stylesheet that doesn't exist usually raises an error, so main's pages may not have rendered at all.
- 🟡 **Leftover tool file.** `.impeccable/live/config.json` isn't used by the app. It's harmless and can be deleted.
- 🟡 The price caps are typed into the controller and the view (1200/1800/2500). Bikes above $25 show only under "Any price". If prices change, the options can go stale. Minor.
- ✅ Read-only and public, as before. Bad values are ignored, not errors. There is no SQL injection, because values come from fixed lists. Unavailable bikes stay hidden.

**Access:** `GET /` is public: anyone, logged in or not, read-only. No new addresses.
**Money:** None. **Database:** None. **Settings:** None.

| | Codex reply2 / explain | plain |
|---|---|---|
| Type and price filters, validated, kept in the URL | ✅ with an example URL | ❌ "changed the main and bikes parts… plain can't describe" |
| Public page, read-only | ✅ implied | ❌ no access line |
| Phone layout | ✅ detailed | 🟡 "changed how the app looks on small screens" |
| New CSS restyles every page | 🟡 "the page's complete visual treatment", no warning about other pages | ❌ framed as phones only |
| `.impeccable` tool file | ❌ not mentioned | 🟡 listed, not explained |
| Tests added | ✅ | ❌ |
| Testing status | ✅ | ✅ |
| Verdict | — | ✅ "No problems spotted" is fair, but the card says almost nothing |

**False statements:**
- plain: "changed how the app looks on small screens like phones (in app.css)". The file is new, and most of it applies on every screen size and every page. Only the `@media` blocks are phone-specific.
- plain: "the main and bikes parts of your server". There is no "main" part. Both refer to `bikes#index`, which is the home page (`root`). Minor naming slip.
- Codex: none found.

**Notes for plain**
1. **Site-wide CSS.** A new or changed stylesheet linked from `layouts/application.html.erb` that has top-level element selectors (`body`, `header`, `main`, `a`, `button`) → "This file styles every page, on every screen size. Check a few other pages too (admin, login, My rentals)." Say "phones" only for rules inside `@media (max-width…)`.
2. **Name the root route.** `root "bikes#index"` → "your home page (the bikes list)", never "main".
3. **Public GET filters.** `params[:x].presence_in(CONST)` or `where(...) if @x` in an action listed in `allow_unauthenticated_access only:` → "Anyone, logged in or not, can now filter the bikes list by type and maximum price. It only shows information ✓."
4. **Tool leftovers.** A new dot-folder at the repo root (`.impeccable/`, `.cursor/`, `.vscode/`) that no app code references → "A settings file from the agent's tools. The app doesn't use it."

---

## Trial 3: Owner asking for ratings
> "let riders leave a rating after their rental ends and show the average rating on each bike"

Codex first asked design questions. Told "use your best judgement", it built the feature.

**What was built:** A nullable `rentals.rating` column, plus a database check constraint (1–5). The new `PATCH /rentals/:id/rating` is in `RentalsController`, which requires a login. It looks the rental up with `Current.user.rentals.find(...)`, so riders can only reach their own rentals. The model allows a rating only when it is 1–5 and the rental is `paid` and its booked end time (`starts_at + hours`) has passed. My rentals shows a five-radio form for eligible rentals, or the stars once rated. A `_rating` partial shows "★ 4.7 (12 ratings)" or "Not yet rated" on the public bike list and bike page.

**Ground truth: problems in the real code**
- 🟡 **"Ends" means the booked end time.** There is no check-in or return step, so a rider can rate as soon as the booked hours pass, even if they never showed up. That's reasonable for this app.
- 🟡 **One rating per rental, not per rider.** A regular who rents the same bike five times counts five times in that bike's average.
- 🟡 **Two extra queries per bike** on the public bike list (`ratings_count` and `average_rating` run inside the loop). That's fine for a small fleet.
- 🟡 The form hides after rating, but the server still accepts a changed rating from the same rider. Harmless.
- ✅ The rules are enforced on the server (model validation and DB constraint), and no one can rate another rider's rental (scoped `find` returns 404). The migration is additive and is applied on start, so bike pages never run before the column exists.

**Access:** New `PATCH /rentals/:id/rating` needs a login and works only on your own rentals, only when paid and ended. `/` and `/bikes/:id` stay public and now show the average to everyone.
**Money:** None. **Database / deploy:** New nullable column plus a check constraint (SQLite rebuilds the `rentals` table). Low risk; applied on start. **Settings:** None.

| | Codex reply2 / explain | plain |
|---|---|---|
| Rating address: login, own rentals, paid and ended | ✅ | 🟡 "updates rentals and requires login ✓" is **correct**, but misses "own rentals, paid, ended" |
| 1–5 in Rails and the database | ✅ | ❌ |
| Average and count on public bike pages | ✅ with an example | ❌ file names only |
| Booked end time, not actual return | 🟡 shows the formula, doesn't call out no-shows | ❌ |
| Repeat rentals count several times | ❌ | ❌ |
| Two queries per bike on the list | ❌ | ❌ |
| Migration applies itself on start | 🟡 "run migrate" (local step) | ✅ |
| Testing status | ✅ | ✅ |
| Verdict | — | ✅ "No problems spotted" is fair; only 🟡 items |

**False statements:**
- Codex explain: quotes the lookup as `Current.user.rentals.find(params[:id])`. The code uses `params.expect(:id)`. Same effect. Trivial.
- Codex explain: "This prevents ratings for unpaid, canceled, or ongoing rentals." This branch has no canceled status. Harmless.
- plain: none found.

**Notes for plain**
1. **Own-records writes.** `Current.user.<assoc>.find(params…)` followed by `update` → "requires login, and riders can only change their own rentals ✓". That's stronger and still exact.
2. **Model rules are part of access.** A `validate :method` whose body checks `status == "paid"` or a time comparison (`<= Time.current`), on the field being written → add "…only after a paid rental has ended".
3. **Public aggregates.** A model method using `.average(` / `.count` rendered in a partial on public pages → "Bike pages now show the average rating and how many people rated, to everyone."
4. **Queries in a loop.** A model method that runs a query, called inside `@x.each` in a view → 🟡 "The list now makes 2 extra database queries per bike. Fine for a few dozen bikes."
5. **Migration risk wording.** For a nullable `add_column` / `add_check_constraint` on a new column → "Low risk: adds a column. It applies itself when the app starts." Keep "Back up first" for `remove_column`, `change_column`, unique indexes and `null: false` without a default.

---

## Trial 4: Owner asking to cancel a rental with a refund
> "Admins should be able to cancel a rental from the admin page, refund the payment through Stripe if it was paid, and email the rider."

Codex first asked product and accessibility questions. Told "use your best judgement", it built the feature.

**What was built:**
- **Admin pages.** The admin page (`/admin`, `bikes#index`) now lists every rental with a "Review cancellation" link. `GET /admin/rentals/:id` is a confirmation page. `PATCH /admin/rentals/:id` runs `RentalCancellation`.
- **Cancellation.** Inside `rental.with_lock`, it returns early if the rental is already canceled. It fetches the Checkout Session when needed, to catch a payment that beat the webhook, and decides whether money was taken. If so, it calls `Stripe::Refund.create` (full amount, idempotency key `rental-<id>-cancellation`). It then sets `status: "canceled"`, `canceled_at` and `refunded_at`.
- **Afterwards.** The controller queues `RentalMailer.canceled`. On a Stripe error it logs it and shows "The refund could not be completed. The rental was not canceled or emailed. Try again."
- **Webhook.** It now also saves `stripe_payment_intent_id`.

**Ground truth: problems in the real code**
- 🟡 **Canceling an unpaid rental doesn't close its Stripe payment page.** The Checkout Session stays open (Stripe's default is 24 hours). If the rider pays after the cancel, the webhook ignores it (status isn't `pending`). The money is taken, nothing is refunded, and nobody is told. It's rare, but money is involved. Fix: call `Stripe::Checkout::Session.expire` when canceling a pending rental.
- 🟡 **Email needs setup.** Production has no mail delivery configured (see the header). The admin sees "rider emailed" either way.
- 🟡 **Stripe keeps its processing fee** on refunds. The shop pays it. Worth telling the owner.
- 🟡 **Any rental can be canceled and refunded**, including ones that already happened. Only the confirmation page stands in the way.
- 🟡 The admin page now loads every rental ever, with no limit, so it slows down over time. The two Stripe calls run inside the database transaction, which holds SQLite's write lock for a second or two. Minor.
- ✅ Admin-only, with CSRF. A refund failure rolls everything back, and the rider isn't emailed. Retries can't double-refund (status check plus idempotency key). Old paid rentals, which have no saved payment ID, are handled through the session lookup.

**Access:** New `GET` and `PATCH /admin/rentals/:id`: login plus admin (`require_admin`). Others are sent to `/` with "Admins only." The confirmation page shows the rider's email, to admins only. The webhook still needs a Stripe signature.
**Money:** 💰 **New money going out:** full Stripe refunds from an admin button. 💰 The webhook (payment confirmation) now also saves the payment ID.
**Database / deploy:** Three nullable columns on `rentals` (`stripe_payment_intent_id`, `canceled_at`, `refunded_at`). Low risk; applied on start.
**Settings:** `STRIPE_SECRET_KEY` must be allowed to create refunds (this matters for restricted keys). Mail delivery must be set up in production.

| | Codex reply2 / explain | plain |
|---|---|---|
| Admin-only cancel and refund address | ✅ | 🟡 "requires login ✓" is **correct** but should say admins only |
| Full Stripe refund, retry-safe | ✅ clear | 🟡 "asks Stripe to create a refund", with no 💰 and verdict "No problems spotted" |
| Payment that beat the webhook is caught | ✅ | ❌ |
| Unpaid rental's Stripe page stays open, so a late payment is kept | ❌ ("you were not charged") | ❌ |
| Rider email; needs mail set up | 🟡 email ✅, setup ❌ | 🟡 "emails people", no setup step |
| Webhook saves the payment ID | ✅ | ❌ "can't describe" |
| Stripe fees not returned | ❌ | ❌ |
| Admin rentals list | ✅ | ✅ "admin part… now reads rentals" |
| Database fields | ✅ all three | 🟡 leaves out `stripe_payment_intent_id` |
| Error handling | ✅ "If Stripe rejects the refund, the rental remains active and the rider is not emailed" | ❌ "silently ignored (an empty catch)" |
| Migration applies itself on start | 🟡 "run migrate" (local step) | ✅ |
| Testing status | ✅ | ✅ |
| Verdict | — | ❌ "No problems spotted" on a button that sends money back |

**False statements:**
- plain: "If something goes wrong in app/controllers/admin/rentals_controller.rb, the error is silently ignored (an empty catch…)". The `rescue Stripe::StripeError` logs the error and tells the admin the refund failed and nothing was changed. Nothing is ignored.
- plain: "New server code that lists rentals" for `/admin/rentals/[id]`. It shows one rental and cancels it. The listing is on `/admin`.
- Codex explain: "If the rental was unpaid, the email confirms that they were not charged." True when sent. But the Stripe page stays open, so they can still be charged afterwards, with no refund.
- Codex explain: "Locks the rental to prevent two simultaneous cancellation requests." The row lock does nothing on SQLite. The IMMEDIATE transaction gives the same result. Misleading, not wrong.

**Notes for plain**
1. **An empty catch must be empty.** Flag a `rescue` as "silently ignored" only when its body is empty or just `nil` / `next` / `return` / `false`. A body with `Rails.logger.*`, `redirect_to … alert:`, `flash`, `render`, `head` or `raise` is handled. This false loose end appeared on p4, p5 and p6. It's the top fix.
2. **Refunds are money.** `Stripe::Refund.create(` / `client.v1.refunds.create(` → 💰 "This sends money back to riders through Stripe. Try it in Stripe test mode first." The verdict can't be "No problems spotted" while a new 💰 path has no test step.
3. **Admin wording.** A `before_action` whose method redirects or heads `unless Current.user&.admin?` (or `current_user.admin?`) → "only admins ✓". This is the same miss as in the Laravel trials.
4. **Cancel without expiring the checkout.** Code sets a non-`pending` status on rows that have a `stripe_session_id`, with no `Checkout::Session.expire(` anywhere, while the webhook only acts on `status == "pending"` → 🟡 "Canceling an unpaid rental leaves its Stripe payment page open. If the rider pays later, the money is kept and nothing tells you."
5. **Webhook stores a Stripe ID.** `update!(…, stripe_payment_intent_id: event.data.object.payment_intent)` → "Payment confirmation now also saves Stripe's payment ID, so refunds can find the payment." List `stripe_*_id` columns in the database line too.
6. **Email setup step (Rails).** A new mailer method or `deliver_later` in the diff, with `production.rb` lacking an uncommented `delivery_method`/`smtp_settings` → "Emails only reach people once mail is set up on the live server. This app's mail settings are commented out."

---

## Trial 5: Technical owner asking for pricing and no double-booking
> "Move pricing into a PricingService, add a $5 helmet add-on and 9.5% tax, keep the Stripe amount matching, and never let two people rent the same bike for overlapping times even if they check out at the same time."

**What was built:**
- **Pricing.** `PricingService` computes rate × hours, plus $5 if a helmet is chosen, then 9.5% tax on that sum (so the helmet is taxed). It rounds half-cents up, in whole cents. The order stores only the total. Stripe gets one line item ("… rental (2h, tax included)") for exactly that total. The bike page adds a helmet checkbox and "9.5% tax is added at checkout." A new `rentals.helmet` column.
- **No double-booking.** `Rental.reserve!` runs in a transaction. It calls `Bike.lock.find` (does nothing on SQLite) and loads this bike's `pending` and `paid` rentals that start before the new end. It rejects any that overlap; back-to-back is allowed. The IMMEDIATE transaction is what actually serializes two checkouts on SQLite. That's correct.
- **Webhook.** It returns 422 unless the session id, `amount_total`, currency (`usd`) and `payment_status == "paid"` all match. Then it marks the rental paid under a lock and emails once.
- **Tests.** Pricing and overlap tests were added but not run.

**Ground truth: problems in the real code**
- 🔴 **An abandoned checkout blocks that bike and time slot forever.** `pending` counts as reserved, and nothing ever moves a rental out of `pending`. There is no `checkout.session.expired` handler, no session `expires_at`, and no cleanup. It hits ordinary use: a rider who presses Back on Stripe's page and tries again gets "That bike is already reserved during the selected time", blocked by their own abandoned checkout. Anyone with a free account can block any bike for any hours without paying. If creating the Stripe session fails, the pending rental is left behind too. Old abandoned checkouts already in the database also block their (mostly past) time slots. Fix: give sessions a short `expires_at` and count `pending` only while it is recent, or handle `checkout.session.expired` (which also needs the Stripe dashboard setting).
- 🟡 **The webhook's 422 means "paid, but not confirmed", with no alert.** Mismatches shouldn't happen while the line item comes from the stored total. But any other Checkout payment on the same Stripe account (a Payment Link, a test event, a second app) now gets 422 instead of 200. Stripe then retries for days and emails failure warnings. Async payment methods that complete as `unpaid` would also stay pending forever.
- 🟡 **Accounting.** Tax is charged on the helmet too, which is the owner's or accountant's call. Tax isn't stored separately, so it can't be reported from the data. Stripe receipts show one line, "tax included", with no tax amount.
- 🟡 Customers see the total only on Stripe's page. The bike page says "tax is added" but shows no total. Minor.
- ✅ The Stripe total equals the stored total. Integer-cent math is correct ($23.00 → $2.19 tax → $25.19). Two simultaneous checkouts for the same slot can't both succeed on this SQLite setup. Duplicate webhooks send one email. Bad input now shows a message instead of a 500.

**Access:** No new addresses. Checkout needs a login. The webhook needs a Stripe signature. The bike page is public.
**Money:** 💰 Riders pay more: 9.5% tax, plus $5 if they take a helmet. 💰 The webhook can now refuse a paid session (422). Abandoned checkouts block bookings (🔴).
**Database / deploy:** New `rentals.helmet` (`null: false`, default `false`). Low risk; applied on start. Clear or expire old `pending` rentals with future start times before shipping.
**Settings:** None new. If the fix uses `checkout.session.expired`, the live Stripe webhook must be subscribed to it.

| | Codex reply / explain | plain |
|---|---|---|
| Helmet and tax math; Stripe total matches | ✅ clear, with a worked example | ❌ "can't describe" (🟡 the 💰 test-payment line is right) |
| Riders now pay more | ✅ | 🟡 only "make a test payment" |
| No double-booking (transaction, overlap check) | 🟡 right outcome; credits the bike lock, which is a no-op here | ❌ |
| Abandoned checkouts block slots forever 🔴 | ❌ presents `pending` as a reservation, no expiry | ❌ |
| Webhook 422: paid but unconfirmed; foreign sessions retried | 🟡 framed as a safety check only | ❌ "can't describe" |
| Tax not stored; helmet taxed; one-line receipt | 🟡 example shows the helmet taxed, not flagged | ❌ |
| Error handling | ✅ "A friendly message when the selected time is already reserved" | ❌ "silently ignored (an empty catch)" |
| Migration applies itself on start | ✅ | ✅ |
| Testing status | ✅ | ✅ |
| Verdict | — | ❌ "No problems spotted" with a 🔴 |

**False statements:**
- plain: "If something goes wrong in app/controllers/rentals_controller.rb, the error is silently ignored (an empty catch…)". Both `rescue` clauses redirect back to the bike with a message ("That bike is already reserved…", or the validation error). Nothing is silent.
- Codex explain: "The bike lock is the important concurrency protection. If two users submit overlapping rentals simultaneously, one request obtains the lock first." On this app's SQLite, `Bike.lock` does nothing. Codex's next sentence (the IMMEDIATE transaction) is the real reason it works.
- Codex reply: "Added the helmet checkbox, total display…". There is no total before payment. The total appears only on Stripe's page and in My rentals afterwards.
- Codex explain: "Checks pending and paid rentals for an overlap." True, but it never says pending rentals never expire. That is the 🔴.

**Notes for plain**
1. **Holds that never expire.** A status list containing `pending` (`RESERVED_STATUSES = %w[pending paid]`, `where(status: %w[pending …])`) used in an availability or overlap check, while no code sets `pending` rows to anything else on abandonment (no `checkout.session.expired`, no `expires_at:` in `Checkout::Session.create`, no cleanup job) → 🔴 "An unpaid, abandoned checkout blocks that bike and time forever, even for the same rider trying again. Ask the agent to release unpaid holds after 30 minutes." This was the 🔴 in the Laravel p5/p6 trials too.
2. **Webhook refusals.** `return head :unprocessable_entity` (or any non-2xx) after `construct_event`, other than the signature failure → 🟡 "If this check fails, the rider has paid but the rental stays unconfirmed, and nothing alerts you. Other payments on the same Stripe account will now fail here too."
3. **Read price constants.** `HELMET_CENTS = 500` → "$5 helmet". A `TAX_NUMERATOR`/`TAX_DENOMINATOR` pair, or a `TAX_RATE`, → "Riders now pay 9.5% tax on the bike and the helmet." Only compute a rate when both constants are literal numbers.
4. **One-line totals.** `quantity: 1, unit_amount: <total>` with "tax included" in the name → "Stripe receipts won't show the tax separately, and the app doesn't store the tax amount."
5. **The empty-catch rule** (p4 note 1) applies here too.

---

## Trial 6: Frustrated owner with a vague complaint
> "renting a bike is buggy and the admin page is slow, fix it"

**What was built:**
- **Renting.** `create` builds the rental and runs validations. Invalid input re-renders the bike page with errors, with status 422, instead of a 500 page. New validations: pick-up time present and in the future, 1–8 hours, amount > 0, status `pending`/`paid`, and the bike marked available. A Stripe error deletes the pending rental, logs it, and shows "We couldn't start checkout. Please try again." The bike page shows "This bike is currently unavailable" for bikes off the floor.
- **Admin.** The fleet list is paginated at 50 bikes, with Previous/Next. A new index on `bikes(name, id)`.

**Ground truth: problems in the real code**
- 🟡 **The cause was guessed.** Nothing was reproduced. The rental fixes are real: bad input crashed with a 500 on main, past times and unavailable bikes were accepted, and a Stripe failure left a stray rental.
- 🟡 **The most likely "buggy" renting is untouched: double-booking.** Main lets two riders book the same bike for the same hour, and p6 still does. Abandoned `pending` rentals still pile up. They block nothing here, unlike p5. Missing confirmation emails, because mail isn't set up, would also look "buggy" to riders.
- 🟡 **The admin "slow" fix probably changes nothing.** A shop's fleet is far under 50 bikes, so pagination never kicks in, and the index barely matters. Nothing on main's admin page was obviously slow.
- ✅ No access changes. Prices are unchanged. The index migration is harmless. Validations that apply only `on: :create` don't affect the webhook's `update!`.

**Access:** No new addresses. `/bikes/:id` is still public (it now builds an empty form object, nothing more). Checkout needs a login. `/admin` needs an admin.
**Money:** 💰 The checkout path changed: stricter checks before Stripe, and cleanup when Stripe fails. Prices are unchanged.
**Database / deploy:** Index only, on `bikes`. Safe; applied on start; nothing breaks if it's late.
**Settings:** None.

| | Codex reply / explain | plain |
|---|---|---|
| Validations with inline errors instead of a 500 | ✅ | ❌ "can't describe" (🟡 the 💰 flag is right) |
| Stripe failure cleans up | ✅ | ❌ "silently ignored (an empty catch)" |
| Admin pagination at 50 | ✅ | ❌ "can't describe" |
| It was a guess | 🟡 explains what it fixed; never says it couldn't reproduce | ✅ "You didn't say exactly what was wrong, so the agent guessed" |
| Double-booking still possible | ❌ | ❌ |
| Pagination won't matter for a small fleet | ❌ ("As the fleet grew…") | ❌ |
| Index migration is harmless | 🟡 "Apply the new database index" | 🟡 right that it applies itself; "Back up first; if it fails, the app won't start" overstates an index |
| Bike page change | ✅ "retains the submitted values" | ❌ "now reads rentals" |
| Testing status | ✅ | ✅ |
| Verdict | — | 🟡 |

**False statements:**
- plain: "The bike part of your server now reads rentals. /bikes/[id]". `@rental = Rental.new` builds an empty form object. It reads nothing.
- plain: "If something goes wrong in app/controllers/rentals_controller.rb, the error is silently ignored (an empty catch…)". The `rescue Stripe::StripeError` deletes the stray rental, logs the error and shows the rider a retry message.
- Codex explain: "Bad input—missing pickup time, invalid hours, an unavailable bike—could therefore cause a server error." On main an unavailable bike didn't cause an error. It could simply be rented. The other two did crash.

**Notes for plain**
1. **`Model.new` is not a read.** `@x = Model.new` / `.build` with no `save` → don't say "reads"; say nothing, or "The bike page now remembers what the rider typed if there's an error."
2. **Name validations.** New `validate :starts_at_cannot_be_in_the_past` / `validates :x, …` plus `render …, status: :unprocessable_entity unless @x.save` → "Bad booking details now show a message instead of an error page. Pick-up times in the past and bikes marked unavailable are refused."
3. **Pagination.** `.offset(...).limit(N + 1)` in an index action → "The admin fleet page now shows 50 bikes per page." When the request was "slow", add: "If you have fewer than 50 bikes, this won't change anything."
4. **Index-only migrations, auto-migrated.** A migration whose `change` only calls `add_index` (not `unique: true`) → "Speeds up sorting. It applies itself on start; low risk." Drop "Back up first" here.
5. **The empty-catch rule** (p4 note 1) applies here too.

---

## Cross-trial summary for plain (priority order)
1. **Stop the false "silently ignored" loose end.** It appeared on 3 of 6 cards (p4, p5, p6) and was wrong every time. Each `rescue` logged the error, showed a message, or both. Flag only empty bodies, or bodies that do nothing visible (no log, no `redirect_to`/`render`/`head`/`flash`, no `raise`). False alarms on the money paths teach owners to ignore the card.
2. **Holds that never expire** (p5 🔴, missed by plain and Codex). `pending` counted in an availability check, with nothing that ever releases it, blocks slots forever, even for the same rider retrying. It's the same root cause as the 🔴 in the Laravel p5/p6 trials.
3. **Money paths.** 💰 for Stripe refunds (p4, described but no 💰 and "No problems spotted"). A zero-amount branch that skips Stripe and writes `paid` (p1). Non-2xx webhook returns mean "paid but unconfirmed, no alert" (p5). Read price and tax constants (p5). Credit spent before payment (p1). Canceling a pending checkout without `Session.expire` (p4).
4. **The verdict line.** "No problems spotted" sat on p4 (refunds) and p5 (🔴). Until plain detects these, a card with a new 💰 path should say "plain checked access and database changes only."
5. **Access wording.** "only admins ✓" for `require_admin`-style before_actions (p4; missed in Laravel too). Add own-records and model rules: "only their own rentals, after a paid rental ends" (p3). "Anyone, logged in or not, read-only" for public GET filters (p2).
6. **Migration wording for auto-migrating Rails apps.** Detecting `bin/docker-entrypoint` → `db:prepare` was right on all five branches. Now grade the risk. Additive nullable or defaulted columns and non-unique indexes → "low risk, applies itself". Keep "Back up first" for removals, type changes, unique indexes and `null: false` without a default. "If it fails, the app won't start" is true for Docker; with Kamal, the old version keeps running.
7. **Fewer "can't describe" lines.** p2 filters, p4 webhook, p5 checkout and webhook, p6 checkout and admin. Use validations, pagination, price constants, `presence_in` filters and Stripe ID writes.
8. **Name things correctly.** The root route is "your home page", not "main" (p2). `Model.new` isn't "reads" (p6). A `show` + `update` pair under `/admin/rentals/:id` is "review and cancel a rental", not "lists rentals" (p4).
9. **Site-wide CSS.** A new stylesheet linked from the layout with `body`/`header` rules restyles every page, not just phones (p2). Explain tool leftovers such as `.impeccable/`.
10. **Email setup step** when a diff adds mailer sends and `production.rb` has no active `delivery_method`/`smtp_settings` (p1, p4).
11. **Keep what worked.** p1's "people can sign up again with another email" warning was the right headline, and p6's "the agent guessed" step was right. Upgrade p1's warning from "a guess" when signup is open and a free path needs no card.

Login claims checked: p3 "requires login ✓" for `/rentals/[id]/rating` is **correct**; the server also limits it to the rider's own paid, ended rentals, which plain didn't say. p4 "requires login ✓" for `/admin/rentals/[id]` is **correct** but understated; it should say admins only. No "works without logging in", "needs login to change anything" or "Anyone can" claims were made. **2 login claims, both correct, none wrong.**

---

## Scorecard (plain at the start of this round)

| | Codex "explain" | plain |
|---|---|---|
| Login claims | accurate | **2 made, both correct** (p3, p4 "requires login ✓"; p4 should say admins only, p3 "only your own rentals"). None wrong |
| 🔴 problems caught (1: abandoned checkouts block a bike forever, p5) | 0 | 0 |
| Deploy steps | – | ✅ "changes your live database by itself when the app starts" on all five migration changes |
| False alarms | – | ❌ "the error is silently ignored (an empty catch)" on p4, p5, p6: every Ruby `rescue` was counted as empty |
| Verdict line | – | "No problems spotted" on p4 (a refund button) and p5 (a 🔴) |

**The honest result.** The Rails login reading held on its first real app. The misses repeat Laravel's:
old data meeting a new rule (pending checkouts holding a bike), and money paths without a 💰 (refunds,
a webhook that answers 422 to a paid checkout).

## What we changed in plain (same day)

| Gap | Fix | Result |
|---|---|---|
| Every `rescue` read as an empty catch (p4, p5, p6) | The parser's unnamed `rescue` keyword token isn't a rescue clause | p4, p5, p6 |
| "Now reads rentals" for an empty form (`Rental.new`, p6) | `.new` isn't a read | p6 |
| "By itself when the app starts" for any app with the Docker entrypoint | Only with a real Kamal `config/deploy.yml` (not `rails new`'s placeholder) or a Procfile `release:` line; a Procfile without one, `render.yaml` or `app.json` means "run `bin/rails db:migrate`" | all five migration cards now say to run it (this app has no deploy config) |

The independent reviews of the Rails reader found more before it shipped (in the same commit): see
[languages.md](languages.md#ruby-on-rails-).

## Still open

1. ✅ **Old data under new rules** (the 🔴): a `pending` status counted as taken, with nothing that frees it. Fixed later; see [trials-go.md](trials-go.md#fixed-after-the-trials).
2. **"Only admins ✓"** for `require_admin`, and "only your own" for `Current.user.rentals.find`.
3. **💰 for refunds**, zero-amount paths that skip Stripe, and a webhook that answers 4xx to a paid checkout.
4. **`rate_limit`** as a limit on spam.
5. **ERB views** aren't read yet.
