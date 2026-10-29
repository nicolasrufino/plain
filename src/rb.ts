// Ruby on Rails: config/routes.rb (and the config/routes/*.rb files it draws), controllers and their callbacks, concerns, Active
// Record, migrations, Stripe (stripe-ruby, Pay), mailers, ENV and credentials. Which controller action a route reaches, and login, are
// decided in plain.ts:
//  - routes in file order, the FIRST definition of a method and address wins (unlike Laravel);
//  - an action's before_actions: its class's and its parents' (ApplicationController), the concerns they include (Rails 8's
//    `include Authentication`), in order; declaring the same one again replaces it (`before_action :authenticate_user!, only: [:edit]`
//    in a subclass leaves the rest open); skip_before_action removes it (with if:/unless:, plain can't tell);
//  - login: Devise's authenticate_user! (with devise in the Gemfile), Rails 8's require_authentication, http_basic_authenticate_with,
//    Devise's `authenticate :user do` around routes, an app before_action whose code turns guests away (`redirect_to login_path unless
//    current_user`); in an action, only such a check that returns. Pundit / CanCanCan don't mean login: plain can't tell.
// ponytail: ERB views, Devise's and Pay's own routes, mounted engines and route constraints beyond Devise's aren't read.
import { adminCond } from './admin.ts'
import type { FileFacts } from './plain.ts'
import type { SchemaOp } from './php.ts'
import { parserFor } from './treesitter.ts'
const parser = await parserFor('tree-sitter-ruby.wasm')   // 2 MB; null when web-tree-sitter isn't installed: Ruby files are skipped

type N = import('web-tree-sitter').Node
export type Cb = { kind: 'before' | 'skip' | 'include'; name: string; only?: string[]; except?: string[]; cond?: boolean; body?: string }   // name '?' for a block/lambda (body: its code)
export type RbRoute = { method: string; path: string; controller: string; action: string; guard?: 'login' | 'unknown'; htmlOnly?: boolean; at: number; fallthrough?: boolean }   // fallthrough: inside a constraint (Devise's authenticated): guests go on to later routes
export type RbClass = { base?: string; outer: string; cbs: Cb[]; includes: string[]; api: boolean; model: boolean; table?: string; csrfOff: string[] }   // outer: the namespace its code is written in (where Ruby looks up its parent)
export type RbCheck = 'login' | 'unknown'
// tops: the method's own methods it calls at the top level, unconditionally, before anything returns
export type RbFacts = FileFacts & { rb: {
  routes: RbRoute[]                                         // in this routes file, in order (draws in `draws`, at their place)
  draws: { file: string; path: string; module: string; guard?: 'login' | 'unknown'; at: number }[]
  devise: string[]                                          // devise_for :users -> users (authenticate_user! exists)
  classes: Map<string, RbClass>                             // Admin::OrdersController -> its callbacks, ...; modules too (a concern's `included do`)
  methods: Map<string, FileFacts & { check?: RbCheck; halts?: RbCheck | 'none'; tops?: string[] }>   // Class.method -> facts; check: in an action; halts: as a before_action
  schema: SchemaOp[]
  risks: Set<string>
} }

const all = (n: N, type: string) => n.descendantsOfType(type).filter((x): x is N => !!x && x.isNamed)
// :index, "index", index:, %i[a b] -> strings
const val = (n?: N | null): string | undefined => {
  if (!n) return undefined
  if (n.type === 'simple_symbol') return n.text.slice(1)
  if (n.type === 'hash_key_symbol' || n.type === 'bare_symbol' || n.type === 'bare_string') return n.text
  if (n.type === 'string' || n.type === 'delimited_symbol') return n.namedChildren.every(c => c?.type === 'string_content' || c?.type === 'escape_sequence') ? n.namedChildren.map(c => c!.text).join('') : undefined
  return undefined
}
const vals = (n?: N | null): string[] => !n ? [] : /^(array|symbol_array|string_array)$/.test(n.type) ? n.namedChildren.flatMap(c => vals(c)) : val(n) !== undefined ? [val(n)!] : []
const argsOf = (c: N) => { const a = c.childForFieldName('arguments')?.namedChildren.filter((x): x is N => !!x) ?? []
  return { pos: a.filter(x => x.type !== 'pair'), opt: new Map(a.filter(x => x.type === 'pair').map(p => [val(p.childForFieldName('key')) ?? p.childForFieldName('key')!.text.replace(/^:/, ''), p.childForFieldName('value')!])) } }
const blockBody = (c: N) => { const b = c.childForFieldName('block'); return b ? b.childForFieldName('body') ?? undefined : undefined }
const plural = (s: string) => s.endsWith('y') && !/[aeiou]y$/.test(s) ? s.slice(0, -1) + 'ies' : /(s|x|z|ch|sh)$/.test(s) ? s + 'es' : s + 's'
const singular = (s: string) => s.endsWith('ies') ? s.slice(0, -3) + 'y' : /(sses|xes|zes|ches|shes)$/.test(s) ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s
const camel = (s: string) => s.split('_').map(w => w && w[0].toUpperCase() + w.slice(1)).join('')
// orders -> Order; admin/orders -> Admin::OrdersController
export const rbModelOf = (table: string) => camel(singular(table))
export const controllerClass = (c: string) => c.split('/').map(camel).join('::') + 'Controller'
const join = (a: string, b: string) => ('/' + [a, b].join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
// :id -> [id], *path -> [path], (/:id) and (.:format) parts read as there
const rbPath = (p: string) => p.replace(/\(\.:format\)/g, '').replace(/[()]/g, '').replace(/:(\w+)/g, '[$1]').replace(/\*(\w+)/g, '[$1]')

// Who's logged in, in Rails code; a check turns guests away only when the user is missing (`unless current_user`,
// `if current_user.nil?`, `unless current_user&.admin?`); 'unknown' when a rejection depends on the user some other way.
const USER = String.raw`(?:current_user|Current\.user|Current\.session|user_signed_in\?|authenticated\?|logged_in\?|signed_in\?|session\[:user_id\]|current_admin|admin_signed_in\?)`
const PROP = String.raw`(?:&?\.(?!nil\?|blank\?|empty\?)\w+[?!]?)?`   // current_user&.admin? (not .nil?: `unless current_user.nil?` is for guests)
const NO_USER = String.raw`(?:unless\s+${USER}${PROP}|if\s+(?:!\s*|not\s+)${USER}${PROP}|if\s+${USER}\.(?:nil|blank)\?)`
const HALT = String.raw`(?:redirect_to|redirect_back|redirect_back_or_to|head|render|raise|request_authentication|request_http_\w+_authentication|(?:render|redirect|head|deny|reject|respond)_\w*(?:unauthori[sz]ed|forbidden|login|denied|sign_in)\w*|deny_access)\b`
const LOGIN_LINE = new RegExp(String.raw`^(return\s+)?${HALT}[^\n]*?\s${NO_USER}\s*$|^(?:return\s+)?${HALT}[^\n]*\band\s+return\s+${NO_USER}\s*$`)
const LOGIN_BLOCK = new RegExp(String.raw`^(?:if\s+(?:!\s*|not\s+)${USER}${PROP}|unless\s+${USER}${PROP}|if\s+${USER}\.(?:nil|blank)\?)\s*\n\s*(return\s+)?${HALT}`)
const ALWAYS = /authenticate_or_request_with_http_(?:token|basic)|\|\|\s*request_authentication\b|^\s*resume_session\s*\|\|/m
// ...counted only as the statement itself, unconditional (not `x && authenticate_or_...`, `... if staging?`, a ternary)
const ALWAYS_STMT = /^(?:authenticate_or_request_with_http_(?:token|basic)\b|resume_session\s*\|\|\s*request_authentication\s*$)/
const ABOUT_USER = new RegExp(USER)
export const LAMBDA_LOGIN = (body: string) => { const b = uncomment(body).replace(/^\s*->\s*(\(\w*\))?\s*\{\s*|\s*\}\s*$/g, '').replace(/^\s*do\s*(\|[^|]*\|)?|\s*end\s*$/g, '').trim(); return LOGIN_LINE.test(b) }
// classes from gems and Ruby itself: not the app's models or services
const VENDOR = /^(Stripe|Pay|Rails|ActiveRecord|ActionController|ActiveSupport|ENV|Time|Date|DateTime|JSON|URI|Net|File|IO|Integer|Float|String|Array|Hash|Kernel|Struct|BigDecimal|SecureRandom|Digest|Base64|Devise|Pundit|CanCan|Faraday|HTTParty|Aws|Google|OpenAI|Anthropic)\b/
const uncomment = (t: string) => t.replace(/(^|\s)#[^{\n][^\n]*/g, '$1')
// as a before_action: halting (redirect / head / render) stops the action. In an action: only a check that returns does.
// (out.admin: the line that turns guests away turns away non-admins too: `redirect_to root_path unless Current.user&.admin?`)
function userCheck(body: N | null | undefined, callback: boolean, out: { admin?: boolean } = {}): RbCheck | 'none' {
  if (!body) return 'none'
  let first = true, guestsOut = false
  for (const st of body.namedChildren) {
    if (!st || st.type === 'comment') continue
    const t = uncomment(st.text).trim()
    // HTTP auth only counts unconditionally (`... if Rails.env.staging?` leaves the rest open)
    if (ALWAYS_STMT.test(t) && !/\s(if|unless)\s|\?\s|&&/.test(t.split('\n')[0]) && !/\}\s*(if|unless)\s|\bend\s+(if|unless)\s/.test(t)) return 'login'
    // in an action the check must come first (after a write it's too late) and return; in a before_action halting stops the action
    const ok = callback || first
    if (ok && LOGIN_LINE.test(t) && (callback || /^return\b|\band\s+return\b/.test(t))) { out.admin = adminCond(t); return 'login' }
    // (the halt inside the block may carry its own condition: `redirect_to root_path if request.delete?` turns away non-admins only sometimes)
    if (ok && LOGIN_BLOCK.test(t) && (callback || /^\S[^\n]*\n\s*return\b|\band\s+return\b/.test(t))) { const [c, h = ''] = t.split('\n').filter(l => l.trim()); out.admin = adminCond(c) && !/\s(if|unless)\s/.test(h); return 'login' }
    // `return if current_user` then a redirect: whoever isn't logged in is turned away
    if (callback && new RegExp(String.raw`^return\s+(?:\S+\s+)?if\s+${USER}${PROP}\s*$`).test(t)) { guestsOut = true; continue }
    if (guestsOut && new RegExp(`^(return\\s+)?${HALT}`).test(t) && !/\s(if|unless)\s/.test(t)) return 'login'   // (a halt with its own condition doesn't always run)
    if (/\breturn\b/.test(t)) break   // some requests leave before what follows
    first = false
  }
  // a rejection that depends on the user (an if / unless testing them, whose branch stops the request), or a Pundit / CanCanCan check
  const halt = new RegExp(HALT)
  const branches = [...all(body, 'if'), ...all(body, 'unless'), ...all(body, 'elsif'), ...all(body, 'if_modifier'), ...all(body, 'unless_modifier')]
    .some(n => ABOUT_USER.test(n.childForFieldName('condition')?.text ?? '') && halt.test(uncomment((n.childForFieldName('consequence') ?? n.childForFieldName('body'))?.text ?? '')))
  // as a before_action, anything else that can stop the request (a render in a rescue, a helper like render_unauthorized,
  // authenticate_with_http_token || ..., a call to another method) is something plain can't judge
  const CRED = /token|session|header|jwt|unauthori[sz]ed|forbidden|401|403|authenticat|signed_in|login|password/i
  const other = callback && ([...all(body, 'if'), ...all(body, 'unless'), ...all(body, 'if_modifier'), ...all(body, 'unless_modifier')].some(n => CRED.test(n.childForFieldName('condition')?.text ?? '') && halt.test(n.text))
    || all(body, 'rescue').some(r => CRED.test(r.text) && halt.test(uncomment(r.text))) || body.namedChildren.some(c => !!c && halt.test(uncomment(c.text)) && CRED.test(c.text)))
  return branches || other || /\bauthorize!?\s*[(@:]|\bauthorize\s+\w/.test(uncomment(body.text)) || ALWAYS.test(uncomment(body.text)) ? 'unknown' : 'none'
}

export function rbFacts(path: string, text: string, empty: (printed?: string) => FileFacts): RbFacts | undefined {
  if (!parser) return undefined
  const tree = parser.parse(text)
  if (!tree) return undefined
  const root = tree.rootNode
  const code = uncomment(text)
  const f: RbFacts = Object.assign(collect(root, empty(code.replace(/\s+/g, ' ')), new Map(), ''), { rb: { routes: [], draws: [], devise: [], classes: new Map(), methods: new Map(), schema: [], risks: new Set<string>() } as RbFacts['rb'] })
  f.todos = [...text.matchAll(/#\s*((TODO|FIXME|HACK)\b[^\n]*)/g)].map(m => m[1])
  const rb = f.rb

  // ---- routes ----
  type Ctx = { path: string; module: string; guard?: 'login' | 'unknown'; resource?: { base: string; item: string; controller: string }; on?: string; controller?: string; fallthrough?: boolean }   // on: inside a member / collection block; controller: scope controller: / controller :x do
  const concerns = new Map<string, N>()
  if (/(^|\/)config\/routes(\.rb|\/.+\.rb)$/.test(path)) {
    const top = /config\/routes\.rb$/.test(path) ? all(root, 'call').find(c => c.childForFieldName('method')?.text === 'draw' && /routes$/.test(c.childForFieldName('receiver')?.text ?? '')) : undefined
    walk(top ? blockBody(top) : root, { path: '', module: '' })
  }
  function walk(body: N | undefined, ctx: Ctx) {
    for (const st of body?.namedChildren ?? []) if (st?.type === 'call' || st?.type === 'identifier') route(st, ctx)
  }
  function route(c: N, ctx: Ctx) {
    const name = c.type === 'identifier' ? c.text : c.childForFieldName('method')?.text ?? '', { pos, opt } = c.type === 'call' ? argsOf(c) : { pos: [], opt: new Map<string, N>() }
    const inner = c.type === 'call' ? blockBody(c) : undefined
    const add = (method: string, p: string, controller: string, action: string, extra: Partial<RbRoute> = {}) => {
      for (const m of method === 'MATCH' ? vals(opt.get('via')).map(v => v.toUpperCase()).map(v => v === 'ALL' ? 'ANY' : v) : [method]) rb.routes.push({ method: m, path: rbPath(p), controller, action, guard: ctx.guard, at: c.startIndex, fallthrough: ctx.fallthrough, ...extra })
    }
    switch (name) {
      case 'namespace': { const n = val(pos[0]); if (n) walk(inner, { ...ctx, path: join(ctx.path, val(opt.get('path')) ?? n), module: `${ctx.module}${val(opt.get('module')) ?? n}/`, resource: undefined }); return }
      case 'scope': { const p = val(pos[0]) ?? val(opt.get('path')) ?? '', m = val(opt.get('module')), k = val(opt.get('controller')); walk(inner, { ...ctx, path: join(ctx.path, p), module: m ? `${ctx.module}${m}/` : ctx.module, controller: k ?? ctx.controller }); return }
      case 'controller': { const k = val(pos[0]); walk(inner, { ...ctx, controller: k ?? ctx.controller }); return }
      case 'defaults': case 'shallow': case 'with_options': case 'nested': walk(inner, ctx); return
      // a constraint that fails lets the request go on to later routes (and isn't a 401): plain can't tell, and a later route wins for guests
      case 'constraints': { const seg = !pos.some(p => p.type !== 'hash') && ![...opt.keys()].some(k => !/^(id|format|\w+_id)$/.test(k)); walk(inner, seg ? ctx : { ...ctx, guard: ctx.guard ?? 'unknown', fallthrough: true }); return }
      case 'authenticate': walk(inner, { ...ctx, guard: 'login' }); return   // Devise: guests are sent to sign in
      case 'authenticated': walk(inner, { ...ctx, guard: 'login', fallthrough: true }); return   // the route isn't there for guests: they go on to later routes
      case 'unauthenticated': case 'devise_scope': walk(inner, ctx); return
      case 'concern': { const n = val(pos[0]); if (n && inner) concerns.set(n, inner); return }
      case 'concerns': for (const n of pos.flatMap(vals)) walk(concerns.get(n), ctx); return
      case 'draw': { const n = val(pos[0]); if (n) rb.draws.push({ file: `${path.match(/^(.*?)config\/routes/)?.[1] ?? ''}config/routes/${n}.rb`, path: ctx.path, module: ctx.module, guard: ctx.guard, at: c.startIndex }); return }
      case 'resources': case 'resource': {
        const single = name === 'resource', only = opt.has('only') ? vals(opt.get('only')) : undefined, except = vals(opt.get('except'))
        for (const r of pos.flatMap(vals)) {
          const controller = `${ctx.module}${val(opt.get('module')) ? val(opt.get('module')) + '/' : ''}${val(opt.get('controller')) ?? (single ? plural(r) : r)}`
          const base = join(ctx.resource ? ctx.resource.item.replace(/\[id\]$/, `[${singular(ctx.resource.base.split('/').pop()!)}_id]`).replace(/:id$/, `:${singular(ctx.resource.base.split('/').pop()!)}_id`) : ctx.path, val(opt.get('path')) ?? r)
          const param = val(opt.get('param')) ?? 'id', item = single ? base : `${base}/:${param}`
          const acts: [string, string, string, boolean?][] = single
            ? [['show', 'GET', base], ['create', 'POST', base], ['new', 'GET', `${base}/new`, true], ['edit', 'GET', `${base}/edit`, true], ['update', 'PATCH', base], ['update', 'PUT', base], ['destroy', 'DELETE', base]]
            : [['index', 'GET', base], ['create', 'POST', base], ['new', 'GET', `${base}/new`, true], ['edit', 'GET', `${item}/edit`, true], ['show', 'GET', item], ['update', 'PATCH', item], ['update', 'PUT', item], ['destroy', 'DELETE', item]]
          for (const [action, method, p, html] of acts) if ((!only || only.includes(action)) && !except.includes(action)) add(method, p, controller, action, { htmlOnly: html })
          const here: Ctx = { ...ctx, resource: { base, item, controller }, on: undefined }
          for (const n of vals(opt.get('concerns'))) walk(concerns.get(n), here)
          walk(inner, here)
        }
        return
      }
      case 'member': case 'collection': walk(inner, { ...ctx, on: name }); return
      case 'root': { const to = val(opt.get('to')) ?? val(pos[0]); if (to?.includes('#')) add('GET', ctx.path || '/', `${ctx.module}${to.split('#')[0]}`, to.split('#')[1]); return }
      case 'devise_for': rb.devise.push(...pos.flatMap(vals)); return
      case 'mount': case 'direct': case 'resolve': return
    }
    if (!/^(get|post|patch|put|delete|options|match)$/.test(name)) return
    // get "photos/search" (photos#search), get "x", to: "c#a", get "x" => "c#a", get :preview, on: :member (inside resources)
    const hashForm = c.childForFieldName('arguments')?.namedChildren.find(x => x?.type === 'pair' && x.childForFieldName('key')?.type === 'string')
    const first = hashForm ? val(hashForm.childForFieldName('key')) : val(pos[0]), to = hashForm ? val(hashForm.childForFieldName('value')) : val(opt.get('to'))
    if (first === undefined) return
    const method = name === 'match' ? 'MATCH' : name.toUpperCase()
    const r = ctx.resource
    if (r && !hashForm && (!to || pos[0]?.type === 'simple_symbol' || opt.has('on') || ctx.on)) {
      const on = val(opt.get('on')) ?? ctx.on, p = on === 'member' ? `${r.item}/${first}` : on === 'collection' ? `${r.base}/${first}` : on === 'new' ? `${r.base}/new/${first}` : `${r.item.replace(/:(\w+)$/, `:${singular(r.base.split('/').pop()!)}_id`)}/${first}`
      add(method, p, to?.includes('#') ? `${ctx.module}${to.split('#')[0]}` : r.controller, to?.split('#')[1] ?? first); return
    }
    const p = join(r ? r.item.replace(/:(\w+)$/, `:${singular(r.base.split('/').pop()!)}_id`) : ctx.path, first)
    const action = hashForm && hashForm.childForFieldName('value')?.type === 'simple_symbol' ? val(hashForm.childForFieldName('value')) : undefined
    const target = action && ctx.controller ? `${ctx.controller}#${action}` : !to && !hashForm && ctx.controller ? `${ctx.controller}#${first.split('/').filter(x => x && !x.startsWith(':')).pop()}` : to ?? (val(opt.get('controller')) ? `${val(opt.get('controller'))}#${val(opt.get('action')) ?? first.split('/').pop()}` : first.replace(/^\//, '').replace(/\/(?=[^/]*$)/, '#'))
    if (!target.includes('#') || /^https?:|redirect\(/.test(target)) return
    add(method, p, `${to?.startsWith('/') ? '' : ctx.module}${target.split('#')[0].replace(/^\//, '')}`, target.split('#')[1])
  }

  // ---- classes and modules: callbacks, includes, methods ----
  const scopeName = (n: N, outer: string) => (outer ? outer + '::' : '') + n.childForFieldName('name')!.text
  const visit = (n: N, outer: string) => { for (const c of n.namedChildren) {
    if (!c) continue
    if (c.type === 'class' || c.type === 'module') { const name = scopeName(c, outer); klass(c, name, outer); visit(c.childForFieldName('body') ?? c, name) }
    else if (c.type === 'body_statement' || c.type === 'program') visit(c, outer)
  } }
  visit(root, '')
  function klass(c: N, name: string, outer: string) {
    const base = c.childForFieldName('superclass')?.namedChildren[0]?.text
    const info: RbClass = { base, outer, cbs: [], includes: [], api: /ActionController::API$/.test(base ?? ''), model: /^(ApplicationRecord|ActiveRecord::Base)$/.test(base ?? ''), csrfOff: [] }
    rb.classes.set(name, info)
    const body = c.childForFieldName('body')
    const statements = (b: N | undefined | null): N[] => (b?.namedChildren ?? []).filter((x): x is N => !!x)
    // a concern's `included do ... end` runs in the class that includes it: its callbacks are this module's
    const stmts = [...statements(body), ...statements(body).filter(s => s.type === 'call' && s.childForFieldName('method')?.text === 'included').flatMap(s => statements(blockBody(s)))]
    for (const st of stmts) {
      if (st.type === 'method') continue
      const m = st.type === 'call' ? st.childForFieldName('method')?.text : st.type === 'identifier' ? st.text : undefined
      if (!m || st.type === 'call' && st.childForFieldName('receiver')) continue
      const { pos, opt } = st.type === 'call' ? argsOf(st) : { pos: [] as N[], opt: new Map<string, N>() }
      const literal = (k: string) => !opt.has(k) || /^(array|symbol_array|string_array|simple_symbol|string)$/.test(opt.get(k)!.type)   // only: PUBLIC (a constant): plain can't tell
      const lim = { only: opt.has('only') ? vals(opt.get('only')) : undefined, except: opt.has('except') ? vals(opt.get('except')) : undefined, cond: opt.has('if') || opt.has('unless') || !literal('only') || !literal('except') }
      if (/^(before_action|prepend_before_action|append_before_action|around_action)$/.test(m)) {
        const lam = pos.find(p => p.type === 'lambda') ?? (st.childForFieldName('block') ?? undefined)
        for (const n of pos.flatMap(vals)) info.cbs.push({ kind: 'before', name: n, ...lim })
        if (lam) info.cbs.push({ kind: 'before', name: '?', body: lam.text, ...lim })
      }
      else if (m === 'skip_before_action') for (const n of pos.flatMap(vals)) info.cbs.push({ kind: 'skip', name: n, ...lim })
      else if (m === 'allow_unauthenticated_access') info.cbs.push({ kind: 'skip', name: 'require_authentication', ...lim })
      else if (m === 'http_basic_authenticate_with') info.cbs.push({ kind: 'before', name: '@basic', ...lim })
      else if (/^(load_and_authorize_resource|authorize_resource)$/.test(m)) info.cbs.push({ kind: 'before', name: '@policy', ...lim })
      else if (m === 'include') { info.includes.push(...pos.map(p => p.text)); for (const p of pos) info.cbs.push({ kind: 'include', name: p.text }) }   // where it is: its callbacks run from there
      else if (m === 'skip_forgery_protection' || m === 'protect_from_forgery' && (opt.has('except') || opt.has('only')))
        info.csrfOff.push(...(m === 'protect_from_forgery' ? lim.except ?? ['*'] : lim.only ?? ['*']))
    }
    for (const st of statements(body)) if (st.type === 'call' && st.childForFieldName('method')?.text === 'skip_before_action' && vals(argsOf(st).pos[0]).includes('verify_authenticity_token')) info.csrfOff.push(...(argsOf(st).opt.has('only') ? vals(argsOf(st).opt.get('only')) : ['*']))
    const tn = body?.text.match(/self\.table_name\s*=\s*["'](\w+)["']/)?.[1]; if (tn) info.table = tn
    // instance variables set anywhere in the class (set_order: @order = Order.find(...)) type the actions that use them
    const vars = types(c)
    for (const m of all(body ?? c, 'method')) {
      let up: N | null = m.parent; while (up && up.type !== 'class' && up.type !== 'module') up = up.parent
      if (up?.id !== c.id) continue
      const mname = m.childForFieldName('name')!.text, mb = m.childForFieldName('body')
      const g = collect(m, empty(m.text.replace(/\s+/g, ' ')), new Map([...vars, ...types(m)]), name, info.model)
      const tops: string[] = []
      for (const st of mb?.namedChildren ?? []) { if (!st || st.type === 'comment') continue
        if (st.type === 'identifier' || st.type === 'call' && !st.childForFieldName('receiver') && !st.childForFieldName('block')) tops.push(st.type === 'identifier' ? st.text : st.childForFieldName('method')!.text)
        else if (/\breturn\b|\bnext\b/.test(st.text) || /^(if|unless|case|if_modifier|unless_modifier|while|until|rescue_modifier)$/.test(st.type)) break }
      const ca: { admin?: boolean } = {}, ha: { admin?: boolean } = {}, check = userCheck(mb, false, ca), halts = userCheck(mb, true, ha)
      rb.methods.set(`${name}.${mname}`, Object.assign(g, { check: check === 'login' ? 'login' as const : check === 'unknown' ? 'unknown' as const : undefined, halts, tops,
        checkAdmin: check === 'login' && !!ca.admin, haltsAdmin: halts === 'login' && !!ha.admin }))
    }
  }

  // ---- migrations: what change/up does to the tables (down and dir.down ignored) ----
  if (/(^|\/)db\/(migrate\/[^/]+|schema)\.rb$/.test(path)) {
    const meths = /schema\.rb$/.test(path) ? [root] : all(root, 'method').filter(m => /^(change|up)$/.test(m.childForFieldName('name')?.text ?? ''))   // (schema.rb: the tables as they are)
    const skip = (n: N) => { for (let p: N | null = n.parent; p; p = p.parent) if (p.type === 'call' && p.childForFieldName('method')?.text === 'down' && p.childForFieldName('receiver')) return true; return false }
    const cols = (t: string, block: N | undefined, s: SchemaOp) => {
      for (const c of block ? all(block, 'call') : []) {
        if (c.childForFieldName('receiver')?.text !== t) continue
        const k = c.childForFieldName('method')!.text, { pos, opt } = argsOf(c), col = val(pos[0])
        if (k === 'timestamps') s.add.push('created_at', 'updated_at')
        else if (/^(references|belongs_to)$/.test(k) && col) s.add.push(`${col}_id`, `→${camel(col)}`)
        else if (k === 'remove' || k === 'remove_references') { s.drop.push(...pos.flatMap(vals)); s.loses = true }
        else if (k === 'rename' && col && val(pos[1])) s.renames.push([col, val(pos[1])!])
        else if (k === 'index' || k === 'remove_index') continue
        else if (col && /^(string|text|integer|bigint|float|decimal|numeric|boolean|date|datetime|time|timestamp|json|jsonb|binary|uuid|column|money|inet|citext|enum|virtual)$/.test(k)) { s.add.push(col); if (opt.get('null')?.text === 'true' || !opt.has('null')) (s.nullable ??= []).push(col) }
      }
    }
    for (const m of meths) for (const c of all(m, 'call')) {
      if (c.childForFieldName('receiver') || skip(c)) continue
      const k = c.childForFieldName('method')!.text, { pos, opt } = argsOf(c), table = val(pos[0])
      if (!table && k !== 'execute') continue
      const op = (o: Partial<SchemaOp>): SchemaOp => ({ op: 'table', table: table ?? '', add: [], drop: [], renames: [], loses: false, ...o })
      if (k === 'create_table') { const s = op({ op: 'create', add: opt.get('id')?.text === 'false' ? [] : ['id'] }); if (opt.has('force') && opt.get('force')!.text !== 'false') rb.schema.push(op({ op: 'drop', loses: true })); cols(c.childForFieldName('block')?.childForFieldName('parameters')?.namedChildren[0]?.text ?? 't', c.childForFieldName('block') ?? undefined, s); rb.schema.push(s) }
      else if (k === 'change_table') { const s = op({}); cols(c.childForFieldName('block')?.childForFieldName('parameters')?.namedChildren[0]?.text ?? 't', c.childForFieldName('block') ?? undefined, s); rb.schema.push(s) }
      else if (k === 'drop_table' || k === 'drop_join_table') rb.schema.push(op({ op: 'drop', loses: true }))
      else if (k === 'rename_table' && val(pos[1])) rb.schema.push(op({ op: 'rename', to: val(pos[1]) }))
      else if (k === 'add_column' && val(pos[1])) rb.schema.push(op({ add: [val(pos[1])!], nullable: opt.get('null')?.text === 'false' ? [] : [val(pos[1])!] }))
      else if (k === 'add_reference' || k === 'add_belongs_to') { const r = val(pos[1]); if (r) rb.schema.push(op({ add: [`${r}_id`, `→${camel(r)}`], nullable: opt.get('null')?.text === 'false' ? [] : [`${r}_id`] })) }
      else if (k === 'add_timestamps') rb.schema.push(op({ add: ['created_at', 'updated_at'] }))
      else if (/^remove_(column|columns|reference|belongs_to|timestamps)$/.test(k)) rb.schema.push(op({ drop: k === 'remove_timestamps' ? ['created_at', 'updated_at'] : /reference|belongs_to/.test(k) ? [`${val(pos[1])}_id`] : k === 'remove_columns' ? pos.slice(1).flatMap(vals) : [val(pos[1]) ?? ''], loses: true }))
      else if (k === 'rename_column' && val(pos[1]) && val(pos[2])) rb.schema.push(op({ renames: [[val(pos[1])!, val(pos[2])!]] }))
      else if (k === 'change_column') rb.schema.push(op({ loses: true }))
      else if (/^(add_index|remove_index|rename_index)$/.test(k)) rb.schema.push(op({ indexOnly: !(k === 'add_index' && /unique:\s*true/.test(c.text)) }))
      else if (k === 'execute' && /\b(DELETE|DROP|TRUNCATE|UPDATE)\b/i.test(c.text)) rb.schema.push(op({ table: '', loses: true }))
    }
    if (meths.some(m => /\b[A-Z]\w*\.(delete_all|destroy_all|update_all)\b/.test(m.text))) rb.schema.push({ op: 'table', table: '', add: [], drop: [], renames: [], loses: true })
  }

  // ---- risks ----
  // mass assignment: params.permit!, params.expect(order: {}) / permit(x: {}), to_unsafe_h, permitting role/admin fields
  if (/\bpermit!|\bto_unsafe_h\b|permit_all_parameters\s*=\s*true|(?:expect|permit)\([^)]*\w+:\s*\{\s*\}/.test(code)) f.rb.risks.add('mass')
  if (!/(^|\/)controllers\/admin\//.test(path) && /(?:permit|expect)\([^)]*:(?:role|admin|is_admin|superuser)\b/.test(code)) f.rb.risks.add('massField')
  // SQL built by pasting text into where/find_by_sql/execute
  if (/\.(where|find_by_sql|execute|order|group|having|joins|select|pluck)\s*\(\s*["'][^"']*#\{/.test(code)) f.rb.risks.add('sql')
  // CORS for every site, with cookies (a regex matching all, or a block that's true); "*" with credentials doesn't even boot
  if (/Rack::Cors/.test(code) && /credentials:\s*true/.test(code) && /origins\s+(\/\.\*\/|\{[^}]*true\s*\}|->)/.test(code)) f.rb.risks.add('corsCreds')
  if (/(^|\/)config\/environments\/production\.rb$|(^|\/)config\/application\.rb$/.test(path)) {
    if (/allow_forgery_protection\s*=\s*false|default_protect_from_forgery\s*=\s*false/.test(code)) f.rb.risks.add('csrfAll')
    if (/consider_all_requests_local\s*=\s*true/.test(code) && /production\.rb$/.test(path)) f.rb.risks.add('debug')
  }
  if (/http_basic_authenticate_with[^\n]*password:\s*["'][^"']+["']/.test(code)) f.rb.risks.add('basicPassword')
  return f

  // the type of each variable: @order = Order.find(...) / Order.new(...) / Order.create(...); current_user.orders.build -> @rel:orders
  function types(n: N): Map<string, string> {
    const out = new Map<string, string>()
    for (const a of all(n, 'assignment')) {
      const l = a.childForFieldName('left')?.text, r = a.childForFieldName('right')
      if (!l || !r) continue
      let x: N | null = r
      while (x?.type === 'call' && x.childForFieldName('receiver')) x = x.childForFieldName('receiver')
      if (x?.type === 'constant' || x?.type === 'scope_resolution') out.set(l, (/\.new\b/.test(r.text) && r.childForFieldName('method')?.text === 'new' ? 'new:' : '') + x.text)
      else if (r.type === 'call' && /^(build|new|create|create!|find|find_by|find_by!|first|last)$/.test(r.childForFieldName('method')?.text ?? '') && r.childForFieldName('receiver')?.type === 'call') out.set(l, `${/^(build|new)$/.test(r.childForFieldName('method')!.text) ? 'new:' : ''}@rel:${r.childForFieldName('receiver')!.childForFieldName('method')?.text ?? ''}`)
    }
    return out
  }
  // Facts from one subtree: Active Record reads and writes, Stripe, Pay, mailers, ENV and credentials, calls into other classes.
  function collect(node: N, g: FileFacts, vars: Map<string, string>, self: string, isModel = false): FileFacts {
    const tag = (m: string) => m.startsWith('@') ? m : `@m:${m.split('::').pop()}`
    const write = (m: string | undefined, op: string) => { if (!m) return; g.tables.add(tag(m)); g.written.add(tag(m)); g.writes = true; g.ops.add(op) }
    // what a receiver is: a model constant (Order), a typed variable (@order), an association (current_user.orders), self in a model
    const model = (n: N | null | undefined): string | undefined => {
      if (!n) return undefined
      if (n.type === 'constant' || n.type === 'scope_resolution') return VENDOR.test(n.text) ? undefined : n.text   // (Stripe::Refund.create isn't a table)
      if (/^(instance_variable|identifier)$/.test(n.type)) return vars.get(n.text)?.replace(/^new:/, '') ?? (n.text === 'current_user' || n.text === 'Current.user' ? 'User' : undefined)
      if (n.type === 'self') return isModel ? self : undefined
      if (n.type === 'call') { const m = n.childForFieldName('method')?.text ?? '', r = n.childForFieldName('receiver')
        if (m === 'new') return model(r)
        if (n.text === 'Current.user') return 'User'
        if (/^(where|where\.not|order|includes|joins|limit|offset|find|find_by|find_by!|first|last|all|lock|preload|eager_load|not|select|find_or_initialize_by)$/.test(m)) return model(r)
        if (r && !n.childForFieldName('arguments') && model(r) && /^[a-z_]+$/.test(m) && m.endsWith('s')) return `@rel:${m}` }   // current_user.orders
      return undefined
    }
    // block parameters of a model's each / find_each (Order.find_each { |o| o.destroy }) are that model
    for (const c of all(node, 'call')) if (/^(each|find_each|find_in_batches|each_with_index|map)$/.test(c.childForFieldName('method')?.text ?? '')) {
      const t = model(c.childForFieldName('receiver')), p = c.childForFieldName('block')?.childForFieldName('parameters')?.namedChildren[0]?.text
      if (t && p) vars.set(p, t)
      if (t && /&:(destroy|delete)\b/.test(c.childForFieldName('arguments')?.text ?? '')) write(t, 'delete')
    }
    for (const c of all(node, 'call')) {
      const m = c.childForFieldName('method')?.text ?? '', r = c.childForFieldName('receiver'), t = c.text
      g.used.add(m)
      // a model's own method writing itself: update!(status: ...) / save / destroy with no receiver
      if (!r && isModel && /^(update|update!|update_column|update_columns|update_attribute|save|save!|destroy|destroy!|delete|touch|increment!|decrement!|toggle!)$/.test(m)) write(self, /destroy|delete/.test(m) ? 'delete' : 'update')
      // Stripe (stripe-ruby, legacy and client styles), Pay
      if (/^Stripe::Checkout::Session$/.test(r?.text ?? '') && m === 'create' || /\.checkout\.sessions$/.test(r?.text ?? '') && m === 'create') { g.money = true; g.services.add('Stripe'); g.outside.add('Stripe: checkout.sessions.create') }
      if (/^Stripe::(PaymentIntent|Charge|Subscription)$/.test(r?.text ?? '') && m === 'create' || /\.(payment_intents|charges|subscriptions)$/.test(r?.text ?? '') && m === 'create') { g.money = true; g.services.add('Stripe') }
      if (r?.text === 'Stripe::Refund' && m === 'create' || /\.refunds$/.test(r?.text ?? '') && m === 'create') { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
      if (r?.text === 'Stripe::Webhook' && m === 'construct_event') { g.services.add('Stripe'); g.outside.add('Stripe: webhooks.constructEvent') }
      if (/payment_processor$/.test(r?.text ?? '') && /^(charge|checkout|subscribe)$/.test(m)) { g.money = true; g.services.add('Stripe') }
      if (m === 'refund!' && /charge/.test(r?.text ?? '')) { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
      // email: OrderMailer.with(...).confirmation.deliver_later
      if (/^deliver_(later|now)!?$/.test(m) && /Mailer\b/.test(t)) { g.services.add('email'); g.outside.add('email: send') }
      // ENV.fetch("X") is required; ENV.fetch("X", default) / with a block isn't; credentials need RAILS_MASTER_KEY
      if (r?.text === 'ENV' && m === 'fetch') { const k = val(argsOf(c).pos[0]); if (k) { g.env.add(k); if (argsOf(c).pos.length < 2 && !c.childForFieldName('block')) g.envReq.add(k) } }
      if (/credentials$/.test(r?.text ?? '') || /^Rails\.application\.credentials/.test(t)) { g.env.add('RAILS_MASTER_KEY'); g.envReq.add('RAILS_MASTER_KEY') }
      // "no" messages: render json: { error: "..." }, status: :unprocessable_entity
      if (m === 'render' && /status:\s*(:unprocessable_entity|:unprocessable_content|:conflict|:bad_request|:payment_required|422|409|400|402)\b/.test(t)) { const msg = t.match(/(?:error|message):\s*["']([^"'#]+)["']/)?.[1]; if (msg) g.refuses.add(msg) }
      // Active Record
      const target = model(r)
      if (target && /^(create|create!|insert|insert!|insert_all|insert_all!|find_or_create_by|find_or_create_by!|create_or_find_by|create_or_find_by!|build)$/.test(m) && m !== 'build') write(target, 'create')
      else if (target && /^(upsert|upsert_all|update_all|update|update!|update_attribute|update_attributes|update_column|update_columns|increment!|decrement!|toggle!|touch)$/.test(m)) write(target, 'update')
      else if (target && /^(save|save!)$/.test(m)) write(target, vars.get(r?.text ?? '')?.startsWith('new:') ? 'create' : 'update')
      else if (target && /^(destroy|destroy!|delete|delete_all|destroy_all|destroy_by|delete_by)$/.test(m)) write(target, 'delete')
      else if (target && /^[A-Z@]/.test(target) && /^(find|find_by|find_by!|where|all|first|last|order|includes|count|sum|pluck|exists\?|find_each|each|map|limit|page|joins|select|ids|average|minimum|maximum|take|preload|eager_load|find_or_initialize_by)$/.test(m)) g.tables.add(tag(target))   // a read (not an association's accessor)
      // calls into other classes (OrderCanceller.new(order).call, PricingService.quote(...)) and this class's own methods
      const recv = r?.type === 'call' && r.childForFieldName('method')?.text === 'new' ? r.childForFieldName('receiver') : r
      if ((recv?.type === 'constant' || recv?.type === 'scope_resolution') && !VENDOR.test(recv.text)) g.used.add(`rcall:${recv.text}.${m}`)
      if (!r || r.type === 'self') g.used.add(`rcall:${self}.${m}`)
      else if (target && !target.startsWith('@') && /^[a-z_]+[!?]?$/.test(m)) g.used.add(`rcall:${target}.${m}`)   // order.cancel! (a model's own method)
    }
    for (const id of all(node, 'identifier')) if (id.parent?.type === 'body_statement' || id.parent?.type === 'then' || id.parent?.type === 'else') g.used.add(`rcall:${self}.${id.text}`)   // set_order (a bare call)
    // ENV["X"] (optional)
    for (const e of all(node, 'element_reference')) if (e.childForFieldName('object')?.text === 'ENV') { const k = val(e.namedChildren[1]); if (k) g.env.add(k) }
    g.emptyCatch += all(node, 'rescue').filter(r => !r.namedChildren.some(c => c?.type === 'then' && c.namedChildren.length)).length
    return g
  }
}
