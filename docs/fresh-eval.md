# Fresh pilot: plain on 65 commits it was never tuned on

The [production pilot](production-eval.md) graded plain on 70 commits, and plain was then fixed against those same commits. Its
numbers can be flattering. This pilot checks that: 23 other open-source apps, 3 recent commits each (65 in all), picked the
same way ([eval/fresh/run.ts](../eval/fresh/run.ts), [repos.txt](../eval/fresh/repos.txt)), run by plain at
commit a0adc6f, and graded from scratch by separate agents following [GRADING.md](../eval/fresh/GRADING.md). Cards and grades
are in [eval/fresh/](../eval/fresh) (`GRADES=grades CARDS=cards node eval/fresh/score.ts`).

## First run, before any fix

| | tuned pilot (70) | fresh pilot (65) |
|---|---|---|
| wrong or misleading reassurance | 4/59 (7%) | 6/64 (9%) |
| wrong or misleading warning | 1/23 | 4/4 |
| wrong or misleading description | 11/210 (5%) | 13/180 (7%) |
| wrong or misleading step | 0/37 | 7/16 |
| high-severity misses | 7 | 12 |
| silent cards | 33 (47%) | 46 (71%) |
| crashed | 0 | 0 (one ran out of memory before the fix below) |

What held up on new code: reassurances and descriptions are about as accurate as on the tuned set, and nothing crashed.

What didn't:
- **Steps were partly fitted to the tuned set.** 7 of 16 were wrong: settings that are optional or opt-in told to be added
  ("Add MCP_ENABLED"), "missing from .env.example" for a repo with `.example.env` or none, and "apply before the new code or it
  fails" for migrations that only drop unused tables or fix rows.
- **The 4 warnings:** 3 were routes declared inside a test file, 1 a public profile tab in a Mastodon client (elk).
- **Silence is the real gap: 71%.** Django was silent on all 9 cards, Go on 5 of 6. Most of the 12 high misses are security
  fixes plain doesn't say anything about (paperless's admin login skipping 2FA, gotify's user creation without an elevated
  session, chatwoot leaking other agents' tokens, openstatus leaking status-page passwords).
- **Memory:** Infisical's 1.4 GB of screenshots ran plain out of memory; snapshots now skip binary and huge files.

## Fixed since (a0adc6f → 2a4e2dd)

Test files' routes, mounts and settings no longer count; a FastAPI router behind a login dependency two mounts up is
recognised (dispatch's endpoint went from "works without logging in" to "requires login ✓"); settings only tested aren't
required unless a missing value stops the app; table-dropping migrations go after the new code; "Most of this change" needs a
real majority. These were fixed against this pilot, so it isn't a clean measure of them any more; the next fresh batch is.

## Not fixed

- **Go route discovery** (gotify: `os.Exit(run())` → a switch on the command → `return serve()` → gin chains). Finding the
  routes worked, but then every gotify route read as open: its own middleware (`a.evaluateOr401(ctx, ...)`) reads as "no
  check", so new routes would get false "anyone can use" alarms. Dropped after review; it needs own-middleware hand-offs read
  as "can't tell" first.
- **Security fixes** that don't add or remove a route or a check plain reads (a template escaping a name, a serializer no
  longer sending tokens): there's no rule for "this closes a hole" that wouldn't guess.
