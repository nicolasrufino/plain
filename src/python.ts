// Python (FastAPI, Flask; SQLAlchemy, SQLModel, Django ORM): the same facts plain.ts reads from TypeScript.
// Parsed with tree-sitter (WebAssembly, grammar in vendor/), not the user's python3: that one can be missing or older
// than the code, and Python's own parser gives up on a whole file at the first syntax error.
// Django: urls.py (path/re_path/include, DRF routers) and the views they point to. plain.ts walks the includes.
import type { FileFacts } from './plain.ts'

type N = import('web-tree-sitter').Node
import { parserFor } from './treesitter.ts'
const parser = await parserFor('tree-sitter-python.wasm')   // null when web-tree-sitter isn't installed: Python files are skipped

// servers: routers/apps/blueprints made in this file; aliases: CurrentUser = Annotated[User, Depends(get_current_user)]
export type PyFacts = FileFacts & { models: Map<string, string[]>; risks: Set<string>; servers: Map<string, { prefix: string; guard: boolean }>
  aliases: Map<string, boolean>; appGuard: boolean; dj: Dj }
// Django. A view's routes are relative to where urls.py puts it: '' for a plain view, '/[pk]' and '/[pk]/pay' for a DRF viewset.
// guard: true / false / 'writes' (only changes need login) / undefined (DRF view without its own: the settings decide).
export type DjRoute = { sub: string; method: string; facts: FileFacts; guard?: boolean | 'writes'; open: boolean; drf: boolean; act?: string }
export type DjDef = { name: string; facts: FileFacts; guard: boolean; act?: { sub: string; methods: string[]; pc?: string } }
export type DjClass = { bases: string[]; pc?: string; getPerms?: string; model?: string; lookup?: string; http?: string[]; md: Set<string>; open: boolean; defs: DjDef[]; rest: FileFacts }
type DjRef = { view: string; guard: boolean; actions?: Record<string, string>; pc?: string }   // pc: as_view(permission_classes=[...]) overrides the class's
export type Dj = { urls: ({ path: string; include?: string } & Partial<DjRef> & { guard: boolean })[]; routers: Map<string, { prefix: string; view: string }[]>
  views: Map<string, DjRoute[]>; classes: Map<string, DjClass>; aliases: Map<string, DjRef>; stars: string[]; drf?: boolean | 'writes'; loginMw: boolean; emailBackend?: string; emailHost?: string }

const str = (n?: N | null) => n?.type === 'string' && !n.namedChildren.some(c => c?.type === 'interpolation')
  ? n.namedChildren.filter(c => c?.type === 'string_content').map(c => c!.text).join('') : undefined
// a node's text without its # comments: a commented-out IsAuthenticated or raise checks nothing
const code = (n?: N | null) => { if (!n) return ''; let t = n.text; for (const c of n.descendantsOfType('comment').reverse()) if (c) t = t.slice(0, c.startIndex - n.startIndex) + t.slice(c.endIndex - n.startIndex); return t }
const fString = (n?: N | null) => n?.type === 'string' && n.namedChildren.some(c => c?.type === 'interpolation')
const args = (call: N) => call.childForFieldName('arguments')?.namedChildren.filter((c): c is N => !!c && c.type !== 'comment') ?? []
const kw = (call: N, name: string) => args(call).find(a => a.type === 'keyword_argument' && a.childForFieldName('name')?.text === name)?.childForFieldName('value') ?? undefined
const pos = (call: N) => args(call).filter(a => a.type !== 'keyword_argument')
const fnName = (call: N) => call.childForFieldName('function')?.text ?? ''
const all = (n: N, type: string) => n.descendantsOfType(type).filter((x): x is N => !!x)
const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s
// order_item -> OrderItem; db_item / new_user -> Item / User; self, x -> nothing
const modelOf = (v: string) => /^(self|cls|obj|x|_)$/.test(v) || v.length < 2 ? '' : cap(v.replace(/^(db|new|created|updated|the)_/, '').replace(/_(\w)/g, (_, c) => c.toUpperCase()).replace(/s$/, ''))

const HTTP = /^(get|post|put|patch|delete)$/
// What checks who you are. Decorators: login_required, jwt_required(), admin_required, roles_required, permission_required.
// FastAPI dependencies, by the function inside Depends(...): get_current_user, require_admin, verify_token; not get_admin_service,
// AuthService, or get_current_user_optional (lets everyone through).
const GUARD_DECO = /^(login_required|jwt_required|fresh_jwt_required|admin_required|roles?_required|permission_required|staff_member_required|superuser_required|user_passes_test|auth_required|requires_auth|token_required)$/
const GUARD_DEP = /^(get_)?current_(active_)?(user|admin|superuser)$|^(require|verify|check)_\w+|^(get_)?(admin|authenticated)_user$|^(is_)?(admin|authenticated|logged_in)$|^auth(enticate)?(_user)?$|login_required/i
const depGuard = (text: string) => [...text.matchAll(/\b(?:Depends|Security)\(\s*([\w.]+)/g)].some(m => { const fn = m[1].split('.').at(-1)!; return GUARD_DEP.test(fn) && !/optional|_or_none|maybe/i.test(fn) })
const SERVICES: Record<string, string> = { stripe: 'Stripe', openai: 'OpenAI', anthropic: 'Anthropic', resend: 'Resend', twilio: 'Twilio',
  boto3: 'AWS', supabase: 'Supabase', sendgrid: 'SendGrid', postmarker: 'Postmark' }
const HOSTS: Record<string, string> = { 'api.resend.com': 'Resend', 'api.stripe.com': 'Stripe', 'api.openai.com': 'OpenAI', 'api.anthropic.com': 'Anthropic',
  'api.sendgrid.com': 'SendGrid', 'api.twilio.com': 'Twilio' }
// Django and DRF class views: the methods they answer without writing them, and what each does to the model.
// CreateView and FormView also answer GET, but only to show the empty form.
const GENERIC: Record<string, string> = { View: '', APIView: '', TemplateView: 'GET', ListView: 'GET', DetailView: 'GET', RedirectView: 'GET', FormView: 'POST',
  CreateView: 'POST:create', UpdateView: 'GET POST:update', DeleteView: 'GET POST:delete',
  ListAPIView: 'GET', RetrieveAPIView: 'GET', CreateAPIView: 'POST:create', UpdateAPIView: 'PUT:update PATCH:update', DestroyAPIView: 'DELETE:delete',
  ListCreateAPIView: 'GET POST:create', RetrieveUpdateAPIView: 'GET PUT:update PATCH:update', RetrieveDestroyAPIView: 'GET DELETE:delete',
  RetrieveUpdateDestroyAPIView: 'GET PUT:update PATCH:update DELETE:delete' }
// DRF viewsets: action -> address and method (the router adds /[pk] for one item)
const ACTIONS: Record<string, [string, string, string?]> = { list: ['', 'GET'], create: ['', 'POST', 'create'], retrieve: ['/[pk]', 'GET'],
  update: ['/[pk]', 'PUT', 'update'], partial_update: ['/[pk]', 'PATCH', 'update'], destroy: ['/[pk]', 'DELETE', 'delete'] }
const VIEWSETS: Record<string, string> = { ModelViewSet: 'list create retrieve update partial_update destroy', ReadOnlyModelViewSet: 'list retrieve',
  ListModelMixin: 'list', CreateModelMixin: 'create', RetrieveModelMixin: 'retrieve', UpdateModelMixin: 'update partial_update', DestroyModelMixin: 'destroy' }
const LOGIN_MIXIN = /^(LoginRequired|PermissionRequired|UserPassesTest|StaffRequired|SuperuserRequired|AdminRequired)Mixin$/
// DRF permission classes, which all have to pass (A | B: either one; ~A: not A). AllowAny and an empty list check nothing; *OrReadOnly checks only changes.
// ponytail: custom classes count by name (IsAuthenticated..., IsAdmin..., IsStaff...); IsOwner alone isn't a login check: anyone can still create,
// and IsAuthenticatedOrCreate lets anyone in for something
const RANK = [false, 'writes', true] as const
const guards = (n: string) => /^(Is)?(Authenticated|Admin|Staff|Superuser|LoggedIn)|^DjangoModelPermissions$|^DjangoObjectPermissions$/.test(n)
const rank = (n: string) => guards(n) && (!/Or[A-Z]/.test(n) || n.split(/Or(?=[A-Z])/).every(guards)) ? 2 : /Or(Anon)?ReadOnly$/.test(n) && guards(n.replace(/Or(Anon)?ReadOnly$/, '')) ? 1 : 0
const names = (t: string) => (t.match(/\b[A-Z]\w*/g) ?? []).map(rank)
export const perm = (t: string): boolean | 'writes' => RANK[Math.max(0, ...t.replace(/^\s*[\[(]|[\])]\s*$/g, '').split(',')
  .map(e => Math.min(...e.split('|').map(alt => alt.includes('~') ? 0 : Math.max(0, ...names(alt))))))]
// get_permissions(): which branch a route takes. `if self.action in ('list', 'retrieve'): return [AllowAny()]` (or sets self.permission_classes),
// `if self.request.method in SAFE_METHODS: ...`, a permission_classes_by_action map, then the last return. super().get_permissions() means permission_classes.
// ponytail: one condition per branch; a branch on anything else (the user, a flag, a list held in a variable) is skipped
const flat = (t: string) => { let d = 0, o = ''; for (const ch of t) { d += '([{'.includes(ch) ? 1 : ')]}'.includes(ch) ? -1 : 0; o += ch === '\n' && d > 0 ? ' ' : ch } return o }   // black's wrapped lines
const permFor = (raw: string, pc?: string) => (act: string, method: string): boolean | 'writes' | undefined => {
  const body = flat(raw)
  const ret = (x: string) => /super\(\)\.get_permissions|\bself\.permission_classes\b/.test(x) || !/\b[A-Z]\w*|^\s*\[\s*\]/.test(x) ? (pc ? perm(pc) : undefined) : perm(x)   // a variable: what it started as
  const byAction = /_by_action\b/.test(body) && body.match(new RegExp(`['"]${act}['"]\\s*:\\s*([\\[(][^\\])]*[\\])])`))
  if (byAction) return perm(byAction[1])
  for (const [, cond, x] of body.matchAll(/\b(?:el)?if\s+([^\n]+?):\s*\n?\s*(?:return\s+|self\.permission_classes\s*=\s*)([^\n]+)/g)) {
    if (/\b(and|or)\b/.test(cond)) continue   // two conditions at once: skipped (the last return decides; never a false ✓ for reads)
    const not = /\bnot\s+in\b|!=|^\s*not\b/.test(cond), named = /['"]/.test(cond)
    const hit = /self\.action\b/.test(cond) ? (named ? new RegExp(`['"]${act}['"]`).test(cond) : undefined)
      : /SAFE_METHODS/.test(cond) ? method === 'GET' : /\.method\b/.test(cond) && named ? new RegExp(`['"]${method}['"]`).test(cond) : undefined
    if (hit !== undefined && hit !== not) return ret(x)
  }
  const last = [...body.matchAll(/^\s*return\s+([^\n]+)/gm)].at(-1)
  return last ? ret(last[1]) : pc ? perm(pc) : undefined
}
// A class view's routes, from the class and the base classes plain.ts found for it (own class first). names: every base class name in the chain.
export function djClassRoutes(chain: DjClass[], bases: string[], empty: () => FileFacts): DjRoute[] {
  const first = <K extends keyof DjClass>(k: K) => chain.map(c => c[k]).find(v => v !== undefined)
  const drf = bases.some(b => /APIView$|ViewSet$/.test(b) || b in VIEWSETS), viewset = bases.some(b => /ViewSet$/.test(b))
  const pc = first('pc'), gp = first('getPerms'), model = first('model'), lookup = first('lookup') ?? 'pk', http = first('http')
  const md = new Set(chain.flatMap(c => [...c.md])), open = chain.some(c => c.open)
  // a login mixin only counts left of the view class it guards: class Wipe(View, LoginRequiredMixin) never runs it
  const firstView = bases.findIndex(b => b in GENERIC || b in VIEWSETS || /View$|ViewSet$|APIView$/.test(b))
  const login = bases.some((b, i) => LOGIN_MIXIN.test(b) && (firstView < 0 || i < firstView)) || md.has('dispatch')
  const classGuard = (act: string, method: string) => login ? true : gp !== undefined ? permFor(gp, pc)(act, method) : pc !== undefined ? perm(pc) : drf ? undefined : false
  const defs = new Map<string, DjDef>()
  for (const c of [...chain].reverse()) for (const d of c.defs) defs.set(d.name, d)   // the class's own methods win over its bases'
  const rest = empty()
  for (const c of chain) for (const k of ['tables', 'written', 'ops', 'outside', 'env', 'envReq', 'services', 'refuses'] as const) for (const x of c.rest[k]) rest[k].add(x)
  rest.money = chain.some(c => c.rest.money)
  const inherited = (op?: string) => { const g = empty(); for (const k of ['tables', 'written', 'ops', 'outside', 'env', 'envReq', 'services', 'refuses'] as const) for (const x of rest[k]) g[k].add(x)
    g.money = rest.money; if (model) { g.tables.add(model); if (op) { g.written.add(model); g.writes = true; g.ops.add(op) } } return g }
  const routes: DjRoute[] = []
  const add = (sub: string, method: string, facts: FileFacts, act: string, own = false) =>
    routes.push({ sub, method, facts, act, open, drf, guard: own || md.has(method.toLowerCase()) ? true : classGuard(act, method) })
  for (const b of bases) {
    for (const m of (GENERIC[b] ?? '').split(' ').filter(Boolean)) { const [method, op] = m.split(':'); if (!defs.has(method.toLowerCase())) add('', method, inherited(op), method.toLowerCase()) }
    for (const a of (VIEWSETS[b] ?? '').split(' ').filter(Boolean)) if (!defs.has(a)) { const [sub, method, op] = ACTIONS[a]; add(sub, method, inherited(op), a) }
  }
  for (const d of defs.values()) {
    if (/^(get|post|put|patch|delete)$/.test(d.name)) add('', d.name.toUpperCase(), d.facts, d.name, d.guard)
    else if (ACTIONS[d.name] && viewset) add(ACTIONS[d.name][0], ACTIONS[d.name][1], d.facts, d.name, d.guard)
    if (d.act) for (const m of d.act.methods) routes.push({ sub: d.act.sub, method: m, facts: d.facts, act: d.name, open, drf,
      guard: d.guard || md.has(d.name) ? true : d.act.pc ? perm(d.act.pc) : classGuard(d.name, m) })
  }
  const seen = new Set<string>()
  return routes.filter(r => (!http || http.includes(r.method)) && !seen.has(r.sub + r.method + r.act) && seen.add(r.sub + r.method + r.act))
    .map(r => ({ ...r, sub: r.sub.replace('[pk]', `[${lookup}]`) }))
}
const DJANGO_OPS: Record<string, string> = { create: 'create', get_or_create: 'create', update_or_create: 'create', bulk_create: 'create', update: 'update', bulk_update: 'update', delete: 'delete',
  acreate: 'create', aget_or_create: 'create', aupdate_or_create: 'create', abulk_create: 'create', aupdate: 'update', abulk_update: 'update', adelete: 'delete' }   // async versions

export function pyFacts(path: string, text: string, empty: (printed?: string) => FileFacts): PyFacts | undefined {
  if (!parser) return undefined
  const tree = parser.parse(text)
  if (!tree) return undefined
  const root = tree.rootNode
  const f: PyFacts = Object.assign(collect(root, empty(text.replace(/#[^\n]*/g, '').replace(/\s+/g, ' '))),
    { models: new Map<string, string[]>(), risks: new Set<string>(), servers: new Map(), aliases: new Map<string, boolean>(), appGuard: false,
      dj: { urls: [], routers: new Map(), views: new Map(), classes: new Map(), aliases: new Map(), stars: [], loginMw: false } as Dj })
  f.todos = all(root, 'comment').map(c => c.text.match(/#\s*((TODO|FIXME|HACK)\b.*)/)?.[1]).filter((t): t is string => !!t)

  // imports: from .routers import orders; from app.db import SessionLocal as S; import stripe
  for (const imp of [...all(root, 'import_from_statement'), ...all(root, 'import_statement')]) {
    const mod = imp.childForFieldName('module_name')?.text
    for (const n of imp.childrenForFieldName('name').filter((x): x is N => !!x)) {
      const name = n.type === 'aliased_import' ? n.childForFieldName('name')!.text : n.text, local = n.type === 'aliased_import' ? n.childForFieldName('alias')!.text : name.split('.')[0]
      const full = mod ? `${mod}${mod.endsWith('.') ? '' : '.'}${name}` : name
      f.imports.push(`py:${mod ?? name}`); f.binds.set(local, `py:${mod && !mod.endsWith('.') ? full : mod ? mod + name : name}`)
      f.used.add(name); f.used.add(local)
      const top = (mod ?? name).replace(/^\.+/, '').split('.')[0]
      if (SERVICES[top]) f.services.add(SERVICES[top])
    }
  }

  // servers and routers: app = FastAPI(); router = APIRouter(prefix='/orders', dependencies=[Depends(get_current_user)]); bp = Blueprint('x', __name__, url_prefix='/x')
  const servers = f.servers
  for (const a of all(root, 'assignment')) {
    const left = a.childForFieldName('left')?.text ?? '', right = a.childForFieldName('right')
    if (right?.type !== 'call') continue
    const fn = fnName(right)
    if (/^(FastAPI|APIRouter|Flask|Blueprint)$/.test(fn.split('.').at(-1)!))
      servers.set(left, { prefix: str(kw(right, 'prefix') ?? kw(right, 'url_prefix')) ?? '', guard: depGuard(kw(right, 'dependencies')?.text ?? '') })
    // CurrentUser = Annotated[User, Depends(get_current_user)]: a parameter typed CurrentUser is a login check
    if (/^[A-Z]\w*$/.test(left) && /^Annotated\[/.test(right?.text ?? '')) f.aliases.set(left, depGuard(right!.text))
  }
  for (const a of all(root, 'assignment')) {   // the same, written as a type alias without a call
    const left = a.childForFieldName('left')?.text ?? '', right = a.childForFieldName('right')
    if (/^[A-Z]\w*$/.test(left) && right?.type === 'subscript' && /^Annotated\[/.test(right.text)) f.aliases.set(left, depGuard(right.text))
  }
  // @bp.before_request that turns logged-out people away: everything in that blueprint (before_app_request: the whole app) needs login
  const turnsAway = (body: N) => all(body, 'if_statement').some(i => {
    const cond = code(i.childForFieldName('condition')), then = code(i.childForFieldName('consequence'))
    return /current_user|is_authenticated|request\.user|session\.get\(|session\[|g\.user|\buser\b/.test(cond)
      && /abort\(\s*40[13]|raise\s+\w*(HTTPException|Unauthori[sz]ed|Forbidden|PermissionDenied|NotAuthenticated)|status(_code)?\s*=\s*(status\.HTTP_)?40[13]|HttpResponse(Forbidden|NotAllowed)\(|redirect\([^)]*login|redirect_to_login\(|url_for\(\s*['"][\w.]*login/.test(then)
  })
  const decorated = all(root, 'decorated_definition').map(d => ({ def: d.childForFieldName('definition')!,
    decos: d.namedChildren.filter((c): c is N => c?.type === 'decorator').map(c => c.namedChildren[0]!) }))
  for (const { def, decos } of decorated) for (const x of decos) {
    const m = x.text.match(/^(\w+)\.before_(app_)?request$/)
    if (m && turnsAway(def)) { if (m[2]) f.appGuard = true; else if (servers.has(m[1])) servers.get(m[1])!.guard = true }
  }
  // routes: @router.post('/{id}'), @app.route('/x', methods=['POST']), @app.api_route('/x', methods=[...]); also on an imported app or blueprint
  for (const { def, decos } of decorated) {
    if (def.type !== 'function_definition') continue
    const params = def.childForFieldName('parameters')?.namedChildren.filter((x): x is N => !!x) ?? []
    for (const [i, x] of decos.entries()) {
      if (x.type !== 'call') continue
      const fn = fnName(x), obj = fn.split('.').slice(0, -1).join('.'), last = fn.split('.').at(-1)!, path = str(pos(x)[0])
      const imported = !servers.has(obj) && f.binds.has(obj)
      if (path === undefined || !/^(route|api_route|get|post|put|patch|delete)$/.test(last) || !servers.has(obj) && !imported) continue
      const methods = HTTP.test(last) ? [last.toUpperCase()]
        : (kw(x, 'methods')?.namedChildren.map(m => str(m!)?.toUpperCase()).filter((m): m is string => !!m) ?? ['GET'])
      // Flask only applies decorators written *below* the route decorator
      const guard = decos.slice(i + 1).some(d => GUARD_DECO.test(d.text.split('(')[0].split('.').at(-1)!))
        || depGuard(kw(x, 'dependencies')?.text ?? '') || params.some(q => depGuard(q.text)) || turnsAway(def)
      // parameters typed with an alias (current_user: CurrentUser) are checked against aliases from every file
      const mw = params.map(q => q.childForFieldName('type')?.text.match(/^\w+$/)?.[0]).filter((t): t is string => !!t)
      const facts = collect(def, empty(def.text))
      // FastAPI {id} and Flask <int:id> become [id]
      const url = path.replace(/\{(\w+)(:[^}]*)?\}/g, '[$1]').replace(/<(?:\w+:)?(\w+)>/g, '[$1]')
      for (const m of methods) f.handlers.push({ server: obj, method: m, path: url, guard: guard || !!servers.get(obj)?.guard, mw, facts, own: servers.get(obj)?.prefix, imported })
    }
  }
  // app.include_router(orders.router, prefix='/api', dependencies=[...]); app.register_blueprint(bp, url_prefix='/x')
  // A register_blueprint url_prefix replaces the blueprint's own; an include_router prefix adds to the router's.
  for (const c of all(root, 'call')) {
    const fn = fnName(c), last = fn.split('.').at(-1)!, parent = fn.split('.').slice(0, -1).join('.')
    if (!/^(include_router|register_blueprint)$/.test(last) || !servers.has(parent) && !f.binds.has(parent)) continue
    const t = pos(c)[0]?.text ?? '', [target, attr] = t.includes('.') ? [t.split('.')[0], t.split('.').slice(1).join('.')] : [t, t]
    const given = kw(c, 'prefix') ?? kw(c, 'url_prefix')
    if (target) f.mounts.push({ server: parent, path: str(given) ?? '', target, attr, guard: depGuard(kw(c, 'dependencies')?.text ?? ''), guardLike: false,
      override: last === 'register_blueprint' && !!given })
  }
  // Mounted in the same file: fold the mount into the routes right away
  for (let i = 0; i < 5; i++) for (const m of f.mounts.filter(m => servers.has(m.target) && m.target === m.attr)) {
    for (const h of f.handlers) if (h.server === m.target) {
      h.path = m.path.replace(/\/$/, '') + (m.override ? '' : (h.own ?? '').replace(/\/$/, '')) + h.path
      h.guard ||= m.guard || !!servers.get(m.server)?.guard; h.server = m.server; h.own = servers.get(m.server)?.prefix
    }
    f.mounts.splice(f.mounts.indexOf(m), 1)
  }

  django(root, f, decorated, turnsAway)

  // models: class Order(db.Model) / (Base) / (SQLModel, table=True) / (models.Model)
  for (const cls of all(root, 'class_definition')) {
    const sup = cls.childForFieldName('superclasses')?.text ?? ''
    if (!/\b(db\.Model|models\.Model|Base|DeclarativeBase)\b|table\s*=\s*True/.test(sup)) continue   // not BaseModel (pydantic)
    // (class Base(DeclarativeBase): the base every model builds on, and `__abstract__ = True` mixins: not tables)
    if (/^\(\s*(?:(?:AsyncAttrs|MappedAsDataclass)\s*,\s*)*DeclarativeBase(?:NoMeta)?(?:\s*,\s*(?:AsyncAttrs|MappedAsDataclass))*\s*\)$/.test(sup) || /^\s*__abstract__\s*=\s*True/m.test(cls.childForFieldName('body')?.text ?? '')) continue
    const fields: string[] = []
    for (const st of cls.childForFieldName('body')?.namedChildren ?? []) {
      const a = st?.type === 'expression_statement' ? st.namedChildren[0] : undefined
      if (a?.type !== 'assignment') continue
      const name = a.childForFieldName('left')?.text ?? '', val = a.childForFieldName('right')?.text ?? a.childForFieldName('type')?.text ?? ''
      if (!/^[a-z]\w*$/.test(name)) continue
      const rel = val.match(/(?:ForeignKey|OneToOneField|relationship)\(\s*['"]?(\w+)/)?.[1]
      if (rel && /^[A-Z]/.test(rel)) fields.push(/ManyToMany|list\[|List\[|uselist=True/.test(val) ? `→${rel}[]` : `→${rel}`)
      else if (!/relationship\(|ManyToManyField/.test(val)) fields.push(name)
    }
    f.models.set(cls.childForFieldName('name')!.text, fields)
  }

  // the mistakes AI makes most in Python apps (Bandit / Semgrep rules)
  for (const a of all(root, 'assignment')) {
    const left = a.childForFieldName('left')?.text ?? '', right = a.childForFieldName('right')
    // module level only: DEBUG = True inside class DevelopmentConfig is the dev setting, not the live one
    const top = a.parent?.parent?.type === 'module' && !/(^|\/)(dev|development|local|test)\w*\.py$|settings\/(dev|local|test)/.test(path)
    if (/^DEBUG$/.test(left) && right?.text === 'True' && top) f.risks.add('debug')
    if (/^(SECRET_KEY|app\.secret_key|app\.config\[['"]SECRET_KEY['"]\])$/.test(left) && str(right)) f.risks.add('secret')
    if (/^CORS_(ALLOW_ALL_ORIGINS|ORIGIN_ALLOW_ALL)$/.test(left) && right?.text === 'True') f.risks.add('cors')
  }
  for (const c of all(root, 'call')) {
    const fn = fnName(c)
    if (/\.run$/.test(fn) && kw(c, 'debug')?.text === 'True') f.risks.add('debug')
    if (fn === 'CORS' && !kw(c, 'origins') && !kw(c, 'resources')) f.risks.add('cors')
    if (/(^|\.)add_middleware$/.test(fn) && /CORSMiddleware/.test(c.text) && /allow_origins\s*=\s*\[\s*['"]\*['"]/.test(c.text)) f.risks.add('cors')
    if (/(^|\.)(execute|executescript|raw|extra)$|^(sqlalchemy\.|sa\.)?text$/.test(fn) && (fString(pos(c)[0]) || /^(binary_operator)$/.test(pos(c)[0]?.type ?? '') && /['"]/.test(pos(c)[0]!.text))) f.risks.add('sql')
  }
  // a webhook that checks its signature (Stripe, GitHub, ...) is exempt on purpose: other sites can't fake that
  if (decorated.some(({ def, decos }) => decos.some(d => /^(csrf_exempt|csrf\.exempt)$/.test(d.text)) && !/construct_event\(|verify_signature\(|compare_digest\(|\bhmac\./.test(code(def)))) f.risks.add('csrf')

  // top-level functions, for "deleted but still used" and handlers named elsewhere
  for (const def of root.namedChildren) {
    const fn = def?.type === 'decorated_definition' ? def.childForFieldName('definition') : def
    if (fn?.type === 'function_definition') { f.fns.set(fn.childForFieldName('name')!.text, fn.text); f.locals.set(fn.childForFieldName('name')!.text, collect(fn, empty(fn.text))) }
    if (fn && /^(function|class)_definition$/.test(fn.type)) f.exports.add(fn.childForFieldName('name')!.text)
  }
  return f


  // Django: urlpatterns, DRF routers, settings, function views, and the raw facts of every class (plain.ts follows their base classes)
  function django(root: N, f: PyFacts, decorated: { def: N; decos: N[] }[], turnsAway: (n: N) => boolean) {
    const dj = f.dj, routers = new Set<string>()
    const vars = new Map(root.namedChildren.flatMap(st => { const a = st?.namedChildren[0], r = a?.childForFieldName('right'); return a?.type === 'assignment' && r ? [[a.childForFieldName('left')!.text, r] as const] : [] }))
    const lists = new Map([...vars].map(([k, v]) => [k, code(v)]))
    const guardName = (n: N): boolean => n.type === 'list' ? n.namedChildren.some(x => !!x && guardName(x))
      : n.type === 'identifier' && /^\[/.test(lists.get(n.text) ?? '') ? (lists.get(n.text)!.match(/\w+/g) ?? []).some(w => GUARD_DECO.test(w))   // decorators = [never_cache, login_required]
      : GUARD_DECO.test((n.type === 'call' ? fnName(n) : n.text).split('.').at(-1)!)
    // method_decorator(login_required, name='dispatch'), method_decorator([never_cache, login_required]), method_decorator(decorators, ...)
    const mdGuard = (d: N) => d.type === 'call' && /(^|\.)method_decorator$/.test(fnName(d)) && !!pos(d)[0] && guardName(pos(d)[0]!)
    // a view in urls.py or assigned in views.py: login_required(views.dashboard), permission_required('x')(views.wipe), csrf_exempt(OrderView.as_view())
    const unwrap = (v: N) => {
      let x: N = v, guard = false
      while (x.type === 'call' && pos(x)[0] && !/\.as_view$/.test(fnName(x))) { guard ||= guardName(x.childForFieldName('function')!); x = pos(x)[0]! }
      const map = x.type === 'call' ? pos(x)[0] : undefined   // OrderViewSet.as_view({'get': 'list'}, permission_classes=[AllowAny])
      const actions = map?.type === 'dictionary' ? Object.fromEntries(map.namedChildren.flatMap(pr => pr?.type === 'pair' && str(pr.childForFieldName('key')) && str(pr.childForFieldName('value'))
        ? [[str(pr.childForFieldName('key'))!.toUpperCase(), str(pr.childForFieldName('value'))!]] : [])) : undefined
      const pc = x.type === 'call' && /\.as_view$/.test(fnName(x)) ? kw(x, 'permission_classes') : undefined
      return { view: x.text.replace(/\.as_view\(.*$/s, ''), guard, actions, pc: pc ? code(pc) : undefined }
    }
    const one = (c: N | null | undefined, pre: string): void => {
      if (c?.type === 'attribute') { entries(c, pre); return }
      if (c?.type !== 'call' || !/^(path|re_path|url)$/.test(fnName(c))) return
      const p = pos(c)[0] ?? kw(c, 'route'), v = pos(c)[1] ?? kw(c, 'view'), path = str(p)
      if (path === undefined || !v) return
      if (v.type === 'call' && fnName(v) === 'include') {   // include('shop.urls'), include(router.urls), include(('api.urls', 'api'), namespace='api'), include([...]), include(extra)
        let a = pos(v)[0]; if (a?.type === 'tuple') a = a.namedChildren[0] ?? undefined
        const list = a?.type === 'list' ? a : a?.type === 'identifier' && vars.get(a.text)?.type === 'list' ? vars.get(a.text) : undefined
        if (list) entries(list, pre + path)
        else if (a) dj.urls.push({ path: pre + path, include: str(a) ?? a.text, guard: false })
        return
      }
      if (v.type === 'identifier' && vars.get(v.text)?.type === 'list') { entries(vars.get(v.text), pre + path); return }
      dj.urls.push({ path: pre + path, ...unwrap(v) })
    }
    const entries = (n: N | null | undefined, pre = ''): void => {
      if (!n) return
      if (n.type === 'binary_operator') { entries(n.childForFieldName('left'), pre); entries(n.childForFieldName('right'), pre); return }
      // urlpatterns += router.urls; [*router.urls] (tree-sitter reads the star as part of the attribute)
      if (n.type === 'attribute' && /^\*?\w+\.urls$/.test(n.text)) { dj.urls.push({ path: pre, include: n.text.replace(/^\*/, ''), guard: false }); return }
      if (n.type === 'identifier' && n.text !== 'urlpatterns' && /^(list|tuple)$/.test(vars.get(n.text)?.type ?? '')) { entries(vars.get(n.text), pre); return }   // urlpatterns = api + pages
      if (n.type === 'list' || n.type === 'tuple') for (const c of n.namedChildren) one(c, pre)
    }
    for (const a of [...all(root, 'assignment'), ...all(root, 'augmented_assignment')]) {
      const left = a.childForFieldName('left')?.text, right = a.childForFieldName('right')
      if (left === 'urlpatterns') entries(right)
      if (right?.type === 'call' && /(^|\.)(Default|Simple)Router$/.test(fnName(right)) && left) routers.add(left)
      if (left === 'REST_FRAMEWORK') { const m = code(right).match(/['"]DEFAULT_PERMISSION_CLASSES['"]\s*:\s*([\[(][^\])]*[\])])/); if (m) dj.drf = perm(m[1]) }
      if (left === 'MIDDLEWARE' && /['"]django\.contrib\.auth\.middleware\.LoginRequiredMiddleware['"]/.test(code(right))) dj.loginMw = true
      if (left === 'EMAIL_BACKEND') dj.emailBackend = code(right)
      if (left === 'EMAIL_HOST') dj.emailHost = code(right)
      // views.py: wipe = Wipe.as_view(), wipe = csrf_exempt(_wipe)
      if (left && /^\w+$/.test(left) && a.parent?.parent?.type === 'module' && right?.type === 'call' && (/\.as_view$/.test(fnName(right)) || /^[a-z_][\w.]*$/.test(fnName(right)) && !!pos(right)[0]))
        dj.aliases.set(left, unwrap(right))
    }
    for (const c of all(root, 'call')) if (/^urlpatterns\.(append|extend)$/.test(fnName(c))) { const a = pos(c)[0]; if (a?.type === 'list') entries(a); else one(a, '') }
    for (const c of all(root, 'call')) {   // router.register(r'orders', OrderViewSet)
      const fn = fnName(c), r = fn.replace(/\.register$/, ''), p = pos(c)[0] ?? kw(c, 'prefix'), v = pos(c)[1] ?? kw(c, 'viewset')
      if (fn.endsWith('.register') && routers.has(r) && str(p) !== undefined && v) dj.routers.set(r, [...dj.routers.get(r) ?? [], { prefix: str(p)!, view: v.text }])
    }
    dj.stars = all(root, 'import_from_statement').filter(i => i.namedChildren.some(c => c?.type === 'wildcard_import')).map(i => i.childForFieldName('module_name')!.text)
    const decoNames = (decos: N[]) => decos.map(d => d.text.split('(')[0].split('.').at(-1)!)
    // function views: def order_detail(request, pk)
    for (const node of root.namedChildren) {
      const d = node?.type === 'decorated_definition' ? decorated.find(x => x.def.startIndex === node.childForFieldName('definition')!.startIndex) : undefined
      const def = d?.def ?? node, decos = d?.decos ?? []
      const first = def?.type === 'function_definition' ? def.childForFieldName('parameters')?.namedChildren[0] : undefined   // request, request: HttpRequest, req
      if (!first || !/^(request|req)$/.test(first.type === 'typed_parameter' ? first.namedChildren[0]?.text ?? '' : first.text)) continue
      const names = decoNames(decos), facts = collect(def, empty(def.text)), api = decos.find(x => /(^|\.)api_view$/.test(x.type === 'call' ? fnName(x) : x.text))
      const listed = (x?: N) => x ? pos(x)[0]?.namedChildren.map(m => str(m!)?.toUpperCase()).filter((m): m is string => !!m) : undefined
      // require_POST, require_http_methods([...]), @api_view([...]); with no check, a view answers every method
      const asked = [...def.text.matchAll(/request\.method\s*(?:==|in|!=)\s*([^:\n]*)/g)].flatMap(m => m[1].match(/POST|PUT|PATCH|DELETE/g) ?? [])
      const methods = names.includes('require_POST') ? ['POST'] : names.some(n => /^require_(GET|safe)$/.test(n)) ? ['GET']
        : listed(decos.find(x => /require_http_methods$/.test(fnName(x)))) ?? (api ? listed(api.type === 'call' ? api : undefined) ?? ['GET']
        : asked.length ? ['GET', ...new Set(asked)] : ['ANY'])   // plain.ts: POST if it (or what it calls) changes data, else GET
      const pc = decos.find(x => fnName(x).endsWith('permission_classes'))
      const guard = decos.some(guardName) || turnsAway(def) ? true : pc ? perm(pc.text) : api ? undefined : false
      dj.views.set(def.childForFieldName('name')!.text, methods.map(method => ({ sub: '', method, facts, guard, open: names.includes('login_not_required'), drf: !!api })))
    }
    // classes: their bases, settings, decorators and methods, kept raw; djClassRoutes turns a chain of them into routes
    for (const cls of all(root, 'class_definition')) {
      const body = cls.childForFieldName('body')!
      const decos = cls.parent?.type === 'decorated_definition' ? cls.parent.namedChildren.filter((c): c is N => c?.type === 'decorator').map(c => c.namedChildren[0]!) : []
      const attr = (name: string) => body.namedChildren.map(st => st?.namedChildren[0]).find(a => a?.type === 'assignment' && a.childForFieldName('left')?.text === name)?.childForFieldName('right')
      const defs = body.namedChildren.flatMap(st => { const def = st?.type === 'decorated_definition' ? st.childForFieldName('definition') : st
        return def?.type === 'function_definition' ? [{ def, st: st!, decos: st!.type === 'decorated_definition' ? st!.namedChildren.filter((c): c is N => c?.type === 'decorator').map(c => c.namedChildren[0]!) : [] }] : [] })
      const md = new Set<string>()
      for (const d of decos) if (mdGuard(d)) md.add(str(kw(d, 'name')) ?? 'dispatch')
      for (const { def, decos: ds } of defs) { const n = def.childForFieldName('name')!.text; if (ds.some(mdGuard) || n === 'dispatch' && turnsAway(def)) md.add(n) }
      const out: DjDef[] = [], routeDefs = new Set<number>()
      for (const { def, st, decos: ds } of defs) {
        const name = def.childForFieldName('name')!.text, act = ds.find(x => fnName(x).split('.').at(-1) === 'action')
        if (!/^(get|post|put|patch|delete)$/.test(name) && !ACTIONS[name] && !act) continue
        routeDefs.add(st.startIndex)
        out.push({ name, facts: collect(def, empty(def.text)), guard: turnsAway(def), act: act && {   // @action(detail=True, methods=['post'], url_path='pay')
          sub: (kw(act, 'detail')?.text === 'True' ? '/[pk]' : '') + '/' + (str(kw(act, 'url_path')) ?? name), pc: kw(act, 'permission_classes') ? code(kw(act, 'permission_classes')) : undefined,
          methods: kw(act, 'methods')?.namedChildren.map(x => str(x!)?.toUpperCase()).filter((x): x is string => !!x) ?? ['GET'] } })
      }
      const rest = empty(body.text)
      for (const st of body.namedChildren) if (st && !routeDefs.has(st.startIndex)) collect(st, rest)   // perform_create, get_queryset, ...
      const gpDef = defs.find(d => d.def.childForFieldName('name')!.text === 'get_permissions')?.def
      const byAction = body.namedChildren.map(st => st?.namedChildren[0]).find(a => a?.type === 'assignment' && /_by_action$/.test(a.childForFieldName('left')?.text ?? ''))
      const getPerms = gpDef ? code(gpDef) + (byAction ? '\n' + code(byAction) : '') : undefined
      dj.classes.set(cls.childForFieldName('name')!.text, { bases: (cls.childForFieldName('superclasses')?.namedChildren ?? []).filter(b => b?.type !== 'keyword_argument').map(b => b!.text),
        pc: attr('permission_classes') ? code(attr('permission_classes')) : undefined, getPerms, model: attr('model')?.text.match(/^[A-Z]\w*$/)?.[0] ?? attr('queryset')?.text.match(/^([A-Z]\w*)\.objects\b/)?.[1] ?? body.text.match(/\b([A-Z]\w*)\.objects\b/)?.[1],   // or what get_queryset reads
        lookup: str(attr('lookup_field')), http: attr('http_method_names')?.namedChildren.map(x => str(x!)?.toUpperCase()).filter((x): x is string => !!x),
        md, defs: out, rest, open: decos.some(d => /method_decorator\(\s*login_not_required/.test(d.text) && /dispatch/.test(d.text))
          || defs.some(d => d.def.childForFieldName('name')!.text === 'dispatch' && d.decos.some(x => /login_not_required/.test(x.text))) })
    }
  }

  // Facts from one subtree: the whole file, or one route handler.
  function collect(node: N, g: FileFacts): FileFacts {
    const inner = new Set(all(node, 'function_definition').filter(d => d.startIndex !== node.startIndex).map(d => d.childForFieldName('name')!.text))   // def remove() inside a handler isn't the remove() route
    for (const c of all(node, 'call')) {
      const fn = fnName(c), a0 = pos(c)[0]
      g.used.add(fn.split('.').at(-1)!)
      if (/^\w+(\.\w+)?$/.test(fn) && !inner.has(fn)) g.used.add(`call:${fn}`)   // create_order(...), services.create_order(...): pyFold follows these
      // SQLAlchemy: session.add(Order(...)), session.delete(order), session.query(Order), select(Order), Order.query
      if (/(^|\.)session\.(add|add_all|merge)$|^(db\.)?session\.(add|merge)$/.test(fn) || /^(self\.)?(db|session)\.(add|merge)$/.test(fn)) {
        const made = a0 && all(node, 'assignment').find(x => x.childForFieldName('left')?.text === a0.text && x.childForFieldName('right')?.type === 'call')
        const t = a0?.type === 'call' ? fnName(a0) : made ? fnName(made.childForFieldName('right')!) : a0 ? modelOf(a0.text) : undefined
        if (t && /^[A-Z]\w*$/.test(t)) { g.written.add(t); g.tables.add(t) }
        g.writes = true; g.ops.add('create')
      }
      // Django model instances: order.save(), order.delete(), form.save() (no arguments: client.delete('/x') is a web request)
      const inst = fn.match(/^([a-z_]\w*)\.a?(save|delete)$/)
      if (inst && !a0 && !/^(self|cls|session|db|request|cache|storage|messages|super)$/.test(inst[1])) {
        // order = Order(...) is new; order = Order.objects.get(...) / get_object_or_404(Order, ...) is an existing one; OrderSerializer(...) saves orders
        const made = all(node, 'assignment').find(x => x.childForFieldName('left')?.text === inst[1] && x.childForFieldName('right')?.type === 'call')?.childForFieldName('right')
        const mf = made ? fnName(made) : '', fetched = mf.match(/^([A-Z]\w*)\.(objects|query)\b/)?.[1] ?? (/(^|\.)get_(object|list)_or_404$/.test(mf) ? pos(made!)[0]?.text : undefined)
        const t = fetched ?? (/^[A-Z]\w*$/.test(mf) ? mf.replace(/(Model)?(Serializer|Form|FormSet)$/, '') : made || /form|serializer/i.test(inst[1]) ? '' : modelOf(inst[1]))
        g.writes = true; if (t !== '') g.ops.add(inst[2] === 'delete' ? 'delete' : /^[A-Z]/.test(mf) && !fetched ? 'create' : 'update')   // a form: saves, new or not
        if (/^[A-Z]\w*$/.test(t)) { g.written.add(t); g.tables.add(t) }
      }
      if (/(^|\.)(session|db)\.delete$/.test(fn) && a0) { const t = a0.type === 'identifier' ? modelOf(a0.text) : ''; if (t) { g.written.add(t); g.tables.add(t) } g.writes = true; g.ops.add('delete') }
      if (/(^|\.)(query|select|get)$/.test(fn) && a0 && /^[A-Z]\w*$/.test(a0.text) && /session|db|^select$/.test(fn)) g.tables.add(a0.text)
      if (/^(insert|update|delete)$/.test(fn) && a0 && /^[A-Z]\w*$/.test(a0.text)) { g.tables.add(a0.text); g.written.add(a0.text); g.writes = true; g.ops.add(fn === 'insert' ? 'create' : fn) }
      // Django: Order.objects.create(...), Order.objects.filter(...).delete()
      const q = fn.match(/^([A-Z]\w*)\.query\b[\s\S]*\.(delete|update)$/)   // Order.query.filter_by(id=1).delete()
      if (q) { g.tables.add(q[1]); g.written.add(q[1]); g.writes = true; g.ops.add(q[2]) }
      const dj = fn.match(/^([A-Z]\w*)\.objects\b[\s\S]*\.(\w+)$/)   // also split over lines
      if (dj) { g.tables.add(dj[1]); if (DJANGO_OPS[dj[2]]) { g.written.add(dj[1]); g.writes = true; g.ops.add(DJANGO_OPS[dj[2]]) } }
      // Supabase: supabase.table('orders').insert(...)
      const sb = c.text.match(/\.(?:table|from_)\(\s*['"](\w+)['"]\s*\)\s*\.\s*(select|insert|update|upsert|delete)\b/)
      if (sb && fn.endsWith(sb[2])) { g.tables.add(sb[1]); if (sb[2] !== 'select') { g.written.add(sb[1]); g.writes = true; g.ops.add(sb[2] === 'insert' || sb[2] === 'upsert' ? 'create' : sb[2]) } }
      // money and outside services
      // (a Stripe refund, not `order.refunds.create`, a related manager; a `client` only in a file that uses Stripe, not a Client model)
      if (/^stripe\.Refund\.create$|^stripe\.(?:v1\.)?refunds\.create$/.test(fn) || /^(?:stripe_client|client)\.(?:v1\.)?refunds\.create$/.test(fn) && /\bimport\s+stripe\b|\bfrom\s+stripe\b|StripeClient/.test(text)) { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
      if (/^stripe\.(checkout\.Session|PaymentIntent|Charge|Subscription|Invoice)\.create$|checkout\.sessions\.create$/.test(fn)) {
        g.money = true; g.services.add('Stripe'); if (/checkout/i.test(fn)) g.outside.add('Stripe: checkout.sessions.create')
      }
      if (/^stripe\.Webhook\.construct_event$|\.construct_event$/.test(fn)) g.outside.add('Stripe: webhooks.constructEvent')
      if (/^(resend\.Emails\.send|sg\.send|sendgrid)/.test(fn)) g.outside.add('Resend: emails.send')
      // Django's own email: send_mail(...), EmailMessage(...).send(); Flask-Mail: mail.send(msg)
      if (/(^|\.)(send_mail|send_mass_mail|mail_admins|mail_managers)$|^(EmailMessage|EmailMultiAlternatives)$|^mail\.send$/.test(fn)) { g.services.add('email'); g.outside.add('email: send') }
      const host = /^(requests|httpx)\.(get|post|put|patch|delete)$/.test(fn) && str(a0)?.match(/^https?:\/\/([^/]+)/)?.[1]
      if (host && HOSTS[host]) { g.services.add(HOSTS[host]); g.outside.add(`${HOSTS[host]}: ${/resend|sendgrid/.test(host) ? 'emails.send' : 'request'}`) }
      // env: os.environ.get('X'), os.getenv('X', 'default'), config('X')
      if (/^(os\.environ\.get|os\.getenv|config|env)$/.test(fn) && str(a0) && /^[A-Z][A-Z0-9_]+$/.test(str(a0)!)) {
        const dflt = pos(c)[1] ?? kw(c, 'default')
        g.env.add(str(a0)!); if (!dflt || /^(None|''|"")$/.test(dflt.text)) g.envReq.add(str(a0)!)
      }
      // "no" messages: raise HTTPException(status_code=409, detail='...'), abort(400, '...')
      if (/(^|\.)(HTTPException|abort)$/.test(fn)) {
        const code = +(kw(c, 'status_code')?.text ?? a0?.text ?? 0), m = str(kw(c, 'detail') ?? kw(c, 'description') ?? pos(c)[1])
        if (code >= 400 && code < 500 && ![401, 403, 404].includes(code) && m) g.refuses.add(m)
      }
    }
    for (const s of all(node, 'subscript')) {   // os.environ['X']
      const k = str(s.childForFieldName('subscript'))
      if (s.childForFieldName('value')?.text === 'os.environ' && k) { g.env.add(k); g.envReq.add(k) }
    }
    for (const t of all(node, 'attribute')) { const m = t.text.match(/^([A-Z]\w*)\.query$/); if (m) g.tables.add(m[1]) }   // Order.query.filter(...)
    g.emptyCatch += all(node, 'except_clause').filter(e => /^\s*pass\s*$/.test(e.namedChildren.at(-1)?.text ?? '')).length
    return g
  }
}
