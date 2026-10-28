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

[src/session.ts](../src/session.ts) adds the per-prompt snapshots and `plain recap`;
[src/cli.ts](../src/cli.ts) is the command line and the Claude Code hooks.

## 1. Facts per file

`fileFacts(path, text)` parses one file with the TypeScript compiler and collects:

| Fact | Read from (examples) |
|---|---|
| Server addresses | Next.js `app/**/route.ts` and `pages/api/*`; Express-style `router.post('/x', requireAuth, handler)` |
| Mounts | `app.use('/api/admin', requireAuth, adminRouter)`, `app.use('/api/x', require('./x'))` |
| Pages | Next.js `app/**/page.tsx` and `pages/*`; React Router `<Route path element>` and `{ path, element }` |
| Login checks | calls like `auth()`, guard middleware (`requireAuth`, `verifyToken`), wrappers like `<RequireAuth>` |
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
  `file#/address` unit) that handles it. Mount prefixes and guards are followed up the chain.
- **Pages include their components.** A page also does what the components it imports do.
- **Helpers are resolved.** `api('/bookings')` becomes `/api/bookings` when `api` wraps
  `` fetch(`/api${path}`) ``.
- **The database** comes from `schema.prisma`, or from replaying `supabase/migrations/*.sql`
  with the real Postgres parser ([src/supabase.ts](../src/supabase.ts)). The replay also gives
  who each table's access rules let in.
- **Env vars** come from the code and from every `.env.example`; packages from every `package.json`.

## 3. Compare and 4. English

`analyze(before, after)` finds what's new, removed and changed. Then it checks for problems:

- **Missing login checks.** An address that changes data has no login check. It's flagged as
  ⚠ if the address or table sounds sensitive (admin, orders, payments, ...), and as a "thing to
  decide" otherwise. Addresses that must be public (login, register, webhooks, ...) are never
  flagged.
- **Broken.** A function was deleted but other code still uses it.
- **Unasked.** Code changed that doesn't match what you asked for. This one is a guess, and the
  card says so.
- **Guesses about money, worded as questions.** Each one says it's a guess:
  - A cancel status with no refund anywhere.
  - A sign-up discount that people can claim again with another email.
- **Before you ship.** Data that will be deleted, and migrations to run (with the folder, the
  live-site command and what fails until then). Also new env vars without a default, new
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
