// Go servers: net/http (Go 1.22+ patterns), chi, gin and echo; database writes (GORM, sqlc-style query methods, raw SQL), Stripe
// (stripe-go), email, env. Routes are registered by code that runs, often across packages (api.Register(r)), so this file records
// each function's route operations in order, and plain.ts runs them from main():
//  - a router's middleware covers which routes depends on the router: chi's Use covers all of that router's routes (Use after a route
//    panics), gin's and echo-group's Use only the routes registered after it, echo's e.Use every route; a route's own middleware
//    (gin r.GET(p, mw, h), echo e.GET(p, h, mw), chi r.With(mw)), and net/http's wrapping (mux.Handle(p, requireAuth(h)),
//    http.ListenAndServe(addr, withAuth(mux)));
//  - login: a middleware or handler whose code turns away a request that has no user, read structurally (a top-level `if` about the
//    session / cookie / token / user that answers 401 / 403 / a login redirect and stops: `return`, gin's Abort, echo's returned error),
//    nothing before it letting requests through; library middleware by name (jwtauth.Authenticator; Verifier alone rejects nobody).
// ponytail: fiber, gorilla/mux and templates aren't read.
import { adminCond } from './admin.ts'
import type { FileFacts } from './plain.ts'
import { parserFor } from './treesitter.ts'
const parser = await parserFor('tree-sitter-go.wasm')   // 0.2 MB; null when web-tree-sitter isn't installed: Go files are skipped

type N = import('web-tree-sitter').Node
// a handler or middleware as written: a function name (h.CreateOrder, api.List, createOrder), a func literal (its key), a wrapper call
export type GoRef = { fn?: string; lit?: string; wrap?: string[]; call?: string; args?: string[] }   // wrap: middleware around `fn`/`lit`
export type GoOp =
  | { op: 'new'; v: string; kind: 'chi' | 'gin' | 'echo' | 'mux' }
  | { op: 'group'; v: string; from: string; prefix: string; mws: GoRef[] }                // gin/echo r.Group(p, mw...), chi r.With(mw) / r.Group()
  | { op: 'use'; on: string; mws: GoRef[] }
  | { op: 'route'; on: string; methods: string[]; path: string; handler: GoRef; mws: GoRef[] }
  | { op: 'sub'; on: string; prefix: string; v: string; ops: GoOp[] }                      // chi r.Route(p, func(r chi.Router) {...}) / r.Group(func(r) {...})
  | { op: 'mount'; on: string; prefix: string; target: GoRef }                             // chi r.Mount(p, x), mux.Handle("/p/", http.StripPrefix(...))
  | { op: 'call'; fn: string; args: string[] }                                              // api.RegisterRoutes(r, h)
  | { op: 'serve'; handler: GoRef }                                                         // http.ListenAndServe(addr, withAuth(mux))
  | { op: 'assign'; v: string; fn: string; args: string[] }                                // r := routes(h): the router it returns
  | { op: 'subfn'; on: string; prefix: string; fn: string }                               // chi r.Route(p, adminRoutes) / r.Group(h.protected)
  | { op: 'return'; v: string; wrap?: string[] }
export type GoFunc = FileFacts & { routeOps: GoOp[]; pkgVars: Map<string, string>; takesHandler: boolean; inUse: boolean;   // pkgVars: h := handlers.New(...) -> h is from that import path
  params: string[]; check?: 'login' | 'unknown'; mw?: 'login' | 'unknown' | 'none'; checkAdmin?: boolean; mwAdmin?: boolean; traps: string[] }   // *Admin: that login check is "only admins"
export type GoFacts = FileFacts & { go: {
  pkg: string; dir: string
  imports: Map<string, string>                    // alias -> import path
  funcs: Map<string, GoFunc>                      // Name / Recv.Name / @lit<offset> -> what it does
  structs: Map<string, string[]>                  // GORM-style models: type Order struct { gorm.Model; Total int } -> fields
  automigrate: string[]                           // db.AutoMigrate(&Order{}, ...) -> Order
  selfMigrates: boolean                           // m.Up() / goose.Up / AutoMigrate at startup
  required: string[]                              // env vars the code refuses to start without (mustEnv("X"), env:"X,required")
  risks: Set<string>
} }

const all = (n: N, type: string) => n.descendantsOfType(type).filter((x): x is N => !!x && x.isNamed)
const stmtsTop = (n: N) => ((n.namedChildren.find(c => c?.type === 'statement_list') ?? n).namedChildren ?? []).filter((x): x is N => !!x && x.type !== 'comment')
const str = (n?: N | null) => n && /^(interpreted|raw)_string_literal$/.test(n.type) ? n.text.slice(1, -1) : undefined
const argsOf = (c: N) => (c.childForFieldName('arguments')?.namedChildren ?? []).filter((x): x is N => !!x)
const callee = (c: N) => c.childForFieldName('function')?.text ?? ''
const VERB: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', GET: 'GET', POST: 'POST', PUT: 'PUT', PATCH: 'PATCH', DELETE: 'DELETE', Any: 'ANY', Handle: 'ANY', HandleFunc: 'ANY', Method: 'ANY', MethodFunc: 'ANY' }
// {id}, :id, {id...}, {$} -> [id]
export const goPath = (p: string) => p.replace(/\{\$\}/g, '').replace(/\{(\w+)(\.\.\.)?\}/g, '[$1]').replace(/:(\w+)/g, '[$1]').replace(/\*(\w*)$/, (_, n) => `[${n || 'rest'}]`)
const singular = (s: string) => s.endsWith('ies') ? s.slice(0, -3) + 'y' : /(sses|xes|ches|shes)$/.test(s) ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s
const camel = (s: string) => s.split('_').map(w => w && w[0].toUpperCase() + w.slice(1)).join('')
export const goModelOf = (table: string) => camel(singular(table))

// What stops a request that has no user: 401 / 403 / a redirect to log in, and stopping (return / gin Abort / echo's returned error)
const STATUS = String.raw`(?:http\.Status(?:Unauthorized|Forbidden)|40[13]|fiber\.Status(?:Unauthorized|Forbidden))`
const DENY = new RegExp(String.raw`http\.Error\([^;\n]*${STATUS}|WriteHeader\(\s*${STATUS}|http\.Redirect\([^;\n]*(login|signin|sign-in|auth)|AbortWithStatus(?:JSON)?\(\s*${STATUS}|AbortWithError\(\s*${STATUS}|echo\.Err(?:Unauthorized|Forbidden)|NewHTTPError\(\s*${STATUS}|\.(?:JSON|String|NoContent|Redirect)\(\s*${STATUS}|\.Redirect\([^;\n]*(login|signin)|Status\(\s*${STATUS}|\w*(?:[Ee]rror|[Ff]ail|[Dd]eny|[Uu]nauthori[sz]ed|[Rr]espond|[Ww]rite)\w*\([^;\n]*${STATUS}`)
// a test that's true when there's no user: x == nil, x == "", !ok, err != nil, !token.Valid, !isLoggedIn(r)
const NO_ONE = /==\s*nil\b|==\s*""|!\s*ok\b|!\s*[\w.]+\.Valid\b|\berr\s*!=\s*nil|!\s*[\w.]+\(/
// about who's asking (in the test itself), or where its err / ok came from: a cookie, a token, the Authorization header, a session
const WHO = /user|claims|token|session|cookie|auth|bearer|jwt|principal|Authorization/i
const FROM_LOGIN = /\.Cookie\(\s*(?!"?\w*(?:csrf|xsrf))(?:"[^"]*(?:session|auth|jwt|sid|user|login|token)[^"]*"|\w*(?:[Ss]ession|[Aa]uth|[Jj]wt|[Uu]ser|[Ll]ogin|[Tt]oken)\w*)\s*\)|\.Parse\w*\(|[Vv](?:erify|alidate)\w*(?:Token|JWT|Jwt|Session|Auth|User|Login|Claims|Bearer)\w*\(|[Aa]uthenticate\w*\(|FromContext\(|UserFrom\w*\(|Header\.Get\(\s*"Authorization"|\.Value\(\s*\w*[Uu]ser|ForSession\w*\(|SessionUser\w*\(|GetString\(\s*"(user|session|token)/
// a body's own check: a top-level `if` that's true when there's no user (and nothing else: no &&), whose branch denies as one of its
// own statements and stops, with nothing before it letting requests through. Traps: a deny that doesn't stop (no return; gin without
// Abort). `next` / `ctx`: what this code calls to go on (next.ServeHTTP, h.ServeHTTP, c.Next()).
function check(body: N | null | undefined, gin: boolean, next: string[] = ['next'], ctx: string[] = ['c'], middleware = true): { kind?: 'login' | 'unknown'; admin?: boolean; traps: string[] } {
  const traps: string[] = []
  if (!body) return { traps }
  const NEXT = new RegExp(String.raw`\b(?:${next.join('|')})\.ServeHTTP\(|\b(?:${next.join('|')})\(\s*\w+\s*(?:,\s*\w+\s*)?\)|\b(?:${ctx.join('|')})\.Next\(\)`)
  const stmtsOf = (n: N | null | undefined) => ((n?.namedChildren.find(c => c?.type === 'statement_list') ?? n)?.namedChildren ?? []).filter((x): x is N => !!x && x.type !== 'comment')
  const stmts = stmtsOf(body)
  let escaped = false
  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i], t = st.text
    if (st.type === 'if_statement') {
      const condOnly = st.childForFieldName('condition')?.text ?? '', cond = (st.childForFieldName('initializer')?.text ?? '') + ' ' + condOnly
      const then = st.childForFieldName('consequence'), own = stmtsOf(then), alt = st.childForFieldName('alternative')?.text ?? ''
      if (own.some(x => /^(expression_statement|return_statement)$/.test(x.type) && DENY.test(x.text))) {
        const vars = [...condOnly.matchAll(/\b(err|ok|\w*[Ee]rr)\b/g)].map(m => m[1])
        const NOT_WHO = /csrf|xsrf|captcha|turnstile|origin|referer|signature|webhook|reset|invite|confirm|unsubscribe|magic/i   // (checks about the request, not who's asking)
        const srcs = vars.flatMap(v => [st.childForFieldName('initializer')?.text ?? '', ...stmts.slice(0, i).map(p => p.text)].filter(p => new RegExp(`\\b${v}\\b[^=\\n]*:?=`).test(p)))
        const from = srcs.some(p => FROM_LOGIN.test(p)) && !srcs.some(p => NOT_WHO.test(p))
        // (`if !u.IsAdmin`: a guest has no user either, and is turned away too: "only admins"; the flag must be the user's, not one
        // the request carries: `role := r.Header.Get("X-Role")`, a decoded JSON body)
        const av = condOnly.match(/!\s*\(?\s*(\w+)\./)?.[1] ?? condOnly.match(/(\w+)\.Role\b/)?.[1]
        const asrc = av ? [st.childForFieldName('initializer')?.text ?? '', ...stmts.slice(0, i).map(p => p.text)].filter(p => new RegExp(`\\b${av}\\b[^=\\n]*:?=`).test(p)).join('\n') : ''
        const admin = adminCond(condOnly) && (WHO.test(condOnly) || WHO.test(asrc)) && !/\br\.(?:Body|Header|URL|Form|PostForm|FormValue)|json\.(?:NewDecoder|Unmarshal)|\.(?:ShouldBind\w*|Bind\w*|Query|Param|GetHeader|DefaultQuery)\(/.test(asrc)
        const about = (NO_ONE.test(condOnly) && (WHO.test(condOnly) || from) || admin) && !NOT_WHO.test(cond.replace(/\.\w*Confirmed\b/g, ''))   // (user.EmailConfirmed is about who's asking)
        const last = stmts.slice(i + 1).every(x => x.type === 'return_statement')   // (an else covers it only when nothing runs after the if)
        const stops = own.some(x => x.type === 'return_statement') || NEXT.test(alt) && !NEXT.test(then?.text ?? '') || gin && /\.Abort/.test(then?.text ?? '') || !middleware && !!alt && last
        if (gin && !/\.Abort/.test(then?.text ?? '')) { if (middleware) traps.push('ginNoAbort'); return { kind: middleware ? 'unknown' : (own.some(x => x.type === 'return_statement') || !!alt && last) && about && !escaped ? 'login' : 'unknown', admin, traps } }
        if (!stops) { traps.push('noReturn'); return { kind: 'unknown', traps } }
        return { kind: about && !/&&/.test(condOnly) && !escaped ? 'login' : 'unknown', admin, traps }
      }
      if (NEXT.test(then?.text ?? '') || /\breturn\b/.test(then?.text ?? '')) escaped = true   // some requests go on (or leave) before what follows
      continue
    }
    if (st.type === 'return_statement') break
    if (NEXT.test(t) || /\breturn\b/.test(t)) escaped = true   // a loop or switch that lets some requests through
  }
  // anything else that denies, somewhere plain can't be sure covers every request
  return { kind: DENY.test(body.text) ? 'unknown' : undefined, traps }
}

export function goFacts(path: string, text: string, empty: (printed?: string) => FileFacts): GoFacts | undefined {
  if (!parser) return undefined
  const tree = parser.parse(text)
  if (!tree) return undefined
  const root = tree.rootNode
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const pkg = all(root, 'package_identifier')[0]?.text ?? ''
  const imports = new Map<string, string>()
  for (const s of all(root, 'import_spec')) { const p = str(s.childForFieldName('path')) ?? '', alias = s.childForFieldName('name')?.text ?? p.split('/').filter(x => !/^v\d+$/.test(x)).pop()!.replace(/^go-/, '').replace(/-go$/, ''); imports.set(alias, p) }
  const f: GoFacts = Object.assign(empty(text.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')), { go: { pkg, dir, imports, funcs: new Map(), structs: new Map(), automigrate: [], selfMigrates: false, required: [], risks: new Set<string>() } as GoFacts['go'] })
  f.todos = [...text.matchAll(/\/\/\s*((TODO|FIXME|HACK)\b[^\n]*)/g)].map(m => m[1])
  const go = f.go
  const isGin = [...imports.values()].some(p => /gin-gonic\/gin/.test(p)), lit = (n: N) => `@lit${n.startIndex}`

  // ---- functions: their route operations, facts, checks ----
  for (const fn of [...all(root, 'function_declaration'), ...all(root, 'method_declaration')]) {
    const name = fn.childForFieldName('name')!.text, recv = fn.type === 'method_declaration' ? fn.childForFieldName('receiver')?.text.match(/\*?\s*(\w+)\s*\)$/)?.[1] : undefined
    record(recv ? `${recv}.${name}` : name, fn)
  }
  for (const fl of all(root, 'func_literal')) record(lit(fl), fl)
  function record(key: string, fn: N) {
    const body = fn.childForFieldName('body')
    const params = (fn.childForFieldName('parameters')?.namedChildren ?? []).flatMap(p => (p?.namedChildren ?? []).filter(x => x?.type === 'identifier').map(x => x!.text))
    const g = collect(fn, empty(fn.text.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')))
    const ginCtx = /\*gin\.Context/.test(fn.childForFieldName('parameters')?.text ?? '') || isGin && /gin\.HandlerFunc/.test(fn.childForFieldName('result')?.text ?? '')
    // a middleware: func(next http.Handler) http.Handler { return http.HandlerFunc(func(w, r) { ... }) }, gin's func() gin.HandlerFunc,
    // echo's func(next echo.HandlerFunc) echo.HandlerFunc, factories taking a dependency first: the innermost closure returned decides
    const names = (n: N, re: RegExp) => all(n.childForFieldName('parameters') ?? n, 'parameter_declaration').filter(p => re.test(p.childForFieldName('type')?.text ?? '')).flatMap(p => p.namedChildren.filter(x => x?.type === 'identifier').map(x => x!.text))
    const nexts = new Set(names(fn, /(?:http|echo|gin)\.Handler(?:Func)?\b/)), ctxs = new Set(names(fn, /gin\.Context|echo\.Context|fiber\.Ctx/))
    let inner: N | undefined, at: N | null | undefined = body
    for (let d = 0; at && d < 3; d++) {
      const ret = stmtsTop(at).find(x => x.type === 'return_statement'), lit_ = ret ? all(ret, 'func_literal')[0] : undefined
      if (!lit_) break
      inner = lit_; at = lit_.childForFieldName('body')
      for (const x of names(lit_, /(?:http|echo|gin)\.Handler(?:Func)?\b/)) nexts.add(x)
      for (const x of names(lit_, /gin\.Context|echo\.Context|fiber\.Ctx/)) ctxs.add(x)
    }
    const nx = [...nexts].length ? [...nexts] : ['next'], cx = [...ctxs].length ? [...ctxs] : ['c']
    // (the function itself: a handler, unless it's used as middleware (a func literal in Use / With) or returns one)
    const asMw = fn.type === 'func_literal' && fn.parent?.type === 'argument_list' && (/\.(Use|With|Group)$/.test(fn.parent.parent ? callee(fn.parent.parent) : '') || fn.parent.namedChildren.at(-1)?.id !== fn.id && !/\becho\.Context\b/.test(fn.childForFieldName('parameters')?.text ?? ''))   // (echo puts the handler first: e.POST(p, func(c echo.Context) error {...}, mw...))
    const own = check(body, ginCtx, nx, cx, asMw || nexts.size > 0)
    const mw = inner ? check(inner.childForFieldName('body'), ginCtx || /gin\.Context/.test(inner.childForFieldName('parameters')?.text ?? ''), nx, cx) : check(body, ginCtx, nx, cx, true)
    const actsAsMw = !!inner || asMw || nexts.size > 0 || new RegExp(String.raw`\b(?:${cx.join('|')})\.Next\(\)`).test(body?.text ?? '')
    const pkgVars = new Map<string, string>()
    for (const d of body ? all(body, 'short_var_declaration') : []) { const v = d.childForFieldName('left')?.namedChildren[0]?.text, rhs = d.childForFieldName('right')?.namedChildren[0]
      const callee_ = rhs?.type === 'call_expression' ? callee(rhs) : rhs?.type === 'unary_expression' ? rhs.text.match(/^&(\w+)\./)?.[1] + '.' : rhs?.text.match(/^(\w+)\.\w+\{/)?.[1] + '.'
      const alias = callee_?.split('.')[0]; if (v && alias && imports.has(alias)) pkgVars.set(v, imports.get(alias)!) }
    go.funcs.set(key, Object.assign(g, { takesHandler: names(fn, /(?:http|echo|gin)\.Handler(?:Func)?\b/).length > 0, inUse: asMw, pkgVars, routeOps: body ? ops(body) : [], params, check: own.kind, mw: mw.kind ?? 'none', checkAdmin: own.kind === 'login' && own.admin, mwAdmin: mw.kind === 'login' && mw.admin, traps: actsAsMw ? mw.traps : own.traps }))
  }

  // route operations in a block, in order
  function ops(block: N): GoOp[] {
    const out: GoOp[] = []
    const list = block.namedChildren.find(c => c?.type === 'statement_list') ?? block
    for (const st of list.namedChildren) {
      if (!st) continue
      if (/http\.Server\{/.test(st.text)) for (const kv of all(st, 'keyed_element')) if (/^Handler\b/.test(kv.namedChildren[0]?.text ?? '')) out.push({ op: 'serve', handler: ref(kv.namedChildren.at(-1)!.namedChildren[0] ?? kv.namedChildren.at(-1)!) })
      if (st.type === 'return_statement') { const v = st.namedChildren[0]?.namedChildren[0] ?? st.namedChildren[0]; if (v?.type === 'identifier') out.push({ op: 'return', v: v.text }); else if (v) { const r = ref(v); if (r.fn) out.push({ op: 'return', v: r.fn, wrap: r.wrap }) } continue }
      // v := chi.NewRouter() / gin.Default() / echo.New() / http.NewServeMux(); g := r.Group("/x", mw); a := r.With(mw)
      if (st.type === 'short_var_declaration' || st.type === 'assignment_statement' || st.type === 'var_declaration') {
        const v = st.childForFieldName('left')?.namedChildren[0]?.text ?? all(st, 'var_spec')[0]?.childForFieldName('name')?.text, rhs = (st.childForFieldName('right') ?? all(st, 'var_spec')[0]?.childForFieldName('value'))?.namedChildren[0]
        if (!v || rhs?.type !== 'call_expression') continue
        const fnt = callee(rhs), a = argsOf(rhs)
        if (/^chi\.NewRouter$|^chi\.NewMux$/.test(fnt)) out.push({ op: 'new', v, kind: 'chi' })
        else if (/^gin\.(Default|New)$/.test(fnt)) out.push({ op: 'new', v, kind: 'gin' })
        else if (/^echo\.New$/.test(fnt)) out.push({ op: 'new', v, kind: 'echo' })
        else if (/^http\.NewServeMux$/.test(fnt)) out.push({ op: 'new', v, kind: 'mux' })
        else if (/\.Group$/.test(fnt) && a.length && str(a[0]) !== undefined) out.push({ op: 'group', v, from: fnt.slice(0, -6), prefix: str(a[0])!, mws: a.slice(1).map(ref) })
        else if (/\.With$/.test(fnt)) out.push({ op: 'group', v, from: fnt.slice(0, -5), prefix: '', mws: a.map(ref) })
        else if (rhs.childForFieldName('function')?.type === 'identifier' || rhs.childForFieldName('function')?.type === 'selector_expression') out.push({ op: 'assign', v, fn: fnt, args: a.map(x => x.text) })
        continue
      }
      const call = st.type === 'expression_statement' ? st.namedChildren[0] : st.type === 'go_statement' || st.type === 'defer_statement' ? st.namedChildren[0] : undefined
      if (call?.type !== 'call_expression') { if (st.type === 'if_statement' || st.type === 'block') for (const b of all(st, 'block').slice(0, 1)) out.push(...ops(b)); continue }
      const nested = all(call, 'call_expression').find(c => /^http\.ListenAndServe(TLS)?$/.test(callee(c)))
      if (nested && nested.id !== call.id) { out.push(...callOps(nested)); continue }
      out.push(...callOps(call))
    }
    return out
  }
  function callOps(call: N): GoOp[] {
    const fnt = callee(call), a = argsOf(call), sel = call.childForFieldName('function')
    let on = sel?.type === 'selector_expression' ? sel.childForFieldName('operand')!.text : '', pre: GoRef[] = []
    const m = sel?.type === 'selector_expression' ? sel.childForFieldName('field')!.text : ''
    // r.With(mw).Post(...): the route's own middleware
    const operand = sel?.type === 'selector_expression' ? sel.childForFieldName('operand') : undefined
    if (operand?.type === 'call_expression' && /\.With$/.test(callee(operand))) { pre = argsOf(operand).map(ref); on = callee(operand).slice(0, -5) }
    // net/http: mux.Handle("/api/", http.StripPrefix("/api", apiMux)) mounts a sub-mux
    if (on && m === 'Handle' && a[1]?.type === 'call_expression' && /StripPrefix$/.test(callee(a[1]))) return [{ op: 'mount', on, prefix: str(argsOf(a[1])[0]) ?? '', target: ref(argsOf(a[1])[1]) }]
    // r.Get("/x", h) / r.GET("/x", mw, h) / e.GET("/x", h, mw...) / mux.HandleFunc("POST /x", h) / r.Method("GET", "/x", h)
    if (on && (VERB[m] || m === 'Match') && a.length >= 2) {
      const methodArg = m === 'Method' || m === 'MethodFunc' ? str(a[0]) : undefined, rest = methodArg ? a.slice(1) : a
      let p = str(rest[0]); if (p === undefined) return []
      let methods = methodArg ? [methodArg.toUpperCase()] : [VERB[m]]
      const pm = p.match(/^([A-Z]+)\s+(.*)$/); if (pm && /^(HandleFunc|Handle)$/.test(m)) { methods = [pm[1]]; p = pm[2] }
      p = p.replace(/^[^/]*(?=\/)/, '')   // (a host in a net/http pattern)
      const hs = rest.slice(1).map(ref)
      // gin: the last is the handler, the rest middleware; echo: the first is the handler, the rest middleware
      const echo = hs.length > 1 && !isGin && /echo/.test([...imports.values()].join(' '))
      return [{ op: 'route', on, methods, path: p, handler: echo ? hs[0] : hs.at(-1)!, mws: [...pre, ...echo ? hs.slice(1) : hs.slice(0, -1)] }]
    }
    if (on && m === 'Use') return [{ op: 'use', on, mws: a.map(ref) }]
    if (on && (m === 'Route' || m === 'Group') && a.some(x => x.type === 'func_literal')) {
      const fl = a.find(x => x.type === 'func_literal')!, v = fl.childForFieldName('parameters')?.namedChildren[0]?.namedChildren.find(x => x?.type === 'identifier')?.text ?? on
      return [{ op: 'sub', on, prefix: m === 'Route' ? str(a[0]) ?? '' : '', v, ops: ops(fl.childForFieldName('body')!) }]
    }
    if (on && (m === 'Route' || m === 'Group') && a.length && /^(identifier|selector_expression)$/.test(a.at(-1)!.type)) return [{ op: 'subfn', on, prefix: m === 'Route' ? str(a[0]) ?? '' : '', fn: a.at(-1)!.text }]
    if (on && m === 'Mount' && a.length === 2) return [{ op: 'mount', on, prefix: str(a[0]) ?? '', target: ref(a[1]) }]
    if (/^http\.ListenAndServe(TLS)?$/.test(fnt) && a.length >= 2) return [{ op: 'serve', handler: ref(a.at(-1)!) }]
    if (on && /^(Run|Start|RunTLS|StartTLS|ListenAndServe)$/.test(m)) return []
    // registerRoutes(r, h) / api.RegisterRoutes(r)
    if (a.some(x => x.type === 'identifier')) return [{ op: 'call', fn: fnt, args: a.map(x => x.text) }]
    return []
  }
  // a handler / middleware expression
  function ref(n: N): GoRef {
    if (n.type === 'func_literal') return { lit: lit(n) }
    if (n.type === 'call_expression') {
      const fnt = callee(n), a = argsOf(n)
      if (/^http\.(HandlerFunc|Handler)$/.test(fnt) && a.length === 1) return ref(a[0])   // a conversion
      // requireAuth(h) / auth.Middleware(h) wraps; jwtauth.Verifier(tokenAuth), middleware.Logger(), AuthRequired() build a middleware
      const inner = a.find(x => /^(identifier|selector_expression|func_literal|call_expression)$/.test(x.type) && !/^(tokenAuth|ja|cfg|config|db|store)$/i.test(x.text))
      if (inner && a.length === 1 && !/^(jwtauth|middleware|echojwt|cors|gin|clerkhttp)\./.test(fnt)) { const r = ref(inner); return { ...r, wrap: [fnt, ...r.wrap ?? []] } }
      return { call: fnt, args: a.map(x => x.text) }
    }
    return { fn: n.text }
  }

  // ---- GORM models, migrations at startup, required settings ----
  for (const t of all(root, 'type_spec')) {
    const st = t.childForFieldName('type')
    if (st?.type !== 'struct_type') continue
    const fields: string[] = []
    for (const fd of all(st, 'field_declaration')) {
      const names = fd.namedChildren.filter(x => x?.type === 'field_identifier').map(x => x!.text), ty = fd.childForFieldName('type')?.text ?? ''
      if (!names.length && /gorm\.Model/.test(fd.text)) fields.push('id', 'created_at', 'updated_at', 'deleted_at')
      for (const n of names) fields.push(/^[A-Z]\w*$/.test(ty.replace(/^\*/, '')) && !/^(Time|String|Int|Bool|Float|Decimal|JSON|UUID|NullString|NullInt64|NullTime)$/.test(ty.replace(/^\*|^\w+\./g, '')) && !/\[\]/.test(ty) ? `→${ty.replace(/^\*|^\w+\./g, '')}` : n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/ID$/, '_id').toLowerCase().replace(/__/g, '_'))
      const tag = fd.childForFieldName('tag')?.text ?? ''
      for (const m of tag.matchAll(/env:"(\w+)([^"]*)"/g)) if (/required/.test(m[2]) && !/envDefault:/.test(tag)) go.required.push(m[1])
      for (const m of tag.matchAll(/envconfig:"(\w+)"[^`]*required:"true"/g)) go.required.push(m[1])
    }
    go.structs.set(t.childForFieldName('name')!.text, fields)
  }
  // migrations run by the server itself: golang-migrate's m.Up() / goose.Up in a main that also starts the server (not a separate
  // migrate command, not tests); AutoMigrate only makes GORM's tables (it never applies .sql files)
  const serves = /ListenAndServe|\.Run\(|\.Start\(|\.Listen\(/.test(text) && pkg === 'main' && !path.endsWith('_test.go')
  for (const c of all(root, 'call_expression')) {
    const fnt = callee(c)
    if (/\.AutoMigrate$/.test(fnt)) for (const a of argsOf(c)) { const m = a.text.match(/&?(?:\w+\.)?(\w+)\{\}/)?.[1]; if (m) go.automigrate.push(m) }
    if (serves && (/^goose\.(Up|UpContext|UpTo)$/.test(fnt) || /\.Up$/.test(fnt) && /migrate\.New/.test(text))) go.selfMigrates = true
  }
  // required: mustEnv("X") / requireEnv("X") style helpers, and LookupEnv followed by a fatal
  for (const c of all(root, 'call_expression')) if (/^(must|require)\w*Env\w*$|^(must|require)Getenv$|^env\.Must\w*$/i.test(callee(c))) { const k = str(argsOf(c)[0]); if (k) go.required.push(k) }
  for (const m of text.matchAll(/os\.LookupEnv\(\s*"(\w+)"\s*\)\s*;?\s*(?:\n\s*if\s+)?!\s*ok\s*\{[^}]*?(log\.Fatal|panic\()/g)) go.required.push(m[1])
  for (const m of text.matchAll(/os\.Getenv\(\s*"(\w+)"\s*\)\s*;?\s*\n?\s*if\s+\w+\s*==\s*""\s*\{[^}]*?(log\.Fatal|panic\()/g)) go.required.push(m[1])
  // risks: SQL built with Sprintf; CORS that reflects any site with cookies; a check that doesn't stop the request
  const code = text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`])\/\/[^\n]*/g, '$1')
  const SQL = String.raw`(?:SELECT\s[\s\S]*?\sFROM\s|INSERT\s+INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s)`
  if (new RegExp(String.raw`fmt\.Sprintf\(\s*["\x60][^"\x60]*${SQL}[^"\x60]*%[sv]`, 'i').test(code) || new RegExp(String.raw`["\x60][^"\x60]*${SQL}[^"\x60]*=\s*'?["\x60]\s*\+\s*\w`, 'i').test(code)) go.risks.add('sql')
  const creds = /AllowCredentials:\s*true/.test(code)
  if (creds && (/AllowOriginFunc:\s*func\([^)]*\)\s*bool\s*\{\s*return\s+true/.test(code) || /AllowedOrigins:\s*\[\]string\{[^}]*"https?:\/\/\*"/.test(code) || /AllowOrigins:\s*\[\]string\{[^}]*"https?:\/\/\*"/.test(code) && /AllowWildcard:\s*true/.test(code))
    || /Access-Control-Allow-Origin",\s*(r\.Header\.Get\("Origin"\)|origin)\)/.test(code) && /Access-Control-Allow-Credentials",\s*"true"/.test(code) || /UnsafeWildcardOriginWithAllowCredentials:\s*true/.test(code)) go.risks.add('corsCreds')
  ;(f as FileFacts & { parseError?: boolean }).parseError = tree.rootNode.hasError   // (see the cut-off file check in plain.ts)
  tree.delete()   // trees live in WebAssembly memory, which JavaScript never frees: a big repo filled it and the parser aborted
  return f

  // Facts from one function: database writes and reads, Stripe, email, env, calls into other functions, "no" messages.
  function collect(node: N, g: FileFacts): FileFacts {
    // variable types: order := models.Order{...} / var order models.Order / orders := []Order{} / order := &Order{}
    const vt = new Map<string, string>()
    for (const d of [...all(node, 'short_var_declaration'), ...all(node, 'var_spec')]) {
      const v = (d.childForFieldName('left') ?? d.childForFieldName('name'))?.namedChildren[0]?.text ?? d.childForFieldName('name')?.text
      const ty = d.childForFieldName('type')?.text ?? d.childForFieldName('right')?.namedChildren[0]?.text.match(/^&?(?:\[\])?(?:\w+\.)?([A-Z]\w*)\{/)?.[0]
      const t = ty?.replace(/^&|\[\]|\{$|^\*/g, '').replace(/^\w+\./, '')
      if (v && t && /^[A-Z]\w*$/.test(t)) vt.set(v, t)
    }
    for (const p of all(node.childForFieldName('parameters') ?? node, 'parameter_declaration')) { const t = p.childForFieldName('type')?.text.replace(/^\*|^\[\]|^\w+\./g, '').replace(/^\*|^\w+\./g, ''); if (t && /^[A-Z]\w*$/.test(t)) for (const x of p.namedChildren.filter(x => x?.type === 'identifier')) vt.set(x!.text, t) }
    const entity = (n?: N) => { if (!n) return undefined; const t = n.text.replace(/^&/, ''); return t.match(/^(?:\[\])?(?:\w+\.)?([A-Z]\w*)\{/)?.[1] ?? vt.get(t) }
    const write = (e: string | undefined, op: string) => { if (!e) return; g.tables.add(`@e:${e}`); g.written.add(`@e:${e}`); g.writes = true; g.ops.add(op) }
    for (const c of all(node, 'call_expression')) {
      const fnt = callee(c), a = argsOf(c), sel = c.childForFieldName('function'), m = sel?.type === 'selector_expression' ? sel.childForFieldName('field')!.text : fnt
      const opnd = sel?.type === 'selector_expression' ? sel.childForFieldName('operand')!.text : '', imp = imports.get(opnd) ?? ''
      g.used.add(m)
      // GORM: db.Create(&order), db.Save(&o), db.Delete(&Order{}, id), db.Model(&o).Update(...), db.Where(...).Find(&orders)
      if (/^(Create|CreateInBatches|Save|FirstOrCreate)$/.test(m) && a.length && entity(a[0])) write(entity(a[0]), m === 'Save' ? 'update' : 'create')
      else if (/^(Delete|Unscoped)$/.test(m) && a.length && entity(a[0])) write(entity(a[0]), 'delete')
      else if (/^(Update|Updates|UpdateColumn|UpdateColumns)$/.test(m) && /\.Model\(/.test(fnt)) write(entity(all(sel!, 'call_expression').find(x => /\.Model$/.test(callee(x))) ? argsOf(all(sel!, 'call_expression').find(x => /\.Model$/.test(callee(x)))!)[0] : undefined), 'update')
      else if (/^(Find|First|Last|Take|Scan)$/.test(m) && a.length && entity(a[0])) g.tables.add(`@e:${entity(a[0])}`)
      // sqlc / repository methods: q.CreateOrder(ctx, ...), store.CancelOrder(...), repo.ListOrders(...)
      const qm = m.match(/^(Create|Insert|Add|Update|Set|Delete|Remove|Upsert|Cancel|Mark|Get|List|Find|Count)([A-Z]\w*?)(?:ByID|ByEmail|By\w+)?$/)
      if (qm && /quer|store|repo|db\b|^q$|dao|model/i.test(opnd.split('.').pop() ?? '')) {
        const e = qm[2].replace(/s$/, ''); if (/^(Get|List|Find|Count)$/.test(qm[1])) g.tables.add(`@e:${e}`); else write(e, /^(Delete|Remove)$/.test(qm[1]) ? 'delete' : /^(Create|Insert|Add)$/.test(qm[1]) ? 'create' : 'update')
      }
      // raw SQL: db.ExecContext(ctx, "UPDATE orders SET ..."), pool.QueryRow(ctx, `INSERT INTO orders ...`)
      if (/^(Exec|ExecContext|Query|QueryContext|QueryRow|QueryRowContext|Get|Select|NamedExec|NamedExecContext|MustExec|Raw)$/.test(m)) for (const s of a.map(str).filter(Boolean) as string[]) {
        const w = s.match(/^\s*(?:WITH[\s\S]*?\)\s*)?(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)"?/i), r = s.match(/\bFROM\s+"?(\w+)"?/i)
        if (w) write(`@t:${w[2]}`, /^INSERT/i.test(w[1]) ? 'create' : /^UPDATE/i.test(w[1]) ? 'update' : 'delete'); else if (r) g.tables.add(`@e:@t:${r[1]}`)
      }
      // Stripe (stripe-go): session.New / paymentintent.New / refund.New / webhook.ConstructEvent, or the client's V1... services
      if (/stripe-go/.test(imp)) {
        if (/checkout\/session$/.test(imp) && m === 'New') { g.money = true; g.services.add('Stripe'); g.outside.add('Stripe: checkout.sessions.create') }
        if (/\/(paymentintent|charge|subscription|paymentlink)$/.test(imp) && m === 'New') { g.money = true; g.services.add('Stripe') }
        if (/\/refund$/.test(imp) && m === 'New') { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
        if (/\/webhook$/.test(imp) && /^ConstructEvent/.test(m)) { g.services.add('Stripe'); g.outside.add('Stripe: webhooks.constructEvent') }
      }
      if (/\.CheckoutSessions\.New$/.test(fnt) && /stripe-go/.test([...imports.values()].join(' '))) { g.money = true; g.services.add('Stripe'); g.outside.add('Stripe: checkout.sessions.create') }
      if (/\.(PaymentIntents|Charges|Subscriptions)\.New$/.test(fnt) && /stripe-go/.test([...imports.values()].join(' '))) { g.money = true; g.services.add('Stripe') }
      if (/\.Refunds\.New$/.test(fnt) && /stripe-go/.test([...imports.values()].join(' '))) { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
      if (/\.V1CheckoutSessions\.Create$/.test(fnt)) { g.money = true; g.services.add('Stripe'); g.outside.add('Stripe: checkout.sessions.create') }
      if (/\.V1(PaymentIntents|Charges|Subscriptions)\.Create$/.test(fnt)) { g.money = true; g.services.add('Stripe') }
      if (/\.V1Refunds\.Create$/.test(fnt)) { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
      if (/^webhook\.ConstructEvent/.test(fnt) && /stripe/.test([...imports.values()].join(' '))) { g.services.add('Stripe'); g.outside.add('Stripe: webhooks.constructEvent') }
      // email: smtp.SendMail, gomail / go-mail DialAndSend, resend client.Emails.Send, sendgrid, postmark
      if (fnt === 'smtp.SendMail' || /DialAndSend$|\.Emails\.Send$|SendEmail$/.test(fnt) || m === 'Send' && /sendgrid/.test([...imports.values()].join(' '))) { g.services.add('email'); g.outside.add('email: send') }
      // env: os.Getenv("X") (empty when unset: optional)
      if (fnt === 'os.Getenv' || fnt === 'os.LookupEnv' || /^(must|require)\w*Env\w*$|^(must|require)Getenv$|^env\.Must\w*$/i.test(fnt)) { const k = str(a[0]); if (k) g.env.add(k) }
      // "no" messages: http.Error(w, "msg", 409), c.JSON(http.StatusConflict, gin.H{"error": "msg"}), echo.NewHTTPError(409, "msg")
      if (/^http\.Error$/.test(fnt) && /StatusConflict|StatusBadRequest|StatusUnprocessableEntity|StatusPaymentRequired|\b(400|402|409|422)\b/.test(a[2]?.text ?? '')) { const s = str(a[1]); if (s) g.refuses.add(s) }
      if (/^(JSON|NewHTTPError|String)$/.test(m) && /StatusConflict|StatusBadRequest|StatusUnprocessableEntity|StatusPaymentRequired|\b(400|402|409|422)\b/.test(a[0]?.text ?? '')) { const s = (a[1] && str(a[1])) ?? a[1]?.text.match(/"(?:error|message)"\s*:\s*"([^"]+)"/)?.[1]; if (s) g.refuses.add(s) }
      // calls into other functions: createOrder(...), orders.Cancel(...), h.svc.Refund(...)
      if (sel?.type === 'identifier') g.used.add(`gcall:${pkg}.${fnt}`)
      else if (opnd && imports.has(opnd)) g.used.add(`gcall:${imports.get(opnd)}.${m}`)
      else if (opnd) g.used.add(`gcall:*.${m}`)
    }
    // a hand-written call to Stripe's API: "https://api.stripe.com/v1/refunds", ".../v1/checkout/sessions"
    for (const lit_ of all(node, 'interpreted_string_literal')) { const u = lit_.text
      if (/api\.stripe\.com\/v1\/refunds"$/.test(u)) { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
      if (/api\.stripe\.com\/v1\/(checkout\/sessions|payment_intents|charges)"$/.test(u)) { g.money = true; g.services.add('Stripe'); if (/checkout/.test(u)) g.outside.add('Stripe: checkout.sessions.create') } }
    g.emptyCatch += all(node, 'if_statement').filter(s => /err\s*!=\s*nil/.test(s.childForFieldName('condition')?.text ?? '') && /^\{\s*\}$/.test(s.childForFieldName('consequence')?.text ?? '')).length
    return g
  }
}
