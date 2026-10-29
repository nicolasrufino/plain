// PHP (Laravel): route files, controllers, middleware, Eloquent, migrations, config, Stripe (stripe-php and Cashier), email.
// The same facts plain.ts reads from other stacks; which file loads which routes, and login, are decided in plain.ts:
//  - routes/web.php (web group) and, when bootstrap/app.php registers it (withRouting(api: ...)) or a 10-style RouteServiceProvider
//    does, routes/api.php under /api; files they require or group(base_path(...)) come with that group's prefix and middleware;
//  - middleware from the groups around a route, the route's own, the controller's (HasMiddleware's static middleware(), else a Laravel
//    10 constructor; Laravel 13's #[Middleware] attributes), minus withoutMiddleware ('auth' also removes 'auth:sanctum' since 13.39);
//  - login: auth / auth:guard / auth.basic / verified / password.confirm / can: / Spatie's role: and permission: (when that alias is
//    Spatie's), an app middleware whose handle() turns guests away; in the handler: Gate::authorize, abort_unless(auth()->check()),
//    a FormRequest whose authorize() checks something. Other app middleware: plain can't tell.
// ponytail: Blade views, Inertia pages, Livewire/Volt components and package routes (Fortify, Cashier's /stripe/*) aren't read.
import { adminCond } from './admin.ts'
import type { FileFacts } from './plain.ts'
import { parserFor } from './treesitter.ts'
const parser = await parserFor('tree-sitter-php_only.wasm')   // 1 MB; null when web-tree-sitter isn't installed: PHP files are skipped

type N = import('web-tree-sitter').Node
export type Mw = { mw: string; only?: string[]; except?: string[]; attr?: boolean }   // attr: from a Laravel 13 #[Middleware] / #[Authorize] / #[WithoutMiddleware]
export type PhpRoute = { methods: string[]; path: string; mw: string[]; without: string[]; cls?: string; fn?: string; facts?: FileFacts & { check?: Check }; at: number }   // at: where in the file (routes and includes run in order)
export type Group = { prefix: string; mw: string[]; without: string[] }
export type Check = 'login' | 'policy' | 'crash' | 'unknown' | `owner:${string}`   // the handler turns guests away; through a gate or policy; $this->authorize (needs a trait); rejects in a way plain can't read
export type SchemaOp = { op: 'create' | 'table' | 'drop' | 'rename'; table: string; to?: string; add: string[]; drop: string[]; renames: [string, string][]; loses: boolean; nullable?: string[]; indexOnly?: boolean }   // indexOnly: only adds or drops indexes
export type PhpFacts = FileFacts & { php: {
  routes: PhpRoute[]                                            // Route::get(...) etc. in this file, with the groups around them
  includes: (Group & { file: string; at: number })[]           // require __DIR__.'/auth.php', ->group(base_path('routes/x.php'))
  csrf: string[]                                               // addresses with forgery protection off ('*': all of them)
  methods: Map<string, FileFacts & { check?: Check }>          // Class.method -> facts
  classes: Map<string, { base?: string; illuminate: boolean; traits: string[]; interfaces: string[]; staticMw?: Mw[]; attrMw: Mw[]; methodMw: Map<string, Mw[]>; without: Mw[]; methodWithout: Map<string, Mw[]>; ctorMw: Mw[]; model: boolean; unguarded: boolean; table?: string }>
  middleware: Map<string, 'login' | 'policy' | 'unknown' | 'none'>   // app middleware class -> whether its handle() turns guests away
  adminMw: Set<string>   // ...and its deciding check turns away everyone but admins (`if (! $request->user()?->is_admin) abort(403)`)
  formRequests: Map<string, 'login' | 'unknown' | 'none' | `owner:${string}`>   // FormRequest class -> whether its authorize() turns guests away
  notifications: Map<string, boolean>                          // Notification class -> it emails (via() includes 'mail')
  params: Map<string, string[]>                                // Class.method -> its parameters' types
  schema: SchemaOp[]                                           // a migration's up()
  config: Map<string, { env: string; optional: boolean }>      // config/services.php 'stripe' => ['secret' => env('STRIPE_SECRET')]
  app?: { web?: string[]; api?: string[]; apiPrefix: string; using: boolean; groups: Map<string, string[]>; aliases: Map<string, string> }
  risks: Set<string>
} }

const all = (n: N, type: string) => n.descendantsOfType(type).filter((x): x is N => !!x)
const short = (name: string) => name.replace(/^\\/, '').split('\\').at(-1)!
// 'x', "x" (no variables in it)
const str = (n?: N | null): string | undefined => {
  if (!n) return undefined
  if (n.type === 'string' || n.type === 'encapsed_string') return n.namedChildren.every(c => c?.type === 'string_content' || c?.type === 'escape_sequence') ? n.namedChildren.map(c => c!.text).join('') : undefined
  return undefined
}
const args = (n?: N | null) => ((n?.childForFieldName('arguments') ?? (n?.type === 'attribute' ? n.childForFieldName('parameters') : null) ?? n?.namedChildren.find(c => c?.type === 'arguments'))?.namedChildren ?? [])
  .filter((a): a is N => a?.type === 'argument').map(a => ({ name: a.childForFieldName('name')?.text, v: a.namedChildren.at(-1)! }))
// 'auth', ['auth', 'verified'], Authenticate::class, [X::class, 'y'] -> middleware names (class names shortened; anything else '?')
const names = (n?: N): string[] => !n ? [] : n.type === 'array_creation_expression' ? n.namedChildren.flatMap(e => names(e?.namedChildren.at(-1) ?? undefined))
  : str(n) !== undefined ? [str(n)!] : n.type === 'class_constant_access_expression' && /::class$/.test(n.text) ? [short(n.namedChildren[0]!.text)]
  : n.type === 'scoped_call_expression' && n.childForFieldName('name')?.text === 'using' ? [short(n.childForFieldName('scope')!.text) + ':' + args(n).map(a => str(a.v) ?? '?').join(',')] : ['?']
// a route file path from __DIR__.'/x.php', base_path('routes/x.php'), 'routes/x.php'
const fileArg = (n: N, from: string): string | undefined => {
  const s = [...(n.type === 'string' ? [n] : []), ...all(n, 'string')].map(x => str(x)).find(x => x?.endsWith('.php'))
  if (!s) return undefined
  return /__DIR__/.test(n.text) ? norm(from.replace(/[^/]*$/, '') + s.replace(/^\//, '')) : (from.match(/^((?:[^/]+\/)*?)(?:routes|bootstrap|app|config|database)\//)?.[1] ?? '') + s.replace(/^\//, '')
}
const norm = (p: string) => { const out: string[] = []; for (const s of p.split('/')) s === '..' ? out.pop() : s && s !== '.' && out.push(s); return out.join('/') }
const join = (a: string, b: string) => ('/' + [a, b].join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
// {id} -> [id], {post:slug} -> [post], {name?} -> [name]
export const phpPath = (p: string) => p.replace(/\{(\w+)(:\w+)?\??\}/g, '[$1]')
// Laravel facades: their static calls aren't Eloquent models (an app model may be called Event or Session: plain.ts keeps only
// classes that are models)
const FACADES = /^(Route|Schema|Auth|Gate|Log|Cache|Storage|Http|Str|Arr|Hash|Validator|Inertia|Carbon|CarbonImmutable|Redirect|View|URL|Artisan|Bus|Crypt|Lang|Password|RateLimiter|Redis|Blade|Vite|Mail|Notification|DB|Checkout|Cashier|self|static|parent)$/
// classes from packages: their calls aren't followed (\Stripe\Invoice isn't the app's Invoice model)
const VENDOR = /^(Stripe|Illuminate|Laravel|Symfony|GuzzleHttp|Carbon|Psr|League|Aws|Google|OpenAI|Anthropic|Spatie|Inertia|Livewire|Barryvdh|Maatwebsite|Intervention)\\/
const CSRF = /^(ValidateCsrfToken|VerifyCsrfToken|PreventRequestForgery)$/
const VERBS: Record<string, string[]> = { get: ['GET'], post: ['POST'], put: ['PUT'], patch: ['PATCH'], delete: ['DELETE'], options: ['OPTIONS'], any: ['ANY'] }
const singular = (s: string) => s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('sses') ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s
// orders -> Order, order_items -> OrderItem (Eloquent's table naming, the other way round)
export const modelOf = (table: string) => singular(table).split('_').map(w => w && w[0].toUpperCase() + w.slice(1)).join('')
// Code that turns away visitors who aren't logged in (a handler, an app middleware's handle(), a form request's authorize()).
// 'login' only for a top-level statement, that no earlier statement can return before, where a missing user surely stops the
// request: `if (! $request->user()?->is_admin) abort(403)`, `if ($order->user_id !== auth()->id()) abort(403)`,
// `abort_unless(auth()->check(), 401)`, `if (Auth::guest()) return redirect('/login')`; 'policy' for gates the same way; 'unknown'
// when a rejection elsewhere depends on the user (`if ($request->user() && ...)` lets guests through; a check behind
// `if ($request->is('admin/*'))` or after `return $next($request)` doesn't cover every request): plain then claims nothing.
const GUARDED = String.raw`(?:Auth::guard\([^()]*\)|auth\(\s*['"][\w-]+['"]\s*\)|auth\(\)->guard\([^()]*\))`
const WHO = String.raw`(?:\$request->user\((?:\s*['"][\w-]+['"]\s*)?\)|request\(\)->user\(\)|auth\(\)->user\(\)|Auth::user\(\)|\$this->user\(\)|auth\(\)->check\(\)|Auth::check\(\)|auth\(\)->id\(\)|Auth::id\(\)|${GUARDED}->(?:user|check|id)\(\))`
const GUEST_CALL = String.raw`(?:auth\(\)->guest\(\)|Auth::guest\(\)|${GUARDED}->guest\(\))`
const PROP = String.raw`(?:\??->\w+(?:\([^()]*\))?)?`
const ID = String.raw`(?:auth\(\)->id\(\)|Auth::id\(\)|${WHO}\??->id)`
const FIELD = String.raw`\$(?!request\b)\w+(?:->\w+)+`   // $order->user_id (not $request->user_id: a visitor's own input)
const CODE40X = String.raw`(?:40[13]|Response::HTTP_(?:FORBIDDEN|UNAUTHORIZED))`
const STOP = String.raw`(?:abort\s*\(\s*${CODE40X}|throw\s+new\s+\\?(?:[\w\\]*\\)?(?:AuthenticationException|AuthorizationException|AccessDeniedHttpException|UnauthorizedHttpException)|return\s+redirect\b[^;]*login|return\s+(?:response|to_route)\b[^;]*\b40[13]\b)`
const OR = String.raw`(?:\s*(?:\|\||\bor\b)[^;{]*?)?`
const NO_USER = String.raw`(?:!\s*${WHO}${PROP}|${GUEST_CALL}|${WHO}\??->\w+\s*!==\s*(?:'[^']*'|"[^"]*"|true|${FIELD})|${FIELD}\s*!==\s*${ID}|${ID}\s*!==\s*${FIELD})`
const USER_OK = String.raw`(?:${WHO}${PROP}|${FIELD}\s*===\s*${ID}|${ID}\s*===\s*${FIELD}|${WHO}\??->\w+\s*===\s*(?:'[^']*'|"[^"]*"|true)|${WHO}\s*!==?\s*null|null\s*!==?\s*${WHO})`
const LOGIN_STMT = new RegExp(String.raw`^(?:if\s*\(\s*${NO_USER}${OR}\s*\)\s*\{?\s*${STOP}|abort_if\s*\(\s*${NO_USER}${OR}\s*,\s*${CODE40X}|abort_unless\s*\(\s*${USER_OK}\s*,\s*${CODE40X})`)
const POLICY_STMT = new RegExp(String.raw`^(?:Gate::authorize\s*\(|if\s*\(\s*(?:Gate::denies|!\s*Gate::allows|!\s*Gate::check)\s*\([^;{]*\)\s*\)\s*\{?\s*${STOP}|abort_if\s*\(\s*Gate::denies|abort_unless\s*\(\s*Gate::(?:allows|check))`)
const ABOUT_USER = new RegExp(String.raw`${WHO}|${GUEST_CALL}|Gate::|->can\(|->cannot\(`)
const REJECT = /abort\s*\(|throw\s+new|\b40[13]\b|redirect[^;]*login/
const uncomment = (b: string) => b.replace(/\/\/[^\n]*|#(?!\[)[^\n]*|\/\*[\s\S]*?\*\//g, '')
// does this statement return, or hand the request on ($next($request)), outside a nested function?
// (a return inside a nested function doesn't count; a $next call does: DB::transaction(fn () => $next($request)) runs it)
const escapes = (n: N, next: string, nested = false): boolean => !nested && n.type === 'return_statement' || n.type === 'function_call_expression' && n.childForFieldName('function')?.text === next
  || n.namedChildren.some(c => !!c && escapes(c, next, nested || /^(anonymous_function|arrow_function|function_definition|method_declaration|class_declaration)$/.test(n.type)))
// the walk: `inputs` are variables holding the visitor's request (Request $req, StoreOrderRequest $r), read like $request;
// `$user = $request->user()` makes $user the user
export function userCheck(body?: N | null, inputs: string[] = [], next = '$next', out: { admin?: boolean } = {}): 'login' | 'policy' | 'unknown' | `owner:${string}` | undefined {
  if (!body) return undefined
  let escaped = false
  const users: string[] = []
  const varRe = (v: string) => new RegExp(v.replace('$', '\\$') + '(?!\\w)', 'g')
  const read = (t: string) => { for (const v of inputs) t = t.replace(varRe(v), () => '$request'); for (const v of users) t = t.replace(varRe(v), () => 'auth()->user()'); return t }
  for (const st of body.type === 'compound_statement' ? body.namedChildren : []) {
    if (!st || st.type === 'comment') continue
    const t = read(uncomment(st.text).trim())
    // $user = $request->user(), when it's the only assignment to $user (`$user ??= User::find(...)` later could be anyone)
    const who = t.match(new RegExp(String.raw`^(\$\w+)\s*=\s*${WHO}\s*;$`))
    const v = who?.[1].slice(1), b = body.text
    const once = v && [...b.matchAll(new RegExp(String.raw`\$${v}\s*(?:[-+*/.%]|\?\?)?=(?!=)|\bas\s+(?:\$\w+\s*=>\s*)?&?\$${v}\b|list\s*\([^)]*\$${v}\b|\[[^\]=]*\$${v}\b[^\]]*\]\s*=(?!=)`, 'g'))].length === 1
    if (who && once) { users.push(who[1]); continue }
    // an owner check ($order->user_id !== auth()->id()) holds for guests only while that column can't be empty: plain.ts checks
    const owner = LOGIN_STMT.exec(t)?.[0].match(new RegExp(String.raw`(${FIELD})\s*[!=]==\s*${ID}|${ID}\s*[!=]==\s*(${FIELD})`))
    if (!escaped && owner) return `owner:${(owner[1] ?? owner[2]).split('->').at(-1)}`
    if (!escaped && LOGIN_STMT.test(t)) { out.admin = adminCond(LOGIN_STMT.exec(t)![0]); return 'login' }   // (the deciding part, not an elseif after it)
    if (!escaped && POLICY_STMT.test(t)) return 'policy'
    if (st.type === 'return_statement') break
    if (escapes(st, next)) escaped = true   // some requests leave (or go on) before what follows
  }
  // a rejection that depends on the user, somewhere plain can't be sure covers every request
  const about = (t: string) => ABOUT_USER.test(read(t))
  const ifs = [...all(body, 'if_statement'), ...all(body, 'else_if_clause')].some(i => about(i.childForFieldName('condition')?.text ?? '') && REJECT.test(uncomment(i.text)))
  const aborts = all(body, 'function_call_expression').some(c => /^abort_(if|unless)$/.test(c.childForFieldName('function')?.text ?? '') && about(c.text))
  const gates = all(body, 'expression_statement').some(e => POLICY_STMT.test(uncomment(e.text).trim()))   // Gate::authorize inside a branch
  return ifs || aborts || gates ? 'unknown' : undefined
}
// a form request's authorize(): a check only when it returns false for nobody logged in (`return $this->user() !== null;`,
// `return auth()->check() && ...;`); `|| config(...)` or `?->is_banned !== true` lets them in
export function authorizeCheck(body?: N | null): 'login' | 'unknown' | 'none' | `owner:${string}` {
  const st = body?.namedChildren.filter(x => x && x.type !== 'comment') ?? []
  const ret = st.length === 1 && st[0]!.type === 'return_statement' ? uncomment(st[0]!.text).replace(/^return\s+|;\s*$/g, '').trim() : undefined
  const ok = ret && !/\|\||\bor\b/.test(ret) ? ret.split('&&').map(c => c.trim()).map(c => /^\(.*\)$/.test(c) ? c.slice(1, -1).trim() : c).filter(c => new RegExp(String.raw`^${USER_OK}$`).test(c)) : []
  const owner = ok.map(c => c.match(new RegExp(String.raw`^(${FIELD})\s*===\s*${ID}$|^${ID}\s*===\s*(${FIELD})$`))).find(Boolean)
  if (owner && ok.length === 1) return `owner:${(owner[1] ?? owner[2]).split('->').at(-1)}`
  if (ok.length) return 'login'
  return ABOUT_USER.test(uncomment(body?.text ?? '')) ? 'unknown' : 'none'
}

export function phpFacts(path: string, text: string, empty: (printed?: string) => FileFacts): PhpFacts | undefined {
  if (!parser) return undefined
  const tree = parser.parse(text)
  if (!tree) return undefined
  const root = tree.rootNode
  // use Illuminate\Routing\Controller as BaseController; -> BaseController is Illuminate's
  const uses = new Map(all(root, 'namespace_use_clause').map(u => [u.childForFieldName('alias')?.text ?? short(u.namedChildren[0]!.text), u.namedChildren[0]!.text.replace(/^\\/, '')]))
  // a class name as PHP resolves it: \App\X as is, imported (use ... as Alias), or in this file's namespace
  const ns = all(root, 'namespace_definition')[0]?.childForFieldName('name')?.text ?? ''
  const fq = (n: string) => { if (n.startsWith('\\')) return n.slice(1); const [head, ...rest] = n.split('\\'); return uses.has(head) ? [uses.get(head)!, ...rest].join('\\') : ns ? `${ns}\\${n}` : n }
  let code = text
  for (const c of all(root, 'comment').sort((a, b) => b.startIndex - a.startIndex)) code = code.slice(0, c.startIndex) + code.slice(c.endIndex)
  const f: PhpFacts = Object.assign(collect(root, empty(code.replace(/\s+/g, ' ')), new Map()), { php: { routes: [], includes: [], csrf: [], methods: new Map(), classes: new Map(),
    middleware: new Map(), adminMw: new Set(), formRequests: new Map(), notifications: new Map(), params: new Map(), schema: [], config: new Map(), risks: new Set<string>() } as PhpFacts['php'] })
  f.todos = [...text.matchAll(/(?:\/\/|#)\s*((TODO|FIXME|HACK)\b[^\n]*)/g)].map(m => m[1])
  const php = f.php

  // ---- routes ----
  if (/(^|\/)routes\/|(^|\/)bootstrap\/app\.php$|Providers\/\w*Route\w*\.php$/.test(path)) walk(root, { prefix: '', mw: [], without: [] }, undefined)
  function walk(n: N, g: Group, ctrl: string | undefined) {
    for (const c of n.namedChildren) {
      if (!c) continue
      if (c.type === 'expression_statement' && /^(member|scoped)_call_expression$/.test(c.namedChildren[0]?.type ?? '') && chainRoot(c.namedChildren[0]!) === 'Route') { chain(c.namedChildren[0]!, g, ctrl); continue }
      if (c.type === 'expression_statement' && /^(require|include)(_once)?_expression$/.test(c.namedChildren[0]?.type ?? '')) { const file = fileArg(c.namedChildren[0]!, path); if (file) php.includes.push({ ...g, file, at: c.startIndex }); continue }
      if (/^(anonymous_function|arrow_function|class_declaration|function_definition|method_declaration)$/.test(c.type) && !/bootstrap\/app\.php$|Providers\//.test(path)) continue
      walk(c, g, ctrl)
    }
  }
  function chainRoot(n: N): string | undefined { let x: N | null = n; while (x?.type === 'member_call_expression') x = x.childForFieldName('object'); return x?.type === 'scoped_call_expression' ? short(x.childForFieldName('scope')!.text) : undefined }
  // Route::middleware('auth')->prefix('admin')->group(fn () => ...), Route::get('/x', [C::class, 'm'])->middleware('auth'), Route::resource(...)
  function chain(n: N, g: Group, ctrl: string | undefined) {
    const items: { name: string; node: N }[] = []
    for (let x: N | null = n; x; x = x.type === 'member_call_expression' ? x.childForFieldName('object') : null) { items.unshift({ name: x.childForFieldName('name')!.text, node: x }); if (x.type === 'scoped_call_expression') break }
    const own: Group = { prefix: '', mw: [], without: [] }
    let controller = ctrl, verb: { name: string; node: N } | undefined, group: N | undefined
    const perAction: { add: boolean; actions: string[]; mw: string[] }[] = []
    let only: string[] | undefined, except: string[] | undefined, creatable = false, destroyable = false, shallow = false
    for (const it of items) {
      const a = args(it.node)
      switch (it.name) {
        case 'middleware': own.mw.push(...a.flatMap(x => names(x.v))); break
        case 'withoutMiddleware': own.without.push(...a.flatMap(x => names(x.v))); break
        case 'prefix': own.prefix = join(own.prefix, str(a[0]?.v) ?? ''); break
        case 'controller': if (a[0]?.v.type === 'class_constant_access_expression') controller = fq(a[0].v.namedChildren[0]!.text); break
        case 'can': own.mw.push(`can:${a.map(x => str(x.v) ?? '?').join(',')}`); break
        case 'only': only = a.flatMap(x => names(x.v)); break
        case 'except': except = a.flatMap(x => names(x.v)); break
        case 'middlewareFor': case 'withoutMiddlewareFor': perAction.push({ add: it.name === 'middlewareFor', actions: names(a[0]?.v), mw: names(a[1]?.v) }); break
        case 'creatable': creatable = true; break
        case 'destroyable': destroyable = true; break
        case 'shallow': shallow = true; break
        case 'group': {
          // Route::group(['prefix' => 'x', 'middleware' => [...]], fn) (array form), or ->group(fn | file)
          for (const x of a) if (x.v.type === 'array_creation_expression') for (const e of x.v.namedChildren) {
            const k = str(e?.namedChildren[0]), v = e?.namedChildren[1] ?? undefined
            if (k === 'prefix') own.prefix = join(own.prefix, str(v) ?? '')
            if (k === 'middleware') own.mw.push(...names(v))
            if (k === 'excluded_middleware' || k === 'withoutMiddleware') own.without.push(...names(v))
          }
          group = a.at(-1)?.v
          break
        }
        default: if (VERBS[it.name] || /^(match|resource|apiResource|resources|apiResources|singleton|apiSingleton)$/.test(it.name)) verb = it
      }
    }
    const here: Group = { prefix: join(g.prefix, own.prefix), mw: [...g.mw, ...own.mw], without: [...g.without, ...own.without] }
    if (group && !verb) {
      if (/^(anonymous_function|arrow_function)$/.test(group.type)) walk(group.childForFieldName('body') ?? group, here, controller)
      else { const file = fileArg(group, path); if (file) php.includes.push({ ...here, file, at: n.startIndex }) }
      return
    }
    if (!verb) return
    const a = args(verb.node)
    if (VERBS[verb.name] || verb.name === 'match') {
      const methods = verb.name === 'match' ? names(a[0]?.v).map(m => m.toUpperCase()) : VERBS[verb.name]
      const uri = str((verb.name === 'match' ? a[1] : a[0])?.v), h = (verb.name === 'match' ? a[2] : a[1])?.v
      if (uri === undefined) return
      const r: PhpRoute = { methods: methods.filter(m => m !== 'HEAD'), path: phpPath(join(here.prefix, uri)), mw: here.mw, without: here.without, at: n.startIndex }
      if (!h) return
      if (/^(anonymous_function|arrow_function)$/.test(h.type)) { const fx = collect(h, empty(h.text.replace(/\s+/g, ' ')), types(h)); r.facts = Object.assign(fx, { check: codeCheck(h.childForFieldName('body'), false, requestParams(h)) }) }
      else if (h.type === 'array_creation_expression') { const [c, m] = h.namedChildren.map(e => e?.namedChildren[0]); if (c?.type === 'class_constant_access_expression') { r.cls = fq(c.namedChildren[0]!.text); r.fn = str(m) } }
      else if (h.type === 'class_constant_access_expression') { r.cls = fq(h.namedChildren[0]!.text); r.fn = '__invoke' }
      else if (str(h) !== undefined) { const s = str(h)!; if (s.includes('@')) { r.cls = fq(s.split('@')[0]); r.fn = s.split('@')[1] } else if (controller) { r.cls = controller; r.fn = s } }
      if (r.cls && !r.fn) return
      if (r.without.some(w => CSRF.test(w))) php.csrf.push(uri)
      php.routes.push(r)
      return
    }
    // resources: Route::resource('photos', PhotoController::class) and friends (photos.comments: nested)
    const pairs: [string, string][] = /^(resources|apiResources)$/.test(verb.name)
      ? (a[0]?.v.namedChildren ?? []).flatMap(e => { const k = str(e?.namedChildren[0]), v = e?.namedChildren[1]; return k && v?.type === 'class_constant_access_expression' ? [[k, fq(v.namedChildren[0]!.text)] as [string, string]] : [] })
      : str(a[0]?.v) && a[1]?.v.type === 'class_constant_access_expression' ? [[str(a[0].v)!, fq(a[1].v.namedChildren[0]!.text)]] : []
    const api = /^api/.test(verb.name), single = /ingleton$/.test(verb.name)
    for (const [name, cls] of pairs) {
      const parts = name.split('.'), param = (s: string) => `{${singular(s.split('/').at(-1)!).replace(/-/g, '_')}}`
      const parent = parts.slice(0, -1).map(s => `${s}/${param(s)}`).join('/'), last = parts.at(-1)!
      const base = join(parent, last), item = shallow && parent ? join(last, param(last)) : join(base, param(last))
      const actions: [string, string[], string][] = single
        ? [['show', ['GET'], base], ...(api ? [] : [['edit', ['GET'], base + '/edit']] as [string, string[], string][]), ['update', ['PUT', 'PATCH'], base],
           ...(creatable ? [...(api ? [] : [['create', ['GET'], base + '/create']] as [string, string[], string][]), ['store', ['POST'], base], ['destroy', ['DELETE'], base]] as [string, string[], string][] : destroyable ? [['destroy', ['DELETE'], base]] as [string, string[], string][] : [])]
        : [['index', ['GET'], base], ...(api ? [] : [['create', ['GET'], base + '/create']] as [string, string[], string][]), ['store', ['POST'], base], ['show', ['GET'], item],
           ...(api ? [] : [['edit', ['GET'], item + '/edit']] as [string, string[], string][]), ['update', ['PUT', 'PATCH'], item], ['destroy', ['DELETE'], item]]
      for (const [fn, methods, uri] of actions) {
        if (only && !only.includes(fn) || except?.includes(fn)) continue
        const mw = [...here.mw], without = [...here.without]
        for (const p of perAction) if (p.actions.includes(fn)) (p.add ? mw : without).push(...p.mw)
        php.routes.push({ methods, path: phpPath(join(here.prefix, uri)), mw, without, cls, fn, at: n.startIndex })
      }
    }
  }

  // ---- bootstrap/app.php (11+): which route files load, middleware groups, aliases, CSRF exceptions ----
  if (/(^|\/)bootstrap\/app\.php$/.test(path)) {
    const app: NonNullable<PhpFacts['php']['app']> = { apiPrefix: 'api', using: false, groups: new Map(), aliases: new Map() }
    for (const c of all(root, 'member_call_expression')) {
      const name = c.childForFieldName('name')!.text, a = args(c), named = (k: string) => a.find(x => x.name === k)?.v
      if (name === 'withRouting') {
        const files = (k: string) => { const v = named(k); return v ? (v.type === 'array_creation_expression' ? v.namedChildren.map(e => fileArg(e!, path)) : [fileArg(v, path)]).filter((x): x is string => !!x) : undefined }
        app.web = files('web'); app.api = files('api'); app.apiPrefix = str(named('apiPrefix')) ?? 'api'; app.using = !!named('using')
      }
      if (c.childForFieldName('object')?.text !== '$middleware') continue
      if (name === 'web' || name === 'api') app.groups.set(name, [...app.groups.get(name) ?? [], ...['append', 'prepend'].flatMap(k => names(named(k)))])
      if (name === 'web' && names(named('remove')).some(w => CSRF.test(w))) php.csrf.push('*')
      if (name === 'appendToGroup' || name === 'prependToGroup' || name === 'group') { const gname = str(a[0]?.v); if (gname) app.groups.set(gname, [...app.groups.get(gname) ?? [], ...names(a[1]?.v)]) }
      if (name === 'append' || name === 'prepend') app.groups.set('*', [...app.groups.get('*') ?? [], ...names(a[0]?.v)])
      if (name === 'alias') for (const e of a[0]?.v.namedChildren ?? []) { const k = str(e?.namedChildren[0]); if (k) app.aliases.set(k, names(e!.namedChildren[1]!)[0]) }
      if (name === 'validateCsrfTokens' || name === 'preventRequestForgery') php.csrf.push(...names(named('except') ?? a[0]?.v))
    }
    php.app = app
  }

  // ---- classes: controllers, middleware, form requests, models ----
  for (const cls of all(root, 'class_declaration')) {
    const bare = cls.childForFieldName('name')?.text; if (!bare) continue
    const name = ns ? `${ns}\\${bare}` : bare
    const body = cls.childForFieldName('body')!, baseRaw = cls.namedChildren.find(c => c?.type === 'base_clause')?.namedChildren[0]?.text
    const baseFull = baseRaw && fq(baseRaw), base = baseFull
    const traits = body.namedChildren.filter(c => c?.type === 'use_declaration').flatMap(u => u!.namedChildren.map(x => short(x!.text)))
    const attrs = (n: N) => { const l = n.childForFieldName('attributes'); return l ? all(l, 'attribute') : [] }
    // Laravel 13's controller attributes (Illuminate\Routing\Attributes\Controllers\Middleware, ...); another class of that name does nothing
    const attrMw = (as: N[], kinds: RegExp): Mw[] => as.flatMap(at => { const full = fq(at.namedChildren[0]!.text), an = short(full), a = args(at)
      if (!full.startsWith('Illuminate\\Routing\\Attributes\\Controllers\\') || !kinds.test(an)) return []
      const opt = (k: string) => { const v = a.find(x => x.name === k)?.v; return v ? names(v) : undefined }
      return an === 'Authorize' ? [{ mw: 'can:' + (str(a[0]?.v) ?? '?'), only: opt('only'), except: opt('except'), attr: true }]
        : names(a[0]?.v).map(mw => ({ mw, only: opt('only'), except: opt('except'), attr: true })) })
    const interfaces = cls.namedChildren.find(c => c?.type === 'class_interface_clause')?.namedChildren.map(x => short(fq(x!.text))) ?? []
    const info = { base, illuminate: baseFull === 'Illuminate\\Routing\\Controller', traits, interfaces, staticMw: undefined as Mw[] | undefined, attrMw: attrMw(attrs(cls), /^(Middleware|Authorize)$/),
      methodMw: new Map<string, Mw[]>(), without: attrMw(attrs(cls), /^WithoutMiddleware$/), methodWithout: new Map<string, Mw[]>(), ctorMw: [] as Mw[],
      model: /^Illuminate\\(Database\\Eloquent\\(Model|Relations\\Pivot)|Foundation\\Auth\\User)$/.test(baseFull ?? '') || /^(Model|Authenticatable)$/.test(baseRaw ?? ''),
      unguarded: false, table: undefined as string | undefined }
    php.classes.set(name, info)
    // the class's typed properties ($this->refunder: RefundsStripeOrders), from constructor promotion or declarations
    const fields = new Map([...types(cls), ...all(body, 'property_promotion_parameter').flatMap(p => p.childForFieldName('type') ? [[`$this->${p.childForFieldName('name')!.text.slice(1)}`, fq(p.childForFieldName('type')!.text.replace(/^\?/, ''))] as const] : []),
      ...all(body, 'property_declaration').flatMap(d => d.childForFieldName('type') ? all(d, 'property_element').map(e => [`$this->${e.childForFieldName('name')!.text.slice(1)}`, fq(d.childForFieldName('type')!.text.replace(/^\?/, ''))] as const) : [])])
    for (const m of all(body, 'method_declaration')) {
      const mname = m.childForFieldName('name')!.text, key = `${name}.${mname}`
      const mBody = m.childForFieldName('body')
      // HasMiddleware: public static function middleware(): array { return ['auth', new Middleware('log', only: ['index'])]; }
      if (mname === 'middleware' && /\bstatic\b/.test(m.text.slice(0, m.text.indexOf('('))) && mBody) {
        const ret = all(mBody, 'return_statement')[0]?.namedChildren[0]
        info.staticMw = []
        for (const e of ret?.type === 'array_creation_expression' ? ret.namedChildren : []) {
          const v = e?.namedChildren.at(-1)
          if (v?.type === 'object_creation_expression' && /Middleware$/.test(v.namedChildren[0]?.text ?? '')) { const a = args(v), opt = (k: string) => { const x = a.find(y => y.name === k)?.v; return x ? names(x) : undefined }
            info.staticMw.push(...names(a[0]?.v).map(mw => ({ mw, only: opt('only'), except: opt('except') }))) }
          else info.staticMw.push(...names(v ?? undefined).map(mw => ({ mw })))
        }
        continue
      }
      // 10-style: public function __construct() { $this->middleware('auth')->only(['store']); }
      if (mname === '__construct' && mBody) for (const c of all(mBody, 'member_call_expression')) if (c.childForFieldName('name')!.text === 'middleware' && c.childForFieldName('object')?.text === '$this') {
        // ->only([...]) / ->except([...]) after it, or as options: $this->middleware('auth', ['except' => ['index']])
        const outer = c.parent?.type === 'member_call_expression' ? c.parent : undefined, how = outer?.childForFieldName('name')?.text
        const opts = new Map((args(c)[1]?.v.namedChildren ?? []).map(e => [str(e?.namedChildren[0]) ?? '', names(e?.namedChildren[1] ?? undefined)]))
        info.ctorMw.push(...names(args(c)[0]?.v).map(mw => ({ mw, only: how === 'only' ? args(outer).flatMap(x => names(x.v)) : opts.get('only'), except: how === 'except' ? args(outer).flatMap(x => names(x.v)) : opts.get('except') })))
      }
      const ma = attrs(m)
      if (ma.length) { info.methodMw.set(mname, attrMw(ma, /^(Middleware|Authorize)$/)); info.methodWithout.set(mname, attrMw(ma, /^WithoutMiddleware$/)) }
      php.params.set(key, all(m.childForFieldName('parameters')!, 'simple_parameter').map(p => short(p.childForFieldName('type')?.text.replace(/^\?/, '') ?? '')))
      const g = collect(m, empty(m.text.replace(/\s+/g, ' ')), new Map([...fields, ...types(m)]), name, info.model)
      for (const t of php.params.get(key)!) if (/^[A-Z]/.test(t)) g.tables.add(`@m:${t}`)   // show(Order $order): route model binding loads it
      const inputs = requestParams(m)
      php.methods.set(key, Object.assign(g, { check: codeCheck(mBody, true, inputs) }))
      // middleware: handle(Request $request, Closure $next) that turns guests away
      if (mname === 'handle' && /\bClosure\b/.test(m.childForFieldName('parameters')?.text ?? '')) {
        const ps = all(m.childForFieldName('parameters')!, 'simple_parameter'), next = ps.find(p => /Closure/.test(p.childForFieldName('type')?.text ?? ''))?.childForFieldName('name')?.text ?? '$next'
        const o: { admin?: boolean } = {}, c = userCheck(mBody, requestParams(m), next, o)
        if (c === 'login' && o.admin) php.adminMw.add(bare)
        php.middleware.set(bare, c === 'login' || c === 'policy' ? c : c?.startsWith('owner:') ? 'unknown' : c || ABOUT_USER.test(uncomment(mBody?.text ?? '')) ? 'unknown' : 'none')
      }
      // a FormRequest's authorize(): a check only when it looks at the user (`return true;`, or a rule about the order, checks nobody)
      if (mname === 'authorize' && /FormRequest$/.test(base ?? '')) php.formRequests.set(bare, authorizeCheck(mBody))
    }
    if (/FormRequest$/.test(base ?? '') && !php.formRequests.has(bare)) php.formRequests.set(bare, 'none')
    // the app's own Authenticate (extends Laravel's): still a login check, unless its handle() can return before Laravel's runs
    if (/^Illuminate\\Auth\\Middleware\\(Authenticate|AuthenticateWithBasicAuth|EnsureEmailIsVerified|RequirePassword)$/.test(baseFull ?? '')) {
      // (its handle() reaches parent::handle / $this->authenticate as a top-level statement, nothing returning before; authenticate()
      // or unauthenticated() overridden: plain can't tell)
      const ms = all(body, 'method_declaration'), h = ms.find(m => m.childForFieldName('name')?.text === 'handle')?.childForFieldName('body')
      let ok = !h
      for (const st of h?.namedChildren ?? []) { if (!st || st.type === 'comment') continue
        if (/^(return\s+)?(parent::handle|\$this->authenticate)\s*\(/.test(uncomment(st.text).trim())) { ok = true; break }
        if (escapes(st, '$next')) break }
      php.middleware.set(bare, ok && !ms.some(m => /^(authenticate|unauthenticated)$/.test(m.childForFieldName('name')?.text ?? '')) ? 'login' : 'unknown')
    }
    const via = all(body, 'method_declaration').find(m => m.childForFieldName('name')?.text === 'via')
    if (via) php.notifications.set(bare, /['"]mail['"]|MailChannel/.test(via.text) || !/return\s*\[/.test(via.text))   // via() decided at runtime: it may
    // Eloquent: protected $guarded = []; Model::unguard(); #[Unguarded]; protected $table = 'x'; #[Table('x')]
    for (const pe of all(body, 'property_element')) {
      const k = pe.childForFieldName('name')?.text, v = pe.childForFieldName('default_value')
      if (k === '$guarded' && v?.type === 'array_creation_expression' && !v.namedChildren.length) info.unguarded = true
      if (k === '$table' && str(v)) info.table = str(v)
      if (k === '$except' && /VerifyCsrfToken$/.test(base ?? '')) php.csrf.push(...names(v ?? undefined))
    }
    for (const at of attrs(cls)) { const an = short(at.namedChildren[0]!.text); if (an === 'Unguarded') info.unguarded = true; if (an === 'Table') info.table = str(args(at)[0]?.v) ?? info.table }
  }
  if (/\bModel::unguard\s*\(/.test(code)) php.risks.add('unguard')

  // ---- migrations: what up() does to the tables ----
  if (/(^|\/)database\/migrations\/[^/]+\.php$/.test(path)) {
    const up = all(root, 'method_declaration').find(m => m.childForFieldName('name')?.text === 'up')
    for (const c of up ? all(up, 'scoped_call_expression') : []) {
      if (short(c.childForFieldName('scope')!.text) !== 'Schema') continue
      const op = c.childForFieldName('name')!.text, a = args(c), table = str(a[0]?.v)
      if (!table) continue
      if (op === 'drop' || op === 'dropIfExists') { php.schema.push({ op: 'drop', table, add: [], drop: [], renames: [], loses: true }); continue }
      if (op === 'rename') { php.schema.push({ op: 'rename', table, to: str(a[1]?.v), add: [], drop: [], renames: [], loses: false }); continue }
      if (op !== 'create' && op !== 'table') continue
      const s: SchemaOp = { op, table, add: [], drop: [], renames: [], loses: false }
      const fn = a[1]?.v
      const onTable = (fn ? all(fn, 'member_call_expression') : []).filter(x => x.childForFieldName('object')?.type === 'variable_name').map(x => x.childForFieldName('name')!.text)
      s.indexOnly = op === 'table' && onTable.length > 0 && onTable.every(k => /^(index|spatialIndex|dropIndex|dropSpatialIndex|renameIndex)$/.test(k))
        && !/DB::|::query\s*\(|->(update|delete|insert|save|truncate)\s*\(/.test(fn?.text ?? '')   // (no data change in the closure either)
      for (const call of fn ? all(fn, 'member_call_expression') : []) {
        // $table->string('name')->nullable(): the innermost call on $table
        if (call.childForFieldName('object')?.type !== 'variable_name') continue
        const k = call.childForFieldName('name')!.text, ca = args(call), col = str(ca[0]?.v), cols = names(ca[0]?.v)
        // ->nullable() anywhere on the rest of that statement: the column may be empty
        let whole: N = call; while (whole.parent?.type === 'member_call_expression') whole = whole.parent
        if (col && /->nullable\(\s*(true)?\s*\)/.test(whole.text)) (s.nullable ??= []).push(col)
        if (k === 'id' || k === 'increments' || k === 'bigIncrements') s.add.push(col ?? 'id')
        else if (/^(timestamps|nullableTimestamps|timestampsTz)$/.test(k)) s.add.push('created_at', 'updated_at')
        else if (/^softDeletes(Tz)?$/.test(k)) s.add.push(col ?? 'deleted_at')
        else if (k === 'rememberToken') s.add.push('remember_token')
        else if (k === 'foreignIdFor') { const m = ca[0]?.v.type === 'class_constant_access_expression' ? short(ca[0].v.namedChildren[0]!.text) : undefined; if (m) s.add.push(str(ca[1]?.v) ?? m.replace(/[A-Z]/g, (x, i) => (i ? '_' : '') + x.toLowerCase()) + '_id', `→${m}`) }
        else if (/^(foreignId|foreignUuid|foreignUlid)$/.test(k) && col) s.add.push(col, `→${modelOf(col.replace(/_id$/, ''))}`)
        else if (/^(nullable)?(uuid|ulid|numeric)?[mM]orphs$/.test(k) && col) s.add.push(`${col}_id`, `${col}_type`)
        else if (k === 'dropColumn') { s.drop.push(...cols); s.loses = true }
        else if (/^(dropTimestamps|dropTimestampsTz)$/.test(k)) { s.drop.push('created_at', 'updated_at'); s.loses = true }
        else if (k === 'dropSoftDeletes') { s.drop.push('deleted_at'); s.loses = true }
        else if (k === 'dropConstrainedForeignId' && col) { s.drop.push(col); s.loses = true }
        else if (k === 'dropMorphs' && col) { s.drop.push(`${col}_id`, `${col}_type`); s.loses = true }
        else if (k === 'renameColumn' && col && str(ca[1]?.v)) s.renames.push([col, str(ca[1].v)!])
        else if (col && /^(string|char|text|tinyText|mediumText|longText|integer|tinyInteger|smallInteger|mediumInteger|bigInteger|unsigned\w*Integer|boolean|decimal|float|double|date|dateTime|dateTimeTz|time|timeTz|timestamp|timestampTz|year|json|jsonb|enum|set|uuid|ulid|binary|ipAddress|macAddress|geometry|geography|vector|unsignedDecimal)$/.test(k)) s.add.push(col)
      }
      php.schema.push(s)
    }
    // index-only means the whole up(): nothing but Schema::table(...) statements
    if (!(up?.childForFieldName('body')?.namedChildren ?? []).every(st => !st || st.type === 'comment' || /^Schema::table\s*\(/.test(st.text.trim()))) for (const x of php.schema) x.indexOnly = false
    if (up && /DB::(statement|unprepared)\s*\(\s*['"][^'"]*\b(DROP|TRUNCATE|DELETE)\b|->(delete|truncate)\s*\(\s*\)/i.test(up.text)) php.schema.push({ op: 'table', table: '', add: [], drop: [], renames: [], loses: true })
  }

  // ---- config/*.php: 'stripe' => ['secret' => env('STRIPE_SECRET')] -> services.stripe.secret ----
  const cfg = path.match(/(^|\/)config\/(\w+)\.php$/)
  if (cfg) {
    const ret = all(root, 'return_statement')[0]?.namedChildren[0]
    const read = (n: N | undefined, key: string) => { if (n?.type !== 'array_creation_expression') return
      for (const e of n.namedChildren) { const k = str(e?.namedChildren[0]), v = e?.namedChildren[1]; if (!k || !v || e!.namedChildren.length < 2) continue
        const env = v.type === 'function_call_expression' && v.childForFieldName('function')?.text === 'env' ? v : v.type === 'cast_expression' ? v.namedChildren.find(x => x?.type === 'function_call_expression' && x.childForFieldName('function')?.text === 'env') : undefined
        if (env) { const ea = args(env); if (str(ea[0]?.v)) php.config.set(`${key}.${k}`, { env: str(ea[0].v)!, optional: ea.length > 1 && !/^(null|''|"")$/i.test(ea[1].v.text) }) }
        else read(v, `${key}.${k}`) } }
    read(ret ?? undefined, cfg[2])
    // CORS: every site, with cookies (php-cors then echoes back any site's origin)
    if (cfg[2] === 'cors' && /['"]allowed_origins['"]\s*=>\s*\[\s*['"]\*['"]|['"]allowed_origins_patterns['"]\s*=>\s*\[\s*['"]\/\.\*\/['"]/.test(code) && /['"]supports_credentials['"]\s*=>\s*true/.test(code)) php.risks.add('cors')
    if (cfg[2] === 'app' && /['"]debug['"]\s*=>\s*true\b/.test(code)) php.risks.add('debug')
  } else if (!/(^|\/)(bootstrap|database|tests|config)\//.test(path)) for (const m of code.matchAll(/\benv\s*\(\s*['"](\w+)['"]/g)) php.risks.add(`env:${m[1]}`)   // env() outside config/: null once config is cached
  // SQL built by pasting in text: DB::select("... $id"), whereRaw('... ' . $x)
  // whatever the visitor sent, saved as is: Order::create($request->all()) (dangerous when the model accepts every field)
  // (all:Order for Order::create($request->all()); all:? when plain can't tell which model)
  const vars = types(root)
  for (const m of code.matchAll(/(?:\b(\w+)::|(\$\w+)->|->)(create|update|fill|forceFill|forceCreate|firstOrCreate|updateOrCreate)\s*\(\s*(?:\$request|request\(\))->(?:all|input|post)\(\s*\)/g))
    php.risks.add(/^force/.test(m[3]) ? 'force' : `all:${m[1] && /^[A-Z]/.test(m[1]) ? m[1] : short(vars.get(m[2] ?? '')?.replace(/^new:/, '') ?? '?')}`)
  if (/\b(DB::(select|statement|insert|update|delete|unprepared)|->(whereRaw|havingRaw|orderByRaw|selectRaw)|DB::raw)\s*\(\s*("[^"]*\$\w|'[^']*'\s*\.\s*\$|"[^"]*"\s*\.\s*\$)/.test(code)) php.risks.add('sql')
  tree.delete()   // trees live in WebAssembly memory, which JavaScript never frees: a big repo filled it and the parser aborted
  return f

  // parameters holding the visitor's request: Illuminate\Http\Request, or a form request (a *Request class outside the models)
  function requestParams(fn: N): string[] {
    return all(fn.childForFieldName('parameters') ?? fn, 'simple_parameter').filter(p => { const t = fq(p.childForFieldName('type')?.text.replace(/^\?/, '') ?? '')
      return t === 'Illuminate\\Http\\Request' || /Request$/.test(t) && !/\\Models\\/.test(t) }).map(p => p.childForFieldName('name')!.text)
  }
  // types of the variables in a function: typed parameters (Order $order), $x = new Order / Order::find(...) / Order::create(...),
  // $request->user() / auth()->user() -> User
  function types(n: N): Map<string, string> {
    const out = new Map<string, string>()
    for (const p of all(n.childForFieldName('parameters') ?? n, 'simple_parameter')) { const t = p.childForFieldName('type')?.text.replace(/^\?/, ''); if (t && /^[A-Z]/.test(short(t))) out.set(p.childForFieldName('name')!.text, fq(t)) }
    for (const a of all(n, 'assignment_expression')) {
      const l = a.childForFieldName('left')?.text, r = a.childForFieldName('right')
      if (!l || !r) continue
      let x: N | null = r
      while (x?.type === 'member_call_expression') x = x.childForFieldName('object')
      if (r.type === 'object_creation_expression') out.set(l, 'new:' + fq(r.namedChildren[0]!.text))
      else if (x?.type === 'scoped_call_expression' && /^[A-Z]/.test(short(x.childForFieldName('scope')!.text))) out.set(l, fq(x.childForFieldName('scope')!.text))
      else if (/^(\$request->user\(\)|auth\(\)->user\(\)|Auth::user\(\)|\$this->user\(\))$/.test(r.text)) out.set(l, 'User')
    }
    return out
  }
  // what the handler's own code checks: login (or a policy) before going on
  function codeCheck(body: N | null | undefined, inClass: boolean, inputs: string[] = []): Check | undefined {
    const c = userCheck(body, inputs)
    return c === 'login' || c === 'policy' || c?.startsWith('owner:') ? c : inClass && /\$this->authorize\s*\(/.test(uncomment(body?.text ?? '')) ? 'crash' : c
  }
  // Facts from one subtree: Eloquent reads and writes, Stripe, email, config and env, "no" messages.
  // `self`: the class the code is in. Calls into other classes ($cancelEvent->handle(), $this->refunder->refund(), PricingService::quote(),
  // app(X::class)->y(), $this->helper()) are recorded as pcall:Class.method and followed in plain.ts.
  function collect(node: N, g: FileFacts, vars: Map<string, string>, self?: string, isModel = false): FileFacts {
    const model = (n: N | null | undefined): string | undefined => {
      if (!n) return undefined
      if (n.type === 'variable_name') { if (n.text === '$this' && isModel) return short(self!); const t = vars.get(n.text); return t && short(t.replace(/^new:/, '')) }
      if (n.type === 'member_call_expression') {
        const name = n.childForFieldName('name')!.text, obj = n.childForFieldName('object')
        if (/^(user)$/.test(name) && /^(\$request|auth\(\)|\$this)$/.test(obj?.text ?? '')) return 'User'
        if (/^(where\w*|orderBy\w*|latest|oldest|with\w*|select|limit|take|skip|query|lockForUpdate|sharedLock|has|whereHas|withTrashed|onlyTrashed|first\w*|find\w*|sole)$/.test(name)) return model(obj)
        if (n.childForFieldName('arguments')?.namedChildren.length === 0 && obj && model(obj)) return `@rel:${name}`   // $user->orders()->create(...)
        return undefined
      }
      if (n.type === 'scoped_call_expression') { const s = short(n.childForFieldName('scope')!.text); return s === 'DB' && n.childForFieldName('name')!.text === 'table' && str(args(n)[0]?.v) ? `@tbl:${str(args(n)[0].v)}` : /^[A-Z]/.test(s) && !FACADES.test(s) ? `@m:${s}` : undefined }
      return undefined
    }
    const tag = (m: string) => /^@/.test(m) ? m : `@m:${m}`
    const write = (m: string | undefined, op: string) => { if (!m) return; g.tables.add(tag(m)); g.written.add(tag(m)); g.writes = true; g.ops.add(op) }
    for (const c of all(node, 'scoped_call_expression')) {
      const s = short(c.childForFieldName('scope')!.text), name = c.childForFieldName('name')!.text, a = args(c)
      // stripe-php, static style (\Stripe\Checkout\Session::create, or imported: Session::create), Laravel's Mail, Notification, DB
      const full = (uses.get(c.childForFieldName('scope')!.text) ?? c.childForFieldName('scope')!.text).replace(/^\\/, '')
      const stripe = /^Stripe\\/.test(full)
      if (stripe && /\\Checkout\\Session$/.test(full) && name === 'create') { g.money = true; g.services.add('Stripe'); g.outside.add('Stripe: checkout.sessions.create') }
      if (stripe && /\\(PaymentIntent|Charge)$/.test(full) && name === 'create') { g.money = true; g.services.add('Stripe') }
      if (stripe && /\\Refund$/.test(full) && name === 'create') { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
      if (stripe && /\\Webhook$/.test(full) && name === 'constructEvent') { g.services.add('Stripe'); g.outside.add('Stripe: webhooks.constructEvent') }
      if (stripe) continue
      if (s === 'Checkout' && name === 'guest') g.used.add('cashier:checkout')
      if (s === 'Mail' && /^(send|raw|html|plain|queue)$/.test(name)) { g.services.add('email'); g.outside.add('email: send') }
      if (s === 'Notification' && /^(send|sendNow)$/.test(name)) g.used.add(`notify:${c.text.match(/\bnew\s+\\?([\w\\]+)/)?.[1].split('\\').at(-1) ?? '?'}`)
      if (s === 'DB' && name === 'table') { const t = str(a[0]?.v); if (t) g.tables.add(`@tbl:${t}`) }
      if (FACADES.test(s)) continue
      const scope = c.childForFieldName('scope')!.text, sfq = /^(self|static)$/.test(scope) ? self : fq(scope)
      if (sfq && /^[A-Z]/.test(short(sfq)) && scope !== 'parent' && !VENDOR.test(sfq)) g.used.add(`pcall:${sfq}.${name}`)   // PricingService::quote()
      // Order::create([...]), Order::destroy($id), Order::where(...) (a read; a write if the chain ends in update/delete, below)
      if (/^(create|forceCreate|insert|insertOrIgnore|insertGetId|upsert|updateOrCreate|firstOrCreate|updateOrInsert)$/.test(name)) write(`@m:${s}`, /^(upsert|updateOrCreate|updateOrInsert)$/.test(name) ? 'update' : 'create')
      else if (/^(destroy|forceDestroy|truncate)$/.test(name)) write(`@m:${s}`, 'delete')
      else if (/^[A-Z]/.test(s)) g.tables.add(`@m:${s}`)
    }
    for (const c of all(node, 'member_call_expression')) {
      const name = c.childForFieldName('name')!.text, obj = c.childForFieldName('object'), t = c.text
      g.used.add(name)
      const app = obj?.type === 'function_call_expression' && /^(app|resolve)$/.test(obj.childForFieldName('function')?.text ?? '') ? obj.text.match(/\(\s*\\?([\w\\]+)::class/)?.[1] : undefined
      const callee = app ? fq(app) : obj?.text === '$this' ? self : vars.get(obj?.text ?? '')?.replace(/^new:/, '')
      if (callee && /^[A-Z]/.test(short(callee)) && !VENDOR.test(callee)) g.used.add(`pcall:${callee}.${name}`)
      if (/^(save|update|increment|decrement|restore)$/.test(name)) write(model(obj), name === 'save' && obj?.type === 'variable_name' && vars.get(obj.text)?.startsWith('new:') ? 'create' : 'update')
      if (/^(delete|forceDelete)$/.test(name)) write(model(obj), 'delete')
      if (/^(create|createMany|createQuietly|firstOrCreate|updateOrCreate|insert|upsert|attach|sync|syncWithoutDetaching|detach|toggle)$/.test(name) && obj?.type !== 'scoped_call_expression') { const m = model(obj); if (m) write(m, /^(detach)$/.test(name) ? 'delete' : /^(updateOrCreate|upsert|sync\w*|toggle)$/.test(name) ? 'update' : 'create') }
      // stripe-php client: $stripe->checkout->sessions->create, ->paymentIntents->create, ->refunds->create
      if (name === 'create' && /->checkout->sessions$/.test(obj?.text ?? '')) { g.money = true; g.services.add('Stripe'); g.outside.add('Stripe: checkout.sessions.create') }
      if (name === 'create' && /->(paymentIntents|charges|subscriptions|paymentLinks|invoices)$/.test(obj?.text ?? '')) { g.money = true; g.services.add('Stripe') }
      if (name === 'create' && /->refunds$/.test(obj?.text ?? '')) { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
      if (name === 'constructEvent' && /->webhooks$/.test(obj?.text ?? '')) { g.services.add('Stripe'); g.outside.add('Stripe: webhooks.constructEvent') }
      // Cashier (on a Billable model): checkout, charge, subscriptions; refund. plain.ts counts them only with laravel/cashier installed.
      if (/^(checkout|checkoutCharge|checkoutPrice|charge|pay|invoicePrice|invoiceFor|newSubscription|swap|swapAndInvoice)$/.test(name)) g.used.add('cashier:charge')
      if (name === 'refund') g.used.add('cashier:refund')
      // email: Mail::to($u)->send(new X), ->queue(...), $user->notify(new X)
      if (/^(send|queue|later|sendNow)$/.test(name) && /^Mail::/.test(t)) { g.services.add('email'); g.outside.add('email: send') }
      if (name === 'notify' || name === 'notifyNow') g.used.add(`notify:${t.match(/\bnew\s+\\?([\w\\]+)/)?.[1].split('\\').at(-1) ?? '?'}`)
    }
    for (const fc of all(node, 'function_call_expression')) {
      const fn = fc.childForFieldName('function')!.text, a = args(fc)
      // config('services.stripe.secret') -> its env var (plain.ts); a default makes it optional
      if (fn === 'config' && str(a[0]?.v)) { g.env.add(`@cfg:${str(a[0].v)}`); if (a.length < 2) g.envReq.add(`@cfg:${str(a[0].v)}`) }
      if (fn === 'env' && str(a[0]?.v)) { g.env.add(str(a[0].v)!); if (a.length < 2) g.envReq.add(str(a[0].v)!) }
      // "no" messages: abort(409, 'Already booked'), abort_if($x, 422, 'Too late')
      const code = fn === 'abort' ? a[0]?.v.text : /^abort_(if|unless)$/.test(fn) ? a[1]?.v.text : undefined, msg = fn === 'abort' ? str(a[1]?.v) : str(a[2]?.v)
      if (msg && /^(400|402|409|422)$/.test(code ?? '')) g.refuses.add(msg)
    }
    // return response()->json(['message' => '...'], 409)
    for (const m of node.text.matchAll(/response\(\)\s*->\s*json\(\s*\[\s*['"](?:message|error)['"]\s*=>\s*['"]([^'"]+)['"][^\]]*\]\s*,\s*(400|402|409|422)\s*\)/g)) g.refuses.add(m[1])
    g.emptyCatch += all(node, 'catch_clause').filter(c => /^\{\s*\}$/.test(c.childForFieldName('body')?.text ?? '')).length
    return g
  }
}
