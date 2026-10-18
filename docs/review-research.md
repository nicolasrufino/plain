# Research: reading and reviewing AI-written code

Research done 2026-10. Follows on from [research.md](research.md), which covers code-to-English tools.
Numbers marked *(unverified)* come from secondary sources.

## Writing code is no longer the bottleneck; understanding it is

- **Anthropic:** more than 80% of merged code is written by Claude (the "When AI builds itself" report,
  June 2026). The "about 90%" figure comes from Cat Wu, who leads Claude Code product, in a
  fireside chat (Apr 2026) *(secondhand)*. Engineers produce roughly 2–8× more code, and the
  bottleneck has moved to review.
  [letsdatascience](https://letsdatascience.com/news/anthropics-claude-code-accelerates-developer-workflows-f3e308d1) ·
  [aiweekly](https://aiweekly.co/alerts/anthropic-reports-ai-now-authors-over-80-of-its-production-code)
- **Harvard working paper, 718 firms (not yet peer reviewed):** AI-adopting firms wrote about 30%
  more code, with no measurable increase in finished work. Time from opening a PR to merging it
  rose **49%**, and change requests nearly doubled.
  [ComplexDiscovery](https://complexdiscovery.com/harvard-researchers-find-ai-coding-agents-shifted-the-bottleneck-to-code-review/)
- **Faros AI telemetry:** 98% more PRs merged, PRs **154% larger**, and review time **+91%**.
  [dev.to](https://dev.to/code-board/the-review-bottleneck-why-more-ai-code-means-slower-teams-in-2026-1e5n)
- **LinearB (8.1M PRs):** developers felt about 20% faster but measured about 19% slower.
  [qa.tech](https://qa.tech/blog/code-review-bottleneck-ai-generated-code)
- About 31% more PRs merged with no review, and 38% of developers say reviewing AI code is harder
  than reviewing a colleague's. [flowverify](https://www.flowverify.co/blog/ai-code-review-bottleneck-2026-data)
- Open-source maintainers are burning out under AI PR volume.
  [CodeRabbit blog](https://www.coderabbit.ai/blog/ai-is-burning-out-the-people-who-keep-open-source-alive)

## Vibe coders

- 51% of non-developers using AI had little or no coding experience, and 73.5% feel confident
  shipping without a developer anyway. [20i survey](https://www.20i.com/blog/vibe-coding-survey/)
- People who accepted AI code without asking questions scored below 40% on understanding it,
  while those who asked for explanations scored 65% or more (a 2026 Anthropic study, reported
  secondhand) *(unverified)*. [Hostinger](https://www.hostinger.com/blog/vibe-coding-statistics/)
- "63% of vibe coders are non-developers", from platform and Reddit analysis *(unverified)*.
  [TechTimes](https://www.techtimes.com/articles/317077/20260524/vibe-coding-non-developers-63-users-now-have-no-coding-background-breaches-follow.htm)

## What exists today

| Approach | Examples | What it misses |
|---|---|---|
| AI reviewers | CodeRabbit, Greptile, Graphite Diamond | Finds bugs, but doesn't help *you* understand the code. Review is also how a team stays aligned ([Ankit Jain](https://ai.engineer/talks/how-to-kill-the-code-review)). [comparison](https://www.morphllm.com/comparisons/graphite-vs-coderabbit) |
| Review the plan, not the diff | [Giant Swarm](https://www.giantswarm.io/blog/spec-driven-development), [Augment](https://www.augmentcode.com/blog/review-the-intent-not-the-code), [Zencoder](https://zencoder.ai/newsletter/plan-review-new-linter-ai-generated-code) | Needs discipline and specs that vibe coders don't write |
| Session replay | [Mindwalk](https://betterstack.com/community/guides/ai/mindwalk-ai-agent/), [Poolside](https://docs.poolside.ai/trajectories) | Shows what the *agent did*, not what changed *in the app* |
| Structural diffs | [difftastic](https://man.archlinux.org/man/difft.1.en), [SemanticDiff](https://semanticdiff.com/blog/semanticdiff-vs-difftastic/) | Hides formatting noise, but you're still reading code |
| Code maps | CodeSee (acquired by GitKraken in 2024) | Nobody needs to look at a static map every day. [CB Insights](https://www.cbinsights.com/compare/codescan-vs-codesee) |
| Guided tours | [CodeTour](https://coder.com/blog/onboard-to-new-projects-faster-with-codetour), Swimm | Written by hand, so they go out of date |

Ankit Jain's proposed workflow points the same way as ours: use **checks with fixed rules wherever possible
and LLMs only where needed**, and put human attention on intent and behavior.

## The gap

Every existing tool shows either **code** or **an AI's opinion of code**. None of them shows
**how the app's behavior changed**, worked out from the code itself.

## Our answer: a behavior diff

Extract facts about the app from both versions using fixed rules (pages and routes, data tables,
outside services, secrets, login checks, who calls what), then compare the two sets of facts.
Group changes by story, hide the noise, and flag risks. AI only writes the wording, and every
headline links back to the fact it's based on. Zooming in goes all the way down to lines in English.

See [scenario.md](scenario.md) for what this looks like on a real PR.
