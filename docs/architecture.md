# Architecture

plain compares two snapshots of your app and describes the difference in plain English.
Every sentence is a fixed template filled with facts read from the code. Nothing is generated
by a model, so the same change always gets the same card.

```
two snapshots (git refs, or the files on disk)
      │  1. facts per file      what each file does: addresses, database calls, login checks, ...
      ▼
facts per file
      │  2. facts per app       which file is which page or server address, what the database stores
      ▼
the app before + the app after
      │  3. compare             what's new, removed or changed; what's risky; what's unfinished
      ▼
changes + problems
      │  4. English             fixed sentence templates
      ▼
the card
```

Most of it is in [src/plain.ts](../src/plain.ts). Per language or format:

- [src/python.ts](../src/python.ts): Python files (FastAPI, Flask, Django) with tree-sitter.
- [src/supabase.ts](../src/supabase.ts): SQL migrations with the real Postgres parser.
- [src/sfc.ts](../src/sfc.ts): `.vue` and `.svelte` files turned into TSX, and Nuxt / SvelteKit
  file routes.
- [src/csharp.ts](../src/csharp.ts), [src/java.ts](../src/java.ts), [src/php.ts](../src/php.ts), [src/rb.ts](../src/rb.ts), [src/go.ts](../src/go.ts):
  ASP.NET Core, Spring Boot, Laravel, Rails and Go files with tree-sitter (who each address lets in is then worked out in
  `appFacts`, across files). [src/treesitter.ts](../src/treesitter.ts) loads the grammars from `vendor/`.

[src/session.ts](../src/session.ts) adds the per-prompt snapshots and `plain recap`;
[src/cli.ts](../src/cli.ts) is the command line and the Claude Code hooks.

## 1. Facts per file

`fileFacts(path, text)` parses one file with the TypeScript compiler and collects:

| Fact | Read from (examples) |
|---|---|
| Server addresses | Next.js `app/**/route.ts` and `pages/api/*`; Express-style `router.post('/x', requireAuth, handler)` |
| Mounts | `app.use('/api/admin', requireAuth, adminRouter)`, `app.use('/api/x', require('./x'))` |
| Pages | Next.js `app/**/page.tsx` and `pages/*`; React Router `<Route path element>` and `{ path, element }` |
| Login checks | an `if` that turns guests away, guard middleware (`requireAuth`, `verifyToken`), wrappers like `<RequireAuth>`. Next.js route handlers and pages/api get "requires login ✓" only when each method's own `if` tests a name set from an awaited session call (`const session = await auth()`, `getServerSession`, `supabase.auth.getUser()`, ...), or awaits a `require*()` / helper plain can find whose check throws or redirects. Calling `auth()` and ignoring it isn't one. Where plain can't tell (a wrapper, a switch, a check inside `try`, a helper it can't find), it says neither ✓ nor ⚠. So does a check it can see but not prove: `if (!session) return 401` on a name from an awaited session getter imported from an auth or session module (`getMobileCompatibleSession(req)`), as the very next statement, with nothing handing the request off first. |
| Admin-only | a login check whose deciding line turns away non-admins (`!u.IsAdmin`, `unless current_user&.admin?`, `role !== 'admin'`, Spatie's `role:admin`). This is read in Go, Rails, Laravel, and Express middleware written in the app. Elsewhere, an admin check still reads as "requires login". |
| Database | `prisma.<table>.<call>`, `db.<table>.<call>` and `supabase.from('<table>').<call>`: which tables are read, which are written and how |
| Talks to the server | `fetch('/api/x', { method })`, `axios.post('/x')`, and your own helpers like `api('/x')` |
| On screen | headings, buttons, boxes (named by their label), forms, links |
| Outside services | imports (`stripe`, `openai`, `resend`, ...) and calls on their clients |
| Loose ends | `TODO`s, empty `catch`, `any`, functions that return made-up data |

A route handler's facts belong to its address, not to the whole file. That way a public `GET`
and an unprotected admin `DELETE` in the same file are judged separately.

## 2. Facts per app

`appFacts(snapshot)` connects the files:

- **Routes.** Each page and server address is matched to the file (or, for Express, the
  `file#/address` unit) that handles it. Mount prefixes and guards are followed up the chain, including routers
  imported under another name. A FastAPI router mounted somewhere plain can't follow (from a list built at runtime) gets
  a partial address, `/…/[username]`, and is named for its folder, instead of a short address that looks real. A prefix
  that isn't written out (`prefix=settings.API_V1_STR`) is `…` too.
- **Pages include their components.** A page also does what the components it imports do, except the app's frame (a
  component named Layout, AppHeader, Sidebar, Navbar or Footer, or anything in `layouts/`), and except a context's login,
  logout and `GET /me` calls (`useAuth()`): those are the whole app's, though they still count against "It only shows
  information" and toward the admin and login checks. A page that imports a file that isn't in the project never gets
  "It only shows information".
- **Helpers are resolved.** `api('/bookings')` becomes `/api/bookings` when `api` wraps
  `` fetch(`/api${path}`) ``, or `` fetch(`${API_URL}/api${path}`) `` when `API_URL` is named for the
  app's own server and holds only env reads and localhost (not `OLLAMA_URL` or another company's API).
- **The database** comes from `schema.prisma`, or from replaying `supabase/migrations/*.sql`
  with the real Postgres parser ([src/supabase.ts](../src/supabase.ts)). The replay also gives
  who each table's access rules let in.
- **Env vars** come from the code and from every `.env.example`; packages from every `package.json`.

## 3. Compare and 4. English

`analyze(before, after)` finds what's new, removed and changed. A JS/TS file whose code is the same once comments and
formatting are set aside, or the same apart from parameters nobody reads at the end of a function's list (`async (event)`
becoming `async ()`), counts as unchanged. It applies to functions defined on their own and to callbacks of wrappers known not to
count parameters (Nuxt's `defineEventHandler`, a promise's `.then`/`.catch`/`.finally`; `_ => x` reads as `() => x`), never to other callbacks: libraries count them (Express error handlers,
vue-router's `next`, Svelte's `derived`, Jest's `done`). It never applies to setters, constructor parameter properties or decorated parameters. Then it checks for problems:

- **An admin check dropped.** An address that was admins-only now lets anyone with an account in
  (login kept). This is a thing to decide.
- **Missing login checks.** An address that changes data has no login check. It's flagged as
  ⚠ if the address or table sounds sensitive (admin, orders, payments, ...), and as a "thing to
  decide" otherwise. Addresses that must be public (login, register, webhooks, ...) are never
  flagged.
- **Broken.** A new import of a folder that isn't in the project (papermark imported `@/ee/features/redaction/...`, a folder
  that doesn't exist): the app won't build. Strict, because files made at build time look missing too. It counts only an
  import new in this commit, read from the syntax tree (not text in a string, not `import type`), whose folder has no files
  inside the importing file's own project. `@/` is resolved through tsconfig `paths` and `baseUrl`, Vite's `alias`, and
  every folder above. Never for a gitignored path, a generated-looking one, a folder a generator's config or a script names,
  a symlink or submodule, or a path that differs only in letter case.
- **Broken.** A file cut off or left unbalanced (LinkStack's `functions.php` lost the end of a function). For JS/TS: TypeScript
  newly reports "'}' expected.". For PHP, Java, C# and Go: the parser newly finds an error *and* the braces no longer
  balance, with strings, comments and heredocs taken out first. A newer language feature the parser doesn't know never
  unbalances braces. Not for PHP files with HTML after `?>`.
- **Broken.** A function was deleted but other code still uses it, or a migration starts with terminal output pasted in.
  For PHP: a global function defined before and nowhere now, still called as one in another PHP or Blade file (not a
  method, a `function_exists` polyfill, a Laravel helper's name, JavaScript in `<script>`, or text in strings; held back
  when a Composer package was added, since the helper may have moved into it)
  ("Already up to date", "$ npx prisma migrate dev").
- **A package removed that code still uses.** A package no package.json lists any more (dependencies, dev, peer or optional)
  that the app's own code still imports or requires, read from the syntax tree. This is a thing to decide, since another
  package may bring it along. Not Node's built-ins, `@types/`, `server-only`/`client-only`, names a bundler, tsconfig, Babel
  or Deno config mentions (aliases), tests, test setup files or stories.
- **Unsafe data and uploads** (from misses in the [production pilot](production-eval.md)):
  - Bank account, card, IBAN, Social Security or passport numbers newly stored as plain text in any model plain reads.
    An account number counts only on a bank model, or next to a routing, IBAN or payout field: a CRM's `accountNumber` is
    a reference. A card number counts only on a payment card, not a loyalty card or a flashcard. Not flagged when some line
    names that field together with encryption (Rails `encrypts`, a Laravel `encrypted` cast, `EncryptedCharField`,
    `/// @encrypted`). Routing and SWIFT codes aren't flagged, because they're public.
  - An upload list that newly takes SVG (`mimes:...,svg`, an `accept`, an allowed or valid list), counted over the changed
    files together, so moving a list between files doesn't count. It skips help text ("SVG, PNG or JPG"), output and
    export formats, content-type maps, docs and translations.
  - A Blade, ERB or Django/Jinja link that newly points straight at a saved address field (`href="{{ $link->link }}"`,
    `link_to ..., @user.website`), for a field some table stores. It skips a `.url` the app makes itself (an upload's `file.url`, a `post.url`), a Django
    `URLField`, and a field whose scheme some line of the app's own code checks. Angular templates clean such links
    themselves. JSX, Vue and Svelte are skipped, because their links mostly come from fixed menu lists.
  - A Stripe webhook whose `try` around a database write has a `catch` that logs and carries on: no throw, no return, no
    error status. Stripe then counts the event as delivered and never retries. A `catch` that answers on purpose (an event
    already handled), sets a flag checked later, or guards a best-effort write inside a `try` that answers is a decision,
    so it isn't flagged. Neither is a Python `except` for a row that isn't there or an event already saved. Only the function that checks the signature is read (JS/TS and
    Python), and calls that don't touch the database (an SMS, a Stripe call) don't count.
  - A Stripe webhook that starts handling an event the app didn't handle before gets a step to make sure the endpoint
    receives it. Not `checkout.session.async_payment_succeeded`/`_failed` when every Checkout the app makes takes cards
    only (each `checkout.sessions.create(...)` in the app's code, not tests, says `payment_method_types: ["card"]`, and
    nothing else makes Checkouts: Payment Links, a pricing table, another SDK): card payments are never "pending".
  - Translation files (`locales/en.ts`, `messages/en.json`, `config/locales/en.yml`; not vendored ones, not code in a
    `messages/` folder): "The agent added wording in the app (in locales/en.ts): "Add exercise" ..., and the same in N other
    languages". Wording is a string value that reads as words (not a URL, `true`, an anchor, a plural rule or markup); a key is
    added when it's there more times than before, else changed. Other languages count only for the same file with the same keys.
  - Code-style settings (`.eslintrc.*`, `eslint.config.*`, `.prettierrc*`, `biome.json`, `.editorconfig`) read "the settings for
    code style checks (not what the app does)", not "changed in a way plain can't describe".
  - A stylesheet's new `@media (max-width: ...)` block reads "changed how the app looks on small screens like phones" only
    when nothing outside those blocks changed (comments aside; spaces only where they don't matter). With rules for every
    screen size too: "on every screen size and on small screens like phones".
  - Code with no login check that deletes stored files (UploadThing `deleteFiles`, S3 `DeleteObject`, Cloudinary `destroy`,
    Supabase storage `remove`, Vercel Blob `del`, Firebase `deleteObject`, Laravel `Storage::delete`), whenever it changed:
    "Anyone may be able to use X to delete files from your storage". Not when its own code checks something (a login call, a
    secret header like `CRON_SECRET`, a webhook signature), nor when an app-wide guard mentions login.
  - A new way to delete your own account: a DELETE on an address that is only `/me`, `/account` or `/profile` (not
    `/teams/[id]/members/me` or `/stripe/account`), or new code that deletes from the users table (`DELETE /api/user`, `deleteAccount`). This is a thing to decide: ask the person to confirm first, and
    clean up the rest of their data. It isn't raised when the code already checks the password.
- **No "doesn't look related" guess.** It used to flag code that didn't seem to match the request. On 70 real commits it was
  wrong 42 times in 45, mostly on the file that was the fix, so it's gone ([production pilot](production-eval.md)). There's
  also no check for imports of missing files: a generated, gitignored file looks the same as a missing one.
- **Guesses about money, worded as questions.** Each one says it's a guess:
  - A cancel status with no refund anywhere.
  - A sign-up discount that people can claim again with another email.
  - Unpaid checkouts that now take up a spot (a seat, a time slot, a day's orders) with nothing that
    frees them, or old unpaid ones already in the database that a new limit starts counting.
- **Limits and AI answers.** Limits written as constants (new, changed, replaced, gone, "no limit now"), and limits whose
  number is a setting's fallback (`getattr(settings, "MAX_PAGE", 10_000)`, `int(os.getenv("X", "50"))`,
  `Number(process.env.X ?? 3)`), said with "your settings can change it". A fallback of 0, an on/off switch
  (`RATE_LIMIT_ENABLED`), or one the app's settings set to a number elsewhere isn't read that way. A guess when a
  per-day limit is replaced by one that never resets, and when AI answers get a length cap nothing checks.
- **Live connection (Socket.IO).** The events the server now takes and what each one does, with "Connecting needs a
  login ✓" from its own `io.use` guard. A guard that's gone is a thing to decide. An event reads "room members only ✓"
  when its first step turns away anyone not in the room it names, on the logged-in socket user, and everything after
  stays in that room. Every name the handler uses is resolved with the language's own scoping (`outerRefs` in
  `src/members.ts`) and must be the user, the socket, the server, Prisma, the member check, or a helper that touches
  nothing.
- **Uploads.** A new way for people to send files is described: what's accepted, how big, and where files go. It's a
  guess-worded problem when nothing caps the size, or how much one person can upload (except admin-only uploads), or when
  SVG is allowed.
- **Money, said for what it does.** "charges customers 💰" only for Stripe calls that charge (checkout, payment intents,
  charges, subscriptions, invoices, payment links, capturing or paying). A refund "gives customers money back 💰", a new
  price "adds a price in Stripe 💰", a coupon "creates a Stripe discount 💰", payouts "send money out of your Stripe balance 💰".
- **Workspace members.** A Next.js server action reads "only lets the workspace's members in ✓" when its login helper
  also checks the user's membership of the workspace it's given, and every Prisma read and write in it stays in that
  workspace (`src/members.ts`, read with the TypeScript parser). Anything it can't follow keeps "requires login ✓".
  "Only lets the workspace's owners and admins in ✓" when that helper then turns away other roles, on the user's own role.
- **Share links.** A new page whose address carries a secret (`/share/[token]`, `/s/[public_id]`) and looks up a link
  field with it "opens from a private link". No login claim on pages, since an app-wide guard plain can't read may
  still ask. Read-only server code with nothing login-ish anywhere says "anyone with the link, no login needed". An
  address ending in `/share` that only sets a link field (a token, a public id, an is-public flag) and calls nothing
  else "turns sharing on or off", not "deletes documents". When it's open, that's a ⚠.
- **Renamed request fields.** A Pydantic request model (`AddUserParam`, `UpdateRoleMenuParam`) whose one field was renamed
  to a required one: "The data your server expects changed: it now needs "role_ids" instead of "roles"". Anything that
  still sends the old name is turned away. Not removals or optional fields (Pydantic ignores fields it doesn't know),
  classes with aliases, dataclasses, response models, migrations or docstrings.
- **A new rule that turns requests away.** An existing route that gains a 403 check, or a 404 that compares ownership
  (`job.form_id !== form.id`), says "now turns away more requests than before (a new 'not allowed' check)". That's often
  a security fix (OpnForm's export status). It's compared per method that was there before and still is, using each
  condition's parts split on `||`, so splitting a check in two or rewording its message isn't new. Not for 401s (login is
  read on its own), nor a bare "row not there" 404.
- **Saying what an address does, without overclaiming.** A GET that only answers with fixed values (a health check)
  "answers requests", not "lists data". Code that only reads and updates the logged-in person's own user row
  (`where: { id: session.user.id }`, behind a login check) "shows and updates the logged-in person's own account".
  A function that was a helper and moved into a `"use server"` file isn't called new: the card says the browser can now
  call it directly.
- **What's new on screen in a component.** A changed or added component (not a page, route, test, story or email) that gains
  buttons, boxes or text says so: "The agent changed IntegrationRow.tsx: it now shows "Test connection"" or "…now has a
  "Save changes" button in place of a "Save" button". Not text the app already had anywhere (moved code), not pieces cut
  around `{expressions}`, and not a component a page the card describes already uses. Text around
  `{a ? 'Turso' : 'D1'}` reads whole, each way it shows ("Turso database"); a longer list ends "and 2 more".
- **Files the card doesn't explain.** When the card says something else, existing code files that changed but that it
  doesn't cover another way get one line: "The agent also changed X and Y, in ways plain can't describe yet." Covered:
  routes and files that declare them, models, schemas, migrations, types, config, seeds, tests, and files a route or page
  the card describes uses (by name, by the file an import comes from, or by a component's file name). Go, Ruby, PHP, C# and
  Java files are skipped when a route in that language changed: plain doesn't follow what those routes call, and the route
  line already says that part changed. A card with nothing else to say lists every changed file instead.
- **Before you ship.** Data that will be deleted, and migrations to run (with the folder, the
  live-site command and what fails until then). A new column on a table the app already had (its
  @@map name too) means pages that load it can fail too. On the users, sessions or accounts table a
  login library reads through its Prisma adapter (better-auth, Auth.js, Lucia), it means logging in
  can fail for everyone. A Prisma project with no migrations, no
  prisma.config and no deploy script, whose own script does nothing but `prisma db push` for that
  schema (`prisma generate` and npm's pre/post scripts checked too), is told to run that script.
  A Django migration that only changes options Django keeps in code (labels, choices,
  `related_name`, `on_delete` other than Django 6's `DB_*`, model options without permissions) is
  "nothing breaks if it runs later". Each field is compared with how the app's earlier migrations
  left it, with its full type and `app.model` target. That needs a numbered, linear history and
  operations lists plain can read whole (one literal list, no `+`, no variables). Anything else
  still must go first. Also new env vars without a default, new
  packages, a test payment when payment code changed, and "the agent says it didn't run or
  test this" when its last message says so.

When plain can't describe a change, it says so ("changed in a way plain can't describe yet")
instead of guessing that it's harmless.

`render()` turns these into the card. The wording is in one place, so it stays consistent.

## Adding a stack

Each stack is one more set of fact extractors feeding the same app model. See
[languages.md](languages.md) for what each stack needs and the order we're adding them in.
The process is the same every time:

1. **Research.** Find out what people actually build with the stack: where its addresses, login
   checks and database calls live, and what AI agents most often get wrong in it.
2. **Fixtures.** Write tests with planted problems in [test/plain.test.ts](../test/plain.test.ts).
3. **A real app.** Have an agent build a realistic app in that stack in `examples/`. Run
   `node test/demos.ts` before and after each change, and read every difference.
4. **Trials.** Personas ask the agent for features. Compare plain's card, the agent's own
   explanation, and the truth from reading the code ([trials.md](trials.md)).

## Testing

- `npm test` runs the fixtures: one app per stack with planted problems, and asserts every one
  is named.
- `node test/demos.ts <dir>` writes plain's card for every branch of the local demo apps. Run
  it before and after a change and `diff -r` the two folders.
- `node test/holds-examples.ts` checks the unpaid-checkout rule on edited copies of the demo
  branches. It skips itself when `examples/` isn't there.
