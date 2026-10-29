# Production pilot: plain on 70 real commits from 26 open-source apps

The trials ([round 1](trials.md) to [round 10](trials-saas-chat-ai.md)) tested plain on demo apps an AI agent built
for us. This pilot asks the other question: what does plain say about **real commits in real apps** that nobody built
for it?

**Short answer:** plain didn't crash, and it never gave a false login ✓. But its "✓ No problems spotted" header was
wrong or misleading 13 times out of 46. Its "doesn't look related" flags were wrong 42 times out of 45. Nearly half the
cards (46%) said nothing useful. The descriptions it does give are mostly right (158 of 184 fully right).

## Method

- **Repos:** 27 popular public apps across the stacks plain reads (8 Next.js, 3 Express, 3 Django, 3 FastAPI, 3 Rails,
  3 Laravel, 2 SvelteKit, 2 Nuxt). One Express repo had no commit that qualified, so 26 repos gave cards. The list is
  in [eval/prod/repos.txt](../eval/prod/repos.txt).
- **Commits:** for each repo, 3 real commits that change server code, chosen by rule, not by hand. They're the newest,
  10th and 20th commits that touch server paths, change 2–40 files and 10–600 lines, and aren't merges, dependency bumps
  or releases. That gave 70 commits; the list is in [picks.json](../eval/prod/picks.json).
- **Cards:** plain compared each commit with its parent. The commit's subject line stood in for "what you asked the
  agent for". Cards are in [eval/prod/cards/](../eval/prod/cards).
- **Grading:** separate agents followed [GRADING.md](../eval/prod/GRADING.md). Each worked out what the commit really
  does from the diff and the repo **before** reading the card. Then it labelled every statement on the card right,
  wrong, misleading or unverifiable, and listed what the card missed, with a severity. Nothing was run. Grades are in
  [eval/prod/grades/](../eval/prod/grades), and [score.ts](../eval/prod/score.ts) adds them up.

To rerun it, clone the repos (`--depth 300`) into `eval/prod/repos/` and run `node eval/prod/run.ts`. It keeps
`picks.json`.

## Results

"Wrong" counts statements graded wrong or misleading.

| stack | cards | wrong reassurance | wrong warning | wrong description | wrong step | high misses | medium misses | silent | crashed |
|---|---|---|---|---|---|---|---|---|---|
| django | 9 | 0/8 | 0/2 | 2/29 | 1/8 | 0 | 6 | 5 | 0 |
| express | 2 | 1/1 | 3/3 | 1/3 | 0/0 | 1 | 2 | 1 | 0 |
| fastapi | 9 | 1/8 | 18/18 | 5/40 | 0/0 | 2 | 5 | 6 | 0 |
| laravel | 9 | 3/8 | 3/3 | 0/28 | 0/1 | 6 | 12 | 6 | 0 |
| next | 23 | 6/13 | 15/18 | 14/49 | 4/28 | 6 | 24 | 10 | 0 |
| nuxt | 3 | 0/1 | 2/3 | 1/5 | 1/1 | 0 | 2 | 0 | 0 |
| rails | 9 | 2/5 | 5/5 | 1/25 | 0/0 | 3 | 8 | 3 | 0 |
| sveltekit | 6 | 0/2 | 1/3 | 2/5 | 0/0 | 0 | 3 | 1 | 0 |
| **all** | **70** | **13/46 (28%)** | **47/55 (85%)** | **26/184 (14%)** | **6/38** | **18** | **62** | **32 (46%)** | **0** |

### What held up

- **No crashes,** and every card took under 32 seconds, including 40 MB repos.
- **No false login, admin or member ✓.** No card in this sample made one: these commits rarely changed who can
  use something. The pilot doesn't measure those claims; the [trials](trials-saas-chat-ai.md) do.
- **The "anyone can use X without logging in" warnings:** 1 of 2 right. chadnext's subscription-plan action really is
  open. The wrong one is below.
- **Descriptions:** 158 of 184 were fully right, and Django, Laravel and Rails were the strongest.

### What didn't

1. **"✓ No problems spotted" promises more than plain checks.** It was wrong or misleading 13 times in 46. The problems
   behind it were mostly things plain never looks for:
   - a commit that imports files that don't exist, so the build breaks (papermark);
   - a PHP file cut off mid-function, which takes the whole site down (LinkStack);
   - a migration whose first lines are pnpm console output (nextcrm);
   - a deploy-script typo that leaves email broken (lobsters);
   - links saved without checks that now go straight into `href`, which allows stored XSS (LinkStack);
   - a Stripe webhook that now swallows database errors and still answers 200 (chadnext);
   - a search API that lists every user's playlists (blackcandy).

   An owner reads the header as "this is safe". It only means "nothing in plain's checks fired".
2. **"? doesn't look related to what you asked" is almost always wrong (42 of 45).** It flagged the file that *was* the
   fix (octobox, atidone), files a feature needed (lobsters' CSP line), and every file of a rename refactor (18 on one
   FastAPI card). A commit subject is a shorter request than a real prompt, which makes this harder. But a flag that is
   wrong 93% of the time trains owners to ignore every flag.
3. **"Nothing about the app changed" was wrong 7 times in 11.** plain says it when no file it reads changed in a way
   it can describe. Those commits changed what users see: a quota row, a release-notes dialog, LinkedIn logos.
4. **Two false warnings.** logtide's "getActiveTerms() returns made-up data" is wrong: it reads settings on purpose.
   The other is a false login warning (workout-cool). Its check is
   `try { const session = await getMobileCompatibleSession(req); if (!session?.user) return 401 }`. plain doesn't know
   that session helper, and it ignores checks inside a `try`, even ones that return.
5. **One changed file was hidden as "only formatting changes"** (django-vue-admin `request.js`, which added logging).
6. **Silent cards: 32 of 70.** These are commits whose meaning lives where plain doesn't read: mobile apps, CSS,
   frontend behaviour, config, deploy scripts, migrations that run themselves.

### The 18 high-severity misses

| kind | count | examples |
|---|---|---|
| Broken code or deploy | 6 | missing imports (papermark), PHP syntax error and deleted helpers still in use (LinkStack ×2), invalid migration SQL (nextcrm), deploy-script typo (lobsters), removed package still needed by a Vapor deploy (OpnForm) |
| Security | 4 | stored XSS through `href` and SVG uploads (LinkStack ×2), unscoped search API (blackcandy), an open action that deletes any file (chadnext) |
| Money | 3 | webhook swallows errors (chadnext), a fix that makes paying users Pro (chadnext), spend totals overstated (expense.fyi) |
| Security fixes not mentioned | 2 | another form's export readable (OpnForm), API keys that could rename their owner (FastAPI-boilerplate) |
| Data and API contract | 3 | irreversible account deletion (instagram-mern), request fields renamed under the admin UI (fastapi-best-architecture), mail now relayed through a new provider (lobsters) |

## What the pilot found in plain itself

- **A memory leak, now fixed** (`abaa3f3`). plain never freed its parsed code trees. One big repo, or many cards made
  in one process, filled tree-sitter's 4 GB and the parser aborted. The pilot's batch run hung on a 40 MB Python
  repo.
- **The harness first gave plain only files with known extensions.** Fixing that changed 19 of 70 cards, and those 19
  were regraded. plain's own snapshot reads every file, and the numbers above use that full input.

## What to fix, in order

1. **Make the header say what was checked.** Keep the ✓ only for what plain read, e.g. "Nothing flagged in logins,
   money, data or secrets". Never claim the change is safe in general. Most of the 13 wrong reassurances were about
   things plain never checks, and this makes them true. Not the webhook, the search API or the deploy typo: those
   need checks of their own.
2. **Drop or narrow "doesn't look related".** At 3 right in 45 it costs more trust than it earns.
3. **Say "changed in ways plain can't describe" instead of "Nothing about the app changed"** whenever app files
   changed.
4. **Fix the false statements:** the made-up-data flag on config reads; login checks that return inside a `try`, with a session read from a helper whose
   module is about auth; and the file hidden as formatting.
5. **Cheap broken-code checks:** a relative import of a file that isn't there, and a migration `.sql` file whose lines
   aren't SQL.
6. **Coverage, the biggest gap but the slowest to close:** CSS and frontend behaviour, and deploy and config files.
