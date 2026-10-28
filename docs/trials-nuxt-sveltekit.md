# Trials, round 5: Nuxt (Leafy) and SvelteKit (Brightside)

Two apps the way Bolt builds them, one per framework:

- **Leafy** (`examples/plant-swap`, private repo `plain-plant-swap`): a plant shop on Nuxt 3,
  nuxt-auth-utils, Prisma and Stripe Checkout.
- **Brightside** (`examples/tutor-booking`, private repo `plain-tutor-booking`): a tutoring
  business on SvelteKit 2 with Svelte 5, Drizzle, a session-cookie login and Stripe Checkout.

The method is the same as rounds [1](trials.md) to [4](trials-django.md):

- Six personas per app asked Codex for a feature.
- We recorded Codex's reply, its answer to "Explain me what u did and how?", and plain's card.
- A separate grader per app established the truth from the code *before* reading either
  explanation. They read the code only; nothing was run.

| # | Persona | Leafy (Nuxt) | Brightside (SvelteKit) |
|---|---|---|---|
| 1 | Non-technical owner | "can ppl get a free small plant with their first reservation if they sign up" | "can new parents get their first session half off if they make an account" |
| 2 | Student, first project | "add a search and filters for light level and price, make it work nice on phones" | "add filters for subject and price on the home page and make it look good on phones" |
| 3 | Knows the basics | "let logged in customers keep a wishlist of plants and see it on their account page" | "let logged in parents leave a review for a tutor after a paid session, and show reviews on the tutor page" |
| 4 | Junior developer | "Owner should be able to cancel a reservation from the admin page, put the plant back in stock, and email the customer with Resend." | "Owner should be able to mark a tutor away for a day from admin; cancel that day's unpaid bookings and email the parents." |
| 5 | Experienced developer | "Move pricing into server/utils/pricing.ts, add an 8% sales tax and a $3 pot deposit, keep Stripe amounts in sync, and never reserve more than what's in stock even if two people check out at the same time." | "Move pricing into src/lib/server/pricing.ts, add a $2 booking fee and 7% tax, keep Stripe amounts matching, and never double-book a tutor's time slot even if two parents pay at once." |
| 6 | Vague and frustrated | "reserving is glitchy and the admin page is slow, fix it" | "booking is buggy and the admin page is slow, fix it" |

The cards graded below are plain's from **before** this round's fixes. What changed is at the end.

---

# Leafy (Nuxt)

## Trial 1: Casual owner, texting style
> "can ppl get a free small plant with their first reservation if they sign up"

**What was built:** A public signup page (`/signup`) and `POST /api/auth/signup`. New accounts get `welcomeGiftEligible = true`. The first reservation claims the gift atomically in the same transaction (`includesWelcomeGift`). If checkout fails or expires, the gift goes back to the customer. A "+ Free small plant" label shows in admin and in the customer's reservations. Promo text appears on the home, login, signup and plant pages. There is a migration.

**Ground truth: problems in the real code**
- 🟡 **Easy to abuse with new accounts.** There is no email verification and no rate limit. One person with a new email address gets a free plant with each first paid reservation. They do have to buy something each time, so it's a "2-for-1 per throwaway email" deal.
- 🟡 **The free plant isn't tracked in inventory.** No stock goes down for it, and no plant is named. Staff have to notice the admin label and hand one out. If small plants run out, nothing stops the promise.
- 🟡 **Unasked change in checkout.** The "Stripe not configured" check moved inside the `try`. A missing key used to return 503 and keep the hold. Now it cancels the reservation and returns 502. This is arguably better, but nobody asked for it.
- 🟡 **The gift can get stuck.** It is claimed at reservation time, not at payment. If the tab closes between the "reserve" and "checkout" calls, the gift stays tied to a PENDING reservation that never expires. Stock gets stuck the same way, and that problem already existed before this change.
- 🟡 **Deploy order.** Two new columns need the migration applied before the new code runs.
- ✅ The signup route is public, which is correct for a signup. It only takes name, email and password. The role defaults to customer, so there's no way to make yourself an admin. The redirect check refuses `//` (open redirect blocked). Passwords are bcrypt-hashed. A duplicate email returns 409.
- ✅ The gift claim is atomic (`updateMany where welcomeGiftEligible: true`), so two reservations at once can't both get it. A failed stock claim rolls the gift claim back.
- ✅ Existing accounts start as not eligible, which matches "if they sign up".

| | Codex "explain" | plain |
|---|---|---|
| New signup page + API | ✅ detailed | ✅ "signup page is new… saves new users" |
| Gift claimed on first reservation, atomic | ✅ | 🟡 "reservations part… now saves users" (vague) |
| Gift restored if checkout fails/expires | ✅ | 🟡 "checkout/webhook… now saves users" (says nothing useful) |
| Existing customers not eligible | ✅ said | ❌ silent |
| Free plant not in inventory / staff must hand it out | 🟡 "additional free item prepared by the shop" | ❌ silent |
| Abuse via throwaway accounts | ❌ silent | ❌ silent ("No problems spotted") |
| New public signup route | ✅ (implicitly) | ❌ never says "anyone can create an account (expected)" |
| Checkout config-check behavior change | ❌ silent | ❌ silent |
| Migration needed | ✅ "apply the database migration" | ❌ lists DB fields, no ship step |
| Login claims | n/a | none made (none wrong) |

**False statements:**
- plain: "The login page now shows the nuxt link." This is component-name leakage and means nothing to an owner. It isn't false, but it's junk.
- plain: "stripe checkout… now saves users." Misleading. It only gives the gift back when checkout fails.
- Codex: none found.

**Notes for plain**
1. When a migration file appears under `prisma/migrations/`, add a ship step: "Apply the database update before the new code goes live." This was missing here and in p2, p3 and p6.
2. When a new `server/api/auth/*signup*`/`register*` route has no `requireUserSession`, say "Anyone can create an account here (that's normal for signup)". Then check for rate limiting and email verification. If neither exists and the diff adds a perk tied to new accounts (a boolean like `*Eligible`, `*Gift*`, `firstOrder`), flag "One person can make many accounts to get the perk again."
3. Phrase `user.updateMany/update` with a single boolean field as "turns X on/off for the customer", not "saves users".
4. Stop naming Vue components like "nuxt link". Say "links to the signup page" (the `to=` target).
5. Don't count `catch (error: any)` as "type checking turned off". This is noise in p1, p4 and p6.

---

## Trial 2: Owner who wants a nicer shop on phones
> "add a search and filters for light level and price, make it work nice on phones"

**What was built:** In the browser: search over name and description, plus Light (Low/Medium/Bright) and max price ($20/$30/$40) dropdowns on the home page. There's a result count, Clear buttons and an empty state. A new `Plant.lightLevel` column (default MEDIUM) with a migration. The admin form gets a Light dropdown. The admin create and edit endpoints check the light level. Each plant card shows a light badge. The seed data is updated. The CSS has breakpoints at 900, 560 and 390px.

**Ground truth: problems in the real code**
- 🟡 **Every existing plant becomes "Medium light".** The migration default is MEDIUM. Only the *seed* file got real values, and seed doesn't run on a live shop. The Light filter gives wrong results until the owner re-tags each plant in admin.
- 🟡 **Deploy order.** `/api/plants` now selects `lightLevel`. If the code ships before the migration, the whole storefront breaks.
- 🟡 Small gaps: the plant detail page doesn't show light level. Price buckets are fixed at $20/$30/$40, and anything above $40 only shows under "Any price". Filtering happens in the browser, which is fine at this catalog size.
- ✅ Admin-only checks didn't change (`requireAdmin`). No new routes. The admin edit flow gets `lightLevel` because the admin GET returns all fields. The new value is checked against an allowlist.
- ✅ The phone layout is real: the filters stack at 560 and 390px.

| | Codex "explain" | plain |
|---|---|---|
| Search box | ✅ | ✅ "box for Search plants" |
| Light + price filters | ✅ | 🟡 only mentions "Clear" buttons, not the two filters |
| New light-level field | ✅ | ✅ "Plants now also store the light level" |
| Existing plants all default to Medium | 🟡 mentions the default, never says "re-tag your plants" | ❌ silent |
| Admin form gets Light dropdown | ✅ | ✅ |
| Phone layout | ✅ | ✅ "changed how the app looks on small screens" |
| Migration needed / deploy order | ✅ "npm run db:migrate" | ❌ no ship step |
| Server routes still admin-only | 🟡 not stated | ❌ "can't describe… ask the agent" |

**False statements:** none. Codex's sketch says "price is below the limit" when the code uses ≤, which is trivial.

**Notes for plain**
1. When a migration adds a column with a `DEFAULT`, write: "Every existing plant will start as 'MEDIUM'. You may need to update them." plain has the literal value right there in the SQL.
2. When a `<select>` with `v-model` is added, name it from its `<label>`: "a Light filter and a Price filter". Today plain lists only buttons.
3. Admin routes whose diff only adds a field and still call `requireAdmin` should say "still only for admins ✓", not "can't describe".
4. Same as T1 #1: add the migration ship step.

---

## Trial 3: Owner adding a customer feature
> "let logged in customers keep a wishlist of plants and see it on their account page"

**What was built:** A `WishlistItem` table keyed on (user, plant), with cascade deletes and a migration. Three routes: `GET /api/wishlist`, `POST` and `DELETE /api/wishlist/:plantId`. All of them use `requireUserSession` and scope every query to `session.user.id`. There's a heart button on plant cards and a "Save to wishlist" button on the plant page. A new `/account/wishlist` page uses the `auth` middleware. A new AccountNav adds Reservations | Wishlist tabs. The header label changed from "My reservations" to "My account".

**Ground truth: problems in the real code**
- 🟡 **Saved hearts probably show as unsaved after a full page load.** `pages/index.vue` and `plants/[id].vue` call `$fetch('/api/wishlist')` at the top level of setup. During server rendering, Nuxt's `$fetch` doesn't forward the browser's cookie. So the server gets a 401, the empty `catch` swallows it, and the page renders as "nothing saved". The client then fetches again. Vue doesn't fix `class`/`aria-pressed` hydration mismatches in production, so hearts can stay looking empty. This is likely from the code; it needs a real run to confirm. The fix is `useFetch`/`useRequestFetch`.
- 🟡 **Hidden plants leak (small).** `POST` accepts any plant ID with `findUnique`, with no `isAvailable` check. `GET` returns `plant: true`, which means all fields. A logged-in customer can save IDs 1..N and read the names, descriptions, prices and stock of plants the owner hid.
- 🟡 Wishlist items for plants that are hidden or sold out still show and link to a page that 404s.
- 🟡 Small request gap: the wishlist is a separate `/account/wishlist` tab, not on the existing account page. The header rename is an unasked change.
- ✅ Login checks: all 3 new routes require login, and every read, write and delete is limited to the customer's own rows. A customer can't touch someone else's wishlist. The new page has the `auth` middleware. Upsert stops duplicates.

| | Codex "explain" | plain |
|---|---|---|
| Wishlist table + migration | ✅ | ✅ |
| 3 routes require login | ✅ | ✅ "requires login ✓" ×3, all **correct** |
| Wishlist page needs login | ✅ | ✅ "You have to log in to open it ✓", **correct** |
| Customer can't touch others' wishlist | ✅ said explicitly | 🟡 not stated (true) |
| Heart / save buttons | ✅ | 🟡 "loads wishlist items" only, buttons not named |
| Saved state wrong on page load (SSR cookie) | ❌ silent | 🟡 its "error silently ignored" loose ends point at exactly these two catches, by luck |
| Hidden plants readable via wishlist | ❌ | ❌ |
| Header renamed to "My account" | ✅ disclosed | ❌ silent |
| Migration needed | ✅ | ❌ no ship step |

**False statements:** none in either. Codex: "Each endpoint uses requireUserSession, so one customer cannot read or change another customer's wishlist". That's true, because every query also filters by `session.user.id`.

**Notes for plain**
1. Add a "your own data only ✓" claim. When a route calls `requireUserSession` and every Prisma `where` includes `userId: session.user.id`, say "customers only see/change their own wishlist ✓". If a route takes an ID from the URL and *doesn't* filter by session user, warn.
2. When a customer-facing route does `findUnique({ where: { id } })` on a model whose public list filters `isAvailable: true`, but this route doesn't, flag "can see plants you've hidden."
3. In `pages/**`, a top-level `await $fetch('/api/...')` to a route that needs login is a fixed-pattern bug in Nuxt: "may not know who's logged in when the page first loads; use useFetch." It's a strong, cheap rule.
4. An empty `catch` with a comment explaining why is deliberate. Lower its weight unless the call matches rule 3.
5. Mention when a `<NuxtLink>` label changes in the header (an unasked label change).

---

## Trial 4: Precise ops owner who names the vendor
> "Owner should be able to cancel a reservation from the admin page, put the plant back in stock, and email the customer with Resend."

**What was built:** A "Cancel reservation" button (with a confirm prompt) for PENDING, PAID and READY rows on `/admin`. `PATCH /api/admin/reservations/:id` with `status: CANCELLED` is admin-only. One transaction sets the status to CANCELLED, with a status guard against double-cancel, and adds the quantity back to stock. Then it emails the customer through Resend's HTTP API, with an idempotency key and HTML escaping. If the email fails, the admin sees "cancelled and stock restored, but email could not be sent". New env vars `NUXT_RESEND_API_KEY` and `NUXT_RESEND_FROM_EMAIL` are required. Without them, cancel returns 503.

**Ground truth: problems in the real code**
- 🔴 **Cancelling a PAID or READY reservation keeps the customer's money.** There's no Stripe refund. The email says "was cancelled by the shop" and doesn't mention a refund. The owner has to refund by hand in Stripe, and nothing in the app reminds them. Chargeback risk.
- 🔴 **Cancelling a PENDING reservation while the customer is still on Stripe's page.** The Stripe session stays open (it isn't expired). The customer can still pay. The webhook only marks PENDING reservations as PAID, so the payment is ignored. The customer gets charged, the reservation stays CANCELLED, and the plant is already back in stock to be sold again.
- 🟡 **Deploy trap.** Cancel is fully blocked (503) until both Resend env vars are set and the sender domain is verified in Resend.
- 🟡 A failed email can't be retried. The status is already CANCELLED, so the button disappears.
- 🟡 Cancelled reservations drop out of "Paid reservation value" even when the money was kept. The revenue number becomes wrong.
- ✅ Admin-only: `requireAdmin` on the server and `admin` middleware on the page. The race guard (`updateMany where status: current`) stops double stock restores. Email failure is handled honestly. Customer data in the HTML is escaped.

| | Codex "explain" | plain |
|---|---|---|
| Cancel button on admin page | ✅ | ✅ "has a Cancel reservation button" |
| Stock restored in same transaction | ✅ | 🟡 "now saves plants" (misleading wording) |
| Customer emailed via Resend | ✅ | ❌ silent, no mention of email at all |
| Email-failure handling | ✅ | ❌ |
| Admin-only | ✅ | ❌ not stated (true) |
| **No refund for paid cancellations** | ✅ **disclosed** ("does not issue a Stripe refund") | ❌ "No problems spotted" |
| Pending cancel while customer paying → charged | ❌ silent | ❌ silent |
| New env vars needed before it works | ✅ | ❌ no ship step |

**False statements:**
- plain: "✓ No problems spotted." Wrong. There are two money-loss paths.
- plain: "The admin reservation part of your server now saves plants." Misleading. It cancels reservations and adds stock back.
- Codex: none. Its README line "Checkout expiration or an owner cancellation… restores stock" is true.

**Notes for plain** (most valuable first)
1. **Refund rule, scoped correctly.** Flag "customers who already paid get nothing back" when code sets `status: 'CANCELLED'` (or `REFUNDED`/`VOID`) **and** the statuses it can cancel from include `'PAID'` (an array literal, `in: [...]`, or a `where.status` the code reads from the current row), **and** the diff and repo have no `refunds.create`. That fires here, where it's true. It doesn't fire in p6, where it fired as a guess (see T6).
2. **Open-checkout rule.** When a cancel path accepts `'PENDING'` and the model has `stripeSessionId` but no `checkout.sessions.expire` is called, write: "A customer may still pay for a cancelled reservation."
3. New keys in `.env.example` or `runtimeConfig` → a ship step: "Add NUXT_RESEND_API_KEY and NUXT_RESEND_FROM_EMAIL to your live settings, or cancelling won't work."
4. An outbound call to `api.resend.com`, `resend.emails.send`, `sendgrid`, `postmark` and similar → a WHAT CHANGED line "now emails the customer when…". Check whether a failure is caught.
5. `stock: { increment }` → "puts stock back". `status: 'CANCELLED'` → "can cancel reservations". Never use "saves plants".
6. `requireAdmin(event)` in the handler → "only admins ✓".

---

## Trial 5: Technical owner with a spec
> "Move pricing into server/utils/pricing.ts, add an 8% sales tax and a $3 pot deposit, keep Stripe amounts in sync, and never reserve more than what's in stock even if two people check out at the same time."

**What was built:** `server/utils/pricing.ts` computes subtotal, 8% tax (rounded), $3 × quantity deposit, and total. The reservation now stores the full breakdown (a migration rebuilds the table and copies old rows in with tax and deposit set to 0). Checkout sends separate Stripe lines for the plant, deposit and tax, built from the stored breakdown, and checks the sum. The webhook only marks PAID if Stripe's `amount_total` matches. The stock race code is unchanged; it gained only a comment.

**Ground truth: problems in the real code**
- 🟡 **Customers never see tax or deposit before Stripe.** No page changed. The plant page still shows $28, and Stripe then asks for $33.24. That surprise leads to abandoned checkouts or complaints.
- 🟡 **A mismatched payment is silently ignored.** If Stripe's total ever differs (for example, someone turns on promo codes in the Stripe dashboard), the customer is charged but the reservation stays PENDING forever. It never expires because the session completed. Stock stays held, and the only signal is a server log line.
- 🟡 **The "refundable" deposit has no refund mechanism.** Nothing tracks or returns it.
- 🟡 **The admin "Paid reservation value" now includes tax and deposits.** Revenue looks inflated by tax money owed to the state and by deposits.
- 🟡 **Deploy order.** The table rebuild must run before the new code. The rebuild is safe: it copies all rows. Back up anyway.
- ✅ Pricing is in one file, and the Stripe lines are built from stored cents. Integer division is checked, and a price change after reserving doesn't change the amount charged. The webhook signature check is unchanged. The stock race was **already safe** before this change (a conditional `updateMany` in a transaction) and still is.

| | Codex "explain" | plain |
|---|---|---|
| pricing.ts created | ✅ | ✅ "created server/utils/pricing.ts, as you asked" |
| Tax + deposit math | ✅ with example | ❌ "can't describe" |
| Stripe lines in sync | ✅ | 🟡 "💰 Make a test payment" (good prompt, no content) |
| Webhook amount check | ✅ (but frames it only as a safety win) | ❌ |
| Customer charged but stuck PENDING on mismatch | ❌ | ❌ |
| Stock race | 🟡 presented as "Prevented concurrent overselling", though it was already there | ❌ silent |
| No price breakdown shown before Stripe | ❌ | ❌ |
| "Refundable" deposit with no refund path | ❌ | ❌ |
| Migration risk | ✅ "ran both migrations… integrity check" | 🟡 "Back up your data first" is good advice, but the reason given is wrong (see below) |

**False statements:**
- plain: "migration.sql deletes data and can't be undone." **False.** It's SQLite's standard table rebuild: it copies every row into `new_Reservation`, then drops the old table and renames. No data is lost.
- Codex: "I changed four connected parts: … stock safety" and "Prevented concurrent overselling". Misleading. The protection was already in the code, and Codex only added a comment. Codex's own step-by-step does describe the existing mechanism correctly.

**Notes for plain**
1. **Table-rebuild detection.** If a migration has `CREATE TABLE "new_X"`, `INSERT INTO "new_X" … SELECT … FROM "X"`, `DROP TABLE "X"` and `ALTER TABLE "new_X" RENAME TO "X"`, call it "rebuilds the reservations table and copies all rows (back up first to be safe)". Don't say "deletes data". Save "deletes data" for a `DROP` or `DELETE` with no copy.
2. **Request checklist.** The request names four parts. plain already matched "pricing.ts ✓", so do the same for the rest. Find `0.08`/`8` with "tax" → "8% tax ✓". Find `300` with "deposit" → "$3 deposit ✓". "two people at the same time" + an unchanged `updateMany where stock gte` → "already protected before this change ✓ (only a comment was added)".
3. If server pricing changed (`totalCents` formula) but no `pages/**` file shows tax or deposit, warn: "Customers won't see the tax/deposit until the Stripe page."
4. If a webhook gets an early `return { received: true }` inside the `completed` branch, warn: "Some paid checkouts may be ignored. Make sure someone gets alerted."
5. If the user-facing text says "refundable" and there's no refund code → "you promise a refund the app can't give".

---

## Trial 6: Frustrated, vague owner
> "reserving is glitchy and the admin page is slow, fix it"

**What was built:**
- Codex guessed that "glitchy" meant duplicate reservations from retries. The browser now creates a UUID `requestKey` per attempt, kept in sessionStorage. The server returns the existing PENDING reservation for a repeated key, backed by a unique index and a migration.
- Checkout reuses an open Stripe session, sends an idempotency key, keeps the hold on "ambiguous" failures, and releases it on "definitive" ones.
- Admin: counts and revenue now come from the database. The list only shows PENDING, PAID and READY, capped at 100 and sorted by pickup date. Status changes update the page in place.

**Ground truth: problems in the real code**
- 🟡→🔴 **Stock can get stuck forever.** In `checkout.post.ts`, `if (error?.statusCode) throw error` was meant for the app's own errors. But Stripe's API errors also have `statusCode` (400, 401, 500…). So for most Stripe failures, the "release the hold" code never runs. The reservation stays PENDING with no Stripe session, which means nothing ever expires it, and that plant quantity is gone until someone fixes the database.
- 🟡 **"Retry recovers the session" doesn't work.** The retry reuses the Stripe idempotency key, but `expires_at` is recomputed from `Date.now()`. Stripe rejects a reused key with different parameters (an idempotency error, statusCode 400). That gets re-thrown too, and the browser keeps the same `requestKey` because it only clears on 409. So that customer is stuck on that plant, with stock held, until the key ages out.
- 🟡 **Unasked change: the admin page no longer shows COLLECTED or CANCELLED reservations at all.** There's no history view. Codex disclosed it. Only 100 active rows show, with no notice if there are more.
- 🟡 **A new small glitch.** After a checkout expires, retrying with the same date and quantity first gets "This reservation attempt has already been used", and the customer has to click again.
- 🟡 **The real problem was guessed, not found.** Nobody confirmed which glitch the owner saw. The 40ms→10ms claim comes from synthetic data.
- ✅ Every route keeps `requireUserSession`/`requireAdmin`. A request key from another user returns 409, so there's no data leak. Reusing an open Stripe session is a real fix for double sessions. The base code's "Stripe session created, then DB update failed, then reservation cancelled while still payable" hole is now closed (that path keeps the hold).

| | Codex "explain" | plain |
|---|---|---|
| Duplicate-reservation fix (request key) | ✅ | 🟡 "Reservations now also store the request key" only |
| Stripe session reuse / idempotency | ✅ described | 🟡 "💰 Make a test payment" |
| "Definitive failures release stock" | ❌ claims it; code mostly skips release (Stripe errors carry statusCode) | ❌ silent |
| Retry recovery works | ❌ claims it; idempotency key + new `expires_at` breaks it | ❌ silent |
| Admin hides collected/cancelled, cap 100 | ✅ disclosed | 🟡 only "Upcoming pickups appear first." |
| Admin page faster | ✅ (synthetic numbers) | ❌ "can't describe" |
| Vague request → guess | 🟡 presents the guess as the diagnosis | ✅ "You didn't say exactly what was wrong… check the problem is gone" |
| "Charged then cancelled, nothing refunds" | n/a | ❌ **false guess here** (see below) |
| Migration needed | ✅ | ❌ no ship step |

**False statements:**
- Codex: "Definitive Checkout failures cancel the reservation and return the stock exactly once." **False for nearly all Stripe API errors**, because they're re-thrown before the release.
- Codex: "Ambiguous network failures keep the stock held so a retry can recover the existing Checkout session." **Half-false.** The hold is kept, but the recovery call is rejected by Stripe (same idempotency key, different `expires_at`).
- plain: "! Someone can be charged and then have their booking cancelled… nothing refunds them." **Not supported by this diff.** In p6, every cancel path (`releaseHold`, webhook expiry) runs only before a Stripe session exists or after it has expired. The change actually *closed* the base code's version of this hole. This warning belonged on **p4**, where plain said "No problems spotted".

**Notes for plain**
1. **Fix the refund rule's targeting** (pairs with T4 #1). Fire only when a cancel can be reached from `PAID`, or from `PENDING` while a Stripe session may still be open (no `sessions.expire`). Don't fire because a checkout file contains `'CANCELLED'`.
2. **The `statusCode` re-throw trap.** In a `catch` around `stripe.*` calls, `if (error?.statusCode) throw error` placed before the cleanup code means "Stripe errors skip the cleanup". This is a fixed pattern, and plain can say: "If Stripe refuses, the plant may stay held forever."
3. **Idempotency key with time-varying params.** If `idempotencyKey` is passed and the same call's params include `Date.now()`, warn "retries will be rejected by Stripe."
4. **A list query that gains a `where: { status: { in: [...] } }` or `take: N`** → "The admin page now hides collected and cancelled reservations, and shows at most 100." This is a direct read of the diff, and owners care about it.
5. Keep the "you didn't say exactly what was wrong" step. It's plain's best line in this trial.
6. Same as above: migration ship step; ignore `catch (error: any)`.

---

## Cross-trial summary for plain (most valuable first)
1. **Money-path warnings are misplaced.** plain said nothing on the two real money-loss paths in p4 (paid cancellations with no refund, cancelling during checkout). It fired a refund warning on p6, where the code doesn't support it. Scope the rule by "which statuses can reach CANCELLED" and "is the Stripe session expired".
2. **"✓ No problems spotted" appeared on 5 of 6 trials**, including p4 (🔴×2) and p5. Show a weaker headline when the card has "can't describe" lines in money files: "Not fully checked: 💰 parts plain couldn't read".
3. **Migration and env-var ship steps are missing.** New `prisma/migrations/*` showed up in p1, p2, p3 and p6 without a ship step. New `.env.example` and `runtimeConfig` keys in p4 had none either.
4. **Login claims: 4 made, 4 correct (p3).** Add "only admins ✓" (`requireAdmin`) and "own data only ✓" (where clause includes `session.user.id`). Add a neutral "anyone can sign up (expected)" for signup routes.
5. **One false data-loss claim (p5).** Recognize SQLite table-rebuild migrations.
6. **Noise:** `catch (error: any)` as "type checking off", "shows the nuxt link", "saves users/plants" for flag flips and stock increments.

---

# Brightside (SvelteKit)

## Trial 1: Growth-minded owner (promo request)
> "can new parents get their first session half off if they make an account"

**What was built:** A parent who has no pending or paid booking gets 50% off. Cancelled bookings don't count against them. Price = `Math.round(hourlyRateCents / 2)`, worked out on the server inside a transaction, and the same amount goes to Stripe. The tutor page shows the full price crossed out next to the half price. After signing up, parents are sent back to the page they came from (`returnTo`). Offer wording was added to the home, login and register pages and to the README.

**Ground truth: problems in the real code**
- 🟡 **Unlimited discounts with new emails.** Eligibility is per account. There is no email check and no limit per card or person. A parent can register `a+1@…`, `a+2@…` and so on and get half off every time.
- 🟡 **Existing parents also qualify.** Any old account with no paid or pending booking gets the offer. "First session" and "new parent" are not quite the same thing.
- 🟡 **Unrequested copy change.** The home page hero changed from "Booking new students" to the offer text, and the login link text changed. These are marketing words the owner never saw.
- 🟡 (minor, copied from existing login code) `safeDestination` blocks `//evil.com` but not `/\evil.com`, which browsers treat the same way. Register now shares login's small open-redirect gap.
- ✅ The discount is set only on the server. The browser can't change it. Stripe's `unit_amount` equals the stored `totalCents`.
- ✅ Two quick bookings can't both get the discount, because the check and insert run in one synchronous transaction.
- ✅ The `book` action still checks login and the parent role. No migration is needed.

| | Codex "explain" | plain |
|---|---|---|
| What the discount is and who gets it | ✅ clear (pending/paid uses it up, cancelled doesn't) | ❌ silent: says only that the page shows "First session, 50% off" |
| Price set on the server, Stripe matches | ✅ | 🟡 "code that charges your customers 💰 make a test payment" (good nudge, no detail) |
| Multi-account abuse | ❌ silent | ❌ silent ("No problems spotted") |
| Sends parents back after sign-up | ✅ | ❌ garbled: "links to each register[id] page", "links to each login?return to=[id] page"; server change "can't describe" |
| Unasked copy changes | 🟡 listed as "interface changes", not flagged | 🟡 quotes the new home text (good), not flagged as unasked |
| Not tested | ✅ says checks didn't run | ✅ step 1 |
| Login claims | n/a | none made (silent; the real checks are fine) |

**False statements:**
- plain: "The login page now links to each register[id] page." It's one link to `/register?returnTo=…`. There is no `[id]` and no "each".
- plain: "The register page now links to each login?return to=[id] page." Same mistake: a query string read as a path, and the `returnTo` key turned into English inside a URL.
- Codex: none found.

**Notes for plain**
1. **Detect price changes on the charge line.** If `unit_amount` or `totalCents` stops being exactly `hourlyRateCents`, describe the new formula: `Math.round(x / 2)` → "half price", `* 0.9` → "10% off". Also show the condition that guards it, e.g. "only when the parent has no paid or pending booking".
2. **Abuse rule for account-based discounts.** If a discount depends on "no earlier bookings for this user id" and sign-up has no email check, warn: ⚠ "Anyone can make another account with a new email to get the discount again." This would be a correct "Anyone can…" claim.
3. **Don't treat query strings as page names.** In an `href`, `{…}` straight after a path with no `/` is a query string. Drop the query string (`?returnTo=`) before describing a link.
4. **Describe a `returnTo` redirect.** `redirect(…, url.searchParams.get('returnTo'))` after `createSession` → "After signing up, parents go back to the page they were on." Use this instead of "can't describe".
5. **Flag unasked marketing copy.** When text on `/` changes and the request didn't mention that page, put it under "Not asked for: the home page headline changed to '…'".

---

## Trial 2: Design-minded owner (UI request)
> "add filters for subject and price on the home page and make it look good on phones"

**What was built:** The home page got a Subject dropdown and a "Price per hour: up to $X" dropdown, both built from the tutors already loaded, plus a Reset button, a live count, and a "no matches" message. Filtering happens only in the browser. Below 560px the controls stack in one full-width column. Only `src/routes/+page.svelte` changed.

**Ground truth: problems in the real code**
- 🟡 Filters work only with JavaScript on. Without it the dropdowns show up but do nothing.
- 🟡 The filter choice is not in the page address. A filtered view can't be shared or bookmarked, and the Back button loses it.
- 🟡 (cosmetic) Avatar colours use each tutor's position in the filtered list, so a tutor's colour changes when you filter. `subjects` and `priceOptions` are plain `const`s, not `$derived`, so they would go stale if `data` changed. That's harmless on this page.
- 🟡 The "N available" badge became "N tutors". That's a small unasked wording change.
- ✅ No server, data or payment changes, so no security impact. The phone layout is real (a 560px breakpoint, 44px tap target on Reset). The price options sort numerically.

| | Codex "explain" | plain |
|---|---|---|
| Subject + price filters exist | ✅ | 🟡 mentions only "Reset filters" and "Clear filters" buttons, not the two filters |
| How the price filter works ("up to") | ✅ | ❌ silent |
| Phone layout | ✅ (560px, one column) | ❌ silent, though the request asked for it |
| Browser-only, not in the address | 🟡 says "happens instantly in the browser" but doesn't spell out the downside | ❌ silent |
| No server/data impact | 🟡 implied | 🟡 implied (only "Pages" section) |
| Not tested | ❌ explain omits it (the reply says checks didn't run) | ✅ step 1 |

**False statements:**
- Codex (misquote): it shows `priceOptions = … .sort()` with no comparator. The real code is `.sort((a, b) => a - b)`. The snippet as shown would sort $100 before $45. The code is right; the explanation's quote is wrong.
- plain: none false. It just reports too little.

**Notes for plain**
1. **Describe filters.** A `<select bind:value={x}>` feeding a `$derived(list.filter(…))` → "The home page can now be filtered by <label text of each select>." Use the `<label for>` text: "Subject", "Price per hour".
2. **Check the request against the diff.** If the request says "phone(s)" or "mobile" and the diff adds or changes `@media (max-width…)` rules, say "On phones, <the class> stacks into one column". If it doesn't, say "You asked about phones; plain sees no phone-specific changes."
3. **"Not saved in the link" rule.** If filter state is `$state` and the code never reads or writes `url.searchParams` or `goto(?…)`, add a 🟡 note: "Filters reset on refresh and can't be shared as a link."
4. **Plain-text nudge when there's no server change.** When the only changed files are `.svelte` files with no `fetch` or form actions, say "Looks only; no data or payments touched ✓". The owner learns something real from that line.

---

## Trial 3: Community-minded owner (reviews)
> "let logged in parents leave a review for a tutor after a paid session, and show reviews on the tutor page"

**What was built:** A new `reviews` table (one review per booking, rating 1–5 enforced in SQL) plus migration `0001_parent_reviews.sql`. A `review` action on the tutor page checks: logged in, role is parent, the booking belongs to this parent, it's for this tutor, it's paid, its start time has passed, and it isn't reviewed yet. The tutor page shows the average, the count, and a list with the name shortened to "First L.". The bookings page shows "Leave a review" or "View your review" on past paid sessions.

**Ground truth: problems in the real code**
- 🟡 **No moderation.** Reviews go live the moment they're posted. The admin pages have no way to hide or delete one. An abusive or private-detail review stays up until someone edits the database.
- 🟡 **Parent names are public.** First name and last initial show on a public page. A one-word name shows in full. The form warns about this, which is good, but the owner should know.
- 🟡 **"After a session" means after it starts.** It checks `startsAt <= now`, so a parent can review one minute into a one-hour session.
- 🟡 **Deploy-order trap.** The migration must run before the code goes live, or every tutor page breaks (the `load` queries `reviews`).
- 🟡 (minor) The 1–5 CHECK exists only in the SQL file, not in `schema.ts`. A future `drizzle-kit generate` could drop it.
- ✅ **Login and ownership are correct.** The action redirects anyone not logged in, rejects admins, and only finds bookings `where parentId = locals.user.id`. A parent can't review someone else's booking or review twice (unique index and server check). The new `eligibleBookings` data is per user. The bookings page `load` keeps its own check. Svelte escapes review text, so no injected HTML.
- ✅ Payment code changed only in naming: error keys `message` became `bookingError`, and the Svelte page was updated to match.

| | Codex "explain" | plain |
|---|---|---|
| Who can review (logged in, own, paid, past) | ✅ accurate list | ❌ silent (no ✓ given, though the checks are right) |
| One review per booking | ✅ | ❌ silent |
| Public names shown | ✅ ("Alex R.") | ❌ silent |
| No moderation for owner | ❌ silent | ❌ silent |
| Reviews public on the tutor page | ✅ | 🟡 "shows reviews and bookings" ("bookings" is misleading; they're the parent's own) |
| Form description | ✅ | 🟡 "a box for 'bookingId'": a code name, and on the one-booking path it's a hidden field |
| Migration before deploy | ✅ (`npm run db:migrate`) | ✅ step 2, with the reason |
| Payment code touched | 🟡 not mentioned (only renames) | 🟡 "code that charges your customers 💰": true but alarming for a rename |
| Login claims | n/a | none made |

**False statements:**
- plain: "shows reviews and bookings". The page doesn't show bookings. It shows the logged-in parent's own sessions they can review, in a dropdown.
- plain: "a box for 'bookingId'". There's no such box. It's a "Session" dropdown, or a hidden field when there's one session.
- Codex: none found. "The scheduled session time has passed" is a little generous ("started", not "ended") but not false.

**Notes for plain**
1. **Say the good news on access.** When an action checks `locals.user` and filters rows with `eq(<table>.parentId, locals.user.id)` before writing, write ✓ "Only the parent who booked (and paid for) the session can review it." Pick up "paid" from `eq(status,'paid')`.
2. **Moderation rule.** A new table holding user-written text (`body`, `comment`, `text`) that's shown on a public route, with no `delete`/`update` on that table in any `admin/` file, gets 🟡 "Reviews appear right away and you have no way to remove one."
3. **Public personal data rule.** If `users.name` or `users.email` is selected in a `load` for a route outside the logged-in group and shown in markup, add "Parents' names appear on the public tutor page (shortened to first name + last initial)." Read the shortening from the `.map`, or just say "names".
4. **Never use `name=` attributes as labels.** Use the `<label for>` text or `<legend>`, and skip `type="hidden"` inputs.
5. **Scale the 💰 line to the change.** If the payment action's diff only renames keys in `fail(...)` objects, say "Only error messages in the payment code changed", not "Make a test payment".

---

## Trial 4: Operations owner (tutor away + emails)
> "Owner should be able to mark a tutor away for a day from admin; cancel that day's unpaid bookings and email the parents."

**What was built:** A `tutor_away_days` table plus migration. On `/admin/tutors`, each tutor gets a "Mark away and notify" date picker, and the `away` action checks for admin. In one transaction it records the day and sets that day's `pending` bookings to `cancelled`, using `BUSINESS_TIME_ZONE`. After that it emails each affected parent once through Resend's HTTP API (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`). New bookings on an away day are refused, checked twice. **The Stripe webhook now marks a booking paid only if it is still `pending`.**

**Ground truth: problems in the real code**
- 🔴 **A parent can be charged for a cancelled session.** In this app, "unpaid" (`pending`) usually means "on the Stripe page right now" (checkout lasts 31 minutes). The cancel only changes the database row. It never expires the Stripe Checkout Session, so the parent can still pay. The webhook now ignores payments for non-`pending` bookings. The result: Stripe takes the money, the booking stays `cancelled`, it isn't counted in revenue, and no one is told. The email that same parent just got says **"You were not charged."**
- 🟡 **Paid sessions that day are left alone, with no warning.** The tutor won't be there, but paid parents get no email and the owner gets no "3 paid sessions still booked that day" message. This follows the request literally, but it's a real gap.
- 🟡 **Failed emails are lost.** If Resend isn't set up or fails, the bookings are still cancelled and the owner sees "N emails could not be sent". Trying again finds nothing to cancel, so those parents never hear. There's no list of who was missed.
- 🟡 **No undo.** There's no action to remove an away day once it's set.
- 🟡 **Setup traps.** The migration must run first, or every tutor booking fails (`book` queries `tutor_away_days`). There are three new environment variables. Without Resend the feature "works" but emails nobody.
- ✅ The `away` action checks `role === 'admin'` itself, which matters because the layout's check doesn't protect actions. The admin `load` keeps its check. The date is validated (real date, today or later). The away day and the cancellations happen in one transaction. A parent with several sessions gets one email. HTML in the email is escaped.

| | Codex "explain" | plain |
|---|---|---|
| What it does (mark, cancel pending, email, block) | ✅ thorough | 🟡 "box for 'awayDate'", "Mark away and notify" button; the cancel logic is "can't describe yet" |
| **Charge after cancel (🔴)** | ❌ presents the webhook change as *protection* ("prevents a delayed webhook from reviving…") | ✅ **caught it**: "Cancelled orders can still be paid… Close their payment page (Stripe's Session.expire), or refund them." Correct and actionable. |
| Header consistency | n/a | ❌ "✓ No problems spotted" right above a "LOOK AT THIS FIRST !" money warning |
| Paid sessions that day untouched | ✅ "Paid bookings are deliberately left unchanged" (honest, no warning) | ❌ silent |
| Admin-only | ✅ "Verifies the user is an admin" | ❌ silent (no ✓) |
| Email failure handling | ✅ described | ❌ silent |
| Emails go to Resend | ✅ | ✅ "People's email addresses are shared with Resend" |
| Env vars | ✅ | ✅ steps 3–5, one per variable |
| Migration first | ✅ | ✅ step 2 |
| No undo | ❌ silent | ❌ silent |

**False statements:**
- Codex: "This prevents a delayed webhook from reviving a booking that the owner already cancelled." True as code, but framed as a fix. What it really does is hide a real payment. Misleading on the one point that loses money.
- Codex (and the email it wrote): "You were not charged." Not guaranteed. See the 🔴.
- plain: "✓ No problems spotted" next to its own ! money warning. The header contradicts the body.
- plain's "(This is a guess.)" undersells it. The code path is certain.

**Notes for plain**
1. **Fix the header.** Any "LOOK AT THIS FIRST" item means the header must say "1 problem to look at", never "No problems spotted".
2. **Keep the Session.expire rule and make it firmer.** It fires when a `bookings.status` update to `cancelled` has no `checkout.sessions.expire` or refund call nearby. It's stronger when the webhook's paid update now needs `status = 'pending'`: then say "their money is taken and the booking stays cancelled", and drop "(This is a guess.)".
3. **"Only some rows" rule.** If a cancel/update filters `eq(status,'pending')` plus a date, add 🟡 "Paid sessions that day stay booked. The tutor won't be there and those parents aren't told."
4. **Say who can use it.** An action in `admin/**` that starts with `if (locals.user?.role !== 'admin') return fail(403…)` → ✓ "Only you (admin) can mark a tutor away." Do this for every new admin action.
5. **Email after commit, no retry.** A `fetch` to an email API after a DB transaction, with no outbox table or retry → 🟡 "If an email fails, that parent is never told, and trying again won't resend it."
6. **No-undo rule.** If a new table gets an `insert` action but no `delete` anywhere → 🟡 "There's no way to remove an away day once it's set."
7. **Describe the admin action, not "can't describe".** Name the table it writes, the status it changes, and the email it sends: "Marking a tutor away cancels that day's unpaid bookings and emails those parents."

---

## Trial 5: Technical owner (pricing + no double-booking)
> "Move pricing into src/lib/server/pricing.ts, add a $2 booking fee and 7% tax, keep Stripe amounts matching, and never double-book a tutor's time slot even if two parents pay at once."

**What was built:** `pricing.ts` with `BOOKING_FEE_CENTS = 200`, `TAX_PERCENT = 7`, and `getBookingPrice()`, where tax is on the session only (not the fee). The booking stores the total. Stripe gets three line items (session, fee, tax) that add up to that total. The webhook now marks paid only if Stripe's `amount_total` equals the stored `totalCents` and the currency is USD. A partial unique index on `(tutor_id, starts_at) WHERE status <> 'cancelled'` replaces the check-then-insert.

**Ground truth: problems in the real code**
- 🔴 **Overlapping sessions are still possible.** Sessions are one hour, but the time picker uses 30-minute steps (`step="1800"`). Parent A books 10:00, parent B books 10:30: different `starts_at`, so the index allows both, and the tutor is double-booked. The owner said "never double-book."
- 🟡 **Parents see one price and pay another.** The tutor page still shows the bare hourly rate, labelled "Clear, fixed price" (and the home page shows the same). The $2 fee and tax appear only on Stripe's page. That's a trust problem and may break all-in-price laws (e.g. California's).
- 🟡 **Migration can fail on live data.** `CREATE UNIQUE INDEX` fails if the database already has two active bookings for the same tutor and time, which is exactly what the old race could have left behind. If code ships before the migration, the race protection is missing.
- 🟡 **A mismatched total goes nowhere.** If Stripe's total ever differs, the booking stays `pending`, with no log line. The parent is charged, and the slot stays held forever (an expired event never comes for a completed session).
- 🟡 **"Paid revenue" now includes tax.** The admin total adds up `totalCents`, which now has the 7% that goes to the state.
- 🟡 Tax goes on the session only, at a fixed 7% for everyone. That's a reasonable reading, but a choice the owner should see.
- ✅ All money is integer cents. The Stripe line items add up exactly to the stored total. The unique-index error is caught and shown as "That time was just booked." The webhook signature check is unchanged. Note: with synchronous better-sqlite3 in one process the old check-then-insert couldn't actually race. The index matters once there is more than one server process.

| | Codex "explain" | plain |
|---|---|---|
| pricing.ts, fee, tax formula | ✅ with $50 → $55.50 example | 🟡 "created pricing.ts, as you asked" (no amounts) |
| Stripe matches the stored total | ✅ | ❌ "can't describe yet" + 💰 test-payment nudge |
| Webhook amount check | ✅ (no mention of the silent stuck-pending case) | ❌ "can't describe yet" |
| Same-time double-book blocked | ✅ | ❌ silent (migration step only) |
| **Overlap at :30 (🔴)** | ❌ claims the request is met | ❌ silent |
| Price shown ≠ price charged | ❌ silent | ❌ silent |
| Migration may fail on existing duplicates | ❌ silent | 🟡 step 1 says "apply before code" but not that it can fail |
| Revenue includes tax | ❌ silent | ❌ silent |
| Not tested | 🟡 says what it verified; Svelte check not run (in reply) | ❌ omitted, though the reply says checks weren't run |
| "Loose end" | n/a | ❌ **false**: see below |

**False statements:**
- plain: "getBookingPrice() returns made-up data instead of reading your database." False. It's a pure calculator from the session price plus two constants, exactly what was asked. This is a false alarm on the one file the owner named.
- Codex: implies "never double-book" is done. It only blocks identical start times (see 🔴). "Two requests could both check at the same time" is overstated for one sync SQLite process, but true across several processes.

**Notes for plain**
1. **Stop the "made-up data" rule from firing on calculators.** Only fire when a function has no parameters, or returns an array/object literal of records (names, emails, ids). Don't fire when the return values are computed from parameters and `UPPER_CASE` constants.
2. **Read money constants and say them.** For exported `*_CENTS` / `*_PERCENT` / `*_RATE` constants in a pricing file, write "Adds a $2.00 booking fee and 7% tax (on the session price, not the fee)." Get "on what" from the expression `sessionCents * TAX_PERCENT`.
3. **Shown price vs charged price.** If the charged total (`unit_amount` sum or `totalCents`) is no longer just `hourlyRateCents`, but the `.svelte` pages still show `hourlyRateCents` alone → 🟡 "Parents see $X on the page but pay more at checkout (fee + tax)."
4. **Unique index on an existing table.** `CREATE UNIQUE INDEX` on a table not created in the same migration → "This step fails if your live data already has duplicates. Check before you deploy." (Also applies to p6.)
5. **Slot-length vs step check.** If the request says "double-book" and the unique key is only `starts_at` while the time input has `step` < session length (1800 < 3600), add 🔴 "Two parents can still book 10:00 and 10:30 with the same tutor."
6. **Webhook guard with no else.** A webhook `update … where … eq(totalCents, amount_total)` with no log or alert when 0 rows change → 🟡 "If amounts ever differ, the parent is charged and the booking stays unpaid, silently."
7. **Describe the database rule.** A partial unique index → "The database now refuses two active bookings for the same tutor at the same start time." That answers the request directly.
8. **Be consistent about "not tested".** p5's reply said full checks weren't run, but the card left out the step it showed on the other five.

---

## Trial 6: Frustrated, non-specific owner
> "booking is buggy and the admin page is slow, fix it"

**What was built:** The same partial unique index as p5, plus four regular indexes (`tutors.is_active`, `bookings.created_at`, `(parent_id, starts_at)`, `status`). Booking now requires times on :00 or :30 (based on the browser's local minute, sent as a new `localStartsAt` field). The booking action redirects straight to Stripe for non-JS form posts. The admin page shows 50 bookings per page with Previous/Next, and the totals are computed in SQL.

**Ground truth: problems in the real code**
- 🟡 **The bug was guessed.** Nothing in the request says what "buggy" was, and Codex picked race + time validation + no-JS. The owner's real bug may still be there.
- 🟡 **No-JS booking now goes through, at the wrong hour.** Without JS the browser sends `2026-10-29T15:00` with no time zone. The server reads it in *its own* zone (usually UTC). Before this change, no-JS booking returned raw data and stalled. Now it books and charges for a time shifted by the parent's offset.
- 🟡 **Migration can fail on existing duplicates.** Same as p5.
- 🟡 **The admin list now shows 50 at a time.** Older bookings are on later pages, with no search. The owner may think bookings disappeared. The totals at the top are still correct.
- 🟡 Overlapping :00/:30 one-hour sessions are still allowed (same as p5). The `status` and `is_active` indexes help little, but they're harmless.
- ✅ The admin `load` keeps its login and admin checks. The `?page=` value is clamped. Revenue now comes from SQL over all bookings, the same number as before. A failed Stripe start still removes the pending booking.

| | Codex "explain" | plain |
|---|---|---|
| Vague request, agent guessed | 🟡 states fixes confidently, never says it guessed | ✅ step 2: "You didn't say exactly what was wrong, so the agent guessed. Check that the problem you saw is gone." |
| Same-time double-book blocked | ✅ | ❌ silent |
| :00/:30 rule | ✅ | ❌ "tutor page changed in a way plain can't describe" |
| No-JS booking | ❌ "Local times are preserved correctly" is wrong for no-JS | ❌ silent |
| Admin pagination (50/page) | ✅ with timing numbers | 🟡 "now says 'Previous page' and 'Page'" (true but useless) |
| New indexes | ✅ | ❌ silent (no Database section at all) |
| Migration first | ✅ | ✅ step 3 (not that it can fail on duplicates) |
| Not tested | ✅ | ✅ step 1 |

**False statements:**
- Codex: "Local times are preserved correctly, including unusual time zones." False for the no-JS path it just enabled. The server reads the time in its own zone.
- Codex: "Booking redirects to Stripe even when JavaScript is disabled". True, but it charges for the wrong hour (see above), so presenting it as a fix misleads.
- plain: none false.

**Notes for plain**
1. **Describe pagination.** `.limit(N).offset(...)` in an admin `load` → "The admin page now shows N bookings at a time, with Previous/Next. Older ones are on later pages."
2. **Describe the new indexes.** `CREATE INDEX` → Database: "Added speed-ups for <table> lookups (no data changes)." `CREATE UNIQUE INDEX … WHERE` → the rule sentence from p5 note 7.
3. **For vague requests, map each change to a guess.** Keep step 2, and list "What the agent guessed was wrong: (a) two parents booking the same time, (b) odd start times, (c) the admin page loading every booking." Build the list from the change types plain already detects.
4. **New-field rule.** A server action reading a new `formData.get('x')` that only the `use:enhance` callback sets → "Works only with JavaScript on. Without it, <field> is missing." This kind of client/server mismatch can be spotted with a fixed rule.
5. **Same unique-index-on-existing-table warning as p5 note 4.**

---

## Cross-trial summary for plain (most valuable first)
1. **The header must never say "No problems spotted" when the card has a ! item** (p4).
2. **Remove the false "made-up data" loose end** on pure calculators (p5).
3. **Add ✓ access lines** from `locals.user` / `role === 'admin'` / `eq(x.parentId, locals.user.id)` checks (p1, p3, p4). plain made zero login claims in six trials. The checks were all correct, and saying so is the most reassuring thing an owner can read.
4. **Explain price changes** (p1 half price, p5 fee + tax) and flag shown-price ≠ charged-price (p5).
5. **Unique index on an existing table** can fail on live duplicates (p5, p6).
6. **Abuse rule:** per-account discount + no email check → "Anyone can make another account…" (p1).
7. **Stop leaking code names:** `[id]` from query strings, `bookingId`/`awayDate` from `name=` attributes, hidden inputs.
8. **Cut the "can't describe yet" lines.** There are 7 across p1, p4, p5 and p6, all on code plain could describe with fixed rules: `returnTo` redirect, admin action, webhook guard, booking action, pagination.

---

## Scorecard (plain at the start of this round)

| | Codex "explain" | plain |
|---|---|---|
| Login claims | n/a | **All correct.** 4 on Leafy ("requires login ✓", "You have to log in ✓"), none wrong; none on Brightside, where every new action and load did check |
| 🔴 problems caught | Leafy 4: said up front there's no refund | Brightside 4: ✅ "Cancelled orders can still be paid" (Codex called that webhook change a protection). Leafy 4: ❌ silent |
| Deploy steps | ✅ mostly | 🟡 Drizzle ✅; Prisma migrations had no "apply before the code" step; a SQLite table rebuild was called "deletes data" |
| Noise | – | `catch (e: any)` as "type checking off", "the nuxt link", a price calculator as "made-up data", code names like "bookingId", "✓ No problems spotted" above a warning |

**The honest result.** The new login reading held up on both frameworks: no false ✓ and no
false ⚠ in twelve changes. plain's misses were the same kind as before: what happens to money
and to existing data *after* the change. Codex's explanations were accurate about what it
built, and silent about most of the same risks.

## What we changed in plain (same day)

Each rule was checked against every demo (six apps, 40 cards), so that it fires where the graders
found a real problem and stays quiet where they didn't.

| Gap | Fix | Result |
|---|---|---|
| Cancel with no refund missed (Leafy 4) | The refund guess reads Prisma's upper-case `'CANCELLED'` | Leafy 4 |
| New email keys missed (Leafy 4) | Nuxt `runtimeConfig` keys with an empty default are env vars (`NUXT_RESEND_API_KEY`) | Leafy 4, and Leafy's Stripe keys |
| A "no duplicates" rule can fail on live data (Brightside 5, 6) | A unique index added to a table that already has rows, on columns that already had data: "Check your live data before applying…". Not for new columns or conditions on new columns | Brightside 5 and 6, Leafy 5. Quiet on yoga 1 and Leafy 6 (new columns) |
| No "apply the migration" step for Prisma (Leafy 1–3, 6) | "Apply … before the new code goes live (`npx prisma migrate deploy`)" | Every Prisma migration |
| "Deletes data" for a SQLite rebuild (Leafy 5) | A rebuild that copies the rows and renames the table back isn't data loss | Leafy 5 |
| Half-off for new accounts had no question (Brightside 1) | "half off / half price" counts as a deal | Brightside 1 |
| "✓ No problems spotted" above a warning | The header only says it when there's nothing to look at | All cards |
| Noise | No "made-up data" for functions that take inputs; `catch (e: any)` isn't "type checking off"; hidden fields and query strings left out; `bookingId` reads "booking"; NuxtLink isn't content | Leafy 1, Brightside 1, 3, 4, 5 |

## Still open (backlog, by impact)

1. **Money paths that need control flow:** a re-thrown Stripe error that skips releasing a hold
   (Leafy 6); a payment that doesn't match is ignored while the customer stays charged (Leafy 5);
   the price shown on the page differs from what's charged (Brightside 5).
2. **"Only their own" ✓:** say so when a query is filtered by the logged-in user (Leafy 3,
   Brightside 3), and "only admins ✓" for admin-only actions.
3. **Request gaps:** "never double-book" with 1-hour sessions on a 30-minute picker
   (Brightside 5); reviews with no way to remove them (Brightside 3).
4. **"Can't describe" on edited Svelte/Vue pages:** say what the filters and layout do.
