// Python (FastAPI, Flask; SQLAlchemy, SQLModel, Django ORM): the same facts plain.ts reads from TypeScript.
// Parsed with tree-sitter (WebAssembly, grammar in vendor/), not the user's python3: that one can be missing or older
// than the code, and Python's own parser gives up on a whole file at the first syntax error.
// ponytail: Django urls.py routing isn't read yet; its ORM calls and models are.
import type { FileFacts } from './plain.ts'
import { fileURLToPath } from 'node:url'

type N = import('web-tree-sitter').Node
let parser: import('web-tree-sitter').Parser | undefined
try {
  const { Parser, Language } = await import('web-tree-sitter')
  await Parser.init()
  parser = new Parser()
  parser.setLanguage(await Language.load(fileURLToPath(new URL('../vendor/tree-sitter-python.wasm', import.meta.url))))
} catch { parser = undefined }   // not installed: Python files are skipped

export type PyFacts = FileFacts & { models: Map<string, string[]>; risks: Set<string> }

const str = (n?: N | null) => n?.type === 'string' && !n.namedChildren.some(c => c?.type === 'interpolation')
  ? n.namedChildren.filter(c => c?.type === 'string_content').map(c => c!.text).join('') : undefined
const fString = (n?: N | null) => n?.type === 'string' && n.namedChildren.some(c => c?.type === 'interpolation')
const args = (call: N) => call.childForFieldName('arguments')?.namedChildren.filter((c): c is N => !!c && c.type !== 'comment') ?? []
const kw = (call: N, name: string) => args(call).find(a => a.type === 'keyword_argument' && a.childForFieldName('name')?.text === name)?.childForFieldName('value') ?? undefined
const pos = (call: N) => args(call).filter(a => a.type !== 'keyword_argument')
const fnName = (call: N) => call.childForFieldName('function')?.text ?? ''
const all = (n: N, type: string) => n.descendantsOfType(type).filter((x): x is N => !!x)
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const modelOf = (v: string) => cap(v.replace(/_(\w)/g, (_, c) => c.toUpperCase()).replace(/s$/, ''))   // order_item -> OrderItem

const HTTP = /^(get|post|put|patch|delete)$/
// Dependencies and decorators that check who you are (get_current_user, login_required, jwt_required, require_admin)
const GUARD = /current_(active_)?user|login_required|jwt_required|auth|admin|require|verify|token|permission|staff|superuser/i
const SERVICES: Record<string, string> = { stripe: 'Stripe', openai: 'OpenAI', anthropic: 'Anthropic', resend: 'Resend', twilio: 'Twilio',
  boto3: 'AWS', supabase: 'Supabase', sendgrid: 'SendGrid', postmarker: 'Postmark' }
const HOSTS: Record<string, string> = { 'api.resend.com': 'Resend', 'api.stripe.com': 'Stripe', 'api.openai.com': 'OpenAI', 'api.anthropic.com': 'Anthropic',
  'api.sendgrid.com': 'SendGrid', 'api.twilio.com': 'Twilio' }
const DJANGO_OPS: Record<string, string> = { create: 'create', get_or_create: 'create', update_or_create: 'create', bulk_create: 'create', update: 'update', bulk_update: 'update', delete: 'delete' }

export function pyFacts(path: string, text: string, empty: (printed?: string) => FileFacts): PyFacts | undefined {
  if (!parser) return undefined
  const tree = parser.parse(text)
  if (!tree) return undefined
  const root = tree.rootNode
  const f = Object.assign(collect(root, empty(text.replace(/#[^\n]*/g, '').replace(/\s+/g, ' '))), { models: new Map<string, string[]>(), risks: new Set<string>() })
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
  const servers = new Map<string, { prefix: string; guard: boolean }>()
  for (const a of all(root, 'assignment')) {
    const left = a.childForFieldName('left')?.text ?? '', right = a.childForFieldName('right')
    if (right?.type !== 'call') continue
    const fn = fnName(right)
    if (/^(FastAPI|APIRouter|Flask|Blueprint)$/.test(fn.split('.').at(-1)!))
      servers.set(left, { prefix: str(kw(right, 'prefix') ?? kw(right, 'url_prefix')) ?? '', guard: guardIn(kw(right, 'dependencies')) })
  }
  // @bp.before_request that turns people away: everything in that blueprint needs login
  for (const d of all(root, 'decorated_definition')) {
    const decos = d.namedChildren.filter((c): c is N => c?.type === 'decorator').map(c => c.namedChildren[0]!)
    const def = d.childForFieldName('definition')!
    for (const x of decos) {
      const m = x.text.match(/^(\w+)\.before_(app_)?request$/)
      if (m && servers.has(m[1]) && /abort\(\s*40[13]|redirect\(|current_user|is_authenticated|login/i.test(def.text) && /abort|redirect|raise/.test(def.text)) servers.get(m[1])!.guard = true
    }
  }
  // routes: @router.post('/{id}'), @app.route('/x', methods=['POST']), @app.api_route('/x', methods=[...])
  for (const d of all(root, 'decorated_definition')) {
    const def = d.childForFieldName('definition')!
    if (def.type !== 'function_definition') continue
    const decos = d.namedChildren.filter((c): c is N => c?.type === 'decorator').map(c => c.namedChildren[0]!)
    const guard = decos.some(x => GUARD.test(x.text.split('(')[0]) && !/route|get|post|put|patch|delete/.test(x.text.split('(')[0].split('.').at(-1)!))
      || decos.some(x => x.type === 'call' && guardIn(kw(x, 'dependencies')))
      || (def.childForFieldName('parameters')?.namedChildren ?? []).some(p => !!p && /\b(Depends|Security)\(/.test(p.text) && GUARD.test(p.text))
    for (const x of decos) {
      if (x.type !== 'call') continue
      const fn = fnName(x), obj = fn.split('.').slice(0, -1).join('.'), last = fn.split('.').at(-1)!, path = str(pos(x)[0])
      if (!servers.has(obj) || path === undefined) continue
      const methods = HTTP.test(last) ? [last.toUpperCase()]
        : /^(route|api_route)$/.test(last) ? (kw(x, 'methods')?.namedChildren.map(m => str(m!)?.toUpperCase()).filter((m): m is string => !!m) ?? ['GET']) : []
      const facts = collect(def, empty(def.text))
      const s = servers.get(obj)!
      // FastAPI {id} and Flask <int:id> become [id]
      const url = (s.prefix.replace(/\/$/, '') + path).replace(/\{(\w+)(:[^}]*)?\}/g, '[$1]').replace(/<(?:\w+:)?(\w+)>/g, '[$1]').replace(/(.)\/$/, '$1') || '/'
      for (const m of methods) f.handlers.push({ server: obj, method: m, path: url, guard: guard || s.guard, mw: [], facts })
    }
  }
  // app.include_router(orders.router, prefix='/api', dependencies=[...]); app.register_blueprint(bp, url_prefix='/x')
  for (const c of all(root, 'call')) {
    const fn = fnName(c), last = fn.split('.').at(-1)!
    if (!/^(include_router|register_blueprint)$/.test(last) || !servers.has(fn.split('.').slice(0, -1).join('.'))) continue
    const target = pos(c)[0]?.text.split('.')[0]
    if (target) f.mounts.push({ server: fn.split('.')[0], path: str(kw(c, 'prefix') ?? kw(c, 'url_prefix')) ?? '', target, guard: guardIn(kw(c, 'dependencies')), guardLike: false })
  }

  // models: class Order(db.Model) / (Base) / (SQLModel, table=True) / (models.Model)
  for (const cls of all(root, 'class_definition')) {
    const sup = cls.childForFieldName('superclasses')?.text ?? ''
    if (!/\b(db\.Model|models\.Model|Base|DeclarativeBase)\b|SQLModel.*table\s*=\s*True/.test(sup)) continue
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
    if (/^DEBUG$/.test(left) && right?.text === 'True') f.risks.add('debug')
    if (/^(SECRET_KEY|app\.secret_key|app\.config\[['"]SECRET_KEY['"]\])$/.test(left) && str(right)) f.risks.add('secret')
    if (/^CORS_(ALLOW_ALL_ORIGINS|ORIGIN_ALLOW_ALL)$/.test(left) && right?.text === 'True') f.risks.add('cors')
  }
  for (const c of all(root, 'call')) {
    const fn = fnName(c)
    if (/\.run$/.test(fn) && kw(c, 'debug')?.text === 'True') f.risks.add('debug')
    if (fn === 'CORS' && !kw(c, 'origins') && !kw(c, 'resources')) f.risks.add('cors')
    if (/(^|\.)add_middleware$/.test(fn) && /CORSMiddleware/.test(c.text) && /allow_origins\s*=\s*\[\s*['"]\*['"]/.test(c.text)) f.risks.add('cors')
    if (/(^|\.)(execute|executescript|raw|text|extra)$/.test(fn) && (fString(pos(c)[0]) || /^(binary_operator)$/.test(pos(c)[0]?.type ?? '') && /['"]/.test(pos(c)[0]!.text))) f.risks.add('sql')
  }
  if (all(root, 'decorator').some(d => /^(csrf_exempt|csrf\.exempt)$/.test(d.namedChildren[0]?.text ?? ''))) f.risks.add('csrf')

  // top-level functions, for "deleted but still used" and handlers named elsewhere
  for (const def of root.namedChildren) {
    const fn = def?.type === 'decorated_definition' ? def.childForFieldName('definition') : def
    if (fn?.type === 'function_definition') f.fns.set(fn.childForFieldName('name')!.text, fn.text)
    if (fn && /^(function|class)_definition$/.test(fn.type)) f.exports.add(fn.childForFieldName('name')!.text)
  }
  return f

  function guardIn(n?: N) { return !!n && /\b(Depends|Security)\(/.test(n.text) && GUARD.test(n.text) }

  // Facts from one subtree: the whole file, or one route handler.
  function collect(node: N, g: FileFacts): FileFacts {
    for (const c of all(node, 'call')) {
      const fn = fnName(c), a0 = pos(c)[0]
      g.used.add(fn.split('.').at(-1)!)
      // SQLAlchemy: session.add(Order(...)), session.delete(order), session.query(Order), select(Order), Order.query
      if (/(^|\.)session\.(add|add_all|merge)$|^(db\.)?session\.(add|merge)$/.test(fn) || /^(self\.)?(db|session)\.(add|merge)$/.test(fn)) {
        const t = a0?.type === 'call' ? fnName(a0) : a0 ? modelOf(a0.text) : undefined
        if (t && /^[A-Z]\w*$/.test(t)) { g.written.add(t); g.tables.add(t) }
        g.writes = true; g.ops.add('create')
      }
      if (/(^|\.)(session|db)\.delete$/.test(fn) && a0) { const t = modelOf(a0.text); g.written.add(t); g.tables.add(t); g.writes = true; g.ops.add('delete') }
      if (/(^|\.)(query|select|get)$/.test(fn) && a0 && /^[A-Z]\w*$/.test(a0.text) && /session|db|^select$/.test(fn)) g.tables.add(a0.text)
      if (/^(insert|update|delete)$/.test(fn) && a0 && /^[A-Z]\w*$/.test(a0.text)) { g.tables.add(a0.text); g.written.add(a0.text); g.writes = true; g.ops.add(fn === 'insert' ? 'create' : fn) }
      // Django: Order.objects.create(...), Order.objects.filter(...).delete()
      const q = fn.match(/^([A-Z]\w*)\.query\b.*\.(delete|update)$/)   // Order.query.filter_by(id=1).delete()
      if (q) { g.tables.add(q[1]); g.written.add(q[1]); g.writes = true; g.ops.add(q[2]) }
      const dj = fn.match(/^([A-Z]\w*)\.objects\b.*\.(\w+)$/)
      if (dj) { g.tables.add(dj[1]); if (DJANGO_OPS[dj[2]]) { g.written.add(dj[1]); g.writes = true; g.ops.add(DJANGO_OPS[dj[2]]) } }
      // Supabase: supabase.table('orders').insert(...)
      const sb = c.text.match(/\.(?:table|from_)\(\s*['"](\w+)['"]\s*\)\s*\.\s*(select|insert|update|upsert|delete)\b/)
      if (sb && fn.endsWith(sb[2])) { g.tables.add(sb[1]); if (sb[2] !== 'select') { g.written.add(sb[1]); g.writes = true; g.ops.add(sb[2] === 'insert' || sb[2] === 'upsert' ? 'create' : sb[2]) } }
      // money and outside services
      if (/^stripe\.(checkout\.Session|PaymentIntent|Charge|Subscription|Invoice)\.create$|checkout\.sessions\.create$/.test(fn)) {
        g.money = true; g.services.add('Stripe'); if (/checkout/i.test(fn)) g.outside.add('Stripe: checkout.sessions.create')
      }
      if (/^stripe\.Webhook\.construct_event$|\.construct_event$/.test(fn)) g.outside.add('Stripe: webhooks.constructEvent')
      if (/^(resend\.Emails\.send|sg\.send|sendgrid)/.test(fn)) g.outside.add('Resend: emails.send')
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
    // a check inside the handler: if not current_user...: abort(401) / raise HTTPException(401) / redirect(...)
    if (/current_user|is_authenticated|get_current_user|request\.user|verify_id_token|get_user\(/.test(node.text)
      && /abort\(\s*40[13]|status_code\s*=\s*40[13]|HTTP_40[13]|HTTPException\(\s*40[13]|redirect\(|PermissionDenied/.test(node.text)) g.auth = true
    g.emptyCatch += all(node, 'except_clause').filter(e => /^\s*pass\s*$/.test(e.namedChildren.at(-1)?.text ?? '')).length
    return g
  }
}
