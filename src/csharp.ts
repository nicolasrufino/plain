// C# (ASP.NET Core): controllers and minimal APIs, their login rules, Entity Framework, Stripe. The same facts plain.ts reads from
// TypeScript and Python. Parsed with tree-sitter (grammar in vendor/).
// Login, as ASP.NET decides it: [AllowAnonymous] / .AllowAnonymous() anywhere on the way (endpoint, handler, controller and its base
// classes, groups) skips every check; otherwise [Authorize] / .RequireAuthorization() on any of those; otherwise the project's app-wide
// FallbackPolicy (or a global AuthorizeFilter / MapControllers().RequireAuthorization() for controllers). With none, it's open.
// Controllers are resolved in plain.ts, through their base classes across files ([ApiController], [Route] and [Authorize] are inherited).
// ponytail: conventional "{controller}/{action}" routes, Razor Pages and Blazor aren't read yet; controllers without any route are skipped.
import type { FileFacts } from './plain.ts'
import { parserFor } from './treesitter.ts'
const parser = await parserFor('tree-sitter-c-sharp.wasm')   // ~40 ms; null when web-tree-sitter isn't installed: C# files are skipped

type N = import('web-tree-sitter').Node
export type Auth = 'yes' | 'anon' | undefined
export type CsRoute = { method: string; path: string; auth: Auth; facts?: FileFacts; handler?: string; controller: boolean }
// a class as written: what controller resolution needs (its own attributes, bases, and actions with their raw templates)
export type CsClass = { bases: string[]; abstract: boolean; api: boolean; route?: string; auth: Auth
  actions: { name: string; method: string; tpl?: string; auth: Auth }[] }
// a call to a group-filling extension method: app.MapGroup("/orders").MapOrders(), OrderEndpoints.MapOrders(app)
export type ExtCall = { name: string; prefix: string; auth: Auth }
export type CsFacts = FileFacts & { cs: {
  routes: CsRoute[]                                          // minimal APIs on the app or a group made in this file (full paths)
  ext: Map<string, { routes: CsRoute[]; calls: ExtCall[] }>  // extension methods that map routes (paths relative to the group they're called on)
  extCalls: ExtCall[]
  classes: Map<string, CsClass>
  methods: Map<string, FileFacts & { csAuth?: Auth }>        // Class.Method -> facts (and its own [Authorize]/[AllowAnonymous])
  fallback: boolean; allControllers: boolean                 // app-wide rules registered in this file
  dbsets: Map<string, string>; entities: Map<string, string[]>   // DbSet<Order> Orders -> Order; mapped properties ("→Type" for a linked entity)
  risks: Set<string>
} }

const str = (n?: N | null): string | undefined =>
  n && /^(string_literal|verbatim_string_literal|raw_string_literal)$/.test(n.type) ? n.text.replace(/^@?"+|"+$/g, '') : undefined
const all = (n: N, type: string) => n.descendantsOfType(type).filter((x): x is N => !!x)
const args = (call: N) => (call.childForFieldName('arguments')?.namedChildren ?? []).filter((a): a is N => !!a && a.type === 'argument').map(a => a.namedChildren.at(-1)!)
const fnText = (call: N) => call.childForFieldName('function')?.text.replace(/\s/g, '') ?? ''
const attrs = (decl: N) => decl.namedChildren.filter((c): c is N => c?.type === 'attribute_list').flatMap(l => l.namedChildren.filter((a): a is N => a?.type === 'attribute'))
const attrName = (a: N) => a.childForFieldName('name')!.text.split('.').at(-1)!.replace(/Attribute$/, '')
const attrArg = (a: N) => { const l = a.namedChildren.find(c => c?.type === 'attribute_argument_list'); return str(l?.namedChildren.find(c => c?.type === 'attribute_argument')?.namedChildren.find(x => /string/.test(x?.type ?? '')) ?? null) }
const authOf = (as: N[]): Auth => as.some(a => attrName(a) === 'AllowAnonymous') ? 'anon' : as.some(a => attrName(a) === 'Authorize') ? 'yes' : undefined
export const mergeAuth = (...xs: Auth[]): Auth => xs.includes('anon') ? 'anon' : xs.includes('yes') ? 'yes' : undefined
const HTTP: Record<string, string> = { HttpGet: 'GET', HttpPost: 'POST', HttpPut: 'PUT', HttpPatch: 'PATCH', HttpDelete: 'DELETE' }
const DB = /^_?(db|context|dbContext|ctx|data|\w*Db|\w*Context)$/i
const EF_WRITE: Record<string, string> = { Add: 'create', AddAsync: 'create', AddRange: 'create', AddRangeAsync: 'create', Remove: 'delete', RemoveRange: 'delete',
  ExecuteDelete: 'delete', ExecuteDeleteAsync: 'delete', Update: 'update', UpdateRange: 'update', ExecuteUpdate: 'update', ExecuteUpdateAsync: 'update' }
// {id:int}, {id?}, {*rest} -> [id], [rest]
export const csPath = (p: string) => p.replace(/\{\*{0,2}(\w+)[^}]*\}/g, '[$1]')
// a controller action's "/x" or "~/x" ignores the controller's route; a minimal API's "/x" inside a group adds to it
export const join = (a: string, b: string) => b.startsWith('/') || b.startsWith('~/') ? b.replace(/^~/, '') : `${a.replace(/\/$/, '')}/${b}`.replace(/\/$/, '') || '/'
export const under = (a: string, b: string) => (`${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`.replace(/\/$/, '')) || '/'
const fnLike = /^(method_declaration|local_function_statement|lambda_expression|anonymous_method_expression|constructor_declaration)$/

export function csFacts(path: string, text: string, empty: (printed?: string) => FileFacts): CsFacts | undefined {
  if (!parser) return undefined
  const tree = parser.parse(text)
  if (!tree) return undefined
  const root = tree.rootNode
  // comments found by the parser, not by text: "/orders/**" in a string isn't the start of one
  let code = text
  for (const c of ['comment'].flatMap(k => all(root, k)).sort((a, b) => b.startIndex - a.startIndex)) code = code.slice(0, c.startIndex) + code.slice(c.endIndex)
  const f: CsFacts = Object.assign(collect(root, empty(code.replace(/\s+/g, ' '))), { cs: { routes: [], ext: new Map(), extCalls: [], classes: new Map(), methods: new Map(),
    // FallbackPolicy = ...RequireAuthenticatedUser(), SetFallbackPolicy(...RequireAuthenticatedUser()), FallbackPolicy = options.DefaultPolicy (login by default)
    fallback: /FallbackPolicy\s*=\s*[^;]*RequireAuthenticatedUser\s*\(|SetFallbackPolicy\s*\([^;]*RequireAuthenticatedUser\s*\(|FallbackPolicy\s*=\s*\w+\.DefaultPolicy\b/.test(code),
    allControllers: /Filters\.Add\(\s*new\s+AuthorizeFilter\b|MapControllers\(\)\s*\.RequireAuthorization\(/.test(code),
    dbsets: new Map<string, string>(), entities: new Map<string, string[]>(), risks: new Set<string>() } })
  // CORS open to every site, unless only while developing
  for (const c of all(root, 'invocation_expression')) if (/\.AllowAnyOrigin$|SetIsOriginAllowed$/.test(fnText(c)) && (!/SetIsOriginAllowed$/.test(fnText(c)) || /=>\s*true/.test(c.text))) {
    let dev = false; for (let p = c.parent; p; p = p.parent) if (p.type === 'if_statement' && /IsDevelopment\s*\(/.test(p.childForFieldName('condition')?.text ?? '')) dev = true
    if (!dev) f.cs.risks.add('cors')
  }
  f.todos = [...text.matchAll(/\/\/\s*((TODO|FIXME|HACK)\b[^\n]*)/g)].map(m => m[1])

  // classes: their attributes, bases and actions (controllers are decided in plain.ts), DbSets, mapped properties, every method's facts
  for (const cls of all(root, 'class_declaration')) {
    const name = cls.childForFieldName('name')!.text, ca = attrs(cls)
    const bases = (cls.namedChildren.find(c => c?.type === 'base_list')?.namedChildren ?? []).map(b => b!.text.replace(/<.*$/, '').split('.').at(-1)!)
    const actions: CsClass['actions'] = []
    for (const m of all(cls, 'method_declaration')) {
      const ma = attrs(m), mname = m.childForFieldName('name')!.text
      f.cs.methods.set(`${name}.${mname}`, Object.assign(collect(m, empty(m.text)), { csAuth: authOf(ma) }))
      if (ma.some(a => attrName(a) === 'NonAction') || !/\bpublic\b/.test(m.namedChildren.filter(c => c?.type === 'modifier').map(c => c!.text).join(' '))) continue
      const mroute = ma.filter(a => attrName(a) === 'Route').map(attrArg).find(x => x !== undefined)
      const verbs = ma.filter(a => HTTP[attrName(a)])
      // [AcceptVerbs("GET", "POST")], or a bare [Route("purge")]: any method; read as POST if it changes data
      const any = !verbs.length && (mroute !== undefined || ma.some(a => attrName(a) === 'AcceptVerbs'))
      for (const a of verbs) actions.push({ name: mname, method: HTTP[attrName(a)], tpl: attrArg(a) ?? mroute, auth: authOf(ma) })
      if (any) actions.push({ name: mname, method: 'ANY', tpl: mroute, auth: authOf(ma) })
    }
    f.cs.classes.set(name, { bases, abstract: /\babstract\b/.test(cls.namedChildren.filter(c => c?.type === 'modifier').map(c => c!.text).join(' ')),
      api: ca.some(a => /^(ApiController|Controller)$/.test(attrName(a))), route: ca.filter(a => attrName(a) === 'Route').map(attrArg).find(x => x !== undefined), auth: authOf(ca), actions })
    // entities: mapped properties only (a setter, not static, not [NotMapped], not computed)
    const props: string[] = []
    for (const p of cls.childForFieldName('body')?.namedChildren.filter((x): x is N => x?.type === 'property_declaration') ?? []) {
      const type = p.childForFieldName('type')!, pn = p.childForFieldName('name')!.text
      const generic = type.type === 'generic_name' ? type : null
      if (generic && /^DbSet$/.test(generic.namedChildren[0]!.text)) { f.cs.dbsets.set(pn, generic.namedChildren[1]!.namedChildren[0]!.text); continue }
      const acc = p.namedChildren.find(c => c?.type === 'accessor_list')?.text ?? ''
      if (!/\b(set|init)\b/.test(acc) || /\bstatic\b/.test(p.namedChildren.filter(c => c?.type === 'modifier').map(c => c!.text).join(' ')) || attrs(p).some(a => attrName(a) === 'NotMapped')) continue
      if (generic || /\[\]$/.test(type.text)) continue   // List<Booking> Bookings: the other side of a link
      props.push(type.type === 'identifier' && /^[A-Z]/.test(type.text) && !/^(String|DateTime|DateTimeOffset|Guid|Decimal|TimeSpan|DateOnly|TimeOnly)$/.test(type.text) ? `→${type.text}` : pn)
    }
    if (props.length) f.cs.entities.set(name, props)
  }
  for (const m of all(root, 'local_function_statement')) f.cs.methods.set(m.childForFieldName('name')!.text, Object.assign(collect(m, empty(m.text)), { csAuth: authOf(attrs(m)) }))

  // minimal APIs. Group variables belong to the method they're declared in (two methods can each have their own `group`).
  const scopeOf = (n: N) => { for (let p = n.parent; p; p = p.parent) if (fnLike.test(p.type)) return p.startIndex; return -1 }
  const chainAuth = (call: N): Auth => {   // what follows the call: .RequireAuthorization() / .AllowAnonymous()
    const out: Auth[] = []
    for (let c: N = call; c.parent?.type === 'member_access_expression' && c.parent.parent?.type === 'invocation_expression'; c = c.parent.parent) {
      const n = c.parent.childForFieldName('name')?.text
      out.push(n === 'AllowAnonymous' ? 'anon' : n === 'RequireAuthorization' ? 'yes' : undefined)
    }
    return mergeAuth(...out)
  }
  // extension methods: MapOrders(this RouteGroupBuilder group) -- routes on `group` (or groups made from it) are relative to the caller
  const extOf = new Map<number, { name: string; param: string }>()
  for (const m of all(root, 'method_declaration')) {
    const p0 = m.childForFieldName('parameters')?.namedChildren.find(x => x?.type === 'parameter')
    if (p0 && /^this\b/.test(p0.text) && /RouteGroupBuilder|IEndpointRouteBuilder|WebApplication/.test(p0.text)) extOf.set(m.startIndex, { name: m.childForFieldName('name')!.text, param: p0.childForFieldName('name')!.text })
  }
  type G = { prefix: string; auth: Auth; ext?: string }   // ext: relative to the group an extension method is called on
  const decls: { name: string; scope: number; at: number; node: N }[] = []
  for (const d of all(root, 'variable_declarator')) decls.push({ name: d.namedChildren[0]!.text, scope: scopeOf(d), at: d.startIndex, node: d.namedChildren.at(-1)! })
  for (const a of all(root, 'assignment_expression')) { const l = a.childForFieldName('left'); if (l?.type === 'identifier') decls.push({ name: l.text, scope: scopeOf(a), at: a.startIndex, node: a.childForFieldName('right')! }) }
  // g.RequireAuthorization() / g.AllowAnonymous() as statements of their own: group conventions apply whatever the order
  const laterAuth = (name: string, scope: number) => mergeAuth(...all(root, 'invocation_expression').filter(c => scopeOf(c) === scope && new RegExp(`^${name}\\.(RequireAuthorization|AllowAnonymous)$`).test(fnText(c)) && c.parent?.type === 'expression_statement')
    .map(c => /AllowAnonymous$/.test(fnText(c)) ? 'anon' as const : 'yes' as const))
  const groupOf = (n: N | null | undefined, seen = 0): G => {
    if (!n || seen > 20) return { prefix: '', auth: undefined }
    if (n.type === 'identifier') {
      const scope = scopeOf(n), ext = extOf.get(scope)
      if (ext && n.text === ext.param) return { prefix: '', auth: undefined, ext: ext.name }
      const d = decls.filter(x => x.name === n.text && x.scope === scope && x.at < n.startIndex).sort((a, b) => b.at - a.at)[0]
      if (!d) return { prefix: '', auth: undefined }
      const g = groupOf(d.node, seen + 1); return { ...g, auth: mergeAuth(g.auth, laterAuth(n.text, scope)) }
    }
    if (n.type === 'invocation_expression') {
      const fn = n.childForFieldName('function'), name = fn?.type === 'member_access_expression' ? fn.childForFieldName('name')?.text : ''
      const up = () => groupOf(fn!.childForFieldName('expression'), seen + 1)
      if (name === 'MapGroup') { const u = up(); return { ...u, prefix: under(u.prefix, str(args(n)[0]) ?? ''), auth: mergeAuth(u.auth, chainAuth(n)) } }
      if (/^(RequireAuthorization|AllowAnonymous|WithTags|WithName|WithOpenApi|WithSummary|WithDescription|AddEndpointFilter\w*|RequireCors|DisableAntiforgery|RequireRateLimiting|CacheOutput)$/.test(name ?? '')) {
        const u = up(); return { ...u, auth: mergeAuth(u.auth, name === 'AllowAnonymous' ? 'anon' : name === 'RequireAuthorization' ? 'yes' : undefined) }
      }
    }
    return { prefix: '', auth: undefined }
  }
  const lambdaAuth = (h: N) => authOf(h.namedChildren.filter((c): c is N => c?.type === 'attribute_list').flatMap(l => l.namedChildren.filter((a): a is N => a?.type === 'attribute')))
  const push = (g: G, r: CsRoute, where: N) => {
    const ext = g.ext && extOf.get(scopeOf(where))
    if (g.ext && ext) { const e = f.cs.ext.get(ext.name) ?? { routes: [], calls: [] }; e.routes.push(r); f.cs.ext.set(ext.name, e) }
    else f.cs.routes.push(r)
  }
  for (const call of all(root, 'invocation_expression')) {
    const fn = call.childForFieldName('function'), a = args(call)
    if (fn?.type !== 'member_access_expression') continue
    const name = fn.childForFieldName('name')!.text, recv = fn.childForFieldName('expression')!
    // MapGet / MapPost / ... ; MapMethods("/x", new[] { "GET", "POST" }, h); Map("/x", h) answers every method
    const verb = name.match(/^Map(Get|Post|Put|Patch|Delete)$/)?.[1]?.toUpperCase()
    const methods = verb ? [verb] : name === 'MapMethods' ? [...(a[1]?.text.matchAll(/"(\w+)"/g) ?? [])].map(m => m[1].toUpperCase()) : name === 'Map' && str(a[0]) !== undefined && a.length === 2 ? ['ANY'] : []
    if (methods.length) {
      const route = str(a[0]), h = a.at(-1)
      if (route === undefined || !h) continue
      const g = groupOf(recv), lambda = /lambda|anonymous_method/.test(h.type)
      for (const method of methods) push(g, { method, path: csPath(under(g.prefix, route)), auth: mergeAuth(g.auth, chainAuth(call), lambda ? lambdaAuth(h) : undefined), controller: false,
        facts: lambda ? collect(h, empty(h.text)) : undefined, handler: lambda ? undefined : h.text }, call)
      continue
    }
    // group-filling extension calls: app.MapGroup("/orders").MapOrders(config), OrderEndpoints.MapOrders(app)
    if (/^Map[A-Z]\w*$/.test(name) && !/^Map(Group|Get|Post|Put|Patch|Delete|Methods|Controllers|ControllerRoute|RazorPages|Hub|Fallback\w*|HealthChecks|OpenApi|Identity\w*|Static\w*|DefaultControllerRoute|Blazor\w*|RazorComponents|Grpc\w*)$/.test(name)) {
      const statik = /^[A-Z]/.test(recv.text) && !!a[0]
      const g = statik ? groupOf(a[0]) : groupOf(recv), c: ExtCall = { name, prefix: g.prefix, auth: mergeAuth(g.auth, chainAuth(call)) }
      const inExt = g.ext && extOf.get(scopeOf(call))
      if (inExt) { const e = f.cs.ext.get(inExt.name) ?? { routes: [], calls: [] }; e.calls.push(c); f.cs.ext.set(inExt.name, e) } else f.cs.extCalls.push(c)
    }
  }
  ;(f as FileFacts & { parseError?: boolean }).parseError = tree.rootNode.hasError   // (see the cut-off file check in plain.ts)
  tree.delete()   // trees live in WebAssembly memory, which JavaScript never frees: a big repo filled it and the parser aborted
  return f

  // Facts from one subtree: Entity Framework, Stripe, email, config, "no" messages, login checks in code.
  function collect(node: N, g: FileFacts): FileFacts {
    const vars = new Map<string, string>()   // var order = await _db.Orders.FindAsync(id) -> order: Orders
    const userVars = new Set<string>()       // var userId = User.FindFirstValue(ClaimTypes.NameIdentifier): who's logged in
    const stripe = new Map<string, string>()  // var service = new SessionService() -> service: SessionService (Stripe.net)
    for (const d of all(node, 'variable_declarator')) {
      const v = d.namedChildren.at(-1)?.text ?? '', id = d.namedChildren[0]!.text
      const m = v.match(/\b(\w+)\.(\w+)\s*\.\s*(Find|First|Single|Where|Include|AsTracking)\w*/); if (m && DB.test(m[1])) vars.set(id, m[2])
      if (/\bUser\.(FindFirst|Identity|Claims|GetUserId)|ClaimTypes\.|GetUserId\(/.test(v)) userVars.add(id)
      const st = v.match(/^new\s+(?:[\w.]+\.)?(SessionService|PaymentIntentService|ChargeService|RefundService|SubscriptionService)\b/)?.[1]; if (st) stripe.set(id, st)
    }
    for (const call of all(node, 'invocation_expression')) {
      const fn = fnText(call).replace(/\.Set<(\w+)>\(\)/, '.$1'), parts = fn.split('.'), last = parts.at(-1)!, a0 = args(call)[0]   // _context.Set<Order>().Add -> _context.Order.Add
      g.used.add(last)
      // _db.Orders.Add(order), _db.Orders.Remove(o), _db.Orders.Where(...).ExecuteDeleteAsync(), _db.Orders.FindAsync(id)
      const set = DB.test(parts[0]) && parts.length >= 3 && /^[A-Z]/.test(parts[1]) ? parts[1].replace(/\(.*$/, '') : undefined
      if (set) { g.tables.add(set); if (EF_WRITE[last]) { g.written.add(set); g.writes = true; g.ops.add(EF_WRITE[last]) } }
      else if (DB.test(parts[0]) && parts.length === 2 && /^(Add|AddAsync|Remove|Update)$/.test(last) && a0) {   // _db.Add(order)
        const t = a0.text.match(/^new\s+(\w+)/)?.[1] ?? vars.get(a0.text); if (t) { g.tables.add(t); g.written.add(t) } g.writes = true; g.ops.add(EF_WRITE[last])
      }
      // order.Status = "Cancelled"; await _db.SaveChangesAsync(): an update of what was loaded
      if (/^SaveChanges(Async)?$/.test(last) && DB.test(parts[0]) && !g.ops.size) {
        for (const as of all(node, 'assignment_expression')) { const l = as.childForFieldName('left')?.text.split('.')[0] ?? ''; const t = vars.get(l); if (t) { g.tables.add(t); g.written.add(t); g.writes = true; g.ops.add('update') } }
      }
      // Stripe.net: new SessionService().CreateAsync(options); EventUtility.ConstructEvent(...); new RefundService().CreateAsync(...)
      // which Stripe service this Create is on: new SessionService().CreateAsync(...), or a variable holding one
      const recv = call.childForFieldName('function')?.childForFieldName('expression')?.text.replace(/\s/g, '') ?? ''
      const svc = recv.match(/^new(?:[\w.]+\.)?(\w+Service)\(/)?.[1] ?? stripe.get(recv)
      if (/^Create(Async)?$/.test(last) && svc === 'SessionService') { g.money = true; g.services.add('Stripe'); g.outside.add('Stripe: checkout.sessions.create') }
      if (/^Create(Async)?$/.test(last) && /^(PaymentIntentService|ChargeService|SubscriptionService)$/.test(svc ?? '')) { g.money = true; g.services.add('Stripe') }
      if (/^Create(Async)?$/.test(last) && svc === 'RefundService') { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
      if (/ConstructEvent$/.test(fn)) { g.services.add('Stripe'); g.outside.add('Stripe: webhooks.constructEvent') }
      if (/^SendEmailAsync$|^EmailSendAsync$/.test(last) || /^Send(Async)?$/.test(last) && /SmtpClient|MailKit/.test(node.text)) { g.services.add('email'); g.outside.add('email: send') }
      // config: Configuration["Stripe:SecretKey"] is read from the env var Stripe__SecretKey; GetConnectionString("Default") from ConnectionStrings__Default
      if (/GetConnectionString$/.test(fn) && str(a0)) g.env.add(`ConnectionStrings__${str(a0)}`)
      if (/GetEnvironmentVariable$/.test(fn) && str(a0)) { g.env.add(str(a0)!); g.envReq.add(str(a0)!) }
      if (/(^|\.)GetValue(<[^>]*>)?$/.test(fn) && str(a0)) g.env.add(str(a0)!.replace(/:/g, '__'))
      // "no" messages: BadRequest("..."), Conflict("..."), Results.BadRequest("..."), Problem("...")
      if (/^(BadRequest|Conflict|UnprocessableEntity|Problem|ValidationProblem)$/.test(last) && str(a0)) g.refuses.add(str(a0)!)
    }
    for (const e of all(node, 'element_access_expression')) {   // Configuration["Stripe:SecretKey"]
      const k = str(e.namedChildren.at(-1)?.namedChildren[0]?.namedChildren.at(-1)), obj = e.namedChildren[0]?.text ?? ''
      // (with a fallback, config["Email:FromName"] ?? "FixIt", it's optional)
      // (not ?? "" / string.Empty / null / throw: an empty webhook secret fails every check)
      const rest = e.parent?.type === 'binary_expression' && e.parent.namedChildren[0]?.startIndex === e.startIndex ? e.parent.text.slice(e.text.length).replace(/^\s*\?\?\s*/, '') : undefined
      const optional = rest !== undefined && rest !== e.parent!.text.slice(e.text.length) && !/^(string\.Empty|""|null|throw\b|default\b)/.test(rest)
      if (k && /config|Configuration/i.test(obj) && /^[A-Za-z][\w:]*$/.test(k)) { g.env.add(k.replace(/:/g, '__')); if (!optional) g.envReq.add(k.replace(/:/g, '__')) }
    }
    // a login check in the handler: if (!User.Identity?.IsAuthenticated ?? true) return Unauthorized(); if (userId is null) return Challenge();
    // (userId read from the logged-in user's claims, not from the request body)
    for (const i of all(node, 'if_statement')) {
      const cond = i.childForFieldName('condition')?.text ?? '', then = i.childForFieldName('consequence')?.text ?? ''
      const aboutUser = /IsAuthenticated/.test(cond) || [...userVars].some(v => new RegExp(`\\b${v}\\b`).test(cond))
      if (aboutUser && /!|null|false|IsNullOrEmpty/.test(cond) && /\b(Unauthorized|Challenge|Forbid)\s*\(/.test(then)) { g.authStop = true; g.authIfs.push({ g: '', at: i.startIndex, fn: 0 }) }
    }
    g.emptyCatch += all(node, 'catch_clause').filter(c => /^\{\s*\}$/.test(c.namedChildren.at(-1)?.text ?? '')).length
    return g
  }
}
