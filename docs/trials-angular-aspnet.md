# Trials, round 6: Angular + ASP.NET Core (FixIt)

A repair shop with an Angular 19 frontend and an ASP.NET Core 9 API: JWT login with a Staff role,
Entity Framework Core on SQLite, a Stripe Checkout deposit and its webhook. The app is in
`examples/repair-shop`. The method is the same as rounds [1](trials.md) to [5](trials-nuxt-sveltekit.md):
six personas asked Codex for a feature; a separate grader established the truth from the code before
reading Codex's own explanation or plain's card. Nothing was run (this Mac has .NET 8, the app targets 9).

| # | Persona | Request |
|---|---|---|
| 1 | Non-technical owner | "can new customers get a free diagnosis on their first repair if they make an account" |
| 2 | Student, first project | "add search and filter by device type and price on the services page, make it look good on phones" |
| 3 | Knows the basics | "let customers rate a repair after it's done and show the average rating on each service" |
| 4 | Junior developer | "Staff should be able to cancel a repair job from the admin area, refund the deposit through Stripe if it was paid, and email the customer." |
| 5 | Experienced developer | "Move pricing into a PricingService on the server, add 8.25% tax and a $5 rush fee option, keep the Stripe deposit amount matching, and never let two customers book the same repair slot at the same time." |
| 6 | Vague and frustrated | "booking a repair is buggy and the admin page is slow, fix it" |

The cards graded below are plain's from **before** this round's fixes. What changed is at the end.

---

## Trial 1: Curious owner floating a promo idea
> "can new customers get a free diagnosis on their first repair if they make an account"

**What was built:** When a customer books, the server checks whether they have booked before. If not, the job gets `FreeDiagnosis = true`, with a new column and migration. In `UpdateStatus`, if the job is flagged and the service is named exactly "Laptop diagnosis", no deposit is set. Promo text was added to the home, login/register, service and my-repairs pages. My-repairs shows "Free diagnosis applied" and "Not required".

**Ground truth: problems in the real code**
- 🟡 **The promise is bigger than the code.** Every page says "your diagnosis is free on your first repair" for every service. Money only changes for the service named "Laptop diagnosis", and even there it just skips the deposit. For every other service the flag is a label: same price, same 25% deposit. This app never charged separately for diagnosis on those services anyway.
- 🟡 **The offer depends on a name.** It matches the string "Laptop diagnosis" (C#) and `serviceName === 'Laptop diagnosis'` (Angular). If staff rename the service, the offer silently stops working.
- 🟡 **Staff can't see the flag.** The admin table was not changed, so at pickup staff have no sign that a job was promised free and may still charge $49.
- 🟡 **Easy to repeat.** "First repair" means the first job on this account. There is no email check, so a new email address gets another free diagnosis. Two bookings sent at the same moment could both get the flag (minor).
- 🟡 **The account condition does nothing.** You already need an account to book, so "if they make an account" adds no extra rule.
- ✅ The flag is decided on the server from the database, not from what the browser sends. No new endpoints. The booking endpoint still requires login. The migration defaults existing rows to false, so the offer isn't given to old jobs.

| | Codex "explain" | plain |
|---|---|---|
| First booking is flagged on the server | ✅ clear, shows the code | 🟡 "store the free diagnosis" only |
| Only Laptop diagnosis is actually $0 deposit | ✅ says so, and admits the name match | ❌ silent ("can't describe") |
| Other services: the flag changes no money | 🟡 says "parts/labor normal", but "diagnostic step is marked as free" still sounds like a real discount | ❌ silent |
| Page copy promises more than the code does | ❌ not raised | 🟡 quotes the copy, doesn't compare it to the code |
| Staff can't see the flag | ❌ | ❌ |
| Repeat by new account | ❌ | ❌ |
| Deposit logic changed (money) | 🟡 explained, not called out as risk | ❌ no 💰 flag on the status endpoint, even though it sets the deposit |
| Migration / deploy | ✅ | 🟡 tells the owner to run `dotnet ef database update`, but the app migrates itself at startup |
| Testing status | n/a (reply2 says builds couldn't run) | ✅ "didn't run or test" |
| Verdict | — | ❌ "No problems spotted" |

**False statements:**
- Codex reply2: "Standalone laptop diagnosis is $0 when it's the first repair." This overclaims. Only the deposit is skipped. The job still shows the $49 price, and nothing records a $0 bill.
- plain: "Apply … or the parts that use it will fail." Not true for this app, because migrations apply on startup.
- plain: "14 files changed". `git diff main p1-free-diagnosis` shows 10. The extra files may come from the earlier Q&A turn, but it doesn't match the branch.

**Notes for plain**
1. **Hard-coded entity names.** Flag a string literal compared to a database name field (`Name.Equals("…")`, `serviceName === '…'`) as 🟡: "This only works while the service is called exactly 'Laptop diagnosis'. Renaming it turns the offer off."
2. **Money in the status endpoint.** Any diff touching an assignment to `*Cents`, `Deposit*` or `Price*` (including a new `if` around one) should get the 💰 "this changes what customers pay" line, the same treatment the deposit endpoint got in p4.
3. **Promise text vs. code.** When new page text contains free/$0/discount/refund, add a step: "The app now promises '<quote>'. Book a test repair and check what you're actually charged."
4. **First-time benefits.** A boolean benefit gated on `!AnyAsync(x => x.CustomerId == userId)` should get 🟡: "Someone can make a new account to get this again."
5. **Auto-migrate.** If `Database.Migrate()` or `MigrateAsync()` runs in Program.cs, say "your server applies this database change by itself when it starts; back up the database file first." Drop the `dotnet ef` step.

---

## Trial 2: Design-minded owner
> "add search and filter by device type and price on the services page, make it look good on phones"

**What was built:** Filtering happens only in the browser, on the home page's service list. There is a text search over name and description, a device dropdown (All, Phones, Laptops), a "Starting price: up to $75 / $100 / $150" dropdown, a result count, a "Clear filters" button and an empty state. Mobile CSS was added at 800px and 560px, with 48px tap targets. There are no server changes.

**Ground truth: problems in the real code**
- 🟡 **Device type is guessed from words.** The regex is `\b(phone|iphone|android)\b` / `\b(laptop|macbook|notebook)\b`. Plurals don't match, so "phones and laptops" in Battery replacement matches neither. That service then shows under both filters, which happens to be right. A service with neither word, such as "Tablet screen" or "Liquid damage", shows under both Phones and Laptops. Staff have no device-type field to set.
- 🟡 The price buckets are fixed in the code ($75, $100, $150). If prices change they may not fit. There's no minimum price.
- 🟡 Not checked on a real phone. No build ran because dependencies weren't installed.
- ✅ No API or login changes. No data risk. Accessibility is decent (labels, aria-live count).

| | Codex "explain" | plain |
|---|---|---|
| Search, device and price filters exist | ✅ | 🟡 mentions the search box and "Clear filters" only, not the two dropdowns |
| Device type is guessed from words | ✅ says it plainly | ❌ silent |
| Mobile styling | ✅ detailed | ✅ "changed how the app looks on small screens" |
| Browser-only, no server | ✅ | 🟡 implied (no Server section) |
| Testing status | 🟡 the explanation doesn't say; the reply says the build couldn't run | ✅ |
| Verdict | — | ✅ "No problems spotted" is fair |

**False statements:** None in either.

**Notes for plain**
1. **List dropdowns.** A new `<select>` should become "a dropdown for 'Device type' (All devices / Phones / Laptops)", using the label and option text. Right now only the input and button are listed.
2. **Keyword guessing.** A regex or `includes()` match on name or description that drives a filter should get 🟡: "The device filter guesses from words in each service's description. New services without 'phone' or 'laptop' in the text show up under both."

---

## Trial 3: Owner wanting social proof
> "let customers rate a repair after it's done and show the average rating on each service"

**What was built:** A nullable `Rating` on `RepairJob`, plus a migration that adds the column **and a SQLite CHECK constraint**. A new endpoint, `POST /api/repairjobs/{id}/rating`, accepts 1–5, only for your own job, only when it's Completed, and only once. The service list and detail endpoints now return `averageRating` and `ratingCount`. Stars appear on the home page, the service page and the staff price list. A star picker on my-repairs appears for completed, unrated jobs.

**Ground truth: problems in the real code**
- 🔴 **The server will very likely fail to start after deploy.** The migration calls `AddCheckConstraint` on an existing SQLite table. SQLite can't add a constraint to an existing table, so EF Core instead rebuilds the table, and to do that it needs the migration's target model from a `.Designer.cs` file. This migration has no Designer file, so EF has nothing to rebuild from and throws "SQLite does not support this migration operation ('AddCheckConstraintOperation')". Because `MigrateAsync()` runs at startup, the whole API would go down, not only ratings. I couldn't run it (no .NET 9 here). Codex didn't build either. The fix is to drop the constraint (the API already checks 1–5) or add a Designer file.
- 🟡 A rating can't be changed or deleted. Staff can't moderate ratings. There's no text review (none was asked for).
- 🟡 If staff move a Completed job back to an earlier status, its rating still counts.
- ✅ The endpoint requires login (class-level `[Authorize]`) and checks ownership with `CustomerId == CurrentUserId()`, so no one can rate someone else's repair. Range, Completed and once-only are all checked on the server. The averages are public, which is fine because the catalog is public.

| | Codex "explain" | plain |
|---|---|---|
| Rating endpoint requires login | ✅ "authenticated" | ✅ "requires login ✓" (correct) |
| Only your own repair | ✅ | ❌ silent |
| Completed + once + 1–5 | ✅ | ❌ silent |
| Averages on services | ✅ | 🟡 "/api/services changed… can't describe" |
| SQLite CHECK constraint can crash startup | ❌ calls the constraint a feature | ❌ silent |
| Which pages make requests | ✅ | ❌ says home, service and admin pages "now send data". They only display new fields |
| Migration / deploy | 🟡 | 🟡 wrong instruction (`dotnet ef`) and misses the crash |
| Testing status | ✅ honest | ✅ |
| Verdict | — | ❌ "No problems spotted" |

**False statements:**
- plain: "The admin page now sends data to your server", "The home page now sends data to your server", "Each service page now sends data to your server". All three are false: those components only gained a `rating()` formatter and template display.
- plain: "Apply … (`dotnet ef database update`) … or the parts that use it will fail". The app migrates on startup, and the real risk is that this migration crashes it.
- Codex: none outright false. It presents the CHECK constraint as a safety feature without noting the SQLite risk.

**Notes for plain**
1. **SQLite + table-rebuild operations.** When `UseSqlite` is present and a migration contains `AddCheckConstraint`, `DropCheckConstraint`, `AlterColumn`, `AddForeignKey`, `AddPrimaryKey` or `AddUniqueConstraint` with no `<name>.Designer.cs`, mark it 🔴: "This database change will likely stop your server from starting. Ask the agent to remove the constraint or generate the migration with `dotnet ef migrations add`."
2. **Owner check.** For a new endpoint with `{id}` whose query filters on `CustomerId == CurrentUserId()` (or `UserId`), say "only the customer who owns the repair ✓". If an `{id}` endpoint has no such filter and no Staff role, mark it ⚠ "a customer could do this to someone else's repair."
3. **"Sends data" only for new calls.** Only say a page sends or loads data when its component diff adds a new call (an `HttpClient` call, or a `this.repairs.<method>(` that wasn't there before). Changes to the model or template alone are display changes. Say "now shows the average rating ★" instead.
4. **Server-side checks.** Describe guard clauses (`if (job.Status != "Completed") return Conflict`, `if (job.Rating is not null) return Conflict`, range checks): "Only after the repair is Completed, once, 1–5 stars."

---

## Trial 4: Operations owner with a precise, money-touching spec
> "Staff should be able to cancel a repair job from the admin area, refund the deposit through Stripe if it was paid, and email the customer."

**What was built:** A new endpoint, `POST /api/repairjobs/{id}/cancel`, with `[Authorize(Roles = "Staff")]`. It:
- checks the Stripe Checkout session, marks the job paid if Stripe says paid, and expires the session if it's still open;
- refunds the PaymentIntent with the idempotency key `repair-job-{id}-deposit-refund`;
- stores the PaymentIntent ID and Refund ID, sets status Cancelled, then sends an SMTP email (HTML-encoded, with an optional staff note);
- returns 502 if the email fails, with a "Retry email" button in admin that doesn't refund again.

The webhook now refunds automatically if a payment completes after cancellation. A cancelled job can't take a deposit or be reopened through the status menu. The migration adds 4 columns plus a unique index on RefundId. New `Email:*` settings were added.

**Ground truth: problems in the real code**
- 🟡 **Email isn't set up by default.** `Email:SmtpHost` and `FromAddress` are empty in appsettings, and the sender throws when they're missing. Until they're set, every cancellation (and its refund) still goes through, but staff see "the customer email could not be sent". Only `SmtpHost` and `FromAddress` are required. `FromName` defaults to "FixIt Repair" and Username/Password are optional.
- 🟡 **Stale Pay button.** On a cancelled job with a deposit set but unpaid, my-repairs still shows "Deposit ready / Pay deposit". The server refuses (409), and the customer sees a generic "Checkout could not be started".
- 🟡 A late refund from the webhook doesn't email the customer. Their email said "No deposit was charged", so they get no word about the refund.
- 🟡 Business note: Stripe doesn't give back its processing fee on refunds, so the shop pays the fee on every cancelled paid deposit. Refund failures that happen later (refund status `failed`) aren't tracked.
- ✅ Staff-only on the server. Refunding twice is prevented three ways: the idempotency key, the stored RefundId and the unique index. Open checkouts are expired. Cancel then email is ordered safely and email retry works. Completed jobs can't be cancelled. This is a solid implementation.

| | Codex "explain" | plain |
|---|---|---|
| Cancel endpoint is Staff-only | ✅ "staff-only" | 🟡 "requires login ✓". True, but it should say staff only |
| Refund through Stripe, no double refund | ✅ idempotency explained | 🟡 "asks Stripe to create a refund" only |
| Webhook auto-refund after cancel | ✅ | ✅ "payments webhook now asks Stripe to create a refund" |
| Deposit endpoint touched (money) | ✅ | ✅ 💰 "make a test payment" (conservative, fine) |
| Email settings needed | ✅ README + user-secrets | 🟡 lists 5 keys; 3 are optional, and it doesn't say what breaks without them |
| Email fails → cancelled anyway, retry | ✅ | ❌ silent |
| Cancelled job still shows Pay deposit | ❌ | ❌ |
| DB fields | ✅ all 4 | 🟡 lists the dates only, not the Stripe payment/refund IDs |
| Verdict | — | ✅ "No problems spotted" is reasonable here |

**False statements:**
- plain: "The my repairs page now sends data to your server." False. That page only shows a "Deposit refunded" state.
- plain: steps 5–7 ("Add Email__FromName / Username / Password") present optional settings as required. This overstates rather than contradicts.
- plain: the migration step again ignores the startup auto-migrate.
- Codex: none found.

**Notes for plain**
1. **Role-aware login label.** `[Authorize(Roles = "Staff")]` or `RequireRole("Staff")` should read "only staff can do this ✓", not "requires login ✓". For an owner, "customers can't cancel" is the point.
2. **Required vs. optional config.** `config["X"] ?? "default"` and `GetValue("X", default)` mean optional. Leave those out or put them under "optional". A key whose absence causes `throw` is required: say what breaks ("Cancelling a repair will show an email error until Email__SmtpHost and Email__FromAddress are set").
3. **Refund safety.** When `RefundService().CreateAsync` has an `IdempotencyKey`, add "won't refund twice if clicked again ✓". Without one, mark ⚠.
4. **Partial-failure path.** If a `catch` returns a 5xx after `SaveChangesAsync` has already committed, say: "If the email fails, the repair stays cancelled (and refunded); staff can retry the email."

---

## Trial 5: Technical owner writing a spec
> "Move pricing into a PricingService on the server, add 8.25% tax and a $5 rush fee option, keep the Stripe deposit amount matching, and never let two customers book the same repair slot at the same time."

**What was built:** A `PricingService` that works in integer cents with explicit rounding: (base + $5 rush) × 8.25% tax = total, and deposit = max($10, 25% of total). Each job stores BasePrice, RushFee, Tax and Total at booking. The status change sets the deposit from the stored total, and Stripe Checkout charges that exact stored amount. The webhook now marks a deposit paid only if `session.AmountTotal == job.DepositCents`. There's a new public endpoint, `GET /api/services/{id}/quote`. A **new required booking slot**, `ScheduledAt` (UTC, 30-minute boundaries), has a **unique index across all jobs**. A conflict returns 409. The migration backfills prices for existing jobs.

**Ground truth: problems in the real code**
- 🟡 **The new amount check can drop real payments silently.** If the amounts ever differ (an older session, a manual change, Stripe tax or promo codes turned on later), the customer **has paid but the job stays "unpaid"**. The webhook still returns 200 OK, logs nothing, and Stripe doesn't retry. Today the amounts should match, so this is an edge case, but the failure is silent and involves money.
- 🟡 **What "slot" means here.** The unique index on `ScheduledAt` alone means the whole shop takes one repair per half hour, ever. Cancelled or finished jobs keep their slot forever. There are no opening hours, so 3 a.m. on a Sunday works. One customer can grab unlimited slots. Customers can't see which slots are free, so they guess and get "That time was just booked". Confirm this matches how the shop runs (number of technicians, hours).
- 🟡 **Deploy the app and server together.** `CreateRepairJobRequest` now requires `ScheduledAt` and `IsRush`, so the old Angular app can't book against the new API.
- 🟡 The date picker's `step=1800` isn't enforced, so a typed time like 10:15 gets a generic "could not book" error. Time zones with a :45 offset can't hit a :00 or :30 UTC slot.
- 🟡 The backfill uses the *current* service price for old jobs, not the price at the time they were booked. Tax also applies to the rush fee (a legal/business call).
- ✅ The price math is right, in cents, with rounding. The Stripe amount equals the stored deposit. The double-booking race is closed at the database level, and the losing request gets a clean 409. The quote endpoint is public but harmless (public price math). Booking still requires login.

| | Codex "explain" | plain |
|---|---|---|
| PricingService, tax, rush, total | ✅ | ❌ "can't describe" |
| Stripe deposit = stored amount | ✅ | ❌ silent (the webhook was touched, but there's no 💰 line) |
| Webhook amount check drops mismatched payments | ❌ presented as pure safety | ❌ silent |
| Unique slot = 1 booking per half hour for the whole shop, forever | 🟡 explains the index and the race well, not the business meaning | ❌ silent |
| Quote endpoint is public | ✅ | ✅ "works without logging in" (correct; no false alarm). "lists repair services" is the wrong description |
| Required new booking fields → deploy together | ❌ | ❌ |
| Migration backfill | ✅ | 🟡 lists the columns; wrong `dotnet ef` advice |
| Testing status | ✅ honest (migration SQL smoke-tested, no build) | 🟡 "didn't run or test" (it partly did) |
| Verdict | — | ❌ "No problems spotted" |

**False statements:**
- Codex: "The Stripe webhook additionally checks that Stripe's paid amount equals the stored deposit … This prevents the UI, database, and Stripe from disagreeing." Wrong in the mismatch case: Stripe holds the money while the database says unpaid, which is exactly a disagreement, created silently.
- plain: "New server code that **lists repair services**" for `/quote`. It calculates a price quote.
- plain: "The admin page now loads data from your server", "The my repairs page now loads data". No new requests; they only display new fields. The service page's new quote request is real.
- plain: "a checkbox for 'Rush serviceAdd $5 before tax'" (text glued together) and "a box for 'scheduled at'" (the visible label is "Repair slot").
- plain: the migration step ignores the startup auto-migrate.

**Notes for plain**
1. **Webhook guard rule (🔴/🟡 money).** A newly added condition on the branch that sets `*Paid = true` inside a payment webhook, with no `else`, log or error, should read: "If this check fails, the customer is charged but the repair stays unpaid, and nothing tells you."
2. **Unique index explained.** `HasIndex(x => x.<DateTime>).IsUnique()` with no status or other columns should read: "Only one repair can ever be booked at a given time, for the whole shop, including cancelled or finished ones."
3. **Required new request fields.** A non-nullable field added to a request record, or a return type changed from `List<T>` to a wrapper: "Ship the app and the server together; the old app can't book against the new server."
4. **Money-file detection.** A new file or class whose name contains Pricing, Price, Tax, Fee or Deposit, or constants such as `0.0825m` or `500` near "Fee", should state the numbers: "Tax 8.25%, rush fee $5.00, deposit 25% (min $10)". These are literal constants plain can read.
5. **Text extraction.** Join adjacent text nodes with a separator. Use `<label for=…>` text before `formControlName`. Name endpoints from their last path segment (`quote` → "gives a price quote").

---

## Trial 6: Frustrated owner with a vague complaint
> "booking a repair is buggy and the admin page is slow, fix it"

**What was built:**
- Booking: the server checks Device (≤100 characters) and Issue (10–1000) after trimming, and returns a specific message. The client trims before checking, blocks a double submit, and shows the server's message.
- Admin: the API now returns pages, `GET /api/repairjobs?page&pageSize` → `{items,total}`, 50 per page with a maximum of 100, using a lean projection without `Include`. A new index on `CreatedAt`. A "Load more jobs" button, OnPush change detection, the currency pipe, and the status dropdown is disabled while saving.

**Ground truth: problems in the real code**
- 🟡 **The cause was guessed.** No bug was reproduced. The fixes are reasonable guesses: whitespace-only text that passed the browser but failed the server, and double clicks.
- 🟡 **The API response changed shape.** It went from a list to `{items,total}`. The app and server must ship together, and anything else reading this endpoint breaks.
- 🟡 Page-number paging: if new bookings arrive between "Load more" clicks, rows repeat (same `job.id` twice in the list).
- 🟡 The heading changed from "Active repair jobs" to "Repair jobs" (small unasked change).
- ✅ Still Staff-only. No new endpoints. The index migration is harmless and applies at startup. I checked OnPush against the admin dialog code and found no stale-UI bug.

| | Codex "explain" | plain |
|---|---|---|
| What the booking fix is | ✅ concrete | ❌ "can't describe" |
| Admin paging, "Load more jobs" | ✅ | ❌ "can't describe" (the button text was there to quote) |
| It was a guess | 🟡 implicit | ✅ "You didn't say exactly what was wrong, so the agent guessed. Check…" (best line on this card) |
| API shape change → deploy together | ❌ | ❌ |
| Migration applies at startup | ✅ says so | ❌ tells the owner to run `dotnet ef` |
| Testing status | 🟡 not in the explanation; the reply says builds were unavailable | ❌ missing (plain didn't catch "builds were unavailable") |
| Verdict | — | 🟡 "No problems spotted" is fair, but the card is mostly empty |

**False statements:**
- plain: "Apply 20261028000200_IndexRepairJobsCreatedAt … or the parts that use it will fail." Codex was right that it applies automatically, and a missing index makes nothing fail.
- Codex: none found.

**Notes for plain**
1. **Untested phrase list.** Add "builds were unavailable", "were unavailable", "not installed", "couldn't build" to the "agent didn't test" detector. p6 slipped through.
2. **Fall back to visible UI.** Even when the logic is opaque, list new buttons ("Load more jobs") and new page text ("Showing X of Y jobs"). Never end up with a card that only says "can't describe".
3. **Paging pattern.** `.Skip(...).Take(...)` plus a `page` or `pageSize` parameter: "The admin list now loads 50 repairs at a time."
4. **Response-shape change.** Same rule as p5 note 3: say "ship together".

---

## Cross-trial summary for plain (priority order)
1. **Auto-migrate awareness** (all 5 migration cards). Detect `Database.Migrate()` or `MigrateAsync()` and replace the `dotnet ef database update … or it will fail` step with "applies itself on server start; back up the database file first." Today this step is misleading on every card.
2. **SQLite migrations that crash on startup** (p3, 🔴 missed). Table-rebuild operations in a migration with no Designer file under `UseSqlite`.
3. **Money rules.** 💰 for any change to `*Cents`, `Deposit*` or `Price*` assignments, including in the status endpoint (p1, p5). A webhook guard before `Paid = true` with no else or log means "charged but not recorded" (p5).
4. **Role and owner wording.** "only staff ✓" for `Roles = "Staff"` (p4). "only the owner of the repair ✓" for `CustomerId == CurrentUserId()` filters (p3), and ⚠ when an `{id}` endpoint has neither.
5. **Stop false "sends/loads data" lines.** Only for newly added HTTP calls in that component (p3 ×3, p4, p5 ×2 false).
6. **Required vs. optional config,** with the consequence of a missing key (p4).
7. **Business-meaning lines for constraints.** Unique DateTime index (p5), hard-coded name match (p1), keyword-guessed categories (p2), first-account benefit (p1).
8. **Deploy-together warning** when a request field becomes required or a response changes shape (p5, p6).
9. **Better UI extraction:** dropdowns, label text, joined text, button text when the logic is opaque (p2, p5, p6).

Login claims checked: p3 "requires login ✓" is correct. p4 "requires login ✓" is correct but should say Staff-only. p5 "works without logging in" for `/quote` is correct and harmless. **No wrong login claims.**

---

## Scorecard (plain at the start of this round)

| | Codex "explain" | plain |
|---|---|---|
| Login claims | accurate on login and owner checks every time | **All correct** ("requires login ✓" on p3, p4; "/quote works without logging in" on p5). None wrong |
| 🔴 problems caught | 0 (p3's database rule, which SQLite may refuse at startup, was called a safety feature) | 0 |
| Database steps | – | 🟡 "run `dotnet ef database update`" though the app migrates itself at startup |
| Wording | – | optional email settings listed as required; pages "now send data" when they only show new fields; "Rush serviceAdd $5" glued together |

**The honest result.** The ASP.NET and Angular readers held: no false ✓ or ⚠ in six changes,
including staff-only cancelling and an owner-only rating. The misses were again what happens after
the change: a webhook that silently ignores a payment whose amount doesn't match (p5), and a one-
booking-per-half-hour rule for the whole shop.

## What we changed in plain (same day)

| Gap | Fix | Result |
|---|---|---|
| "Run `dotnet ef database update`" for an app that migrates itself | When the code calls `Database.Migrate()`: "will change your live database by itself the next time the app starts. Back up first; if it fails, the app won't start." | All five migration cards |
| A SQLite migration that stops the server starting (p3, 🔴 missed) | SQLite can't alter a table in place: EF rebuilds it from the migration's model, which lives in the `.Designer.cs`. A hand-written migration without one that adds a CHECK constraint, drops a column, etc. is now 🔴 "will fail on your SQLite database… so it won't start". Reproduced on a real EF Core 8 run (`NotSupportedException`), and the same migration with a model goes through | p3 |
| A migration EF can't find | New: a migration with no `[Migration]` attribute (in the file or its `.Designer.cs`) never runs. Checked against all six branches: Codex wrote the attribute in the file each time, so it stays quiet | – |
| Optional settings listed as required (p4) | A setting with a real fallback (`?? "FixIt"`) is optional; `?? ""` / `string.Empty` / `throw` keeps it required | p4, and the base app |

## Still open

1. **"Only staff ✓" / "only the owner ✓"** instead of a bare "requires login ✓".
2. **Money paths:** a webhook that drops a payment whose amount doesn't match; a free item that only
   changes one service's deposit (p1).
3. **Pages that "now send data"** when they only display new fields (Angular services shared by
   several components).
