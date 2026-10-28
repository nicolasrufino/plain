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
import { readDb, findings, isMigration, type Db } from './supabase.ts'

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
const SB_OPS: Record<string, string> = { insert: 'create', update: 'update', upsert: 'update', delete: 'delete' }
const WRITES = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/
const SERVICES: Record<string, string> = {
  stripe: 'Stripe', openai: 'OpenAI', '@anthropic-ai/sdk': 'Anthropic', resend: 'Resend',
  '@supabase/supabase-js': 'Supabase', nodemailer: 'email', twilio: 'Twilio', '@vercel/blob': 'Vercel Blob',
}
// ponytail: client variable names by convention; follow imports if apps name them differently
const CLIENTS: Record<string, string> = { stripe: 'Stripe', openai: 'OpenAI', anthropic: 'Anthropic', resend: 'Resend' }   // supabase.* is the database: read as tables
const CODE = /\.[cm]?[jt]sx?$/
const NOISE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/
const printer = ts.createPrinter({ removeComments: true })

type FileFacts = {
  fns: Map<string, string>; used: Set<string>; jsx: Set<string>; services: Set<string>
  tables: Set<string>; ops: Set<string>; writes: boolean; sbAuth: boolean; env: Set<string>; auth: boolean; money: boolean   // sbAuth: supabase.auth.getUser(), a real check only on a server
  emptyCatch: number; todos: string[]; hardcoded: string[]; anys: number; printed: string
  outside: Set<string>; links: Set<string>; fetches: Set<string>; ui: Set<string>; imports: string[]; written: Set<string>; headings: string[]; forms: number
  binds: Map<string, string>; locals: Map<string, FileFacts>                 // name -> module it came from; top-level functions
  handlers: { server: string; method: string; path: string; guard: boolean; handler?: string; facts: FileFacts }[]  // Express-style routes
  mounts: { server: string; path: string; target: string; guard: boolean; guardLike: boolean }[]  // app.use('/api/x', [guards], router | require('./x'))
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
})
const fnLike = (n?: ts.Node) => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))

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
function collect(sf: ts.SourceFile, root: ts.Node, f: FileFacts): FileFacts {
  const servers = new Set<string>(), guarded = new Set<string>()
  const isGuard = (a: ts.Node) => !fnLike(a) && GUARD.test(a.getText(sf)) && !NOT_GUARD.test(a.getText(sf))
  const addHandler = (server: string, method: string, path: string, mw: readonly ts.Expression[], h: ts.Expression) =>
    f.handlers.push({ server, method: method.toUpperCase(), path, guard: guarded.has(server) || mw.some(isGuard),
      handler: ts.isIdentifier(h) ? h.text : undefined, facts: fnLike(h) ? collect(sf, h, empty(printer.printNode(ts.EmitHint.Unspecified, h, sf))) : empty(h.getText(sf)) })
  const labelFor = new Map<string, string>(), boxes: { id?: string; type: string; v?: string; aria: boolean }[] = []
  const str = (e?: ts.Node) => e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text
    : e && ts.isTemplateExpression(e) ? e.head.text + e.templateSpans.map(t => '[…]' + t.literal.text).join('') : undefined
  const visit = (n: ts.Node) => {
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
        else if (callee.text === 'navigate' && arg?.startsWith('/')) f.links.add(arg)
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
        // Supabase: supabase.from('orders').update(...), and edge functions called with supabase.functions.invoke('name')
        const from = ts.isCallExpression(callee.expression) && ts.isPropertyAccessExpression(callee.expression.expression) && callee.expression.expression.name.text === 'from'
          ? { table: str(callee.expression.arguments[0]), on: callee.expression.expression.expression.getText(sf) } : undefined
        if (from?.table && /supabase|client|^sb$/i.test(from.on) && !/storage$/.test(from.on) && /^(select|insert|update|upsert|delete)$/.test(last)) {
          f.tables.add(from.table)
          if (SB_OPS[last]) { f.writes = true; f.written.add(from.table); f.ops.add(SB_OPS[last]) }
        }
        if (last === 'invoke' && /functions$/.test(obj) && arg) f.fetches.add(`POST /functions/v1/${arg}`)
        if (obj === 'Deno.env' && last === 'get' && arg) f.env.add(arg)
        if (/^(getUser|getSession|getClaims)$/.test(last) && /auth$/.test(obj)) f.sbAuth = true   // supabase.auth.getUser()
        if (/^(prisma|db)$/.test(parts[0]) && parts.length === 3 && !parts[1].startsWith('$') && !parts[1].includes('(')) {
          f.tables.add(cap(parts[1]))
          if (WRITES.test(parts[2])) { f.writes = true; f.written.add(cap(parts[1])); f.ops.add(parts[2].replace(/Many$/, '').replace('upsert', 'update')) }
        }
        if (parts[0] === 'stripe' && parts.at(-1) === 'create') f.money = true
        if (CLIENTS[parts[0]] && parts.length > 1 && !parts.some(x => x.includes('('))) f.outside.add(`${CLIENTS[parts[0]]}: ${parts.slice(1).join('.')}`)
        if (parts.at(-1) === 'push' && /router/.test(parts[0]) && str(n.arguments[0])?.startsWith('/')) f.links.add(str(n.arguments[0])!)
      }
    }
    if (ts.isPropertyAccessExpression(n) && /^(process|import\.meta)\.env$/.test(n.expression.getText(sf))) f.env.add(n.name.text)
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = n.initializer.getText(sf)
      if (ts.isIdentifier(n.name) && SERVER.test(init)) servers.add(n.name.text)
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
        for (const el of c.namedBindings.elements) { f.used.add((el.propertyName ?? el.name).text); f.binds.set(el.name.text, mod) }
    }
    if (ts.isJsxAttribute(n) && n.initializer) {
      const v = str(n.initializer), name = n.name.getText(sf)
      if (v && name === 'href' && v.startsWith('/')) f.links.add(v)
    }
    // Visible text of an element, minus the choices of a dropdown (a <label> around a <select> is just its name).
    const textOf = (el: ts.JsxElement): string => el.children.map(c => ts.isJsxText(c) ? c.text
      : ts.isJsxElement(c) && !/^(select|option|textarea)$/.test(c.openingElement.tagName.getText(sf)) ? textOf(c) : '').join('').replace(/\s+/g, ' ').trim()
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
const deps = (text = '{}') => { try { const p = JSON.parse(text); return { ...p.dependencies, ...p.devDependencies } as Record<string, string> } catch { return {} } }

export function appFacts(snap: Snap) {
  const files = new Map<string, FileFacts>()
  for (const [p, t] of snap) if (CODE.test(p) && !p.includes('node_modules/')) {
    try { files.set(p, fileFacts(p, t)) } catch { /* unparsable file: report nothing about it */ }
  }
  // ponytail: '@/' (repo root or the nearest src/) and relative paths only; read tsconfig paths if a repo uses other aliases
  const resolve = (from: string, spec: string) => {
    const rest = spec.slice(2), src = from.slice(0, from.lastIndexOf('src/') + 4)
    const bases = spec.startsWith('@/') ? [rest, 'src/' + rest, src + rest] : spec.startsWith('.') ? [join(from, '..', spec)] : []
    return bases.flatMap(b => [b, ...['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.js'].map(e => b.replace(/\.(m?js|jsx)$/, '') + e)])
      .find(c => files.has(c))
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
  const deps_ = Object.assign({}, ...[...snap].filter(([p]) => /(^|\/)package\.json$/.test(p) && !p.includes('node_modules/')).map(([, t]) => deps(t))) as Record<string, string>
  for (const p of files.keys()) { const r = route(p, 'next' in deps_); if (r) routes.set(p, r) }
  // React Router: the component each <Route> shows is a page at that address. It runs in the browser.
  const browserPages = new Set<string>()
  for (const [p, f] of files) for (const pg of f.pages) {
    const q = target(p, pg.comp)
    if (q && !routes.has(q)) { routes.set(q, { kind: 'page', url: pg.path }); browserPages.add(q); if (pg.guard) files.get(q)!.auth = true }
  }
  // Express-style servers: each address becomes its own unit "file#/api/x", with the facts of its handlers.
  const mounts = new Map<string, { path: string; guard: boolean; from: string }>()
  const guards: { from: string; path: string }[] = []
  for (const [p, f] of files) for (const m of f.mounts) {
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
  for (const [p, f] of [...files]) {
    const pre = f.handlers.length ? prefix(p) : null
    for (const h of f.handlers) {
      const url = (pre!.path.replace(/\/$/, '') + (h.path === '/' ? '' : h.path)).replace(/:(\w+)\??/g, '[$1]') || '/'
      const key = `${p}#${url}`, unit = files.get(key) ?? empty()
      const hf = h.handler ? f.locals.get(h.handler) ?? (target(p, h.handler) && files.get(target(p, h.handler)!)?.locals.get(h.handler)) ?? h.facts : h.facts
      for (const k of ['tables', 'written', 'ops', 'outside', 'env', 'services', 'fetches'] as const) for (const x of hf[k]) unit[k].add(x)
      unit.money ||= hf.money
      unit.fns.set(h.method, hf.printed)
      unit.printed += `\n${h.method} ${hf.printed}`
      // Logged in if every handler that changes something checks (or, with none, every handler does).
      const writes = h.method !== 'GET', guard = pre!.guard || h.guard || hf.auth || hf.sbAuth || guardedPaths.some(g => url === g || url.startsWith(g.replace(/\/$/, '') + '/'))
      const u = unit as FileFacts & { w?: boolean[]; r?: boolean[] }
      ;(writes ? (u.w ??= []) : (u.r ??= [])).push(guard)
      unit.auth = (u.w?.length ? u.w : u.r!).every(Boolean)
      files.set(key, unit); routes.set(key, { kind: 'endpoint', url })
    }
  }
  // A page also does what its own components do: fold in facts from local imports.
  const fold = (p: string, into: FileFacts, seen: Set<string>) => {
    for (const spec of files.get(p)!.imports) {
      const q = resolve(p, spec)
      if (!q || seen.has(q) || /(^|\/)lib\//.test(q)) continue
      seen.add(q)
      const c = files.get(q)!
      for (const k of ['ui', 'fetches', 'links', 'outside', 'tables', 'written', 'ops'] as const) for (const x of c[k]) into[k].add(x)
      into.headings.push(...c.headings); into.forms += c.forms
      fold(q, into, seen)
    }
  }
  for (const p of files.keys()) if (routes.has(p) && !p.includes('#')) fold(p, files.get(p)!, new Set([p]))
  // Reading the session in the browser redirects nobody; on a server (edge function, Next.js) it's a real check.
  for (const k of routes.keys()) if (files.get(k)!.sbAuth && !browserPages.has(k)) files.get(k)!.auth = true
  // Whether a page or address checks login is part of what it is: losing the check counts as a change.
  for (const k of routes.keys()) files.get(k)!.printed += `\n[login: ${files.get(k)!.auth}]`
  const schemaPath = [...snap.keys()].find(p => p.endsWith('schema.prisma'))
  const db = readDb([...snap].filter(([p]) => isMigration(p)))
  const all = models(schemaPath && snap.get(schemaPath))
  for (const [t, tb] of db.tables) all.set(t, [...tb.cols, ...[...tb.refs.values()].map(r => `→${singular(r)}`)])
  return {
    files, routes, db, models: all,
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
const fieldName = (c: string) => { const f = camel(c); return f === 'id' || /Id$/.test(f) ? '' : DATES[f] ?? (/At$/.test(f) ? words(f.slice(0, -2)) + ' date' : words(f.replace(/Cents$/, ''))) }
const fieldList = (fs: string[]) => list(fs.filter(f => !f.startsWith('→')).map(fieldName).filter(Boolean))

// "/products/[slug]/reviews" -> ["product", "reviews"]: a segment before a [param] is one of many
export const named = (url: string) => {
  const segs = url.replace(/^\/functions\/v1\//, '/').split('/').filter(s => s && s !== 'api')
  return segs.flatMap((s, i) => s.startsWith('[') ? [] : [segs[i + 1]?.startsWith('[') ? singular(words(s)) : words(s)])
}
export function pageName(url: string) {
  if (url === '/') return 'the home page'
  const n = named(url)
  return url.endsWith(']') ? `each ${n.join(' ')} page` : `the ${n.join(' ')} page`
}
const serverName = (url: string) => `the ${named(url).join(' ') || 'main'} part of your server`

const VERBS: Record<string, string> = { create: 'create', retrieve: 'look up', update: 'update', del: 'delete', delete: 'delete', list: 'list', send: 'send' }
function outsidePhrase(o: string) {
  const [svc, chain] = o.split(': ')
  if (chain === 'checkout.sessions.create') return `starts a ${svc} checkout`
  if (chain === 'webhooks.constructEvent') return `checks that messages really come from ${svc} ✓`
  const parts = chain.split('.'), verb = parts.at(-1)!, what = singular(words(parts.at(-2) ?? ''))
  return VERBS[verb] ? `asks ${svc} to ${VERBS[verb]} ${verb === 'list' ? pluralize(what) : `a ${what}`}` : `calls ${svc} (${chain})`
}
const VERB = /^((?:now )?(?:shows|links to|has|reads|saves|sends|loads|lists|looks up|updates|deletes|asks \w+ to \w+))\s(.+)$/
function merge(clauses: string[]): string[] {
  const groups = new Map<string, string[]>()
  for (const c of clauses) {
    const m = c.match(VERB), key = m ? m[1] : c
    groups.set(key, [...(groups.get(key) ?? []), ...(m ? [m[2]] : [])])
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

export type Change = { group: 'Pages' | 'Server' | 'Database' | 'Outside services' | 'Other files'; isNew?: boolean; text: string; detail?: string; name?: string; money?: boolean }
export type Problem = { kind: 'Broken' | 'Unsafe' | 'Check' | 'Unasked'; text: string }
// ponytail: name-based guess at what's sensitive; a config file can override it later
const SENSITIVE = /admin|account|user|order|payment|coupon|refund|checkout|settings/i
// Addresses that have to work before you're logged in (or are called by other services): never "missing a login check".
// Webhooks and sign-in callbacks anywhere in the address; login pages only as the last part, and never under admin.
const PUBLIC = /^(login|log in|register|signup|sign up|signin|sign in|logout|log out|forgot password|reset password|verify|verify email|health)$/
const isPublic = (url: string) => !/admin/i.test(url) && (named(url).some(s => /\b(webhooks?|callback|oauth)\b/.test(s)) || PUBLIC.test(named(url).at(-1) ?? ''))

export type Analysis = ReturnType<typeof analyze>
export const report = (before: Snap, after: Snap, opts: { ref: string; asked?: string; color?: boolean }) => render(analyze(before, after, opts))

export function analyze(before: Snap, after: Snap, opts: { ref: string; asked?: string; color?: boolean }) {
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
    const [method, path] = x.split(' '), e = endpoint(path), r = e && route(e[0])!
    const t = e && mainTable(e[1], r!.url), noun = t ? things(t) : 'data'
    const sends = method === '?' ? !!e?.[1].fns.has('POST') && !e[1].fns.has('GET') : method !== 'GET'
    if (e?.[1].money) return 'starts a payment 💰'
    return method === 'PUT' || method === 'PATCH' ? `updates ${noun} on your server` : method === 'DELETE' ? `deletes ${noun} on your server`
      : sends ? `sends ${noun} to your server` : `loads ${noun} from your server`
  }
  const newOnly = <T,>(a: Set<T> | undefined, b: Set<T>) => [...b].filter(x => !a?.has(x))
  const newPage = (name: string, f: FileFacts, clauses: string[]) => {
    const title = f.headings.find(h => h.startsWith('h1:'))?.slice(3)
    const sections = f.headings.filter(h => !h.startsWith('h1:')).map(h => h.slice(3))
    const rest = merge(clauses.filter(c => c !== 'requires login ✓'))
    return [
      `${cap(name)} is new${title ? `, titled "${title}"` : ''}.`,
      sections.length ? `It has sections for ${list(sections)}.` : '',
      rest.length ? `It ${list(rest)}.` : '',
      viewOnly(f) ? 'It only shows information: nothing on it lets you change anything.' : '',
      f.auth ? 'You have to log in to open it ✓' : '',
    ].filter(Boolean).join(' ')
  }
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
      const comps = newOnly(a?.jsx, b.jsx).filter(x => /^[A-Z]/.test(x) && !/^(Link|Image|Script|Head)$/.test(x) && !x.includes('.'))
      if (a && comps.length) clauses.push(`now shows the ${list(comps.map(nice))}`)
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
      } else {
        for (const x of newOnly(a.written, b.written)) clauses.push(`saves ${things(x)}`)
        for (const x of newOnly(a.tables, b.tables).filter(x => !b.written.has(x))) clauses.push(`reads ${things(x)}`)
        if (!a.money && b.money) clauses.push('charges customers 💰')
      }
      for (const o of newOnly(a?.outside, b.outside).filter(o => !o.startsWith('Stripe: checkout.sessions'))) clauses.push(outsidePhrase(o))
    }
    const name = placeName(p)
    const text = !a
      ? (r.kind === 'page' ? newPage(name, b, clauses) : `New server code that ${list(merge(clauses)) || 'handles requests'}.`)
      : (a.auth && !b.auth ? `${cap(name)} no longer requires login.${clauses.length ? ' It also' : ''}` : !a.auth && b.auth ? `${cap(name)} now requires login ✓${clauses.length ? ' It also' : ''}` : '')
        + (clauses.length ? `${a.auth !== b.auth ? ' now ' : `${cap(name)} now `}${list(merge(clauses.map(c => c.replace(/^now /, ''))))}.` : a.auth !== b.auth ? '' : `${cap(name)} had small behind-the-scenes changes.`)
    changes.push({ group: r.kind === 'page' ? 'Pages' : 'Server', isNew: !a, text: text + (a?.money && b.money ? ' This is the code that charges your customers 💰' : ''), detail: r.url, name: r.kind === 'page' ? pageName(r.url) + (!a && b.headings.find(h => h.startsWith('h1:')) ? ` ("${b.headings.find(h => h.startsWith('h1:'))!.slice(3)}")` : '') : named(r.url).join(' ') || 'main', money: b.money })

    if (!b.auth && (!a || a.auth) && !isPublic(r.url)) {
      const writes = b.written.size || METHODS.slice(1).some(m => b.fns.has(m))
      if (r.kind === 'page' && /admin|dashboard|account/.test(r.url))
        problems.push({ kind: 'Unsafe', text: `Anyone can open ${name} without logging in.` })
      else if (r.kind === 'endpoint' && writes && (SENSITIVE.test(r.url) || [...b.written].some(t => SENSITIVE.test(t))))
        problems.push({ kind: 'Unsafe', text: `Anyone can use ${name} without logging in.` })
      else if (r.kind === 'endpoint' && writes) {
        const t = mainTable(b, r.url), noun = t ? things(t) : 'data'
        problems.push({ kind: 'Check', text: `Anyone can ${b.ops.has('create') || !b.ops.size ? 'post' : 'change'} ${noun} without logging in, and nothing limits spam or fake ${noun}. That's normal for some things (like reviews), but make sure it's what you want.` })
      }
    }
  }

  // asked to change things, but nothing new can change anything
  const verb = opts.asked?.toLowerCase().match(/\b(control|manage|edit|change|update|delete|cancel|refund)\b/)?.[1]
  const writesNow = [...B.files].some(([p, f]) => route(p) && f.written.size && !(A.files.get(p)?.written.size))
  const newViewOnly = real.filter(p => route(p)?.kind === 'page' && !A.files.has(p) && B.files.has(p) && viewOnly(B.files.get(p)!))
  if (verb && !writesNow && newViewOnly.length)
    problems.push({ kind: 'Check', text: `You asked to "${verb}", but nothing new lets you change anything: ${list(newViewOnly.map(placeName))} only ${newViewOnly.length > 1 ? 'show' : 'shows'} information. If you wanted buttons to act on things (like refunding or cancelling orders), ask for that. (This is a guess.)` })

  // files that aren't code
  for (const p of real) if (!p.includes('#') && !CODE.test(p) && !/(^|\/)(package\.json|\.env\.example|schema\.prisma|\.gitignore)$|prisma\/migrations\/|supabase\/migrations\//.test(p))
    changes.push({ group: 'Other files', isNew: !before.has(p), text: `The agent ${!before.has(p) ? 'added' : !after.has(p) ? 'deleted' : 'changed'} ${p}${/\.md$/i.test(p) ? ', a notes file (not code)' : ''}.` })

  // database
  for (const [m, fields] of B.models) {
    const old = A.models.get(m), links = (fs: string[]) => fs.filter(f => f.startsWith('→')).map(f => f.slice(1))
    if (!old) {
      const l = links(fields)
      const one = l.filter(x => !x.endsWith('[]')).map(x => an(words(x))), many = l.filter(x => x.endsWith('[]')).map(x => things(x.slice(0, -2)))
      const rels = [one.length ? `belongs to ${list(one)}` : '', many.length ? `can have many ${list(many)}` : ''].filter(Boolean)
      changes.push({ group: 'Database', isNew: true, name: things(m), text: `Your database now stores ${things(m)}: ${fieldList(fields)}.${rels.length ? ` Each one ${list(rels)}.` : ''}` })
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
    ship.push("Update your database: run `npx prisma migrate dev`. The database's structure changed, but no migration was created.")
  for (const m of newMigrations) if (/\bDROP\b/i.test(after.get(m) ?? '')) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`)
  // Supabase: new migrations, what they destroy (removed tables and columns are already listed above), and who the rules let in.
  for (const m of B.sqlMigrations.filter(m => !A.sqlMigrations.includes(m))) {
    const bad = (B.db.destructive.get(m) ?? []).filter(x => !/^deletes the \S+ (column|table)/.test(x))
    if (bad.length) ship.push(`Back up your data first: ${m} ${list(bad)}, and that can't be undone.`)
    ship.push(`Make sure ${m} reaches your live database (Lovable does this for you; otherwise run \`supabase db push\`).`)
  }
  // Tables the app itself uses; edge functions usually use the service key, which skips the rules.
  const used = (X: typeof A) => new Set([...X.files].filter(([p]) => !/(^|\/)supabase\/functions\//.test(p)).flatMap(([, f]) => [...f.tables]))
  const before_ = findings(A.db, used(A), things).map(x => x.text), rls = findings(B.db, used(B), things).filter(x => !before_.includes(x.text))
  problems.push(...rls)
  const notes = rls.length ? ["Database access rules are read from supabase/migrations. Rules changed in the Supabase dashboard aren't visible to plain."] : []

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
      if (!fns.length) problems.push({ kind: 'Unasked', text: `The agent also changed ${p}, which doesn't look related to what you asked for.` })
      for (const n of fns) {
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
  for (const k of new Set([...B.files.values()].flatMap(f => [...f.env]))) if (!usedBefore.has(k)) {
    // VITE_, NEXT_PUBLIC_, ... are copied into the code every visitor downloads.
    const pub = /^(VITE|NEXT_PUBLIC|REACT_APP|EXPO_PUBLIC|PUBLIC)_/.test(k) && !/PUBLISHABLE|ANON/.test(k)
    if (pub && /SECRET|SERVICE_ROLE|PRIVATE|PASSWORD/.test(k)) problems.push({ kind: 'Unsafe', text: `${k} is a secret, but its name makes it part of the code every visitor's browser downloads, so anyone can read it. Move it to server-only code and give it a name without the ${k.split('_')[0]}_ prefix.` })
    else if (pub && /API_KEY|TOKEN/.test(k)) problems.push({ kind: 'Check', text: `${k} is sent to every visitor's browser (because of its ${k.split('_')[0]}_ prefix). That's fine for keys meant to be public, but not for secret ones.` })
    // Edge functions read their secrets from Supabase, which provides SUPABASE_URL and its keys by itself.
    const edgeOnly = [...B.files].filter(([, f]) => f.env.has(k)).every(([p]) => /(^|\/)supabase\/functions\//.test(p.split('#')[0]))
    if (edgeOnly && /^SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)$/.test(k)) continue
    ship.push(edgeOnly ? `Add ${k} to your Supabase project's secrets (Edge Functions → Secrets, or \`supabase secrets set\`).`
      : `Add ${k} to your hosting settings (like Vercel).${B.envExample.has(k) ? '' : ' It\'s also missing from .env.example.'}`)
  }
  for (const [d, v] of Object.entries(B.deps)) {
    if (!(d in A.deps)) ship.push(`A new package was added: ${d} (${v}). Make sure you actually need it.`)
    else if (A.deps[d] !== v) ship.push(`Test anything that uses ${d}: it was upgraded from ${A.deps[d]} to ${v}.`)
  }
  const svcBefore = new Set([...A.files.values()].flatMap(f => [...f.services]))
  for (const s of new Set([...B.files.values()].flatMap(f => [...f.services]))) if (!svcBefore.has(s))
    changes.push({ group: 'Outside services', isNew: true, text: `Your app now uses ${s}.` })

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
    bad ? red(`⚠ ${plural(bad, 'problem')}`) : green('✓ Nothing looks broken'),
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
