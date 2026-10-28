#!/usr/bin/env node
// plain v0: what changed in your app compared to a git ref. Static facts, no AI.
//
//   plain [ref] [--asked "what you asked for"]   ref defaults to HEAD (uncommitted work)
//   plain --hook                                  Claude Code Stop hook: reads the last prompt
//
// ponytail: Next.js (app/ and pages/), Express-style servers, React Router, Prisma, Supabase, Stripe. Each framework is one more fact extractor.
import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readDb, findings, isMigration, ownOnly, type Db } from './supabase.ts'
import { pyFacts, type PyFacts } from './python.ts'

export type Snap = Map<string, string>

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })

// ponytail: one `git show` per file, fine for app-sized repos; use `git archive` if it gets slow
export function snapshot(cwd: string, ref: string | null): Snap {
  const list = ref ? git(['ls-tree', '-r', '--name-only', ref], cwd) : git(['ls-files', '-co', '--exclude-standard'], cwd)
  const snap: Snap = new Map()
  for (const f of list.split('\n').filter(Boolean)) {
    if (ref) snap.set(f, git(['show', `${ref}:${f}`], cwd))
    else if (existsSync(join(cwd, f))) snap.set(f, readFileSync(join(cwd, f), 'utf8'))
  }
  return snap
}

// ---------- facts from one file ----------

const AUTH = new Set(['auth', 'getServerSession', 'getUser', 'currentUser', 'requireAdmin', 'requireUser'])
// npm:stripe@14, https://esm.sh/stripe@14?target=deno, jsr:@supabase/supabase-js@2 (Deno, edge functions) -> the package name
const pkgName = (m: string) => m.replace(/^(npm:|jsr:|https:\/\/esm\.sh\/)/, '').replace(/\?.*$/, '').replace(/(.)@[^/]*$/, '$1')
const SB_OPS: Record<string, string> = { insert: 'create', update: 'update', upsert: 'create', delete: 'delete' }   // upsert: adds (or updates if it's there)
const WRITES = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/
const SERVICES: Record<string, string> = {
  stripe: 'Stripe', openai: 'OpenAI', '@anthropic-ai/sdk': 'Anthropic', resend: 'Resend',
  '@supabase/supabase-js': 'Supabase', nodemailer: 'email', twilio: 'Twilio', '@vercel/blob': 'Vercel Blob',
  '@sendgrid/mail': 'SendGrid', postmark: 'Postmark',
}
// Services called straight over the web: fetch('https://api.resend.com/emails', ...)
const HOSTS: Record<string, string> = {
  'api.resend.com': 'Resend', 'api.stripe.com': 'Stripe', 'api.openai.com': 'OpenAI', 'api.anthropic.com': 'Anthropic',
  'api.sendgrid.com': 'SendGrid', 'api.postmarkapp.com': 'Postmark', 'api.twilio.com': 'Twilio', 'hooks.slack.com': 'Slack',
}
const EMAIL = new Set(['Resend', 'SendGrid', 'Postmark', 'email'])
// ponytail: client variable names by convention; follow imports if apps name them differently
const CLIENTS: Record<string, string> = { stripe: 'Stripe', openai: 'OpenAI', anthropic: 'Anthropic', resend: 'Resend' }   // supabase.* is the database: read as tables
const CODE = /\.([cm]?[jt]sx?|py)$/
const NOISE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/
const printer = ts.createPrinter({ removeComments: true })

export type FileFacts = {
  fns: Map<string, string>; used: Set<string>; jsx: Set<string>; services: Set<string>
  tables: Set<string>; ops: Set<string>; writes: boolean; sbAuth: boolean; env: Set<string>; auth: boolean; money: boolean   // sbAuth: supabase.auth.getUser(), a real check only on a server
  emptyCatch: number; todos: string[]; hardcoded: string[]; anys: number; printed: string
  texts: Set<string>; refuses: Set<string>; envReq: Set<string>; exports: Set<string>   // words on screen ("[price]" for a formatted price); "no" messages (4xx); env vars without a fallback
  serverFns: Map<string, string>; serverRoute: boolean; serverGuard: boolean; pageGuard: boolean; middleware: Map<string, boolean>   // TanStack Start; middleware: name -> does it stop people?
  outside: Set<string>; links: Set<string>; fetches: Set<string>; ui: Set<string>; imports: string[]; written: Set<string>; headings: string[]; forms: number
  binds: Map<string, string>; locals: Map<string, FileFacts>                 // name -> module it came from; top-level functions
  handlers: { server: string; method: string; path: string; guard: boolean; mw: string[]; handler?: string; facts: FileFacts; own?: string; imported?: boolean }[]  // Express-style routes, server actions, Python routes (own: the router's prefix)
  mounts: { server: string; path: string; target: string; guard: boolean; guardLike: boolean; attr?: string; override?: boolean }[]  // app.use('/api/x', [guards], router | require('./x')); Python: include_router / register_blueprint
  pages: { path: string; comp: string; guard: boolean }[]                     // React Router <Route> / { path, element }
  calls: { name: string; path: string; method: string; prop: boolean }[]      // api('/x'), http.post('/x'): resolved against wrappers later
  wrappers: Map<string, string>                                               // fetch helpers and their address prefix: api() -> '/api'
}

export const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const isExported = (n: ts.Node) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)

const HTTP = /^(get|post|put|patch|delete)$/
const SERVER = /^(express(\.Router)?|Router|fastify|Fastify|new Hono|require\(['"]express['"]\)(\.Router)?)\(/   // what makes a variable a server/router
const GUARD = /auth|admin|protect|login|logged|token|jwt|session|private/i   // server middleware that checks who you are
const NOT_GUARD = /(^|\.)session\(|passport\.(initialize|session)|cookie|csrf|cors|helmet|(routes?|router)$/i   // sets up sessions or mounts routes; checks nothing
const PAGE_GUARD = /auth|protect|private|require|guard|signedin|loggedin/i   // client wrapper that does
const empty = (printed = ''): FileFacts => ({
  fns: new Map(), used: new Set(), jsx: new Set(), services: new Set(), tables: new Set(), ops: new Set(),
  writes: false, sbAuth: false, env: new Set(), auth: false, money: false, emptyCatch: 0, todos: [], hardcoded: [], anys: 0, printed,
  outside: new Set(), links: new Set(), fetches: new Set(), ui: new Set(), imports: [], written: new Set(), headings: [], forms: 0,
  binds: new Map(), locals: new Map(), handlers: [], mounts: [], pages: [], calls: [], wrappers: new Map(),
  texts: new Set(), refuses: new Set(), envReq: new Set(), exports: new Set(),
  serverFns: new Map(), serverRoute: false, serverGuard: false, pageGuard: false, middleware: new Map(),
})
// Code that can turn someone away: throw, redirect, a 401/403, "unauthorized"
const STOPS = /\bthrow\b|redirect\s*\(|\b40[13]\b|unauthori[sz]ed|forbidden/i
const fnLike = (n?: ts.Node) => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))
// `process.env.PORT || 3001` has a real default; `|| ''` or `?? undefined` only quiets TypeScript, the value is still needed
const hasDefault = (n: ts.Node) => ts.isBinaryExpression(n.parent) && n.parent.left === n && /^(\|\||\?\?)$/.test(n.parent.operatorToken.getText())
  && !/^(''|""|``|null|undefined)$/.test(n.parent.right.getText().trim())

export function fileFacts(path: string, text: string): FileFacts {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    /tsx$/.test(path) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JSX)
  const f = collect(sf, sf, empty(printer.printFile(sf)))
  f.todos = text.match(/\/\/\s*(TODO|FIXME|HACK)\b[^\n]*/g)?.map(t => t.replace(/^\/\/\s*/, '')) ?? []
  const addFn = (name: string, node: ts.Node) => {
    f.fns.set(name, printer.printNode(ts.EmitHint.Unspecified, node, sf))
    if (/^(get|fetch|load|list)[A-Z]/.test(name) && returnsLiteralOnly(node)) f.hardcoded.push(name)
  }
  for (const st of sf.statements) {
    if (isExported(st) && ts.isVariableStatement(st))   // export const POST = withErrors(async () => ...)
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && METHODS.includes(d.name.text) && d.initializer && ts.isCallExpression(d.initializer))
        f.fns.set(d.name.text, printer.printNode(ts.EmitHint.Unspecified, d.initializer, sf))
    if (isExported(st)) for (const d of ts.isVariableStatement(st) ? st.declarationList.declarations : [st as ts.DeclarationStatement])
      if (d.name && ts.isIdentifier(d.name)) f.exports.add(d.name.text)
    const fns: [string, ts.Node][] = ts.isFunctionDeclaration(st) && st.name ? [[st.name.text, st]]
      : ts.isVariableStatement(st) ? st.declarationList.declarations.filter(d => ts.isIdentifier(d.name) && fnLike(d.initializer)).map(d => [(d.name as ts.Identifier).text, d.initializer!])
      : []
    for (const [name, node] of fns) {
      f.locals.set(name, collect(sf, node, empty(printer.printNode(ts.EmitHint.Unspecified, node, sf))))
      const param = (node as ts.FunctionLikeDeclaration).parameters[0]?.name.getText(sf)
      const wraps = (n: ts.Node): string | undefined => {
        if (ts.isCallExpression(n) && n.expression.getText(sf) === 'fetch') {
          const a = n.arguments[0]
          if (a && ts.isTemplateExpression(a) && a.templateSpans[0].expression.getText(sf) === param) return a.head.text
        }
        return ts.forEachChild(n, wraps)
      }
      const pre = param && wraps(node)
      if (pre !== undefined && pre !== '') f.wrappers.set(name, pre)
      if (isExported(st)) addFn(name, node)
    }
  }
  return f
}

// Facts from one subtree: a whole file, one function, or one route handler.
const CLIENT_MAKER = /^(await\s+)?(createClient|createServerClient|createBrowserClient|\w*[Ss]upabase\w*)\s*(<[^>]*>)?\(/
const clientsOf = new WeakMap<ts.SourceFile, Set<string>>()   // one set per file: a client made at the top is used inside handlers
function collect(sf: ts.SourceFile, root: ts.Node, f: FileFacts): FileFacts {
  const servers = new Set<string>(), guarded = new Set<string>()
  let sbClients = clientsOf.get(sf)
  if (!sbClients) {
    clientsOf.set(sf, sbClients = new Set())
    for (const st of sf.statements) if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.initializer && CLIENT_MAKER.test(d.initializer.getText(sf))) sbClients.add(d.name.text)
  }
  const isGuard = (a: ts.Node) => !fnLike(a) && GUARD.test(a.getText(sf)) && !NOT_GUARD.test(a.getText(sf))
  const addHandler = (server: string, method: string, path: string, mw: readonly ts.Expression[], h: ts.Expression) =>
    f.handlers.push({ server, method: method.toUpperCase(), path, guard: guarded.has(server) || mw.some(isGuard), mw: mw.map(m => m.getText(sf)),
      handler: ts.isIdentifier(h) ? h.text : undefined, facts: fnLike(h) ? collect(sf, h, empty(printer.printNode(ts.EmitHint.Unspecified, h, sf))) : empty(h.getText(sf)) })
  const labelFor = new Map<string, string>(), boxes: { id?: string; type: string; v?: string; aria: boolean }[] = []
  const str = (e?: ts.Node) => e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text
    : e && ts.isTemplateExpression(e) ? e.head.text + e.templateSpans.map(t => '[…]' + t.literal.text).join('') : undefined
  const visit = (n: ts.Node) => {
    // TanStack Start server action: const book = createServerFn({ method: 'POST' }).middleware([auth]).validator(...).handler(async () => ...)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && /^createServerFn\b/.test(n.initializer.getText(sf))) {
      let method = 'GET', h: ts.Expression | undefined
      const mw: ts.Expression[] = []
      for (let c: ts.Node = n.initializer; ts.isCallExpression(c); c = ts.isPropertyAccessExpression(c.expression) ? c.expression.expression : c.expression) {
        const name = ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : c.expression.getText(sf), a0 = c.arguments[0]
        if (name === 'handler') h = a0
        if (name === 'middleware' && a0 && ts.isArrayLiteralExpression(a0)) mw.push(...a0.elements)
        if (name === 'createServerFn' && a0 && ts.isObjectLiteralExpression(a0))
          method = str((a0.properties.find(q => ts.isPropertyAssignment(q) && q.name.getText(sf) === 'method') as ts.PropertyAssignment | undefined)?.initializer)?.toUpperCase() ?? 'GET'
      }
      if (h) { addHandler('', method, `(server action) ${n.name.text}`, mw, h); f.serverFns.set(n.name.text, method); return }
    }
    if (ts.isPropertyAssignment(n) || ts.isMethodDeclaration(n)) {
      const key = n.name.getText(sf), val = ts.isPropertyAssignment(n) ? n.initializer : n
      // createFileRoute('/api/x')({ server: { middleware: [auth], handlers: { GET, POST } } })
      if (key === 'handlers' && ts.isObjectLiteralExpression(n.parent) && ts.isPropertyAssignment(n.parent.parent) && n.parent.parent.name.getText(sf) === 'server') {
        f.serverRoute = true
        const methods = (o: ts.Node): void => { if (ts.isObjectLiteralExpression(o)) for (const q of o.properties) if (q.name && METHODS.includes(q.name.getText(sf))) f.fns.set(q.name.getText(sf), q.getText(sf)); ts.forEachChild(o, methods) }
        methods(val)
      }
      if (key === 'middleware' && ts.isArrayLiteralExpression(val) && ts.isObjectLiteralExpression(n.parent) && ts.isPropertyAssignment(n.parent.parent) && n.parent.parent.name.getText(sf) === 'server'
        && val.elements.some(isGuard)) f.serverGuard = true
      // beforeLoad: () => { if (!context.user) throw redirect({ to: '/login' }) }: hides the page, doesn't protect its data
      if (key === 'beforeLoad' && /redirect\s*\(|\bthrow\b/.test(val.getText(sf)) && /user|auth|session|login|sign ?in|claims/i.test(val.getText(sf))) f.pageGuard = true
      // createStart(() => ({ functionMiddleware: [authMiddleware] })): every server action (or request) checks login
      // (app-wide functionMiddleware / requestMiddleware can't block logged-out people, or signing in would break: not a check)
    }
    // legacy: createServerFileRoute('/api/x').methods({ GET, POST })
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'methods' && /^createServerFileRoute\b/.test(n.expression.expression.getText(sf))
      && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
      f.serverRoute = true
      for (const q of n.arguments[0].properties) if (q.name && METHODS.includes(q.name.getText(sf))) f.fns.set(q.name.getText(sf), q.getText(sf))
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      const arg = str(n.arguments[0])?.replace(/^\[…\]/, '')
      // fetch(url, { method: 'POST' }): GET when there are no options, '?' when they aren't written out
      const opt = n.arguments[1], prop = opt && ts.isObjectLiteralExpression(opt) ? opt.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'method') as ts.PropertyAssignment | undefined : undefined
      const method = !opt ? 'GET' : ts.isObjectLiteralExpression(opt) ? (prop ? str(prop.initializer)?.toUpperCase() ?? '?' : 'GET') : '?'
      if (ts.isIdentifier(callee)) {
        f.used.add(callee.text)
        if (AUTH.has(callee.text)) f.auth = true
        if (callee.text === 'fetch' && arg?.startsWith('/')) f.fetches.add(`${method} ${arg.split('?')[0]}`)
        const host = callee.text === 'fetch' && HOSTS[arg?.match(/^https?:\/\/([^/]+)/)?.[1] ?? '']
        if (host) { f.services.add(host); f.outside.add(`${host}: ${EMAIL.has(host) ? 'emails.send' : 'request'}`) }
        else if (callee.text === 'navigate' && arg?.startsWith('/')) f.links.add(arg)
        else if (/^(require|get|read|must)?_?env(ironment)?(_?var(iable)?)?$/i.test(callee.text) && arg && /^[A-Z][A-Z0-9_]*(_|KEY|SECRET|URL|TOKEN)[A-Z0-9_]*$/.test(arg) && arg !== 'NODE_ENV') {
          f.env.add(arg); if (n.arguments.length === 1) f.envReq.add(arg)   // requireEnv('STRIPE_KEY'); env('X', 'default') has a default
        }
        else if (arg?.startsWith('/') && callee.text !== 'require') f.calls.push({ name: callee.text, path: arg.split('?')[0], method, prop: false })
        if (callee.text === 'require' && arg) { f.imports.push(arg); if (SERVICES[arg]) f.services.add(SERVICES[arg]) }
      } else if (ts.isPropertyAccessExpression(callee)) {
        const parts = callee.getText(sf).replace(/\s|\?/g, '').split('.')
        const obj = parts.slice(0, -1).join('.'), last = parts.at(-1)!, args = n.arguments
        const chain = obj.match(/^([\w$]+)\.route\((['"`])([^'"`]+)\2\)/)   // app.route('/x').get(h).post(h)
        if (servers.has(obj) && last === 'use') {
          const t = args.at(-1)!, spec = ts.isCallExpression(t) && t.expression.getText(sf) === 'require' ? str(t.arguments[0]) : undefined
          // app.use('/api/x', thing): a router, or a login check for everything under /api/x. appFacts decides by looking at the file.
          if (arg?.startsWith('/') && (ts.isIdentifier(t) || spec)) f.mounts.push({ server: obj, path: arg, target: spec ?? t.getText(sf),
            guard: guarded.has(obj) || args.slice(1, -1).some(isGuard), guardLike: args.length === 2 && !spec && isGuard(t) })
          else if (!arg && args.some(isGuard)) guarded.add(obj)
        } else if (servers.has(obj) && HTTP.test(last) && arg?.startsWith('/') && args.length > 1) {
          addHandler(obj, last, arg, args.slice(1, -1), args.at(-1)!)
          return   // the handler's facts belong to the route, not to the whole file
        } else if (chain && servers.has(chain[1]) && HTTP.test(last) && args.length) {
          addHandler(chain[1], last, chain[3], args.slice(0, -1), args.at(-1)!)
          visit(callee.expression)   // the earlier .get(h) in the chain
          return
        } else if (HTTP.test(last) && arg?.startsWith('/') && !servers.has(obj)) f.calls.push({ name: obj, path: arg.split('?')[0], method: last.toUpperCase(), prop: true })   // axios.get('/api/x')
        const code = (e?: ts.Node) => e && ts.isNumericLiteral(e) ? +e.text : 0
        const msg = (e?: ts.Node) => e && (str(e) ?? (ts.isObjectLiteralExpression(e)
          ? str((e.properties.find(p => ts.isPropertyAssignment(p) && /^(message|error)$/.test(p.name.getText(sf))) as ts.PropertyAssignment | undefined)?.initializer) : undefined))
        const statusCall = ts.isCallExpression(callee.expression) && ts.isPropertyAccessExpression(callee.expression.expression) && callee.expression.expression.name.text === 'status'
          ? code(callee.expression.arguments[0]) : 0
        const nextStatus = last === 'json' && args[1] && ts.isObjectLiteralExpression(args[1])
          ? code((args[1].properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'status') as ts.PropertyAssignment | undefined)?.initializer) : 0
        const st = statusCall || nextStatus
        if (st >= 400 && st < 500 && ![401, 403, 404].includes(st) && /^(json|send)$/.test(last) && msg(args[0]) && !msg(args[0])!.includes('[…]')) f.refuses.add(msg(args[0])!)   // 401/403: login, said elsewhere; 404: noise
        // Supabase: supabase.from('orders').update(...), and edge functions called with supabase.functions.invoke('name')
        const from = ts.isCallExpression(callee.expression) && ts.isPropertyAccessExpression(callee.expression.expression) && callee.expression.expression.name.text === 'from'
          ? { table: str(callee.expression.arguments[0]), on: callee.expression.expression.expression.getText(sf) } : undefined
        if (from?.table && (sbClients.has(from.on) || /supabase|client|^sb$/i.test(from.on)) && !/storage$/.test(from.on) && /^(select|insert|update|upsert|delete)$/.test(last)) {
          f.tables.add(from.table)
          if (SB_OPS[last]) { f.writes = true; f.written.add(from.table); f.ops.add(SB_OPS[last]) }
        }
        if (last === 'invoke' && /functions$/.test(obj) && arg) f.fetches.add(`POST /functions/v1/${arg}`)
        if (obj === 'Deno.env' && last === 'get' && arg) {
          f.env.add(arg)
          if (!hasDefault(n)) f.envReq.add(arg)
        }
        if (/^(getUser|getSession|getClaims)$/.test(last) && /auth$/.test(obj)) f.sbAuth = true   // supabase.auth.getUser()
        if (/^(prisma|db)$/.test(parts[0]) && parts.length === 3 && !parts[1].startsWith('$') && !parts[1].includes('(')) {
          f.tables.add(cap(parts[1]))
          if (WRITES.test(parts[2])) { f.writes = true; f.written.add(cap(parts[1])); f.ops.add(parts[2].replace(/Many$/, '').replace('upsert', 'create')) }
        }
        if (parts[0] === 'stripe' && parts.at(-1) === 'create') f.money = true
        if (CLIENTS[parts[0]] && parts.length > 1 && !parts.some(x => x.includes('('))) f.outside.add(`${CLIENTS[parts[0]]}: ${parts.slice(1).join('.')}`)
        if (parts.at(-1) === 'push' && /router/.test(parts[0]) && str(n.arguments[0])?.startsWith('/')) f.links.add(str(n.arguments[0])!)
      }
    }
    // new HttpError(409, 'That time is taken'), fail(400, '...'), createError(400, '...')
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments?.length === 2 && ts.isNumericLiteral(n.arguments[0]) && str(n.arguments[1])
      && /(Error|^fail|^abort|^reject|^createError|^httpError)$/i.test(n.expression.getText(sf).split('.').at(-1)!)) {
      const c = +n.arguments[0].text, m = str(n.arguments[1])!
      if (c >= 400 && c < 500 && ![401, 403, 404].includes(c) && !m.includes('[…]')) f.refuses.add(m)
    }
    if (ts.isPropertyAccessExpression(n) && /^(process|import\.meta)\.env$/.test(n.expression.getText(sf))) {
      f.env.add(n.name.text)
      // `process.env.PORT || 3001` has a fallback, so it doesn't need setting up
      if (!hasDefault(n)) f.envReq.add(n.name.text)
    }
    // Words on screen: text between tags, and strings or formatted prices inside {...} (not attributes like className)
    if (ts.isJsxText(n) && /[a-z]{2}/i.test(n.text)) f.texts.add(n.text.replace(/\s+/g, ' ').trim())
    const tagOf = (x: ts.Node) => ts.isJsxElement(x) ? x.openingElement.tagName.getText(sf) : ''
    if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent)) && !/^(style|script)$/.test(tagOf(n.parent))) {
      // Follow only what gets rendered: both sides of `a ? b : c`, the right of `a && b`; never conditions, keys or arguments.
      const words_ = (e: ts.Node): void => {
        if (ts.isParenthesizedExpression(e)) return words_(e.expression)
        if (ts.isConditionalExpression(e)) { words_(e.whenTrue); words_(e.whenFalse); return }
        if (ts.isBinaryExpression(e)) {
          const op = e.operatorToken.getText(sf)
          if (op === '&&') words_(e.right)
          else if (/^(\|\||\?\?|\+)$/.test(op)) { words_(e.left); words_(e.right) }
          return
        }
        if (ts.isCallExpression(e)) {   // a price only with a currency hint: formatMoney(x), toLocaleString('en', { style: 'currency' })
          if (/format(Money|Price|Currency|Amount)/i.test(e.expression.getText(sf)) || /toLocaleString|NumberFormat/.test(e.expression.getText(sf)) && /currency/i.test(e.getText(sf))) f.texts.add('[price]')
          return
        }
        const t = str(e as ts.Expression)?.replace(/\[…\]/g, '…').replace(/\s+/g, ' ').trim()
        if (t && /[a-z]{2}/i.test(t) && /\s/.test(t) && !/^https?:/.test(t)) f.texts.add(t)   // words, not keys like 'home.title' or 'USD'
        if (ts.isTemplateExpression(e)) e.templateSpans.forEach(sp => words_(sp.expression))
      }
      words_(n.expression)
    }
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = n.initializer.getText(sf)
      // const authMiddleware = createMiddleware().server(...): a login check only if it can stop someone
      if (ts.isIdentifier(n.name) && /^createMiddleware\b/.test(init)) f.middleware.set(n.name.text, STOPS.test(init))
      if (ts.isIdentifier(n.name) && SERVER.test(init)) servers.add(n.name.text)
      // const admin = getSupabaseAdminClient(): a database client, whatever it's called
      if (ts.isIdentifier(n.name) && CLIENT_MAKER.test(init)) sbClients.add(n.name.text)
      const base = init.match(/^axios\.create\([^)]*baseURL:\s*['"`](\/[^'"`]*)/)?.[1]
      if (ts.isIdentifier(n.name) && base) f.wrappers.set(n.name.text, base.replace(/\/$/, ''))
      const mod = init.match(/(?:require|import)\(\s*['"]([^'"]+)['"]/)?.[1]   // require('x'), lazy(() => import('x'))
      if (mod) for (const el of ts.isIdentifier(n.name) ? [n.name] : ts.isObjectBindingPattern(n.name) ? n.name.elements.map(e => e.name) : [])
        if (ts.isIdentifier(el)) f.binds.set(el.text, mod)
    }
    if (ts.isStringLiteral(n) && METHODS.includes(n.text) && /\.method\b/.test((ts.isCaseClause(n.parent) ? n.parent.parent.parent : n.parent).getText(sf)))
      f.fns.set(n.text, '')   // pages/api: if (req.method === 'POST')
    const route = routeLike(n, sf)
    if (route) {
      const chain = [route]; for (let p = n.parent; p; p = p.parent) { const r = routeLike(p, sf); if (r) chain.unshift(r) }
      const path = chain.reduce((acc, r) => r.path === undefined ? acc : r.path.startsWith('/') ? r.path : `${acc.replace(/\/$/, '')}/${r.path}`, '')
      if (route.comp && (route.path !== undefined || route.index) && !path.includes('*'))
        f.pages.push({ path: path || '/', comp: route.comp, guard: chain.some(r => r.guard) })
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) f.jsx.add(n.tagName.getText(sf))
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const mod = n.moduleSpecifier.text
      f.imports.push(mod)
      if (SERVICES[pkgName(mod)]) f.services.add(SERVICES[pkgName(mod)])
      const c = n.importClause
      if (c?.name) { f.used.add(c.name.text); f.binds.set(c.name.text, mod) }
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings))
        for (const el of c.namedBindings.elements) { f.used.add((el.propertyName ?? el.name).text); f.binds.set(el.name.text, mod); if (el.propertyName) f.binds.set(el.propertyName.text, mod) }
    }
    if (ts.isJsxAttribute(n) && n.initializer) {
      const v = str(n.initializer), name = n.name.getText(sf)
      if (v && name === 'href' && v.startsWith('/')) f.links.add(v)
    }
    // Visible text of an element, minus the choices of a dropdown (a <label> around a <select> is just its name).
    const textOf = (el: ts.JsxElement): string => el.children.map(c => ts.isJsxText(c) ? c.text
      : ts.isJsxElement(c) && !/^(select|option|textarea)$/.test(c.openingElement.tagName.getText(sf)) ? textOf(c) : ' ').join('').replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim()
    // A box is named by its aria-label, its type (email, password), the <label> around it, its placeholder, or its name.
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /^(input|textarea|select)$/.test(n.tagName.getText(sf))) {
      const at = (k: string) => { const a = n.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(sf) === k) as ts.JsxAttribute | undefined; return a?.initializer && str(a.initializer) }
      const type = at('type') ?? '', el = ts.isJsxOpeningElement(n) ? n.parent.parent : n.parent
      const label = ts.isJsxElement(el) && el.openingElement.tagName.getText(sf) === 'label' ? textOf(el) : ''
      boxes.push({ id: at('id'), type, v: at('aria-label') ?? (label || undefined), aria: !!at('aria-label') })
      if (!boxes.at(-1)!.v) boxes.at(-1)!.v = at('placeholder') ?? at('name')   // after <label htmlFor> is known
    }
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === 'label') {
      const a = n.openingElement.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(sf) === 'htmlFor') as ts.JsxAttribute | undefined
      const id = a?.initializer && str(a.initializer)
      if (id) labelFor.set(id, textOf(n))
    }
    // Headings with code in them ("{dog} with {walker}") would come out as fragments: skip those.
    if (ts.isJsxElement(n) && /^h[1-3]$/.test(n.openingElement.tagName.getText(sf)) && !n.children.some(c => ts.isJsxExpression(c) && c.expression && !str(c.expression))) {
      const t = textOf(n)
      if (t) f.headings.push(`${n.openingElement.tagName.getText(sf)}:${t}`)
    }
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === 'form') f.forms++
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === 'button') {
      const expr = (e?: ts.Expression) => e && (str(e) ?? (ts.isConditionalExpression(e) ? str(e.whenFalse) : undefined))
      const t = n.children.filter(ts.isJsxText).map(c => c.text.trim()).join(' ').trim()
        || n.children.map(c => ts.isJsxExpression(c) ? expr(c.expression) : undefined).find(Boolean)
      if (t) f.ui.add(`button "${t}"`)
    }
    if (ts.isCatchClause(n) && n.block.statements.length === 0) f.emptyCatch++
    if (n.kind === ts.SyntaxKind.AnyKeyword) f.anys++
    ts.forEachChild(n, visit)
  }
  visit(root)
  // A router made and mounted in the same file: const admin = Router(); admin.post('/x'); app.use('/api/admin', requireAdmin, admin)
  for (let i = 0; i < 5; i++) for (const m of f.mounts.filter(m => servers.has(m.target))) {
    for (const h of f.handlers) if (h.server === m.target) { h.path = m.path.replace(/\/$/, '') + (h.path === '/' ? '' : h.path); h.guard ||= m.guard; h.server = m.server }
    f.mounts.splice(f.mounts.indexOf(m), 1)
  }
  for (const b of boxes) {
    const v = (b.aria ? b.v : b.id && labelFor.get(b.id)) || b.v
    if (/^(email|password)$/.test(b.type) && !b.aria) f.ui.add(`field ${b.type}`)
    else if (b.type === 'checkbox' && v) f.ui.add(`check "${v}"`)
    else if (v && !/^(hidden|submit|radio)$/.test(b.type)) f.ui.add(`box "${v}"`)
  }
  return f
}

// <Route path="x" element={<Page />}> or { path: 'x', element: <Page /> }: its path, the page component, and any login wrapper.
function routeLike(n: ts.Node, sf: ts.SourceFile): { path?: string; index: boolean; comp?: string; guard: boolean } | null {
  const tags = (e?: ts.Node) => { const out: string[] = []; const v = (x: ts.Node) => { if (ts.isJsxOpeningElement(x) || ts.isJsxSelfClosingElement(x)) out.push(x.tagName.getText(sf)); ts.forEachChild(x, v) }; if (e) v(e); return out }
  let path: string | undefined, index = false, el: ts.Node | undefined
  if (ts.isJsxElement(n)) n = n.openingElement
  else if (ts.isJsxOpeningElement(n)) return null   // seen through its JsxElement
  if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === 'Route') {
    for (const a of n.attributes.properties) if (ts.isJsxAttribute(a)) {
      const k = a.name.getText(sf), v = a.initializer
      if (k === 'path' && v && ts.isStringLiteral(v)) path = v.text
      if (k === 'index') index = true
      if ((k === 'element' || k === 'Component' || k === 'component') && v) el = v
    }
  } else if (ts.isObjectLiteralExpression(n)) {
    const prop = (k: string) => n.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === k) as ts.PropertyAssignment | undefined
    const p = prop('path')?.initializer, elp = prop('element') ?? prop('Component') ?? prop('component')
    if (p ? !ts.isStringLiteral(p) || !(elp || prop('children')) : !elp || !(prop('index') || prop('children'))) return null   // layout and index routes have no path
    path = p && ts.isStringLiteral(p) ? p.text : undefined; index = !!prop('index'); el = elp?.initializer
  } else return null
  const names = el && (ts.isJsxExpression(el) || ts.isJsxElement(el) || ts.isJsxSelfClosingElement(el)) ? tags(el) : el ? [el.getText(sf).replace(/[{}\s]/g, '')] : []
  const comp = names.filter(t => /^[A-Z]/.test(t) && !PAGE_GUARD.test(t) && !/^(Navigate|Suspense|Outlet|Fragment)$/.test(t)).at(-1)
  return { path: path?.replace(/:(\w+)\??/g, '[$1]'), index, comp, guard: names.some(t => PAGE_GUARD.test(t)) }
}

// A "get/fetch/list" function that returns a literal and never awaits or queries anything.
function returnsLiteralOnly(fn: ts.Node): boolean {
  let literal = false, real = false
  const visit = (n: ts.Node) => {
    if (ts.isAwaitExpression(n) || (ts.isCallExpression(n) && /prisma|fetch|supabase|db\./.test(n.expression.getText()))) real = true
    if (ts.isReturnStatement(n) && n.expression && (ts.isArrayLiteralExpression(n.expression) || ts.isObjectLiteralExpression(n.expression))) literal = true
    if (ts.isArrowFunction(n) && (ts.isArrayLiteralExpression(n.body) || ts.isObjectLiteralExpression(n.body))) literal = true
    ts.forEachChild(n, visit)
  }
  visit(fn)
  return literal && !real
}

// ---------- facts about the whole app ----------

export type Route = { kind: 'page' | 'endpoint'; url: string }
// TanStack Router file routes: src/routes/classes.$classId.tsx -> /classes/[classId]; _authed/ and (group)/ add nothing;
// posts_.$id.edit.tsx -> /posts/[id]/edit; files under -folders are ignored; [.] is a literal dot.
export function tanstackRoute(path: string): { url: string; ids: string[]; layout: boolean; index: boolean } | null {
  const m = path.match(/^(?:src\/|app\/)?routes\/(.+?)(?:\.lazy)?\.[jt]sx?$/)
  if (!m || m[1].split('/').some(x => x.startsWith('-')) || /(^|\/)__root$|routeTree\.gen$/.test(m[1])) return null
  const toks = m[1].replace(/\[\.\]/g, '\u0000').split(/[/.]/).map(t => t.replace(/\u0000/g, '.'))
  const index = toks.at(-1) === 'index', kept = toks.filter((t, i) => !(i === toks.length - 1 && (t === 'index' || t === 'route')))
  const segs = kept.filter(t => !t.startsWith('_') && !/^\(.*\)$/.test(t)).map(t => t.replace(/_$/, ''))
    .map(t => t === '$' ? '[rest]' : t.startsWith('$') ? `[${t.slice(1)}]` : t)
  // ids of the layouts above it, to find a login check on a parent (_authed.tsx, admin/route.tsx)
  return { url: '/' + segs.join('/'), ids: kept.map((_, i) => kept.slice(0, i + 1).join('/')), layout: !!kept.at(-1)?.startsWith('_'), index }   // _authed.tsx wraps pages, isn't one
}
// Next.js routes come from file paths: app/x/page.tsx, app/api/x/route.ts, and (with pagesDir) pages/x.tsx, pages/api/x.ts.
export function route(path: string, pagesDir = false): Route | null {
  const m = path.match(/^(?:src\/)?app\/(.*?)\/?(page|route)\.[jt]sx?$/)
  const clean = (p: string) => '/' + p.split('/').filter(s => s && s !== 'index' && !/^\(.*\)$/.test(s)).join('/')
  if (m) return { kind: m[2] === 'page' ? 'page' : 'endpoint', url: clean(m[1]) }
  const fn = path.match(/(?:^|\/)supabase\/functions\/(?!_)([^/]+)\/index\.[jt]s$/)   // Supabase edge function
  if (fn) return { kind: 'endpoint', url: `/functions/v1/${fn[1]}` }
  const pg = pagesDir && path.match(/^(?:src\/)?pages\/(?!_)(.*)\.[jt]sx?$/)
  return pg ? { kind: pg[1].startsWith('api/') ? 'endpoint' : 'page', url: clean(pg[1]) } : null
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

// Columns of each model; relation fields show up as "→Model".
function models(schema = ''): Map<string, string[]> {
  const blocks = [...schema.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)]
  const names = new Set(blocks.map(m => m[1]))
  const out = new Map<string, string[]>()
  for (const [, name, body] of blocks)
    out.set(name, body.split('\n').map(l => l.trim().split(/\s+/)).filter(([w]) => w && !w.startsWith('@') && !w.startsWith('//'))
      .map(([w, type = '']) => names.has(type.replace(/[\[\]?]/g, '')) ? `→${type.replace(/[?]/g, '')}` : w))
  return out
}

const envKeys = (text = '') => new Set([...text.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map(m => m[1]))
// Python packages: requirements.txt lines (stripe==7.1.0), and in pyproject.toml only real dependency lists:
// [project] dependencies = [...], [project.optional-dependencies] groups, [tool.poetry.*dependencies] tables.
const pySpec = (x: string) => x.match(/^\s*([A-Za-z][\w.-]*)(?:\[[^\]]*\])?\s*((?:[=<>!~]=?)\s*[^,;#\s]+)?/)
const pyDeps = (text: string, path: string): Record<string, string> => {
  const out: Record<string, string> = {}, add = (spec?: string) => { const m = spec && pySpec(spec); if (m && m[1].toLowerCase() !== 'python') out[m[1].toLowerCase()] = (m[2] ?? '*').replace(/\s/g, '').replace(/^==/, '') }
  if (!path.endsWith('.toml')) { for (const l of text.split('\n')) if (!/^\s*(#|-|$)|:\/\//.test(l)) add(l.replace(/#.*/, '')); return out }
  let section = '', inArray = false
  for (const l of text.split('\n')) {
    const h = l.match(/^\s*\[([^\]]+)\]\s*$/)
    if (h) { section = h[1]; inArray = false; continue }
    const arrayHere = section === 'project' && /^\s*dependencies\s*=\s*\[/.test(l) || section === 'project.optional-dependencies' && /^\s*[\w-]+\s*=\s*\[/.test(l)
    if (arrayHere || inArray) { for (const q of l.matchAll(/["']([^"']+)["']/g)) add(q[1]); inArray = !/\]/.test(l.replace(/\[[^\]]*\]/g, '').split('=').slice(arrayHere ? 1 : 0).join('=')) || (arrayHere && !/\]\s*$/.test(l)); continue }
    if (/^tool\.poetry(\.group\.[\w-]+)?\.(dev-)?dependencies$/.test(section)) { const m = l.match(/^\s*([A-Za-z][\w.-]*)\s*=\s*(?:["']([^"']*)["']|\{[^}]*version\s*=\s*["']([^"']*)["'])/); if (m && m[1] !== 'python') out[m[1].toLowerCase()] = m[2] ?? m[3] ?? '*' }
  }
  return out
}
const deps = (text = '{}') => { try { const p = JSON.parse(text); return { ...p.dependencies, ...p.devDependencies } as Record<string, string> } catch { return {} } }

export function appFacts(snap: Snap) {
  const files = new Map<string, FileFacts>()
  for (const [p, t] of snap) if (CODE.test(p) && !p.includes('node_modules/')) {
    try { const f = p.endsWith('.py') ? pyFacts(p, t, empty) : fileFacts(p, t); if (f) files.set(p, f) } catch { /* unparsable file: report nothing about it */ }
  }
  // ponytail: '@/' (repo root or the nearest src/) and relative paths only; read tsconfig paths if a repo uses other aliases
  const resolve = (from: string, spec: string): string | undefined => {
    if (spec.startsWith('py:')) return resolvePy(from, spec.slice(3))
    const rest = spec.slice(2), src = from.slice(0, from.lastIndexOf('src/') + 4)
    const bases = spec.startsWith('@/') ? [rest, 'src/' + rest, src + rest] : spec.startsWith('.') ? [join(from, '..', spec)] : []
    return bases.flatMap(b => [b, ...['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.js'].map(e => b.replace(/\.(m?js|jsx)$/, '') + e)])
      .find(c => files.has(c))
  }
  // Python: from .routers import orders -> routers/orders.py next to this file; app.routers.orders -> any file ending in app/routers/orders.py.
  // `from x import router` names something inside x, so try without the last part too.
  const resolvePy = (from: string, mod: string): string | undefined => {
    const dots = mod.match(/^\.*/)![0].length, rest = mod.slice(dots).replace(/\./g, '/')
    const base = dots ? join(from, ...Array(dots).fill('..')) : ''
    const tries = [rest, rest.split('/').slice(0, -1).join('/')].filter(Boolean).flatMap(r => [`${r}.py`, `${r}/__init__.py`].map(x => dots ? join(base, x) : x))
    return tries.map(x => files.has(x) ? x : dots ? undefined : [...files.keys()].find(k => k.endsWith('/' + x))).find(Boolean)
  }
  const target = (p: string, name: string) => { const m = files.get(p)!.binds.get(name); return m ? resolve(p, m) : undefined }

  // api('/bookings') through `fetch(\`/api${path}\`)`, or http.get('/x') on axios.create({ baseURL: '/api' }): the real address.
  for (const [p, f] of files) for (const c of f.calls) {
    const q = f.wrappers.has(c.name) ? p : target(p, c.name), w = q ? files.get(q)?.wrappers : undefined
    const pre = w?.get(c.name) ?? (w?.size === 1 ? [...w.values()][0] : undefined)   // default import: local name may differ
    if (pre !== undefined) f.fetches.add(`${c.method} ${pre}${c.path}`)
    else if (c.prop) f.fetches.add(`${c.method} ${c.path}`)
  }

  const routes = new Map<string, Route>()
  const deps_ = Object.assign({}, ...[...snap].filter(([p]) => /(^|\/)package\.json$/.test(p) && !p.includes('node_modules/')).map(([, t]) => deps(t)),
    ...[...snap].filter(([p]) => /(^|\/)(requirements[\w-]*\.txt|pyproject\.toml)$/.test(p)).map(([p, t]) => pyDeps(t, p))) as Record<string, string>
  for (const p of files.keys()) { const r = route(p, 'next' in deps_); if (r) routes.set(p, r) }
  // TanStack Start: route files are pages (or server routes); a login check on a parent layout covers its children.
  const browserPages = new Set<string>()
  if (Object.keys(deps_).some(d => /^@tanstack\/(react-start|start|react-router|solid-start)$/.test(d))) {
    const tr = new Map([...files.keys()].flatMap(p => { const t = tanstackRoute(p); return t ? [[p, t] as const] : [] }))
    // Layouts are the non-index files; admin/index.tsx is a page next to admin.tsx, not above it.
    const byId = new Map([...tr].filter(([, t]) => !t.index).map(([p, t]) => [t.ids.at(-1)!, p]))
    const rootGuard = [...files].some(([p, f]) => /(^|\/)routes\/__root\.[jt]sx?$/.test(p) && f.pageGuard)
    for (const [p, t] of tr) {
      const f = files.get(p)!
      // _authed.tsx, or admin.tsx when admin/index.tsx exists: a layout around pages, not a page
      if (t.layout || !t.index && [...tr.values()].some(o => o.index && o.ids.at(-1) === t.ids.at(-1))) { if (!files.get(p)!.serverRoute) routes.delete(p); continue }
      const above = t.index ? t.ids : t.ids.slice(0, -1)
      if (!f.serverRoute || f.jsx.size) {
        routes.set(p, { kind: 'page', url: t.url }); browserPages.add(p)
        f.auth = f.pageGuard || rootGuard || above.some(id => !!files.get(byId.get(id) ?? '')?.pageGuard)   // calls like getUser() alone don't stop anyone
      }
      // The server part of a route file: an address of its own, even when the file is also a page
      if (f.serverRoute) {
        const unit = f.jsx.size ? { ...empty(f.printed), tables: f.tables, written: f.written, ops: f.ops, money: f.money, outside: f.outside, env: f.env, envReq: f.envReq,
          fns: new Map([...f.fns].filter(([k]) => METHODS.includes(k))), refuses: f.refuses } : f
        unit.auth = f.serverGuard || (f.auth || f.sbAuth) && STOPS.test(f.printed)
        const key = f.jsx.size ? `${p}#server` : p
        files.set(key, unit); routes.set(key, { kind: 'endpoint', url: t.url })
      }
    }
  }
  // TanStack server actions: calling one (createBooking({ data }), useServerFn(createBooking)) talks to the server.
  for (const [p, f] of files) for (const x of f.used) {
    const q = f.serverFns.has(x) ? p : target(p, x), m = q && files.get(q)?.serverFns.get(x)
    if (m) f.fetches.add(`${m} (server action) ${x} in ${q}`)
  }
  const middleware = new Map([...files.values()].flatMap(f => [...f.middleware]))
  // React Router: the component each <Route> shows is a page at that address. It runs in the browser.
  for (const [p, f] of files) for (const pg of f.pages) {
    const q = target(p, pg.comp)
    if (q && !routes.has(q)) { routes.set(q, { kind: 'page', url: pg.path }); browserPages.add(q); if (pg.guard) files.get(q)!.auth = true }
  }
  // Express-style servers: each address becomes its own unit "file#/api/x", with the facts of its handlers.
  const mounts = new Map<string, { path: string; guard: boolean; from: string }>()
  const guards: { from: string; path: string }[] = []
  for (const [p, f] of files) if (!p.endsWith('.py')) for (const m of f.mounts) {
    const q = m.target.startsWith('.') ? resolve(p, m.target) : target(p, m.target), file = q && files.get(q)
    if (file && (file.handlers.length || file.mounts.length)) mounts.set(q!, { ...m, from: p })   // it declares routes: a router
    else if (m.guardLike) guards.push({ from: p, path: m.path })                                  // otherwise it's a login check
  }
  const prefix = (p: string, seen = new Set<string>()): { path: string; guard: boolean } => {
    const m = mounts.get(p); if (!m || seen.has(p)) return { path: '', guard: false }
    const up = prefix(m.from, seen.add(p))
    return { path: up.path.replace(/\/$/, '') + m.path, guard: up.guard || m.guard }
  }
  const guardedPaths = guards.map(g => prefix(g.from).path.replace(/\/$/, '') + g.path)
  // Python: routers are named things inside files, so mounts are keyed by file and router
  const pyMounts = new Map<string, { from: string; server: string; path: string; guard: boolean; override: boolean }>()
  for (const [p, f] of files) if (p.endsWith('.py')) for (const m of f.mounts) {
    const q = target(p, m.target)
    if (q) pyMounts.set(`${q}::${m.attr}`, { from: p, server: m.server, path: m.path.replace(/\/$/, ''), guard: m.guard, override: !!m.override })
  }
  const pyServer = (file: string, name: string) => (files.get(file) as PyFacts | undefined)?.servers?.get(name)
  const pyPrefix = (file: string, server: string, seen = new Set<string>()): { path: string; guard: boolean; override: boolean } => {
    const k = `${file}::${server}`, m = pyMounts.get(k)
    if (!m || seen.has(k)) return { path: '', guard: false, override: false }
    seen.add(k)
    const pf = !pyServer(m.from, m.server) && files.get(m.from)!.binds.has(m.server) ? target(m.from, m.server) ?? m.from : m.from   // parent imported too
    const up = pyPrefix(pf, m.server, seen), parent = pyServer(pf, m.server)
    return { path: up.path + (up.override ? '' : (parent?.prefix ?? '').replace(/\/$/, '')) + m.path, guard: up.guard || !!parent?.guard || m.guard, override: m.override }
  }
  const pyAliases = new Map([...files.values()].flatMap(f => [...((f as PyFacts).aliases ?? [])]))
  const pyAppGuard = [...files.values()].some(f => (f as PyFacts).appGuard)
  const pyRoute = (p: string, h: FileFacts['handlers'][number]) => {
    let file = p, own = h.own ?? '', g = false
    if (h.imported) { const q = target(p, h.server); if (q) { file = q; own = pyServer(q, h.server)?.prefix ?? ''; g = !!pyServer(q, h.server)?.guard } }
    const P = pyPrefix(file, h.server)
    return { url: (P.path + (P.override ? '' : own.replace(/\/$/, '')) + h.path).replace(/(.)\/$/, '$1') || '/',
      guard: P.guard || g || pyAppGuard || h.mw.some(a => pyAliases.get(a)) }
  }
  for (const [p, f] of [...files]) {
    const pre = f.handlers.length ? prefix(p) : null
    for (const h of f.handlers) {
      const py = p.endsWith('.py') ? pyRoute(p, h) : undefined
      const url = py ? py.url : h.path.startsWith('(server action) ') ? `${h.path} in ${p}`
        : (pre!.path.replace(/\/$/, '') + (h.path === '/' ? '' : h.path)).replace(/:(\w+)\??/g, '[$1]') || '/'
      const key = `${p}#${url}`, unit = files.get(key) ?? empty()
      const hf = h.handler ? f.locals.get(h.handler) ?? (target(p, h.handler) ? files.get(target(p, h.handler)!)?.locals.get(h.handler) : undefined) ?? h.facts : h.facts
      for (const k of ['tables', 'written', 'ops', 'outside', 'env', 'envReq', 'services', 'fetches', 'refuses'] as const) for (const x of hf[k]) unit[k].add(x)
      unit.money ||= hf.money
      unit.fns.set(h.method, hf.printed)
      unit.printed += `\n${h.method} ${hf.printed}`
      // Logged in if every handler that changes something checks (or, with none, every handler does).
      // A named middleware counts unless this repo defines it and it can't stop anyone; reading the user counts only if the code acts on it.
      const mwGuard = h.guard && !(h.mw.length && h.mw.every(m => middleware.get(m) === false))
      const writes = h.method !== 'GET', guard = pre!.guard || mwGuard || !!py?.guard || (hf.auth || hf.sbAuth) && STOPS.test(hf.printed) || guardedPaths.some(g => url === g || url.startsWith(g.replace(/\/$/, '') + '/'))
      const u = unit as FileFacts & { w?: boolean[]; r?: boolean[] }
      ;(writes ? (u.w ??= []) : (u.r ??= [])).push(guard)
      unit.auth = (u.w?.length ? u.w : u.r!).every(Boolean)
      files.set(key, unit); routes.set(key, { kind: 'endpoint', url })
    }
  }
  // A page also does what its own components do: fold in facts from local imports.
  const fold = (p: string, into: FileFacts, seen: Set<string>, page: boolean) => {
    for (const spec of files.get(p)!.imports) {
      const q = resolve(p, spec)
      // lib/ and server code (server actions, server/, *.server.ts) aren't part of what the page shows; calls to them are
      if (!q || seen.has(q) || /(^|\/)lib\//.test(q) || page && (/(^|\/)server\/|\.server\.[jt]sx?$/.test(q) || files.get(q)!.serverFns.size)) continue
      seen.add(q)
      const c = files.get(q)!
      for (const k of ['ui', 'fetches', 'links', 'outside', 'tables', 'written', 'ops'] as const) for (const x of c[k]) into[k].add(x)
      into.headings.push(...c.headings); into.forms += c.forms
      fold(q, into, seen, page)
    }
  }
  for (const p of files.keys()) if (routes.has(p) && !p.includes('#')) fold(p, files.get(p)!, new Set([p]), routes.get(p)!.kind === 'page')
  // Reading the session in the browser redirects nobody; on a server (edge function, Next.js) it's a real check.
  for (const k of routes.keys()) if (files.get(k)!.sbAuth && !browserPages.has(k)) files.get(k)!.auth = true
  // Whether a page or address checks login is part of what it is: losing the check counts as a change.
  for (const k of routes.keys()) files.get(k)!.printed += `\n[login: ${files.get(k)!.auth}]`
  const schemaPath = [...snap.keys()].find(p => p.endsWith('schema.prisma') && !p.includes('node_modules/'))
  const db = readDb([...snap].filter(([p]) => isMigration(p)))
  const all = models(schemaPath && snap.get(schemaPath))
  for (const [t, tb] of db.tables) all.set(t, [...tb.cols, ...[...tb.refs.values()].map(r => `→${singular(r)}`)])
  const pyModels = new Set<string>()
  for (const f of files.values()) for (const [m, fs] of (f as PyFacts).models ?? []) { all.set(m, fs); pyModels.add(m) }
  return {
    files, routes, db, models: all, schemaPath, pyModels,
    pyMigrations: [...snap.keys()].filter(p => /(^|\/)(migrations\/versions|alembic\/versions|migrations)\/[^/]+\.py$/.test(p) && !p.endsWith('__init__.py')),
    envExample: envKeys([...snap].filter(([p]) => /(^|\/)\.env\.example$/.test(p)).map(([, t]) => t).join('\n')), deps: deps_,
    migrations: [...snap.keys()].filter(p => /prisma\/migrations\/.+\.sql$/.test(p)), sqlMigrations: [...snap.keys()].filter(isMigration),
  }
}

// ---------- English ----------
// Every sentence below is a fixed template filled with facts. No model writes any of it.

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase()
const singular = (s: string) => s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('sses') ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s
const pluralize = (s: string) => s.endsWith('s') ? s : s.endsWith('y') ? s.slice(0, -1) + 'ies' : s + 's'
export const things = (model: string) => pluralize(words(model))
const an = (w: string) => (/^([aeio]|u(?!s|ni))/.test(w) ? 'an ' : 'a ') + w   // a user, an umbrella
export const list = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`
const DATES: Record<string, string> = { createdAt: 'date created', updatedAt: 'date updated', expiresAt: 'expiry date', deletedAt: 'date deleted' }
const camel = (c: string) => c.replace(/_([a-z])/g, (_, x) => x.toUpperCase())   // created_at -> createdAt
const fieldName = (c: string) => { const f = camel(c); return f === 'id' || /Id$/.test(f) ? '' : DATES[f] ?? (/At$/.test(f) ? words(f.slice(0, -2)) + ' date' : words(f.replace(/Cents$/, '')).replace(/^(is|has) /, '')) }   // is_intro_offer: "intro offer"
const fieldList = (fs: string[]) => list(fs.filter(f => !f.startsWith('→')).map(fieldName).filter(Boolean))

// "/products/[slug]/reviews" -> ["product", "reviews"]: a segment before a [param] is one of many
export const named = (url: string): string[] => {
  if (url.startsWith('(server action) ')) return [words(url.slice(16).split(' in ')[0])]
  const segs = url.replace(/^\/functions\/v1\//, '/').split('/').filter(s => s && s !== 'api')
  return segs.flatMap((s, i) => s.startsWith('[') ? [] : [segs[i + 1]?.startsWith('[') ? singular(words(s)) : words(s)])
}
export function pageName(url: string) {
  if (url === '/') return 'the home page'
  const n = named(url)
  return url.endsWith(']') ? `each ${n.join(' ')} page` : `the ${n.join(' ')} page`
}
const serverName = (url: string) => url.startsWith('(server action) ') ? `the "${named(url)[0]}" action on your server` : `the ${named(url).join(' ') || 'main'} part of your server`

const VERBS: Record<string, string> = { create: 'create', retrieve: 'look up', update: 'update', del: 'delete', delete: 'delete', list: 'list', send: 'send' }
function outsidePhrase(o: string) {
  const [svc, chain] = o.split(': ')
  if (chain === 'checkout.sessions.create') return `starts a ${svc} checkout`
  if (chain === 'webhooks.constructEvent') return `checks that messages really come from ${svc} ✓`
  if (EMAIL.has(svc) && /emails?\.send|send/.test(chain)) return `emails people through ${svc}`
  if (chain === 'request') return `calls ${svc}`
  const parts = chain.split('.'), verb = parts.at(-1)!, what = singular(words(parts.at(-2) ?? ''))
  return VERBS[verb] ? `asks ${svc} to ${VERBS[verb]} ${verb === 'list' ? pluralize(what) : `a ${what}`}` : `calls ${svc} (${chain})`
}
const VERB = /^((?:now )?(?:shows|links to|has|reads|saves|sends|loads|lists|looks up|updates|deletes|refuses with|says|asks \w+ to \w+))\s(.+)$/
function merge(clauses: string[]): string[] {
  const groups = new Map<string, string[]>()
  for (const c of clauses) {
    const m = c.match(VERB), key = m ? m[1] : c
    groups.set(key, [...new Set([...(groups.get(key) ?? []), ...(m ? [m[2]] : [])])])
  }
  // "loads data from your server" + "loads bookings from your server" -> "loads data and bookings from your server"
  const tail = (objs: string[]) => objs.map(o => o.match(/ (from|to|on) your server$/)?.[0]).reduce((x, y) => x === y ? x : undefined)
  return [...groups].map(([verb, objs]) => { const t = objs.length > 1 && tail(objs); return !objs.length ? verb : t ? `${verb} ${list(objs.map(o => o.slice(0, -t.length)))}${t}` : `${verb} ${list(objs)}` })
}
const NICE: Record<string, string> = { nav: 'navigation menu', btn: 'button', img: 'image' }
const nice = (s: string) => words(s).split(' ').map(w => NICE[w] ?? w).join(' ')
const uiPhrase = (u: string) => u.startsWith('box ') ? `a box for ${u.slice(4)}` : u.startsWith('field ') ? `${an(u.slice(6))} box`
  : u.startsWith('check ') ? `a checkbox for ${u.slice(6)}` : `${an(u.slice(8).toLowerCase()).split(' ')[0]} ${u.slice(7)} button`
// More than 3 boxes is a form: name the first few instead of listing every one.
const uiList = (us: string[]) => {
  const boxes = us.filter(u => u.startsWith('box ')), rest = us.filter(u => !u.startsWith('box '))
  const b = boxes.length > 3 ? [`boxes for ${list([...boxes.slice(0, 3).map(u => u.slice(4)), `${boxes.length - 3} more`])}`] : boxes.map(uiPhrase)
  return [...b, ...rest.map(uiPhrase)]
}
const norm = (u: string) => u.replace(/\[[^\]]*\]/g, '*')

// ---------- the diff ----------

const STOP = new Set(['with', 'that', 'this', 'from', 'make', 'code', 'codes', 'page', 'some', 'please', 'have', 'into', 'when', 'also', 'should', 'want'])
const keywords = (asked: string) =>
  asked.toLowerCase().match(/[a-z]{4,}/g)?.filter(w => !STOP.has(w)).map(w => w.replace(/(es|s)$/, '')) ?? []

export type Change = { group: 'Pages' | 'Server' | 'Database' | 'Outside services' | 'Other files'; isNew?: boolean; text: string; detail?: string; name?: string; money?: boolean; vague?: boolean }
export type Problem = { kind: 'Broken' | 'Unsafe' | 'Check' | 'Unasked'; text: string }
// ponytail: name-based guess at what's sensitive; a config file can override it later
const SENSITIVE = /admin|account|user|order|payment|coupon|refund|checkout|settings/i
// Addresses that have to work before you're logged in (or are called by other services): never "missing a login check".
// Webhooks and sign-in callbacks anywhere in the address; login pages only as the last part, and never under admin.
const PUBLIC = /^(login|log in|register|signup|sign up|signin|sign in|logout|log out|signout|sign out|forgot password|reset password|verify|verify email|health|token|access token|refresh|refresh token)$/   // token: OAuth2 password login
const isPublic = (url: string) => !/admin/i.test(url) && (named(url).some(s => /\b(webhooks?|callback|oauth)\b/.test(s)) || PUBLIC.test(named(url).at(-1) ?? ''))

export type Analysis = ReturnType<typeof analyze>
type Opts = { ref: string; asked?: string; color?: boolean; agentSaid?: string }   // agentSaid: the agent's last message, if known
export const report = (before: Snap, after: Snap, opts: Opts) => render(analyze(before, after, opts))

export function analyze(before: Snap, after: Snap, opts: Opts) {
  const A = appFacts(before), B = appFacts(after)
  const route = (p: string) => B.routes.get(p) ?? A.routes.get(p) ?? null
  const placeName = (p: string) => { const r = route(p); return r ? (r.kind === 'page' ? pageName(r.url) : serverName(r.url)) : p }
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).sort()
  const noise: string[] = [], real: string[] = []
  for (const p of changed) {
    const a = A.files.get(p), b = B.files.get(p)
    if (NOISE.test(p) || (a && b && a.printed === b.printed)) noise.push(p)
    else real.push(p)
  }
  // Pages and addresses can change without their file changing: an Express route ("file#/api/x") inside a bigger file,
  // or a login check added or removed where the route is declared (a mount, a <RequireAuth> wrapper).
  for (const k of new Set([...A.routes.keys(), ...B.routes.keys()])) if (!real.includes(k) && A.files.get(k)?.printed !== B.files.get(k)?.printed) real.push(k)
  const usersOf = (name: string, self: string) =>
    [...B.files].filter(([p, f]) => p !== self && (f.used.has(name) || f.jsx.has(name))).map(([p]) => placeName(p))
  const mainTable = (f: FileFacts, url: string) =>
    named(url).reverse().map(seg => [...f.tables].find(t => things(t) === pluralize(seg))).find(Boolean)
      ?? [...f.written][0] ?? [...f.tables][0]
  const endpoint = (path: string) => [...B.files].find(([p]) => { const r = route(p); return r?.kind === 'endpoint' && norm(r.url) === norm(path) })
  const fetchPhrase = (x: string) => {
    const method = x.slice(0, x.indexOf(' ')), path = x.slice(x.indexOf(' ') + 1), e = endpoint(path), r = e && route(e[0])!
    const t = e && mainTable(e[1], r!.url), noun = t ? things(t) : 'data'
    const sends = method === '?' ? !!e?.[1].fns.has('POST') && !e[1].fns.has('GET') : method !== 'GET'
    if (e?.[1].money) return 'starts a payment 💰'
    return method === 'PUT' || method === 'PATCH' ? `updates ${noun} on your server` : method === 'DELETE' ? `deletes ${noun} on your server`
      : sends ? `sends ${noun} to your server` : `loads ${noun} from your server`
  }
  const newOnly = <T,>(a: Set<T> | undefined, b: Set<T>) => [...b].filter(x => !a?.has(x))
  const newPage = (name: string, f: FileFacts, clauses: string[]) => {
    const title = f.headings.find(h => h.startsWith('h1:'))?.slice(3)
    const sections = f.headings.filter(h => !h.startsWith('h1:')).map(h => h.slice(3).replace(/[.!]$/, ''))
    const rest = merge(clauses.filter(c => c !== 'requires login ✓'))
    return [
      `${cap(name)} is new${title ? `, titled "${title}"` : ''}.`,
      sections.length ? `It has sections for ${list(sections)}.` : '',
      rest.length ? `It ${list(rest)}.` : '',
      viewOnly(f) ? 'It only shows information: nothing on it lets you change anything.' : '',
      f.auth ? 'You have to log in to open it ✓' : '',
    ].filter(Boolean).join(' ')
  }
  // Server code that an admin page calls is admin-only, whatever its name.
  const adminCalls = (url: string) => [...B.files].some(([p, f]) => route(p)?.kind === 'page' && /(^|\/)(admin|dashboard)(\/|$)/.test(route(p)!.url)
    && [...f.fetches].some(x => norm(x.slice(x.indexOf(' ') + 1)) === norm(url)))
  const viewOnly = (f: FileFacts) => ![...f.fetches].some(x => !x.startsWith('GET ')) && !f.forms && !f.written.size && ![...f.ui].some(u => u.startsWith('button ') || u.startsWith('box '))

  const changes: Change[] = [], problems: Problem[] = [], unfinished: string[] = [], ship: string[] = []

  // pages and server code
  for (const p of real) {
    const r = route(p); if (!r) continue
    const a = A.files.get(p), b = B.files.get(p)
    if (!b) { changes.push({ group: r.kind === 'page' ? 'Pages' : 'Server', text: `${cap(placeName(p))} was removed.`, detail: r.url, name: placeName(p) }); continue }
    const clauses: string[] = []
    if (r.kind === 'page') {
      const ui = uiList(newOnly(a?.ui, b.ui))
      if (ui.length) clauses.push(`${a ? 'now has' : 'has'} ${list(ui)}`)
      for (const t of newOnly(a?.tables, b.tables).filter(t => !b.written.has(t))) clauses.push(`${a ? 'now shows' : 'shows'} ${things(t)}`)
      for (const t of newOnly(a?.written, b.written)) clauses.push(`${a ? 'now saves' : 'saves'} ${things(t)}`)
      for (const x of newOnly(a?.fetches, b.fetches)) clauses.push((a ? 'now ' : '') + fetchPhrase(x))
      for (const x of newOnly(a?.links, b.links)) clauses.push(`${a ? 'now links' : 'links'} to ${pageName(x)}`)
      // icons (lucide, heroicons, ...) aren't content: "shows the gift" would be noise
      const comps = newOnly(a?.jsx, b.jsx).filter(x => /^[A-Z]/.test(x) && !/^(Link|Image|Script|Head)$/.test(x) && !x.includes('.')
        && !/icons?|lucide|phosphor|tabler|feather/i.test(b.binds.get(x) ?? '') && !/Icon$/.test(x))
      if (a && comps.length) clauses.push(`now shows the ${list(comps.map(nice))}`)
      const price = (f: FileFacts) => f.texts.has('[price]') || [...f.jsx].some(x => /Price|Money|Amount|Currency/.test(x))   // or a <Price/> component
      if (a && price(a) && !price(b)) clauses.push('no longer shows the price')
      if (a && !price(a) && price(b)) clauses.push('now shows a price')
      const gone = [...(a?.texts ?? [])].filter(t => !b.texts.has(t)).map(t => t.toLowerCase().replace(/[^a-z]/g, ''))
      const said = newOnly(a?.texts, b.texts).filter(t => t !== '[price]' && ![...b.ui].some(u => u.includes(t)) && !b.headings.some(h => h.endsWith(t))
        && !gone.includes(t.toLowerCase().replace(/[^a-z]/g, '')))   // "Save" -> "Save!" isn't new copy
      if (a && !clauses.length && said.length) clauses.push(`now says ${list(said.slice(0, 2).map(t => `"${t.length > 90 ? t.slice(0, 87) + '…' : t}"`))}`)
      if (!a && b.auth) clauses.push('requires login ✓')
    } else {
      const t = mainTable(b, r.url), noun = t ? things(t) : 'data'
      if (!a) {
        const can: string[] = [], creates = b.ops.has('create') || (b.writes && !b.ops.size)
        if (b.fns.has('GET')) can.push(`lists ${noun}`)
        if (b.fns.has('POST') || !METHODS.some(m => b.fns.has(m))) can.push(creates ? (can.length ? 'saves new ones' : `saves new ${noun}`)
          : b.ops.has('update') ? `updates ${noun}` : b.ops.has('delete') ? `deletes ${noun}` : t ? `looks up ${noun}` : 'accepts requests')
        if (b.fns.has('PUT') || b.fns.has('PATCH')) can.push(`updates ${noun}`)
        if (b.fns.has('DELETE')) can.push(`deletes ${noun}`)
        clauses.push(...new Set(can))
        if (b.money) clauses.push('charges customers 💰')
        if (b.auth) clauses.push('requires login ✓')
        else if (!b.written.size && !METHODS.slice(1).some(m => b.fns.has(m)) && !isPublic(r.url)) clauses.push('works without logging in')   // read-only; changing ones get a warning instead
      } else {
        for (const x of newOnly(a.written, b.written)) clauses.push(`saves ${things(x)}`)
        for (const x of newOnly(a.tables, b.tables).filter(x => !b.written.has(x))) clauses.push(`reads ${things(x)}`)
        if (!a.money && b.money) clauses.push('charges customers 💰')
        // only when there are more ways to say no than before: a reworded message isn't a new rule
        for (const m of newOnly(a.refuses, b.refuses).slice(0, Math.min(3, b.refuses.size - a.refuses.size))) clauses.push(`refuses with "${m}"`)
      }
      for (const o of newOnly(a?.outside, b.outside).filter(o => !o.startsWith('Stripe: checkout.sessions'))) clauses.push(outsidePhrase(o))
    }
    const name = placeName(p)
    const text = !a
      ? (r.kind === 'page' ? newPage(name, b, clauses) : `New server code that ${list(merge(clauses)) || 'handles requests'}.`)
      : (a.auth && !b.auth ? `${cap(name)} no longer requires login.${clauses.length ? ' It also' : ''}` : !a.auth && b.auth ? `${cap(name)} now requires login ✓${clauses.length ? ' It also' : ''}` : '')
        + (clauses.length ? `${a.auth !== b.auth ? ' now ' : `${cap(name)} now `}${list(merge(clauses.map(c => c.replace(/^now /, ''))))}.` : a.auth !== b.auth ? '' : `${cap(name)} changed in a way plain can't describe yet.${b.money ? '' : ' Ask the agent what it does differently.'}`)
    changes.push({ group: r.kind === 'page' ? 'Pages' : 'Server', isNew: !a, text: text + (a?.money && b.money ? ' This is the code that charges your customers 💰 Make a test payment before you ship.' : ''), detail: r.url, name: r.kind === 'page' ? pageName(r.url) + (!a && b.headings.find(h => h.startsWith('h1:')) ? ` ("${b.headings.find(h => h.startsWith('h1:'))!.slice(3)}")` : '') : named(r.url).join(' ') || 'main', money: b.money, vague: !!a && !clauses.length && a.auth === b.auth && !b.money })

    // New, lost its login check, or started changing data without one
    const changesData = (f?: FileFacts) => !!f && (f.written.size > 0 || METHODS.slice(1).some(m => f.fns.has(m)))
    if (!b.auth && (!a || a.auth || !changesData(a) && changesData(b)) && !isPublic(r.url)) {
      const writes = changesData(b)
      if (r.kind === 'page' && /admin|dashboard|account/.test(r.url))
        problems.push({ kind: 'Unsafe', text: `Anyone can open ${name} without logging in.` })
      else if (r.kind === 'endpoint' && /(^|\/)admin(\/|$)/.test(r.url) && (writes || b.tables.size))   // admin data, even just to read
        problems.push({ kind: 'Unsafe', text: `Anyone can use ${name} without logging in.` })
      else if (r.kind === 'endpoint' && writes && (SENSITIVE.test(r.url) || [...b.written].some(t => SENSITIVE.test(t)) || adminCalls(r.url)))
        problems.push({ kind: 'Unsafe', text: `Anyone can use ${name} without logging in.` })
      else if (r.kind === 'endpoint' && writes) {
        const t = mainTable(b, r.url), noun = t ? things(t) : 'data'
        problems.push({ kind: 'Check', text: `Anyone can ${b.ops.has('create') || !b.ops.size ? 'post' : 'change'} ${noun} without logging in, and nothing limits spam or fake ${noun}. That's normal for things like sign-ups or reviews, but make sure it's what you want.` })
      }
    }
  }

  // Several changes plain can't describe: one line, not one each.
  for (const g of ['Pages', 'Server'] as const) {
    const vs = changes.filter(c => c.vague && c.group === g)
    if (vs.length < 2) continue
    for (const v of vs) changes.splice(changes.indexOf(v), 1)
    const names = vs.map(v => g === 'Pages' ? pageName(v.detail!) : named(v.detail!).join(' ') || 'main')
    changes.push({ group: g, text: `The agent changed ${g === 'Pages' ? list(names) : `the ${list(names)} parts of your server`} in ways plain can't describe yet. Ask the agent what they do differently.` })
  }

  // asked to change things, but nothing new can change anything
  const verb = opts.asked?.toLowerCase().match(/\b(control|manage|edit|change|update|delete|cancel|refund)\b/)?.[1]
  const writesNow = [...B.files].some(([p, f]) => route(p) && f.written.size && !(A.files.get(p)?.written.size))
  const newViewOnly = real.filter(p => route(p)?.kind === 'page' && !A.files.has(p) && B.files.has(p) && viewOnly(B.files.get(p)!))
  if (verb && !writesNow && newViewOnly.length)
    problems.push({ kind: 'Check', text: `You asked to "${verb}", but nothing new lets you change anything: ${list(newViewOnly.map(placeName))} only ${newViewOnly.length > 1 ? 'show' : 'shows'} information. If you wanted buttons to act on things (like refunding or cancelling orders), ask for that. (This is a guess.)` })

  // files that aren't code
  for (const p of real) if (!p.includes('#') && !CODE.test(p) && !/(^|\/)(package\.json|\.env\.example|schema\.prisma|\.gitignore|requirements[\w-]*\.txt|pyproject\.toml)$|prisma\/migrations\/|supabase\/migrations\//.test(p))
  {
    const media = (t = '') => new Set(t.match(/@media[^{]*max-width[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) ?? [])
    const phones = /\.(css|scss)$/.test(p) && [...media(after.get(p))].some(m => !media(before.get(p)).has(m))
    changes.push({ group: 'Other files', isNew: !before.has(p), text: phones ? `The agent changed how the app looks on small screens like phones (in ${p}).`
      : `The agent ${!before.has(p) ? 'added' : !after.has(p) ? 'deleted' : 'changed'} ${p}${/\.md$/i.test(p) ? ', a notes file (not code)' : ''}.` })
  }

  // database
  for (const [m, fields] of B.models) {
    const old = A.models.get(m), links = (fs: string[]) => fs.filter(f => f.startsWith('→')).map(f => f.slice(1))
    if (!old) {
      const l = links(fields)
      const one = l.filter(x => !x.endsWith('[]')).map(x => an(words(x))), many = l.filter(x => x.endsWith('[]')).map(x => things(x.slice(0, -2)))
      const rels = [one.length ? `belongs to ${list(one)}` : '', many.length ? `can have many ${list(many)}` : ''].filter(Boolean)
      changes.push({ group: 'Database', isNew: true, name: things(m), text: `Your database now stores ${things(m)}: ${fieldList(fields)}.${rels.length ? ` Each one ${list(rels)}.` : ''}${ownOnly(B.db, m) ? ' Each person can only see their own ✓' : ''}` })
      continue
    }
    const add = fields.filter(x => !old.includes(x)), del = old.filter(x => !fields.includes(x))
    if (fieldList(add)) changes.push({ group: 'Database', name: things(m), text: `${cap(things(m))} now also store the ${fieldList(add)}.` })
    if (links(add).length) changes.push({ group: 'Database', text: `${cap(things(m))} are now linked to ${list(links(add).map(x => things(x.replace('[]', ''))))}.` })
    if (del.length) {
      changes.push({ group: 'Database', text: `${cap(things(m))} will no longer store the ${fieldList(del) || list(del)}.` })
      ship.push(`Back up your data first: the ${fieldList(del) || list(del)} on ${things(m)} will be deleted for good.`)
    }
  }
  for (const m of A.models.keys()) if (!B.models.has(m)) {
    changes.push({ group: 'Database', text: `Your database will no longer store ${things(m)}.` })
    ship.push(`Back up your data first: all ${things(m)} will be deleted for good.`)
  }
  const newMigrations = B.migrations.filter(m => !A.migrations.includes(m))
  if (changed.some(p => p.endsWith('schema.prisma')) && !newMigrations.length)
  {
    const sp = B.schemaPath ?? '', std = /(^|\/)prisma\/schema\.prisma$/.test(sp), dir = std ? sp.replace(/prisma\/schema\.prisma$/, '') : ''
    const flag = std || sp === 'schema.prisma' ? '' : ` --schema ${sp}`, added = [...B.models.keys()].filter(m => !A.models.has(m) && !B.db.tables.has(m))
    ship.push(`Update your database: ${dir ? `in ${dir}, ` : ''}run \`npx prisma migrate dev${flag}\` (on your live site: \`npx prisma migrate deploy${flag}\`). The database's structure changed, but no migration was created.${added.length ? ` Until you do, anything that uses ${list(added.map(things))} will fail.` : ''}`)
  }
  for (const m of newMigrations) if (/\bDROP\b/i.test(after.get(m) ?? '')) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`)
  // Supabase: new migrations, what they destroy (removed tables and columns are already listed above), and who the rules let in.
  for (const m of B.sqlMigrations.filter(m => !A.sqlMigrations.includes(m))) {
    const bad = (B.db.destructive.get(m) ?? []).filter(x => !/^deletes the \S+ (column|table)/.test(x))
    if (bad.length) ship.push(`Back up your data first: ${m} ${list(bad)}, and that can't be undone.`)
    ship.push(`Apply ${m} to your live database before the new code goes live (\`supabase db push\`), or the parts that use it will fail.`)
    for (const fn of B.db.replaced.get(m) ?? []) ship.push(`Test what ${fn} does: ${m} rewrote that existing database rule, which the app already relied on.`)
  }
  // Tables the app itself uses; edge functions usually use the service key, which skips the rules.
  const used = (X: typeof A) => new Set([...X.files].filter(([p]) => !/(^|\/)supabase\/functions\//.test(p)).flatMap(([, f]) => [...f.tables]))
  const before_ = findings(A.db, used(A), things).map(x => x.text), rls = findings(B.db, used(B), things).filter(x => !before_.includes(x.text))
  problems.push(...rls)
  const notes = rls.length ? ["Database access rules are read from supabase/migrations. Rules changed in the Supabase dashboard aren't visible to plain."] : []

  // Python: the mistakes AI makes most (Bandit / Semgrep rules), when they're new in this change
  const RISK: Record<string, Problem> = {
    debug: { kind: 'Unsafe', text: "Debug mode is turned on. If this runs on your live site, an error page can show visitors your code and settings." },
    secret: { kind: 'Unsafe', text: "The app's secret key is written in the code. Anyone who sees the code can fake logins. Move it to an environment variable." },
    sql: { kind: 'Unsafe', text: 'A database query is built by pasting in text, which lets attackers read or change your data (SQL injection). Use query parameters instead.' },
    cors: { kind: 'Check', text: "Any website can call your server from a visitor's browser (CORS allows all sites). Fine for a public API, not for one that uses logins." },
    csrf: { kind: 'Check', text: 'A form was excluded from forgery protection (csrf_exempt). Other sites could submit it for a logged-in visitor.' },
  }
  for (const p of real) for (const r of (B.files.get(p) as PyFacts | undefined)?.risks ?? [])
    if (!(A.files.get(p) as PyFacts | undefined)?.risks?.has(r)) problems.push({ ...RISK[r], text: `${RISK[r].text} (in ${p})` })
  const newPyMigrations = B.pyMigrations.filter(m => !A.pyMigrations.includes(m))
  if ([...B.pyModels, ...A.pyModels].some(m => JSON.stringify(A.models.get(m)) !== JSON.stringify(B.models.get(m))) && !newPyMigrations.length)
    ship.push('django' in B.deps
      ? 'Update your database: run `python manage.py makemigrations`, then `python manage.py migrate` (also on your live site). The models changed, but no migration was created.'
      : 'Update your database: create a migration (`alembic revision --autogenerate`, or `flask db migrate` with Flask-Migrate) and apply it (`alembic upgrade head` / `flask db upgrade`), also on your live site. The models changed, but no migration was created.')
  for (const m of newPyMigrations) {
    const up = (after.get(m) ?? '').split(/def downgrade|def backwards/)[0]
    if (/op\.drop_(table|column)|RemoveField|DeleteModel|\bDROP\b/.test(up)) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`)
  }

  // broken, unasked, unfinished
  const allBefore = new Map<string, string>(), allAfter = new Set<string>()
  for (const [p, f] of A.files) for (const n of f.fns.keys()) allBefore.set(n, p)
  for (const f of B.files.values()) for (const n of f.fns.keys()) allAfter.add(n)
  for (const [n, p] of allBefore) if (!allAfter.has(n) && !METHODS.includes(n)) {
    const users = usersOf(n, p)
    if (users.length) problems.push({ kind: 'Broken', text: `${n}() was deleted from ${p}, but ${list(users)} still ${users.length > 1 ? 'use' : 'uses'} it, so that will break.` })
  }
  const kw = opts.asked ? keywords(opts.asked) : []
  for (const p of real) {
    const a = A.files.get(p), b = B.files.get(p)
    if (kw.length && a && b && !route(p) && !kw.some(k => (after.get(p) ?? '').toLowerCase().includes(k))) {
      const fns = [...b.fns].filter(([n, s]) => a.fns.has(n) && a.fns.get(n) !== s).map(([n]) => n)
      // Part of the feature if it adds something new (ApiError) that the rest of this change uses.
      const added = [...b.exports].filter(x => !a.exports.has(x))
      const feature = added.some(x => [...B.files].some(([q, f]) => q !== p && real.includes(q) && (f.used.has(x) || f.jsx.has(x))))
      if (!fns.length && !feature) problems.push({ kind: 'Unasked', text: `The agent also changed ${p}, which doesn't look related to what you asked for.` })
      for (const n of fns.filter(n => !added.some(x => new RegExp(`\\b${x}\\b`).test(b.fns.get(n) ?? '')))) {
        const u = usersOf(n, p)
        problems.push({ kind: 'Unasked', text: `The agent also changed ${n}() in ${p}, which doesn't look related to what you asked for.${u.length ? ` It's used by ${list(u)}, so check that ${u.length > 1 ? 'they' : 'it'} still ${u.length > 1 ? 'work' : 'works'}.` : ''}` })
      }
    }
    if (!b || p.includes('#')) continue
    for (const t of b.todos.filter(t => !a?.todos.includes(t))) unfinished.push(`The agent left a to-do: "${t.replace(/^(TODO|FIXME|HACK):?\s*/, '')}" (in ${p}).`)
    for (const h of b.hardcoded.filter(h => !a?.hardcoded.includes(h))) unfinished.push(`${h}() returns made-up data instead of reading your database.`)
    if (b.emptyCatch > (a?.emptyCatch ?? 0)) unfinished.push(`If something goes wrong in ${placeName(p)}, the error is silently ignored (an empty catch in ${p}).`)
    if (b.anys > (a?.anys ?? 0)) { const n = b.anys - (a?.anys ?? 0); unfinished.push(`Type checking is turned off in ${n} spot${n === 1 ? '' : 's'} in ${p} (\`any\`).`) }
  }
  for (const [p, f] of B.files) if (/(^|\/)components\//.test(p))
    for (const n of f.fns.keys()) if (/^[A-Z]/.test(n) && !usersOf(n, p).length && !A.files.get(p)?.fns.has(n))
      unfinished.push(`The ${words(n)} component was built, but it isn't shown on any page yet.`)

  // env, packages, services
  const usedBefore = new Set([...A.files.values()].flatMap(f => [...f.env]))
  const required = new Set([...B.files.values()].flatMap(f => [...f.envReq]))
  for (const k of new Set([...B.files.values()].flatMap(f => [...f.env]))) if (!usedBefore.has(k)) {
    // VITE_, NEXT_PUBLIC_, ... are copied into the code every visitor downloads.
    const pub = /^(VITE|NEXT_PUBLIC|REACT_APP|EXPO_PUBLIC|PUBLIC)_/.test(k) && !/PUBLISHABLE|ANON/.test(k)
    if (pub && /SECRET|SERVICE_ROLE|PRIVATE|PASSWORD/.test(k)) problems.push({ kind: 'Unsafe', text: `${k} is a secret, but its name makes it part of the code every visitor's browser downloads, so anyone can read it. Move it to server-only code and give it a name without the ${k.split('_')[0]}_ prefix.` })
    else if (pub && /API_KEY|TOKEN/.test(k)) problems.push({ kind: 'Check', text: `${k} is sent to every visitor's browser (because of its ${k.split('_')[0]}_ prefix). That's fine for keys meant to be public, but not for secret ones.` })
    // Edge functions read their secrets from Supabase, which provides SUPABASE_URL and its keys by itself.
    const edgeOnly = [...B.files].filter(([, f]) => f.env.has(k)).every(([p]) => /(^|\/)supabase\/functions\//.test(p.split('#')[0]))
    if (edgeOnly && /^SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)$/.test(k) || !required.has(k)) continue
    ship.push(edgeOnly ? `Add ${k} to your Supabase project's secrets (Edge Functions → Secrets, or \`supabase secrets set\`).`
      : `Add ${k} to your hosting settings (like Vercel).${B.envExample.has(k) ? '' : ' It\'s also missing from .env.example.'}`)
  }
  for (const [d, v] of Object.entries(B.deps)) {
    if (!(d in A.deps)) ship.push(`A new package was added: ${d} (${v}). Make sure you actually need it.`)
    else if (A.deps[d] !== v) ship.push(`Test anything that uses ${d}: it was upgraded from ${A.deps[d]} to ${v}.`)
  }
  const svcBefore = new Set([...A.files.values()].flatMap(f => [...f.services]))
  for (const s of new Set([...B.files.values()].flatMap(f => [...f.services]))) if (!svcBefore.has(s))
    changes.push({ group: 'Outside services', isNew: true, text: EMAIL.has(s)
      ? `Your app now sends emails${s === 'email' ? '' : ` through ${s}`}. People's email addresses are shared with ${s === 'email' ? 'the email provider' : s}.` : `Your app now uses ${s}.` })

  // Guesses about money, worded as questions. Each says it's a guess.
  const moneyChanged = real.some(p => B.files.get(p)?.money && route(p))
  const said = (x: string | undefined) => x ?? ''
  // A deal for new sign-ups (newsletter, first order, welcome) can be claimed again with another email.
  if (moneyChanged && /(\d+\s*(%|percent)|\$\s*\d+\s+off|discount|promo|coupon|\bfree\b(\s+\w+){0,2}\s+(shipping|delivery|trial|month|week|walk|order|item|session|class|lesson|booking|visit|consultation)s?\b|\bfirst\s+\w+\s+(is\s+)?free\b)/i.test(said(opts.asked)) && /(sign ?up|newsletter|subscribe|\bfirst\b|new (customer|user|account)|welcome|referr)/i.test(said(opts.asked)))
    problems.push({ kind: 'Check', text: 'You asked for a discount. If it depends on a new account or email address, people can usually get it again by signing up with another email. What stops that? (This is a guess.)' })
  // Cancelling that can hit paid rows: a 'cancelled' write whose surroundings don't limit it to pending/unpaid ones.
  // A cancel counts when it isn't limited to pending/unpaid rows: a write that sets 'cancelled', or a validated
  // list (['completed', 'cancelled']) next to a write of `status` from the request.
  // ponytail: no control flow; a pending row cancelled right after Stripe charged it (charged, no booking) is missed
  const stmtAt = (t: string, i: number) => t.slice(t.lastIndexOf(';', i) + 1, (t.indexOf(';', i) + 1 || t.length))
  const isWrite = (x: string) => /update|\.save\(|\bdata\s*:|\bset\b/i.test(x)
  const pendingOnly = (x: string) => /pending|unpaid|expired|open/i.test(x) && !/(?<!un)\bpaid\b/i.test(x.replace(/payment_status\s*={1,3}\s*['"`]paid['"`]/g, ''))
  const statusFromInput = (t: string) => [...t.matchAll(/\bstatus\s*(?=[,}])|\bstatus\s*:\s*(?!['"`])[A-Za-z_]/g)].some(m => { const x = stmtAt(t, m.index!); return isWrite(x) && !pendingOnly(x) })
  const paidCancels = (t = '') => [...t.matchAll(/['"`]cancell?ed['"`]/g)].filter(m => {
    const x = stmtAt(t, m.index!)
    return isWrite(x) ? !pendingOnly(x) : statusFromInput(t)
  }).length
  const newSql = B.sqlMigrations.filter(m => !A.sqlMigrations.includes(m)).map(m => after.get(m) ?? '').join('\n')
  const cancels = real.some(p => route(p)?.kind !== 'page' && !/\.[jt]sx$/.test(p.split('#')[0]) && !!B.files.get(p)?.written.size
    && paidCancels(B.files.get(p)!.printed) > paidCancels(A.files.get(p)?.printed)) || paidCancels(newSql) > 0 && /update\s+[\w.]*\s+set/i.test(newSql)
  const refunds = [...B.files.values()].some(f => /refunds?\.create|\brefund\(/.test(f.printed))
  if (cancels && !refunds && [...B.files.values()].some(f => f.services.has('Stripe')))
    problems.push({ kind: 'Check', text: "Cancelling doesn't give money back: nothing in your app refunds a Stripe payment. If someone cancels after paying, they stay charged. (This is a guess.)" })
  // "I couldn't run the tests", "didn't get a chance to test", "tests not run", "untested"; not "I didn't change the tests"
  const NOT_RUN = /\b(did ?n[o'’]?t|could ?n[o'’]?t|was ?n[o'’]?t able to|were ?n[o'’]?t able to|unable to|not able to|have ?n[o'’]?t|has ?n[o'’]?t)\s+(?:(?:actually|yet|been able to|get to|get a chance to|have time to|manage to|be able to)\s+)?(run|test|build|verify|start|try|install|execute)\b|\b(tests?|build|it|this|app|code)\s+(?:(?:was|were|has|have)\s+)?not\s+(?:been\s+)?(run|tested|verified|built)\b|\buntested\b/i
  // "fix it", "it's weird", "make it faster" without saying what's wrong: the agent had to guess what to fix
  const ask = said(opts.asked)
  if (/\b(fix|broken|weird|buggy|bug|slow|faster|not working|doesn'?t work|glitch\w*|janky)\b/i.test(ask) && ask.split(/\s+/).length < 16 && !/["'`]|\berror\b|\bwhen i\b|\bafter\b/i.test(ask))
    ship.unshift("You didn't say exactly what was wrong, so the agent guessed. Check that the problem you saw is gone.")
  // a file you named in your request: say it's there
  for (const m of ask.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|py|sql|css)\b/g)) {
    const hit = real.find(p => p === m[0] || p.endsWith('/' + m[0].replace(/^\.?\//, '')))
    if (hit) changes.push({ group: 'Other files', isNew: !before.has(hit), text: `The agent ${before.has(hit) ? 'changed' : 'created'} ${hit}, as you asked.` })
  }
  if (NOT_RUN.test(said(opts.agentSaid)))
    ship.unshift("The agent says it didn't run or test this. Try it yourself before you ship.")

  return { ...opts, files: real.filter(p => !p.includes('#')).length, noise: noise.length, changes, problems, unfinished, ship, notes, A, B, schemaChanged: changed.some(p => p.endsWith('schema.prisma')) }
}

export function render(r: {
  ref: string; asked?: string; color?: boolean; files: number; noise: number
  changes: Change[]; problems: Problem[]; unfinished: string[]; ship: string[]; notes?: string[]
}): string {
  const c = (code: string) => (t: string) => r.color ? `\x1b[${code}m${t}\x1b[0m` : t
  const bold = c('1'), dim = c('2'), red = c('31'), yellow = c('33'), green = c('32')
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const wrap = (text: string, first: string, rest: string, width = 92) => {
    const lines: string[] = []; let line = first
    for (const w of text.split(' ')) {
      if (line.trim() && (line + ' ' + w).length > width) { lines.push(line); line = rest + w }
      else line = line.endsWith(' ') || !line.trim() ? line + w : line + ' ' + w
    }
    return [...lines, line]
  }
  const out: string[] = [`${bold('plain')} · ${plural(r.files, 'file')} changed since ${r.ref}`]
  if (r.asked) out.push(dim(`You asked: "${r.asked.length > 80 ? r.asked.slice(0, 77) + '...' : r.asked}"`))
  if (!r.changes.length && !r.problems.length && !r.unfinished.length && !r.ship.length)
    return [...out, '', 'Nothing about the app changed.'].join('\n')

  const checks = r.problems.filter(p => p.kind === 'Check').length, bad = r.problems.length - checks
  out.push('', '  ' + [
    bad ? red(`⚠ ${plural(bad, 'problem')}`) : green('✓ No problems spotted'),
    checks ? yellow(`${plural(checks, 'thing')} to decide`) : '',
    r.unfinished.length ? yellow(`${plural(r.unfinished.length, 'loose end')}`) : '',
    r.ship.length ? `${plural(r.ship.length, 'step')} before you ship` : '',
  ].filter(Boolean).join('  ·  '))

  if (r.problems.length) {
    out.push('', bold('LOOK AT THIS FIRST'))
    const icon = { Broken: red('✖'), Unsafe: red('⚠'), Check: yellow('!'), Unasked: yellow('?') }
    for (const p of r.problems) out.push(...wrap(p.text + (p.kind === 'Unasked' ? ' (This is a guess.)' : ''), `  ${icon[p.kind]} `, '    '))
  }
  if (r.changes.length) {
    out.push('', bold('WHAT CHANGED'))
    for (const g of ['Pages', 'Server', 'Database', 'Outside services', 'Other files'] as const) {
      const items = r.changes.filter(x => x.group === g).sort((x, y) => Number(!!y.isNew) - Number(!!x.isNew))
      if (!items.length) continue
      out.push(`  ${g}`)
      for (const i of items) {
        out.push(...wrap(i.text, `    ${i.isNew ? green('+') : '•'} `, '      '))
        if (i.detail) out.push(dim(`      ${i.detail}`))
      }
    }
  }
  if (r.unfinished.length) {
    out.push('', bold('LOOSE ENDS'))
    for (const u of r.unfinished) out.push(...wrap(u, `  ${yellow('◐')} `, '    '))
  }
  if (r.ship.length) {
    out.push('', bold('BEFORE YOU SHIP'))
    r.ship.forEach((s, i) => out.push(...wrap(s, `  ${i + 1}. `, '     ')))
  }
  for (const n of r.notes ?? []) out.push('', ...wrap(n, dim(''), '').map(dim))
  if (r.noise) out.push('', dim(`(Hidden: ${plural(r.noise, 'file')} with only formatting changes, or lockfiles.)`))
  return out.join('\n')
}
