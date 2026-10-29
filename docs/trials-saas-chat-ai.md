# Trials, round 10: apps that aren't shops (Huddle, Porch, Quill)

Rounds 1 to 9 were all shops: something to buy, Stripe Checkout, a webhook. This round checks whether
plain works on "anything". Codex built three apps that sell nothing, each as its own repo in `examples/`:

- **Huddle** (`examples/huddle-board`): a team workspace. Next.js 15 App Router, Auth.js v5 for login,
  Prisma with Postgres, and invite emails through Resend.
- **Porch** (`examples/porch-chat`): a neighbourhood chat. An Express server with Socket.IO (the
  always-open connection that delivers chat messages live), Prisma with SQLite, and a React client.
- **Quill** (`examples/quill-notes`): an AI writing assistant. FastAPI with Jinja pages, SQLAlchemy with
  Alembic migrations, and OpenAI.

The method is the same as rounds [1](trials.md) to [9](trials-go.md): six personas per app asked Codex
for a feature; a separate grader worked out the truth from the code before reading Codex's explanation
or plain's card. Nothing was run. The persona types are the same six as before.

All 18 runs are graded. The first 13 (Huddle p1–p5, Porch p1–p3 and Quill p1–p5) are in the tables below. Five
runs (Huddle p6, Porch p4–p6 and Quill p6) were cut off by Codex's usage limit, rerun the next morning, and graded
separately; see [The five reruns](#the-five-reruns-after-codexs-usage-limit-reset). The headline table covers the
first 13.

The cards graded below are plain's from **before** this round's fixes. What changed is at the end.

---

## Headline results

| | Codex "explain" | plain |
|---|---|---|
| Access claims | **35 right, 0 wrong** | **10 right, 0 wrong** (Huddle 2, Porch 3, Quill 5) |
| 🔴 problems caught (3: Porch p3 unlimited picture uploads; Quill p1 a "trial" that locks out existing users; Quill p5 cut-off AI answers) | **0 of 3** | **0 of 3** |
| False alarms | 0 | **9**: 8 "doesn't look related" (Porch 6, Quill 2) and 1 "empty catch" (Quill p5) |
| Wrong or misleading descriptions | **2** (Quill p1 "The account starts with 20 AI edits"; Quill p4 `store=False` framed as a change) | **7**: "shows project shares", "saves tasks", "small screens like phones", "lists memberships" (Huddle); "lists messages" for a picture (Porch); "deletes documents", "lists documents" (Quill) |
| Deploy step | `npm run db:migrate` / `npm run prisma:migrate` on 4 branches: development commands, wrong for a live database | ✅ the right live command (`npx prisma migrate deploy`, `alembic upgrade head`) on all 8 branches with a migration; often understated what breaks |
| "The agent didn't test this" step | – | missing on 6 of 13 (Huddle p4, all five Quill) |
| Verdict line | – | "No problems spotted" on 9 of 13, including Quill p5 (🔴). The other two 🔴 cards showed only false "decide" items |

The 10 access claims are from the persona cards. plain's card for Huddle's first build (the whole app)
also said "You have to log in ✓" on the login, home, sign-up and invite pages, which are public. That
is fixed; see [What we changed](#what-we-changed-in-plain-under-review).

**The main lesson.** plain's access claims held up on three new stacks: 10 claims, none wrong. But the
cards didn't describe what was built. On Huddle they left out the main feature on four of five
branches: the public link, the emails, removing a member, the limits. The work lived in places plain
didn't read yet:
- **Server actions** (Next.js functions a page runs on the server, in files marked `'use server'`). No card
  gave one an access line or a proper description.
- **Socket.IO.** No Porch card mentioned live chat.
- **Uploads.** The picture card never said "pictures", sizes, types or who can see them.
- **AI cost and limits.** Both Quill cards about money said the AI file "changed in a way plain can't describe yet".

All three 🔴 were missed by both plain and Codex. Codex described every feature accurately, but flagged
almost none of the owner decisions.

---

## Huddle (team workspace, Next.js)

| # | Persona | Request |
|---|---|---|
| 1 | Non-technical owner | "can people share a project with someone outside the team, like a client, without them making an account" |
| 2 | Student, first project | "add search across all tasks and let me filter by who it's assigned to and the due date" |
| 3 | Knows the basics | "let people comment on tasks and @mention teammates, and email them when they get mentioned" |
| 4 | Junior developer | "Workspace admins should be able to remove a member: their open tasks get reassigned to the admin who removed them and they lose access immediately." |
| 5 | Experienced developer | "Add per-workspace limits: free workspaces get at most 3 projects and 5 members, enforce it on the server even with concurrent invites, and add a usage endpoint the UI can read." |
| 6 | Vague and frustrated | "people say they sometimes see tasks from other teams?? fix it asap" (graded in "The five reruns" below) |

Facts for all five graded branches:
- **Nothing was run.** There's no Postgres here, and Codex had no dependencies installed either.
- **Every workspace query on main is limited to members.** Three helpers do the checks: `requireUser`
  (login), `requireWorkspaceMember` (member of this workspace) and `requireWorkspaceAdmin` (owner or
  admin). Every workspace page and server action calls one. The grader found no way to read or change
  another workspace on main.
- **Public pages:** `/`, `/login`, `/sign-up` and `/invite/[token]`. Everything under `/w` needs a login.
- **Access is checked on every request.** The login token holds only the user id. Membership and role
  are read from the database each time, so removing someone takes effect at once (this matters for p4).
- **Migrations don't apply themselves.** The project's `db:migrate` script is `prisma migrate dev`, a
  development command. A live server needs `npx prisma migrate deploy` before the new code goes live.
  plain said exactly that on p1, p3 and p5. Codex said `npm run db:migrate` on p1 and p3.
- **No error page.** Any server action that throws shows Next.js's generic error screen (matters for p5).
- **No 🔴 on any Huddle branch,** so plain's five "No problems spotted" verdicts are fair. The cards were
  thin, not wrong.

### Trial 1: Owner asking about sharing with a client
> "can people share a project with someone outside the team, like a client, without them making an account"

Codex first answered "Not currently": inviting a client would make them a member of the whole workspace.
Told to go ahead, it built the feature.

**What was built:** Any member can create or revoke one link per project, holding a random 192-bit code.
A new public page, `/share/[token]`, shows the workspace name, the project's name and description, and
every task (title, notes, status, due date, assignee name).

**Ground truth: problems in the real code**
- 🟡 **Any member, not only admins, can publish a project to anyone with the link.** On main, letting
  outsiders in (invites) is admin-only. The owner should decide.
- 🟡 **The link never expires,** and nothing records who made it. It works until someone revokes it.
- 🟡 **The client sees everything in the project, now and later:** every task's notes, teammates' full
  names, and tasks added after the link was sent.
- ✅ The code can't be guessed. Only that one project is shown, with no emails. No one can share another
  workspace's project. Revoking works at once (the page isn't cached; the grader is confident but didn't
  run it). The page is read-only.

**Access:** `/share/[token]`: **anyone with the link, no login**, read-only. Creating or revoking a link:
login plus membership (any role). **Database:** new table; apply it first, or the project page fails.

| | Codex reply2 / explain | plain |
|---|---|---|
| Public page, no login, one project, read-only | ✅ | 🟡 "It only shows information" ✅, but **never says it's public** |
| What the client sees | ✅ exact list, "does not expose … member emails" | ❌ "It shows project shares" |
| Any member can create a link | 🟡 stated, not flagged | ❌ |
| Link never expires; later tasks show up | ❌ | ❌ |
| Migration step | 🟡 `npm run db:migrate` (development command) | ✅ `npx prisma migrate deploy` |
| Verdict | — | 🟡 fair (no 🔴), but the headline should be "anyone with the link can see this project" |

**False statements:** plain's "It shows project shares" is misleading: it shows the project board. Codex: none.

### Trial 2: Owner asking for task search
> "add search across all tasks and let me filter by who it's assigned to and the due date"

Codex built it straight away.

**What was built:** A new Tasks page (`/w/[workspaceId]/tasks`) with a sidebar link. It searches task
titles, notes and project names, ignoring case. It filters by assignee (or "unassigned") and by a
due-date range, both ends included. Results are sorted by due date and link to the task on its board,
which is highlighted.

**Ground truth: problems in the real code**
- 🟡 **"All tasks" means all tasks in the current workspace.** Someone in two workspaces searches each one
  separately. That's the safe reading.
- 🟡 **No paging.** An empty search loads every task in the workspace. Fine for small teams.
- 🟡 A "from" date after the "by" date returns nothing, with no message. Minor.
- ✅ Login and membership required; only this workspace's tasks. Read-only. The search text is safe.

**Access:** New page: login plus membership in that workspace. **Database / settings:** none.

| | Codex reply / explain | plain |
|---|---|---|
| Search and filters | ✅ with an example URL | 🟡 lists the boxes ("Search by task or project", "Assignee", "Due from" and 1 more); no behaviour |
| Members only, this workspace only | ✅ | ❌ no access line |
| Jump-to-task link on the board | ✅ | ❌ "changed in a way plain can't describe yet" |
| No paging | ❌ | ❌ |
| Verdict | — | ✅ fair |

**False statements:** none from either.

### Trial 3: Owner asking for comments, @mentions and email
> "let people comment on tasks and @mention teammates, and email them when they get mentioned"

Codex built it straight away.

**What was built:** Comments on each task, with an @ autocomplete. Posting checks membership and that the
task is in this workspace. Each mentioned teammate gets an email through Resend with the task and the
first 280 characters of the comment. If an email fails, it's logged and the comment stays.

**Ground truth: problems in the real code**
- 🟡 **The comment text leaves the app by email,** through Resend, an outside service. That's what was
  asked, but the owner should know.
- 🟡 **People can't turn mention emails off,** and there's no limit on how often they're sent. Comments
  can't be edited or deleted, not even by admins.
- 🟡 **Failed emails are silent.** They go to the server log only. With the Resend settings missing, no
  mention email goes out and nobody is told.
- ✅ No one can comment on another workspace's task or email someone outside it. Comments can't run code
  in people's browsers. The emails in the autocomplete were already visible to members on main.

**Access:** login plus membership, this workspace's tasks only. **Database:** two new tables; apply them
first, or the project page fails. **Settings:** none new (reuses the Resend ones).

| | Codex reply / explain | plain |
|---|---|---|
| Comments, members only, own workspace only | ✅ | 🟡 "saves comments"; no access line |
| **Emails mentioned teammates through Resend, with the comment text** | ✅ | ❌ **not mentioned at all**, not even "shared with your email provider" |
| Failed emails are silent | 🟡 "failure is logged, but the comment remains saved" (true, not framed as a gap) | ❌ |
| No opt-out; no edit or delete | ❌ | ❌ |
| Migration step | 🟡 development command | ✅ |
| Verdict | — | 🟡 fair, but the card hides the one thing the owner asked for: the email |

**False statements:** Codex's "mention parsing tests … pass" is true, but they were a one-off script, not
a saved test. Minor. plain: none.

### Trial 4: Admin asking to remove members
> "Workspace admins should be able to remove a member: their open tasks get reassigned to the admin who removed them and they lose access immediately."

Codex built it straight away.

**What was built:** A new server action for owners and admins. In one transaction (a group of database
changes that all happen or none do), it gives the person's unfinished tasks in this workspace to the
admin, then deletes their membership. It can't target an owner or yourself. The settings page gets a
Remove button with a confirmation.

**Ground truth: problems in the real code**
- 🟡 **Admins can remove other admins.** On main, only the owner can change roles, so this is a new power.
  The owner should decide.
- 🟡 **Nobody is told.** The removed person gets no email, and nothing records who removed whom.
- 🟡 **Rare errors.** A task edited at the same moment can make the removal fail with the generic error
  screen (click again), or end up assigned to the removed person.
- ✅ Access really ends on the next click. Owners and yourself are protected. Other workspaces can't be
  touched. Finished tasks stay with the person, so history is kept.

**Access:** owners and admins only. **Database / settings:** none.

| | Codex reply / explain | plain |
|---|---|---|
| Owners and admins only | ✅ | ❌ no access line |
| **Removes the member** | ✅ | ❌ **not mentioned**: "The w settings page now saves tasks" |
| Unfinished tasks reassigned; finished ones stay | ✅ | ❌ |
| Admins can remove admins | 🟡 implied by "any non-owner member" | ❌ |
| Testing status | ✅ "verification wasn’t possible" | ❌ step missing |
| Verdict | — | 🟡 fair, but the card doesn't say a member can be removed |

**False statements:** plain's "saves tasks" names the minor write and leaves out the delete. plain's
"changed how the app looks on small screens like phones" is mostly wrong: the new rules apply to every
screen size. Codex: none.

### Trial 5: Technical owner asking for plan limits
> "Add per-workspace limits: free workspaces get at most 3 projects and 5 members, enforce it on the server even with concurrent invites, and add a usage endpoint the UI can read."

Codex built it straight away.

**What was built:** A `plan` on each workspace (`free` or `pro`), with every workspace starting free. Free
means 3 projects and 5 members, and unanswered invites count as seats. Each check first locks the
workspace's row, so two requests at the same moment wait in turn. It runs when creating a project,
sending an invite, accepting one, and signing up with one. New `GET /api/workspaces/:id/usage` returns
the plan and the counts.

**Ground truth: problems in the real code**
- 🟡 **Hitting a limit shows the generic error screen, not a message.** Only sign-up-with-invite shows
  "This workspace has reached its 5-member limit." The limit works but looks broken.
- 🟡 **Every workspace becomes Free, and nothing can make one Pro.** No billing, no admin screen. Upgrading
  means editing the database by hand. Teams already over the limit keep what they have but can't add.
- 🟡 **Easy to get around:** anyone can create more free workspaces. Unanswered invites hold a seat for
  7 days.
- ✅ **Safe with invites at the same moment, as asked,** on every path. Revoking an invite, or a failed
  invite email, frees the seat. The usage endpoint is members-only.

**Access:** usage endpoint: login plus membership (401 / 404). **Database:** the new column is on the
workspace record that every workspace page loads, so **if the code goes live first, every workspace page
fails.**

| | Codex reply / explain | plain |
|---|---|---|
| 3 projects, 5 members on free | ✅ | ❌ **not mentioned** |
| Usage endpoint: login plus membership | ✅ with example JSON | 🟡 "lists memberships and requires login ✓": login ✅, "lists memberships" wrong |
| Limit hit shows the error screen | ❌ | ❌ |
| Everyone becomes Free; no way to set Pro | 🟡 stated, not flagged | 🟡 "Workspaces now also store the plan" |
| Every workspace page fails before the migration | ❌ no apply step | 🟡 step ✅, but "the parts that use it will fail" understates it |
| Verdict | — | 🟡 fair, but the card says nothing about limits |

**False statements:** plain's "lists memberships" (it checks the caller's membership). Codex: none.

---

## Porch (community chat, Express + Socket.IO)

| # | Persona | Request |
|---|---|---|
| 1 | Non-technical owner | "can people chat without signing up, just pick a nickname" |
| 2 | Student, first project | "add a search box to find old messages in a room" |
| 3 | Knows the basics | "let people send pictures in the chat" |
| 4 | Junior developer | "Admins need to ban a user: kick them out of all rooms right away, delete their messages, and stop them from logging back in." (graded in "The five reruns" below) |
| 5 | Experienced developer | "Add per-user rate limiting on messages (5 per 10 seconds) across both the socket and the REST API, store read receipts per room, and make unread counts accurate across devices." (graded in "The five reruns" below) |
| 6 | Vague and frustrated | "messages show up twice sometimes and the app is slow, fix it" (graded in "The five reruns" below) |

Facts for all three graded branches:
- **Nothing was run.** Codex couldn't build either (no dependencies, network blocked). It did apply its
  migrations to a temporary SQLite database.
- **Login.** The server's addresses under `/api/rooms` and `/api/messages` need a login (401 otherwise).
  Health, register, login and logout are public.
- **Live chat needs a login too.** Every Socket.IO connection checks the login cookie. Joining a room,
  sending and "typing…" also check room membership. Two limits:
  - the login token is never checked against the database, so a deleted account keeps working for up
    to 7 days (this will matter for p4);
  - someone who leaves a room through the website but keeps their live connection open can keep
    receiving that room's messages. The real client closes it; a modified one might not.
- **Private rooms are sealed.** No one outside can see, read or post in them.
- **Moderators** can remove messages in rooms they're in. Nobody can ban, mute or kick.
- **No rate limits anywhere.** Signup is open and emails aren't verified.
- **Migrations don't apply themselves.** The only script is `prisma migrate dev` (development). A live
  server needs `npx prisma migrate deploy` first. plain said so on p1 and p3; Codex said
  `npm run prisma:migrate`.
- **plain said nothing about Socket.IO on any card.** The file counts and the testing step were right on all three.

### Trial 1: Owner asking about guests
> "can people chat without signing up, just pick a nickname"

Codex built it straight away.

**What was built:** A public `POST /api/auth/guest`. It takes a nickname (2–40 characters) and creates a
normal member account with a placeholder email and a password nobody can log in with, marked `isGuest`.
The guest gets the normal 7-day login cookie. The login page now leads with "Chat as guest", and a guest's
menu shows **Leave** instead of **Sign out**.

**Ground truth: problems in the real code**
- 🟡 **No limit on guest accounts, and guests can do everything a member can:** join public rooms, post,
  create rooms. There's no ban tool. Not 🔴, because main's signup was already open to scripts, but it
  removes the last bit of friction. The owner should decide: a cap per address, read-only guests, or no
  room creation for guests.
- 🟡 **Others can't tell a guest from a member,** and a guest can take a real neighbour's name.
- 🟡 **Leaving is permanent.** After Leave (or 7 days), a guest can't come back or remove old messages.
- 🟡 Guest accounts pile up. Deploy order: without the migration, sign-in breaks.
- ✅ Guests pass the same room and live-chat checks as members. The placeholder email never reaches anyone.

**Access:** New `POST /api/auth/guest`: **anyone, no login**, creates a member-level account.

| | Codex reply / explain | plain |
|---|---|---|
| Nickname-only entry | ✅ | 🟡 "saves new users. /api/auth/guest"; never says these are guests with a nickname |
| Anyone can use it without logging in | ✅ | 🟡 "⚠ Anyone can use the auth guest part of your server without logging in." True, but it files the requested feature as a problem |
| Guests get the same room and live-chat checks | ✅ including "Socket connections still require a valid session" | ❌ |
| No limit on guest accounts; no ban | ❌ | ❌ |
| Migration step | 🟡 development command | ✅ |
| Verdict | — | 🟡 "1 problem · 4 things to decide": the problem is the feature, and all 4 are false alarms |

**False statements:** plain raised **4 false "doesn't look related" alarms** (`AppShell`, `AuthProvider`,
`publicUser`, `verifyToken`). All four are the feature. "Users now also store the guest" is garbled for a
yes/no flag. Codex: none.

### Trial 2: Owner asking for message search
> "add a search box to find old messages in a room"

Codex built it straight away.

**What was built:** The room's message list (`GET /api/messages`) takes a search of 2–100 characters,
after the existing membership check. It searches that room only, skips removed messages, and returns 30
at a time, newest first. The room page gets a search bar, highlighted matches and "Show more results".

**Ground truth: problems in the real code**
- 🟡 **A result can't be opened in context.** There's no "jump to" the conversation around it.
- 🟡 Ignoring case probably works only for plain English letters ("josé" won't find "JOSÉ"). Minor.
- 🟡 Each search reads every message in the room. Fine at neighbourhood size.
- ✅ Only room members can search it. Removed messages never show. The search text is safe. No migration.

**Access:** unchanged: login plus room membership. **Database / settings:** none.

| | Codex reply / explain | plain |
|---|---|---|
| Search box, highlights, "Show more results" | ✅ | ✅ |
| Server search, 2–100 characters | ✅ | 🟡 quotes the right refusals ("Search for at least 2 characters.") but calls it "the main part of your server" at "/" |
| Only room members | ✅ | ❌ no access line |
| Removed messages left out | ✅ | ❌ |
| Verdict | — | ✅ fair |

**False statements:** none. "The main part of your server" is a naming slip: plain lost the
`/api/messages` prefix (fixed; see below).

### Trial 3: Owner asking for pictures
> "let people send pictures in the chat"

Codex built it straight away.

**What was built:** `POST /api/messages/image` (login and room membership). It accepts JPEG, PNG, WebP or
GIF up to 5 MB, checks the file really starts like that type, and takes a caption. The picture's bytes
are stored **inside the SQLite database**. The room sees it live. `GET /api/messages/:id/image` shows it
to current room members only; a removed picture gives "not found". Moderators see thumbnails.

**Ground truth: problems in the real code**
- 🔴 **No limit on how many pictures one person can send, and they all go into the one database file.**
  Each upload can be 5 MB. Nothing limits uploads per minute or per person, and signup is open and
  unverified. One script with a free account can add gigabytes in minutes. All chat data lives in the
  same SQLite file, so when the disk fills, every write fails and **the whole chat stops**. Backups also
  grow with every picture. Text messages on main had the same missing limit, but at 2,000 characters a
  message; pictures make it about 2,500 times worse. Fix: a per-person rate limit or daily quota on
  uploads. Better, store the files outside the database, with a size cap.
- 🟡 **Removing a picture doesn't erase it.** It stops being shown, but the bytes stay in the database and
  its backups. That matters for illegal or private pictures.
- 🟡 **Photos are kept exactly as uploaded,** including hidden details (EXIF) that can hold the GPS
  location. For a neighbourhood app, that can reveal where someone lives. The grader is unsure how each
  device behaves. The original file name is shown to the room too.
- 🟡 Deploy order: without the migration, the whole chat breaks.
- ✅ **Uploads are otherwise done well:** only those four types (no SVG or HTML, which could run code),
  the 5 MB limit is enforced on the server, files aren't public, and every view re-checks membership.

**Access:** both new addresses: login plus room membership.

| | Codex reply / explain | plain |
|---|---|---|
| Pictures, live to the room | ✅ | 🟡 "saves new messages and requires login ✓"; never says "pictures" |
| Types, file check, 5 MB | ✅ | ❌ |
| Only room members can send or see them | ✅ | 🟡 "requires login ✓" ×2, correct, but should say "only people in that room" |
| Viewing route | ✅ | ❌ "lists messages" for a route that shows one picture |
| **Unlimited uploads fill the disk and stop the chat 🔴** | ❌ | ❌ |
| Removed pictures stay in the database; photo location kept | ❌ | ❌ |
| Migration step | 🟡 development command | ✅ |
| Verdict | — | ❌ "2 things to decide", both false alarms, with the 🔴 missed |

**False statements:** plain raised **2 false "doesn't look related" alarms**: `types.ts` and
`serializeMessage()`, which keeps the picture bytes out of live messages. "lists messages" is wrong. The
paths `/image` and `/[messageId]/image` dropped the `/api/messages` prefix. Codex: none.

---

## Quill (AI writing assistant, FastAPI + OpenAI)

| # | Persona | Request |
|---|---|---|
| 1 | Non-technical owner | "can new people try the AI for free without a credit card, like 20 rewrites" |
| 2 | Student, first project | "show people a history of their past AI rewrites that they can search" |
| 3 | Knows the basics | "let people share a document with a public link" |
| 4 | Junior developer | "Users need to be able to delete their account and all their data, including what we sent to OpenAI if that's possible." |
| 5 | Experienced developer | "Add a model switcher (gpt-4o-mini by default, gpt-4o for pro users), stream the responses, track token usage and cost per user per day, and hard-stop at a daily budget." |
| 6 | Vague and frustrated | "the AI thing is broken sometimes and really slow, fix it" (graded in "The five reruns" below) |

Facts for all five graded branches:
- **Nothing was run.** The grader checked that every changed Python file parses. Codex's replies all say
  full runtime tests weren't possible.
- **Migrations don't apply themselves** (`alembic upgrade head` by hand). Code that goes live first fails
  on every query that touches the new column.
- **Documents are owner-only on main.** Someone else's document gives "not found".
- **The 50-a-day AI limit is really enforced,** even with requests at the same moment: the user's row is
  locked before counting. Only successful requests count.
- 🟡 **On main, that lock is held for the whole OpenAI call.** About 15 slow AI calls at once could tie up
  every database connection and stall every page. p5 removes this.
- **Signup is open and unverified,** so each new email gets a new AI allowance (worst case about $0.65 per
  account per day on main).
- **What goes to OpenAI:** the instructions and the selected passage (up to 20,000 characters). Not the
  email, the title or the whole document. OpenAI may keep requests up to 30 days for abuse checks.
- **The home page promises privacy:** "Your account can only read and change documents that belong to you."
- **p2, p3 and p5 use the same migration ID.** Merging any two needs one renumbered.
- **plain's cards:** "The agent didn't test this" was missing on all five. `editor.js` was left off p1–p3.
  The migration step also mentioned "`flask db upgrade` with Flask-Migrate" on p2, p3 and p5, but there's
  no Flask here.

### Trial 1: Owner asking about a free trial
> "can new people try the AI for free without a credit card, like 20 rewrites"

Codex first answered: no card is needed, but users get 50 edits a day, not 20. It asked whether to switch
to 20 in total, and said that after those "we'd need either a paywall or a 'trial exhausted' screen".
Told "use your best judgement", it built the "trial exhausted" version.

**What was built:** The 50-a-day limit became `FREE_EDIT_LIMIT = 20`, and the date filter was removed, so
the count covers every AI request a user has ever made. The editor shows "N of 20 free edits remaining"
and disables the AI buttons at 0. The home and signup pages say "20 free AI edits. No credit card
required." `common.js` now passes on the error code, so the editor can spot "limit reached". No migration.

**Ground truth: problems in the real code**
- 🔴 **It isn't a trial. It's a lifetime cap of 20 for everyone, existing users included, with no way to
  get more.** The count covers every past request, so any current user who has already made 20 or more
  AI edits is locked out of the AI the moment this ships. Yesterday they had 50 a day. There's no
  billing, plan or upgrade anywhere in the app, so after 20 edits nobody can ever use the AI again. The
  owner asked about letting *new* people *try* it, which implies something to pay for afterwards.
  Codex's own first reply said a paywall would be needed. The build put a "trial" label on the
  product's only plan.
- 🟡 **One person can get it again with a new email.** Signup is unverified. Not a new hole, but "free
  trial" invites it.
- 🟡 **"No credit card required" implies something to pay for.** There isn't anything.
- ✅ The limit holds with requests at the same moment, failed requests are free, and it's checked on the
  server. The `common.js` change is needed.

**Money / AI cost:** 💰 every account goes from 50 AI edits a day to 20 ever.

| | Codex reply2 / explain | plain |
|---|---|---|
| 20 edits in total; buttons off at 0 | ✅ | ❌ "AI rewrite and document parts… can't describe yet" |
| **Existing users over 20 are locked out at once 🔴** | ❌ "The account starts with 20 AI edits" | ❌ |
| No paid plan: after 20, the AI is gone | 🟡 raised in its first reply, dropped later | ❌ |
| Repeatable with a new email | ❌ | ❌ (plain caught this on the Go p1, not here) |
| `common.js` | ✅ explained | ❌ false alarm: "doesn't look related" |
| Testing status | ✅ "full runtime tests were unavailable" | ❌ step missing |
| Verdict | — | ❌ its only "decide" item is a false alarm; the 🔴 is absent |

**False statements:** Codex's "The account starts with 20 AI edits" is false for every existing account.
plain's `common.js` alarm is false: `editor.js` reads what it adds.

### Trial 2: Owner asking for a searchable rewrite history
> "show people a history of their past AI rewrites that they can search"

Codex built it straight away.

**What was built:** Each AI request now saves the full passage, the AI's answer, and the document's id and
title. A new `/history` page (login) shows your own 100 newest and searches all of yours. The editor
sends the document id, which is checked as yours before OpenAI is called.

**Ground truth: problems in the real code**
- 🟡 **People's text is now kept forever, and they can't remove it.** There's no delete for history.
  **Deleting a document no longer removes its text**, despite the "This cannot be undone" prompt: the
  passages and title stay in history. Deleting the account still removes them. On main, only character
  counts were stored. The owner should decide, and update any privacy text.
- 🟡 **Deploy order.** Until the migration runs, every AI request fails *after* OpenAI has answered and
  been paid.
- 🟡 Only the 100 newest show, with no paging. History starts empty.
- ✅ Login required, own rows only. The search is safe. Nothing new is sent to OpenAI.

**Access:** `/history`: login, own rewrites only.

| | Codex reply / explain | plain |
|---|---|---|
| `/history`: login, own rows, search, 100 newest | ✅ (the 100 cap not mentioned) | 🟡 "lists airequests and requires login ✓" is **correct**; misses own-only, search and the cap |
| Stores full passages and answers | ✅ | ✅ "now also store the input text, output text and document title" |
| Text survives document deletion; history can't be deleted | 🟡 mentioned as a feature | ❌ |
| AI breaks until the migration | 🟡 "Run `alembic upgrade head` before launching" | ✅ step (plus a stray Flask-Migrate mention) |
| `models.py` | ✅ | ❌ false alarm: "doesn't look related", while the card's own Database line describes its columns |
| Testing status | ✅ | ❌ step missing |
| Verdict | — | ❌ its only "decide" item is false |

**False statements:** plain's `models.py` alarm. Codex: none.

### Trial 3: Owner asking for public share links
> "let people share a document with a public link"

Codex built it straight away.

**What was built:** Each document can get a random 256-bit link code. The owner can turn sharing on or
off (login, owner only, and a CSRF check: proof the request came from the app itself). Turning it on again makes a new link. A public page,
`/s/{code}`, shows the title, the text and the "Updated" date, and asks search engines not to index it.

**Ground truth: problems in the real code**
- 🟡 **The link shows the live document, including what the owner types later.** The editor saves every
  keystroke within a second, so drafts and private notes appear until sharing is turned off.
- 🟡 **Deploy order: the whole app breaks before the migration.** Every document page reads the new
  column. Codex and plain both understate it.
- ✅ The link can't be guessed and can be turned off at once. Only the owner can share. No email or edit
  buttons on the public page. Deleting the document kills the link.

**Access:** `/s/{code}`: **anyone with the link, no login**, one document. Sharing on or off: login, owner only.

| | Codex reply / explain | plain |
|---|---|---|
| Public page, no login, one document | ✅ | 🟡 "lists documents and works without logging in": access **correct**, "lists documents" **wrong** |
| Sharing on/off: login, owner | ✅ | 🟡 "requires login ✓" correct; "deletes documents" **false** |
| Later edits show on the link | 🟡 panel text only | ❌ |
| Whole app fails before the migration | 🟡 "Before using the feature, run…" | 🟡 "the parts that use it will fail" |
| Verdict | — | ✅ fair (no 🔴) |

**False statements (plain):**
- "deletes documents": the `DELETE` address only turns the link off.
- "lists documents… works without logging in": it shows one document to someone with its secret link.
  To an owner it reads like a public list of everyone's writing. It was the most alarming false line of
  the round.

Codex: none.

### Trial 4: Owner asking for account deletion
> "Users need to be able to delete their account and all their data, including what we sent to OpenAI if that's possible."

Codex built it straight away.

**What was built:** A new `/account` page. It explains what Quill stores, and that OpenAI may keep
requests up to 30 days for abuse checks, which Quill can't delete early. `POST /account/delete` needs a
login, the current password and typing `DELETE`. It deletes the user and logs them out. The OpenAI call
gains `store=False`.

**Ground truth: problems in the real code**
- 🟡 **What was sent to OpenAI can't be deleted, and the app now says so honestly.** `store=False`
  changes nothing: it was already the default.
- 🟡 Backups keep deleted accounts until they age out. Normal, but worth a line in a privacy policy.
- 🟡 Anyone can show the "account deleted" banner by visiting the address. Cosmetic.
- ✅ **Deletion is complete for this database:** documents and AI records go with the account, in one
  step, and other devices are logged out on their next click.

**Access:** both new addresses: login; each person can delete only themselves.

| | Codex reply / explain | plain |
|---|---|---|
| Account page and delete, login required | ✅ | ✅ "requires login ✓" twice |
| Password, typed DELETE, CSRF check | ✅ | ❌ |
| Deletes documents and AI records too | ✅ | 🟡 "deletes users" only |
| OpenAI data can't be deleted; 30 days disclosed | ✅ with links | ❌ the request's own question goes unanswered |
| `store=False` | 🟡 framed as a change (it was already the default) | ❌ "also changed app/ai.py" |
| Testing status | ✅ | ❌ step missing |
| Verdict | — | ✅ fair |

**False statements:** Codex's `store=False` "prevents OpenAI from keeping the completion" is misleading,
not false. plain: none ("lists data" for `/account` is vague, not wrong).

### Trial 5: Technical owner asking for models, streaming and a budget
> "Add a model switcher (gpt-4o-mini by default, gpt-4o for pro users), stream the responses, track token usage and cost per user per day, and hard-stop at a daily budget."

Codex built it straight away.

**What was built:**
- **Pro and models.** A new `is_pro` flag, set only by hand in the database. Non-Pro users asking for
  gpt-4o are refused on the server.
- **Budget.** A daily dollar budget **per user** (`DAILY_AI_BUDGET_USD`, default $0.25) replaces 50 a day.
  Before each call, the worst-case cost is reserved. The answer's length cap (`max_tokens`) is at most
  2,048 tokens and shrinks to fit what's left of the budget.
- **Streaming and tracking.** Answers appear word by word. Exact tokens and cost are saved, and the
  editor shows "$0.0123 / $0.25". If anything fails, the full reservation is charged.

**Ground truth: problems in the real code**
- 🔴 **AI answers can be cut off mid-sentence with no warning, and "Replace selection" then overwrites the
  user's whole passage with the cut-off text.** Main had no length cap. Now it's at most 2,048 tokens
  (about 1,500 words), and it shrinks toward 64 as the user nears their budget. Nothing checks
  `finish_reason` (OpenAI's note that an answer was cut off), so a cut-off answer arrives as a normal
  one. Rewriting a long selection (up to 20,000 characters is allowed), or any edit late in the day,
  comes back cut off. Applying it replaces the whole selection, and autosave writes it to the database
  within a second.
- 🟡 **The budget is per person; your total OpenAI bill has no cap.** With open signup, the total is $0.25
  × accounts. If the owner meant a cap on the whole bill, it doesn't exist.
- 🟡 **Failed AI requests are charged at their worst-case cost.** During an OpenAI outage, a Pro user can
  run out of budget for the day after a few errors. On main, failures were free.
- 🟡 **Pro users get the same $0.25** on a model that costs about 16 times more, so they get far fewer edits.
- 🟡 No way to become Pro except editing the database. Users now see dollar amounts.
- 🟡 **Deploy order: before the migration, nobody can use anything** past the home, login and signup pages.
- ✅ Model access is checked on the server. The budget is safe with requests at the same moment. Prices
  are right. The OpenAI call no longer holds a database connection, which removes main's stall risk.

**Money / AI cost:** 💰 $0.25 per user per day replaces 50 requests; no total cap. 💰 gpt-4o for Pro.
💰 Failures charged. **Settings:** `DAILY_AI_BUDGET_USD` (optional, default 0.25, per user).

| | Codex reply / explain | plain |
|---|---|---|
| Model switcher; Pro checked on the server | ✅ | ❌ "AI rewrite and document parts… can't describe yet" |
| Streaming | ✅ | ❌ |
| **Cut-off answers can overwrite the passage 🔴** | ❌ (mentions the shrinking cap, not the result) | ❌ |
| Per-user budget, no total cap | 🟡 stated, not flagged | ❌ |
| Failed requests charged | 🟡 says disconnects; leaves out OpenAI errors | ❌ |
| `is_pro` only by hand | ✅ with the SQL | 🟡 "Users now also store the pro." |
| `DAILY_AI_BUDGET_USD` | ✅ | ❌ no settings line |
| Verdict | — | ❌ "No problems spotted" with a 🔴 and a false loose end |

**False statements:** plain's "the error is silently ignored (an empty catch)" in `editor.js` is a false
alarm: a fallback message is set first and then shown. "store the pro" is garbled. Codex left out that
OpenAI errors are charged too (its code comment says so). Incomplete, not false.

---

## What we changed in plain

"Result" comes from plain's cards regenerated after the fixes. An independent review (round 27) took three rounds (10 findings, then 3, then clean). It made the login rules strict:
- **Next.js pages:** only a check in the page itself (the default export, `getServerSideProps`, or a function the page calls) counts.
- **Server actions:** an `auth()` call next to a success redirect isn't a check. An action that checks nothing at all is flagged as "Anyone can".
- **Not guards:** optional-login middleware (`optionalAuth()`, `credentialsRequired: false`) doesn't count as a check.

| Gap | Fix | Result |
|---|---|---|
| Next.js pages: "You have to log in ✓" on Huddle's public login, home, sign-up and invite pages (whole-app card) | Login is claimed only when the page, or a layout above it, turns guests away | Those four pages no longer claim it. The workspace pages under `/w` now all say "You have to log in ✓" |
| Server actions were invisible (Huddle p1, p3, p4, p5) | Functions in `'use server'` files are now described, following the helpers they call (emails through Resend, updates, deletes) | p1 "saves new project shares", "deletes project shares"; p3 "saves new comments and emails people through Resend"; p4 "updates and deletes tasks and memberships". p5's four changed actions still "can't describe" |
| Express routers made by a function lost their address (Porch "/", "the main part of your server", `/image`) | The mount path is kept | p2 "/api/messages"; p3 "/api/messages/image" and "/api/messages/[messageId]/image" |
| SQLAlchemy's `Base` read as a table (Quill whole-app card: "stores bases") | `Base` is skipped | Gone |
| Acronyms ("airequests") | "AI requests", "photo URL" | Quill p2 "lists AI requests" |
| AI services named but not explained (Quill: "Your app now uses OpenAI.") | Say what people write can be sent to the AI service and that each request costs money | Quill whole-app card: "What people write in it can be sent to OpenAI, and each request costs you money." Persona cards don't show it: OpenAI was already in use on main |
| "The agent didn't test this" missed (Huddle p4, Quill p1–p5) | More phrasings ("wasn't possible", "testing wasn't possible", and others) | Huddle p4 and Quill p2–p5 now get the step. Quill p1 ("full runtime tests were unavailable") still doesn't |
| Flask-Migrate mentioned on a FastAPI app (Quill p2, p3, p5) | Mentioned only when it's installed | The step says only `alembic upgrade head` |
| "Doesn't look related" false alarms (8: Porch 6, Quill 2) | Suppressed when the change adds a name that the request's other files add too | 7 of 8 gone: all six on Porch, and Quill p2's `models.py`. Quill p1's `common.js` is still raised: its only new name, `error.status`, is read by another static script, so nothing links it |

## Still open

1. ✅ **Uploads** (Porch p3 🔴). Fixed later. A new upload is described with its accepted types, its size limit and where files go. The card adds a guess when there's no size limit or no per-person limit, and when SVG is allowed. Porch p3 now reads "People can now upload pictures (JPEG, PNG, WebP or GIF), up to 5 MB each. They're stored in your database." and gets "Nothing limits how many files one person can upload: one account can fill your database and stop the whole app."

   The independent review (round 28) took five rounds (8, 13, 1, 1, then clean). It made the rule count only real request entry points, not previews, webhooks or files the server makes itself. It reads sizes only from limits and framework defaults, and storage only from the upload code and its imports. It skips the per-person guess for admin-only uploads.

   Known miss: a new upload with no size limit, added beside a size-checked one in the same file, gets no size warning.
   When files live in the database, add that a full disk stops the whole app.
2. ✅ **Socket.IO events and their access** (all Porch cards). Fixed later. The server's live events and what each one does are now listed, and "Connecting needs a login ✓" is shown when the server's own `io.use` turns away connections without a token. Porch now reads: "Your server now takes "join room", "leave room", "send message" (saves new messages) and "typing" over its live connection. Connecting needs a login ✓". A login check that's really gone is raised. Review 29 took five rounds (9, 3, 1, 2, then clean). It took out browser listeners, bots and other clients, other servers' guards, loggers and rate limiters. Still open: "only people in that room ✓", which needs reading each event's own membership check.
3. ✅ **AI cost and limit changes** (Quill p1 🔴, p5 🔴). Fixed later.
   - **Limits written in the code** are now described: new, changed, replaced, gone, and "no limit now". The wording keeps units, e.g. "a maximum upload size of 10 MB", "$5".
   - **A per-day limit replaced by one that never resets** gets a guess: "…it counts everything ever, so anyone who has already used 20 loses it as soon as this ships". This needs fewer date checks in the function that compares against the limit and the helpers it calls.
   - **An AI call that gets a new `max_tokens`** with nothing checking the finish reason gets a guess that a cut-off answer looks complete.
   - Quill p1 and p5 now get these.
   - **Review 30** took six rounds (11, 10, 8, 4, 2, then clean). It made the rule:
     - count date checks only where the limit is used;
     - say "replaced" only when the new limit takes the old one's exact place in a comparison;
     - treat a constant as a rename only when it takes the old one's place in the lines that used it;
     - skip constants that aren't limits on people (time, size, retries);
     - look for AI calls only in apps with an AI library.
   - **Known limits:**
     - a limit defined once per plan in one file is skipped;
     - a renamed limit with a reworded comparison reads as new and gone, without the guess;
     - Go's MixedCaps constants aren't read;
     - a date-check helper whose variable has a function type (`const h: (id: string) => … = async …`) isn't followed.
   - **Still open:** budget settings read from the environment (per person or total, and the default).
4. 🟡 **Login claims through helpers.** Partly fixed later: a server action now reads "requires login ✓" when its first awaited call is a helper of the app that turns guests away itself (a redirect, a throw or `notFound()`; not `return null`), directly or one helper further down. All of Huddle's actions now get it. Review 31 took six rounds (12, 10, 3, 1, 2, then clean). It made the check structural: only awaited calls at the top of the action, before any write, loop, try or branch. A helper whose own check sits in a try, with a catch that doesn't rethrow the redirect first, doesn't count. Then "only lets the workspace's members in ✓" (later): a server action gets it when its login helper also
   looks up the logged-in user's membership of the workspace it's given and stops when there's none, and every Prisma read
   and write in the action is limited to that same workspace. Five of Huddle's actions get it (create and update projects
   and tasks, revoke an invite). Review 33 took six rounds (12, 6, 9, 3, then nits, then clean) and made it strict, read
   with the TypeScript parser where text matching leaked:
   - the value checked is bound once and never changed, and each write carries it under the workspace's own key
     (`workspaceId: workspaceId`), in `where` for updates and deletes and in `data` for creates;
   - an update can't move a row (no workspace key in its data, no `connect`), and every other id it writes is the
     logged-in user's or was found first by a lookup limited to the workspace, with a stop;
   - reads are limited too, with no `include`/`select` deeper than one level;
   - nothing plain can't follow: OR/NOT, transactions, raw SQL, try, regex literals, `import()`, a repository object,
     a namespace or default import, or a helper that touches tables. Only small local functions that touch nothing.
   - Known misses: helpers written as arrows aren't read; ids under names without "Id" (`assignedTo`, a storage key)
     aren't checked; a membership that's pending or soft-deleted still counts.
   Then "only lets the workspace's owners and admins in ✓" (later): when the login helper runs the member check and,
   right away, turns away every other role, on the role from the user's own membership row. Huddle's revoke-invite
   action gets it. Review 35 took three rounds (2, 1, then clean): the role must be returned exactly as read
   (`m.role`, or the filtered relation's first row), from the helper's only return, with nothing changing it before
   (no staff override, no `?? user.role`, not the user's site-wide role). Roles that aren't kinds of person read
   "members with the billing role".
5. ✅ **Public share-link pages** (Huddle p1, Quill p3). Fixed later.
   - Huddle p1's page now adds "It opens from a private link, so only people who have the link can find it."
   - Quill p3 now reads "turns sharing on or off for documents and requires login ✓" (it was "deletes
     documents") and "shows documents to anyone with the link, no login needed" (it was "lists documents").
   - **Review 32** took six rounds (6, 8, 7, 7, 1, then clean). It made every part strict:
     - Pages make no login claim. Next.js middleware, Nuxt's Supabase module and SvelteKit hooks can ask for
       login where plain can't see it, and "only people who have the link" stays true either way.
     - A param counts as a secret only when the lookup compares it with a field named for a link
       (`shareToken`, `public_id`), or a bare `token` on a share, invite or reset table. A coin's
       `[token]`, a cursor, a device token, a row's own id, a number, or a copy of the param doesn't count.
     - "Turns sharing on or off" needs every changing handler to write only link fields, with no
       variables, no raw SQL and no several-row updates. It may call only lookups, login checks named
       for one, responses and token makers: a helper may delete or email.
     - The ⚠ "Anyone can turn sharing on or off" is skipped when the app may guard everything elsewhere
       (`app.use`, FastAPI dependencies or custom middleware, Rails `before_action`, a route wrapper).
   - Known misses: Django `get_object_or_404`, TypeORM `findOneBy`, Mongoose `findOne({ shareToken })` and a
     multi-line `where` with a same-name field aren't read as lookups, so those cards keep the old wording.
     A Rails job queued without parentheses beside a share update isn't seen.
   - Still open: whether the link can be guessed from how it's made, whether it expires, and what the
     page shows ("It shows project shares" on Huddle p1 is really the project board).
6. **"Only people in this room"** (Porch p2, p3): a membership check before a 403 should upgrade
   "requires login ✓".
7. ✅ **Migration wording** (Prisma). Fixed later.
   - **A new column on a table the app already had:** the step now says "pages that load workspaces can fail too, not
     just the new parts (Prisma asks for every column)". This applies to Huddle p5, Porch p1 and p3, and plant-swap.
     A local SQLite repro confirmed it: `findMany` and `update` fail with P2022 until the column exists.
   - **The project's only migrate script is `prisma migrate dev`:** the step adds "Don't use the `db:migrate` script
     there: it runs `prisma migrate dev`, which is for your own computer and can offer to wipe the database". The
     repro showed the reset prompt when the database had drifted.
   - **Review 34** (one round, nothing blocking) confirmed both against Prisma's docs. It narrowed the column rule to
     plain fields: `Unsupported(...)`, `@ignore` and SQL-only columns are never selected.
   - **Still open:**
     - Quill (Alembic/SQLAlchemy) isn't covered.
     - `prisma db push` scripts get no warning.

Smaller items seen on the regenerated cards: the guest sign-in is still a "⚠ problem" (Porch p1); the
"empty catch" false alarm is still there (Quill p5); some wrong nouns remain ("lists memberships" on Huddle p5).

---

## The five reruns (after Codex's usage limit reset)

Codex's usage limit cut these five runs off. They were rerun the next morning and graded the same way. Ground truth
came from the diff before either explanation was read. The full grading is in the scratchpad trials folders; the
cards were made with plain as pushed at that time (commit 6b3f57c).

| App | # | Persona | Request |
|---|---|---|---|
| Huddle | 6 | Vague and frustrated | "people say they sometimes see tasks from other teams?? fix it asap" |
| Porch | 4 | Junior developer | "Admins need to ban a user: kick them out of all rooms right away, delete their messages, and stop them from logging back in." |
| Porch | 5 | Experienced developer | "Add per-user rate limiting on messages (5 per 10 seconds) across both the socket and the REST API, store read receipts per room, and make unread counts accurate across devices." |
| Porch | 6 | Vague and frustrated | "messages show up twice sometimes and the app is slow, fix it" |
| Quill | 6 | Vague and frustrated | "the AI thing is broken sometimes and really slow, fix it" |

**Results.**

| Branch | 🔴 | plain's verdict | plain's false statements | Codex's false statements |
|---|---|---|---|---|
| Huddle p6 | none (safe hardening; no leak existed on main to fix) | ✓ No problems · "the agent guessed, check the problem is gone" ✅ | "deletes data" for a `DROP CONSTRAINT`; a unique-rule warning on a rule that includes the primary key | "Fixed the cross-team task leak" (none was found) |
| Porch p4 | none | ✓ No problems | none outright; "requires login ✓" where it's admins only | none |
| Porch p5 | none | ✓ No problems | "saves room read receipts" (it deletes them); "a maximum of 5 messages" (it's 5 per 10 seconds per person) | "Five mixed socket/REST limiter consumes succeed" (only direct calls were run) |
| Porch p6 | none | 1 thing to decide: a false "doesn't look related" | "doesn't look related" for the new endpoint; "lists rooms" (it returns one) | "Fixed the duplicate-message and performance issues" (nothing was reproduced) |
| Quill p6 | **1**: a 15-second timeout on a non-streamed answer, so long rewrites now always fail | 1 thing to decide (the cut-off answer guess ✅) | "saves failed reservations" (it deletes them); app/ai.py, 101 of 105 changed lines, only under "Other files" | "Failed or empty responses no longer consume quota" (they never did); "verification passed" (it ran against fakes) |

**What it says.**
- Codex overclaimed on every vague request ("Fixed …") without reproducing the problem. plain's step "You didn't
  say exactly what was wrong, so the agent guessed. Check that the problem you saw is gone." was the most useful
  line on those cards.
- plain caught 0 of 1 🔴 (Quill p6's timeout). Codex caught 0 of 1.
- plain had 6 wrong statements across the five cards; most come from reading a `deleteMany` or `delete` as a save,
  and from reading `DROP CONSTRAINT` as deleting data.
- plain never mentions Porch's live-chat changes on p4–p6 (the events existed on main, and only new events are
  listed).

**Rules this suggests** (not built yet):
1. Only `DROP TABLE`, `DROP COLUMN`, `DELETE` and `TRUNCATE` count as deleting data; skip the unique-rule warning
   when the rule includes the primary key.
2. A `delete` in a route or an `except` branch is a delete, not a save ("un-counts on failure").
3. A limit constant used with a time window reads "5 per 10 seconds".
4. A 🔴 guess when an AI client's timeout is far shorter than `max_tokens` needs and nothing streams.
5. Changed Socket.IO events (not only new ones) get a line.
6. "requires login ✓" upgrades to "admins only ✓" when the route's own check is an admin role.
