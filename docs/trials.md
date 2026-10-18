# Trials: plain vs. "Explain me what u did and how?"

Six personas ask Codex for a feature in the bracelet shop (`examples/bracelet-shop`, each on its own
branch from `dashboard`). For each one we record:

1. **Codex's own reply** after building it.
2. **Codex's answer** to "Explain me what u did and how?"
3. **plain's output** on the same change.
4. **Ground truth** from reading the actual changes.

Then we compare what each one got right or wrong, and what each one left out.

| # | Persona | Prompt |
|---|---|---|
| 1 | Non-technical shop owner | "can people get like 10% off if they sign up for my newsletter" |
| 2 | Student, first project | "add a search bar so ppl can find bracelets and make it look good on phones" |
| 3 | Knows the basics | "add a wishlist where logged in users can save bracelets, save it in the database" |
| 4 | Junior developer | "Add order status management: admin can mark orders shipped or cancelled via an API route, and email the customer with Resend." |
| 5 | Experienced developer | "Move pricing into lib/pricing.ts, add 8.25% sales tax to totals, keep Stripe amounts in sync, and decrement stock in the webhook when an order is paid." |
| 6 | Vague and frustrated | "checkout is kinda broken sometimes, fix it and make it faster" |

---

## Trial 1: Non-technical shop owner

> "can people get like 10% off if they sign up for my newsletter"

**What was built:** a newsletter signup box on the home page → `POST /api/newsletter` → creates a
Subscriber **and a new single-use 10% Coupon in the same database save** → shows the code on
screen. Plus an admin Subscribers page (login required) and a new menu link.

**Ground truth: problems in the real code**
- 🔴 **Unlimited coupons for anyone.** Every new email gets a fresh 10% code, and fake emails cost nothing.
- 🔴 **Someone else's code leaks.** Typing an existing subscriber's email returns *their* code.
- 🟡 No email is sent, so the code only appears on screen.
- 🟡 Needs a database migration.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ clear step-by-step flow | ✅ pages, server, database, all correct |
| Unlimited coupons | ❌ presents the duplicate-email check as protection | 🟡 "anyone can post subscribers… spam or fake subscribers", but **missed that each signup creates a coupon** |
| Someone else's code leaks | ❌ | ❌ |
| No email sent | ✅ | ❌ |
| Migration needed | ✅ | ✅ (with the exact command) |
| Unasked changes | — | ❌ **false positive**: AdminNav "unrelated" (it's the Subscribers link) |
| Written for this user | ❌ says `auth()`, "Prisma client", "model" to a shop owner | ✅ mostly plain words |

**Notes for plain**
1. **Catch database saves nested inside other saves.** `subscriber.create({ data: { coupon: { create } } })` also writes Coupon. With that, the risk becomes **Unsafe** (coupons are sensitive): "anyone can get unlimited coupons".
2. **Fix the "unasked" heuristic.** A change is related if it mentions something *new in this same change* (a new page address, table or component), not just words from the prompt.
3. **Don't count guesses in the red "N problems" verdict.** Count them as things to check.
4. **"a box for 'you@example.com'"** should be "an email signup box". Use the input's `type`/`name`, not just its placeholder.
5. **Missing pieces matter as much as present ones.** "Newsletter", but no email service is set up. Rule idea: the request mentions email or a newsletter, and no email package or service appears in the code.

**Setup finding:** the first "explain" answer came from the go-between agent, which had **never read the code**. It summarized every session since the beginning and missed all the risks. In real use, people often ask the outer chat agent "what did you do?", and that agent may only know what the sub-agent told it. plain reads the code itself.

---

## Trial 2: Student, first project

> "add a search bar so ppl can find bracelets and make it look good on phones"

**What was built:** one file changed (`app/page.tsx`). A GET form puts the search in the address
(`/?q=blue`), the page filters products with `where: { name/description contains q }`, shows a
results count and a no-results message, and the controls stack full-width on phones.

**Ground truth: problems:** none worth flagging. Low risk.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ excellent, step by step, teaches the "why" (server-rendered, shareable links) | ❌ "a box and a Search button, links to the home page". Never says *search* |
| Mobile layout | ✅ specific (stacking, 48px tap targets) | ❌ invisible |
| Reassurance it's safe | 🟡 says "I changed only app/page.tsx" (true, but you have to trust it) | 🟡 implied by the short output, never said |
| Written for this user | ✅ ideal for a student | ✅ plain, but too thin |

**Codex wins clearly** on a small, low-risk UI change. Its explanation *teaches*.

**Notes for plain**
1. **Read search and filter logic.** `findMany({ where: { name: { contains: q } } })` → "filters bracelets by name and description".
2. **Read the page address.** `searchParams.q` → "reads what you search from the page address (so you can share a search as a link)".
3. **Spot layout work.** New `sm:`/`md:`/`lg:` style prefixes → "adjusts the layout for phone and desktop sizes".
4. **Add a "Low risk" line. This is plain's unique strength:** it can *check* what did NOT change.
   "Low risk: only the home page changed. Nothing saves data, charges money, or changes login."
   Codex can only *claim* this.
5. Links to the same page ("Clear search" → `/`) are noise, so leave them out.

---

## Trial 3: Knows the basics

> "add a wishlist where logged in users can save bracelets, save it in the database"

**What was built:** the shop had no customer accounts, so Codex built **a whole login system**:
sign-up, login and logout, hashed passwords (`scrypt`), database sessions in a cookie, plus
User, Session and WishlistItem tables, heart buttons, a `/wishlist` page, an `/account` page and
the header navigation. 17 files. Most database calls are **raw SQL** (`$queryRaw`/`$executeRaw`),
not normal Prisma calls.

**Ground truth: problems in the real code**
- 🔴 **The migration is incomplete.** It's the *first* migration in the repo, and it only creates
  User, Session and WishlistItem. Product, Order, Coupon, Review and Subscriber were never in any
  migration, so a fresh database setup fails (WishlistItem points at a Product table that was
  never created).
- 🟡 **Raw SQL everywhere.** It's likely a workaround for not being able to regenerate the Prisma
  client, and it skips the type safety the rest of the app has.
- 🟡 **Big scope.** "Wishlist" turned into "customer accounts plus passwords plus sessions". It's
  reasonable, but it's a large security surface the user should know they now own.
- ✅ Passwords are hashed properly, and the admin login still works.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ thorough, 7 sections | 🟡 lists everything, but as "New server code that accepts requests" ×4 |
| Scope: new account system | ✅ explained, though not flagged as *bigger than asked* | ❌ never says "you now have customer accounts" |
| Incomplete migration | ❌ "I created a Prisma SQL migration that creates these tables" | ❌ saw a migration and **dropped** the "update database" step |
| Raw SQL | ✅ mentions `INSERT OR IGNORE` | ❌ completely blind: wishlist "deletes data" with no table named |
| Password safety | ✅ scrypt, salt, timing-safe | ❌ silent |
| False alarms | none | ❌ **4 of 4 "problems" were false**: "anyone can use login/register/logout without logging in" (that's the point of them), "anyone can open the account page" (it's the sign-in page), and the wishlist "! anyone can post" (it *does* check login, via `getCurrentUser`) |
| Wording | technical but fine for this persona | "an user", "each account?next=[…] page" |

**Codex wins clearly.** plain was **actively misleading** here: a red "⚠ 4 problems" verdict made entirely of false alarms.

**Notes for plain**
1. **Recognize login checks by role, not a fixed list of names.** `getCurrentUser`,
   `requireUser` and so on. Better still: any call into the app's own auth module (`lib/auth`).
2. **Treat sign-in endpoints as their own category.** Login, register, logout, signup and reset
   must be public. Instead of flagging them, explain them: "**Customers can now create accounts and log in.**"
3. **Spot new account systems.** A new User table with a password field → a headline: "Your app now has
   customer accounts with passwords." If the password is hashed (scrypt/bcrypt/argon2) → "passwords
   are stored scrambled ✓". If it's stored plain → **Unsafe**.
4. **Read raw SQL.** Parse `INSERT INTO X` / `DELETE FROM X` / `FROM X` inside `$queryRaw`/`$executeRaw` for
   tables and saves. Also mention "uses raw SQL in N places instead of Prisma" as a loose end.
5. **Check migrations cover the schema.** Every table in the schema should be created by some migration;
   if not → "Your database setup is incomplete: Product, Order… are never created".
6. Remove query strings from links (`/account?next=…` → the account page). Fix "an user" → "a user".
7. `app/layout.tsx` affects **every page**: "Every page now shows the account menu".
8. A heading that only shows when the list is empty ("Nothing saved yet") isn't a section.

**Pattern so far:** Codex's explanations are accurate about what's *there*. plain's edge only shows up
when it's *right*. One noisy run (4 false alarms) would make a user stop trusting it. **False
alarms are worse than missing a problem.**

---

## Trial 4: Junior developer

> "Add order status management: admin can mark orders shipped or cancelled via an API route, and email the customer with Resend."

**What was built:** `PATCH /api/admin/orders/[id]` (admin login required, only accepts
`shipped`/`cancelled`), Ship and Cancel buttons on the admin orders page, and `lib/resend.ts`, which
calls `https://api.resend.com/emails` with `fetch` directly (no new package). There are two new
environment variables. The status is saved before the email is sent, and the admin sees a warning
if the email fails.

**Ground truth: problems in the real code**
- 🔴 **Cancelling doesn't refund.** There's no `stripe.refunds` call anywhere. The customer gets
  "your order was cancelled" and keeps paying.
- 🔴 **No status rules.** You can mark a *pending, never-paid* order as shipped. Its email is still
  the placeholder `pending@checkout.local`, so the "on its way" email goes nowhere. You can also
  cancel something that already shipped.
- 🟡 Needs RESEND_API_KEY and RESEND_FROM_EMAIL, plus a domain verified with Resend.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ excellent, including the email-failure behavior | ✅ buttons, "updates orders", login ✓, all correct but thin |
| Emails customers | ✅ | ❌ **missed Resend entirely** (it's a raw `fetch`, not an SDK import) |
| Env vars to set | ✅ plus the domain caveat | ✅ |
| Cancel doesn't refund | ❌ | ❌ |
| Can ship unpaid orders | ❌ | ❌ |
| False alarms | none | none ✓ |

**Tie on safety (both missed the money problem); Codex wins on explaining.**

**Notes for plain**
1. **Recognize outside services from URLs**, not just imports. `fetch("https://api.resend.com/…")` →
   Resend; also `api.stripe.com`, `api.openai.com`, `hooks.slack.com`, …
   → "now **emails customers** (through Resend)".
2. **Read what an update changes.** `order.update({ data: { status } })` → "changes the **status** of orders"
   instead of "updates orders".
3. **A money rule plain *could* catch:** code that sets an order to `cancelled`/`refunded`, but there's no
   refund call (`stripe.refunds.create`) anywhere → **Check:** "Cancelling an order doesn't refund the
   customer in Stripe. Do it by hand in Stripe, or ask for automatic refunds."
4. Status rules (can't ship unpaid orders) need reasoning: **optional AI territory**.

---

## Trial 5: Experienced developer

> "Move pricing into lib/pricing.ts, add 8.25% sales tax to totals, keep Stripe amounts in sync, and decrement stock in the webhook when an order is paid."

**What was built:** a new `lib/pricing.ts` (subtotal, discount, `SALES_TAX_RATE = 0.0825`, total);
`calculateTotal` removed from `lib/money.ts`; checkout sends Stripe **one combined merchandise line
plus one tax line** (it used to send one line per product and created a Stripe coupon); the cart shows
estimated tax; and the webhook marks the order paid and lowers stock inside a transaction, now
also listening for the `async_payment_succeeded` event.

**Ground truth: problems in the real code**
- 🔴 **Charged but stuck at "pending".** If stock is short when payment arrives, the transaction
  throws and rolls back, *including* the paid status. The customer has paid, the order says pending,
  and Stripe keeps retrying the webhook. The code doesn't refund or alert anyone.
- 🟡 **Stripe receipts lose the product list.** They show one "merchandise" line instead of each bracelet.
- 🟡 **One flat tax rate for every customer**, wherever they are (8.25% hardcoded).
- ✅ The move is clean: nothing still uses the deleted `calculateTotal`.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ excellent, the right depth for a senior | ❌ "**small behind-the-scenes changes**" ×3 |
| New pricing file | ✅ | ❌ **never mentioned** |
| Tax rate | ✅ | ❌ |
| Stock decrement | ✅ | ❌ blind (`transaction.product.updateMany`, not `prisma.…`) |
| Charged-but-pending risk | ❌ presents the rollback as safety | ❌ |
| Stripe line-item change | ✅ | ❌ (and didn't notice the Stripe coupon call was removed) |
| Flat tax for everyone | ❌ | ❌ |
| False alarms | none | ❌ "lib/money.ts looks unrelated" (you asked to move pricing out of it) |

**Codex wins by a lot.** For experienced developers, plain v0 adds nothing, and its false alarm costs it trust.

**Notes for plain**
1. **Report new and changed shared code** (`lib/`, `utils/`), not just pages and server code. List new
   exported functions in words: "New pricing code: calculates the subtotal, sales tax and pricing."
2. **Recognize database calls through any variable.** Any `x.<model>.<operation>` where `<model>` is a schema
   table, not just `prisma.…` (covers transactions and renamed clients).
3. **Read update data.** `{ stock: { decrement } }` → "lowers products' **stock**". (Same as trial 4's note.)
4. **Read named constants.** `SALES_TAX_RATE = 0.0825` → "sets the sales tax to **8.25%**". A single flat rate
   → Check: "everyone pays the same tax wherever they live".
5. **Report removed outside calls too:** "no longer asks Stripe to create a coupon".
6. **Webhook event names** (`checkout.session.async_payment_succeeded`) → "now also reacts to delayed payments".
7. **Fix "unasked" with the import graph.** A changed file connected by imports to the other changed files
   is related. Also, removing functions as part of a move is not unrelated.
8. **New visible labels on pages** ("Subtotal", "Estimated sales tax"), up to ~5 → "the cart now shows the subtotal, estimated sales tax and estimated total".
9. A payment webhook that can `throw` after taking payment is a pattern plain could flag (Check: "if this fails,
   the customer has paid but the order won't update"). It's borderline. Maybe for the AI layer.

---

## Trial 6: Vague and frustrated

> "checkout is kinda broken sometimes, fix it and make it faster"

**What was built:** 3 files. The cart handles network failures and bad responses (the button no
longer sticks on "Opening checkout…"); the server checks the cart, merges duplicate products
(which used to crash the order save), returns readable out-of-stock errors, looks up products and
coupons at the same time (`Promise.all`), uses the request's own address when `NEXT_PUBLIC_SITE_URL`
isn't set (it used to send customers to localhost), and survives a corrupted saved cart.

**Ground truth: problems:** none serious. A good fix. (Using the request's address is a minor
trust issue behind some proxies; that's not worth a vibe coder's attention.)

| | Codex "explain" | plain |
|---|---|---|
| What was fixed and *why it was broken* | ✅ **excellent**: names each cause | ❌ "small behind-the-scenes changes" ×2 |
| Faster | ✅ explains parallel lookups | ❌ |
| Localhost redirect fix | ✅ | ❌ |
| False alarms | none | ❌ "AddToCartButton looks unrelated" (it's part of checkout) |

**Codex wins clearly.** For "fix it" requests, the user needs *why it broke*, and that's reasoning, not facts.

**Notes for plain**
1. **New error messages are readable facts.** `{ error: "Sea Glass does not have enough stock." }` →
   "Customers may now see these messages: …". It's the most human-readable thing in server code.
2. **New try/catch around risky calls** (`fetch`, `JSON.parse`, `response.json`) → "now handles failures
   instead of getting stuck or crashing".
3. **`Promise.all`** replacing back-to-back `await`s → "now does N lookups at the same time (faster)".
4. **Changed fallbacks.** `process.env.X ?? A` → `?? B` → "If X isn't set, it now uses B instead of A".
5. **The "unasked" heuristic fails on vague requests.** There are no specific words to match. Only flag unasked
   changes that touch something **sensitive** (money, login, saved data, prices) **and** aren't connected
   to the rest of the change.

---

# What we learned

## Scorecard

| Trial | Persona | Who explained better | Real risks found by Codex / plain | plain false alarms |
|---|---|---|---|---|
| 1 | Non-technical | Codex (but too technical for this user) | 0 / ½ (spam, but missed the coupons) | 1 |
| 2 | Student | **Codex** | n/a (low risk) | 0 |
| 3 | Basics | **Codex** | 0 / 0 (incomplete migration missed by both) | **4** |
| 4 | Junior | **Codex** | 0 / 0 (no refund, can ship unpaid: both missed) | 0 |
| 5 | Senior | **Codex** | 0 / 0 (charged-but-pending: both missed) | 1 |
| 6 | Vague | **Codex** | n/a | 1 |

## The honest result

**plain v0 loses to "Explain me what u did and how?" in all six trials** on explaining what was built.
Codex's own explanations were accurate, complete and well organized every time, and none of them made
anything up. The "AI might invent things" fear did **not** show up in these runs.

**Neither caught the real business risks:** unlimited coupons, someone else's coupon code leaking, a migration
that can't build a fresh database, cancelling without a refund, shipping unpaid orders, charged-but-pending
orders. Codex *explains its own intent*, so it describes its design choices as safeguards
("the duplicate check prevents multiple codes", "the rollback keeps things consistent"). **An agent
reviewing its own work is not a second opinion.**

**plain's false alarms (7 across six trials) did more damage than its misses.** Trial 3's red "⚠ 4 problems",
all false, would make anyone uninstall it.

## Where plain's edge actually is

These are the things plain can do and "explain yourself" structurally can't:

1. **Independence.** It's a second reader that didn't write the code, so it doesn't defend design choices.
   That only matters if its checks are *right*.
2. **Facts it can verify, including what did NOT change.** "Only the home page changed; nothing saves
   data, charges money or touches login." An agent can say that; plain can **prove** it.
3. **Reading the code, not the transcript.** Trial 1's go-between agent had never read the code and
   summarized from memory. In real use, people often ask the outer agent, and that agent may only
   know what it was told.
4. **The same format every time, instantly, for free, offline.** It can run on every turn, every PR and every
   teammate's branch, with no prompt and no tokens. Over many changes it can build the **timeline**
   ("what did we ship this week?"), which an agent per session can't.
5. **Checks across many files that agents skip:** schema vs. migrations, env vars vs. `.env.example`,
   deleted functions still in use, cancel without refund, each signup creating a coupon. These are
   mechanical, and agents don't do them unless asked.

**Where plain should *not* compete:** explaining *why* (trials 2, 5, 6) and *how* (design reasoning).
Codex is better there, and that's fine.

## What this means for the product

1. **Change the pitch.** It's not "plain explains better than the agent". It's "**plain checks the agent's
   work.**" Let the agent explain; plain verifies and points out what the explanation left out.
2. **Combine them.** Run plain, then hand its facts *to the agent*: "Here's what plain found. Explain
   your change to the user, and address these points." That gives Codex's clarity *and* plain's
   independent checks. It could also work the other way: plain compares the agent's summary to its own
   facts and flags claims the facts don't support ("says 'only changed X', but Y also changed").
3. **Accuracy first. False alarms are the enemy.** Every rule needs a test against real agent output,
   and a guess must never turn the verdict red.
4. **Fewer, sharper checks beat broad coverage.** The money, login, data and setup checks below would have
   caught 5 of the 7 real risks.

## Improvement backlog, by impact

**Kill false alarms (do first)**
- [ ] Recognize login checks by role: any call into the app's auth module, plus `getCurrentUser`, `require*` (T3)
- [ ] Treat login, register, logout, signup and reset as public by design, and describe them instead of flagging them (T3)
- [ ] "Unasked": only flag sensitive changes that aren't connected to the rest of the change by imports (T1, T5, T6)
- [ ] Guesses never count toward the red "N problems" verdict (T1)

**Catch the real risks (the edge)**
- [ ] Database saves nested inside other saves (`data: { coupon: { create } }`) → coupons are created publicly (T1)
- [ ] Every table in the schema must be created by some migration (T3)
- [ ] Cancel or refund status with no `stripe.refunds` call anywhere (T4)
- [ ] Database calls through any variable (`transaction.product…`) (T5)
- [ ] A payment webhook that can throw after payment → "customer paid, order not updated" (T5, borderline)
- [ ] A new user table with a password field: hashed ✓ or **Unsafe** (T3)

**Say what was built (stop "behind-the-scenes changes")**
- [ ] Shared code in `lib/`: new or removed exported functions, in words (T5)
- [ ] Fields an update changes (`data: { status }`, `{ stock: { decrement } }`) (T4, T5)
- [ ] Search and filter in queries (`where … contains`) (T2)
- [ ] New user-visible error messages, labels and named constants (`SALES_TAX_RATE = 0.0825` → 8.25%) (T5, T6)
- [ ] Outside services from `fetch` URLs (`api.resend.com` → "emails customers") (T4)
- [ ] Raw SQL: tables and saves from `$queryRaw`/`$executeRaw` (T3)
- [ ] `layout.tsx` = every page; `searchParams`; responsive layout styles; `Promise.all`; changed env fallbacks (T2, T3, T6)
- [ ] **"Low risk" line**: say what did NOT change (T2)

**Wording**
- [ ] "a user", not "an user"; strip query strings from links; empty-state headings aren't sections; email inputs → "an email signup box"

**The AI layer (optional, labeled)**
- [ ] Order and status logic (ship unpaid, cancel shipped), leaking data to people who shouldn't see it, abuse (farming coupons), retry and rollback traps

**Product experiment**
- [ ] "plain + agent": feed plain's facts into the agent's explanation, and flag claims in the agent's summary that the facts don't support
