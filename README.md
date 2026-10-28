# plain

**See what your app does differently now, without reading the code.**

AI writes most of the code now. Writing is no longer the bottleneck; understanding is. PRs are
bigger, reviews take longer, and "what did we just change?" has become a question you ask the
agent instead of something you know ([research](docs/review-research.md)).

You know what you asked for. plain shows you what you got: in plain English, after every turn.
A real card (shortened):

```
plain · 7 files changed since main
You asked: "add coupon codes at checkout"

  ⚠ 3 problems  ·  5 loose ends  ·  4 steps before you ship

LOOK AT THIS FIRST
  ⚠ Anyone can use the coupon part of your server without logging in.
  ✖ oldDiscount() was deleted from lib/money.ts, but the admin refunds page still uses it,
    so that will break.
  ? The agent also changed calculateTotal() in lib/money.ts, which doesn't look related to
    what you asked for. It's used by the checkout part of your server, so check that it
    still works. (This is a guess.)

WHAT CHANGED
  Server
    + New server code that looks up coupons.
    • The checkout part of your server now reads coupons. This is the code that charges your
      customers 💰
  Database
    + Your database now stores coupons: code and percent off.

LOOSE ENDS
  ◐ The agent left a to-do: "rate limit" (in app/api/coupon/route.ts).
  ◐ getCoupons() returns made-up data instead of reading your database.

BEFORE YOU SHIP
  1. Update your database: run `npx prisma migrate dev`.
```

**No AI inside.** plain reads your code with fixed rules (using the TypeScript compiler and the real Postgres parser), so it can't
make things up, costs nothing to run, and says the same thing every time. It's an independent
check on what the agent did, not the agent grading its own work.

## Install (Claude Code)

```
/plugin install plain --marketplace nicolasrufino/plain
```

Then restart Claude Code. You need [Node.js](https://nodejs.org) 23.6 or newer.

- **After every turn**, a short card shows what changed since your last message: what's new,
  what's risky, what the agent changed that you didn't ask for, and what to do before you ship.
- **After a long session**, run `/plain:recap` for the whole picture: your app now,
  what each request changed, what's still open, and 3 things to remember.

plain snapshots your code before and after each prompt without touching your branch or your
staged files. The session log lives in `.git/plain-session.jsonl`.

## Works on

| Your app uses | plain understands |
|---|---|
| **Next.js** (App Router or `pages/`) | pages, server routes, login checks |
| **Node servers** (Express, Fastify, Hono) | every route and the address it's mounted at, login middleware |
| **React** with React Router (Vite, Create React App) | pages, login wrappers, what each page asks the server for |
| **Prisma** | your database tables, and changes that delete data |
| **TanStack Start** (Lovable's default) | pages from `src/routes`, login checks on layouts, server actions and server routes |
| **Python**: FastAPI, Flask, Django + REST Framework (SQLAlchemy, SQLModel, Django ORM) | routes and their login checks, models, payments, and the mistakes AI makes most in Python (debug on, secret keys in code, SQL injection) |
| **Supabase** (Lovable, Bolt) | your tables, and **who your access rules (Row Level Security) let in**: tables anyone can read or change, rules that only check "is logged in", users who can mark their own order paid |
| **Stripe**, OpenAI, Resend and other services | when your app starts using them, and the code that charges money |

**Coming next, in order:** Vue/Nuxt and SvelteKit,
Angular, C# (ASP.NET Core), Java (Spring Boot), then Laravel, Rails and Go.
[Why this order, and what each one needs](docs/languages.md).

On other projects plain won't break, but it won't have much to say yet.

## Use it from the terminal

From a clone of this repo, inside your app's folder:

```sh
node /path/to/plain/src/cli.ts                    # what changed vs. HEAD
node /path/to/plain/src/cli.ts main               # what changed vs. main
node /path/to/plain/src/cli.ts recap              # recap of your last Claude Code session
node /path/to/plain/src/cli.ts recap --refs a,b,c # recap across git refs, one "request" per step
```

## Status

Early and rough. It will get things wrong: false alarms, missed risks, awkward English.
**That's what I need help with.** If plain says something wrong or confusing about your app,
[open an issue](https://github.com/nicolasrufino/plain/issues) with what it said and what was
actually true.

Known gaps are in [docs/trials.md](docs/trials.md), where plain was tested against 6 kinds of
vibe coders and compared to just asking the agent "explain what you did".

## Docs

- [Trials](docs/trials.md): 6 vibe-coder personas, plain vs. the agent explaining itself (Next.js)
- [Trials, round 2](docs/trials-node-react.md): the same on a Node + React app, and what changed in plain because of it
- [Trials, round 3](docs/trials-tanstack-supabase.md): the same on TanStack Start + Supabase, Lovable's stack
- [Trials, round 4](docs/trials-django.md): the same on Django + REST Framework, the first non-JavaScript app
- [Scenario](docs/scenario.md): one feature, from building to reviewing
- [Review research](docs/review-research.md): the review bottleneck, what exists, the gap
- [Code-to-English research](docs/research.md): line-level English and prior work
- [Architecture](docs/architecture.md): how plain reads a change and writes the card, and how a stack is added
- [Stacks](docs/languages.md): what plain reads in each stack, what it warns about, and why

## Roadmap

- Fewer false alarms, more money/login/data risks caught ([backlog](docs/trials.md))
- A GitHub Action that posts the summary on every PR
- More stacks: Vue/Nuxt, SvelteKit, Angular, C#, Java, then Laravel, Rails and Go ([order and why](docs/languages.md))
- Zoom into a function and read it line by line in English ([prototype](prototype/))

## Development

```sh
npm install
npm test                      # fixtures with planted problems, one per stack
node test/demos.ts /tmp/a     # plain's card for every branch of the demo apps in examples/
```

How a new stack gets added (research, fixtures, a real app, trials) is in
[docs/architecture.md](docs/architecture.md#adding-a-stack).

## License

[MIT](LICENSE)
