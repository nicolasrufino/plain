# Grading plain's cards on real commits

plain turns a code change into a "card" in plain English for a non-technical app owner. You grade cards made from real commits
in real open-source apps. You are the ground truth: work out what the commit really does before you read the card.

## Files
- `cards/<id>.txt`: plain's card. `diffs/<id>.diff`: the commit (message, stat, patch).
- The repo is cloned at `repos/<owner>_<name>/`. Read any file at the commit with `git -C repos/<dir> show <sha>:<path>`
  (or `<sha>~1:<path>` for before). Use it: a login check often lives in middleware, a layout, a base class or a helper.

## Steps, for each card
1. Read the diff and enough surrounding code to know what changed for the people using the app: pages, server addresses,
   who can use them (login, admins, members, anyone), data saved or deleted, money, emails, database changes, secrets.
2. Then read the card. Split it into statements (each bullet, each ✓/⚠/! line, each "before you ship" step).
3. Label each statement:
   - `right`: true and fair.
   - `wrong`: false. Say what's actually true.
   - `misleading`: technically true but an owner would come away believing something false.
   - `unverifiable`: you can't tell from the code (say why).
   Kind: `reassurance` (any ✓, "requires login", "only admins", "No problems spotted"), `warning` (⚠ / ! lines),
   `description` (what changed), `step` (before-you-ship steps).
   A "No problems spotted" header is a reassurance: it's wrong if there's a problem an owner must know about (an open address
   that changes data, a secret exposed, data loss, money mistakes). Be strict on reassurances and warnings.
4. List `misses`: things an owner should know about this commit that the card doesn't say. Severity: `high` (security, data
   loss, money, broken production), `medium` (behaviour users notice), `low` (nice to know). Don't list internal refactors or
   tests as misses.
5. `silent`: true if the card says nothing useful about the change (only "changed in a way plain can't describe", or empty).

Library repos or commits that only touch tests/docs/tooling: still grade; there's often nothing to miss.

## Output
Write one JSON file per card to `grades/<id>.json`:
```json
{ "id": "...", "summary": "one line: what the commit really does",
  "statements": [{ "text": "...", "kind": "reassurance|warning|description|step", "verdict": "right|wrong|misleading|unverifiable", "why": "..." }],
  "misses": [{ "what": "...", "severity": "high|medium|low" }],
  "silent": false }
```
Keep `why` short and concrete (file:line where it helps). Don't edit anything outside `grades/`.
