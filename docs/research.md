# Research

Why a rule-based code-to-English tool matters, and who has tried something like it.
Research done 2026-10. Numbers marked *(unverified)* come from secondary sources; check the
primary source before quoting them.

## Why it matters

### People ship AI code they don't trust

- In the Stack Overflow 2025 survey (49k respondents), **84%** use or plan to use AI tools, but
  only **33%** trust their accuracy, and **46%** actively distrust it. The top complaint, from **66%**
  of respondents, is code that's "almost right, but not quite."
  [survey.stackoverflow.co/2025/ai](https://survey.stackoverflow.co/2025/ai)
- In Sonar's 2026 State of Code survey, only **48%** of developers always check AI-assisted code
  before committing it.
  [Sonar report](https://www.sonarsource.com/state-of-code-developer-survey-report.pdf)
- "Comprehension debt", meaning code a team ships without understanding it, has become a common term.
  [TechRadar](https://www.techradar.com/pro/the-rise-of-comprehension-debt-in-the-age-of-ai-coding)
- An "Explanation Gate", where developers had to explain AI code before accepting it, cut
  maintenance-task failures from 77% to 39% (arXiv:2602.20206) *(unverified)*. A rule-based
  explanation is a cheap version of that gate.

### Reading code is a large part of the job

- An instrumented study found **22–61%** of time spent reading code.
  [TU Delft](https://repository.tudelft.nl/file/File_1c4db9bf-2865-4e29-ae21-89fedf33b5dd)
  The often-quoted "75% reading" figure is *(unverified)*.

### AI explanations make mistakes, and novices miss them

- GPT-3.5/4 answering comprehension questions about their own code made the same mistakes
  novices make. [ICSE 2024](https://conf.researchr.org/details/icse-2024/icse-2024-software-engineering-education-and-training-track/9/Let-s-Ask-AI-About-Their-Programs-Exploring-ChatGPT-s-Answers-To-Program-Comprehension-Questions)
- Novices are the least able to spot misleading AI suggestions.
  [arXiv:2507.15822](https://arxiv.org/pdf/2507.15822)
- GPT-4-improved compiler errors beat the standard messages in only 1 of 6 tasks, and
  explanations written by experts did better overall. [arXiv:2409.18661](https://export.arxiv.org/pdf/2409.18661)

## Who has tried this

### Rule-based tools (the same approach as plain)

| Project | What it does | Takeaway |
|---|---|---|
| **cdecl** (30+ years) | C/C++ declarations ↔ English | The approach lasts, but this covers only one small corner of syntax. [vscode-cdecl](https://github.com/WasabiFan/vscode-cdecl) |
| **explainshell** | Shell commands → man-page text | Popular, and built on lookups rather than AI. |
| **Regex explainers** | Regex → English, piece by piece | A narrow area again. [DevToolLab](https://devtoollab.com/tools/tags/regex-to-plain-english) |
| **Sridhara et al., ASE 2010** | Java methods → summary comments (SWUM and templates) | Reviewers rated **127/144** comments accurate. It summarized whole methods, not only lines. [paper](https://www.academia.edu/5237265/Towards_Automatically_Generating_Summary_Comments_for_Java_Methods_) · [survey](https://arxiv.org/pdf/1907.10863) |
| **Rai & Gupta, 2019** | Python → XML → pseudocode templates | Nearly the same as `prototype/plain.py`. Research prototype only. [arXiv:1906.06117](https://arxiv.org/pdf/1906.06117) |
| **2023 rule-based baseline** | Line-by-line Python rules | Fails on keywords its rules don't cover. Strict mode is our answer to that. [arXiv:2312.05047](https://arxiv.org/pdf/2312.05047) |
| **Java2Pseudo, ISE 2022** | Java → pseudocode via templates | [CEUR](https://ceur-ws.org/Vol-3362/ISE2022_short11_Cho_Java2Pseudo.pdf) |

### Learned and AI-based tools

- **Pseudogen** (Oda et al., ASE 2015) learned Python → English/Japanese pseudocode with
  statistical machine translation. It works line by line only.
  [paper](https://www.infona.pl/resource/bwmeta1.element.ieee-art-000007372074)
- **VS Code "explain code" extensions**
  ([Code Explainer](https://github.com/Sadeedpv/codeExplainer),
  [Explain Code](https://github.com/eimenhmdt/explain-code-vs-extension),
  [VarDocs](https://www.github.com/RtiM0/vardocs),
  [CodeVis](https://github.com/anikanb32/codevisualization)) nearly all need an OpenAI key.
  Many are abandoned, and most support a single language.

### Learning tools

- **Hedy** (Felienne Hermans) is a gradual language with 20 levels that build up to Python. It's
  evidence that reading code like a language helps learners. [user study](https://www.hedy.org/research/Gradual_Programming_in_Hedy_A_First_User_Study_2021.pdf)
- **Python Tutor** shows step-by-step traces of running code. It's popular, but the evidence that
  it improves learning is thin, and very detailed traces may keep learners stuck at the low level.
  [arXiv:2606.03288](https://arxiv.org/pdf/2606.03288). This supports summarizing above the
  line level.

### Accessibility

- **StructJumper** (Baker, Milne, Ladner) lets blind programmers navigate Java code as a tree
  of its nesting structure. Users moved faster and better understood how lines relate.
  It breaks on any parse error. [NSF](https://par.nsf.gov/servlets/purl/10111821)
- **Accessible AST-based programming** (Brown, SIGCSE 2019) gives spoken descriptions of code
  structure, and users were more accurate with the same speed. [paper](https://cs.brown.edu/~sk/Publications/Papers/Published/sbk-accessible-ast-blocks/paper.pdf)
- **CodeTalk** (Microsoft Research, CHI 2018) notes that IDE screen-reader support is limited. [paper](https://microsoft.com/en-us/research/uploads/prod/2018/04/CodeTalkCHI2018CameraReady.pdf)

### Searched and found nothing

- **No rule-based TypeScript/JavaScript → English package** on npm or GitHub. There are AST
  tools to build one on, for example [ccxt/ast-transpiler](https://github.com/ccxt/ast-transpiler),
  which translates TypeScript into other *programming* languages.
- **No F# → English tool.** The building blocks exist: the FCS untyped AST, the
  [Fantomas](https://github.com/fsprojects/fantomas) AST viewer, and
  [tree-sitter-fsharp](https://docs.rs/tree-sitter-fsharp).
- **For C**, only cdecl, which handles declarations only.

## Conclusions

1. **There's a real gap.** The rule-based approach has worked for decades in narrow tools
   (cdecl, regex, shell) and in academic prototypes. Nobody has shipped one that covers several
   languages, works offline, and is aimed at learning or review.
2. **Being faithful to the code is the pitch.** Trust in AI accuracy is low, and the main
   complaint is "almost right" output.
3. **Summarizing above the line level is what sets plain apart.** Line by line has been done
   since 2015 and stalled there. Sridhara showed templates can summarize whole methods.
4. **Strict mode handles the main known failure** of rule-based tools: code outside the rules.
5. **Risk:** rule-based English reads more literally than an LLM's. The fix is good sentence
   patterns, plus an optional AI layer for the "why" that is clearly labeled as such.

## To read next

- [ ] arXiv:2602.20206 (Explanation Gate): confirm the numbers
- [ ] Sridhara 2010 / 2011: how they summarize whole methods
- [ ] CodeTalk CHI 2018: what screen-reader users need from the output
- [ ] Oda 2015: their user study on whether pseudocode helps novices
