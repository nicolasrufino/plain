# Languages

How each language maps to the [core tree](architecture.md#2-lower-language-tree--core-tree),
and what's hard about it. Each language uses the same running example: add up the items above
a limit.

Target English for all of them:

> big_total takes xs and limit, and returns the total of every x in xs that is greater than limit.

---

## TypeScript / JavaScript (first to build)

```ts
const bigTotal = (xs: number[], limit: number) =>
  xs.filter(x => x > limit).reduce((a, b) => a + b, 0)
```

- **Parser:** `tree-sitter-typescript` (handles JS too). Later, the TS compiler API for types.
- **Maps easily:** array method chains (`filter`, `map`, `reduce`, `find`, `some`, `every`)
  become collection operations directly.
- **Hard parts:**
  - `async`/`await` and Promises: needs `Await` and "waits for …" wording.
  - Classes, `this`, prototypes.
  - JSX: probably "renders a `<Button>` with …" and its own set of templates.
  - Many ways to write the same thing (`for`, `for…of`, `forEach`, `reduce`), which is the
    job of the recognize step.
- **Prior art:** none found for TypeScript → English with fixed rules.

## Python

```python
def big_total(xs, limit):
    return sum(x for x in xs if x > limit)
```

- **Parser:** `tree-sitter-python`. The prototype uses Python's built-in `ast` module.
- **Maps easily:** comprehensions become `Filter` and `Map`. Built-ins `sum`, `len`, `any` and
  `all` become collection operations.
- **Hard parts:** decorators, `with` statements, generators (`yield`), dynamic tricks
  (`getattr`, `**kwargs`).
- **Prior art:** Pseudogen (2015), Rai & Gupta (2019), and `prototype/plain.py`.

## C

```c
int big_total(const int *xs, size_t n, int limit) {
    int t = 0;
    for (size_t i = 0; i < n; i++)
        if (xs[i] > limit) t += xs[i];
    return t;
}
```

- **Parser:** `tree-sitter-c`.
- **Maps easily:** C has a small core of constructs (if, for, while, assignment, return).
- **Hard parts, which are also where C is most useful to learners:**
  - **Pointers and memory.** `*p`, `&x`, `malloc`/`free` need their own wording: "the value
    that p points to", "the address of x", "reserve space for n ints". This is where
    learners struggle most.
  - **Index loops.** `for (i = 0; i < n; i++) … xs[i]` needs a recognize rule to become
    "for each item of xs (the first n)".
  - **Declarations.** Reuse the cdecl approach for types like `int (*fp)(char *)`.
  - **The preprocessor.** tree-sitter sees macros before they're expanded. Explain
    `#define` constants literally, and leave function-like macros as `Unknown` at first.
  - **Undefined behavior.** Don't try to explain it. Possible later: warnings like "this reads
    past the end of xs if n is wrong".
- **Prior art:** cdecl (declarations only).

## F#

```fsharp
let bigTotal xs limit =
    xs |> List.filter (fun x -> x > limit) |> List.sum
```

- **Parser:** `tree-sitter-fsharp` (ionide, v0.3.x, still in progress). If its coverage falls
  short, the alternative is the FCS untyped AST through a small .NET helper, but that means
  depending on .NET.
- **Maps easily, maybe the best fit of any language:** pipelines (`|>`) read naturally in order.
  "Take xs, keep those greater than limit, then add them up." The `List.*`, `Seq.*` and
  `Array.*` functions map directly to collection operations.
- **Hard parts:**
  - **Pattern matching and unions.** `match shape with Circle r -> … | Square s -> …` needs
    `Match` templates: "If shape is a Circle with radius r: …".
  - **Expression-oriented code.** There's no `return`, and the last expression is the result,
    so the template should say "results in …".
  - **Type inference.** There are often no type annotations, so we'd need FCS to describe types.
  - **Computation expressions** (`async { }`, `seq { }`): leave them as `Unknown` at first.
  - **Point-free style** (`List.sum >> sqrt`): "adds up, then takes the square root."
- **Prior art:** none found.

---

## Adding a language

1. Check that a tree-sitter grammar exists and is maintained.
2. Write `packages/lang-<x>/lower.ts`, mapping grammar node types to core nodes.
3. Add the running example and the cross-language fixtures. Their English must match the other
   languages.
4. Add wording only for constructs that are truly specific to the language (Rust lifetimes,
   C pointers). Everything else reuses the core templates.

## Candidates after these

| Language | Why | What's hard |
|---|---|---|
| Go | Simple, explicit code | goroutines and channels |
| Rust | Learners need help | ownership and lifetimes need their own wording |
| Java / C# | Lots of existing code; Sridhara's prior work | heavy object-oriented boilerplate to summarize away |
| SQL | Huge demand | it describes what result you want, not steps |
| Bash | explainshell shows people want it | quoting and expansion |
