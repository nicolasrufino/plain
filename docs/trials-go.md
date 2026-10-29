# Trials, round 9: Go (Fresh Crate)

Weekly vegetable boxes as a Go JSON API: chi, pgx with raw SQL, golang-migrate run by `main()` when the
server starts, session-cookie login (`auth.RequireUser`, `auth.RequireAdmin`), Stripe Checkout through
stripe-go and its webhook. The app is in `examples/fresh-crate`. Same method as rounds [1](trials.md) to
[8](trials-rails.md): six personas asked Codex for a feature; a separate grader worked out the truth from
the code before reading Codex's explanation or plain's card. Nothing was compiled (no Go here).

| # | Persona | Request |
|---|---|---|
| 1 | Non-technical owner | "can new customers get their first box half price if they make an account" |
| 2 | Student, first project | "add search and filters by price to the boxes list, and a way to sort them" |
| 3 | Knows the basics | "let customers rate a box after it's delivered and show the average rating on each box" |
| 4 | Junior developer | "Admins should be able to cancel an order, refund it through Stripe if it was paid, and email the customer." |
| 5 | Experienced developer | "Move pricing into a pricing package, add a $4 delivery fee and 8% tax, keep the Stripe amount matching, and never take more than 30 orders for one delivery date even if people check out at the same time." |
| 6 | Vague and frustrated | "ordering a box is buggy and the admin orders list is slow, fix it" |

The cards graded below are plain's from **before** this round's fixes. What changed is at the end.

---

## Trial 1: Curious owner floating a promo idea
> "can new customers get their first box half price if they make an account"

Codex first answered the question: not currently. It suggested basing eligibility on "previously paid orders". It was told "use your best judgement" and built the feature, but counted any earlier order, paid or not.

**What was built:** `store.InsertOrder` now runs in a transaction. It locks the user's row (`SELECT … FOR UPDATE`) and checks `EXISTS (SELECT 1 FROM orders WHERE user_id = $1)`. If the user has no orders, the order is saved at `(price + 1) / 2`, which is half price rounded up to the cent. Stripe's `UnitAmount` uses that amount, and the session gets the metadata `first_box_discount=true|false`. There is a README line.

**Ground truth: problems in the real code**
- 🟡 **The discount is spent when checkout starts, not when they pay.** Any earlier order counts, including `pending` ones. If a customer leaves Stripe's page (the cancel URL goes back to `/boxes`), their next try is full price. The same happens if creating the Stripe session fails, because the order row was already saved. On main, abandoned checkouts are never cleaned up, so this will happen.
- 🟡 **One person can get it again with a new email.** Signup is open and emails aren't verified. Each new account gets half off its first box. They still pay the other half by card.
- 🟡 **It isn't only for new accounts.** Any account with no orders qualifies, including old accounts that never ordered. That's a fair reading of "new customers", but the owner should know.
- 🟡 **Customers aren't told.** The API doesn't return the discount, and the Stripe line item keeps the plain box name. The customer only sees a lower price on Stripe's page. There's no front end here to advertise it.
- ✅ The price is computed on the server, and Stripe's amount equals the stored `amount_cents`. Two checkouts at once can't both get the discount: the row lock works on Postgres. A failed insert rolls back.

**Access:** No new addresses. `POST /api/orders` still needs a login. Customers still see only their own orders.
**Money:** 💰 Checkout amount changed: first orders are charged half price.
**Database / deploy:** None.
**Settings:** None.

| | Codex reply2 / explain | plain |
|---|---|---|
| First order half price, rounded up; Stripe matches | ✅ with a $25.01 → $12.51 example | 🟡 "now reads users… charges your customers 💰" (right flags, no description) |
| Spent when an order is created, even if abandoned | ✅ explain: "consumed when the first order is created—even if the customer abandons payment" | ❌ |
| Repeatable with a new email | ❌ ("This prevents discount abuse") | ✅ "people can usually get it again by signing up with another email" (marked "a guess"; the code proves it) |
| Older accounts with no orders also qualify | ❌ | ❌ |
| Safe with two checkouts at once | ✅ | ❌ |
| Customers don't see "half price" before Stripe | ❌ | ❌ |
| Testing status | ✅ | ✅ |
| Verdict | — | ✅ the "decide" item is the right headline |

**False statements:**
- Codex explain: "This prevents discount abuse." It doesn't stop the main abuse, a new email per order. What it really does is take the discount from customers who leave the payment page.
- Codex reply1 proposed eligibility "based on whether the customer has any previously paid orders". The build counts any order. The explain discloses this, so it's an inconsistency, not a false statement.
- plain: none found. "The orders part of your server now reads users" is true: it locks the user's row.

**Notes for plain**
1. **Discount checked against any order.** An `EXISTS (SELECT 1 FROM orders WHERE user_id = $1)` (or `COUNT(*)`) with no `status = 'paid'` filter, in the function that inserts a `'pending'` order and feeds a discount → 🟡 "The discount counts any earlier order, even an unpaid one. If a customer leaves the payment page, their next try is full price."
2. **Say what the discount is.** An amount passed to Stripe's `UnitAmount` that differs from the catalog field (`box.PriceCents`), computed as `(x + 1) / 2`, `x / 2` or `x * 50 / 100` → 💰 "First orders are now charged half the box price."
3. **Upgrade the new-email warning.** When the signup handler has no verification step (no token, no confirm route) and the discount depends on "no previous orders" or a new account, drop "(This is a guess.)".
4. **Eligibility wording.** A "no previous orders" check, with no `created_at` comparison, means "Anyone who hasn't ordered yet gets it, including older accounts."

---

## Trial 2: Owner asking for search, price filters and sorting
> "add search and filters by price to the boxes list, and a way to sort them"

Codex built it straight away.

**What was built:** `GET /api/boxes` now reads four optional query parameters:
- `q`: case-insensitive search in names and descriptions (`ILIKE '%q%'`);
- `min_price_cents` / `max_price_cents`: inclusive bounds, non-negative integers;
- `sort`: `price_asc` (the default), `price_desc`, `name_asc` or `name_desc`.

Bad values, or a minimum above the maximum, return 400 with a message. Filter values use placeholders (`$1`…), and `sort` maps to fixed `ORDER BY` strings with an `id` tie-breaker. Only available boxes are shown, as before. Unit tests for parsing and query building were added but not run. The README documents the parameters.

**Ground truth: problems in the real code**
- 🟡 **Nothing visible changes yet.** The repo is API-only. A website or app has to add the search box, price fields and sort menu.
- 🟡 **"No matches" returns `null`, not `[]`.** `var out []Box` stays nil when no rows match, and Go encodes that as `null`. Main did the same, but only when there were no boxes at all. Search and filters make empty results common, so a front end that expects a list may break.
- 🟡 Prices are in cents in the URL (`max_price_cents=3000` means $30). That's fine for an API, but the front end must convert.
- ✅ Read-only and public, as before. No SQL injection: values are placeholders, and the sort comes from an allow-list. `%` or `_` typed into the search act as wildcards. That's harmless.

**Access:** `GET /api/boxes` is public: anyone, logged in or not, read-only. No new addresses.
**Money:** None. **Database:** None. **Settings:** None.

| | Codex reply / explain | plain |
|---|---|---|
| Search, price bounds, sort; validated; 400 on bad input | ✅ with example URLs | ❌ "changed in a way plain can't describe yet" |
| Public, read-only | 🟡 implied | ❌ no access line |
| Safe SQL (placeholders, sort allow-list) | ✅ | ✅ no false alarm |
| API only: the front end must be updated | ✅ "this repository has no frontend or boxes-list UI" | ❌ |
| Empty results come back as `null` | ❌ | ❌ |
| Tests added, not run | ✅ | 🟡 the testing step is right; the tests aren't mentioned |
| Verdict | — | 🟡 "No problems spotted" is fair, but the card says almost nothing |

**False statements:**
- Codex: none found.
- plain: none found. The card is empty, not wrong.

**Notes for plain**
1. **Public GET filters (Go).** A handler that reads `r.URL.Query().Get(...)` on a route registered outside any `RequireUser`/`RequireAdmin` group or `With(...)` → "Anyone, logged in or not, can now search the boxes list, filter it by price and sort it. It only shows information ✓." Take the parameter names from the README or the `Query().Get` keys.
2. **Allow-listed sort is safe.** A `switch` on the sort value that appends fixed `ORDER BY` strings: say nothing. Flag only `"ORDER BY " + r.URL.Query().Get(...)` or `fmt.Sprintf` with request data.
3. **API-only repos.** When the repo has no front-end files (no `.html`, templates, `.tsx`/`.jsx`/`.vue`/`.svelte`) and the request names a page ("boxes list", "on each box") → "This app is only the server. Your website or app must be updated to show the new search and filters."
4. **Nil slices encode as `null`.** A list handler returning a `var out []T` built with `append`, where the diff adds filters → 🟡 "When nothing matches, the server sends `null` instead of an empty list. Check that your app handles it." Only fire this when filters were added; otherwise it's noise.

---

## Trial 3: Owner asking for ratings
> "let customers rate a box after it's delivered and show the average rating on each box"

Codex built it straight away.

**What was built:**
- **Rating address.** New `PUT /api/orders/{id}/rating` inside the `RequireUser` group. It takes `{"rating": 1..5}` and rejects anything else with 422. The update runs `WHERE id = $1 AND user_id = $2 AND status = 'paid' AND delivery_date <= CURRENT_DATE`. If no row matches, it says "only your delivered, paid orders can be rated", and that doesn't reveal whether the order exists.
- **Database.** A new nullable `orders.rating SMALLINT CHECK (rating BETWEEN 1 AND 5)`.
- **Boxes list.** `ListBoxes` and `GetBox` now join rated orders and return `average_rating` (rounded to 0.1, `null` if unrated) and `rating_count`.
- **Order lists.** The customer's and the admin's order lists include `rating`. There is a README line.

**Ground truth: problems in the real code**
- 🟡 **"Delivered" means "the delivery date has come".** Nothing tracks real delivery. A customer can rate on the morning of the delivery day, before the box arrives. `CURRENT_DATE` is the database's date, usually UTC. That's reasonable for this app.
- 🟡 **One rating per order, not per customer.** A regular who orders the same box ten times counts ten times. Ratings can also be changed later (PUT overwrites). Harmless.
- 🟡 **A box's contents change week to week.** The average mixes every week's box under one name. That's a product question for the owner.
- 🟡 API only: a front end must show the stars and the "rate" control.
- ✅ The rules are enforced on the server and in the database. No one can rate another customer's order. `GROUP BY b.id` is valid because `id` is the primary key. Checkout still charges the same price; only the box lookup query behind it changed.

**Access:** New `PUT /api/orders/{id}/rating`: login required, and only on your own paid orders whose delivery date has come. `GET /api/boxes` stays public and now shows the average and count to everyone.
**Money:** None. The checkout's `GetBox` query changed shape, but the amount is the same.
**Database / deploy:** One nullable column with a check on it. Low risk; applied by itself on start. Postgres checks the constraint against existing rows, which are all empty.
**Settings:** None.

| | Codex reply / explain | plain |
|---|---|---|
| Rating address: login, own orders, paid, delivery date reached | ✅ | 🟡 "updates orders and requires login ✓" is **correct**, but misses "own orders, paid, delivered" |
| 1–5 enforced in the handler and the database | ✅ | ❌ |
| Average and count on the public boxes list | ✅ with JSON example | ❌ "can't describe yet" |
| "Delivered" = delivery date, not real delivery | 🟡 explain is exact ("delivery date is today or earlier"); reply says "after delivery" | ❌ |
| Repeat orders count several times | ❌ | ❌ |
| Order lists include the rating | ✅ | 🟡 "admin orders… can't describe" |
| 💰 on `/api/orders` | — | 🟡 checkout amount unchanged; only the box lookup query changed |
| Migration applies itself on start | ❌ not mentioned ("reversible database migration") | ✅; 🟡 "Back up first" overstates a nullable column |
| API only: a front end must show it | ✅ "gives a frontend enough information" | ❌ |
| Testing status | ✅ | ✅ |
| Verdict | — | ✅ "No problems spotted" is fair; only 🟡 items |

**False statements:**
- Codex explain: "an order proves that a specific customer bought and received a box". Receipt isn't tracked, only the delivery date. Minor.
- plain: "The orders part of your server changed… This is the code that charges your customers 💰". The changed handlers are the rating route and the order list. Checkout charges the same. Misleading, not wrong.

**Notes for plain**
1. **Own-records writes (SQL).** `UPDATE … WHERE id = $1 AND user_id = $2` with `auth.User(r).ID` (or any `current user` id) as the argument, and `RowsAffected() == 0` → error → "requires login, and customers can only rate their own orders ✓".
2. **Extra WHERE rules are access rules.** `AND status = 'paid'`, `AND delivery_date <= CURRENT_DATE` on that update → add "…only paid orders whose delivery date has come."
3. **Public aggregates.** `AVG(` / `COUNT(` added to the query behind a public GET → "The boxes list now shows each box's average rating and how many people rated it, to everyone."
4. **Scope 💰 to the checkout handler.** Flag "charges your customers" only when the diff changes the handler that calls `session.New` / `V1CheckoutSessions.Create`, or a value it passes (amount, quantity, line items). A new sibling route in the same file, or a list query, isn't a money change. This false 💰 also appeared on p4.
5. **Migration risk wording (golang-migrate).** For `ADD COLUMN` that is nullable or has a default, with or without a `CHECK` on the new column → "Low risk: adds a column. It applies itself when the app starts." Keep "Back up first" for `DROP`, type changes, `UNIQUE`, `NOT NULL` without a default, and data backfills.

---

## Trial 4: Owner asking to cancel an order with a refund
> "Admins should be able to cancel an order, refund it through Stripe if it was paid, and email the customer."

Codex built it straight away.

**What was built:**
- **Address.** `POST /api/admin/orders/{id}/cancel`, inside the `/api/admin` route (`RequireUser` and `RequireAdmin`).
- **Cancellation.** It loads the order with the customer's name and email and the box name. `canceled` skips to the email step. Anything other than `pending` or `paid` gives 409.
- **Stripe.** A new `StripeCanceler` calls Stripe's HTTP API directly, not through stripe-go. It reads the Checkout Session. If it was paid, it refunds the full PaymentIntent (`POST /refunds`, idempotency key `cancel-order-<id>`). If the session is still open, it expires it. If expiring fails because the payment just went through, it reads again and refunds.
- **Database update.** It's a compare-and-swap (`WHERE id = $1 AND status = $2`) that sets `canceled`, `canceled_at`, `refunded_at` and `stripe_refund_id`. If the webhook changed the status first, it retries once.
- **Email.** A `net/smtp` email to the customer: "No payment was captured." or "We refunded $X". `cancellation_email_sent_at` is recorded. If the email fails, the response says so, and calling the address again re-sends only the email.
- **Order lists.** The customer's and the admin's order lists now include `canceled_at` and `refunded_at`.
- **Startup.** `main` now requires `SMTP_ADDR` and `SMTP_FROM` (`mustEnv`). Three Stripe tests use a fake server; they weren't run.

**Ground truth: problems in the real code**
- 🔴 **The whole app won't start without `SMTP_ADDR` and `SMTP_FROM`.** They use `mustEnv`, which calls `log.Fatal`. Deploying before setting them takes the whole shop down: no boxes list, no orders, no webhook. The migration runs first and succeeds, so only the settings are missing. Codex listed the settings, but never said that leaving them out stops the app.
- 🟡 **SMTP details.** `smtp.SendMail` needs a `host:port` that speaks STARTTLS (port 587), not port 465. If `SMTP_ADDR` has no port, the login details are dropped without a warning, and sending then fails.
- 🟡 **Any order can be canceled and refunded,** including boxes already delivered. Nothing but the admin's judgement stands in the way.
- 🟡 **Stripe keeps its processing fee** on refunds; the shop pays it. A refund can also fail later at the bank. The app marks it refunded as soon as Stripe accepts the request.
- 🟡 Payments that finish later, such as bank debits (`complete` but `unpaid`), are canceled with no refund. If that payment then succeeds, the money is kept. This is rare, and the app doesn't handle those payments anywhere else either.
- 🟡 After 24 hours, Stripe forgets the idempotency key. If the refund went through but the database save failed, a retry a day later gets "already refunded", and the order can't be canceled through the app. This is rare.
- ✅ Admin-only. Canceling an unpaid order also closes its Stripe payment page, so the customer can't pay afterwards. This was the gap in the Rails p4. Retries don't refund twice: the status check plus the idempotency key. A late webhook can't flip a canceled order back to paid (`MarkOrderPaid` needs `pending`). The `To:` address can't inject email headers, because `smtp.SendMail` rejects CR/LF.

**Access:** New `POST /api/admin/orders/{id}/cancel`: login plus admin. Others get 401 or 403. The customer's own order list now shows the cancellation and refund dates.
**Money:** 💰 **New money going out:** full Stripe refunds from an admin button. 💰 Open Stripe payment pages are closed on cancel.
**Database / deploy:** Four nullable columns on `orders` (`canceled_at`, `refunded_at`, `stripe_refund_id`, `cancellation_email_sent_at`). Low risk; applied by itself on start.
**Settings:** `SMTP_ADDR` and `SMTP_FROM` are **required**; the app won't start without them. `SMTP_USERNAME` and `SMTP_PASSWORD` are optional. `STRIPE_SECRET_KEY` must be allowed to create refunds and expire sessions; this matters for restricted keys.

| | Codex reply / explain | plain |
|---|---|---|
| Admin-only cancel address | ✅ "only admins can call it" | 🟡 "requires login ✓" is **correct**, but should say admins only |
| Full Stripe refund, retry-safe | ✅ | ❌ "nothing in your app refunds a Stripe payment" |
| Open payment page expired | ✅ "so the customer cannot pay afterward" | ❌ |
| Payment that lands mid-cancel is refunded | ✅ | ❌ |
| Email; failed email can be retried without a second refund | ✅ | 🟡 "emails people"; "shared with the email provider" ✅ |
| App won't start without the SMTP settings | 🟡 "the server now requires these email settings"; doesn't say a missing one stops the whole app | ❌ no settings step at all |
| Any order, even delivered, can be refunded | ❌ | ❌ |
| Stripe fee kept; refunds can fail later | ❌ | ❌ |
| Database fields | ✅ all four | 🟡 leaves out `stripe_refund_id` |
| Customers see the canceled and refunded dates | ❌ | ❌ ("charges your customers 💰" instead) |
| Migration applies itself on start | ❌ not mentioned | ✅ |
| Testing status | ✅ | ❌ step missing |
| Verdict | — | ❌ its only "decide" item is false |

**False statements:**
- plain: "Cancelling doesn't give money back: nothing in your app refunds a Stripe payment. If someone cancels after paying, they stay charged." False. `stripe_canceler.go` posts to `https://api.stripe.com/v1/refunds`. plain only looks for stripe-go calls.
- plain: "The orders part of your server changed… This is the code that charges your customers 💰". Checkout didn't change. Only the customer's order list gained two date fields. Misleading.
- Codex: none found.

**Notes for plain**
1. **New required settings in Go.** A new `mustEnv("X")` in `main`, or `os.Getenv("X")` followed by `log.Fatal`/`panic` when it's empty → BEFORE YOU SHIP: "Set SMTP_ADDR and SMTP_FROM on the live server before you deploy. Without them, the app stops at startup and the whole shop is down." Mark a plain `os.Getenv("SMTP_USERNAME")` as optional. The Go reference already says to resolve `mustEnv`-style helpers. This is the top miss on this card.
2. **Hand-written Stripe calls are money.** A string containing `api.stripe.com/v1` plus a path `"/refunds"`, `"/checkout/sessions/…/expire"`, `"/payment_intents"`, sent with `SetBasicAuth(secretKey, "")` or `Authorization: Bearer sk_…` → treat it like `refund.New` / `session.Expire`. 💰 "This sends money back to customers through Stripe. Try it in Stripe test mode first."
3. **Never assert "nothing refunds" when the diff says refund.** Before the "doesn't give money back" headline, search the diff for `refund` in identifiers, strings, URL paths and SQL columns. If found and not resolved, say "plain couldn't confirm how refunds are sent" instead.
4. **Admin wording (Go).** A route under `r.Route(prefix, …)` with `r.Use(…RequireAdmin)`, where the middleware writes 403 and returns `if u == nil || !u.IsAdmin` → "only admins ✓". This was missed in the Rails and Laravel trials too.
5. **Expire on cancel is good news.** `"/expire"` or `session.Expire(` in a cancel path → "Canceling an unpaid order also closes its Stripe payment page ✓."
6. **Testing-status phrases.** Match "couldn't", "could not", "can't", "cannot" or "unable to" before "run", "execute", "be run" or "be executed", with both `'` and `’`. Also match "no Go toolchain" and "Go is not installed". p4 and p6 said "Tests couldn’t be executed" and got no step.
7. **List `stripe_*_id` columns** in the database line (`stripe_refund_id`). Same miss as the Rails p4.

---

## Trial 5: Technical owner asking for pricing and a delivery cap
> "Move pricing into a pricing package, add a $4 delivery fee and 8% tax, keep the Stripe amount matching, and never take more than 30 orders for one delivery date even if people check out at the same time."

Codex built it straight away.

**What was built:**
- **Pricing.** `internal/pricing` sets `DeliveryFeeCents = 400` and `TaxPercent = 8`. `Calculate` charges box + $4 + 8% tax on the box only (not on delivery), rounded to the nearest cent. Example: $25.99 → $2.08 tax → $32.07. The order stores the total. Stripe gets three line items (the box, "Delivery", "Tax (8%)") that add up to that total.
- **Delivery cap.** A new `delivery_date_capacity(delivery_date PK, order_count CHECK 0..30)` table. `InsertOrder` runs in a transaction. It upserts `order_count + 1` `WHERE order_count < 30`. No row returned means the date is full, and the customer gets 409 "that delivery date is full". Then it inserts the order.
- **Migration.** It fills the table from `COUNT(*)` of all existing orders per date.
- **Tests.** Pricing tests were added but not run.

**Ground truth: problems in the real code**
- 🔴 **Every checkout attempt uses up a slot forever, paid or not.** The counter goes up when the `pending` order is created, before the customer pays. Nothing ever lowers it: no expiry handler, no cancel, no cleanup. A customer who presses Back on Stripe and tries again uses two slots. If creating the Stripe session fails, the slot is gone too. Anyone with a free account can fill a date with 30 unpaid checkouts. So "30 orders" really means "30 checkout attempts". Fix: count only paid orders, plus recent pending ones (give sessions a short `expires_at`), or lower the counter on `checkout.session.expired`.
- 🟡 **The migration can stop the app.** The fill counts every existing order, including abandoned `pending` ones. If any date already has more than 30, the `CHECK` fails, the migration fails, and the app won't start. golang-migrate leaves the database "dirty", so the app stays down until someone fixes it by hand. Check first with `SELECT delivery_date, COUNT(*) FROM orders GROUP BY 1 HAVING COUNT(*) > 30`. Old abandoned orders also eat into future dates' 30 straight away.
- 🟡 **Customers pay more, and see it only on Stripe's page.** `GET /api/boxes` still shows the box price alone.
- 🟡 **Accounting.** Tax applies to the box but not to delivery; that's the owner's or accountant's call. Only the total is stored, so tax can't be reported from the database. Stripe's receipt does show it on its own line.
- ✅ The Stripe total equals the stored total. Integer-cent math is correct. The counter is safe under simultaneous checkouts on Postgres. A failed order insert rolls the counter back.

**Access:** No new addresses. Checkout still needs a login.
**Money:** 💰 Customers pay $4 delivery plus 8% tax on the box. 💰 Dates can now refuse orders, and unpaid checkouts fill them (🔴).
**Database / deploy:** New table, filled from existing orders, with a `CHECK` that the fill can break. It applies itself on start; see the 🟡 above before shipping.
**Settings:** None.

| | Codex reply / explain | plain |
|---|---|---|
| $4 delivery + 8% tax on the box; rounding; worked example | ✅ | ❌ not mentioned |
| Stripe total matches; three line items | ✅ | 🟡 only "Make a test payment" 💰 |
| Customers pay more; the list still shows the box price only | 🟡 amounts clear; visibility not mentioned | ❌ |
| Atomic per-date counter; 409 when full | ✅ | 🟡 "saves delivery date capacities and refuses with "{"error":"that delivery date is full"}"" |
| Unpaid and abandoned checkouts use slots forever 🔴 | ❌ | ❌ |
| Fill counts unpaid orders; >30 on a past date stops the app | ❌ | 🟡 generic "Back up first; if it fails, the app won't start" (right here, by luck) |
| Tax on the box only; tax not stored | 🟡 "8% tax on the box subtotal" stated, not flagged | ❌ |
| New `pricing` package | ✅ | ❌ not listed, though counted in "6 files" |
| Testing status | ✅ | ✅ |
| Verdict | — | ❌ "No problems spotted" with a 🔴 |

**False statements:**
- Codex explain: "Enforced the 30-order limit safely". It limits checkout attempts, not orders, and never frees a slot. The concurrency part is true.
- Codex explain: "If inserting the order fails, the transaction rolls back the counter increment too." True, but if the Stripe session fails afterwards, the slot stays used. Incomplete, not false.
- plain: none found. Its card is thin, not wrong.

**Notes for plain**
1. **Holds that never release (counter form).** An upsert or update that does `count = count + 1` in the same function that inserts a `'pending'` order, with no `- 1` anywhere in the code and no `checkout.session.expired` handler → 🔴 "Every checkout attempt uses up a delivery slot, even unpaid and abandoned ones, and nothing gives it back. 30 abandoned checkouts fill a date." The count form (`COUNT(*) … WHERE status IN ('pending', …)` used as a cap) gets the same warning. This is the 🔴 for the third stack in a row (Laravel, Rails, Go).
2. **Read price constants (Go).** `const ( DeliveryFeeCents = 400; TaxPercent = 8 )` used to build the amount → "Customers now pay a $4 delivery fee and 8% tax on the box." Several `CheckoutSessionLineItemParams` with names like "Delivery" and "Tax (8%)" → "Stripe's receipt shows the box, delivery and tax separately ✓." Add "The boxes list still shows the box price only" when the list query is unchanged.
3. **Backfill plus constraint.** A migration that adds a `CHECK`, `UNIQUE` or `NOT NULL` and fills the same table from existing rows (`INSERT … SELECT … COUNT(*)`) → 🟡 "If your existing data breaks the new rule (here, a date with more than 30 orders, paid or not), the migration fails and the app won't start until someone fixes it by hand." Keep "Back up first" here.
4. **Unwrap JSON errors.** `http.Error(w, `{"error":"that delivery date is full"}`, 409)` → quote 'that delivery date is full', not the raw JSON.
5. **Mention new packages.** A new directory under `internal/` (`internal/pricing/`) → one line: "New pricing code: the delivery fee and tax rate live here."

---

## Trial 6: Frustrated owner with a vague complaint
> "ordering a box is buggy and the admin orders list is slow, fix it"

Codex built it straight away. Its log says it would "reproduce both issues", but it never ran anything.

**What was built:**
- **Delivery date.** `deliveryDate()` now compares calendar dates in the server's time zone. Main rejected today's date; it is now accepted. Past or badly formatted dates are still refused.
- **Checkout cleanup.** If `session.New` fails, or saving the session ID fails, the `pending` order is deleted (`DELETE … WHERE status = 'pending'`) and the error is logged. `SetOrderSession` errors used to be ignored.
- **Webhook.** On `checkout.session.completed`, it reads `metadata.order_id`. `MarkOrderPaidByCheckout` sets `paid` and the session ID on that order, unless it already has a different session. If no row matches, it returns 500, and Stripe retries. Sessions without an `order_id` use the old lookup.
- **Admin orders.** `GET /api/admin/orders` is now paginated: `limit` (default 100, max 500) and `offset`. The `X-Limit`, `X-Offset`, `X-Has-More` and `X-Next-Offset` headers tell the client about more pages.
- **Database.** A migration adds indexes on `orders(delivery_date DESC, id DESC)` and `orders(user_id, delivery_date DESC, id DESC)`, plus a **unique** partial index on `stripe_session_id`.
- **Tests.** Date and pagination tests were added but not run.

**Ground truth: problems in the real code**
- 🟡 **The cause was guessed.** Nothing was reproduced. The checkout cleanup and the checked `SetOrderSession` are real fixes. On main, a failed save left an order that Stripe's webhook could never find, so it stayed "pending" even after payment.
- 🟡 **The date "fix" is a rule change: same-day orders are now accepted.** On main, today's date was always refused, and the message said "pick a delivery date in the future". For a farm box, same-day delivery is probably not wanted. The owner should decide. It uses the server's time zone, which is usually UTC.
- 🟡 **The admin screen now gets only 100 orders.** The response looks the same (a JSON list), but it holds at most 100, newest delivery dates first. Unless the admin screen reads `X-Next-Offset` and asks for more pages, older orders silently disappear from it.
- 🟡 **The likeliest "buggy" symptom is untouched.** Abandoned checkouts still stay `pending` forever and fill customers' order lists.
- 🟡 **The webhook can now ask Stripe to retry for days.** It returns 500 when an `order_id` doesn't match (for example, another app on the same Stripe account), and Stripe sends failure warnings. This is rare.
- ✅ No access changes. Prices unchanged. The indexes help the admin list's sort. The unique index is safe, because each order gets its own Stripe session.

**Access:** No new addresses. `/api/admin/orders` still needs an admin. The webhook still checks Stripe's signature.
**Money:** 💰 Checkout cleanup on Stripe failure. 💰 Payment confirmation now also finds the order by its order number. Prices are unchanged.
**Database / deploy:** Three indexes, one unique. Applied by itself on start; low risk. The unique index would fail only if two orders shared a Stripe session, which this app never does. Building it briefly blocks writes to `orders`.
**Settings:** None.

| | Codex reply / explain | plain |
|---|---|---|
| Same-day dates now accepted (a rule change) | 🟡 framed as a bug fix ("selecting today fail[ed]") | ❌ |
| Pending order removed when Stripe fails | ✅ | ❌ "can't describe" (🟡 the 💰 flag is right) |
| Webhook finds the order by `order_id`; 500 → Stripe retries | 🟡 cause misdescribed (see below); retries not mentioned | ❌ "webhooks stripe parts… can't describe" |
| Admin list capped at 100; the admin screen must page | 🟡 states the default; doesn't warn that older orders vanish | ❌ "can't describe" |
| Indexes, one unique | 🟡 doesn't say unique | 🟡 applies itself ✅; same generic risk line |
| It was a guess | ❌ "Fixed both issues." | ✅ "You didn't say exactly what was wrong, so the agent guessed" |
| Abandoned pending orders still pile up | ❌ | ❌ |
| Testing status | ✅ | ❌ step missing |
| Verdict | — | 🟡 |

**False statements:**
- Codex explain: "There was also a small race: Stripe’s webhook could arrive before the session ID was saved." The customer gets the payment link only after the save (`writeJSON` follows `SetOrderSession`), so that race can't happen. The real gap was a save that failed silently, and the new code does cover it.
- Codex reply: "Fixed both issues." Neither was reproduced, and "slow" wasn't measured.
- plain: "the admin orders and webhooks stripe parts of your server". "webhooks stripe" is a naming slip for "Stripe payment confirmation". Minor.

**Notes for plain**
1. **Pagination with a default limit.** `LIMIT $1 OFFSET $2` plus a default constant (`defaultOrdersLimit = 100`) in a list handler, especially when the next-page signal is only in headers (`X-Next-Offset`, `X-Has-More`) → 🟡 "The admin orders list now sends only the first 100 orders. Your admin screen must ask for the next page, or older orders won't show."
2. **Date rule changes.** A date check that moves from `date.Before(time.Now())` to a start-of-day `today` → "Customers can now order for delivery today." On vague "buggy" requests, state any business-rule change as a rule, not a fix.
3. **Cleanup on Stripe failure.** `DELETE … WHERE status = 'pending'` (or a `DeletePending…` call) in the `session.New` error branch → "If Stripe fails, the half-made order is now removed ✓."
4. **Webhook lookups and refusals.** `event.Data.Object["metadata"]` → `order_id` used to mark paid → "Payment confirmation now finds the order by its order number." A new non-2xx return after `ConstructEvent`, other than the signature failure → 🟡 "If Stripe sends a payment this app doesn't recognise, the server asks Stripe to retry for days."
5. **Index-only migrations.** Plain `CREATE INDEX` → "Speeds up sorting. Applies itself on start; low risk." `CREATE UNIQUE INDEX` → add "fails if duplicates already exist". Drop "Back up first" for non-unique indexes.
6. **Name the webhook.** `/api/webhooks/stripe` → "Stripe payment confirmation (webhook)", never "webhooks stripe parts".
7. The testing-status phrase rule (p4 note 6) applies here too.

---

## Cross-trial summary for plain (priority order)
1. **Holds that never release** (p5 🔴, missed by plain and Codex). A counter that goes up for each `pending` order and never goes down, or a cap that counts `pending`, while nothing expires unpaid checkouts, blocks capacity forever. The same root cause costs p1's customers their discount when they leave the payment page. This is the 🔴 for the third stack in a row (Laravel, Rails, Go).
2. **Required settings from `mustEnv`** (p4). A new `mustEnv("SMTP_ADDR")` in `main` means the whole app won't start without it. plain showed no settings step at all. Read `mustEnv`-style helpers, and `os.Getenv` followed by `log.Fatal`, and turn each new key into a BEFORE YOU SHIP step.
3. **Never claim "nothing refunds" when the code refunds** (p4). plain's only "decide" item was false, because the refund went through a hand-written `https://api.stripe.com/v1/refunds` request. Detect raw Stripe HTTP calls. Before any "no refund" headline, search the diff for `refund`.
4. **The verdict line.** "No problems spotted" sat on p5 (🔴). Until plain detects holds that never release, a card with a new 💰 path should say "plain checked access and database changes only."
5. **Money descriptions.** Read price constants (p5: `DeliveryFeeCents = 400`, `TaxPercent = 8`). Describe a changed `UnitAmount` (p1: half price). 💰 for refunds and session expiry (p4). Scope "charges your customers 💰" to the checkout handler, not every handler in `orders.go` (false on p3 and p4).
6. **Testing-status phrases** (p4, p6). "Tests couldn’t be executed" got no step. Match more verbs and both apostrophes.
7. **Access wording.** "only admins ✓" for a `Route` with `RequireAdmin` (p4; missed in Rails and Laravel too). Own-records and extra rules: "only their own paid orders whose delivery date has come" (p3). "Anyone, logged in or not, read-only" for public GET filters (p2).
8. **Migration risk for golang-migrate.** Detecting `m.Up()` in `main` was right on all four branches. Now grade the risk. Nullable columns and plain indexes → "low risk, applies itself". Keep "Back up first" for backfills with constraints (p5, which really can stop the app), unique indexes and removals. Add that a failed golang-migrate run leaves the database "dirty", and the app stays down until it's fixed by hand.
9. **Fewer "can't describe" lines.** p2 filters, p3 averages, p4 order lists, p6 checkout, webhook and pagination. Use `Query().Get` keys, `AVG(`/`COUNT(`, `LIMIT/OFFSET` with a default, `metadata["order_id"]`, and `DELETE … status = 'pending'` in a Stripe error branch.
10. **API-only repos** (p1, p2, p3). With no front-end files, say "This app is only the server. Your website or app must be updated to show this."
11. **Names and formatting.** "Stripe payment confirmation (webhook)", not "webhooks stripe" (p6). Unwrap JSON error strings (p5). Mention new packages such as `internal/pricing/` (p5). List `stripe_*_id` columns (p4).
12. **Keep what worked.** p1's "sign up again with another email" warning was the right headline; drop "(a guess)" when signup has no verification. p6's "the agent guessed" step was right. Self-migration detection, the "sends emails / shared with the email provider" line, and the file counts were all right.

Login claims checked: p3 "requires login ✓" for `/api/orders/[id]/rating` is **correct**; the server also limits it to the customer's own paid orders whose delivery date has come, which plain didn't say. p4 "requires login ✓" for `/api/admin/orders/[id]/cancel` is **correct** but understated; it should say admins only. No "works without logging in", "needs login to change anything" or "Anyone can" claims were made. **2 login claims, both correct, none wrong.**

---

## Scorecard (plain at the start of this round)

| | Codex "explain" | plain |
|---|---|---|
| Login claims | accurate | **2 made, both correct** (p3, p4 "requires login ✓"; p4 should say admins only). None wrong |
| 🔴 problems caught (p5: unpaid orders hold a delivery slot forever; p4: two new settings the app won't start without) | 0 | 0 |
| Deploy steps | – | ✅ "changes your live database by itself when the app starts" |
| False statements | "prevents discount abuse", "enforced the 30-order limit safely" | p4 "nothing in your app refunds a Stripe payment" (a hand-written call to Stripe's API) |

**The honest result.** Go's login reading held on its first real app. The 🔴 is the same as in the Laravel
and Rails rounds: a hold (a `pending` order, a counted slot) that nothing ever releases. That's now the
top thing plain misses on every stack.

## What we changed in plain (same day)

| Gap | Fix | Result |
|---|---|---|
| New required settings missed (p4: `SMTP_ADDR`, `SMTP_FROM` through `mustEnv`) | Settings the code refuses to start without (`mustEnv("X")`, `env:"X,required"`, `LookupEnv` + fatal) are "add to your hosting settings" steps | p4 |
| "Nothing in your app refunds" when it does (p4: a hand-written request to `https://api.stripe.com/v1/refunds`) | Hand-written calls to Stripe's API count like the SDK's (refunds, Checkout, PaymentIntents) | p4 |
| "The agent didn't test this" missed (p4, p6: "Tests couldn’t be executed") | The passive phrasing counts too (any stack) | p4, p6 |

The independent review of the Go reader found more before it shipped (in the same commit): see
[languages.md](languages.md#go-).

## Still open

1. **Holds nothing releases** (the 🔴 in rounds 7, 8 and 9): a `pending` order or a counted slot taken at
   checkout, with nothing that frees it when the checkout is abandoned.
2. **"Only admins ✓"** for an admin check, in every stack.
