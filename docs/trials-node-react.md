# Trials, round 2: Node + React (Paw Pals)

Same method as [round 1](trials.md) (Next.js bracelet shop), on a different stack. Codex built
**Paw Pals**: dog-walk bookings, with a React + Vite + React Router frontend, an Express API, Prisma
and Stripe. The app is in a private repo, `plain-dog-walks`, one branch per persona. Then six
personas asked Codex for a feature. For each one we recorded:

1. **Codex's own reply** after building it.
2. **Codex's answer** to "Explain me what u did and how?"
3. **plain's card** on the same change. The plugin passes the request; the cards below are from
   *before* the fixes in this round.
4. **Ground truth.** It comes from reading the actual changes, and was established *before*
   reading either explanation. Two separate graders did this part, three trials each, so the
   scoring isn't anchored on plain's author.

| # | Persona | Request |
|---|---|---|
| 1 | Non-technical owner | "can people get like 10% off their first walk if they sign up for my newsletter" |
| 2 | Student, first project | "add a search bar so ppl can find walkers by neighborhood and make it look good on phones" |
| 3 | Knows the basics | "add favorites where logged in users can save walkers they like, save it in the database" |
| 4 | Junior developer | "Add booking status management: admin can mark bookings completed or cancelled via an API route, and email the customer with Resend." |
| 5 | Experienced developer | "Move pricing into server/src/lib/pricing.ts, add a $3 booking fee and 8.25% sales tax to totals, keep Stripe amounts in sync, and prevent double-booking a walker for the same slot when the webhook marks a booking paid." |
| 6 | Vague and frustrated | "booking is kinda broken sometimes, fix it and make it faster" |

---

## Trial 1: Non-technical owner (p1-newsletter)
> "can people get like 10% off their first walk if they sign up for my newsletter"

**What was built:** A newsletter box on the home page saves emails to a new table. When a logged-in customer books, the server checks two things: is their account email on the list, and have they never had a paid, completed or recent pending walk? If both are true, Stripe charges 90% of the price. The booking button no longer shows the price. No newsletter emails are ever sent.

**Ground truth: problems in the real code**
- 🔴 Discount farming. Emails are never verified. Anyone can make a new account with a new email, subscribe it, and get 10% off again, forever.
- 🔴 Bookings check the new table. If the database isn't updated, every booking fails, not just the discount.
- 🟡 Anyone can add any email, including a stranger's. No confirmation email is sent (spam and consent risk).
- 🟡 The page promises "Unsubscribe anytime", but there is no way to unsubscribe.
- 🟡 Nothing sends newsletters, and the owner has no screen to see the list.
- 🟡 Unasked change: the price was removed from the booking button.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ full flow, first-walk rule | 🟡 shows signup; never says the price drops 10% or who qualifies |
| New-account discount farming | ❌ even says it's safe because it runs on the server | ❌ |
| Bookings break without DB update | ❌ (only in first reply: "run db:setup") | 🟡 gives the step, not the consequence |
| Any email, no confirmation | ❌ | 🟡 flags "spam or fake subscribers" |
| False "Unsubscribe anytime" | ❌ | ❌ |
| No emails sent / no list screen | 🟡 says no emails sent | ❌ |
| Price removed from button | ✅ disclosed, with a reason | ❌ **FALSE:** "small behind-the-scenes changes" |
| Migration/deploy steps | 🟡 says build didn't run; no DB step in explain | 🟡 `npx prisma migrate dev`, no folder given, no "untested" |
| Unasked / false positives | none | 🟡 "change subscribers" is wrong (it can only add); "Nothing looks broken" is too generous |
| Written for this user | 🟡 heavy jargon (POST /api, model, Math.round) | ✅ mostly plain; raw command and /api paths |

**Notes for plain**
1. Money rule: when the amount sent to Stripe changes (e.g. `* 0.9`), say it outright: "Customers can now pay 10% less when …". The card missed the core feature.
2. Promo-abuse check: if the request says "% off", "first", "free", "coupon" or "discount" and eligibility depends on a user or email that is never verified, ask: "What stops someone making a new account to get it again?"
3. Say what happens if they skip a migration. If a money route reads the new table, write "Until you do this, nobody can book." Name the folder to run it in, and prefer the project's own script (`npm run db:setup`).
4. Never write "behind-the-scenes" when visible text changed. Compare the visible strings and price displays (`formatMoney` removed) and report: "The booking button no longer shows the price."
5. Upsert with an empty update means "adds", not "changes". For endpoints that collect emails, say "anyone can add anyone's email; no confirmation is sent" and drop the "like reviews" comparison.
6. (Lower) Flag promises in the page text that no code backs up: "Unsubscribe anytime" with no unsubscribe route.

## Trial 2: Student, first project (p2-search)
> "add a search bar so ppl can find walkers by neighborhood and make it look good on phones"

**What was built:** A search box on /walkers filters the already-loaded list as you type. It matches part of the neighborhood name and ignores case. It also adds suggestions, a clear (×) button, a live count, and a "no matches" message with a "View all walkers" button. Phone styles stack the cards in one column and make the search box bigger. The changes are browser-only, with no server or data changes.

**Ground truth: problems in the real code**
- 🟡 The phone spacing rules for `.page` and `.page-heading` also change My bookings, walker profiles and admin pages on phones. Small, but not asked for.
- 🟡 Not verified. The build never ran, and nobody looked at it on a phone.
- 🟡 Limits: no typo tolerance, nearby areas or zip codes. The search resets on refresh and can't be shared as a link.
- No 🔴. It doesn't touch login, money or data.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ clear, incl. partial match | 🟡 "a box and a View all walkers button"; doesn't say it filters live; that button only shows when nothing matches |
| "Look good on phones" (half the ask) | ✅ detailed | ❌ only "The agent changed client/src/styles.css" |
| Spacing change hits other pages | 🟡 lists the spacing but says only the walkers page changed | ❌ |
| Not verified | ✅ build blocked (phone not mentioned) | ❌ |
| Search limits | 🟡 explains partial matching | ❌ |
| Migration/deploy steps | ✅ none needed, "no new server endpoint" | ✅ none shown (correct) |
| Unasked / false positives | none | none; "Nothing looks broken" is fair here |
| Written for this user | ✅ fits a student | 🟡 readable but too thin to learn from |

**Notes for plain**
1. Request coverage: split the ask into parts ("search bar", "good on phones") and show the evidence for each. New `@media` rules → "On phones: cards stack in one column and the search box is bigger." If a part has no evidence, say so.
2. Summarize CSS changes instead of naming the file. Say which screen sizes changed, and check whether the changed selectors are used on other pages: "Also tightens spacing on My bookings and admin pages on phones."
3. Say when nothing was tested. If the agent's message says the build or tests couldn't run, add "The agent didn't run the app. Open /walkers on your phone before shipping."
4. Describe behavior: a `.filter` driven by the input's state → "the list narrows as you type." Mention conditional UI along with its condition.

## Trial 3: Knows the basics (p3-favorites)
> "add favorites where logged in users can save walkers they like, save it in the database"

**What was built:** A new Favorite table that stores one row per user and walker. It has three API routes, all behind login and scoped to the logged-in user. A heart button sits on walker cards and the profile, for logged-in users only, and updates instantly with rollback on error. There is also a protected Favorites page and nav link.

**Ground truth: problems in the real code**
- 🟡 Needs a DB update for the new table. Without it, the hearts show errors (the rest of the app still works).
- 🟡 If the owner deactivates a walker, that walker silently disappears from customers' favorites.
- 🟡 Unasked: the walkers page now shows the list even when there's an error, and one error banner serves both "load failed" and "save failed".
- 🟡 Not verified: the build never ran.
- ✅ Security is done right: each user can only read and change their own favorites.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ | ✅ but repetitive |
| Login + ownership (correct) | ✅ says users can't touch others' favorites | 🟡 "requires login ✓" only |
| DB update needed | ✅ `npm run db:setup` | ✅ step given; no folder or consequence |
| Deactivated walkers vanish | ✅ "saved, active walkers" | ❌ |
| Shared error banner change | ❌ | ❌ |
| Not verified | ✅ | ❌ |
| Logged-out users see no heart | ✅ | ❌ |
| Unasked / false positives | none | 🟡 "Each walker page loads favorites" (it's loaded once at login); no false alarms |
| Written for this user | ✅ right level | 🟡 plain but wordy, says little |

**Notes for plain**
1. Ownership confirmation: if a route requires login and every query filters on the session user (`req.user.id`), say "Each person only sees and changes their own favorites ✓". This is the reassurance this persona needs. Flag `:id` routes that are missing that filter.
2. Dedupe verbs. Replace "loads favorites…, sends favorites…, deletes favorites…" (repeated on 3 pages) with one line: "people can save and unsave walkers."
3. Join tables: "remembers which walker each person saved, and when", not "stores favorites: date created".
4. Read filters like `walker: { active: true }` → "Walkers you hide also drop out of people's favorites."
5. Add the "not tested" line and the migration consequence, as in Trials 1 and 2.

---

## Trial 4: Junior developer
> "Add booking status management: admin can mark bookings completed or cancelled via an API route, and email the customer with Resend."

**What was built:** The admin status route (already behind admin login) now only accepts "completed" or "cancelled". It enforces rules: only paid bookings can be completed, and final bookings are locked. It guards against two admins clicking at once. After each change it emails the customer through Resend, using a raw `fetch` to api.resend.com rather than the Resend package. The admin page dropdown now only offers the valid actions. Two Resend keys are now required, or the server won't start.

**Ground truth: problems in the real code**
- 🔴 Cancelling a paid booking does not refund on Stripe. The customer gets a "cancelled" email but keeps paying.
- 🟡 Cancelling a pending booking leaves its Stripe checkout open. The customer can still pay, and the webhook flips the booking back to "paid" after the "cancelled" email went out.
- 🟡 The server refuses to start without RESEND_API_KEY and RESEND_FROM_EMAIL. The sending domain must be verified in Resend.
- 🟡 If the email fails, the status is already saved, but the admin sees an error and a stale row.
- 🟡 New outside service: customer names and emails now go to Resend.
- 🟡 Admins can no longer set a booking back to pending or paid. This is a removed ability.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ Clear, step by step | ❌ "small behind-the-scenes changes". Never says customers get emails |
| No refund on cancel | ❌ | ❌ ("Nothing looks broken") |
| Pending checkout still payable | ❌ | ❌ |
| Server won't start without keys / verified domain | ✅ Both stated | 🟡 Lists keys. Misses crash-on-start and domain |
| Email fails after save | ❌ | ❌ |
| Resend gets customer data | 🟡 Names Resend, not the data | ❌ Missed (raw fetch, no package) |
| Removed pending/paid setting | ✅ "replaced unrestricted editing" | ❌ |
| Migration/deploy | ✅ None needed, env covered | 🟡 3 env steps. EMAIL_TIME_ZONE is optional (has a default), so step 3 is overstated |
| Unasked changes / false positives | ✅ None false | 🟡 Headline "Nothing looks broken" is over-reassuring |
| Written for this user | ✅ Right level for a junior dev | 🟡 Plain words, but almost no content |

**Notes for plain**
1. Detect `fetch()` to known API hosts (api.resend.com, api.stripe.com, api.openai.com) and env prefixes (RESEND_, SENDGRID_, TWILIO_) as services. Today SERVICES only matches imports. Card line: "Your app now emails customers through Resend. It sends their name and email to Resend."
2. Ban "small behind-the-scenes changes" when a handler gains an outside call or new 400/409 responses. Quote the new error messages. They are already plain English, e.g. "Now refuses: Only paid bookings can be marked completed."
3. Refund rule (a guess): code writes status 'cancelled' on a table with payment fields (amountCents, stripeSessionId), and there is no `refunds.create`. Card line: "Cancelling a paid booking does not give the money back."
4. Env: split required-at-startup (a requiredEnv list, or a throw if missing) from optional (`|| default`). Say "Your server won't start without X." Drop optional keys or mark them optional.
5. Don't print "Nothing looks broken" when a change touches money or sends email. Use "No bugs spotted · N things to know."

## Trial 5: Experienced developer
> "Move pricing into server/src/lib/pricing.ts, add a $3 booking fee and 8.25% sales tax to totals, keep Stripe amounts in sync, and prevent double-booking a walker for the same slot when the webhook marks a booking paid."

**What was built:** pricing.ts computes walk + 300-cent ($3) fee + Math.round(8.25% of the walk). The DB amountCents and the three Stripe line items come from the same call, so they match. The walker API returns a price breakdown and the booking form shows it. A new nullable unique `paidSlotKey` is set when payment succeeds. Both the webhook and the success page go through `markBookingPaid`. If that hits a conflict, it sets the booking to cancelled. The build script now runs `prisma generate`. All requested items were done.

**Ground truth: problems in the real code**
- 🔴 On a slot conflict the customer is charged and the booking is auto-cancelled. No refund is made. The webhook only writes a console.error, so nobody is alerted.
- 🔴 When an admin cancels a paid booking, it keeps its paidSlotKey. The next customer who pays for that slot is charged and auto-cancelled with no refund.
- 🔴 Needs a DB migration. No migration file exists, so every booking query fails until the schema is applied.
- 🟡 The admin route can still set "paid" directly, bypassing the guard.
- 🟡 Tax applies to the walk only, not the $3 fee. That is a business/tax decision to confirm.
- 🟡 Walker list cards still show the bare walk price.

| | Codex "explain" | plain |
|---|---|---|
| What the feature does | ✅ Worked example: $24 → $28.98 (correct) | ❌ Never says prices went up. Calls the 💰 route "small behind-the-scenes changes" |
| Charged + cancelled, no refund | 🟡 "contact support". Doesn't say there is no auto refund or alert | ❌ "Nothing looks broken" |
| Stale paidSlotKey after admin cancel | ❌ | ❌ |
| Migration | 🟡 Says to run `npm run db:setup`, which is migrate dev + re-seed. Dev only | ✅ Flagged. 🟡 `migrate dev` is dev only |
| Admin can set paid | ❌ False claim: "cannot both become paid" | ❌ |
| Tax not on fee | 🟡 Stated, not flagged as a choice | ❌ |
| List price mismatch | ❌ | ❌ |
| Unasked changes / false positives | ✅ Build script mentioned | 🟡 Missed the package.json build change. No false alarms |
| Written for this user | ✅ Fits an experienced dev | ❌ Too thin. "paid slot key" is a raw field name |

**Notes for plain**
1. Price-change rule: when the Stripe `unit_amount`/line_items or the stored amount expression changes, say "Customers now pay more: walk + $3.00 fee + 8.25% tax." Pull the constants from the new module and convert cents to dollars.
2. Charged-but-cancelled rule: a payment handler writes 'cancelled' after `payment_status === 'paid'` and there is no refunds.create. Flag 🔴: "A customer can be charged and get no booking. No refund is sent, and only a server log notes it."
3. Bypass rule: a new guard function wraps writes of status 'paid', but another route still writes that status directly. Flag: "Admins can still mark paid without the double-booking check." (Guess.)
4. Migration wording: read package scripts. Warn that db:setup re-seeds. Add "On your live site use `prisma migrate deploy`."
5. Translate new columns by intent: "a lock so each walker time can be paid for only once." Report package.json script changes.

## Trial 6: Vague and frustrated
> "booking is kinda broken sometimes, fix it and make it faster"

**What was built:** Codex guessed four causes and fixed them:
- **Double-booking race:** a new BookingSlot table keyed on walker + time, written inside a transaction.
- **Timezone:** the browser now sends UTC.
- **Abandoned checkouts:** these held the slot for 31 minutes. A cancel-checkout route now releases it.
- **Taken times:** a new public availability route greys them out, with a client cache.

The admin status route frees the slot on cancel and re-claims it on un-cancel.

**Ground truth: problems in the real code**
- 🔴 New table, no migration. Creating a booking fails until the schema is applied.
- 🟡 Bookings made before the change were stored in server time. They may sit hours away from new ones, so they won't block the same intended slot.
- 🟡 "Faster" is mostly unmet. There is no server speedup, and each date pick adds a request. The cache never refreshes while the page is open.
- 🟡 The new availability route needs no login. Anyone can see a walker's booked times.
- 🟡 A payment can land on a booking that was just deleted (stale-pending cleanup or a cancel race). The webhook ignores it: the customer is charged and has no booking.
- 🟡 The webhook can still flip an admin-cancelled booking to paid without re-claiming its slot.

| | Codex "explain" | plain |
|---|---|---|
| What was broken / what was fixed | ✅ Four clear causes. Doesn't ask "was this your problem?" | ❌ Never says what was fixed. "sends bookings… loads bookings" is misleading |
| Migration | 🟡 "must be migrated". Reply says db:setup (re-seeds) | ✅ Flagged |
| Old bookings' times | ❌ | ❌ |
| "Faster" not really done | 🟡 Recasts UX as speed | ❌ |
| Public availability route | 🟡 Says "public", not as a tradeoff | 🟡 "lists bookings" with no login note. Overstates the data |
| Paid-but-deleted booking | ❌ | ❌ |
| Webhook slot gap | ❌ | ❌ |
| Unasked changes / false positives | ✅ Lists the extras | ❌ The only "problem" is a false alarm. The api() change is safe (ApiError extends Error) and is used for this fix |
| Written for this user | ❌ Too technical: "synchronous submission guard", UTC | 🟡 Plain words, but doesn't answer "is it fixed?" |

**Notes for plain**
1. For vague asks ("fix", "broken", "faster"), open with "What the agent decided was wrong." Build it from new unique keys and transactions ("Two people can no longer book the same time") and new 409 messages. If no change matches "faster", say so.
2. Unasked rule: before flagging a shared function, check compatibility (same return, Error subclass, same message) and whether the asked-for code uses the new export. Downgrade or drop. Never headline a guess.
3. Show public routes symmetrically: "Anyone, no login: shows which times a walker is booked."
4. Date-format change (a raw string switched to `toISOString`): "Bookings made before this may show at a different hour."
5. New delete/deleteMany on bookings: "Abandoned bookings are now deleted, not kept."

---

# What we learned

## Scorecard (plain as it was at the start of this round)

| | Codex "explain" | plain |
|---|---|---|
| Says what the feature does | ✅ in all 6, step by step | 🟡 thin. "small behind-the-scenes changes" hid real changes in 4 of 6 |
| Real money problems (discount farming, no refund on cancel, charged but no booking) | ❌ none fully, 1 partial ("contact support"). In trial 5 it says something false: "cannot both become paid" | ❌ none |
| Database update needed | 🟡 mentioned, sometimes with a command that re-seeds the data | ✅ every time (4 of 4), but no folder and no "what breaks" |
| False alarms | 1 false claim (trial 5) | 1 ("unasked" in trial 6), plus an over-confident "Nothing looks broken" |
| Written for the person | ❌ jargon for the owner and the vague persona | ✅ plain words, but too little content |

**The honest result.** On this stack, Codex's explanation described features better. Neither
of them caught the money problems. plain's strengths held: it stayed in plain words, raised
almost no false alarms, and caught the database step every time. Its weakness was saying too
little when code changed in ways its rules didn't cover.

## What we changed in plain (same day)

Every change is tested in `test/plain.test.ts` and checked against all 16 demo cards
(`node test/demos.ts`).

| Gap found | Fix | Trial card, after |
|---|---|---|
| "small behind-the-scenes changes" on visible changes | Compare the words on each page, including formatted prices | 1: "Each walker page now says 'Continue to secure checkout' and 'Newsletter subscribers get 10% off…'" |
| Server changes said nothing | Quote new 4xx messages: they're already written for people | 4: "now refuses with 'Bookings can only be marked completed or cancelled.'" |
| Money code changed silently | Changed payment code says "Make a test payment before you ship" | 5, 6 |
| Resend called with `fetch`, so no email was seen | Recognize known API hosts; say the app now **emails people** | 4: "Your app now sends emails through Resend. People's email addresses are shared with Resend." |
| Cancel without refund (🔴 in 4 and 5) | A guess, worded as one: a new "cancelled" status, Stripe in the app, and no refund anywhere | 4, 5: "Cancelling doesn't give money back…" |
| Discount farming (🔴 in 1) | Sign-up discounts: "What stops someone signing up again with another email?" (a guess) | 1 |
| Migration step without context | Folder, the live-site command, and what fails until it's run | 1, 3, 5, 6: "in server/, run … Until you do, anything that uses favorites will fail." |
| The agent never ran the code | Read the agent's last message; say so when it couldn't run or test | 3: "The agent says it didn't run or test this." |
| "Good on phones" was invisible | New `@media` rules mean phones | 2: "changed how the app looks on small screens like phones" |
| Optional settings listed as required | Env vars with a fallback (`|| 'UTC'`) aren't listed | 4 |
| False "unasked" (trial 6) | A shared file that adds something the rest of the change uses is part of the feature | 6 |
| Over-confident headline | "✓ Nothing looks broken" → "✓ No problems spotted" | all |
| Found while testing: an existing public route that *starts* changing data wasn't flagged | Flag it like a new one | — |

## Still open (backlog, by impact)

1. **Say the new price.** "Customers now pay walk + $3.00 fee + 8.25% tax." This means reading
   the amount sent to Stripe, not just noticing that the code changed.
2. **Ownership.** For logged-in routes, check that every query filters by the logged-in user.
   If so, say "each person only sees their own ✓". If an `/:id` route doesn't, flag it: any
   logged-in user could open someone else's record.
3. **Answer vague requests.** For "fix it", "broken" or "faster", lead with "what the agent
   decided was wrong", built from new unique keys, transactions and refusals. Say so when nothing
   matches "faster".
4. **Check each part of the request.** Split "search bar *and* good on phones" and show evidence
   for each part, or say a part is missing.
5. **Bypasses.** A new guard (like "only one paid booking per slot") that another route skips.
6. **Shorter repeated lines.** Three pages that all "load, send and delete favorites" should be
   one line.
