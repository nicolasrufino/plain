# Stacks plain understands

plain needs to know, for each stack, three things: **where the pages and server addresses are**,
**how a login check looks**, and **how the database is read and written**. Everything else
(the card, the wording, the checks) is shared.

| Stack | Status |
|---|---|
| Next.js (App Router and `pages/`) | ✅ Supported |
| Node servers: Express (Fastify, Hono written the same way) | ✅ Supported |
| React with React Router (Vite, Create React App) | ✅ Supported |
| Prisma (database) | ✅ Supported |
| **Supabase** (tables, Row Level Security, edge functions) | ✅ Supported |
| Stripe, OpenAI, Anthropic, Resend, Twilio (outside services) | ✅ Recognized |
| **TanStack Start** (Lovable's default since May 2026) | ✅ Supported |
| **Python: FastAPI, Flask** (SQLAlchemy, SQLModel) | ✅ Supported |
| 3. Python: Django (`urls.py`, views, DRF) | 🔜 Next (its ORM and models already work) |
| 4. Vue / Nuxt, SvelteKit | Planned |
| 5. Angular | Planned |
| 6. C#: ASP.NET Core | Planned |
| 7. Java: Spring Boot | Planned |
| 8. Laravel (PHP), Ruby on Rails, Go | Later |

## Why this order

plain is for people who build with AI and don't read the code. So the order follows what
those people actually ship, not what's popular with developers.

- **Supabase is first.** It's the backend for Lovable and Bolt, the usual database for v0
  apps, and AI tools start more than 60% of new Supabase databases ([Lovable FAQ][lovable-faq],
  [Bolt docs][bolt], [v0 docs][v0], [Supabase via Implicator, Jun 2026][supa60]). It's also
  where vibe-coded apps leak data:
  - In Supabase, the browser talks to the database directly. The login check lives in SQL
    policies ("Row Level Security"), not in the code.
  - One scan of 1,645 Lovable apps found 170 whose data anyone could read
    ([CVE-2025-48757][cve]).
  - Another scan of 1,072 apps found a flaw in 98% of them ([Symbiotic, Apr 2026][symb], a vendor).
- **TanStack Start came second.** It's been Lovable's default for new projects since May 2026
  ([Lovable blog][lovable-tss]). It's TypeScript, so it reuses everything plain already has.
- **Python is after that.** It's the most used language with AI tools among developers
  (39%, [Stack Overflow 2026][so]). Its three big frameworks add up to 42% of developers
  (FastAPI 14.8%, Flask 14.4%, Django 12.6%, [SO 2025][so25]). But no AI app builder generates
  Python by default.
- **Vue / Nuxt and SvelteKit next.** They're cheap, because they're TypeScript with file-based
  routes like Next.js. Bolt builds "any JavaScript framework" ([Bolt][bolt-tech]). Their user
  base is smaller: Vue 17.6%, Svelte 7.2%, Nuxt 4.0% ([SO 2025][so25]).
- **Angular after them.** It's widely used (18.2%) and cheap to read with the TypeScript
  compiler. But it's only the frontend, so plain can show pages and calls to the server, not
  whether the data is protected.
- **C# and Java after that.** Both have many developers: ASP.NET Core 19.7%, Spring Boot
  14.7% ([SO 2025][so25]), and 16% / 15% use them with AI ([SO 2026][so]). But no AI app builder
  generates them, so vibe coders only reach them through general agents like Claude Code.
  - Java is still worth it: AI-written Java failed security tests **72%** of the time, the
    worst of any language ([Veracode 2025][veracode]).
  - C# goes first because its app-wide login setting is easy to read reliably.
- **Laravel, Rails and Go come last.** They're less common for this audience (Laravel 8.9%,
  Rails 5.9%), and Bolt can't build PHP. Their migrations are plain SQL, so they'll reuse
  Supabase's SQL reading.

### Most used languages

| Language | Stack Overflow 2026 | Used with AI (SO 2026) | GitHub 2025 | TIOBE Oct 2026 | plain |
|---|---|---|---|---|---|
| JavaScript / TypeScript | 1 (62%) / 6 (44%) | 2 / 4 | 3 / **1** | 6 / 38 | ✅ |
| SQL | 2 (58%) | 5 | – | 9 | 🔜 Supabase migrations |
| Python | 4 (58%) | **1 (39%)** | 2 | **1** | Planned (3) |
| Java | 7 (28%) | 8 | 4 | 4 | Planned (7) |
| C# | 8 (27%) | 7 | 5 | 5 | Planned (6) |
| PHP | – | – | 6 | 12 | Later (8) |
| Go | – | – | 10 | 11 | Later (8) |

Sources: [SO 2026][so-tech], [GitHub Octoverse 2025][octo], [TIOBE][tiobe]. These cover
professional developers, not vibe coders, so we weigh what the AI app builders generate more
heavily.

Weak spots in this evidence: Bolt's default framework and Replit Agent's default stack aren't
officially documented. The surveys cover professional developers, not vibe coders.

---

## Next.js ✅

- **Pages:** `app/**/page.tsx`, and `pages/*.tsx` when the app uses Next.js.
- **Server:** `app/**/route.ts` (one address per file, methods = exported `GET`, `POST`, ...),
  and `pages/api/*` (methods from `req.method === 'POST'`).
- **Login check:** a call to `auth()`, `getServerSession()`, `currentUser()` and similar.
- **Watch for:** admin pages and data-changing routes with no login check.

## Node servers (Express) ✅

- **Server:** `router.get/post/put/patch/delete('/path', ...middleware, handler)` on any
  variable made by `express()`, `Router()`, `fastify()` or `new Hono()`.
- **Addresses** are built from the mounts: `app.use('/api/admin', adminRouter)` +
  `router.get('/users')` = `/api/admin/users`. `:id` is shown as `[id]`. Works with `import`
  and `require()`.
- **Login check:** middleware whose name says so (`requireAuth`, `requireAdmin`,
  `verifyToken`, `passport.authenticate(...)`, `isLoggedIn`, ...). It can sit on the route,
  on the mount, or on the whole router (`router.use(requireAuth)`).
- **Each address is judged on its own.** A file can mix a public list and an admin-only
  delete. An address counts as protected when every handler that changes data checks login.
- **Why name-based:** there's no standard Express auth. Middleware names are what both people
  and agents write, and they're what a reviewer would read too.
- **Not yet:** `app.route('/x').get().post()` chains, middleware passed as arrays, and
  handlers defined in another file and re-exported under a different name.

## React (React Router) ✅

- **Pages:** `<Route path="..." element={<Page />}>`, nested routes (relative paths are
  joined to the parent), `index` routes, `createBrowserRouter([{ path, element, children }])`,
  and lazy pages (`lazy(() => import('./pages/X'))`).
- **Page login check:** a wrapper whose name says so (`<RequireAuth>`, `<ProtectedRoute>`,
  `<PrivateRoute>`), on the route or on a parent layout route.
- **Talks to the server:** `fetch` with its method, axios (also `axios.create({ baseURL })`),
  and your own helpers that wrap fetch (`api('/x')` when `api` calls `` fetch(`/api${path}`) ``).
- **Secrets in the browser.** Env vars named `VITE_*`, `NEXT_PUBLIC_*`, `REACT_APP_*` or
  `EXPO_PUBLIC_*` are copied into the code every visitor downloads. A secret-looking one
  (`SECRET`, `SERVICE_ROLE`, `PRIVATE`, `PASSWORD`) is flagged as unsafe. One that looks like an
  API key or token is a "thing to decide", since some keys are meant to be public. Leaked
  service-role keys in frontend bundles are a common finding in vibe-coded apps
  ([Escape, Oct 2025][escape]).
- **Keep in mind:** a login check in the browser only hides the page. The data is protected
  only if the server checks too, and plain checks the server addresses separately.

## Prisma ✅

- **Tables and columns** from `schema.prisma`, and links between tables.
- **Before you ship:** removed columns or tables (data deleted for good), schema changes
  without a migration, migrations containing `DROP`.

---

## Supabase ✅

How a Supabase app works: the browser calls `supabase.from('orders').select()` directly. The
only thing stopping anyone from reading or changing every row is the table's **Row Level
Security (RLS)** policies, written in SQL in `supabase/migrations/*.sql`.

**What plain reads**
- **Migrations:** `supabase/migrations/*.sql`, replayed in order. That gives tables, columns,
  links to other tables, RLS on/off, policies (created, changed, dropped) and public storage
  buckets.
- **Browser and server code:** `supabase.from('t').select/insert/update/upsert/delete`,
  `supabase.functions.invoke('name')` and `supabase.auth.getUser()`.
- **Edge functions:** `supabase/functions/<name>/index.ts` is a server address at
  `/functions/v1/<name>`. Their secrets come from `Deno.env.get(...)`, and their imports can be
  `npm:`, `jsr:` or `esm.sh`.

**What plain warns about.** Each item comes from Supabase's own database checks
([advisors][advisors]) or a real incident:

| Situation | Card says | Level |
|---|---|---|
| A table with RLS off | "Anyone can read and change every row of …" (exactly CVE-2025-48757) | ⚠ |
| `using (true)` for reading | "Anyone … can read …". ⚠ for private-sounding tables (users, orders, messages, or columns like email or phone); otherwise a "thing to decide", since a public catalog is normal | ⚠ / ! |
| Only checks "is logged in" (`auth.role() = 'authenticated'`) | "Every logged-in user can read every one of your …, including other people's" | ⚠ / ! |
| `with check (true)` / `using (true)` for writing | "… can change / delete every one of …". Inserts into tables without an owner (a contact form) are a "thing to decide" | ⚠ / ! |
| A rule that trusts `user_metadata` | users can edit it themselves | ⚠ |
| Users can set `status`, `paid`, `role`, `credits`, … on their own rows | the CVE-2025-48757 "mark it paid" trick | ! |
| RLS on but no rule, for a table the app uses | the app can't read or save it | ! |
| A public storage bucket | anyone with the link can open the files | ! |
| A view without `security_invoker` | it skips the access rules of the tables it reads | ⚠ / ! |
| A migration that empties a table, deletes all rows, or changes a column's type | "Back up your data first" | before you ship |

**Before you ship:**
- Every new migration gets a reminder to reach the live database (`supabase db push`; Lovable
  does it for you).
- Edge-function secrets go into Supabase's secrets, not your hosting. `SUPABASE_URL` and its
  keys are provided by Supabase, so they're not listed.

**Design decisions**
- **The whole history, not just the diff.** RLS is rebuilt from all migrations, because one
  change can make an old table unsafe. The card only shows findings that are new in this
  change.
- **Honest wording.** When the card says anything about access rules, it adds that they're
  read from `supabase/migrations`, and that rules changed in the Supabase dashboard aren't
  visible.
- **Parser: `libpg-query` 18.2.1.** It's the real Postgres parser in WebAssembly: 1.9 MB, no
  install scripts, loads in about 7 ms, parses a migration in about 6 ms. Regular expressions
  were ruled out because comments, quoted names and function bodies (`$$ ... $$`) that contain
  policy-like text would fool them. A file Postgres can't parse is skipped, not guessed at.
- **Rules are read as a tree, not as text.**
  - `auth.uid() = user_id`, and the faster `(select auth.uid()) = user_id`, mean "your own rows".
  - `auth.uid() is not null`, `auth.role() = 'authenticated'` and `auth.jwt() ->> 'role'` mean
    "any logged-in user".
  - `true`, `1 = 1` and `x or true` mean "everyone".
  - Restrictive rules (`as restrictive`) narrow what the other rules allow.
  - Rules only for `service_role` are ignored, since that key skips the rules anyway.
  - A check hidden in a subquery or helper function (like an admin lookup) is trusted, so it
    never raises an alarm.
- **Other things the replay keeps track of:**
  - `create table if not exists` for an existing table changes nothing.
  - Renamed tables keep their rules.
  - `revoke ... from anon, authenticated` takes a table out of the API entirely.
- **Logging in, by where it runs:**
  - `supabase.auth.getUser()` counts as a login check on a server (edge functions, Next.js).
  - In the browser it doesn't, since reading the session redirects nobody.
  - Tables that only edge functions use don't count as "used by your app", because those
    functions usually run with the service key.
- **Private or not is a name-based guess** (users, orders, payments, messages, … or columns
  like email or phone), like the rest of plain. That's why reading rules on other tables are
  "things to decide", not alarms.

**Not yet:**
- `security definer` functions callable by anyone
- `verify_jwt = false` in `supabase/config.toml`
- grants on single columns
- `rpc()` and storage calls from the browser
- logic hidden inside helper functions used in rules

## TanStack Start ✅

Lovable's default for new apps since May 2026, usually with Supabase.

- **Pages** come from file names in `src/routes/`:

  | File | Address |
  |---|---|
  | `index.tsx` | `/` |
  | `classes.$classId.tsx` or `classes/$classId.tsx` | `/classes/[classId]` |
  | `_authed/my-bookings.tsx` | `/my-bookings` (`_authed` is a layout, not part of the address) |
  | `(shop)/cart.tsx` | `/cart` |
  | `posts_.$postId.edit.tsx` | `/posts/[postId]/edit` |
  | `account/route.tsx` | `/account` |
  | `files/$.tsx` | `/files/[rest]` |
  | `-components/…`, `__root.tsx`, `routeTree.gen.ts` | not pages |

  The address comes from the **file path**, not from the `createFileRoute('...')` string in
  the file: that string is generated by a tool and can be stale in a diff.
- **Login check on a page:** a `beforeLoad` that redirects or throws when there's no user,
  on the page or any layout above it (`_authed.tsx` covers everything inside `_authed/`).
  TanStack's docs warn that this hides the page but doesn't protect its data, so plain checks
  the server side separately.
- **Server actions:** `createServerFn({ method }).middleware([...]).handler(...)`. Each one is
  a piece of server code that the browser can call, shown as "the "save class" action on your
  server".
  - A login check is an auth-sounding middleware, `getUser()` inside the action, or an
    app-wide `functionMiddleware` / `requestMiddleware` in `src/start.ts`.
  - Pages that call an action (directly or through `useServerFn`) "load" or "send" its data.
- **Server routes** (webhooks, APIs): `createFileRoute(...)({ server: { handlers: { POST } } })`,
  and the older `createServerFileRoute(...).methods(...)`.
- **The database part** is Supabase, so the two together cover Lovable's default stack.
- **Any stack:** server code that an admin page calls is treated as admin-only. A missing
  login check there is ⚠, whatever the code is called.

## Python: FastAPI and Flask ✅ (Django 🔜)

- **Addresses:**
  - FastAPI: `@app.get('/x/{id}')` and `@router.post(...)` on `FastAPI()` / `APIRouter(prefix=...)`.
    Router prefixes add up with `include_router(..., prefix=...)`, across files.
  - Flask: `@app.route('/x/<int:id>', methods=[...])` and `@bp.post(...)` on `Blueprint(url_prefix=...)`,
    plus `register_blueprint(..., url_prefix=...)`.
  - Path parameters become `[id]`, like everywhere else.
- **Login checks:**
  - FastAPI:
    - `Depends(get_current_user)` / `Security(...)` in a route's parameters
    - `dependencies=[Depends(...)]` on the route, the router, or `include_router`
  - Flask:
    - `@login_required`, `@jwt_required()`, `@admin_required`
    - a blueprint's `before_request` that aborts or redirects
  - Inside a handler: a check on `current_user` / `request.user` that aborts with 401/403,
    raises or redirects.
  - Names are matched like in Express, since there's no standard (`get_current_user`,
    `require_admin`, `verify_token`, …).
- **Database:**
  - SQLAlchemy / SQLModel: `session.add(Order(...))`, `session.delete(order)`,
    `Order.query.filter(...).delete()`, `select(Order)`.
  - Django ORM: `Order.objects.create/update/delete`.
  - Supabase-py: `supabase.table('orders').insert(...)`.
  - Models: `class Order(db.Model)`, `(Base)`, `(SQLModel, table=True)` or `(models.Model)`.
    Their fields and links show up in the database part of the card, like Prisma.
- **Before you ship:**
  - Migrations: plain notices changed models with no new Alembic / Flask-Migrate / Django
    migration, and `drop_table` / `drop_column` / `RemoveField` in `upgrade()`.
  - Env vars: `os.environ[...]`, `os.getenv('X')` and `config('X')`. A real default means
    it's optional.
  - New packages from `requirements.txt` and `pyproject.toml`.
- **The mistakes AI makes most in Python** (from Bandit and Semgrep rules, and the
  [Veracode 2025 report][veracode]: 38% of AI-written Python had a flaw):

  | In the code | Card says | Level |
  |---|---|---|
  | `DEBUG = True`, `app.run(debug=True)` | error pages can show visitors your code and settings | ⚠ |
  | `SECRET_KEY = '...'`, `app.secret_key = '...'` | anyone who sees the code can fake logins | ⚠ |
  | `execute(f"... {x}")`, `text(f"...")`, `.raw(f"...")` | SQL injection | ⚠ |
  | `allow_origins=["*"]`, `CORS(app)`, `CORS_ALLOW_ALL_ORIGINS = True` | any website can call your server | ! |
  | `@csrf_exempt` | other sites could submit that form for a logged-in visitor | ! |

- **Any stack:** an address under `/admin` with no login check is ⚠ even if it only *reads*
  data. An admin export is a data leak.
- **Parser: tree-sitter, not the user's `python3`.**
  - The Python on a user's machine is often old (the Mac default is 3.9) or missing.
  - Python's own `ast` can't read syntax newer than itself, and gives up on a whole file at
    the first error.
  - tree-sitter-python (MIT, 0.5 MB, in `vendor/`) loads in about 8 ms, handles `match`,
    `type` aliases and modern f-strings, and keeps going past syntax errors.
- **Django, next:** routes in `urls.py` (`path()`, `include()`); methods come from the view;
  DRF routers create several addresses from one line. Login checks: `@login_required`,
  `LoginRequiredMixin`, `permission_classes`, and `DEFAULT_PERMISSION_CLASSES`. Without that
  setting, DRF allows everyone, which plain should say.

## Vue / Nuxt and SvelteKit (planned)

- **Nuxt:**
  - Pages come from `pages/`.
  - Server code lives in `server/api/*.ts` (`defineEventHandler`). A file named
    `orders.post.ts` only accepts POST.
  - `server/middleware` runs on every request, so a login check there covers everything.
- **SvelteKit:**
  - `+page.svelte` is a page.
  - `+page.server.ts` holds the data loading and form `actions`.
  - `+server.ts` exports `GET` and `POST`.
  - `hooks.server.ts` can check login for every request.
- **Close to what plain already does:** both work like Next.js file routes plus TypeScript.
  `.vue` and `.svelte` files need their `<script>` part pulled out first, using the official
  `@vue/compiler-sfc` and `svelte/compiler`.

## Angular (planned)

- **Pages:** `Routes = [{ path, component | loadComponent, canActivate: [authGuard], children }]`.
  This is close to React Router objects, which plain already reads.
- **Talks to the server:** `HttpClient.get/post/put/delete(...)`, usually with
  `environment.apiUrl`.
- **Limit:** Angular is only the frontend. A route guard hides a page, but it doesn't protect
  data. The card will say so, and the server needs its own stack support to be checked.

## C#: ASP.NET Core (planned)

- **Addresses:** controllers (`[Route("api/[controller]")]` + `[HttpGet("{id}")]`), and
  minimal APIs (`app.MapGet("/x", ...)`, `app.MapGroup("/api")`).
- **Login checks:** `[Authorize]` / `[AllowAnonymous]` on a class or method, and
  `.RequireAuthorization()` on a route or group.
  - **App-wide:** a `FallbackPolicy` that requires login makes every address protected unless
    it says otherwise ([Microsoft docs][aspnet]). In that case plain reports the
    `[AllowAnonymous]` exceptions instead.
- **Database:** Entity Framework `DbSet<T>`, `Add` / `Remove` / `SaveChanges`. Migrations live
  in `Migrations/*.cs`; `DropTable` or `DropColumn` inside `Up()` deletes data.
- **To flag:** CORS open to every site (`AllowAnyOrigin()`), and secrets written into
  `appsettings.json`.
- **Parser:** tree-sitter-c-sharp is about 4–5 MB, the biggest of all. Load it only when the
  repo has `.cs` files.

## Java: Spring Boot (planned)

- **Addresses:** `@RequestMapping("/api/orders")` on the class + `@GetMapping("/{id}")`,
  `@PostMapping` on methods.
- **Login checks:** mostly in one place, the `SecurityFilterChain`:
  `requestMatchers("/admin/**").hasRole("ADMIN")`, `.permitAll()`,
  `anyRequest().authenticated()`. The first matching rule wins, so plain has to read them in
  order ([Spring docs][spring-authz]). Per-method checks use `@PreAuthorize` / `@Secured`.
  With Spring Security installed and no rules, everything requires login by default.
- **Database:** JPA `@Entity`, repositories `save` / `delete`. Migrations are Flyway
  `db/migration/V2__*.sql` (plain SQL, shared with Supabase) or Liquibase `dropTable` /
  `dropColumn`.
- **To flag:** `csrf` turned off, `anyRequest().permitAll()`, CORS `*`.
- **Parser:** tree-sitter-java, about 0.4 MB.

## Laravel, Rails, Go (later)

They share the same shape: a routes file or registrations, middleware for login, an ORM, and
migrations. The things to get right:

- **Rails:**
  - `resources` creates 7 addresses.
  - `before_action :authenticate_user!` in `ApplicationController` covers everything, so report
    the `skip_before_action` exceptions instead.
  - `Model.find(params[:id])` lets anyone open anyone's record.
- **Laravel:**
  - `routes/api.php` addresses start with `/api`.
  - Login checks come from `Route::middleware('auth')->group(...)` and from controller
    middleware.
  - A form request whose `authorize()` just returns `true` checks nothing.
- **Go:**
  - `mux.HandleFunc("POST /x/{id}", h)` (Go 1.22), plus chi and gin groups.
  - Wrapping the whole server in auth (`ListenAndServe(addr, withAuth(mux))`) covers every
    address.
  - golang-migrate and goose migrations are plain SQL.

---

## Sources

Research done 2026-10. Vendor reports are marked.

- [lovable-faq]: https://docs.lovable.dev/introduction/faq
- [lovable-tss]: https://lovable.dev/blog/building-apps-using-tanstack-start (2026-06-01)
- [bolt]: https://support.bolt.new/integrations/supabase.md
- [v0]: https://v0.app/docs/full-stack-apps
- [supa60]: https://www.implicator.ai/supabase-doubles-to-10-5-billion-as-agents-deploy-most-of-its-databases/ (2026-06-04, CEO quote reported secondhand)
- [cve]: https://mattpalmer.io/posts/statement-on-CVE-2025-48757/ and https://nvd.nist.gov/vuln/detail/CVE-2025-48757
- [symb]: https://www.symbioticsec.ai/blog/we-scanned-1-072-vibe-coded-apps-98-had-security-flaws (vendor)
- [escape]: https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/ (vendor)
- [advisors]: https://supabase.com/docs/guides/database/database-advisors
- [so]: https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/
- [veracode]: https://www.veracode.com/resources/genai-code-security-report/
- Flask blueprints: https://flask.palletsprojects.com/en/stable/blueprints/
- FastAPI bigger apps: https://fastapi.tiangolo.com/tutorial/bigger-applications/
- DRF permissions: https://www.django-rest-framework.org/api-guide/permissions/
- Supabase RLS: https://supabase.com/docs/guides/auth/row-level-security
- Supabase function config: https://supabase.com/docs/guides/functions/function-configuration
- Go routing: https://go.dev/blog/routing-enhancements
- Laravel routing: https://laravel.com/docs/11.x/routing
- Bolt supported technologies: https://support.bolt.new/building/supported-technologies
- Stack Overflow 2025 (web frameworks): https://survey.stackoverflow.co/2025/technology
- Stack Overflow 2026 (languages): https://survey.stackoverflow.co/2026/technology
- GitHub Octoverse 2025: https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/
- TIOBE index: https://www.tiobe.com/tiobe-index/
- ASP.NET Core authorization (fallback policy): https://learn.microsoft.com/en-us/aspnet/core/security/authorization/secure-data
- Spring Security request authorization: https://docs.spring.io/spring-security/reference/servlet/authorization/authorize-http-requests.html
- Nuxt server directory: https://nuxt.com/docs/4.x/directory-structure/server
- SvelteKit routing: https://svelte.dev/docs/kit/routing

[lovable-faq]: https://docs.lovable.dev/introduction/faq
[lovable-tss]: https://lovable.dev/blog/building-apps-using-tanstack-start
[bolt]: https://support.bolt.new/integrations/supabase.md
[v0]: https://v0.app/docs/full-stack-apps
[supa60]: https://www.implicator.ai/supabase-doubles-to-10-5-billion-as-agents-deploy-most-of-its-databases/
[cve]: https://mattpalmer.io/posts/statement-on-CVE-2025-48757/
[symb]: https://www.symbioticsec.ai/blog/we-scanned-1-072-vibe-coded-apps-98-had-security-flaws
[escape]: https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/
[advisors]: https://supabase.com/docs/guides/database/database-advisors
[so]: https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/
[veracode]: https://www.veracode.com/resources/genai-code-security-report/
[so25]: https://survey.stackoverflow.co/2025/technology
[so-tech]: https://survey.stackoverflow.co/2026/technology
[octo]: https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/
[tiobe]: https://www.tiobe.com/tiobe-index/
[bolt-tech]: https://support.bolt.new/building/supported-technologies
[aspnet]: https://learn.microsoft.com/en-us/aspnet/core/security/authorization/secure-data
[spring-authz]: https://docs.spring.io/spring-security/reference/servlet/authorization/authorize-http-requests.html
