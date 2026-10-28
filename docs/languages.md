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
| Drizzle (database) | ✅ Supported |
| **Supabase** (tables, Row Level Security, edge functions) | ✅ Supported |
| Stripe, OpenAI, Anthropic, Resend, Twilio (outside services) | ✅ Recognized |
| **TanStack Start** (Lovable's default since May 2026) | ✅ Supported |
| **Python: FastAPI, Flask** (SQLAlchemy, SQLModel) | ✅ Supported |
| **Python: Django** (`urls.py`, views, Django REST Framework) | ✅ Supported |
| **Vue / Nuxt, SvelteKit** | ✅ Supported |
| **Angular** | ✅ Supported |
| **C#: ASP.NET Core** | ✅ Supported |
| 7. Java: Spring Boot | 🔜 Next |
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
| A `security definer` function still callable by `anon`/`authenticated` (revoking from `public` isn't enough) that doesn't check the caller | anyone with the public key can run it | ⚠ if it writes, ! if it only reads |
| `create or replace function` on one that already exists | "Test what X does": a rule the app relied on was rewritten | before you ship |
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

## Python: FastAPI, Flask and Django ✅

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

## Django ✅

Django splits a route in two: `urls.py` says the address, and a view in `views.py` says what
happens there. plain joins them, so the card names the address and the facts come from the view.

- **Addresses:**
  - It starts from each `urls.py` that no other one includes (the project's root), then
    follows `include('shop.urls')`, `include(shop_urls)` and namespaced
    `include(('shop.urls', 'shop'))` down.
  - Views are found however they're imported: `from . import views`, `from .views import X`,
    a `views/` package that re-exports from `__init__.py`, or `from .views import *`.
  - `path('orders/<int:pk>/', ...)` and `re_path(r'^orders/(?P<pk>\d+)/$', ...)` both become
    `/orders/[pk]`.
  - `admin/` (Django's own admin site) is skipped. It has its own login.
  - DRF routers: `router.register('orders', OrderViewSet)` makes `/orders` (list, create)
    and `/orders/[pk]` (read, update, delete), plus one address per `@action`
    ([DRF routers][drf-routers]). The router can live in its own file, and
    `http_method_names` or `as_view({'get': 'list'})` narrow what it answers.
- **Which methods a view answers** ([Django: view decorators][dj-http]):
  - `@require_POST`, `@require_GET`, `@require_http_methods([...])`, `@api_view([...])`.
  - Class views: their own `get` / `post` / … methods, plus what the base class adds:
    `CreateView` saves, `UpdateView` updates, `DeleteView` deletes; DRF's
    `ListCreateAPIView`, `ModelViewSet`, its mixins, and so on. The database part comes
    from `model = Order` or `queryset = Order.objects...`.
  - A plain function view answers every method. If it checks `request.method`, plain uses
    those; otherwise it's a POST if it changes data, a GET if not.
  - `CreateView` and `FormView` also answer GET, but only to show an empty form, so plain
    leaves that out.
- **Login checks:**
  - `@login_required`, `@permission_required`, `@user_passes_test`,
    `@staff_member_required`, or `login_required(views.x)` in `urls.py`
    ([Django auth][dj-auth]).
  - `LoginRequiredMixin` and the other `*RequiredMixin`s, or
    `@method_decorator(login_required, name='dispatch')` (also with a list of decorators).
    With `name='get'`, only GET needs login: POST is still open, and plain says so.
  - Base classes are followed, also across files: a view built on your own
    `OwnerOnlyMixin(LoginRequiredMixin)` or `AuthedViewSet` gets their login checks and
    their routes.
  - In the view: `if not request.user.is_authenticated:` followed by a redirect to login,
    `raise PermissionDenied`, `HttpResponseForbidden()` or a 401/403 status.
  - Django 5.1's `LoginRequiredMiddleware` makes every view need login, except
    `@login_not_required` ones ([Django 5.1][dj-51]). It doesn't cover DRF views: DRF 3.16
    exempts them, so their own permissions decide.
- **Django REST Framework permissions** ([DRF permissions][drf-perm]). This is the one most
  worth getting right:
  - **With no setting, DRF lets everyone in** (`AllowAny`). So a new API view that changes
    data gets ⚠ unless something checks login.
  - `DEFAULT_PERMISSION_CLASSES` in `REST_FRAMEWORK` settings applies to every DRF view
    without its own `permission_classes`.
  - `IsAuthenticated`, `IsAdminUser` and `DjangoModelPermissions` mean login is required.
  - `IsAuthenticatedOrReadOnly` means login is required only to change things.
  - `AllowAny` (or `[]`) on a view overrides the settings and lets everyone in.
  - `IsAuthenticated | ReadOnly` lets anyone read (either one is enough); `~IsAuthenticated`
    is never a login check.
  - `get_permissions()`: plain follows its branches on `self.action` and on
    `request.method` / `SAFE_METHODS`, a `permission_classes_by_action` map, and
    `super().get_permissions()`. A branch it can't read (two conditions, a list held in a
    variable) is skipped, so the result leans toward a warning, never a false ✓.
  - `as_view(permission_classes=[AllowAny])` in `urls.py` overrides the class's own.
  - Custom classes count by name (`IsAdmin…`, `IsStaff…`). `IsOwnerOrReadOnly` on its own
    is **not** a login check: DRF only asks it about existing rows, so anyone can still
    create one.
- **What a view does** includes the helper functions it calls (`create_order()` in
  `services.py`), `order.save()` / `order.delete()`, and query chains split over lines.
  This applies to FastAPI and Flask routes too.
- **Before you ship:** a new migration file gets "apply it to your live database before the
  new code goes live (`python manage.py migrate`)". Changed models with no migration get
  `makemigrations`.
- **Email:** Django's `send_mail()` / `EmailMessage` count as "emails people".
- **Already there from the Python support:** the Django ORM, models, `makemigrations`,
  `DEBUG = True`, a `SECRET_KEY` in the code, `@csrf_exempt`, `.raw(f"...")`.
- **Not yet:** Django templates (what pages say), and `csrf_exempt` applied in `urls.py` or
  with `method_decorator`.

## Vue / Nuxt and SvelteKit ✅

Both are file-routed like Next.js, so plain reads them the same way: each page and each server
address is a unit, with the facts of its own code. Bolt generates both
([Bolt: supported technologies][bolt-tech]).

- **`.vue` and `.svelte` files:** plain keeps the `<script>` part as is and turns the template
  into JSX: directives (`v-if`, `@click`, `:prop`, `on:click`, `bind:`) are dropped, `{{ x }}`
  becomes `{x}`, Svelte's `{#if}`/`{#each}` blocks are unwrapped. Then the React rules read
  what the page says, its buttons, forms and links. No compiler is added. If the converted
  template doesn't parse cleanly, plain keeps only the script's facts: fewer facts, never
  wrong ones.
- **What counts as a login check** (both frameworks), read from the code's structure, not its
  words:
  - an `if` that tests the logged-in user (`!locals.user`, `!session?.user`, `!loggedIn.value`,
    `user?.role !== 'admin'`) and stops: a redirect, `navigateTo`, a 401/403, or (inside a
    handler, action or load) a `return`; or a helper named for it (`requireUserSession`,
    `requireUser`, `requireAdmin`, …);
  - not a looked-up row (`if (!user) throw 404`), a form field (`!body.user`), a 400, or
    `user && user.role !== 'admin'` (anonymous visitors pass that);
  - not when another condition is ANDed in that plain can't place (`to.meta.requiresAuth &&
    …`, `method !== 'GET' && …`): it might cover anything, so plain assumes it covers nothing;
  - in a hook or middleware, an early `return` before the check lets those requests through
    (`if (!sessionCookie) return resolve(event)` means anonymous visitors never reach it).

### Nuxt

- **Pages:** `pages/orders/[id].vue` is `/orders/[id]` (also `app/pages/` in Nuxt 4);
  `[...slug]` is a catch-all, `(group)` folders add nothing.
- **Server:** `server/api/orders.post.ts` is POST `/api/orders`; `server/routes/` has no
  `/api` prefix. A file without a method suffix answers every method, so plain calls it POST if
  it reads a body or changes data ([Nuxt: server][nuxt-server]).
- **Talks to the server:** `$fetch`, `useFetch`, `useLazyFetch`; links: `<NuxtLink to>`,
  `navigateTo()`.
- **Login checks that protect data:**
  - in the handler: `requireUserSession(event)` (nuxt-auth-utils) on its own, or
    `getUserSession`, `serverSupabaseUser`, `getServerSession`, `event.context.user` followed
    by a `throw createError({ statusCode: 401 })`;
  - in `server/middleware/`: the same check covers every server route, or only the paths it
    tests (`pathname.startsWith('/api/admin')`).
- **Login checks that only hide pages:** route middleware (`middleware/auth.ts` used through
  `definePageMeta({ middleware: 'auth' })`, or `*.global.ts`). It runs in the Vue part of the
  app and never protects `server/api` ([Nuxt: middleware][nuxt-mw]). A page can say "log in"
  while its API is open; plain checks each one separately.

### Drizzle (any JavaScript stack)

Drizzle is the other common database library next to Prisma. SvelteKit's own CLI offers it as an
add-on (`npx sv add drizzle`, [SvelteKit CLI][sv-drizzle]), and NuxtHub's database layer is
built on it ([NuxtHub][nuxthub-db]).

- **Tables:** `export const orders = pgTable('orders', { ... })` (also `sqliteTable`,
  `mysqlTable`): the columns, and links from `.references(() => users.id)`.
- **Reads and writes:** `db.insert(orders)`, `db.update(orders)`, `db.delete(orders)`,
  `db.select().from(orders)`, `db.query.orders.findMany()`, and the same on a transaction `tx`.
- **Before you ship:** a new migration in `drizzle/` gets "apply it before the new code goes live
  (`npx drizzle-kit migrate`)". Changed tables with no migration get `drizzle-kit generate`, or
  `drizzle-kit push` for apps that don't keep migration files.

### SvelteKit

- **Pages:** `src/routes/(app)/orders/[id=integer]/+page.svelte` is `/orders/[id]`. What
  its `load` functions read is what the page shows.
- **Server:** `+server.ts` exports one handler per method. Form `actions` in
  `+page.server.ts` are POSTs to the page's own address; `<form method="POST">` on the page
  sends to them ([SvelteKit: form actions][kit-actions]).
- **Login checks, and what each one covers:**
  - `hooks.server.ts` (`handle`) runs before everything: pages, form actions and `+server.ts`.
    A check there covers the paths (`url.pathname.startsWith('/admin')`) or route groups
    (`event.route.id?.startsWith('/(app)')`) it tests.
  - A `+layout.server.ts` load that redirects keeps people out of the pages under it, and
    that's all. **Form actions run before any load function, and `+server.ts` never runs one**
    ([SvelteKit: form actions][kit-actions], [loading data][kit-load]). So a page that asks
    for login can have a form anyone can submit. plain says exactly that when it happens.
  - A page's own `+page.server.ts` load runs without the layout's check unless it calls
    `await parent()` first: its data can be fetched directly. plain warns when that load reads
    the database or an outside service.
  - Each method in `+server.ts` is checked on its own: a check in `GET` doesn't cover `DELETE`.
  - Inside an action or handler: `locals.user` / `locals.session` / `locals.auth()` /
    `safeGetSession()` followed by `redirect`, `error(401)` or `fail(401)`.
- **Env vars:** `import { STRIPE_SECRET_KEY } from '$env/static/private'`, and `env.X` from
  `$env/dynamic/private`.

## Angular ✅

Angular is only the browser side. plain reads its pages and what they do, and says plainly what
a route guard can't do.

- **Pages:** the `Routes` array (`app.routes.ts`): `{ path: 'orders/:id', component }`,
  `loadComponent: () => import('./x').then(m => m.X)`, `children`, and lazy child routes
  (`loadChildren: () => import('./admin/admin.routes')`, which put that file's routes under the
  path and behind its guard) ([Angular: routes][ng-routes]).
- **What a page shows and does:** the component's template (`templateUrl` or `template`)
  is read like a React page: `{{ x }}` (with `| currency` read as a price), the new `@if` /
  `@for` blocks, buttons, forms (`formControlName` is the field's name), and links
  (`routerLink`, `[routerLink]="['/orders', o.id]"`). Its services' `HttpClient` calls
  (`http.get('/api/orders')`) are what it loads from and sends to the server.
- **Login:** `canActivate` / `canMatch` / `canActivateChild` with a login guard (`authGuard`,
  an inline `inject(Auth).isLoggedIn()`) means "You have to log in to open it". `canDeactivate`
  doesn't count: it guards leaving a page, not entering it.
- **What a guard can't do:** "Never rely on client-side guards as the sole source of access
  control" ([Angular: route guards][ng-guards]). A guard hides the page; the data is safe only if
  the server checks login too. When the server isn't in the same project (common for Angular),
  the card says so, because plain can't check it.

## C#: ASP.NET Core ✅

- **Addresses:**
  - Controllers: `[Route("api/[controller]")]` on the class and `[HttpPost("{id}/refund")]` on
    the action (`[controller]` and `[action]` filled in; a template starting with `/` or `~/`
    ignores the controller's route).
  - Minimal APIs: `app.MapPost("/orders", ...)`, groups (`var api = app.MapGroup("/api")`,
    nested ones), and groups filled by extension methods in other files
    (`app.MapGroup("/coupons").MapCoupons()`). `{id:int}` becomes `[id]`.
- **Who an address lets in, the way ASP.NET decides it** ([Microsoft: simple
  authorization][aspnet-simple], [fallback policy][aspnet]):
  - `[AllowAnonymous]` / `.AllowAnonymous()` anywhere on the way: open, whatever else says.
  - Otherwise `[Authorize]` / `.RequireAuthorization()` on the endpoint, its controller, or a
    group above it: login required.
  - Otherwise the app-wide `FallbackPolicy = ...RequireAuthenticatedUser()` (or, for
    controllers, a global `AuthorizeFilter` / `MapControllers().RequireAuthorization()`).
  - With none of those, it's open: "Endpoints without authorization metadata don't use the
    default policy… unless the app configures a fallback policy."
  - In code: `if (userId is null) return Unauthorized();` and the like.
- **Database:** Entity Framework. `DbSet<Order> Orders` says the `Orders` table stores `Order`
  rows (its properties are the columns); `_db.Orders.Add/Remove/ExecuteDeleteAsync`, and
  changing a loaded row then `SaveChangesAsync()`, are writes.
- **Before you ship:** a new migration gets "apply it before the new code goes live
  (`dotnet ef database update`)"; `DropTable` / `DropColumn` in `Up()` gets "back up your data";
  changed entities without a migration get `dotnet ef migrations add`. Settings read with
  `Configuration["Stripe:SecretKey"]` come from the env var `Stripe__SecretKey`.
- **To flag:** CORS open to every site (`AllowAnyOrigin()`), and a real key or password
  written into `appsettings.json` (not `appsettings.Development.json`).
- **Money and email:** Stripe.net (`SessionService`, `EventUtility.ConstructEvent`,
  `RefundService`), SendGrid / SMTP.
- **Parser:** tree-sitter-c-sharp (MIT, 5.3 MB, in `vendor/`), about 40 ms to load.
- **Not yet:** conventional routes (`{controller}/{action}`), Razor Pages and Blazor pages.

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

[drf-perm]: https://www.django-rest-framework.org/api-guide/permissions/
[drf-routers]: https://www.django-rest-framework.org/api-guide/routers/
[dj-http]: https://docs.djangoproject.com/en/5.1/topics/http/decorators/
[dj-auth]: https://docs.djangoproject.com/en/5.1/topics/auth/default/#limiting-access-to-logged-in-users
[dj-51]: https://docs.djangoproject.com/en/5.1/ref/middleware/#django.contrib.auth.middleware.LoginRequiredMiddleware
[nuxt-server]: https://nuxt.com/docs/4.x/directory-structure/server
[nuxt-mw]: https://nuxt.com/docs/4.x/directory-structure/app/middleware
[kit-actions]: https://svelte.dev/docs/kit/form-actions
[kit-load]: https://svelte.dev/docs/kit/load#Implications-for-authentication
[sv-drizzle]: https://svelte.dev/docs/cli/drizzle
[nuxthub-db]: https://hub.nuxt.com/docs/features/database
[ng-routes]: https://angular.dev/guide/routing/define-routes
[ng-guards]: https://angular.dev/guide/routing/route-guards
[aspnet-simple]: https://learn.microsoft.com/en-us/aspnet/core/security/authorization/simple
