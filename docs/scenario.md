# Scenario: adding coupon codes

**Maya** runs a small store built with Next.js, Prisma and Stripe, mostly written by Claude Code.
She can read a little code but doesn't really review it. **Leo** is a developer friend who
reviews her PRs on weekends.

Every line below marked **[fact]** comes from the fixed-rule fact extractor. Lines marked
**[AI]** are optional AI wording or opinion, and are always labeled as such.

---

## Part 1: While building (Claude Code session)

Maya types:

> add coupon codes at checkout

Claude works for 4 minutes and edits 14 files (+412 −38).

### Without plain

Maya sees a long scroll of tool calls and diffs, and then:

> I've added coupon support! Users can now enter a code at checkout...

She can't tell what really changed, so she asks "wait, what did you change?" and gets another
paragraph that might or might not be accurate. She ships it.

### With plain

When the session ends, a hook runs `plain diff --since session-start` and prints:

```
plain · this session changed your app            14 files · +412 −38

✚ NEW FEATURE   Coupon codes at checkout                          [fact]
   Checkout page → POST /api/coupon → reads Coupon → returns discount

✎ CHANGED   /api/checkout                                         [fact]
   The amount sent to Stripe now depends on the coupon.
   💰 Money path touched

✚ DATA   New table Coupon (code, percentOff, expiresAt)           [fact]
         migration: 20261017_add_coupon

⚠ RISK   /api/coupon has no login check, so anyone can call it    [fact]
⚠ RISK   New secret STRIPE_COUPON_KEY is missing from .env.example  [fact]
⚠ NOTE   percentOff isn't capped; a 120% coupon could make the
         total negative                                           [AI]

◌ 9 files only reformatted (hidden)    ◌ 1 lockfile (hidden)

→ Open full view: http://localhost:4747     → Fix the risks: press f
```

Maya presses **f**. Plain hands the three warnings back to Claude as a prompt:

> Fix these: (1) require login in app/api/coupon/route.ts, (2) add STRIPE_COUPON_KEY to
> .env.example, (3) clamp percentOff to 0–100.

Claude fixes them, and plain runs again:

```
✓ RESOLVED  /api/coupon now requires login
✓ RESOLVED  STRIPE_COUPON_KEY added to .env.example
✓ RESOLVED  percentOff clamped to 0–100 in applyCoupon
```

The whole loop took **30 seconds of reading**, and Maya can explain her own feature now.

---

## Part 2: During review (GitHub PR)

Maya opens PR #42, "Add coupon codes". The plain GitHub Action posts a comment:

> ### 🧭 plain: what this PR changes in the app
>
> **1 new feature · 1 changed flow · 1 new table · 0 open risks** (3 resolved during the session)
>
> | | Change | |
> |---|---|---|
> | ✚ | **Coupon codes at checkout**: Checkout → `POST /api/coupon` → `Coupon` table | [fact] |
> | ✎ | **`/api/checkout`**: Stripe amount now = cart total − coupon discount 💰 | [fact] |
> | ✚ | **New table `Coupon`** (code, percentOff, expiresAt) | [fact] |
>
> **Suggested reading order** (3 of 14 files carry the real change):
> 1. `app/api/checkout/route.ts` L40–58: 💰 money path
> 2. `lib/coupon.ts`: new `applyCoupon`
> 3. `prisma/schema.prisma`: new table
>
> *Safe to skim: 9 files only reformatted, 1 lockfile, 1 generated Prisma client.*
>
> [Open the interactive view →](#)

### Leo reviews

Leo clicks **Open the interactive view**:

```
┌ App map ──────────────────────────────────────────────────────────┐
│                                                                   │
│   [Home] ── [Product] ── [Cart] ══ [Checkout] ══ (Stripe)         │
│                                       ║                           │
│                                  /api/coupon ── {Coupon}  ← new   │
│                                                                   │
│   ══ lit up = touched by this PR                                  │
└───────────────────────────────────────────────────────────────────┘
```

He clicks **Checkout** and sees the flow before and after:

```
BEFORE                              AFTER
1. Read cart                        1. Read cart
2. Total = sum of item prices       2. Total = sum of item prices
                                    3. If a coupon code was sent:
                                         look up Coupon by code
                                         if found and not expired:
                                           total = applyCoupon(total, coupon)
3. Charge total with Stripe         4. Charge total with Stripe
```

He clicks **applyCoupon** and gets the line-level English (the original engine):

> applyCoupon takes total and coupon. It sets pct to percentOff of coupon, kept between 0 and 100.
> It returns total minus total times pct divided by 100, rounded to cents.

Leo spots one thing the rules can't know about: the expiry check uses server time without a
timezone. He leaves **one** comment on line 52. He's done in **6 minutes**, where reading
412 lines across 14 files would have taken about 45.

### Maya pushes a fix

The comment updates itself:

> ✎ `lib/coupon.ts`: expiry now compared in UTC · **0 open risks** · ✅ ready to merge

---

## What made this work

| Moment | Plain feature | Rules or AI |
|---|---|---|
| After session | Summary of what changed in the app, compared to the start of the session | Rules |
| After session | Warnings, plus a one-key "fix it" prompt sent back to the agent | Rules (+ optional AI notes) |
| PR comment | Story, reading order, noise hidden | Rules |
| PR page | Map with changes lit up | Rules |
| PR page | Flow before/after | Rules |
| PR page | Function → English | Rules (original engine) |
| Headlines | Polished wording | Optional AI, always labeled |

## Facts the extractor must find for this scenario (spike scope)

- Next.js routes: `app/**/page.tsx` (pages), `app/api/**/route.ts` (endpoints + HTTP methods)
- Prisma models from `schema.prisma`, plus which routes read or write them (`prisma.<model>.<op>`)
- Outside services from imports (`stripe`, `openai`, `@supabase/*`, `resend`, ...)
- Money path: any data flow into `stripe.*.create({ amount })`
- Login check: does the route handler call `auth()` / `getServerSession` / `getUser` before doing work?
- `process.env.X` lookups compared against `.env.example`
- Files that changed only in formatting (the syntax tree is the same before and after)
