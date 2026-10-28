# Trials, round 3: TanStack Start + Supabase (Studio Flow)

The stack Lovable generates today. Codex built **Studio Flow**, a yoga studio:

- **TanStack Start:** `src/routes`, server actions, an `_authed` layout.
- **Supabase:** migrations with Row Level Security.
- **Stripe Checkout.**

The app is in a private repo, `plain-class-booking`. The method is the same as rounds
[1](trials.md) and [2](trials-node-react.md):

- Six personas each asked Codex for a feature.
- We recorded Codex's reply, its answer to "Explain me what u did and how?", and plain's card.
- Two separate graders established the truth from the code *before* reading either
  explanation.

| # | Persona | Request |
|---|---|---|
| 1 | Non-technical owner | "can people get like a free first class if they sign up with their email" |
| 2 | Student, first project | "add filters so ppl can find classes by day and instructor and make it look nice on phones" |
| 3 | Knows the basics | "add a waitlist when a class is full, logged in users can join it, save it in the database" |
| 4 | Junior developer | "Add class cancellation: admin can cancel a class from the admin page, mark all its bookings cancelled, and email everyone booked with Resend." |
| 5 | Experienced developer | "Move pricing into src/server/pricing.ts, add a $2 booking fee and 8.875% sales tax, keep Stripe amounts in sync, and never sell more spots than a class's capacity even if two people pay at the same time." |
| 6 | Vague and frustrated | "booking is weird sometimes and the schedule page is slow, fix it" |

The cards graded below are plain's from **before** this round's fixes. What changed is at the end.

---

## Trial 1: Non-technical owner
> "can people get like a free first class if they sign up with their email"

**What was built:** Any signed-in account with no paid booking sees "Free" on class pages. Booking skips Stripe. The booking is saved with status `paid` and a new `is_intro_offer` flag. A unique index allows one intro booking per account. The homepage, login, class page and My Bookings copy was rewritten to advertise the offer.

**Ground truth: problems in the real code**
- 🔴 One free class per *account*, not per person. Anyone can make a new email and get another free class, with no limit.
- 🟡 Free bookings are stored as `paid`, with no money behind them. That will confuse any count of paid bookings or revenue.
- 🟡 Every existing account that never paid also qualifies, not only new signups.
- 🟡 Deploy order: if the code goes live before the migration, the insert fails and new customers can't book at all.
- 🟡 Unasked: the homepage "Come as you are" message was replaced with marketing copy.
- RLS is fine. Users still can't make their own bookings `paid`.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ Clear steps: free, skips Stripe | 🟡 Only lists copy changes. Says the checkout action "changed in a way plain can't describe" |
| New-email abuse 🔴 | ✅ Names it as a limitation | 🟡 Raised, but as "(This is a guess)" next to "✓ No problems spotted" |
| Free saved as "paid" | ❌ | ❌ |
| Existing accounts qualify | 🟡 Implied ("no previously paid booking") | ❌ |
| Migration / deploy order | ✅ "must be applied before running" | 🟡 Says apply it, not *before* the code |
| Unasked copy changes | ✅ Listed | ✅ Listed |
| Written for this user | ✅ Plain English | 🟡 Readable but thin |

**False statements:** plain says "Lovable does this for you" about migrations. That is unverified and likely wrong for a migration Codex wrote outside Lovable.

**Notes for plain**
1. When the money action gains a branch that saves `status: 'paid'` without Stripe, say so: "Some bookings now skip payment and are saved as paid." Never say "can't describe" about the payment code.
2. If a unique index is on `user_id`, state it as fact: "Limit is one per account. A new email gets another." Drop "(This is a guess)" and don't show "No problems spotted" next to it.
3. If new code writes a new column, say "Run the migration before the code goes live, or booking breaks."
4. Remove or verify the "Lovable does this for you" line.

## Trial 2: Student, first project
> "add filters so ppl can find classes by day and instructor and make it look nice on phones"

**What was built:** Two dropdowns (Day, Instructor) on the homepage. They filter in the browser with no database change. There is a result count, a "Clear filters" button and an empty state. Phone CSS stacks the filters and tightens every class row.

**Ground truth: problems in the real code**
- 🟡 The filters only search what the page already loaded: the next 24 classes (`.limit(24)`). Later days and instructors never show up.
- 🟡 Filters live only in the page. They reset on refresh and can't be shared as a link.
- 🟡 The phone CSS changes class rows site-wide, not just the filters.
- No security or migration issues.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ Full, plus the how (browser state, timezone) | 🟡 One line: two boxes and a button |
| 24-class limit | 🟡 Hinted ("classes already returned") | ❌ |
| Filters not in URL | ❌ | ❌ |
| Phone CSS scope | ✅ Detailed | ✅ "changed how the app looks on phones" |
| Migration / deploy | ✅ None needed (implicit) | ✅ None |
| Unasked / false positives | ✅ None | ✅ None |
| Written for this user | ✅ Teaches a student the how | 🟡 Too thin to learn from |

**False statements:** none.

**Notes for plain**
1. When a filter or search runs over loader data, and the loader has `.limit(N)`, say: "Filters only search the next N classes."
2. Say where the filtering happens: "in the browser, no database change." That is one line, and it teaches.
3. Mention the count, the empty state and the reset. They are visible behavior.

## Trial 3: Knows the basics
> "add a waitlist when a class is full, logged in users can join it, save it in the database"

**What was built:** A new `waitlist_entries` table with RLS on (users can read and insert only their own entries). A trigger only lets someone join when the class is full. There are server actions to join and to read your position, both with login checks. Full classes show "Join waitlist" and "You are #N". The existing anti-overbooking function was rewritten so that booking removes your waitlist entry.

**Ground truth: problems in the real code**
- 🔴 Nothing happens when a spot opens. Nobody is told, and anyone can grab the spot. Queue position has no effect.
- 🟡 Users can't leave a waitlist. There is no button and no delete policy.
- 🟡 The owner has no screen to see waitlists.
- 🟡 `created_at` can be set by the user. Someone using the public key can backdate an entry and jump the queue.
- 🟡 The existing `enforce_class_capacity` function (the rule that stops overbooking) was replaced.
- 🟡 Deploy order: without the migration, every class page errors for signed-in users.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ Thorough | 🟡 Mechanical ("loads/sends waitlist entries") |
| No notify/promote 🔴 | ✅ Stated, but last line | ❌ |
| Can't leave waitlist | ❌ | ❌ |
| No owner view | ❌ | ❌ |
| Queue jumping | ❌ ("database is final authority") | ❌ |
| Overbooking rule rewritten | 🟡 Mentions auto-removal, not the replacement | ❌ |
| RLS on the new table | ✅ Explained | ❌ Silent (login checks ✓ shown) |
| Migration / deploy order | 🟡 Lists both files, including the already-applied base | 🟡 Apply it, no ordering |
| Written for this user | ✅ | 🟡 |

**False statements:** Codex says the screen "refreshes its availability if a spot opens". It only refreshes after an error message. plain repeats "Lovable does this for you."

**Notes for plain**
1. Add request-gap rules. For "waitlist", look for code that runs when a booking is cancelled or expires. If there is none: "Nobody is told when a spot opens. First come still wins."
2. If a new table has an insert policy but no delete policy or action: "People can't leave/remove their entry."
3. Flag `create or replace function` on an existing function: "Changed the rule that stops overbooking. Test booking a full class."
4. For new tables, say the RLS result out loud ("only the person can see their entries ✓"). Silence reads as unchecked.
5. If a client-insertable column is used for ordering, warn about queue jumping.

---

## Trial 4: Junior developer
> "Add class cancellation: admin can cancel a class from the admin page, mark all its bookings cancelled, and email everyone booked with Resend."

**What was built:** A Cancel button with an inline confirm on /admin/classes. The server action checks for an admin. A new database function, `cancel_class`, also checks for an admin. It sets `cancelled_at`, unpublishes the class and marks pending and paid bookings cancelled in one step. The server then looks up each member's email and sends one Resend batch. Cancelled classes are hidden from the schedule and from checkout. The webhook now only marks *pending* bookings as paid.

**Ground truth: problems in the real code**
- 🔴 Paid customers get no refund. Their booking is cancelled and the money stays in Stripe.
- 🔴 A customer who is still in Stripe Checkout can finish paying after the class is cancelled. The new webhook rule ignores that payment, so they are charged with no booking and no refund.
- 🟡 If the email send fails, the class is already cancelled and the button is gone. There is no way to retry, so members may never hear.
- 🟡 Steps before shipping: apply the migration, add 2 Resend keys and verify the sending domain.
- 🟡 Email times are hard-coded to the Chicago time zone.
- ✅ Login and admin checks are in place, both in the server code and in the SQL.

| | Codex "explain" | plain |
|---|---|---|
| What it does | ✅ clear 6-step flow | 🟡 a fair list, but "sends classes to your server" is awkward wording |
| No refunds | ❌ | ❌ says "No problems spotted" |
| Paid after cancel, charged with no booking | ❌ presents the webhook rule as a safety feature | ❌ |
| Email failure leaves no retry | ❌ | ❌ |
| Admin check | ✅ | 🟡 says "requires login ✓", which undersells the stronger admin check |
| New DB function (`security definer`) | ✅ | ❌ not mentioned |
| Migration and keys | ✅ migration, keys, domain | ✅ migration and keys, ❌ domain |
| Unasked changes / false positives | ✅ none | 🟡 calls the one-line checkout change "can't describe" |
| Written for this user | ✅ | ✅ |

Neither one says anything false. Both say nothing about refunds.

**Notes for plain**
1. Add a rule: when a change sets bookings or orders with status `paid` to `cancelled` and there is no `refunds.create`, show "! Paid customers are not refunded." plain fired this rule on p6, where it was wrong, and missed it here, where it was right.
2. Add a rule: when a webhook adds a `status = 'pending'` filter, warn "a late payment can be charged with nothing recorded."
3. Report admin checks as "requires admin ✓", not just "login".
4. List every new SQL function, with its `security definer` setting and whether it checks the user.

## Trial 5: Experienced developer
> "Move pricing into src/server/pricing.ts, add a $2 booking fee and 8.875% sales tax, keep Stripe amounts in sync, and never sell more spots than a class's capacity even if two people pay at the same time."

**What was built:** A new `pricing.ts` works in whole cents and computes subtotal + $2 + 8.875% tax on the subtotal only. Checkout sends Stripe 3 line items plus the expected total. The webhook checks the amount, the currency and that the payment matches the booking's current Stripe session. A new `reserve_class_spot` function locks the class row and reserves a spot. Class pages show the price breakdown, and My Bookings shows a total recomputed from the current price.

**Ground truth: problems in the real code**
- 🔴 `reserve_class_spot` is `security definer` and takes any user id. The migration only runs `revoke … from public`. Supabase grants new functions to anon and authenticated users by default, so this likely leaves it open to anyone with the public key. Someone could fill any class with fake holds. Those holds have no Stripe session, so they never expire.
- 🔴 Each click on Book creates a new Stripe session and replaces the saved one. If the customer pays in an older tab, the webhook matches 0 rows and still answers OK. The customer is charged and the booking is then cancelled. On `main`, that payment would have confirmed the booking.
- 🟡 Schedule cards (ClassCard) still show the base price. Checkout then charges more.
- 🟡 The amount paid is never stored. My Bookings recomputes it from today's price, so old bookings show a fee they never paid.
- 🟡 Tax is not charged on the fee. Confirm that with an accountant.
- 🟡 Apply the migration before deploying the code.

| | Codex "explain" | plain |
|---|---|---|
| What it does | ✅ worked $24 example | ❌ never mentions the new `pricing.ts`, the fee, the tax or the 3 Stripe items, and calls My Bookings "can't describe" |
| Function open to the public | ❌ | ❌ |
| Older-session payment charged, no booking | ❌ presents it as a safety feature | ❌ |
| Schedule shows the old price | ❌ | ❌ |
| Amount not stored | ❌ | ❌ |
| Migration | ✅ | ✅ |
| Written for this user | ✅ fits a developer | 🟡 too thin for this user |

**FALSE (Codex):** "Previously… two simultaneous users could both observe the last spot." `main` already had a trigger that locks the class row and checks capacity. The overselling fix was already there.

**Notes for plain**
1. Add a rule: when a `security definer` function has no `revoke … from anon, authenticated` and no `auth.uid()` check, show 🔴 "anyone can run this."
2. Add a rule: a webhook update that can match 0 rows without failing means a payment can be silently dropped.
3. When the price shown to customers changes in one place, list the other places that still show `price_cents`.
4. Always list new files, especially one the user named.
5. Show the "agent didn't test" step every time. It appeared in p4 but not here, although the reply said the same thing.

## Trial 6: Vague and frustrated
> "booking is weird sometimes and the schedule page is slow, fix it"

**What was built:** Holds now expire: the Stripe session lasts 31 minutes and the reservation 36. Cancelling in Stripe releases the spot right away. An open Checkout is reused if the customer clicks Book again. The capacity trigger now ignores expired holds. The schedule reads from one new view instead of two queries. Login now uses one database call instead of a call to Supabase Auth plus a profile read. My Bookings hides cancelled and expired bookings.

**Ground truth: problems in the real code**
- 🟡 The webhook was not updated. A late "expired" message from Stripe for an old session cancels by booking id only. That can wipe a customer's new hold while they are paying, and if the class has filled meanwhile, they are charged with no spot.
- 🟡 The slowness fix is a guess with no measurement. The owner should check that the page they saw is now faster.
- 🟡 The login check no longer asks Supabase Auth directly, so a logged-out or banned session stays valid until its token expires. This is a security-sensitive change made for speed.
- 🟡 My Bookings no longer shows cancelled bookings. That is a behavior change nobody asked for.
- 🟡 Apply the migration before deploying.
- ✅ The view uses `security_invoker` and the new action checks the session owner.

| | Codex "explain" | plain |
|---|---|---|
| What it does | ✅ explains the cause and the fix well | 🟡 a list of parts, never "holds now expire after 36 min" |
| Late Stripe message wipes a hold | ❌ | ❌ |
| Speed fix unmeasured | ❌ presented as fixed | ❌ |
| Login change | 🟡 explained as speed, no risk given | ✅ flagged auth.ts ("unrelated" is half right) |
| My Bookings hides history | ✅ | ❌ "can't describe" |
| Migration | ✅ | ✅ |
| Unasked changes / false positives | ✅ | ❌ FALSE refund warning (the new action cancels *unpaid* checkouts and marks paid ones paid) |
| Written for this user | 🟡 heavy for a frustrated owner | ✅ short |

**FALSE (Codex):** "Two people could… both reserve it." The row-lock trigger already existed on `main`.

**Notes for plain**
1. The refund rule fires on any "cancel" name. Only fire it when bookings that were paid become cancelled, not when a Checkout is ended before payment.
2. For a vague request, add: "You didn't say exactly what was wrong. The agent guessed. Check that the problem you saw is gone."
3. Rate auth changes by risk, not just by whether they look related: "login check changed: test logging out."
4. Show a webhook warning whenever a change edits checkout but not `api.stripe.webhook.ts`.

---

# What we learned

## Scorecard (plain at the start of this round)

| | Codex "explain" | plain |
|---|---|---|
| Says what the feature does | ✅ in all 6 | 🟡 thin. "Can't describe" on payment code in 3 of 6 |
| 🔴 problems caught | 1 of 7 cleanly (new-email abuse, as a "limitation") | 0 cleanly (new-email abuse only as a guess) |
| False statements | 3 ("two people could book the last spot", twice, though the lock already existed; "refreshes when a spot opens") | 2 ("Lovable does this for you" about migrations; a refund warning on unpaid checkouts) |
| Database update / deploy order | ✅ mostly | 🟡 said to apply it, not *before* the code |
| Written for the person | ✅ but heavy for the vague persona | ✅ short, but thin |

**The honest result.** On this stack plain was weaker than on the others. Codex explained
better, and both missed most money-loss paths:

- refunds
- payments landing on cancelled or replaced checkouts
- a late Stripe message wiping a hold
- a database function anyone could call

These paths depend on control flow and on the order of webhook events. plain's fixed rules
read neither.

## What we changed in plain (same day)

Each rule was checked against all six trials, and against round 2's, so that it fires where
the graders found a real problem and stays quiet where they didn't.

| Gap | Fix | Result |
|---|---|---|
| Refund guess fired on unpaid checkouts (6) and missed paid ones (4) | Read *which rows* a cancel touches: limited to pending/unpaid means no warning. Validated status lists and SQL in new migrations count | Fires in yoga 4 and dog 4; quiet in yoga 6, dog 6 and yoga 5 |
| `reserve_class_spot` likely callable by anyone (5) | New Supabase rule: `security definer` + not revoked from both `anon` and `authenticated` + no caller check. ⚠ if it writes, ! if it only reads | Yoga 5: ⚠. Also caught `is_admin(any_user_id)` revealing who's an admin (!) |
| Existing anti-overbooking function silently replaced (3) | `create or replace function` on an existing one: "Test what X does" | Yoga 3 |
| New tables with correct rules looked unchecked (3) | Say it: "Each person can only see their own ✓" | Yoga 3 |
| "Lovable does this for you" (unverified) | Removed. Now: "Apply X before the new code goes live, or the parts that use it will fail" | All migration steps |
| Vague request (6) | "You didn't say exactly what was wrong, so the agent guessed. Check that the problem you saw is gone." | Yoga 6 |
| The file the user named was never mentioned (5) | "The agent created src/server/pricing.ts, as you asked." | Yoga 5 |
| "Didn't test" missed (5) | Accept curly apostrophes (`couldn’t`) | Yoga 5 |
| Free-first-class deal had no question (1) | Deal phrases like "free first class", "first X is free" | Yoga 1 |
| "shows the gift" (an icon), "store the is intro offer" | Icons aren't content; `is_`/`has_` columns read naturally | Yoga 1 and 2 |

## Still open (backlog, by impact)

1. **Charged but no booking.** A payment that lands on a cancelled, replaced or expired checkout
   (yoga 4 and 5, dog 5). This needs the order of webhook events, which plain can't read yet.
2. **Payment code says "can't describe".** Say what changed: new line items, fees, a skipped
   payment (yoga 1 saves free bookings as `paid`).
3. **Request gaps.** A waitlist with nothing that happens when a spot opens (yoga 3). Filters
   that only search the next 24 classes (yoga 2).
4. **"Requires admin ✓" vs "requires login ✓"** when the check is an admin check.
5. **Risky login changes** (yoga 6 swapped an Auth call for a database read). Say "login check
   changed: test logging out".
