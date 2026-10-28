# Trials, round 4: Django + Django REST Framework (Crumb & Co)

The first non-JavaScript app. Codex built **Crumb & Co**, a bakery that takes pickup pre-orders:

- **Django 5:** server-rendered pages, class-based views for the owner's dashboard.
- **Django REST Framework:** a small JSON API with a router and viewsets.
- **Stripe Checkout** with a webhook.

The app is in `examples/bakery` (its own git repo). The method is the same as rounds
[1](trials.md), [2](trials-node-react.md) and [3](trials-tanstack-supabase.md):

- Six personas each asked Codex for a feature.
- We recorded Codex's reply, its answer to "Explain me what u did and how?", and plain's card.
- Two separate graders established the truth from the code *before* reading either
  explanation. They read the code only: Django wasn't installed, so nothing was run.

| # | Persona | Request |
|---|---|---|
| 1 | Non-technical owner | "can new customers get 20% off their first order if they make an account" |
| 2 | Student, first project | "add a search bar and category filter to the products page and make it look good on phones" |
| 3 | Knows the basics | "let logged in customers save favorite items and see them on a favorites page, also in the api" |
| 4 | Junior developer | "Owner should be able to mark a product sold out for the day from the dashboard; cancel today's unpaid orders that include it and email those customers." |
| 5 | Experienced developer | "Move all pricing into shop/pricing.py, add a 6.25% sales tax and a $1 bag fee, keep Stripe amounts matching, and never take more orders than a product's daily_limit even if two people check out at once." |
| 6 | Vague and frustrated | "checkout is buggy sometimes and the orders api feels slow, fix it" |

The cards graded below are plain's from **before** this round's fixes. What changed is at the end.

---

## Trial 1: Owner running a promotion (money)
> "can new customers get 20% off their first order if they make an account"

**What was built:** Every account that has no orders yet (cancelled ones don't count) gets 20% off its next order. The server works out the discount inside `create_order` (`shop/services.py`). It saves `subtotal_cents`, `discount_cents` and `total_cents` on the order. A new migration adds those columns and copies old totals into the subtotal. A new database rule allows only one active discounted order per customer. A new `/checkout/<id>/cancel/` page cancels the order and expires the Stripe session, so the customer gets the discount back. The discount line now shows on signup, checkout (`cart.js` and `checkout.html`), order history, the owner's order page, and the order API. Stripe now gets **one combined line** ("Crumb & Co pickup order", quantity 1) for the discounted total. Before, it got one line per item.

**Ground truth: problems in the real code**
- 🟡 **Unlimited discounts through extra accounts.** Eligibility is "this account has no orders". Signup asks for an email but doesn't check that it's unique or real (`SignUpForm` has no `clean_email`, and Django's `User.email` isn't unique). So one person can get 20% off every order by signing up again, even with the **same** email address.
- 🟡 **An abandoned checkout uses up the discount for up to about 24 hours.** A pending (unpaid) order counts as "used" (`exclude(status=CANCELLED)` only). Say a customer closes the Stripe tab instead of pressing Back. If they come back and try again, they pay full price, and the discount line just disappears from checkout. It only comes back when Stripe's expiry webhook cancels the old order, which by default happens after 24 hours. This also breaks Codex's own plan (reply 1 said "first successfully paid order").
- 🟡 **Unrequested change to Stripe receipts and the Stripe dashboard.** Line items went from one per product to a single "Crumb & Co pickup order" line. Customers and the owner no longer see what was bought in Stripe.
- 🟡 **The cancel page is a plain link (GET) that changes data.** No `require_POST` and no CSRF check. Any page a logged-in customer visits can cancel that customer's own pending checkout. It's limited to their own pending orders, so the harm is small.
- 🟡 **"New customers" in practice means "any account with no orders".** Old accounts that never ordered also get it. And checkout already required an account, so "if they make an account" adds no extra condition. That's a choice the owner should make.
- 🟡 Orders created through the API (`POST /api/orders/`) also take the discount. They never get a Stripe session, so they never expire, and the web discount stays locked for that customer. This is an edge case.
- ✅ Stripe really gets the discounted amount (`unit_amount: order.total_cents`). There's a test for it.
- ✅ The discount is decided on the server. Editing the cart in the browser can't grant it, because `cart.js` only displays it.
- ✅ Double checkouts are guarded twice: a row lock on the customer (works on Postgres) plus a partial unique constraint. On SQLite a race would end in an error page, not a second discount.
- ✅ The migration is present. It fills in old data (`subtotal = total`, discount 0), so past orders aren't changed.
- ✅ The cancel view checks login and only finds the user's own pending order.
- ⚠️ Tests were written but **not run**. Codex says so in its reply.

| | Codex "explain" | plain |
|---|---|---|
| What the discount does (20%, first non-cancelled order, server side) | ✅ clear and accurate | 🟡 only "orders now also store the subtotal and discount"; never says "20% off the first order" |
| Stripe charged the discounted amount | ✅ says so | 🟡 "checkout changed in a way plain can't describe… make a test payment 💰". Good warning, no detail |
| Stripe now gets one combined line, not itemized | ❌ silent | ❌ silent |
| Extra-account abuse | ❌ silent (its "to prevent abuse" list only covers races and JS tampering) | ✅ flagged as a guess ("sign up with another email") |
| Abandoned checkout holds the discount ~24h | 🟡 says "pending or paid → no discount" but not what that means for a customer who leaves | ❌ silent |
| Cancel link changes data on GET | ❌ silent | 🟡 lists the route and says "requires login ✓", but not the GET issue |
| Old no-order accounts also qualify | ❌ silent | ❌ silent |
| Migration / deploy order | ✅ | ✅ step 1 is correct |
| Tests not run | ✅ says the full suite still needs to run | ❌ missed. The "agent didn't test this" step is missing here, though it appears in trials 2 and 3 |
| `cart.js` change | ✅ (checkout summary) | ❌ wrongly marked "doesn't look related". It's the checkout discount display |
| Signup change | ✅ (offer message) | 🟡 "changed in a way plain can't describe", but only wording changed |

**False statements:**
- plain: "changed `shop/static/shop/cart.js`, which doesn't look related to what you asked for." False. It shows the subtotal, discount and total on the checkout page.
- Codex: none strictly false. "Stripe's expiration webhook provides another cancellation path" is listed as something it handled, but that webhook already existed on `main`. Its first reply promised the discount would apply to the first *paid* order, but the code applies it to the first *pending* order.

**Notes for plain**
1. **Describe Stripe line-item changes.** Rule: in a `stripe.checkout.Session.create` call, if the per-item loop (`for item in …`) inside `line_items` is removed and `quantity` becomes `1`, say "Stripe receipts now show one combined line instead of each item."
2. **Make the abuse warning concrete.** If the signup form has an `EmailField` but no `clean_email` / `unique=True` / verification flow, say "the same email can create many accounts". That turns the guess into a fact.
3. **Flag GET routes that change data.** A new view without `require_POST` / `require_http_methods` that calls `.save()`, `.delete()`, `.update()` or assigns `status` gets: "Visiting this link changes data. Other websites can trigger it for a logged-in customer."
4. **Fix the "unrelated file" false positive.** Treat a static JS file as related if its added lines use a `data-*` hook or id that a changed template in the same diff also adds (`data-discount-percent`, `data-cart-subtotal`). Never mark a file unrelated when the template that loads it also changed.
5. **Catch "didn't run tests" in every phrasing.** "Full Django tests couldn't run" and "still needs to be run" were missed. Match `tests? (couldn't|could not|can't) (be )?run`, `still needs? to be run`, and `not installed`. Always read the *latest* agent reply (`reply2`).
6. **Add a "decide" item for discount rules.** When a discount depends on an `Order…exists()` / `.exclude(status=CANCELLED)` check, ask: "Does an unpaid checkout use up the discount? Do old accounts with no orders get it too?" Both answers can be read from which statuses are excluded.
7. **Say when only wording changed.** If a route's diff only changes string literals (like a `messages.success` text), say "only the message text changed" instead of "plain can't describe".
8. **Explain new database constraints.** A `UniqueConstraint` with a `condition` becomes "the database now allows only one discounted active order per customer".

---

## Trial 2: Storefront owner with phone shoppers
> "add a search bar and category filter to the products page and make it look good on phones"

**What was built:** The home page (`/`) has a new search box (`?q=`, case-insensitive match on name or description) and a category dropdown (`?category=`). Both are server-side GET filters, applied when the customer presses "Show products". There's a "Clear filters" link and a "No treats match" empty state. A new `Product.category` field has 6 fixed choices (Bread, Pastries, Cakes & tarts, Cookies, Savory, Other), default "Other", with a migration. The owner product form and the owner product table get a Category field/column. The products API now returns `category`. Phone CSS changed: controls stack at full width, hero is smaller, product numbers are hidden, and there's a new ≤420px breakpoint.

**Ground truth: problems in the real code**
- 🟡 **Every existing product becomes "Other".** The migration only sets the default, with no data step. Right after deploy, picking "Bread" (or any category except Other) shows **nothing**. That lasts until the owner edits every product by hand. Codex said this once; it's the main thing the owner needs to do.
- 🟡 **The category list is fixed in code.** The owner can't add "Seasonal" or rename "Savory" without a developer.
- 🟡 **Unrequested visual changes on phones.** Hero heading changed from a fluid size to a fixed 3.6rem (3rem under 420px). Hero padding is smaller. Product numbers are hidden. The left indent is removed. All of this is reasonable for "look good on phones", but the owner should know the banner looks different.
- 🟡 Search is plain substring matching. "croissants" won't find "Croissant", and there's no typo tolerance. That's fine for a small bakery; it's worth saying.
- 🟡 The products API exposes `category` but can't filter by it. That's a request gap only if the app or API was meant to filter too.
- ✅ Only available products are searched. Unknown categories are ignored. The query is capped at 120 characters.
- ✅ Safe: the ORM `icontains` is parameterized, and the search text is escaped when shown back in the box.
- ✅ The migration is present. The new code reads `category` on the home page, so the home page breaks if the migration isn't applied.
- ⚠️ Tests were written but not run. The "search by name" test only searches a description word ("sourdough").

| | Codex "explain" | plain |
|---|---|---|
| Search on name and description | ✅ | ❌ "the main part of your server changed in a way plain can't describe" |
| Category filter + fixed list of 6 | ✅ lists them | 🟡 "Products now also store the category". No list, no mention of the filter |
| Existing products all set to "Other" (filter empty until recategorized) | ✅ one line ("receive Other until they are categorized") | ❌ silent, and says "No problems spotted" |
| Owner must edit each product's category | 🟡 implied only | ❌ silent (owner `product_list.html` shows only as "changed") |
| Phone layout changes, including unrequested hero/number changes | ✅ lists them all | 🟡 "changed how the app looks on small screens". Doesn't separate new from changed |
| API now returns category | ✅ | ❌ silent |
| Migration / deploy order | ✅ | ✅ |
| Tests not run | ✅ | ✅ |

**False statements:**
- Codex: says tests cover "search by name and description". Only a description match is tested; no test searches by name. That's a small overclaim. Its reply also calls the categories "editable", but the list itself is fixed in code (only each product's choice can be edited).
- plain: none false. "✓ No problems spotted" is misleading, given the empty-filter problem right after deploy.

**Notes for plain**
1. **New field + default on an existing table.** `AddField` with a `default=` on a model that already has rows, and no `RunPython` in the same migration, gets: "All your existing products will be set to 'Other'. Change each one, or the category filter will look empty." Count it as a problem, not "no problems".
2. **List fixed choices.** When a `TextChoices` / `choices=` list is added, print the labels and say "This list is fixed in the code. Adding one needs a developer."
3. **Describe GET filters.** `request.GET.get("q")` combined with `__icontains` on fields becomes "Customers can search by name and description". `filter(category=…)` from a GET param becomes "filter by category". That replaces "plain can't describe" for `/`.
4. **Separate new vs. changed CSS.** Inside a media query, say which existing selectors changed and how (`.hero h1 font-size`, `.product-number { display:none }`): "Also changed: the top banner is smaller on phones; item numbers are hidden on phones."
5. **Report API shape changes.** A field added to an existing serializer's `fields` becomes "The products API now also returns `category`."
6. **Describe owner-screen changes.** A changed owner template plus a field added to `ProductForm.Meta.fields` becomes "Your product form has a new Category field."
7. **Make deploy-order wording concrete.** If the new column is read by the view behind `/`, say "your home page will show an error until you migrate".

---

## Trial 3: Owner with an app developer (feature + API)
> "let logged in customers save favorite items and see them on a favorites page, also in the api"

**What was built:** A new `Favorite` table (customer, product, date) with a "once per customer per product" rule. A migration adds it, and the table is registered in admin. A new `/favorites/` page (login required) appears in the nav for logged-in users. It shows unavailable items with "Not available today" and a disabled Add to cart. There's a heart **toggle** button (POST + CSRF) on the product list and product page. Logged-out visitors see "Log in to save favorites" on the product page. The API gets `GET/POST /api/favorites/` and `GET/DELETE /api/favorites/{id}/` (login required, only your own). The existing product API (and products nested in order responses) now returns `is_favorite`.

**Ground truth: problems in the real code**
- 🟡 **The button is a toggle, so double-clicks and stale tabs undo the action.** `toggle_favorite` creates if missing and deletes if present. A double-click, or a second tab that still says "Save favorite", removes the item instead of saving it.
- 🟡 **The public product API response changed shape.** It now has `is_favorite`. So do order responses, through the nested product. That's harmless for most apps, but anyone already using the API should know.
- 🟡 Small: the API lets you favorite unavailable products (`Product.objects.all()`). Two requests at the same moment can hit the unique rule and return an error page instead of a clean "already saved" message.
- ✅ Login is enforced on every new endpoint: `@login_required` on both web views, `IsAuthenticated` on the API.
- ✅ No data leak between customers. The API queryset is filtered to `request.user`, so another customer's favorite returns 404 (tested). The page uses `request.user.favorites`.
- ✅ The toggle is POST-only with CSRF. The `next` redirect is checked against open redirects (tested).
- ✅ The migration is present. Deleting a customer or product removes their favorites.
- ⚠️ Nine tests were written but not run.

| | Codex "explain" | plain |
|---|---|---|
| Favorites page, save from list and detail | ✅ | 🟡 lists `/favorites` as "lists data". Templates only show as "changed" |
| Login required on every new endpoint | ✅ | ✅ "requires login ✓" on all four |
| Only your own favorites (no leak) | ✅ | ❌ silent. Says login, not ownership |
| Button saves **and removes** (toggle) | ✅ describes create-or-delete | 🟡 "saves new favorites", so the remove half is missing |
| Double-click / stale-tab undo risk | ❌ silent | ❌ silent |
| Product API now has `is_favorite` | ✅ | ❌ "product parts… plain can't describe" |
| One save per product (unique rule) | ✅ | ❌ silent ("stores favorites: customer and date created") |
| Migration / deploy order | ✅ | ✅ |
| Tests not run | ✅ | ✅ |

**False statements:**
- None found in either. Codex's "Duplicate saves return a validation error" is true except in a same-instant race, where the user gets an error page. plain's "/favorites/[pk]/toggle saves new favorites" is incomplete (it also removes), not false.

**Notes for plain**
1. **Say "only their own".** When a viewset's `get_queryset` filters by `request.user` (or a view reads `request.user.<related>`), add "✓ each customer only sees their own". That's the data-leak question owners care about, and the rule is simple. Without such a filter, flag it as 🔴.
2. **Describe toggles honestly.** If the URL name or path contains `toggle`, or the view does `get_or_create` followed by `.delete()` when it exists, say "saves or removes (one button does both)". Mention that a double-click undoes it.
3. **Report API shape changes on existing endpoints.** A field added to an existing serializer becomes "The products API now also returns `is_favorite`. Tell whoever uses your API."
4. **Explain unique constraints.** `UniqueConstraint(fields=["customer","product"])` becomes "a customer can save each item only once".
5. **Name pages from their template.** `/favorites` → `favorite_list.html` should read "a new Favorites page", not "lists data".
6. **Describe template changes.** A new `<form action="{% url 'shop:toggle_favorite' … %}">` inside an `{% if user.is_authenticated %}` in `product_list.html` / `product_detail.html` becomes "logged-in customers see a Save button on the product list and product page". A new nav link in `base.html` becomes "new 'Favorites' link in the menu".

---

### Cross-trial patterns
- plain's best moments: the extra-account abuse guess (T1), "requires login ✓" on every new route (T1, T3), migration-before-deploy (all three), and the 💰 test-payment nudge on checkout (T1).
- plain's biggest misses: it says nothing about real owner work or risk that its rules could detect. That covers the default-"Other" backfill (T2, while saying "No problems spotted"), the Stripe line-item collapse (T1), and the abandoned-checkout lock (T1). It also often falls back to "plain can't describe" on edited views (T1 signup/checkout, T2 `/`, T3 product views).
- plain made one false positive: `cart.js` marked "unrelated" (T1). It also missed "tests not run" once (T1).
- Codex's explanations were accurate. Their gaps are omissions, not lies: abuse via multiple accounts, the Stripe receipt change, and toggle double-click were never mentioned.

---

## Trial 4: Operations owner (a multi-step workflow with side effects: cancel and email)
> "Owner should be able to mark a product sold out for the day from the dashboard; cancel today's unpaid orders that include it and email those customers."

**What was built:** The owner dashboard ("Today's orders") gets a new "Today's product availability" table. Each product has a "Mark sold out" link. The link opens a confirm page that lists the unpaid orders that will be cancelled. On confirm, the code does four things:
- It saves a new `ProductSellout(product, date)` row. This is a new table, added by migration 0002.
- It locks the product and today's matching orders.
- It sets every PENDING order for today that contains the product to CANCELLED. The whole order is cancelled, not just that item.
- It emails each customer with `send_mass_mail`.

Checkout now also refuses a product that has a sellout row for the chosen pickup date. New email settings were added, and the default backend is the **console**. 4 tests were added.

**Ground truth: problems in the real code**
- 🔴 **Customers can still pay for a cancelled order.** The cancel only flips `status` in our database. It never expires the order's Stripe Checkout session, and there is no call to `stripe.checkout.Session.expire`. A customer who still has the Stripe page open can finish paying, since sessions live up to 24h by default. The webhook then runs `.filter(..., status=PENDING).update(PAID)`, which matches nothing, so the order stays CANCELLED. The bakery has taken the money, there is no order, and nothing triggers a refund. The email even says "no refund is needed." The same thing happens if the payment webhook arrives just after the sellout.
- 🟡 **"Sent N emails" can be untrue in production.** `EMAIL_BACKEND` defaults to the console backend in every environment, not just DEBUG. If the owner doesn't set `EMAIL_BACKEND`, plus `EMAIL_HOST`, user, password and `DEFAULT_FROM_EMAIL`, the emails go to the server log. The dashboard still says "sent 3 emails".
- 🟡 **Email failure handling is coarse.** All emails go through one `send_mass_mail` call. If one address fails partway through, the owner sees "the customer email could not be sent". They are not told which customers got it. There is no retry, and the failure is only written to the log. Customers with no email on file are skipped silently, though the count shown to the owner is lower.
- 🟡 **No undo.** Once a product is marked sold out, the only way back is deleting the `ProductSellout` row in Django admin. Cancelled orders can't be restored.
- 🟡 **The checkout guard does nothing in practice.** It blocks orders for a sold-out date, but pickup must already be tomorrow or later (`validate_pickup_date`). A same-day sellout therefore never blocks anything. It is harmless, but the explanation makes it sound like a real protection.
- 🟡 **Deploy order matters.** Migration 0002 must run before the new code, or the dashboard crashes because the table is missing.
- ✅ Paid, ready and completed orders are not touched (`status=PENDING` filter, plus a test). Orders for other dates are not touched either.
- ✅ The change runs inside a transaction with `select_for_update` on the product and the orders. Emails are sent after the commit, so an email failure doesn't undo the cancel.
- ✅ Only staff can do this (`StaffRequiredMixin`, plus a test). The confirm form is a POST with CSRF protection. Running it twice is harmless, because of `get_or_create` and a unique constraint.
- ✅ The confirm page shows the owner who will be affected before anything happens.

| | Codex "explain" | plain |
|---|---|---|
| What it does (sold-out button, confirm page) | ✅ clear | 🟡 "lists products, saves new ones": "saves new ones" sounds like new products |
| **It cancels customer orders** | ✅ said plainly | ❌ silent. The biggest side effect is missing |
| Paid orders untouched | ✅ | ❌ silent |
| Customers can still pay in an open Stripe session (🔴) | ❌ silent; repeats "no refund is needed" | ❌ silent ("No problems spotted") |
| Email config needed in production | 🟡 "Production SMTP values can be supplied". Doesn't warn that the default sends nothing | 🟡 asks for `EMAIL_HOST_USER` and `EMAIL_HOST_PASSWORD` only. Misses `EMAIL_BACKEND` (the one that matters), `EMAIL_HOST` and `DEFAULT_FROM_EMAIL` |
| Email failure behavior | ✅ "cancellation remains, owner sees a warning" | ❌ silent |
| Email addresses shared with a provider | ❌ silent | ✅ |
| Migration before deploy | ✅ "run migrate" | ✅ correct and well worded |
| Owner-only | ✅ "non-staff users" | 🟡 "requires login ✓". It actually needs staff, so plain undersells it |
| Not tested | ✅ honest (Django not installed) | ✅ |

**False statements:**
- Codex: "That no refund is needed because payment was still pending." This is quoted from the email. It is wrong whenever the customer pays in the still-open Stripe session after the cancel.
- Codex: "preventing an order from slipping through during the sellout operation." This is technically true on Postgres, but it can't matter for a same-day sellout, because checkout already rejects same-day pickup. It is misleading, not strictly false.
- plain: "✓ No problems spotted." With the 🔴 above, this is wrong.
- plain: "saves new ones." The new endpoint saves a sellout record and cancels orders. It does not save new products. This is misleading.

**Notes for plain**
1. **Flag status-to-cancelled code that leaves Stripe alone.** If the diff sets `Order.status` to a CANCELLED/REFUNDED-like value (`.update(status=...CANCELLED)`, `bulk_update([... "status"])`, or `order.status = ...CANCELLED`), and the model has a `stripe_session_id` or payment-intent field, but the diff has no `stripe.checkout.Session.expire`, `stripe.Refund.create` or `PaymentIntent.cancel`, then raise a 🔴. Suggested wording: "Cancelled orders may still be payable in Stripe, so you could take money for an order that no longer exists."
2. **Describe bulk status changes as a side effect.** Look for `bulk_update(..., ["status"])`, `.update(status=X)` and `status = X` followed by a save. Report them as "This can cancel customer orders (only ones awaiting payment)". Read the filter's `status=` value to say which orders. Today the card never says orders get cancelled.
3. **Email settings: name the setting that actually matters.** When `EMAIL_BACKEND` defaults to `console`/`locmem`/`dummy` and settings don't switch on DEBUG, the first step should be "Set EMAIL_BACKEND to your mail provider, or no emails reach customers (the dashboard will still say 'sent')". Then list every new `os.environ.get("EMAIL_*")` and `DEFAULT_FROM_EMAIL`, not just the secrets.
4. **Wording for new endpoints.** "Saves new ones" should name the model that gets created, e.g. "records a product as sold out for a day". Also note any status change. If the view class uses a staff/superuser mixin (`StaffRequiredMixin`, `is_staff`, `IsAdminUser`), say "owner-only ✓" instead of "requires login ✓".
5. **Email failure handling.** If `send_mail`/`send_mass_mail` is wrapped in `except Exception` that only logs and warns, add a 🟡: "If email fails, customers are not told and the app does not retry. Check the owner warning."
6. **Customer-facing promises in strings.** Grep new email and message text for "no refund", "won't be charged" and "refund". When the order can still be paid (see note 1), point to that sentence.

---

## Trial 5: Money-minded owner (exact pricing spec plus a concurrency demand)
> "Move all pricing into shop/pricing.py, add a 6.25% sales tax and a $1 bag fee, keep Stripe amounts matching, and never take more orders than a product's daily_limit even if two people check out at once."

**What was built:** There is a new `shop/pricing.py`. It holds the line totals, cents/dollar formatting, the tax (Decimal, `ROUND_HALF_UP`), the bag fee and `price_order()`. It also builds the Stripe line items, and it checks that items + tax + fee equal the stored total before calling Stripe. Orders get `subtotal_cents`, `tax_cents` and `bag_fee_cents` (migration 0002). Old orders are backfilled as subtotal = total, with 0 tax and 0 fee. Stripe now receives the products plus a "Sales tax (6.25%)" line and a "Bag fee" line. The checkout page, the order history and the API now show the breakdown. For the daily_limit, the existing `select_for_update` lock was kept. Codex added only a comment and a two-thread test.

**Ground truth: problems in the real code**
- 🟡 **The daily_limit lock is not new, and it only works on Postgres.** On `main`, `create_order` was already `@transaction.atomic` with `Product.objects.select_for_update().order_by("pk")`. Codex added a comment and a test. On Postgres, the default for `psycopg` in requirements, the lock holds and two buyers can't oversell. On SQLite, the fallback in `settings.py` and `.env.example`, `select_for_update` does nothing. The new concurrency test is `@skipUnlessDBFeature("has_select_for_update")`, so it is **skipped** there. On SQLite the second simultaneous buyer most likely gets a "database is locked" error page rather than an oversell. That is a crash, not lost stock.
- 🟡 **Stock can be locked up without payment (not new, not addressed).** Unpaid (PENDING) orders count against `daily_limit`. Orders created through `POST /api/orders/` never get a Stripe session, so they never expire. Any logged-in customer can "reserve" a product's whole day through the API. That doesn't break "never take more than daily_limit", but it can make a product look sold out when it isn't.
- 🟡 **Owner decision: tax doesn't cover the bag fee.** Tax is charged on items only. Whether a bag fee is taxable depends on local law. Nothing is wrong in the code, but the owner should confirm.
- 🟡 **Deploy order matters.** Migration 0002 must run before the new code, because `create_order` writes the new columns.
- ✅ **The Stripe charge equals the stored total.** The line items are the products, `tax_cents` × 1 and `bag_fee_cents` × 1, which sum to exactly `total_cents`. `stripe_line_items` raises `PricingError` if they don't, and the view deletes the order and shows an error. The `except PricingError` sits before `except ValueError`, so it is caught correctly. A test checks the sum.
- ✅ **Rounding is right.** Decimal half-up on whole cents (40¢ → 2.5¢ → 3¢). The checkout page's JS uses `Math.round(subtotal * 0.0625)`. 0.0625 is exact in binary, so the shown tax matches the server for every positive subtotal.
- ✅ Old orders keep their historical totals. The ProductForm dollar-to-cents conversion is still exact (Decimal).
- ✅ All server pricing now lives in `pricing.py`. The JS mirrors the tax only for display, using the server's rate.

| | Codex "explain" | plain |
|---|---|---|
| pricing.py created; tax and fee added | ✅ with a worked example | ✅ "created shop/pricing.py, as you asked". Says nothing about tax or fee |
| Stripe total = stored total | ✅ explained with the guard | 🟡 "can't describe … make a test payment". Honest but empty |
| Rounding rule | ✅ half-up | ❌ silent |
| daily_limit under concurrency | 🟡 explains the lock correctly, but presents it as new work (it was already there) and doesn't mention that it is Postgres-only | ❌ silent on an explicit request |
| Concurrency test skipped on SQLite | ❌ "including a two-thread checkout test", without saying it skips | ❌ silent |
| Old orders preserved | ✅ | ❌ silent |
| Orders store the breakdown | ✅ | ✅ |
| API now shows tax and fee | ✅ one line | ❌ silent (api/serializers.py not listed) |
| Checkout page JS computes tax | ✅ "updated the checkout … screens" | ❌ cart.js not listed |
| Migration before deploy | ✅ | ✅ |
| Not tested | ✅ honest | ✅ |

**False statements:**
- Codex: none strictly false. The heading "4. Protected the daily limit from concurrent checkouts" implies Codex added the protection. It already existed on `main`, and Codex only added a comment and a test. "Customer B waits for that lock" is true on Postgres only.
- plain: "✓ No problems spotted." This is defensible for this diff. The serious risks were already there or depend on which database is used. plain gave no statements about the concurrency request, so it said nothing false there. It just said nothing.

**Notes for plain**
1. **Check the request against the diff.** When the request names a concurrency need ("two people at once", "at the same time", "race", "never more than X"), look in the changed function for `transaction.atomic` plus `select_for_update`. Report one of three things:
   - (a) "Already protected before this change. The agent didn't change it."
   - (b) "Added".
   - (c) "Not found" (🟡).

   You can tell (a) from (b) by checking whether the `select_for_update` line is a context line or an added line.
2. **Database-dependent locking.** If `select_for_update` is used and `DATABASES` falls back to `sqlite` (or `.env.example` has `sqlite:///`), add: "This lock only works on Postgres/MySQL. On SQLite it does nothing." If a test has `skipUnlessDBFeature("has_select_for_update")`, say "the test for this is skipped on SQLite."
3. **Say the money math in words.** For a new module-level constant like `*_TAX_RATE = Decimal("0.0625")` or `*_FEE_CENTS = 100`, write "Adds 6.25% tax and a $1.00 fee to every order". Detect `ROUND_HALF_UP` vs `ROUND_HALF_EVEN` vs `int()` truncation and name the rule. If a Stripe `line_items` builder adds lines named tax/fee, say "Customers see tax and bag fee as separate lines in Stripe".
4. **Look for a guard that sums the Stripe lines.** If the code compares the sum of the line items to `total_cents` and raises on mismatch, say "✓ Stripe can't charge a different amount than the order shows". If there's no such guard and the line items are built from something other than the stored total, flag it.
5. **List every changed file group.** api/serializers.py ("the API now also returns …") and cart.js ("the checkout page now calculates …") were dropped. Fields added to a DRF `fields=` tuple map easily to "The orders API now also returns subtotal, tax and bag fee."
6. **When a pre-existing route weakens a requested limit, add a short note.** For example, a DRF `ModelViewSet` with `post` creates PENDING orders without a payment session. Lower priority.

---

## Trial 6: Vague complainer (no repro, no numbers)
> "checkout is buggy sometimes and the orders api feels slow, fix it"

**What was built:**
- **Checkout:**
  - cart.js now works out "tomorrow" from the browser's local date instead of `toISOString()` (UTC). This is a real bug: in Chicago evenings, the earliest pickup date and the default date jumped a day too far.
  - The Stripe `success_url` now carries `?session_id={CHECKOUT_SESSION_ID}`.
  - `/checkout/success/` now 404s unless the session id belongs to the logged-in user. It shows "Order #N" and only then clears the cart.
- **Orders API:**
  - `product_id` is now a plain integer, which removes one product query per cart line on POST.
  - Reserved stock is counted with one grouped query instead of one per product.
  - The list view uses `Prefetch(... select_related("product"))`.
  - There is a new index on `(customer, -created_at)` (migration 0002).
  - A test pins the list at 3 queries.

**Ground truth: problems in the real code**
- 🟡 **Customers already paying at deploy time get "Page not found".** Stripe sessions created before the deploy still redirect to `/checkout/success/` with no `session_id`. The new view returns 404 to customers who **just paid**, and their cart is not cleared. They may think payment failed and pay again. This affects sessions up to 24h old.
- 🟡 **The "slow" fix is a guess, and the gain is tiny.** On `main` the order list was already prefetched: count + orders + items + products = **4 queries**, not N+1. Now it is 3. The index only helps customers with very many orders. The POST change saves 1 query per cart line. Nothing was measured. One likely real cause was not checked: DRF `BasicAuthentication` is on, so every Basic-auth API call re-hashes the password with PBKDF2 (roughly 0.3–0.5s each). This is my hypothesis and is not verified.
- 🟡 **The "buggy" fix is a partial guess.** The date bug is real and fixed ✅. The success-page change is hardening, not a fix for anything the owner reported. Other "sometimes" causes were not looked at:
  - The webhook marks PAID on `checkout.session.completed` without checking `payment_status`, which matters for delayed payment methods.
  - A double-click on "Continue to payment" creates two pending orders that both hold stock.
  - The browser uses its own timezone, while the server uses America/Chicago.
- 🟡 **The success page says "has been received" for any of the user's sessions,** even unpaid, expired or cancelled ones. The existing text "We'll update your order as soon as Stripe confirms it" softens this.
- 🟡 **The API error shape changed.** A bad or unavailable `product_id` used to give a per-field error inside `items`. It now gives `{"detail": "..."}`. Any app that reads the old shape breaks. This was not asked for.
- 🟡 **Fragile test.** `CheckoutTests` hard-codes `"product_id": 1`. That passes on SQLite, but on Postgres the ID sequences aren't reset between tests, so the test can fail.
- ✅ The new success page can't be used to view another customer's order (`customer=request.user` plus a test).
- ✅ The grouped reserved-count query is correct (`values().annotate(Sum)`, still under the product lock).
- ✅ The index migration is safe. Nothing in the code depends on it.

| | Codex "explain" | plain |
|---|---|---|
| Date bug: what and why | ✅ clear and correct | ❌ silent (cart.js not listed) |
| Success page now needs a session id | ✅ | 🟡 "changed in a way plain can't describe yet. Ask the agent" |
| 404 for customers already in a Stripe session at deploy | ❌ silent | ❌ silent |
| API speed changes | 🟡 accurate list, but doesn't say the list was already 4 queries (a 1-query gain) | ❌ silent. api/views.py and serializers.py not mentioned at all |
| Says the fixes are guesses or unmeasured | ❌ presents them as fixes | ✅ "You didn't say exactly what was wrong, so the agent guessed. Check that the problem you saw is gone." |
| API error format changed | ❌ silent | ❌ silent |
| Migration | ✅ "run migrate" | ❌ says the code "will fail" without it. Untrue: it is index-only |
| Not tested | ✅ honest | ✅ |

**False statements:**
- plain: "Apply shop/migrations/0002_order_customer_created_index.py … or the parts that use it will fail." The migration only adds an index, and no code depends on it. Skipping it is harmless. The order is still good practice, but the stated consequence is false.
- plain: "✓ No problems spotted." This misses the deploy-time 404 for customers who just paid.
- Codex: "Removed per-item product queries" and "Reduced nested loading" are true. But the framing ("reduced database work in the orders API") implies the slowness is fixed, and nothing was measured. That is misleading, not false. Nothing Codex said is strictly false.

**Notes for plain**
1. **Detect index-only migrations.** If every operation in a migration is `AddIndex`, `RemoveIndex` or `AlterIndexTogether`, change the step to: "Adds a speed-up index. Safe to run before or after deploy. On a big table it can briefly block writes." Don't say "will fail".
2. **Catch success URLs that change while a view gets stricter.** Flag 🟡 when a diff changes a Stripe `success_url`/`return_url` (new query params) and also makes the matching view stricter (`get_object_or_404`, `request.GET[...]` required). Suggested wording: "Customers who are mid-payment when you deploy will land on an error page after paying."
3. **Name what each "fix" changed in the vague case.** List each changed area as a separate claimed fix, e.g. "Speed: API now uses fewer database queries (1 fewer per page)." You can count queries from `prefetch_related` / `select_related` / `Prefetch` changes and from a new `assertNumQueries(n)` test. Say "Not measured" when there's no benchmark or timing.
4. **List all changed code files.** The card dropped cart.js, api/views.py, api/serializers.py and services.py. A vague request needs this most, because the owner has to see which "fix" touched what. Group them: "Checkout page (date picker)", "Orders API", "Order saving".
5. **Spot a changed API error shape.** If a DRF serializer field is swapped (`PrimaryKeyRelatedField` → `IntegerField`) or validation moves into `create()` with `{"detail": ...}`, add: "Error messages from the orders API look different now. Apps that read them may need updating."
6. **Flag hard-coded IDs in tests.** Flag `"product_id": 1`, `pk=1` and `/1/` in a new test file as "may fail on Postgres". Low priority.
7. **For "slow" complaints, name likely causes from the settings.** If `BasicAuthentication` is in `DEFAULT_AUTHENTICATION_CLASSES`, say "API logins with a password re-check it on every request, which is slow by design". That is a fixed rule plain can apply, and the owner can test it.

---

## Scorecard (plain at the start of this round)

| | Codex "explain" | plain |
|---|---|---|
| Says what the feature does | ✅ accurate in all 6 | 🟡 routes, logins and tables right; "can't describe" on most edited views |
| 🔴 problems caught | 0 of 1 (cancelled orders can still be paid, trial 4) | 0 of 1 |
| Login on every new address | 🟡 said in passing | ✅ "requires login ✓" right on all of them |
| Database update / deploy order | ✅ | ✅ "apply before the new code goes live" on every migration (too strong for an index) |
| False statements | 2 small overclaims (tests "cover search by name"; the oversell lock presented as new work) | 3 (cart.js "not related"; "will fail" for an index-only migration; "No problems spotted" next to real ones) |

**The honest result.** Django support itself held up: every route, method, login check and
table in the bakery app was read correctly, including DRF's router, `http_method_names`, a
custom staff mixin, and the settings default. The misses were the same kind as round 3:
consequences that depend on what happens *later* (a customer paying on a page the owner
already cancelled) and on data already in the database (every product becoming "Other").

## What we changed in plain (same day)

Each rule was checked against the six bakery trials and every earlier demo, so that it fires
where the graders found a real problem and stays quiet where they didn't.

| Gap | Fix | Result |
|---|---|---|
| Cancelled orders can still be paid (4) | Cancelling unpaid orders while the app uses Stripe Checkout, and nothing closes the payment page (`Session.expire`) or refunds: "Cancelled orders can still be paid…". Code that reacts to Stripe's own "expired" event, and test files, are skipped | Bakery 4. Quiet on yoga's expired-session webhook and on yoga 6, which closes the page first |
| Charged, then cancelled (dog 5, a known miss since round 2) | The same code confirms the payment (`payment_status`, `sessions.retrieve`) and then cancels: "Someone can be charged and then have their booking cancelled… and nothing refunds them" | Dog 5 |
| Every existing product became "Other" (2) | A new text field with a default, on a table that already had rows: "Every product you already have gets "other" as its category" | Bakery 2 |
| Changes data on a plain visit (1) | A Python view that changes or deletes things on a GET (a Django view with no method check answers GET): "changes things when someone just opens its address" | Not on views that only write on POST, view counters, email-confirm links, or Stripe's return links. Bakery 1's cancel link *is* Stripe's `cancel_url` (Stripe sends people back with a GET), so it stays quiet there: making it POST-only would break checkout |
| Emails may never go out (4) | Django sending email with `EMAIL_BACKEND` unset or console: "Turn on real email sending…" | Bakery 4 |
| "Will fail" for an index-only migration (6) | Index-only migrations: "It only makes lookups faster, so nothing breaks if it runs later" | Bakery 6 |
| Changed files left off the card (all) | "The agent also changed shop/services.py, api/serializers.py…" for Python files the card doesn't otherwise mention | All six |
| "Didn't test" missed (1) | "still needs to be run" | Bakery 1 |
| "⚠ 1 problem" over a line that was only a guess | Unasked-change guesses count as things to decide | Bakery 1 |
| "saves new ones" meant sell-out records, read as products (4) | Name the table that's created | Bakery 4 |
| "(like Vercel)" for a Django app | Dropped for Python apps | All six |
| Not found by the graders, found while building Django | Django `send_mail`; `order.save()` / `order.delete()`; helpers a view calls (`create_order()` in services.py); query chains split over lines | Bakery checkout, webhook, sold-out |

## Still open (backlog, by impact)

1. **Payments and later events.** A success page that now needs an ID that payment pages
   opened before the deploy don't send (6). The oversell lock that only works on Postgres (5).
2. **"Can't describe" on edited views.** Say what changed inside a view: new filters, a
   discount, items collapsed into one Stripe line (1).
3. **"Only their own".** A query filtered by `request.user` could say so, as Supabase cards do.
4. **API shape.** New fields on an existing serializer (`is_favorite`, `category`).
5. **Django templates.** What pages say is in `templates/`, which plain doesn't read yet.
