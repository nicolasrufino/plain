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
| Stripe, OpenAI, Anthropic, Resend, Supabase, Twilio (outside services) | ✅ Recognized |
| 1. **Supabase** (tables, Row Level Security, edge functions) | 🔜 Next |
| 2. TanStack Start | 🔜 After Supabase |
| 3. Python: FastAPI, Flask, Django | Planned |
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
- **TanStack Start is next.** It's been Lovable's default for new projects since May 2026
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

## Supabase 🔜

How a Supabase app works: the browser calls `supabase.from('orders').select()` directly. The
only thing stopping anyone from reading or changing every row is the table's **Row Level
Security (RLS)** policies, written in SQL in `supabase/migrations/*.sql`.

**What plain will read**
- Calls: `supabase.from('t').select/insert/update/upsert/delete`, `rpc`, `storage`, and
  `functions.invoke('name')`.
- Migrations: tables, columns, `enable row level security`, `create policy ... using (...)
  with check (...)`.
- Edge functions: `supabase/functions/<name>/index.ts`, served at `/functions/v1/<name>`.
- `supabase/config.toml`.

**What plain will warn about.** Each item comes from Supabase's own database checks
([advisors][advisors]) or a real incident:
- A table the app uses with **no RLS turned on**. This is exactly CVE-2025-48757.
- A policy that lets **everyone** in: `using (true)` or `with check (true)`, especially `to anon`.
- A policy that only checks **"is logged in"** (`auth.role() = 'authenticated'`), so every
  user can see every other user's rows.
- A policy based on `user_metadata`, which users can edit themselves.
- Users who can set columns like `status`, `paid`, `role` or `credits` on their own rows. In
  CVE-2025-48757 an insert with `payment_status: "paid"` skipped payment.
- The **service-role key** used in browser code. It skips every policy.
- An edge function with `verify_jwt = false`.
- A public storage bucket.
- Destructive SQL: `drop table`, `drop column`, `truncate`, `delete` without `where`.

**Design decisions**
- **The whole history, not just the diff.** RLS is rebuilt from all migrations, because one
  change can make an old table unsafe.
- **Honest wording.** The card will say "based on this repo's migrations", since policies can
  also be changed in the Supabase dashboard, where plain can't see them.
- **Parser.** Regular expressions break on SQL comments, quoted names, and function bodies
  that contain policy-like text. The candidate is `libpg-query`: the real Postgres parser,
  compiled to WebAssembly, about 1.8 MB. We'll check it installs cleanly with no build step
  before choosing it.

## TanStack Start 🔜

- **Pages** come from file names in `src/routes/`. For example, `posts.$postId.tsx` is
  `/posts/[postId]`. `__root` and `_layout` files aren't pages.
- **Server code:** `createServerFn()` and route `server.handlers`.
- In Lovable apps, the database part is Supabase, so the two together cover Lovable's default.

## Python: FastAPI, Flask, Django (planned)

- **Addresses:**
  - Flask: `@app.route('/x', methods=[...])` and `@bp.post`. Blueprint prefixes come from
    `Blueprint(url_prefix=)`, and `register_blueprint(url_prefix=)` replaces them.
  - FastAPI: `@app.get('/x/{id}')`. `APIRouter(prefix=)` and `include_router(prefix=)` add up.
  - Django: `urls.py` `path()` and `include()`. Methods come from the view (`def get/post`,
    `@require_POST`). DRF routers make several addresses from one line.
- **Login checks, and why they're harder:**
  - Per address: `@login_required` / `@jwt_required()` (Flask), `Depends(get_current_user)`
    in parameters or `dependencies=[...]` (FastAPI), `LoginRequiredMixin` /
    `permission_classes` (Django and DRF).
  - App-wide checks are common, and missing them would cause false alarms:
    - Flask `before_request`
    - FastAPI router- or app-level `dependencies`
    - Django `LoginRequiredMiddleware`
    - DRF `DEFAULT_PERMISSION_CLASSES`. Its absence means everything is public by default,
      which plain should say.
- **Database:**
  - SQLAlchemy / SQLModel models; writes through `session.add` / `delete`.
  - Django models; writes through `objects.create`, `.save()`, `.delete()`.
  - Migrations: Alembic `op.drop_column` / `drop_table` (only in `upgrade()`), and Django
    `RemoveField` / `DeleteModel`.
- **Common AI mistakes to flag:** `DEBUG = True` / `debug=True`, a hard-coded `SECRET_KEY`,
  CORS open to every site, `@csrf_exempt`, and SQL built from f-strings. Sources: Bandit and
  Semgrep rules, and the [Veracode 2025 report][veracode] (38% of AI-written Python had a flaw).
- **Parser decision: tree-sitter (WebAssembly) inside plain, not the user's `python3`.**
  - The `python3` on a user's machine is often old. The Mac default is 3.9, or an install
    prompt.
  - `ast` can't read syntax newer than the Python running it.
  - It gives up on a whole file at the first error, while tree-sitter keeps going.
  - tree-sitter-python is about 0.5 MB and gives every user the same result.

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
