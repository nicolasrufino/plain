# Production pilot: plain on 70 real commits from 26 open-source apps

The trials ([round 1](trials.md) to [round 10](trials-saas-chat-ai.md)) tested plain on demo apps an AI agent built
for us. This pilot asks the other question: what does plain say about **real commits in real apps** that nobody built
for it?

**Short answer** (before the fixes [below](#what-changed-in-plain-because-of-it) and the [second round](#second-round-the-7-misses)): plain didn't crash, and it never gave a false login ✓. But its "✓ No problems spotted" header was
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
`picks.json`. On a Mac with 8 GB of memory, give Node more room (`node --max-old-space-size=4096 eval/prod/run.ts`): the
biggest repos pass Node's default limit there.

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

## What changed in plain because of it

The numbers above are for the cards from **before** these fixes. Cards from after are in
[eval/prod/cards-after/](../eval/prod/cards-after).

| Problem | Before | After |
|---|---|---|
| "? doesn't look related" | 45 flags, 42 wrong | **gone**: the guess is removed (it was also the top false alarm in [round 10](trials-saas-chat-ai.md)) |
| "Nothing about the app changed" | 11 cards, 7 wrong | 2 cards, both test-only and right. The others now list the files, "in ways plain can't describe yet. Ask the agent what they do differently." An independent grader checked all 9 new lines: all true |
| "✓ No problems spotted" | 46 headers, 13 wrong or misleading | now "Nothing flagged", no green ✓, under it: "plain reads logins, payments, database changes and secrets. It doesn't run the code, and it can miss bugs." |
| False "anyone can use" (workout-cool) | ⚠ | no warning and no ✓: a check plain can see but not prove (`if (!session?.user) return 401` right after a session getter from an auth module). Three review rounds (7, 6, 2 findings) made sure it can't hide a route that's really open |
| False "returns made-up data" (logtide) | ◐ | gone: an object built from settings isn't made up |
| Migration that's terminal output (nextcrm) | missed | **✖ ... starts with "Already up to date", which is terminal output, not SQL** |

An independent grader rechecked the 13 wrong headers. With a first wording of the note ("plain checks who can use what,
money, saved data and secrets"), 6 were right and 7 still wrong or misleading. The note promised checks plain doesn't
fully do. The 7 problems:
- `javascript:` links and SVG uploads, both stored XSS (LinkStack ×2);
- a search API that lists every user's playlists (blackcandy);
- inflated spend totals (expense.fyi);
- a webhook that swallows errors (chadnext);
- plain-text bank numbers (captable);
- account deletion with no password check (instagram-mern).

The note now says plain can miss bugs, and the green ✓ is gone, so the header no longer claims the change is safe.
Those 7 are still **misses**: plain doesn't catch them yet.

Tried and dropped after review:
- **A "won't build" check for imports of files that aren't in the project.** It caught papermark, but it also fired on
  generated, gitignored files (Laravel Wayfinder's `@/routes`, openapi types) and on imports inside code samples.
- **A keyword list for "this isn't SQL".** It flagged real T-SQL, SQL*Plus and DuckDB migrations. Only pasted terminal
  output is flagged now.

## Second round: the 7 misses

Five of the seven are now caught, each by a rule written for that shape of problem and checked on all 70 commits. No other
card changed, so the rules raised no new false alarms in the pilot. Across the 17 demo apps, the only change is a fair
"thing to decide" on the persona run that added account deletion.

| Miss | Now |
|---|---|
| `javascript:` links through saved `href` (LinkStack) | ! Links in buttons.blade.php and icons.blade.php now go straight to an address people saved… make sure saved links can only start with http:// or https:// |
| SVG uploads (LinkStack) | ⚠ Uploads now accept SVG files… an SVG can carry a script |
| Webhook swallows a failed save (chadnext) | ⚠ If saving to your database fails in your Stripe webhook, the error is caught and Stripe is still told it worked |
| Bank numbers in plain text (captable) | ! Bank accounts now store the account number as plain text |
| Account deletion with no confirmation (instagram-mern) | ! People can now delete their own account… make sure the app asks them to confirm first. The card also says what the route does now, instead of "can't describe" |
| Search API lists everyone's playlists (blackcandy) | **still missed** |
| Inflated spend totals (expense.fyi) | **still missed** |

The two that are left:
- **blackcandy:** the unscoped `Playlist.search` was already in the code. The commit only added a JSON view for it. Catching it
  means knowing which data belongs to whom, and plain's earlier name-based guesses at that raised false alarms.
- **expense.fyi:** the totals are wrong because of a calculation, which a rule that doesn't run the code can't check.

Six independent review rounds tried to break the new rules with realistic code. Each finding became a test. They found
7, 5, 6, 5, 4 and 4 problems, mostly false alarms; one was a crash on unusual code inside a `catch`, fixed before
pushing. The last round found no crash in about 40 attempts. Examples:
- a QR code's `["png", "svg"]` output formats;
- a `{{ file.url }}` download link;
- Hono's `c.json(x, 500)`;
- a catch that answers "already processed" for a repeated event;
- leaving a team via `DELETE /teams/[id]/members/me`;
- a `failed = true` flag checked after the catch.

To stay quiet on code like that, the rules give up some real cases:
- React, Vue and Svelte links (their links mostly come from fixed menu lists);
- a webhook whose save is inside a helper function;
- SVG lists spread over several lines.

## Third round: wrong descriptions

Wrong statements cost more than silence, so these were fixed before the silent cards. On the 70 commits, only these five
cards changed:

| App | Before | Now |
|---|---|---|
| FastAPI-boilerplate | "The main part … `/[username]`" (real: `/api/v1/users/{username}`, mounted from a list built at runtime) | "The user part … `/…/[username]`": a partial address, marked as one |
| fastapi-best-architecture | "The main part … `/`" (real: `/api/v1/monitors/sessions`) | "The monitors sessions part … `/…/monitors/sessions`": routers imported under another name are followed now, and a prefix from settings is `…` |
| fastapi-best-architecture | "the rules, menus and scopes parts" | "the sys data scope rules, sys role menus and sys role scopes parts" |
| workout-cool | "lists users and updates users" | "shows and updates the logged-in person's own account" |
| chadnext | "New server code that looks up users" | "getUserSubscriptionPlan() was a helper in src/lib/subscription.ts. It moved into a "use server" file, so the browser can now call it directly." |

On the demo apps, two health checks that return `{ ok: true }` now "answer requests" instead of "list data".

Three review rounds found 3 problems each. The "own account" rule leaked three times: a GET that read
only your own row vouched for a PATCH that could edit anyone, through a helper, `updateMany` or raw SQL. It's strict now. Every call in every
method must be the login check, reading the request, or a `prisma.user` lookup or update keyed by the login's id.
Anything else keeps the old wording.

## Where it stands now: the 70 cards regraded

After all of the above, the 70 new cards ([cards-after/](../eval/prod/cards-after)) were regraded by separate agents
following [GRADING-AFTER.md](../eval/prod/GRADING-AFTER.md). The graders started from the first pilot's ground truth (what each
commit really does, what the owner should know) and checked the diff for anything new. Grades are in
[grades-after/](../eval/prod/grades-after) (`GRADES=grades-after CARDS=cards-after node eval/prod/score.ts`).

| | before | after |
|---|---|---|
| wrong or misleading reassurance | 13/46 (28%) | 6/61 (10%) |
| wrong or misleading warning | 47/55 (85%) | 0/11 (0%) |
| wrong or misleading description | 26/184 (14%) | 10/197 (5%) |
| wrong or misleading step | 6/38 | 5/38 |
| high-severity misses | 18 | 13 |
| medium-severity misses | 62 | 61 |
| silent cards | 32 (46%) | 40 (57%) |
| crashed | 0 | 0 |

Silent cards went up. Many cards had only a wrong "doesn't look related" flag, and with it gone nothing useful is left. The 6
"Nothing flagged" headers that are still wrong all hide problems plain doesn't read yet:
- a build that fails on files missing from the repo (papermark);
- a deploy-script typo that leaves email broken (lobsters);
- a sign-in flow change (Django-CRM);
- API keys losing a permission (FastAPI-boilerplate);
- an unscoped search (blackcandy);
- inflated money totals (expense.fyi).

## Still open

1. **The 2 misses above:** unscoped queries in a new endpoint, and wrong money math.
2. **Silent cards (32 of 70).** Frontend behaviour, CSS, mobile apps, config and deploy scripts. Outside Python, a code
   file plain can't describe is listed only when the card has nothing else to say. Listing them always named files the
   card had already described another way (models, route files).
3. **Wrong descriptions (26 of 184).** For example "changed in a way plain can't describe" on pure refactors, verbs
   like "lists users" guessed from table names, and a new page described from components that weren't in the commit
   (papermark).
