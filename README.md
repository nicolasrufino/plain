# plain

**Turn code into plain English, using fixed rules instead of AI.**

```ts
const bigTotal = (xs: number[], limit: number) =>
  xs.filter(x => x > limit).reduce((a, b) => a + b, 0)
```

> bigTotal takes a list of numbers `xs` and a number `limit`, and adds up every `x` in `xs` that is greater than `limit`.

The English is generated from the code's syntax tree by fixed rules, with no LLM involved. That gives it three properties:

- **Faithful.** It describes what the code actually does. It can't invent anything.
- **Instant and free.** It runs offline, with no API key and no tokens.
- **Honest about its limits.** In strict mode, code it can't explain is reported as unexplained instead of being described wrongly.

## Who it's for

- **Learners.** See every line of a new language in English, and notice that Python, TypeScript and F# say the same things.
- **Reviewers of AI-written code.** Read what the code really does before you merge it.
- **Screen-reader users.** Get spoken descriptions of code structure ([research](docs/research.md#accessibility)).

## Status

Early design. There's a working Python prototype in [`prototype/`](prototype/):

```sh
python3 prototype/plain.py prototype/demo.pln         # explain
python3 prototype/plain.py prototype/demo.pln --run   # run
python3 prototype/plain.py                            # self-check
```

## Docs

- [Research](docs/research.md): why this matters, and who has tried it before
- [Architecture](docs/architecture.md): how the pipeline works
- [Languages](docs/languages.md): TypeScript, Python, C, F#, and how to add one

## Roadmap

1. **v0.1:** TypeScript and Python explained line by line through the shared core, as an `npx` CLI.
2. **v0.2:** Recognize common patterns, so whole loops and chains like filter, map and sum become one sentence.
3. **v0.3:** A VS Code extension with hover and a side-by-side view.
4. **v0.4:** C and F#.
5. **Later:** Learning mode (read the English, then write the code), a strict-mode lint for CI, and more languages.

## License

MIT
