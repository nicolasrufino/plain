# Regrading plain's cards after the fixes

Same job as GRADING.md (read it first: statement kinds, verdicts, misses, `silent`), with one shortcut: each commit was
already graded. `grades/<id>.json` holds the ground truth: what the commit really does (`summary`), what an owner should
know (`misses`), and verdicts on the old card's statements. Trust it, and check the diff (`diffs/<id>.diff`) or the repo
(`repos/<dir>/`, `git -C repos/<dir> show <sha>:<path>`) only for statements that are new or worded differently.

For each id you're given:
1. Read `grades/<id>.json` and the new card `cards-after/<id>.txt`.
2. Split the new card into statements and label each one (right / wrong / misleading / unverifiable, with kind). A statement
   that matches an old one word for word keeps its old verdict unless you see it was wrong.
   - The header "Nothing flagged" with the note under it ("plain reads logins, payments, database changes and secrets. It
     doesn't run the code, and it can miss bugs.") is a `reassurance`. It's `wrong` or `misleading` only if the commit has
     a problem in exactly those areas (logins, payments, database changes, secrets) that an owner must know about.
   - "The agent also changed X, in a way plain can't describe yet" is a `description`: right if X really changed in a way
     that matters to the app (not a pure no-op).
3. `misses`: start from the old misses. Drop the ones the new card now covers; keep the rest (same severity). Add a new one
   only if you notice something the old grade missed.
4. `silent`: true if the card still says nothing useful about the change.

Write `grades-after/<id>.json` in the same format as GRADING.md. Don't edit anything else.
