# Architecture

```
source code (TS, Python, C, F#, ...)
      │  1. parse         tree-sitter (one library, ~100+ grammars)
      ▼
language syntax tree
      │  2. lower         one small adapter per language
      ▼
core tree             ← shared across all languages
      │  3. recognize     pattern rules: loop + accumulator → Sum, ...
      ▼
core tree, with summaries
      │  4. render        sentence templates, one set per output language
      ▼
English (or Spanish, Japanese, ...)
```

Only step 2 is specific to each language. Steps 3 and 4 are written once and shared by every language.

## 1. Parse

Use [tree-sitter](https://tree-sitter.github.io/) for every language. It's one API with mature
grammars, it handles broken code gracefully (important when someone is in the middle of an
edit), and it runs as WASM, so the same code works in Node, the browser, and VS Code.

A language-specific parser (the TypeScript compiler API, FCS for F#) is only worth adding when
we need **types**, for example "a list of numbers xs". That's a v2 concern.

## 2. Lower: language tree → core tree

Each adapter maps its language's syntax nodes to a small shared set of nodes. Anything it can't
map becomes `Unknown`, which keeps the original code text.

### Core nodes (draft)

**Structure:** `Module`, `Function(name, params, body)`, `Type(name, fields)`

**Statements:**
| Node | Example English |
|---|---|
| `Let(name, value, mutable)` | Set t to 0. / Define t as 0. |
| `Update(target, op, value)` | Add x to t. |
| `If(test, then, else)` | If x is greater than limit: … Otherwise: … |
| `Match(subject, cases)` | Depending on what shape is: … |
| `Loop(kind, var, source, body)` | For each x in xs: … / Repeat while … |
| `Return(value)` | Return t. |
| `Call(fn, args)` | Print t. / Append x to list. |
| `Break`, `Continue`, `Throw(value)`, `Try(body, handlers)` | |
| `Unknown(source)` | *(not explained: `<code>`)* |

**Expressions:** `Name`, `Literal`, `BinOp`, `Compare`, `Logic`, `Not`, `Index`, `Field`,
`Call`, `Lambda`, `ListLit`, `Range`

**Collection operations**, the high-level vocabulary:
| Node | TS | Python | F# | English |
|---|---|---|---|---|
| `Filter(src, pred)` | `.filter` | `[x for x in s if p]` | `List.filter` | every x in s that … |
| `Map(src, fn)` | `.map` | `[f(x) for x in s]` | `List.map` | f of each x in s |
| `Sum(src)` | `.reduce((a,b)=>a+b,0)` | `sum()` | `List.sum` | the total of … |
| `Count(src)` | `.length` after filter | `len()` | `List.length` | how many … |
| `Find(src, pred)` | `.find` | `next(...)` | `List.tryFind` | the first x in s that … |
| `Any` / `All` | `.some` / `.every` | `any()` / `all()` | `List.exists` / `forall` | whether any / every … |
| `Sort(src, key)` | `.sort` | `sorted()` | `List.sortBy` | s sorted by … |

This vocabulary is why one set of English templates works for every language. A Python list
comprehension and an F# pipeline become the same nodes.

Every node carries a **source span** (file, start, end), so editors can link each sentence back
to its code.

## 3. Recognize: turning patterns into summaries

Rules that rewrite a group of core nodes into one higher-level node, keeping the original
nodes as children so people can drill down:

```
Let(t, 0); Loop(each x in xs){ If(p){ Update(t, +, x) } }
  ⇒  Let(t, Sum(Filter(xs, p)))      "t is the total of every x in xs that …"
```

Starter rules: accumulate into `Sum`, `Count`, `Max` and `Min`; collect into a list as
`Filter` or `Map`; return early inside a loop as `Find`, `Any` or `All`; swap via a temporary
variable as `Swap`.

Rules have to be **sound**: a rule fires only when the rewrite means exactly the same thing
(for example, the accumulator isn't touched anywhere else in the loop). If we're not sure, it
doesn't fire, and the reader gets the line-by-line version.

## 4. Render

Templates turn core nodes into sentences. Output modes:

- `lines`: one sentence per statement, indented the way the code is (what the prototype does)
- `summary`: just the function-level summaries, as a paragraph
- `side-by-side`: each code line paired with its English (for the editor and learning mode)
- `json`: the core tree plus sentences and spans, for tools to use

Templates are kept as data, separate from code, so translating them into another spoken
language doesn't require code changes.

## Strict mode

If any `Unknown` node is produced, exit with a non-zero code and list the spans. In CI this
works as a lint: "every line of this file can be explained." It also defines an LLM-friendly
subset of each language.

## Packaging (proposed)

The tool is written in **TypeScript**, so it runs on Node, in the browser, and in VS Code
using the same tree-sitter WASM grammars, and it ships through npm.

```
packages/
  core/          core tree types, recognize rules, renderer, templates
  lang-ts/       one adapter per language: lowering plus tests
  lang-python/
  lang-c/
  lang-fsharp/
  cli/           npx plain explain file.ts [--strict] [--mode summary]
  vscode/        hover and side-by-side view
```

None of this is built yet. The folders get created when their code is written.

## Testing

Snapshot tests: `fixtures/<lang>/<name>.<ext>` → expected `.txt`.
Cross-language fixtures are the strongest check: the same algorithm written in TS, Python, C
and F# should produce **the same English**. When they don't, there's a bug in one of the
language adapters.
