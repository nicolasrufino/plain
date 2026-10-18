# plain

**See what your app does differently now, without reading the code.**

AI writes most of the code now. At Anthropic, more than 80% of merged code is written by Claude.
Writing is no longer the bottleneck; understanding is. PRs are 154% bigger, reviews take 91%
longer, and "what did we just change?" has become a question you ask the agent instead of
something you know ([research](docs/review-research.md)).

plain reads your code and shows **what changed in your app**: new features, changed flows,
new data, risks. Each one links to the exact code, and you can zoom from the app level down to
individual lines in plain English.

```
✚ NEW FEATURE   Coupon codes at checkout
   Checkout page → POST /api/coupon → reads Coupon → returns discount
✎ CHANGED   /api/checkout · the amount sent to Stripe now depends on the coupon 💰
⚠ RISK   /api/coupon has no login check
◌ 9 files only reformatted (hidden)
```

The facts come from fixed rules, not an LLM, so they can't be made up. AI is optional and
only used for wording, and it's always labeled.

## Where it runs

1. **`npx plain`**: shows your branch compared to main as a local web page. No sign-up.
2. **GitHub Action**: posts the summary on every PR, with a reading order and noise hidden.
3. **Claude Code / Cursor hook**: shows a summary after every agent session, with one key to send the risks back to the agent.
4. **VS Code extension**: later.

## How it looks

See the full walkthrough of building with Claude Code and then reviewing on GitHub:
**[docs/scenario.md](docs/scenario.md)**.

## Status

Working prototype for Next.js + Prisma apps (TypeScript, Node 23.6+, no AI):

```sh
node src/cli.ts main                 # what changed vs. main, in plain English
node src/cli.ts recap                # recap of a long Claude Code session (needs the plugin hooks)
node src/cli.ts recap --refs a,b,c   # recap across git refs, one "request" per step
npm test                             # self-check
```

As a Claude Code plugin (`.claude-plugin/` + `hooks/`), plain snapshots the code before and after every prompt (without touching your branch or staging area), shows a short card after each turn, and `plain recap` sums up the session: your app now, what each request did, what's still open, and 3 things to remember.

Docs:

- [Trials](docs/trials.md): 6 vibe-coder personas, plain vs. the agent explaining itself

- [Scenario](docs/scenario.md): one PR, from building to reviewing
- [Review research](docs/review-research.md): the review bottleneck, what exists, the gap
- [Code-to-English research](docs/research.md): the line-level engine and prior work
- [Architecture](docs/architecture.md): parsing, the shared core tree, and English output
- [Languages](docs/languages.md): TypeScript, Python, C, F#

The line-level English engine has a Python prototype in [`prototype/`](prototype/).

## Roadmap

1. **Spike:** extract facts from a Next.js + Prisma repo (routes, tables, services, env, login checks) and compare two branches
2. **v0.1:** `npx plain` that opens a local page for the current branch compared to main
3. **v0.2:** Claude Code hook (the post-session summary and "fix the risks")
4. **v0.3:** GitHub Action (PR comment and interactive view)
5. **v0.4:** Zoom into functions with the English engine (TypeScript)
6. **Later:** More frameworks (Express, Supabase, Django), more languages (Python, C, F#), VS Code extension

## License

MIT
