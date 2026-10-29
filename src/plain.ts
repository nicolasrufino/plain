#!/usr/bin/env node
// plain v0: what changed in your app compared to a git ref. Static facts, no AI.
//
//   plain [ref] [--asked "what you asked for"]   ref defaults to HEAD (uncommitted work)
//   plain --hook                                  Claude Code Stop hook: reads the last prompt
//
// ponytail: Next.js (app/ and pages/), Express-style servers, React Router, Prisma, Supabase, Stripe. Each framework is one more fact extractor.
import { adminCond, adminPos, FROM_REQUEST } from './admin.ts'
import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readDb, findings, isMigration, ownOnly, type Db } from './supabase.ts'
import { pyFacts, djClassRoutes, type PyFacts, type DjClass } from './python.ts'
import { sfcToTsx, nuxtRoute, svelteRoute, ngTemplateToJsx } from './sfc.ts'
import { javaFacts, type JavaFacts, type Family } from './java.ts'
import { STRIPE_EVENTS } from './stripe-events.ts'
import { goFacts, goModelOf, goPath, type GoFacts, type GoOp, type GoRef, type GoFunc } from './go.ts'
import { rbFacts, rbModelOf, controllerClass, LAMBDA_LOGIN, type RbFacts, type RbRoute, type Cb } from './rb.ts'
import { phpFacts, modelOf, type PhpFacts, type SchemaOp, type Mw } from './php.ts'
import { csFacts, mergeAuth, join as csJoin, under, csPath, type CsFacts, type CsClass, type CsRoute, type ExtCall, type Auth } from './csharp.ts'

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
  '@google/genai': 'Google Gemini', '@google/generative-ai': 'Google Gemini', 'groq-sdk': 'Groq', '@mistralai/mistralai': 'Mistral', replicate: 'Replicate',
  '@ai-sdk/openai': 'OpenAI', '@ai-sdk/anthropic': 'Anthropic', '@ai-sdk/google': 'Google Gemini',
}
// Services called straight over the web: fetch('https://api.resend.com/emails', ...)
const HOSTS: Record<string, string> = {
  'api.resend.com': 'Resend', 'api.stripe.com': 'Stripe', 'api.openai.com': 'OpenAI', 'api.anthropic.com': 'Anthropic',
  'api.sendgrid.com': 'SendGrid', 'api.postmarkapp.com': 'Postmark', 'api.twilio.com': 'Twilio', 'hooks.slack.com': 'Slack',
}
const EMAIL = new Set(['Resend', 'SendGrid', 'Postmark', 'email'])
// AI services: what people type goes to them, and each request is paid for
const AI = new Set(['OpenAI', 'Anthropic', 'Google Gemini', 'Groq', 'Mistral', 'Replicate'])
// ponytail: client variable names by convention; follow imports if apps name them differently
const CLIENTS: Record<string, string> = { stripe: 'Stripe', openai: 'OpenAI', anthropic: 'Anthropic', resend: 'Resend' }   // supabase.* is the database: read as tables
const CODE = /\.([cm]?[jt]sx?|py|vue|svelte|cs|java|rb|go)$|(?<!\.blade)\.php$/   // (Blade and ERB templates aren't read)
const NOISE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/
const printer = ts.createPrinter({ removeComments: true })

export type FileFacts = {
  fns: Map<string, string>; used: Set<string>; jsx: Set<string>; services: Set<string>
  tables: Set<string>; ops: Set<string>; writes: boolean; sbAuth: boolean; env: Set<string>; auth: boolean; admin?: boolean; money: boolean   // admin: the login check turns away everyone but admins. sbAuth: supabase.auth.getUser(), a real check only on a server
  emptyCatch: number; todos: string[]; hardcoded: string[]; anys: number; printed: string
  texts: Set<string>; refuses: Set<string>; envReq: Set<string>; exports: Set<string>   // words on screen ("[price]" for a formatted price); "no" messages (4xx); env vars without a fallback
  serverFns: Map<string, string>; serverRoute: boolean; serverGuard: boolean; pageGuard: boolean; middleware: Map<string, boolean>   // TanStack Start; middleware: name -> does it stop people?
  authStop: boolean; authReturn: boolean   // turns away people who aren't logged in (see loginGroups); authReturn: the same check ending in a return
  exportAuth?: boolean                    // Nuxt: the default-exported handler itself checks login
  pageFns?: number[]   // Next.js: where the default export (the page or layout itself) and getServerSideProps start
  authIfs: { g: string; at: number; fn: number }[]; skipIfs: { c: string; at: number; fn: number }[]   // where those checks apply (their path tests, '' = everywhere); early returns that let requests through
  outside: Set<string>; links: Set<string>; fetches: Set<string>; ui: Set<string>; imports: string[]; written: Set<string>; headings: string[]; forms: number
  binds: Map<string, string>; locals: Map<string, FileFacts>                 // name -> module it came from; top-level functions
  handlers: { server: string; method: string; path: string; guard: boolean; admin?: boolean; mw: string[]; handler?: string; facts: FileFacts; own?: string; imported?: boolean; anyMethod?: boolean; unknown?: boolean; nextAction?: boolean }[]  // Express-style routes, server actions, Python routes (own: the router's prefix)
  mounts: { server: string; path: string; target: string; guard: boolean; guardLike: boolean; attr?: string; override?: boolean; mw?: string[] }[]  // app.use('/api/x', [guards], router | require('./x')); Python: include_router / register_blueprint
  pages: { path: string; comp: string; guard: boolean | 'unknown' }[]                     // React Router <Route> / { path, element }
  calls: { name: string; path: string; method: string; prop: boolean }[]      // api('/x'), http.post('/x'): resolved against wrappers later
  wrappers: Map<string, string>                                               // fetch helpers and their address prefix: api() -> '/api'
}

export const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const isExported = (n: ts.Node) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)

const HTTP = /^(get|post|put|patch|delete)$/
const SERVER = /^(express(\.Router)?|Router|fastify|Fastify|new Hono|require\(['"]express['"]\)(\.Router)?)\(/   // what makes a variable a server/router
const GUARD = /auth|admin|protect|login|logged|token|jwt|session|private/i   // server middleware that checks who you are
const NOT_GUARD = /(^|\.)session\(|(^|\.|express|cookie)[sS]ession\(\s*\{|passport\.(initialize|session)|cookie|csrf|cors|helmet|(routes?|router)$|\boptional\w*\(|\w*Optional\(|optional\s*:\s*true|credentialsRequired\s*:\s*false|sessionRequired\s*:\s*false/i   // (expressSession({...}), optionalAuth(), expressjwt({ credentialsRequired: false }) let everyone through)   // sets up sessions or mounts routes; checks nothing
const PAGE_GUARD = /auth|protect|private|require|guard|signedin|loggedin/i   // client wrapper that does
const empty = (printed = ''): FileFacts => ({
  fns: new Map(), used: new Set(), jsx: new Set(), services: new Set(), tables: new Set(), ops: new Set(),
  writes: false, sbAuth: false, env: new Set(), auth: false, money: false, emptyCatch: 0, todos: [], hardcoded: [], anys: 0, printed,
  outside: new Set(), links: new Set(), fetches: new Set(), ui: new Set(), imports: [], written: new Set(), headings: [], forms: 0,
  binds: new Map(), locals: new Map(), handlers: [], mounts: [], pages: [], calls: [], wrappers: new Map(),
  texts: new Set(), refuses: new Set(), envReq: new Set(), exports: new Set(),
  serverFns: new Map(), serverRoute: false, serverGuard: false, pageGuard: false, middleware: new Map(), authStop: false, authReturn: false, authIfs: [], skipIfs: [],
})
// Code that can turn someone away: throw, redirect, a 401/403, "unauthorized"
const STOPS = /\bthrow\b|redirect\s*\(|\b40[13]\b|unauthori[sz]ed|forbidden/i
// ---------- login checks, read from the code's structure ----------
// A login check: an `if` whose condition tests the logged-in user (`!locals.user`, `!session?.user`, `!loggedIn.value`,
// `user?.role !== 'admin'`, `user == null`), ANDed only with path tests, and whose branch turns people away: a 401/403, a redirect,
// navigateTo / abortNavigation, an error about logging in, or (in a handler, action or load, not in a hook) a return.
// Not: a field of a form or body (`!body.user`), a 404/400, `user && user.role !== 'admin'` (anonymous visitors pass), any other
// ANDed condition (`to.meta.requiresAuth && ...`, `method !== 'GET' && ...`: plain can't tell what that covers).
const LOGIN_REF = /^(?:\(?\s*await\s+)?(?:[\w$]+(?:\??\.[\w$]+|\(\))*\??\.)?(user|session|loggedIn|isLoggedIn|isAuthenticated|authenticated|currentUser|claims|auth|userId)(?:\(\))?\)?(?:\.value)?$/
const NOT_LOGIN = /\b(body|data|form|formData|input|params|query|payload|values|args|result|row|record|item|order|req\.body)\??\./
export const PATH_TEST = /pathname|route\.id|event\.path|to\.path|to\.fullPath|url\.path|getRequestURL/
const strip = (e: ts.Expression): ts.Expression => ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isNonNullExpression(e) ? strip(e.expression) : e
const isLoginRef = (e: ts.Expression, sf: ts.SourceFile) => { const t = strip(e).getText(sf).replace(/\s/g, ''); return LOGIN_REF.test(t) && !NOT_LOGIN.test(t) }
const isNegLogin = (e0: ts.Expression, sf: ts.SourceFile): boolean => {
  const e = strip(e0)
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const o = strip(e.operand)
    return isLoginRef(o, sf) || (ts.isPropertyAccessExpression(o) || ts.isCallExpression(o)) && isLoginRef(ts.isCallExpression(o) ? o.expression : o.expression, sf)   // !user?.isAdmin
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind, K = ts.SyntaxKind
    if ((op === K.EqualsEqualsToken || op === K.EqualsEqualsEqualsToken) && /^(null|undefined|false)$/.test(e.right.getText(sf))) return isLoginRef(e.left, sf)
    // user?.role !== 'admin': a missing user has no role either
    if (op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken) { const l = strip(e.left); return ts.isPropertyAccessExpression(l) && isLoginRef(l.expression, sf) }
  }
  return false
}
const flat = (e: ts.Expression, op: ts.SyntaxKind): ts.Expression[] => { const s = strip(e); return ts.isBinaryExpression(s) && s.operatorToken.kind === op ? [...flat(s.left, op), ...flat(s.right, op)] : [s] }
// The AND-groups of an OR condition that make it a login check; each group's path tests (joined) say where it applies ('' = everywhere).
// a handler, action or load that checks login on every call: a check not tucked under another condition, or a return-style one
export const handlerChecks = (g?: FileFacts) => !!g && (g.authIfs.some(x => !x.g) || g.authReturn)
export function loginGroups(cond: ts.Expression, sf: ts.SourceFile): string[] {
  const out: string[] = []
  for (const or of flat(cond, ts.SyntaxKind.BarBarToken)) {
    const ands = flat(or, ts.SyntaxKind.AmpersandAmpersandToken), others = ands.filter(a => !isNegLogin(a, sf))
    if (others.length < ands.length && others.every(a => PATH_TEST.test(a.getText(sf)))) out.push(others.map(a => a.getText(sf)).join(' && '))
  }
  return out
}
// the branch really stops: a redirect, navigateTo / abortNavigation, SvelteKit's error(401) (it throws), or a throw about logging in / 401 / 403
const hardStop = (t: string) => /redirect\s*\(|redirectToSignIn\s*\(|<RedirectToSignIn\b|<Redirect\b|<Navigate\b|\b(?:notFound|unauthorized|forbidden)\s*\(|sendRedirect\s*\(|navigateTo\s*\(|abortNavigation\s*\(|\berror\s*\(\s*40[13]/i.test(t) || /\bthrow\b/.test(t) && /\b40[13]\b|unauthori[sz]ed|forbidden|log ?in|sign ?in|auth/i.test(t)
  || /\breturn\b/.test(t) && /status(Code)?\s*:\s*40[13]|\bResponse\([^)]*40[13]/.test(t)   // return new Response('Unauthorized', { status: 401 })
const RETURNS = /^\s*\{?\s*return\b/
const REQUIRE_LOGIN = /^(requireUser|requireUserSession|requireAdmin|requireAuth|requireAuthentication|requireLogin|requireLoggedIn|requireSession|requireStaff|requireRole|ensureLoggedIn|ensureAuthenticated|ensureAuth|ensureAdmin|ensureUser)$/
const fnLike = (n?: ts.Node) => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))
// `process.env.PORT || 3001` has a real default; `|| ''` or `?? undefined` only quiets TypeScript, the value is still needed
const hasDefault = (n: ts.Node) => ts.isBinaryExpression(n.parent) && n.parent.left === n && /^(\|\||\?\?)$/.test(n.parent.operatorToken.getText())
  && !/^(''|""|``|null|undefined)$/.test(n.parent.right.getText().trim())

// An Angular component: its class, and its template (templateUrl: './orders.html', or template: `...`) as JSX. Template that doesn't
// convert cleanly: the class's facts only.
function ngFacts(path: string, text: string, snap: Snap): FileFacts {
  const url = text.match(/templateUrl\s*:\s*['"`]([^'"`]+)['"`]/)?.[1], inline = text.match(/\btemplate\s*:\s*`([\s\S]*?)`/)?.[1]
  const html = url ? snap.get(join(path, '..', url).replace(/^\.\//, '')) : inline
  if (html === undefined) return fileFacts(path, text)
  const tsx = `${text}\nexport function __Template() { return (<>${ngTemplateToJsx(html)}</>) }\n`
  const errors = (ts.createSourceFile(path + 'x', tsx, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX) as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics?.length ?? 0
  return errors ? fileFacts(path, text) : fileFacts(path + 'x', tsx)
}
// A .vue / .svelte file: its script and its template as TSX. If the template didn't come out as clean TSX, keep only the script's facts:
// fewer facts, never wrong ones (a stray quote could otherwise put code on the card as "visible text").
function sfcFacts(path: string, text: string): FileFacts {
  const tsx = sfcToTsx(path, text)
  const errors = (ts.createSourceFile(path, tsx, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX) as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics?.length ?? 0
  return fileFacts(path, errors ? sfcToTsx(path, text, false) : tsx)
}

export function fileFacts(path: string, text: string): FileFacts {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    /(tsx|\.vue|\.svelte)$/.test(path) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JSX)
  const f = collect(sf, sf, empty(printer.printFile(sf)))
  f.todos = text.match(/\/\/\s*(TODO|FIXME|HACK)\b[^\n]*/g)?.map(t => t.replace(/^\/\/\s*/, '')) ?? []
  const addFn = (name: string, node: ts.Node) => {
    f.fns.set(name, printer.printNode(ts.EmitHint.Unspecified, node, sf))
    if (/^(get|fetch|load|list)[A-Z]/.test(name) && returnsLiteralOnly(node)) f.hardcoded.push(name)
  }
  // SvelteKit form actions: export const actions = { default: async ({ request, locals }) => ..., create: ... } satisfies Actions.
  // Each one is a POST to its page; plain.ts gives them the page's address.
  for (const st of sf.statements) if (isExported(st) && ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
    let init = d.initializer
    while (init && (ts.isSatisfiesExpression(init) || ts.isAsExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression
    if (ts.isIdentifier(d.name) && d.name.text === 'actions' && init && ts.isObjectLiteralExpression(init))
      for (const q of init.properties) {
        const fn = ts.isPropertyAssignment(q) ? q.initializer : ts.isMethodDeclaration(q) ? q : undefined
        if (fn && q.name) f.handlers.push({ server: '@actions', method: 'POST', path: q.name.getText(sf), guard: false, mw: [],
          facts: collect(sf, fn, empty(printer.printNode(ts.EmitHint.Unspecified, fn, sf))) })
      }
  }
  // Nuxt: export default defineEventHandler(async (event) => { ... }): the handler's own check, not a helper elsewhere in the file
  for (const st of sf.statements) if (ts.isExportAssignment(st)) { const g = collect(sf, st.expression, empty('')); f.exportAuth = handlerChecks(g) }
  if ([...f.binds].some(([k, m]) => k === 'env' && /^\$env\/dynamic\//.test(m))) for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) { f.env.add(m[1]); f.envReq.add(m[1]) }
  for (const st of sf.statements) {
    if (isExported(st) && ts.isVariableStatement(st))   // export const POST = withErrors(async () => ...)
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && METHODS.includes(d.name.text) && d.initializer && ts.isCallExpression(d.initializer))
        f.fns.set(d.name.text, printer.printNode(ts.EmitHint.Unspecified, d.initializer, sf))
    if (isExported(st)) for (const d of ts.isVariableStatement(st) ? st.declarationList.declarations : [st as ts.DeclarationStatement])
      if (d.name && ts.isIdentifier(d.name)) f.exports.add(d.name.text)
    // (export const load = (async () => ...) satisfies PageServerLoad: unwrapped)
    const unwrap = (e?: ts.Expression): ts.Expression | undefined => e && (ts.isSatisfiesExpression(e) || ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) ? unwrap(e.expression) : e
    const fns: [string, ts.Node][] = ts.isFunctionDeclaration(st) && st.name ? [[st.name.text, st]]
      : ts.isVariableStatement(st) ? st.declarationList.declarations.filter(d => ts.isIdentifier(d.name) && fnLike(unwrap(d.initializer))).map(d => [(d.name as ts.Identifier).text, unwrap(d.initializer)!])
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
  const servers = new Set<string>(), guarded = new Set<string>(), guardMw = new Map<string, string[]>()   // guardMw: router.use(requireAuth, requireAdmin)'s names
  let sbClients = clientsOf.get(sf)
  if (!sbClients) {
    clientsOf.set(sf, sbClients = new Set())
    for (const st of sf.statements) if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.initializer && CLIENT_MAKER.test(d.initializer.getText(sf))) sbClients.add(d.name.text)
  }
  const isGuard = (a: ts.Node) => !fnLike(a) && GUARD.test(a.getText(sf)) && !NOT_GUARD.test(a.getText(sf))
  const addHandler = (server: string, method: string, path: string, mw: readonly ts.Expression[], h: ts.Expression) =>
    f.handlers.push({ server, method: method.toUpperCase(), path, guard: guarded.has(server) || mw.some(isGuard), mw: [...guardMw.get(server) ?? [], ...mw.map(m => m.getText(sf))],
      handler: ts.isIdentifier(h) ? h.text : undefined, facts: fnLike(h) ? collect(sf, h, empty(printer.printNode(ts.EmitHint.Unspecified, h, sf))) : empty(h.getText(sf)) })
  const labelFor = new Map<string, string>(), boxes: { id?: string; type: string; v?: string; aria: boolean }[] = []
  const str = (e?: ts.Node) => e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text
    : e && ts.isTemplateExpression(e) ? e.head.text + e.templateSpans.map(t => '[…]' + t.literal.text).join('') : undefined
  // Next.js: the page or layout itself (the default export) and getServerSideProps, where a page's own login check has to be
  {
    const starts: number[] = [], byName = new Map<string, number>()
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) byName.set(st.name.text, st.getStart(sf))
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && fnLike(d.initializer)) byName.set(d.name.text, d.initializer.getStart(sf))
    }
    const named = new Set<string>()
    for (const st of sf.statements) {
      const def = ts.isFunctionDeclaration(st) && st.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)
      if (def) starts.push(st.getStart(sf))
      if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) named.add(st.expression.text)
      if (ts.isExportAssignment(st) && fnLike(st.expression)) starts.push(st.expression.getStart(sf))
      // export default withTracking(Page): the page inside
      if (ts.isExportAssignment(st) && ts.isCallExpression(st.expression)) for (const a of st.expression.arguments) if (ts.isIdentifier(a)) named.add(a.text)
      // export { Page as default }
      if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) if (e.name.text === 'default') named.add((e.propertyName ?? e.name).text)
    }
    for (const n of named) if (byName.has(n)) starts.push(byName.get(n)!)
    if (byName.has('getServerSideProps')) starts.push(byName.get('getServerSideProps')!)
    // (and the file's own functions it calls, one level: `await getUserOrRedirect()`)
    const fnAt = new Map([...byName].map(([n, at]) => [at, n]))
    for (const at of [...starts]) { const node = sf.statements.flatMap(st => [st, ...(ts.isVariableStatement(st) ? st.declarationList.declarations.map(d => d.initializer!).filter(Boolean) : [])]).find(x => x.getStart(sf) === at)
      if (node) for (const m of node.getText(sf).matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) if (byName.has(m[1]) && fnAt.get(at) !== m[1]) starts.push(byName.get(m[1])!) }
    f.pageFns = starts
  }
  // Next.js server actions: a file that starts with 'use server' makes each exported function one (a POST anyone can send).
  // Login is claimed only when its own code turns guests away; through a helper (requireWorkspaceMember) plain can't tell yet,
  // so it says nothing either way.
  // ponytail: own-code checks only; follow imported require* helpers to claim login through them
  const first = sf.statements[0]
  if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use server')
    for (const st of sf.statements) {
      const fn = ts.isFunctionDeclaration(st) && isExported(st) && st.name ? st : ts.isVariableStatement(st) && isExported(st) ? st.declarationList.declarations.find(d => d.initializer && fnLike(d.initializer)) : undefined
      const name = fn?.name && ts.isIdentifier(fn.name) ? fn.name.text : undefined
      if (!name) continue
      // (its facts are the file's top-level function of that name; guard decided in appFacts, unknown unless its own code checks)
      f.handlers.push({ server: '', method: 'POST', path: `(server action) ${name}`, guard: false, mw: [], handler: name, facts: empty(''), unknown: true, nextAction: true } as FileFacts['handlers'][number]); f.serverFns.set(name, 'POST')
    }
  // Where a check sits decides whether it runs for the request, and in time:
  //  - inside a callback, an inner function, a catch, an else branch or a switch case: not on every request -> unread (null)
  //  - in handleFetch / handleError: not the request's own hook -> null
  //  - after resolve(event) or after a write: the request already ran -> null
  // Otherwise: the conditions of the ifs around it (a check inside `if (path.startsWith('/api/admin'))` applies there only;
  // a non-path condition around it makes it unreadable, covering nothing), and the function it's in (skips only apply within it).
  const WRITE_CALL = /\bresolve\s*\(|\.(create|createMany|update|updateMany|upsert|delete|deleteMany|insert|destroy|save)\s*\(/
  const fnLikeNode = (c: ts.Node) => ts.isFunctionDeclaration(c) || ts.isFunctionExpression(c) || ts.isArrowFunction(c) || ts.isMethodDeclaration(c)
  const context = (n: ts.Node): { conds: string[]; fn: number } | null => {
    const conds: string[] = []
    let fns = 0, fn: ts.Node | undefined
    for (let c: ts.Node = n; c.parent && c !== root; c = c.parent) {
      const p = c.parent
      if (ts.isIfStatement(p) && c === p.thenStatement)
        conds.push(...flat(p.expression, ts.SyntaxKind.AmpersandAmpersandToken).map(x => PATH_TEST.test(x.getText(sf)) ? x.getText(sf) : 'pathname /* unread */'))
      if (ts.isIfStatement(p) && c === p.elseStatement || ts.isCatchClause(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) return null
      if (fnLikeNode(p) && p !== root) { fns++; fn ??= p }
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && /^handle(Fetch|Error|ServerError)$/.test(p.name.text) || ts.isFunctionDeclaration(p) && /^handle(Fetch|Error|ServerError)$/.test(p.name?.text ?? '')) return null
    }
    // the handler itself (root) or one top-level function (handle, a load, an authGuard passed to sequence) is fine; a function inside that isn't
    if (fns > (fnLikeNode(root) ? 0 : 1)) return null   // (a file, or defineEventHandler(<the handler>): one level in)
    if (ts.isSourceFile(root) && fns === 0) return null   // module-level code runs once at startup, not per request
    const body = fn ?? root, before = sf.text.slice(body.getStart(sf), n.getStart(sf))
    if (WRITE_CALL.test(before.slice(before.indexOf('{') + 1))) return null
    return { conds, fn: body.getStart(sf) }
  }
  // the branch's own statements (not ifs nested inside it): what the branch itself does when the condition holds
  const own = (s: ts.Statement) => (ts.isBlock(s) ? [...s.statements] : [s]).filter(x => !ts.isIfStatement(x) && !ts.isForStatement(x) && !ts.isForOfStatement(x) && !ts.isWhileStatement(x) && !ts.isTryStatement(x) && !ts.isSwitchStatement(x)).map(x => x.getText(sf)).join('\n')
  // `session` / `user` from something that isn't a login (stripe.checkout.sessions.retrieve(...), prisma.user.findUnique(...)) isn't a login check
  const declOf = new Map<string, string>()
  const declVisit = (x: ts.Node): void => { if (ts.isVariableDeclaration(x) && x.initializer) for (const id of ts.isIdentifier(x.name) ? [x.name] : ts.isObjectBindingPattern(x.name) ? x.name.elements.map(e => e.name).filter(ts.isIdentifier) : []) declOf.set(id.text, x.initializer.getText(sf)); ts.forEachChild(x, declVisit) }
  declVisit(root)
  const NOT_AUTH_SOURCE = /\bstripe\b|\bprisma\.|\bdb\.|\bfetch\(|\$fetch\(|\.from\(|\.retrieve\(|\.find(Unique|First|Many)\w*\(|\.select\(|\bquery\(/
  const authSourced = (cond: ts.Expression) => { const roots = [...cond.getText(sf).matchAll(/!?\s*\(?\s*(?:await\s+)?([A-Za-z_$][\w$]*)/g)].map(m => m[1])
    return !roots.some(r => /^(user|session|currentUser|claims|auth)$/.test(r) && NOT_AUTH_SOURCE.test(declOf.get(r) ?? '')) }
  const visit = (n: ts.Node) => {
    // A real login check: an `if` that tests the logged-in user and stops inside that branch, or a require*() helper that does it.
    if (ts.isIfStatement(n)) {
      const groups = authSourced(n.expression) ? loginGroups(n.expression, sf) : []
      const positive = isLoginRef(n.expression, sf) && authSourced(n.expression) && n.elseStatement   // if (locals.user) { ... } else { redirect(...) }
      const branchNode = groups.length ? n.thenStatement : positive ? n.elseStatement! : undefined
      const branch = branchNode ? own(branchNode) : '', ctx = branch ? context(n) : null
      // SvelteKit hides admin pages with a 404 too: error(404) under `!locals.user` turns people away
      const stops = hardStop(branch) || /\berror\s*\(\s*404/.test(branch) && /\blocals\./.test(n.expression.getText(sf))
      // (Next.js pages router: getServerSideProps turns guests away with `return { redirect: ... }` / `return { notFound: true }`)
      if (ctx && !stops && /\breturn\s*\{\s*(?:redirect|notFound)\b/.test(branch)) { f.authStop = true; f.authIfs.push(...(groups.length ? groups : ['']).map(g => ({ g: [g, ...ctx.conds].filter(Boolean).join(' && '), at: n.getStart(sf), fn: ctx.fn }))) }
      else if (ctx && stops) { f.authStop = true; f.authIfs.push(...(groups.length ? groups : ['']).map(g => ({ g: [g, ...ctx.conds].filter(Boolean).join(' && '), at: n.getStart(sf), fn: ctx.fn }))) }
      else if (ctx && RETURNS.test(branch)) {
        // in a handler a return-style check stops the request; in a hook or middleware it lets anonymous visitors through: a skip for them
        f.authReturn = true; f.skipIfs.push({ c: groups.length ? groups.join(' || ') || 'true' : 'true', at: n.getStart(sf), fn: ctx.fn })
      }
      // an early return that lets requests through before any check (`if (pathname === '/health') return ...`, `if (!sessionId) return resolve(event)`):
      // those requests skip the check. Nuxt's `if (import.meta.server) return` is no skip: the middleware runs again in the browser.
      else if (!groups.length && !positive && /\breturn\b/.test(n.thenStatement.getText(sf)) && !/import\.meta\.(server|client)/.test(n.expression.getText(sf)) && !hardStop(own(n.thenStatement))) {
        const c = context(n); if (c) f.skipIfs.push({ c: n.expression.getText(sf), at: n.getStart(sf), fn: c.fn })
      }
    }
    // locals.user ?? redirect(303, '/login'), user || error(401)
    if (ts.isBinaryExpression(n) && /^(\?\?|\|\|)$/.test(n.operatorToken.getText(sf)) && isLoginRef(n.left, sf) && hardStop(n.right.getText(sf))) {
      const ctx = context(n); if (ctx) { f.authStop = true; f.authIfs.push({ g: ctx.conds.join(' && '), at: n.getStart(sf), fn: ctx.fn }) }
    }
    // requireUserSession(event): everywhere, or only where the ifs around it say
    if (ts.isCallExpression(n) && (REQUIRE_LOGIN.test(n.expression.getText(sf).split('.').at(-1)!) || /^auth\.protect$/.test(n.expression.getText(sf)))) {   // (Clerk's auth.protect())
      const ctx = context(n); if (ctx) { f.authStop = true; f.authIfs.push({ g: ctx.conds.join(' && '), at: n.getStart(sf), fn: ctx.fn }) }
    }
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
        // fetch, and Nuxt's $fetch / useFetch('/api/x', { method: 'POST' })
        if (/^(fetch|\$fetch|useFetch|useLazyFetch)$/.test(callee.text) && arg?.startsWith('/')) f.fetches.add(`${method} ${arg.split('?')[0]}`)
        const host = callee.text === 'fetch' && HOSTS[arg?.match(/^https?:\/\/([^/]+)/)?.[1] ?? '']
        if (host) { f.services.add(host); f.outside.add(`${host}: ${EMAIL.has(host) ? 'emails.send' : 'request'}`) }
        else if (/^(navigate|navigateTo|goto)$/.test(callee.text) && arg?.startsWith('/')) f.links.add(arg)   // React Router, Nuxt, SvelteKit
        else if (/^(require|get|read|must)?_?env(ironment)?(_?var(iable)?)?$/i.test(callee.text) && arg && /^[A-Z][A-Z0-9_]*(_|KEY|SECRET|URL|TOKEN)[A-Z0-9_]*$/.test(arg) && arg !== 'NODE_ENV') {
          f.env.add(arg); if (n.arguments.length === 1) f.envReq.add(arg)   // requireEnv('STRIPE_KEY'); env('X', 'default') has a default
        }
        else if (arg?.startsWith('/') && callee.text !== 'require') f.calls.push({ name: callee.text, path: arg.split('?')[0], method, prop: false })
        if (callee.text === 'require' && arg) { f.imports.push(arg); if (SERVICES[arg]) f.services.add(SERVICES[arg]) }
      } else if (ts.isPropertyAccessExpression(callee)) {
        // getStripe().checkout.sessions.create(...) is stripe.checkout.sessions.create(...)
        const parts = callee.getText(sf).replace(/\s|\?/g, '').replace(/^(?:get|use)(Stripe|Openai|OpenAI|Resend|Anthropic|Supabase)\(\)/, (_, c: string) => c.toLowerCase()).split('.')
        const obj = parts.slice(0, -1).join('.'), last = parts.at(-1)!, args = n.arguments
        const chain = obj.match(/^([\w$]+)\.route\((['"`])([^'"`]+)\2\)/)   // app.route('/x').get(h).post(h)
        if (servers.has(obj) && last === 'use') {
          const t = args.at(-1)!, spec = ts.isCallExpression(t) && t.expression.getText(sf) === 'require' ? str(t.arguments[0]) : undefined
          // app.use('/api/x', thing): a router, or a login check for everything under /api/x. appFacts decides by looking at the file.
          // (a router made by a factory, createMessagesRouter(io): the function's file declares the routes)
          const made = ts.isCallExpression(t) && ts.isIdentifier(t.expression) && !spec ? t.expression.text : undefined
          if (arg?.startsWith('/') && (ts.isIdentifier(t) || spec || made)) f.mounts.push({ server: obj, path: arg, target: spec ?? made ?? t.getText(sf),
            guard: guarded.has(obj) || args.slice(1, -1).some(isGuard), guardLike: args.length === 2 && !spec && !made && isGuard(t), mw: [...guardMw.get(obj) ?? [], ...args.slice(1, -1).filter(isGuard).map(a => a.getText(sf))] })
          else if (!arg && args.some(isGuard)) { guarded.add(obj); guardMw.set(obj, [...guardMw.get(obj) ?? [], ...args.filter(isGuard).map(a => a.getText(sf))]) }
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
        if (/^(prisma|db|tx|trx)$/.test(parts[0]) && parts.length === 3 && !parts[1].startsWith('$') && !parts[1].includes('(')) {
          f.tables.add(cap(parts[1]))
          if (WRITES.test(parts[2])) { f.writes = true; f.written.add(cap(parts[1])); f.ops.add(parts[2].replace(/Many$/, '').replace('upsert', 'create')) }
        }
        // Drizzle: db.insert(orders).values(...), db.update(orders).set(...), db.delete(orders), db.select().from(orders), db.query.orders.findMany()
        // (also in a transaction: tx.insert(...)); the table is the schema variable, ordersTable -> orders
        const dz = /^(db|tx|trx|database)$/i.test(obj) && /^(insert|update|delete|from)$/.test(last) && n.arguments[0] && ts.isIdentifier(n.arguments[0]) ? n.arguments[0].text.replace(/Table$/, '') : undefined
        if (dz && last !== 'from') { f.tables.add(dz); f.written.add(dz); f.writes = true; f.ops.add(last === 'insert' ? 'create' : last) }
        else if (dz || last === 'from' && /^(db|tx)\.select\(/.test(obj) && n.arguments[0] && ts.isIdentifier(n.arguments[0])) f.tables.add((n.arguments[0] as ts.Identifier).text.replace(/Table$/, ''))
        if (/^(db|tx)$/.test(parts[0]) && parts[1] === 'query' && parts.length === 4) f.tables.add(parts[2].replace(/Table$/, ''))
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
      const path = chain.reduce((acc, r) => r.path === undefined ? acc : r.path.startsWith('/') ? r.path : `${acc.replace(/\/$/, '')}/${r.path}`, '').replace(/(.)\/$/, '$1')
      if (route.comp && (route.path !== undefined || route.index) && !path.includes('*'))
        f.pages.push({ path: path || '/', comp: route.comp, guard: chain.some(r => r.guard === true) || (chain.some(r => r.guard === 'unknown') ? 'unknown' : false) })
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) f.jsx.add(n.tagName.getText(sf))
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const mod = n.moduleSpecifier.text
      f.imports.push(mod)
      if (SERVICES[pkgName(mod)]) f.services.add(SERVICES[pkgName(mod)])
      // SvelteKit: import { STRIPE_SECRET_KEY } from '$env/static/private' needs that variable (env.X from $env/dynamic/* is read in fileFacts)
      if (/^\$env\/static\/(private|public)$/.test(mod) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings))
        for (const el of n.importClause.namedBindings.elements) { const k = (el.propertyName ?? el.name).text; f.env.add(k); f.envReq.add(k) }
      const c = n.importClause
      if (c?.name) { f.used.add(c.name.text); f.binds.set(c.name.text, mod) }
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings))
        for (const el of c.namedBindings.elements) { f.used.add((el.propertyName ?? el.name).text); f.binds.set(el.name.text, mod); if (el.propertyName) f.binds.set(el.propertyName.text, mod) }
    }
    if (ts.isJsxAttribute(n) && n.initializer) {
      const v = str(n.initializer), name = n.name.getText(sf)
      // <a href>; Vue's <NuxtLink to> / <RouterLink to> (React Router's <Link to> stays out: those cards never listed it)
      const tag = ts.isJsxAttributes(n.parent) && (ts.isJsxOpeningElement(n.parent.parent) || ts.isJsxSelfClosingElement(n.parent.parent)) ? n.parent.parent.tagName.getText(sf) : ''
      if (v && (name === 'href' || name === 'routerLink' || name === 'to' && /^(NuxtLink|RouterLink|nuxt-link|router-link)$/.test(tag)) && v.startsWith('/')) f.links.add(v.replace(/[?#].*$/, '') || '/')   // /#tutors is the home page; /login?returnTo=... is the login page
      // a SvelteKit <form method="POST" action="?/create">: sends to its own page's form actions (the page's address, filled in later)
      if (name === 'method' && v?.toUpperCase() === 'POST' && ts.isJsxAttributes(n.parent) && ts.isJsxOpeningElement(n.parent.parent) && n.parent.parent.tagName.getText(sf) === 'form') {
        const action = n.parent.properties.find(q => ts.isJsxAttribute(q) && q.name.getText(sf) === 'action') as ts.JsxAttribute | undefined, a = action?.initializer && str(action.initializer)
        f.fetches.add(`POST ${a && a.startsWith('/') ? a.split('?')[0] : '@self'}`)
      }
    }
    // Visible text of an element, minus the choices of a dropdown (a <label> around a <select> is just its name).
    const textOf = (el: ts.JsxElement): string => el.children.map(c => ts.isJsxText(c) ? c.text
      : ts.isJsxElement(c) && !/^(select|option|textarea)$/.test(c.openingElement.tagName.getText(sf)) ? textOf(c) : ' ').join('').replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim()
    // A box is named by its aria-label, its type (email, password), the <label> around it, its placeholder, or its name.
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /^(input|textarea|select)$/.test(n.tagName.getText(sf))) {
      const at = (k: string) => { const a = n.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(sf) === k) as ts.JsxAttribute | undefined; return a?.initializer && str(a.initializer) }
      const type = at('type') ?? '', el = ts.isJsxOpeningElement(n) ? n.parent.parent : n.parent
      const label = ts.isJsxElement(el) && el.openingElement.tagName.getText(sf) === 'label' ? textOf(el) : ''
      if (type !== 'hidden') {   // <input type="hidden" name="bookingId"> is invisible plumbing
        boxes.push({ id: at('id'), type, v: at('aria-label') ?? (label || undefined), aria: !!at('aria-label') })
        // after <label htmlFor> is known; a name attribute is code (bookingId), said in words (booking)
        if (!boxes.at(-1)!.v) boxes.at(-1)!.v = at('placeholder') ?? (at('name') && words(at('name')!.replace(/\[\]$/, '')).replace(/ id$/, ''))
        if (boxes.at(-1)!.v) boxes.at(-1)!.v = boxes.at(-1)!.v!.replace(/\s*\[(id|…)\]/g, '').trim() || undefined   // "Search {{ category }}" -> "Search"
      }
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
    if (n.kind === ts.SyntaxKind.AnyKeyword && !(n.parent && ts.isVariableDeclaration(n.parent) && n.parent.parent && ts.isCatchClause(n.parent.parent))) f.anys++   // catch (e: any) is the usual way to write it
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
function routeLike(n: ts.Node, sf: ts.SourceFile): { path?: string; index: boolean; comp?: string; guard: boolean | 'unknown' } | null {
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
    // Angular: loadComponent: () => import('./admin/admin').then(m => m.Admin) is the page; loadChildren: () => import('./admin/admin.routes') its routes
    const lazy = (k: string) => { const t = prop(k)?.initializer.getText(sf); const m = t?.match(/import\(\s*['"`]([^'"`]+)['"`]\s*\)(?:\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\2\.(\w+))?/); return m ? `${m[1]}#${m[3] ?? ''}` : undefined }
    const lc = lazy('loadComponent'), lch = lazy('loadChildren')
    // canActivate / canMatch / canActivateChild: [authGuard] or an inline () => inject(Auth).isLoggedIn() (canDeactivate guards leaving, not entering)
    // named guards by their name (authGuard, AdminGuard, MsalGuard; not NoAuthGuard / guestGuard, which keep logged-in people out);
    // an inline guard by what it calls (isLoggedIn(), currentUser, hasRole): a feature flag or onboarding check isn't a login
    const ng = ['canActivate', 'canMatch', 'canActivateChild', 'canLoad'].map(k => prop(k)?.initializer.getText(sf) ?? '').join(' ')
    const named = [...ng.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*(?=[,\]\(])/g)].map(m => m[1]).filter(x => !/^(inject|map|of|true|false)$/.test(x))
    const GUEST = /no[-_]?auth|guest|anon|public|loggedOut|notLogged|redirect\w*Logged|unauth/i
    const ngLogin = named.some(x => /auth|login|logged|signed|admin|role|session|user|protect|private|msal|okta|keycloak|oidc/i.test(x) && !GUEST.test(x))
      || /=>/.test(ng) && /is(Logged|Authenticated|SignedIn|Admin)|loggedIn|currentUser|hasRole|getToken|accessToken/i.test(ng)
    // a guard plain can't place: not "anyone can open", not "log in ✓" either
    const ngGuard: boolean | 'unknown' = ngLogin ? true : ng.trim() && named.length && !named.every(x => GUEST.test(x)) && !/feature|flag|onboard|unsaved|pending/i.test(ng) ? 'unknown' : false
    if (p ? !ts.isStringLiteral(p) || !(elp || lc || lch || prop('children')) : !elp || !(prop('index') || prop('children'))) return null   // layout and index routes have no path
    path = p && ts.isStringLiteral(p) ? p.text : undefined; index = !!prop('index'); el = elp?.initializer
    if (lc || lch) return { path: path?.replace(/:(\w+)\??/g, '[$1]'), index, comp: lc ? `@load:${lc}` : `@children:${lch}`, guard: ngGuard }
    if (ngGuard) return { path: path?.replace(/:(\w+)\??/g, '[$1]'), index, comp: el?.getText(sf), guard: ngGuard }
  } else return null
  const names = el && (ts.isJsxExpression(el) || ts.isJsxElement(el) || ts.isJsxSelfClosingElement(el)) ? tags(el) : el ? [el.getText(sf).replace(/[{}\s]/g, '')] : []
  const comp = names.filter(t => /^[A-Z]/.test(t) && !PAGE_GUARD.test(t) && !/^(Navigate|Suspense|Outlet|Fragment)$/.test(t)).at(-1)
  return { path: path?.replace(/:(\w+)\??/g, '[$1]'), index, comp, guard: names.some(t => PAGE_GUARD.test(t)) }
}

// A "get/fetch/list" function that returns a literal and never awaits or queries anything.
function returnsLiteralOnly(fn: ts.Node): boolean {
  let literal = false, real = false
  // a calculator (getPrice(rate, hours) => ({ total: rate * hours })) computes from its inputs: not made-up data
  const params = ts.isFunctionLike(fn) ? (fn as ts.SignatureDeclaration).parameters.map(p => p.name.getText()) : []
  const calc = (e: ts.Node) => params.some(x => new RegExp(`\\b${x}\\b`).test(e.getText())) && !/['"`]/.test(e.getText())
  const visit = (n: ts.Node) => {
    if (ts.isAwaitExpression(n) || (ts.isCallExpression(n) && /prisma|fetch|supabase|db\./.test(n.expression.getText()))) real = true
    if (ts.isReturnStatement(n) && n.expression && (ts.isArrayLiteralExpression(n.expression) || ts.isObjectLiteralExpression(n.expression)) && !calc(n.expression)) literal = true
    if (ts.isArrowFunction(n) && (ts.isArrayLiteralExpression(n.body) || ts.isObjectLiteralExpression(n.body)) && !calc(n.body)) literal = true
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

// Go migrations: golang-migrate's *.up.sql, and goose's .sql files (their Up part)
const goMigration = (p: string) => /\.up\.sql$/.test(p) && !/(^|\/)(supabase|prisma)\//.test(p) || /(^|\/)(migrations|db\/migrations|sql\/schema|schema)\/\d+[\w-]*\.sql$/.test(p) && !/\.down\.sql$/.test(p) && !/(^|\/)(supabase|prisma|drizzle)\//.test(p)
export function appFacts(snap: Snap) {
  const files = new Map<string, FileFacts>()
  for (const [p, t] of snap) if (CODE.test(p) && !p.includes('node_modules/') && !/(^|\/)(vendor|storage|bootstrap\/cache|tmp|log)\//.test(p)) {
    // (EF migrations and their snapshots are read as migrations, not as code)
    if (/(^|\/)Migrations\/[^/]+\.cs$/.test(p)) continue
    try { const f = p.endsWith('.go') ? goFacts(p, t, empty) : p.endsWith('.rb') ? rbFacts(p, t, empty) : p.endsWith('.php') ? phpFacts(p, t, empty) : p.endsWith('.java') ? javaFacts(p, t, empty) : p.endsWith('.cs') ? csFacts(p, t, empty) : p.endsWith('.py') ? pyFacts(p, t, empty) : /\.(vue|svelte)$/.test(p) ? sfcFacts(p, t) : /@Component\s*\(/.test(t) && /@angular\/core/.test(t) ? ngFacts(p, t, snap) : fileFacts(p, t); if (f) files.set(p, f) } catch { /* unparsable file: report nothing about it */ }
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
    // two apps with the same module name (shop/urls.py, legacy/shop/urls.py): the one closest to the importing file
    const near = (x: string) => [...files.keys()].filter(k => k.endsWith('/' + x)).sort((a, b) => shared(b) - shared(a) || a.length - b.length)[0]
    const shared = (k: string) => { let i = 0; while (i < k.length && k[i] === from[i]) i++; return i }
    return tries.map(x => files.has(x) ? x : dots ? undefined : near(x)).find(Boolean)
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
    ...[...snap].filter(([p]) => /(^|\/)(requirements[\w-]*\.txt|pyproject\.toml)$/.test(p)).map(([p, t]) => pyDeps(t, p)),
    // Java: pom.xml <artifactId> (with <version>), build.gradle implementation 'group:artifact:version'
    ...[...snap].filter(([p]) => /(^|\/)pom\.xml$/.test(p)).map(([, t]) => Object.fromEntries([...t.replace(/<parent>[\s\S]*?<\/parent>|<plugins>[\s\S]*?<\/plugins>/g, '').matchAll(/<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>(?:[\s\S]*?<version>([^<]+)<\/version>)?[\s\S]*?<\/dependency>/g)].map(m => [m[1], m[2] ?? '*']))),
    ...[...snap].filter(([p]) => /(^|\/)build\.gradle(\.kts)?$/.test(p)).map(([, t]) => Object.fromEntries([...t.matchAll(/(?:implementation|api|runtimeOnly|compileOnly)\s*\(?\s*['"]([\w.-]+):([\w.-]+)(?::([\w.-]+))?['"]/g)].map(m => [m[2], m[3] ?? '*']))),
    // Ruby: Gemfile `gem "stripe", "~> 13.0"`
    ...[...snap].filter(([p]) => /(^|\/)Gemfile$/.test(p)).map(([, t]) => Object.fromEntries([...t.matchAll(/^\s*gem\s+["']([\w-]+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)].map(m => [m[1], m[2] ?? '*']))),
    // PHP: composer.json require / require-dev
    ...[...snap].filter(([p]) => /(^|\/)composer\.json$/.test(p) && !/(^|\/)vendor\//.test(p)).map(([, t]) => { try { const j = JSON.parse(t); return Object.fromEntries(Object.entries({ ...j.require, ...j['require-dev'] }).filter(([k]) => k.includes('/'))) } catch { return {} } }),   // (not php, ext-*)
    // .NET: <PackageReference Include="Stripe.net" Version="47.0.0" />
    ...[...snap].filter(([p]) => p.endsWith('.csproj')).map(([, t]) => Object.fromEntries([...t.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]*)")?/g)].map(m => [m[1], m[2] ?? '*'])))) as Record<string, string>
  for (const p of files.keys()) { const r = route(p, 'next' in deps_); if (r) routes.set(p, r) }
  // Next.js pages: logged in when the page, or a layout above it, turns guests away (`if (!session) redirect('/login')`).
  // Reading the session to pick a "Log in" button, or sending logged-in people on from /login, doesn't.
  for (const [p, r] of routes) if (r.kind === 'page' && /^(?:src\/)?(?:app|pages)\//.test(p)) {
    const dirs = p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/')).filter(d => /^(?:src\/)?app(\/|$)/.test(d))
    const layouts = dirs.flatMap(d => ['tsx', 'jsx', 'js', 'ts'].map(x => `${d}/layout.${x}`)).filter(l => files.has(l))
    // (only the page or layout itself: not a "use server" function or a small component in the same file, not a guest-view return)
    const own = (g?: FileFacts) => !!g && g.authIfs.some(x => !x.g && (g.pageFns ?? []).includes(x.fn))
    files.get(p)!.auth = own(files.get(p)) || layouts.some(l => own(files.get(l)))
  }
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
  const csModels = new Map<string, string[]>()   // Entity Framework entities (filled in below)
  const javaModels = new Map<string, string[]>()   // JPA @Entity classes
  const phpModels = new Map<string, string[]>()    // Laravel: the tables its migrations build
  const rbModels = new Map<string, string[]>()     // Rails: the same
  const goModels = new Map<string, string[]>()     // Go: GORM's AutoMigrate'd structs, and the tables SQL migrations build
  let goDb: Db | undefined, goOld: string | undefined   // goOld: go.mod's go version, when it's older than the route patterns need
  const goGorm = new Set<string>()                  // (models AutoMigrate keeps: it never drops a column)
  const svelteUrls = new Map<string, string>()   // SvelteKit pages: their <form method="POST"> sends to this address
  // Where a hook's or middleware's login check applies: each checking `if` covers what its path tests allow, and an earlier
  // `if (<path test>) return ...` lets those addresses through unchecked. Tests: startsWith, ===, !==, ['/a', '/b'].includes(path),
  // each possibly negated; a path or route-id test plain can't read makes that `if` cover nothing (never a false ✓).
  const PATH_RE = 'pathname|event\\.path|to\\.path|to\\.fullPath|url\\.path|getRequestURL\\(event\\)\\.pathname'
  const test = (t: string) => {   // one AND-group of path tests -> (url, id) => boolean, or undefined if it can't be read
    if (/\|\||!\s*\(/.test(t)) return undefined   // !(a || b) and mixed ors: not read
    const preds: ((url: string, id: string) => boolean)[] = []
    let rest = t
    for (const m of t.matchAll(new RegExp(`(!\\s*)?[\\w.?()]*?(${PATH_RE}|route\\.id\\??)\\s*(\\.startsWith\\(|===?|!==?)\\s*['"\`](\\/[^'"\`]*)['"\`]\\)?`, 'g'))) {
      const [all, neg, kind, op, v] = m, onId = kind.startsWith('route')
      const under = (x: string) => x === v || x.startsWith(v.replace(/\/$/, '') + '/') || v.endsWith('/') && x.startsWith(v) || onId && x.startsWith(v)
      // a negated startsWith excludes by characters, as JavaScript does ('/api/public-export'.startsWith('/api/public')); a plain one includes by segment
      const base = op.startsWith('.') ? (neg ? (x: string) => x.startsWith(v) : under) : op.startsWith('!') ? (x: string) => x !== v : (x: string) => x === v
      preds.push((url, id) => !!neg !== base(onId ? id : url)); rest = rest.replace(all, '')
    }
    for (const m of t.matchAll(new RegExp(`(!\\s*)?\\[([^\\]]*)\\]\\.includes\\(\\s*[\\w.?()]*?(?:${PATH_RE})\\s*\\)`, 'g'))) {
      const list = [...m[2].matchAll(/['"`](\/[^'"`]*)['"`]/g)].map(x => x[1]); preds.push(url => !!m[1] !== list.includes(url)); rest = rest.replace(m[0], '')
    }
    if (PATH_TEST.test(rest)) return undefined   // some path test left unread
    return (url: string, id: string) => preds.every(p => p(url, id))
  }
  const coverage = (f?: FileFacts) => {
    if (!f?.authStop) return () => false
    // a skip is an OR of AND-groups; one plain can't read (or that isn't about the path) might let anything through
    const skips = f.skipIfs.map(({ c, at, fn }) => { const groups = c === 'true' ? [() => true] : c.split('||').map(g => test(g)); return { at, fn, hits: groups.some(g => !g) ? () => true : (url: string, id: string) => groups.some(g => g!(url, id)) } })
    // each check covers its own scope, minus what an earlier early return in the same function lets through
    const checks = f.authIfs.map(({ g, at, fn }) => { const t = g ? test(g) : () => true; return (url: string, id: string) => !!t && t(url, id) && !skips.some(s => s.fn === fn && s.at < at && s.hits(url, id)) })
    return (url: string, id = url) => checks.some(c => c(url, id))
  }
  // Nuxt. Route middleware (middleware/auth.ts, auth.global.ts) turns people away from pages but runs in the Vue part of the app:
  // it never protects server/api. Server middleware with a login check covers every server route, or the paths it tests.
  if ('nuxt' in deps_) {
    // runtimeConfig: { resendApiKey: '', public: { appUrl: '' } } is filled from NUXT_RESEND_API_KEY / NUXT_PUBLIC_APP_URL; an empty default needs it set
    for (const [p, f] of files) if (/(^|\/)nuxt\.config\.[cm]?[jt]s$/.test(p)) {
      const t = snap.get(p) ?? '', at = t.search(/runtimeConfig\s*:\s*\{/)
      if (at < 0) continue
      // nested keys add up: public: { stripe: { pk: '' } } -> NUXT_PUBLIC_STRIPE_PK
      const keys: [string, string][] = [], path: string[] = ['NUXT']
      for (const raw of t.slice(t.indexOf('{', at) + 1).split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim()
        if (!line) continue
        if (/^\}/.test(line)) { if (path.length === 1) break; path.pop(); continue }
        const m = line.match(/^['"]?(\w+)['"]?\s*:\s*(.*?),?$/)
        if (!m) continue
        if (m[2] === '{') path.push(m[1])
        else keys.push([[...path, m[1]].join('_'), m[2]])
      }
      for (const [k, v] of keys) if (/^(''|""|``|undefined|null)$/.test(v)) {
        const env = k.replace(/([a-z0-9])([A-Z])|([A-Z])([A-Z][a-z])/g, (_, a, b, c, d) => a ? `${a}_${b}` : `${c}_${d}`).toUpperCase(); f.env.add(env); f.envReq.add(env)   // APIKey -> API_KEY
      }
    }
    const mw = new Map<string, { global: boolean; covers: (url: string) => boolean }>()
    for (const [p, f] of files) { const m = p.match(/^(?:app\/)?middleware\/([\w-]+?)(\.global)?\.[cm]?[jt]s$/); if (m) mw.set(m[1], { global: !!m[2], covers: coverage(f) }) }
    // @sidebase/nuxt-auth: its own middleware, on every page with globalAppMiddleware enabled (except definePageMeta({ auth: false }))
    const sidebase = '@sidebase/nuxt-auth' in deps_
    const sbGlobal = sidebase && [...snap].some(([p, t]) => /(^|\/)nuxt\.config\.[cm]?[jt]s$/.test(p) && /globalAppMiddleware\s*:\s*(true\b|\{(?![^}]*isEnabled\s*:\s*false))/.test(t.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')))
    if (sidebase) mw.set('sidebase-auth', { global: false, covers: () => true })
    const serverGuards = [...files].filter(([p]) => /^server\/middleware\//.test(p)).map(([, f]) => coverage(f))
    const pageFiles = new Map([...files.keys()].flatMap(p => { const r = nuxtRoute(p); return r?.kind === 'page' ? [[p, r] as const] : [] }))
    const ownGuard = (p: string, url: string) => {
      const f = files.get(p)!, meta = f.printed.match(/definePageMeta\(\s*\{[\s\S]*?\}\s*\)/)?.[0] ?? ''
      const names = (meta.match(/middleware\s*:\s*(\[[^\]]*\]|['"`][\w-]+['"`])/)?.[1] ?? '').match(/['"`]([\w-]+)['"`]/g)?.map(x => x.slice(1, -1)) ?? []
      // an inline middleware counts when it sends people who aren't logged in somewhere
      const inline = /middleware\s*:[\s\S]*?if\s*\(\s*!\s*[\w.]*?(loggedIn|user|session)(\.value)?\s*\)\s*\{?\s*(return\s+)?(navigateTo|abortNavigation)\s*\(/.test(meta)
      return names.some(n => mw.get(n)?.covers(url)) || inline || sbGlobal && !/\bauth\s*:\s*(false\b|\{[^}]*unauthenticatedOnly\s*:\s*true)/.test(meta) || [...mw.values()].some(m => m.global && m.covers(url))
    }
    for (const [p, f] of [...files]) {
      const r = nuxtRoute(p); if (!r) continue
      if (r.kind === 'page') {
        routes.set(p, { kind: 'page', url: r.url }); browserPages.add(p)
        // a parent page (pages/admin.vue around pages/admin/users.vue) runs its middleware for the child too
        const parents = [...pageFiles.keys()].filter(q => q !== p && p.startsWith(q.replace(/\.vue$/, '/')))
        f.auth = ownGuard(p, r.url) || parents.some(q => ownGuard(q, r.url))
      } else {
        // no method in the name: it answers every method; call it POST if it reads a body or changes data
        const method = r.method ?? (f.writes || /\breadBody\(|readValidatedBody\(|readMultipartFormData\(|readFormData\(/.test(f.printed) ? 'POST' : 'GET')
        f.fns.set(method, f.printed)
        routes.set(p, { kind: 'endpoint', url: r.url })
        // defineEventHandler({ onRequest: [requireAuth], handler }) runs the check first
        const onRequest = (f.printed.match(/onRequest\s*:\s*(\[[^\]]*\]|[\w.]+)/)?.[1] ?? '').match(/\w+/g)?.some(x => REQUIRE_LOGIN.test(x)) ?? false
        f.auth = !!f.exportAuth || onRequest || serverGuards.some(g => g(r.url))
      }
    }
  }
  // SvelteKit. hooks.server.ts runs before everything (pages, form actions, +server.ts); a login check there covers the paths or route
  // groups it tests. A layout load that redirects keeps people out of the pages under it, but form actions run before any load and
  // +server.ts never runs one: those need their own check. A page's own server load runs without the layout's check unless it awaits
  // parent() first (client-side navigation fetches its data alone).
  if ('@sveltejs/kit' in deps_) {
    const covered = coverage([...files].find(([p]) => /^src\/hooks\.server\.[jt]s$/.test(p))?.[1])
    const sv = new Map([...files.keys()].flatMap(p => { const r = svelteRoute(p); return r ? [[p, r] as const] : [] }))
    // a layout or page load only keeps people out by throwing (redirect / error); one that returns { user: null } lets the page render
    const loadStops = (g?: FileFacts) => !!g && g.authIfs.some(x => !x.g)
    const layoutGuards = [...sv].filter(([p, r]) => r.file === 'layout' && !p.endsWith('.svelte') && loadStops(loadOf(p))).map(([, r]) => r.id)
    function loadOf(p: string) { return files.get(p)?.locals.get('load') }
    const checks = handlerChecks
    for (const [p, r] of sv) {
      const f = files.get(p)!, dir = p.slice(0, p.lastIndexOf('/') + 1)
      if (r.file === 'page') {
        routes.set(p, { kind: 'page', url: r.url }); browserPages.add(p); svelteUrls.set(p, r.url)
        // what its load functions read is what the page shows
        // (and a change to them is a change to the page)
        for (const q of [`${dir}+page.server.ts`, `${dir}+page.server.js`, `${dir}+page.ts`, `${dir}+page.js`]) { const l = loadOf(q); if (l) { for (const t of l.tables) f.tables.add(t); f.printed += `\n[load] ${l.printed}` } }
        const serverLoad = [`${dir}+page.server.ts`, `${dir}+page.server.js`].map(loadOf).find(Boolean)
        const g = f as FileFacts & { layoutLogin?: boolean; dataOpen?: boolean }
        g.layoutLogin = layoutGuards.some(id => r.id === id || r.id.startsWith(id.replace(/\/$/, '') + '/') || id === '/')
        f.auth = covered(r.url, r.id) || loadStops(serverLoad) || g.layoutLogin
        // the layout keeps people out of the page, but its own load hands its data to anyone who asks for it directly
        g.dataOpen = g.layoutLogin && !covered(r.url, r.id) && !!serverLoad && !loadStops(serverLoad) && !/await\s+(\w+\.)?parent\s*\(/.test(serverLoad.printed)
          && (serverLoad.tables.size > 0 || serverLoad.outside.size > 0 || serverLoad.fetches.size > 0)
      }
      if (r.file === 'pageServer') for (const h of f.handlers.filter(h => h.server === '@actions')) {
        h.guard = checks(h.facts) || covered(r.url, r.id); h.server = ''; h.path = r.url
      }
      if (r.file === 'server') {
        routes.set(p, { kind: 'endpoint', url: r.url })
        // each method on its own: a check in GET doesn't cover DELETE
        const ms = METHODS.filter(m => f.fns.has(m)), writes = ms.filter(m => m !== 'GET')
        f.auth = covered(r.url, r.id) || (writes.length ? writes : ms).length > 0 && (writes.length ? writes : ms).every(m => checks(f.locals.get(m)))
      }
    }
  }
  // ASP.NET Core: each endpoint's login, as ASP.NET decides it: AllowAnonymous anywhere on the way skips it; then [Authorize] /
  // RequireAuthorization() on the endpoint, its handler, its controller (and base classes) or a group; then the project's FallbackPolicy
  // (or a global AuthorizeFilter for controllers); then a check in the handler's own code.
  // App-wide rules belong to their project (the folder with its .csproj); test projects (WebApplicationFactory, *.Tests) don't count.
  const csFiles = [...files].filter(([p]) => p.endsWith('.cs')).map(([p, f]) => [p, (f as CsFacts).cs] as const)
  if (csFiles.length) {
    const projects = [...snap.keys()].filter(p => p.endsWith('.csproj')).map(p => p.slice(0, p.lastIndexOf('/') + 1))
    const projectOf = (p: string) => projects.filter(d => p.startsWith(d)).sort((a, b) => b.length - a.length)[0] ?? ''
    const isTest = (p: string) => /(^|\/)[\w.]*Tests?(\/|\.)|WebApplicationFactory/.test(p) || /WebApplicationFactory/.test(snap.get(p) ?? '')
    const appWide = (p: string, k: 'fallback' | 'allControllers') => csFiles.some(([q, c]) => c[k] && !isTest(q) && projectOf(q) === projectOf(p))
    // a handler given by name (OrderHandlers.Delete): that exact method first, then a method of that name anywhere
    const methodFacts = (h: string) => { const exact = h.split('.').slice(-2).join('.'), bare = h.split('.').at(-1)!
      for (const [, c] of csFiles) { const m = c.methods.get(exact); if (m) return m }
      for (const [, c] of csFiles) { const m = c.methods.get(bare) ?? [...c.methods].find(([k]) => k.endsWith('.' + bare))?.[1]; if (m) return m } }
    // DbSet<Order> PurchaseOrders: the table is called PurchaseOrders and stores Order rows
    const sets = new Map(csFiles.flatMap(([, c]) => [...c.dbsets]))
    const remap = (f: FileFacts) => { for (const k of ['tables', 'written'] as const) for (const t of [...f[k]]) if (sets.has(t)) { f[k].delete(t); f[k].add(sets.get(t)!) } return f }
    const add = (p: string, r: CsRoute & { auth: Auth }, controller: boolean) => {
      const m = r.handler ? methodFacts(r.handler) : undefined, facts = remap(r.facts ?? m ?? empty())
      const auth = mergeAuth(r.auth, m?.csAuth)
      const guard = auth === 'anon' ? false : auth === 'yes' || appWide(p, 'fallback') || controller && appWide(p, 'allControllers') || handlerChecks(facts)
      // a method with no verb (Map("/x"), [AcceptVerbs]/[Route] only) answers every one: read as POST if it changes data
      const method = r.method === 'ANY' ? (facts.writes ? 'POST' : 'GET') : r.method
      files.get(p)!.handlers.push({ server: '', method, path: r.path, guard, mw: [], facts })
    }
    for (const [p, c] of csFiles) if (!isTest(p)) for (const r of c.routes) add(p, r, false)
    // group.MapOrders() from another file: its routes under the group that calls it (and the extension calls it makes in turn)
    const exts = new Map(csFiles.flatMap(([p, c]) => [...c.ext].map(([k, v]) => [k, { p, ...v }] as const)))
    const mount = (call: ExtCall, depth = 0): void => {
      const e = exts.get(call.name); if (!e || depth > 5) return
      for (const r of e.routes) add(e.p, { ...r, path: under(call.prefix, r.path), auth: mergeAuth(call.auth, r.auth) }, false)
      for (const c of e.calls) mount({ name: c.name, prefix: under(call.prefix, c.prefix), auth: mergeAuth(call.auth, c.auth) }, depth + 1)
    }
    for (const [p, c] of csFiles) if (!isTest(p)) for (const call of c.extCalls) mount(call)
    // controllers: a class named ...Controller, or one whose chain has ControllerBase / Controller / [ApiController]; [Route] and
    // [Authorize] / [AllowAnonymous] come down from base classes too
    const classes = new Map(csFiles.flatMap(([p, c]) => [...c.classes].map(([k, v]) => [k, { p, ...v }] as const)))
    const chainOf = (name: string, seen = new Set<string>()): (CsClass & { p: string; name: string })[] => {
      const c = classes.get(name); if (!c || seen.has(name)) return []
      seen.add(name); return [{ ...c, name }, ...c.bases.flatMap(b => chainOf(b, seen))]
    }
    for (const [name, c] of classes) {
      if (c.abstract || isTest(c.p)) continue
      const chain = chainOf(name), baseNames = chain.flatMap(x => x.bases)
      if (!/Controller$/.test(name) && !chain.some(x => x.api) && !baseNames.some(b => /^(ControllerBase|Controller)$/.test(b))) continue
      const route = chain.map(x => x.route).find(x => x !== undefined), auth = mergeAuth(...chain.map(x => x.auth))
      for (const a of chain.flatMap(x => x.actions.map(y => ({ ...y, cls: x.name, p: x.p })))) {
        if (route === undefined && a.tpl === undefined) continue   // conventional routing: not read yet
        const tok = (t: string) => t.replace(/\[controller\]/gi, name.replace(/Controller$/, '').toLowerCase()).replace(/\[action\]/gi, a.name.toLowerCase())
        add(c.p, { method: a.method, path: csPath(tok(csJoin('/' + (route ?? '').replace(/^\//, ''), a.tpl ?? ''))), auth: mergeAuth(auth, a.auth), facts: csFiles.find(([q]) => q === a.p)?.[1].methods.get(`${a.cls}.${a.name}`), controller: true }, true)
      }
    }
    // Entity Framework: the entities the DbSets name (by that name; one defined twice is left out rather than guessed)
    // (a DTO of the same name elsewhere doesn't replace the entity: prefer Models/Entities/Domain/Data folders, then the one with an Id)
    const defs = new Map<string, { p: string; props: string[] }[]>()
    for (const [p, c] of csFiles) for (const [k, v] of c.entities) defs.set(k, [...defs.get(k) ?? [], { p, props: v }])
    const rank = (d: { p: string; props: string[] }) => (/(^|\/)(Models|Entities|Domain|Data)\//.test(d.p) ? 2 : 0) + (d.props.includes('Id') ? 1 : 0) - (/(^|\/)(Dtos?|Contracts|ViewModels|Requests|Responses)\//.test(d.p) ? 3 : 0)
    for (const [, t] of sets) { const d = defs.get(t)?.sort((a, b) => rank(b) - rank(a)); if (d?.length) csModels.set(t, d[0].props) }
    for (const f of files.values()) remap(f)
  }
  // Spring Boot: each endpoint's login, as Spring decides it (see src/java.ts): the first security chain whose securityMatcher fits
  // (in @Order), the first rule in it that matches; method checks on top when their kind is switched on. Test code (src/test) is left out.
  const javaFiles = [...files].filter(([p]) => p.endsWith('.java') && !/(^|\/)src\/test\//.test(p)).map(([p, f]) => [p, (f as JavaFacts).java] as const)
  if (javaFiles.length) {
    // Spring Security on the classpath: the starter, OAuth2 starters, spring-security-web/config, or a Gradle catalog alias
    const security = Object.keys(deps_).some(d => /^spring-boot-starter-(security|oauth2-[\w-]+)$|^spring-security-(web|config)$/.test(d))
      || [...snap].some(([p, t]) => /(^|\/)build\.gradle(\.kts)?$/.test(p) && /implementation\s*\(?\s*libs\.[\w.]*security/.test(t))
    const chains = javaFiles.flatMap(([, j]) => j.chains).sort((a, b) => a.order - b.order)
    const enabled = new Set(javaFiles.flatMap(([, j]) => j.enabled))
    const props = [...snap].filter(([p]) => /(^|\/)src\/main\/resources\/application(-prod)?\.(properties|ya?ml)$/.test(p)).sort(([a], [b]) => a.length - b.length).map(([, t]) => t).join('\n')
    const prop = (k: string) => props.match(new RegExp(`^\\s*${k.replace(/\./g, '\\.')}\\s*[=:]\\s*(.+)$`, 'm'))?.[1]?.trim() ?? yamlProp(props, k)
    const context = (prop('server.servlet.context-path') ?? '').replace(/^["']|["']$/g, '').replace(/\/$/, '')
    const repos = new Map(javaFiles.flatMap(([, j]) => [...j.repos]))
    const repoWrites = new Map(javaFiles.flatMap(([, j]) => [...j.repoWrites]))
    const methods = new Map(javaFiles.flatMap(([, j]) => [...j.methods]))
    const impls = new Map(javaFiles.flatMap(([, j]) => [...j.implements]))
    // a controller's facts include what it calls (services, its own helpers), a few levels down; and the method checks met on the way
    // (@PreAuthorize on the service method it calls stops the request too); repository placeholders become their entities
    const lookup = (t: string, m: string) => methods.get(`${t}.${m}`) ?? [...methods].find(([k]) => k.endsWith(`.${m}`) && (impls.get(k.split('.')[0]) ?? []).includes(t))?.[1]
    const fold = (g: FileFacts & { checks?: Family[] }, into: FileFacts & { checks?: Family[] }, seen: Set<string>) => {
      for (const k of ['tables', 'written', 'ops', 'outside', 'env', 'envReq', 'services', 'refuses'] as const) for (const y of g[k]) into[k].add(y)
      into.money ||= g.money; into.writes ||= g.writes; into.checks = [...into.checks ?? [], ...g.checks ?? []]; into.printed += (into.printed ? '\n' : '') + g.printed
      for (const u of g.used) if (u.startsWith('jcall:') && !seen.has(u)) {
        seen.add(u); const [t, m] = u.slice(6).split('.')
        const w = repoWrites.get(`${t}.${m}`)   // @Modifying @Query repository method
        if (w && repos.has(t)) { into.written.add(`@repo:${t}`); into.tables.add(`@repo:${t}`); into.writes = true; into.ops.add(w) }
        const h = lookup(t, m); if (h) fold(h, into, seen)
      }
    }
    const entityOf = (f: FileFacts) => { for (const k of ['tables', 'written'] as const) for (const t of [...f[k]]) if (t.startsWith('@repo:')) { f[k].delete(t); const e = repos.get(t.slice(6)); if (e) f[k].add(e) } return f }
    // an Ant-style pattern: /api/**, /api/*/x, /orders/{id}
    const matches = (pattern: string, url: string) => {
      const re = pattern.split('/').map(seg => seg === '**' ? '\u0000' : seg.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}|\*/g, '[^/]+')).join('/')
      return new RegExp('^' + re.replace(/\/\u0000$/, '(/.*)?').replace(/\u0000/g, '.*') + '/?$').test(url.replace(/\[[^\]]+\]/g, 'x'))
    }
    // 'open' | 'login' | 'deny' | undefined (plain can't tell)
    const decide = (method: string, path: string) => {
      if (!chains.length) return security ? 'login' : 'open'
      const c = chains.find(x => !x.matchers.length || x.matchers.some(m => matches(m, path)))
      if (!c || !c.rules) return 'open'   // no chain fits, or a chain with no request rules: nothing checks login
      const r = c.rules.find(x => (!x.methods.length || x.methods.includes(method)) && x.patterns.some(pt => matches(pt, path)))
      return r ? r.decision : !c.complete ? undefined : c.legacy ? 'open' : 'deny'
    }
    const route = (p: string, r: { method: string; path: string }, facts: FileFacts & { checks?: Family[] }) => {
      const method = r.method === 'ANY' ? (facts.writes ? 'POST' : 'GET') : r.method, decision = decide(method, r.path)
      const guard = decision === 'login' || decision === 'deny' || (facts.checks ?? []).some(c => enabled.has(c))
      files.get(p)!.handlers.push({ server: '', method, path: context + r.path, guard, mw: [], facts: entityOf(facts), unknown: !guard && decision === undefined })
    }
    for (const [p, j] of javaFiles) for (const r of j.routes) {
      const into: FileFacts & { checks?: Family[] } = Object.assign(empty(), { checks: [...r.checks] }), h = methods.get(`${r.cls}.${r.name}`)
      // @PreAuthorize on the interface method this controller implements (an OpenAPI-generated API, say)
      for (const i of impls.get(r.cls) ?? []) into.checks!.push(...methods.get(`${i}.${r.name}`)?.checks ?? [])
      if (h) fold({ ...h, checks: [] }, into, new Set())
      route(p, r, into)
    }
    // Spring Data REST: with the dependency, every repository is an API of its own (list, read, create, update, delete), unless exported = false
    if (Object.keys(deps_).some(d => /^spring-boot-starter-data-rest$|^spring-data-rest-webmvc$/.test(d))) {
      const base = (prop('spring.data.rest.base-path') ?? '').replace(/^["']|["']$/g, '').replace(/\/$/, '')
      for (const [p, j] of javaFiles) for (const [repo, path] of j.restRepos) {
        const e = repos.get(repo); if (!e) continue
        const url = `${base}/${path || pluralize(e.charAt(0).toLowerCase() + e.slice(1))}`
        for (const [method, sub, op] of [['GET', '', ''], ['POST', '', 'create'], ['GET', '/[id]', ''], ['PUT', '/[id]', 'update'], ['PATCH', '/[id]', 'update'], ['DELETE', '/[id]', 'delete']] as const) {
          const facts = empty(`spring data rest ${repo}`); facts.tables.add(e); if (op) { facts.written.add(e); facts.writes = true; facts.ops.add(op) }
          route(p, { method, path: url + sub }, facts)
        }
      }
    }
    for (const [, j] of javaFiles) for (const [e, fs] of j.entities) javaModels.set(e, fs)
    // @Value("${stripe.secret-key}"): set in application.properties as ${STRIPE_SECRET_KEY} (that env var), or by its relaxed env name
    for (const f of files.values()) for (const k of ['env', 'envReq'] as const) for (const x of [...f[k]]) if (x.startsWith('@prop:')) {
      f[k].delete(x); const name = x.slice(6), v = prop(name)
      const ref = v?.match(/^\$\{(\w+)(:[^}]*)?\}$/)
      if (ref) { if (k === 'env' || !ref[2]) f[k].add(ref[1]) } else if (v === undefined) f[k].add(name.replace(/[.-]/g, (c) => c === '.' ? '_' : '').toUpperCase())
    }
  }
  // Laravel: which route files load (routes/web.php; routes/api.php under /api when bootstrap/app.php or a RouteServiceProvider registers
  // it; the files they include), each route's middleware (its groups', its own, its controller's, minus withoutMiddleware), and login
  // from those (see src/php.ts). Test code (tests/) is left out.
  for (const [p, f] of files) if (p.endsWith('.php') && /(^|\/)tests\//.test(p)) { f.env.clear(); f.envReq.clear() }
  const phpFiles = [...files].filter(([p]) => p.endsWith('.php') && !/(^|\/)tests\//.test(p)).map(([p, f]) => [p, (f as PhpFacts).php] as const)
  if (phpFiles.length) {
    const byPath = new Map(phpFiles)
    const app = phpFiles.find(([, x]) => x.app)?.[1].app
    const classes = new Map(phpFiles.flatMap(([p, x]) => [...x.classes].map(([k, v]) => [k, { p, ...v }] as const)))
    const methods = new Map(phpFiles.flatMap(([, x]) => [...x.methods]))
    const params = new Map(phpFiles.flatMap(([, x]) => [...x.params]))
    const appMw = new Map(phpFiles.flatMap(([, x]) => [...x.middleware])), adminMws = new Set(phpFiles.flatMap(([, x]) => [...x.adminMw]))
    const formRequests = new Map(phpFiles.flatMap(([, x]) => [...x.formRequests]))
    const notifications = new Map(phpFiles.flatMap(([, x]) => [...x.notifications]))
    const config = new Map(phpFiles.flatMap(([, x]) => [...x.config]))
    // classes by full name (App\Http\Controllers\Admin\EventController); a name plain couldn't resolve (no namespace, a missing import)
    // falls back to the one class with that short name
    const bareName = (c: string) => c.split('\\').at(-1)!
    const lookup = (c?: string) => !c ? undefined : classes.has(c) ? c : (() => { const m = [...classes.keys()].filter(k => bareName(k) === bareName(c)); return m.length === 1 ? m[0] : undefined })()
    const chainOf = (c?: string, seen = new Set<string>()): string[] => { const k = lookup(c); return !k || seen.has(k) ? [] : [k, ...chainOf(classes.get(k)!.base, seen.add(k))] }
    const models = new Set([...classes].filter(([, c]) => c.model).map(([k]) => bareName(k)))
    // Laravel 13's #[Middleware] attributes: 'yes' when composer only allows 13+, 'no' when only older, else plain can't tell
    const majors = [...(deps_['laravel/framework'] ?? '').matchAll(/(?:^|[\^~=|>,\s])v?(\d+)/g)].map(m => +m[1])
    const lv13 = !majors.length || /\*|dev-/.test(deps_['laravel/framework'] ?? '*') ? 'maybe' : majors.every(n => n >= 13) ? 'yes' : majors.every(n => n < 13) && !/>/.test(deps_['laravel/framework']) ? 'no' : 'maybe'
    // aliases: Laravel's own, then the app's (bootstrap/app.php; 10-style Kernel.php $middlewareAliases / $routeMiddleware)
    const DEFAULTS = new Map<string, string>([['auth', 'Authenticate'], ['auth.basic', 'AuthenticateWithBasicAuth'], ['verified', 'EnsureEmailIsVerified'], ['can', 'Authorize'],
      ['guest', 'RedirectIfAuthenticated'], ['signed', 'ValidateSignature'], ['throttle', 'ThrottleRequests'], ['password.confirm', 'RequirePassword'], ['auth.session', 'AuthenticateSession'],
      ['cache.headers', 'SetCacheHeaders'], ['precognitive', 'HandlePrecognitiveRequests'], ['bindings', 'SubstituteBindings']])
    const aliases = new Map(app?.aliases ?? [])
    for (const [p, t] of snap) if (/(^|\/)app\/Http\/Kernel\.php$/.test(p)) for (const m of t.matchAll(/['"]([\w.]+)['"]\s*=>\s*\\?([\w\\]+)::class/g)) aliases.set(m[1], m[2].split('\\').at(-1)!)
    // a gate or policy that lets guests in (?User, ?\App\Models\User, User|null, mixed, User $user = null): its checks don't mean login
    const guestPolicies = [...snap].some(([p, t]) => /(^|\/)app\/(Policies|Providers)\/.*\.php$/.test(p) && /\?\\?[\w\\]*User\b|\b\w*User\s*\|\s*null\b|\bnull\s*\|\s*\\?[\w\\]*User\b|\bmixed\s+\$\w+|User\s+\$\w+\s*=\s*null/.test(t))
    const LOGIN = /^(Authenticate|AuthenticateWithBasicAuth|EnsureEmailIsVerified|RequirePassword|CheckAbilities|CheckForAnyAbility|RoleMiddleware|PermissionMiddleware|RoleOrPermissionMiddleware)$/
    const NOT_LOGIN = /^(RedirectIfAuthenticated|ValidateSignature|ThrottleRequests\w*|AuthenticateSession|SetCacheHeaders|HandlePrecognitiveRequests|SubstituteBindings|EnsureFrontendRequestsAreStateful|ValidateCsrfToken|VerifyCsrfToken|PreventRequestForgery|EncryptCookies|StartSession|ShareErrorsFromSession|AddQueuedCookiesToResponse|HandleInertiaRequests|AddLinkHeadersForPreloadedAssets|HandleAppearance|HandleCors|TrimStrings|ConvertEmptyStringsToNull|TrustProxies|ValidatePostSize|PreventRequestsDuringMaintenance|web|api)$/
    // 'auth:sanctum' -> Authenticate:sanctum, what withoutMiddleware compares
    const resolved = (m: string) => { const [n, ...rest] = m.split(':'); return (aliases.get(n) ?? DEFAULTS.get(n) ?? n) + (rest.length ? ':' + rest.join(':') : '') }
    const kind = (m: string): 'login' | 'policy' | 'none' | 'unknown' => {
      const n = m.split(':')[0], c = resolved(m).split(':')[0]
      // the app's own class (an alias of the app's, or a class named directly; apps write their own RoleMiddleware too): its handle()
      // decides. Laravel's own aliases ('auth') stay Laravel's, whatever classes of the same name the app has.
      if (NOT_LOGIN.test(c)) return 'none'   // (an app's copy of RedirectIfAuthenticated is still guest-only)
      if ((aliases.has(n) || !DEFAULTS.has(n)) && appMw.has(c)) { const v = appMw.get(c)!; return v === 'policy' && guestPolicies ? 'unknown' : v }
      if (c === 'Authorize') return guestPolicies ? 'unknown' : 'policy'
      if (LOGIN.test(c)) return 'login'
      return NOT_LOGIN.test(c) ? 'none' : 'unknown'
    }
    // "only admins": the app's middleware whose check turns away non-admins, or Spatie's role:admin (every role named an admin one)
    const adminKind = (m: string) => { const n = m.split(':')[0], [c, arg] = resolved(m).split(':')
      if ((aliases.has(n) || !DEFAULTS.has(n)) && adminMws.has(c)) return true
      return c === 'RoleMiddleware' && !appMw.has(c) && !!arg && arg.split(',')[0].split('|').every(r => /^(super[-_]?)?admin(istrator)?$/i.test(r.trim())) }
    const groupMw = (name: string) => [...app?.groups.get(name) ?? []]
    // route files: from bootstrap/app.php (11+) or a provider's group(base_path(...)) (10), else Laravel's defaults
    type Ctx = { prefix: string; mw: string[]; without: string[] }
    const rootOf = (p: string) => p.match(/^((?:[^/]+\/)*?)(?:routes|bootstrap|app)\//)?.[1] ?? ''
    const base = rootOf(phpFiles.find(([p]) => /(^|\/)(routes|bootstrap)\//.test(p))?.[0] ?? '')
    const entries: (Ctx & { file: string })[] = []
    const providerIncludes = phpFiles.filter(([p]) => /(^|\/)(bootstrap\/app|app\/Providers\/\w+)\.php$/.test(p)).flatMap(([, x]) => x.includes)
    if (app) {
      if (!app.using) {
        for (const f of app.api ?? []) entries.push({ file: f, prefix: '/' + app.apiPrefix.replace(/^\/|\/$/g, ''), mw: ['api'], without: [] })
        for (const f of app.web ?? []) entries.push({ file: f, prefix: '', mw: ['web'], without: [] })
      }
      entries.push(...providerIncludes)
    } else if (providerIncludes.length) entries.push(...providerIncludes)
    else entries.push({ file: base + 'routes/api.php', prefix: '/api', mw: ['api'], without: [] }, { file: base + 'routes/web.php', prefix: '', mw: ['web'], without: [] })
    // every route, in the order Laravel registers them (an included file's routes where the require is); the same method and
    // address defined again replaces the earlier one
    const found = new Map<string, { p: string; r: import('./php.ts').PhpRoute; method: string; ctx: Ctx }>()
    const slashes = (u: string) => u.replace(/\/+/g, '/').replace(/(.)\/$/, '$1') || '/'
    const visit = (file: string, ctx: Ctx, seen: Set<string>) => {
      const x = byPath.get(file); if (!x || seen.has(file)) return
      seen = new Set([...seen, file])
      for (const item of [...x.routes, ...x.includes].sort((a, b) => a.at - b.at)) {
        if ('file' in item) { visit(item.file, { prefix: ctx.prefix + item.prefix, mw: [...ctx.mw, ...item.mw], without: [...ctx.without, ...item.without] }, seen); continue }
        for (const method of item.methods) {
          const key = `${method} ${slashes(ctx.prefix + item.path)}`
          found.delete(key); found.set(key, { p: file, r: item, method, ctx: { prefix: ctx.prefix, mw: [...ctx.mw, ...item.mw], without: [...ctx.without, ...item.without] } })
        }
      }
    }
    for (const e of entries) visit(e.file, e, new Set())
    // the tables, as the migrations build them (in file-name order, as Laravel runs them); a table only altered here (a package's) isn't one
    const tableClass = new Map([...classes].filter(([, c]) => c.model && c.table).map(([k, c]) => [c.table!, bareName(k)]))
    const tables = new Map<string, string[]>()
    for (const [, x] of phpFiles.filter(([p]) => /(^|\/)database\/migrations\//.test(p)).sort(([a], [b]) => a.split('/').pop()!.localeCompare(b.split('/').pop()!)))
      for (const s of x.schema as SchemaOp[]) {
        if (s.op === 'drop') tables.delete(s.table)
        else if (s.op === 'rename' && s.to) { const t = tables.get(s.table); tables.delete(s.table); if (t) tables.set(s.to, t) }
        else if (s.table && (s.op === 'create' || tables.has(s.table))) { const t = s.op === 'create' ? [] : tables.get(s.table)!
          tables.set(s.table, [...t.filter(c => !s.drop.includes(c)).map(c => s.renames.find(([a]) => a === c)?.[1] ?? c), ...s.add.filter(c => !t.includes(c))]) }
      }
    for (const [t, cols] of tables) phpModels.set(tableClass.get(t) ?? modelOf(t), cols)
    const nullable = new Set(phpFiles.flatMap(([, x]) => x.schema.flatMap(o => o.nullable ?? [])))   // columns that may be empty (any table)
    // a table name in the code: an Eloquent model (Order::create), a relation ($user->orders()->create), DB::table('orders'); only
    // when that model or table exists ($client->chat()->create(...) is an API call)
    const modelName = (t: string) => { if (t.startsWith('@m:')) return models.has(t.slice(3)) ? t.slice(3) : undefined
      if (!/^@(rel|tbl):/.test(t)) return t
      const tb = t.replace(/^@\w+:/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(), m = tableClass.get(tb) ?? modelOf(tb)
      return models.has(m) || t.startsWith('@tbl:') && tables.has(tb) ? m : undefined }
    const cashier = Object.keys(deps_).some(d => d === 'laravel/cashier')
    const finish = (g: FileFacts) => {
      for (const k of ['tables', 'written'] as const) for (const t of [...g[k]]) if (t.startsWith('@')) { g[k].delete(t); const m = modelName(t); if (m) g[k].add(m) }
      g.writes = g.written.size > 0; if (!g.writes) g.ops.clear()
      for (const k of ['env', 'envReq'] as const) for (const x of [...g[k]]) if (x.startsWith('@cfg:')) { g[k].delete(x); const c = config.get(x.slice(5)); if (c && (k === 'env' || !c.optional)) g[k].add(c.env) }
      if (cashier && (g.used.has('cashier:charge') || g.used.has('cashier:checkout'))) { g.money = true; g.services.add('Stripe') }
      if (cashier && g.used.has('cashier:refund')) { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
      for (const u of g.used) if (u.startsWith('notify:') && notifications.get(u.slice(7))) { g.services.add('email'); g.outside.add('email: send') }
      return g
    }
    // what an address does includes what it calls: services ($cancelEvent->handle()), their dependencies (an interface: the classes that
    // implement it), the class's own helpers; a few levels down
    const follow = (g: FileFacts, into: FileFacts, seen: Set<string>, depth = 0) => {
      for (const u of g.used) if (u.startsWith('pcall:') && !seen.has(u) && depth < 6) {
        seen.add(u)
        // the class by its full name (no short-name guess: \Stripe\Invoice isn't the app's Invoice), or an interface's implementations
        const t = u.slice(6, u.lastIndexOf('.')), m = u.slice(u.lastIndexOf('.') + 1)
        for (const c of classes.has(t) ? [t] : [...classes].filter(([, x]) => x.interfaces.includes(bareName(t))).map(([q]) => q)) {
          const callee = chainOf(c).map(x => methods.get(`${x}.${m}`)).find(Boolean)
          if (!callee) continue
          for (const key of ['tables', 'written', 'ops', 'outside', 'env', 'envReq', 'services', 'refuses', 'used'] as const) for (const x of callee[key]) into[key].add(x)
          into.money ||= callee.money; into.writes ||= callee.writes
          into.printed += '\n' + callee.printed   // a change in the service is a change in the address
          follow(callee, into, seen, depth + 1)
        }
      }
    }
    const expand = (mw: string[]): string[] => mw.flatMap(m => m === 'web' || m === 'api' ? [m, ...groupMw(m)] : [m])
    const applies = (fn: string) => (m: Mw) => (!m.only || m.only.includes(fn)) && !m.except?.includes(fn)
    for (const [, { p, r, method, ctx }] of found) {
      const chain = chainOf(r.cls), fn = r.fn ?? '', k = (c: string) => classes.get(c)!
      // the controller's middleware: HasMiddleware's static middleware() (only with the interface; the most-derived one counts), else
      // a 10-style constructor (which only Illuminate's Controller has); Laravel 13 attributes on top
      const hasMw = chain.some(c => k(c).interfaces.includes('HasMiddleware'))
      const fromStatic = hasMw ? chain.map(c => k(c).staticMw).find(Boolean) ?? [] : []
      const fromCtor = hasMw ? [] : chain.some(c => k(c).illuminate) ? chain.flatMap(c => k(c).ctorMw) : chain.some(c => k(c).ctorMw.length) ? [{ mw: '?' }] : []
      const attrs = chain.flatMap(c => [...k(c).attrMw, ...k(c).methodMw.get(fn) ?? []]), attrOff = chain.flatMap(c => [...k(c).without, ...k(c).methodWithout.get(fn) ?? []])
      const ctrl = [...fromStatic, ...fromCtor, ...lv13 === 'no' ? [] : attrs.map(m => lv13 === 'yes' ? m : { ...m, mw: '?' })].filter(applies(fn)).map(m => m.mw)
      const offAttrs = lv13 === 'no' ? [] : attrOff.filter(applies(fn)).map(m => m.mw)
      // withoutMiddleware('auth') removes 'auth', and since Laravel 13.39 'auth:sanctum' too (the class before the colon): read that
      // way on every version, so it errs toward a warning
      const without = [...ctx.without, ...offAttrs].map(resolved)
      const off = (m: string) => without.includes(resolved(m)) || without.includes(resolved(m).split(':')[0])
      const mws = [...expand(ctx.mw), ...groupMw('*'), ...ctrl].filter(m => !off(m)).concat(lv13 === 'maybe' && offAttrs.length ? ['?'] : [])
      const h = r.facts ?? chain.map(c => methods.get(`${c}.${fn}`)).find(Boolean)
      const facts = Object.assign(empty(), h, { tables: new Set(h?.tables), written: new Set(h?.written), ops: new Set(h?.ops), env: new Set(h?.env), envReq: new Set(h?.envReq), services: new Set(h?.services), outside: new Set(h?.outside), used: new Set(h?.used), refuses: new Set(h?.refuses) })
      if (h) follow(h, facts, new Set())
      finish(facts)
      // in the handler: its own check; a gate or policy; a FormRequest whose authorize() checks the user; $this->authorize needs a trait
      // (AuthorizesRequests, on Laravel 10's base controller): without it every request crashes
      const authorizes = chain.some(c => k(c).traits.includes('AuthorizesRequests'))
      if (h?.check === 'crash' && !authorizes && r.cls) byPath.get(classes.get(chain[0] ?? '')?.p ?? '')?.risks.add(`authz:${bareName(chain[0] ?? r.cls)}`)
      // an owner check ($order->user_id !== auth()->id()) turns guests away only while that column is never empty
      const check = h?.check === 'crash' ? (authorizes ? 'policy' : 'unknown') : h?.check?.startsWith('owner:') ? (nullable.has(h.check.slice(6)) ? 'unknown' : 'login') : h?.check
      const ps = chain.map(c => params.get(`${c}.${fn}`)).find(Boolean) ?? []
      const fr = ps.map(t => { const v = formRequests.get(t); return v?.startsWith('owner:') ? (nullable.has(v.slice(6)) ? 'unknown' : 'login') : v }).filter(Boolean)
      const kinds = [...mws.map(kind), check === 'login' ? 'login' : check === 'policy' || fr.includes('login') ? (guestPolicies ? 'unknown' : 'policy')
        : check === 'unknown' || fr.includes('unknown') ? 'unknown' : 'none']
      const guard = kinds.some(x => x === 'login' || x === 'policy'), admin = guard && mws.some(adminKind)
      const m = method === 'ANY' ? (facts.writes ? 'POST' : 'GET') : method
      const at = r.cls ? classes.get(chain.find(c => methods.has(`${c}.${fn}`)) ?? r.cls)?.p ?? p : p
      files.get(at)!.handlers.push({ server: '', method: m, path: slashes(ctx.prefix + r.path), guard, admin, mw: [], facts, unknown: !guard && kinds.includes('unknown') })
    }
    // the files' own facts: config files' env() calls count only through the config() calls that read them
    for (const [p] of phpFiles) { const f = files.get(p)!; if (/(^|\/)(config|bootstrap|database)\//.test(p)) { f.env.clear(); f.envReq.clear() } finish(f) }
    // $this->middleware() in a constructor: only Illuminate's Controller has it (Laravel 10's base); on 11+'s bare base it's a crash
    for (const [c, x] of classes) if (x.ctorMw.length && !chainOf(c).some(y => classes.get(y)!.illuminate) && !chainOf(c).some(y => classes.get(y)!.interfaces.includes('HasMiddleware'))) byPath.get(x.p)!.risks.add(`ctor:${bareName(c)}`)
    // the visitor's whole input saved into a model that accepts every field ($guarded = [], or Model::unguard() for all of them)
    const unguardAll = phpFiles.some(([, x]) => x.risks.has('unguard'))
    for (const [, x] of phpFiles) for (const r of x.risks) if (r.startsWith('all:') && (unguardAll || [...classes].some(([q, c]) => c.model && c.unguarded && bareName(q) === r.slice(4)))) x.risks.add('mass')
  }
  // Rails: config/routes.rb in order (the first definition of a method and address wins; drawn files at their place), each route's
  // controller action and the before_actions it runs (see src/rb.ts), what it does (following calls into other classes), the tables
  // the migrations build. Test code (test/, spec/) is left out.
  for (const [p, f] of files) if (p.endsWith('.rb') && /(^|\/)(test|spec)\//.test(p)) { f.env.clear(); f.envReq.clear() }
  const rbFiles = [...files].filter(([p]) => p.endsWith('.rb') && !/(^|\/)(test|spec)\//.test(p)).map(([p, f]) => [p, (f as RbFacts).rb] as const)
  if (rbFiles.some(([p]) => /(^|\/)config\/routes\.rb$/.test(p))) {
    const byPath = new Map(rbFiles)
    const classes = new Map(rbFiles.flatMap(([p, x]) => [...x.classes].map(([k, v]) => [k, { p, ...v }] as const)))
    const methods = new Map(rbFiles.flatMap(([, x]) => [...x.methods]))
    const devise = 'devise' in deps_, deviseScopes = new Set(rbFiles.flatMap(([, x]) => x.devise).map(s => s.replace(/s$/, '')))
    const apiOnly = [...snap].some(([p, t]) => /(^|\/)config\/application\.rb$/.test(p) && /^\s*config\.api_only\s*=\s*true/m.test(t))
    // a class name as Ruby finds it from inside `ns` (Admin::BaseController, or BaseController from inside module Admin)
    const find = (name: string | undefined, ns = ''): string | undefined => { if (!name) return undefined; const parts = ns.split('::').filter(Boolean)
      for (let i = parts.length; i >= 0; i--) { const k = [...parts.slice(0, i), name.replace(/^::/, '')].join('::'); if (classes.has(k)) return k } return undefined }
    const chainOf = (c: string | undefined, seen = new Set<string>()): string[] => !c || seen.has(c) ? [] : [c, ...chainOf(find(classes.get(c)!.base, classes.get(c)!.outer), seen.add(c))]
    const incOf = (c: string, inc: string) => find(inc, classes.get(c)!.outer) ?? find(inc, c)
    const models = new Set([...classes].filter(([, c]) => c.model).map(([k]) => k.split('::').pop()!))
    // the routes, in order; drawn files where `draw` is
    const found = new Map<string, { r: RbRoute; p: string }>()
    const visit = (file: string, ctx: { path: string; module: string; guard?: 'login' | 'unknown' }, seen: Set<string>) => {
      const x = byPath.get(file); if (!x || seen.has(file)) return
      for (const item of [...x.routes, ...x.draws].sort((a, b) => a.at - b.at)) {
        if ('file' in item) { visit(item.file, { path: ctx.path + item.path, module: ctx.module + item.module, guard: item.guard ?? ctx.guard }, new Set([...seen, file])); continue }
        if (item.htmlOnly && apiOnly) continue
        const path = (ctx.path + item.path).replace(/\/+/g, '/').replace(/(.)\/$/, '$1') || '/', key = `${item.method} ${path}`
        if (!found.has(key) || found.get(key)!.r.fallthrough && !item.fallthrough) found.set(key, { r: { ...item, path, controller: ctx.module + item.controller, guard: item.guard ?? ctx.guard }, p: file })   // the first one wins (for guests, the first that's always there)
      }
    }
    for (const [p] of rbFiles) if (/(^|\/)config\/routes\.rb$/.test(p)) visit(p, { path: '', module: '' }, new Set())
    // the before_actions that run for an action: parents' first, each class's concerns, then its own lines; the same name declared
    // again replaces it; skip_before_action removes it (only:/except: for some actions; with if:/unless: plain can't tell)
    const applies = (c: { only?: string[]; except?: string[] }, fn: string) => (!c.only || c.only.includes(fn)) && !c.except?.includes(fn)
    const callbacks = (chain: string[], fn: string) => {
      const on = new Map<string, Cb | 'unknown'>()
      const apply = (cb: Cb) => {
        if (cb.kind === 'before') { if (cb.name === '?' || cb.name.startsWith('@')) on.set(`${cb.name}${on.size}`, cb); else on.set(cb.name, cb); return }
        if (!on.has(cb.name)) return
        if (cb.cond) { const was = on.get(cb.name)!; if (cb.only?.includes(fn)) on.delete(cb.name); else on.set(cb.name, was === 'unknown' ? was : { ...was, cond: true }); return }   // (skipped on only: always; elsewhere whenever the condition holds)
        if (applies(cb, fn)) on.delete(cb.name)
      }
      const run = (c: string, seen: Set<string>) => { for (const cb of classes.get(c)!.cbs) if (cb.kind === 'include') { const m = incOf(c, cb.name); if (m && !seen.has(m)) run(m, new Set([...seen, m])) } else apply(cb) }
      for (const c of [...chain].reverse()) run(c, new Set([c]))
      return [...on.values()].filter(v => v === 'unknown' || applies(v, fn))
    }
    const methodOf = (chain: string[], name: string, seen = new Set<string>()): (FileFacts & { halts?: string; check?: string }) | undefined => { for (const c of chain) { const m = methods.get(`${c}.${name}`); if (m) return m
      for (const inc of classes.get(c)!.includes) { const k = incOf(c, inc); if (k && !seen.has(k)) { const mm = methodOf([k], name, new Set([...seen, k])); if (mm) return mm } } } }
    const byName = (name: string, chain: string[], depth = 0): 'login' | 'unknown' | 'none' => {
      const m = methodOf(chain, name)
      if (m) { if (m.halts === 'login') return 'login'
        // def require_user; authenticate_user!; end: what it calls decides
        const tops = ((m as { tops?: string[] }).tops ?? []).filter(n => n !== name)
        const calls = [...m.used].filter(u => u.startsWith('rcall:')).map(u => u.slice(u.lastIndexOf('.') + 1)).filter(n => n !== name && (methodOf(chain, n) || /^authenticate_\w+!$/.test(n)))
        const top = depth < 3 ? tops.filter(n => methodOf(chain, n) || /^authenticate_\w+!$/.test(n)).map(n => byName(n, chain, depth + 1)) : []
        const nested = depth < 3 ? calls.filter(n => !tops.includes(n)).map(n => byName(n, chain, depth + 1)) : []
        // (a login call that only sometimes runs, `authenticate_user! unless request.get?`, isn't one)
        return top.includes('login') && m.halts === 'none' ? 'login' : m.halts === 'unknown' || [...top, ...nested].some(k => k !== 'none') ? 'unknown' : (m.halts as 'none') ?? 'none' }
      const scope = name.match(/^authenticate_(\w+)!$/)?.[1]
      if (scope) return devise && deviseScopes.has(scope) ? 'login' : 'unknown'   // Devise defines authenticate_<scope>! for each devise_for
      return /auth|login|sign|session|token|require|ensure|verify|admin|guard|protect|restrict|permi|access/i.test(name) ? 'unknown' : 'none'   // a gem's callback plain can't see
    }
    const kind = (cb: Cb | 'unknown', chain: string[]): 'login' | 'unknown' | 'none' => {
      if (cb === 'unknown' || cb.name === '@policy') return 'unknown'
      const k = cb.name === '?' ? (LAMBDA_LOGIN(cb.body ?? '') ? 'login' : 'unknown') : cb.name === '@basic' ? 'login' : byName(cb.name, chain)
      return cb.cond && k !== 'none' ? 'unknown' : k   // only when (if:/unless:) it runs: a login check it may skip; anything else stays nothing
    }
    // what an address does includes what it calls: OrderCanceller.new(order).call, PricingService.quote, its own methods
    const follow = (g: FileFacts, into: FileFacts, self: string, seen: Set<string>, depth = 0) => {
      for (const u of g.used) if (u.startsWith('rcall:') && !seen.has(u) && depth < 6) {
        seen.add(u)
        const t = u.slice(6, u.lastIndexOf('.')), m = u.slice(u.lastIndexOf('.') + 1), k = find(t, self.split('::').slice(0, -1).join('::')) ?? find(t)
        const callee = k ? methodOf(chainOf(k), m) : undefined
        if (!callee) continue
        for (const key of ['tables', 'written', 'ops', 'outside', 'env', 'envReq', 'services', 'refuses', 'used'] as const) for (const x of callee[key]) into[key].add(x)
        into.money ||= callee.money; into.writes ||= callee.writes; into.printed += '\n' + callee.printed
        follow(callee, into, k!, seen, depth + 1)
      }
    }
    const finish = (g: FileFacts) => {
      for (const k of ['tables', 'written'] as const) for (const t of [...g[k]]) if (t.startsWith('@')) { g[k].delete(t)
        const m = t.startsWith('@m:') ? t.slice(3) : rbModelOf(t.slice(5)); if (models.has(m)) g[k].add(m) }
      g.writes = g.written.size > 0; if (!g.writes) g.ops.clear()
      return g
    }
    for (const [key, { r, p }] of found) {
      const cls = find(controllerClass(r.controller)), chain = chainOf(cls), fn = r.action
      // an action with no method and no view template doesn't exist (404): resources make addresses the controller may not have
      // (only when every parent is known: a gem's controller, like Administrate's, has actions plain can't see)
      const rootBase = cls ? classes.get(chain.at(-1)!)!.base : undefined
      if (cls && /^(::)?ActionController::(Base|API)$/.test(rootBase ?? '') && !methodOf(chain, fn) && ![...snap.keys()].some(v => v.includes(`app/views/${r.controller}/${fn}.`))) continue
      const h = cls ? methodOf(chain, fn) : undefined
      const facts = Object.assign(empty(), h, { tables: new Set(h?.tables), written: new Set(h?.written), ops: new Set(h?.ops), env: new Set(h?.env), envReq: new Set(h?.envReq), services: new Set(h?.services), outside: new Set(h?.outside), used: new Set(h?.used), refuses: new Set(h?.refuses) })
      const cbs = cls ? callbacks(chain, fn) : []
      // the before_actions' own reads and writes (set_order loads the order) belong to the action too (not a login check's own lookups)
      for (const cb of cbs) if (cb !== 'unknown' && !cb.name.startsWith('@') && cb.name !== '?' && kind(cb, chain) === 'none') { const m = methodOf(chain, cb.name); if (m) follow({ ...empty(), used: new Set([`rcall:${cls}.${cb.name}`]) }, facts, cls!, new Set()) }
      if (h && cls) follow(h, facts, cls, new Set())
      finish(facts)
      const kinds = [...cbs.map(cb => kind(cb, chain)), h?.check ?? 'none', r.guard ?? 'none', cls ? 'none' : 'unknown']
      const guard = kinds.includes('login')
      // "only admins": a before_action (always run) or the action's own check whose deciding line turns away non-admins
      const admin = guard && (cbs.some(cb => cb !== 'unknown' && !cb.cond && !!(methodOf(chain, cb.name) as { haltsAdmin?: boolean } | undefined)?.haltsAdmin) || !!(h as { checkAdmin?: boolean } | undefined)?.checkAdmin)
      const m = r.method === 'ANY' ? (facts.writes ? 'POST' : 'GET') : r.method
      files.get(cls ? classes.get(cls)!.p : p)!.handlers.push({ server: '', method: m, path: key.slice(key.indexOf(' ') + 1), guard, admin, mw: [], facts, unknown: !guard && kinds.includes('unknown') })
    }
    // the tables, as the migrations build them (in file-name order)
    const tableClass = new Map([...classes].filter(([, c]) => c.model && c.table).map(([k, c]) => [c.table!, k.split('::').pop()!]))
    const tables = new Map<string, string[]>()
    for (const [, x] of [...rbFiles.filter(([p]) => /(^|\/)db\/schema\.rb$/.test(p)), ...rbFiles.filter(([p]) => /(^|\/)db\/migrate\//.test(p)).sort(([a], [b]) => a.split('/').pop()!.localeCompare(b.split('/').pop()!))])
      for (const s of x.schema) {
        if (s.op === 'drop') tables.delete(s.table)
        else if (s.op === 'rename' && s.to) { const t = tables.get(s.table); tables.delete(s.table); if (t) tables.set(s.to, t) }
        else if (s.table && (s.op === 'create' || tables.has(s.table))) { const t = s.op === 'create' ? [] : tables.get(s.table)!
          tables.set(s.table, [...t.filter(c => !s.drop.includes(c)).map(c => s.renames.find(([a]) => a === c)?.[1] ?? c), ...s.add.filter(c => !t.includes(c))]) }
      }
    for (const [t, cols] of tables) rbModels.set(tableClass.get(t) ?? rbModelOf(t), cols)
    for (const [p] of rbFiles) { const f = files.get(p)!; if (/(^|\/)(db\/|config\/(?!initializers\/|environments\/production\.rb))/.test(p)) { f.env.clear(); f.envReq.clear() } finish(f) }   // (initializers and production.rb run at boot: their settings count)
  }
  // Go: run main() as far as routes go (routers made, groups, Use, routes, sub-routers and mounts, calls that pass a router on, across
  // packages by import path), then each route's middleware and handler (see src/go.ts). Test files (_test.go) are left out.
  const goFiles = [...files].filter(([p]) => p.endsWith('.go') && !p.endsWith('_test.go') && !/(^|\/)vendor\//.test(p)).map(([p, f]) => [p, (f as GoFacts).go] as const)
  if (goFiles.length) {
    const gomod = [...snap].find(([p]) => /(^|\/)go\.mod$/.test(p)), root = gomod?.[0].replace(/go\.mod$/, '') ?? '', module = gomod?.[1].match(/^module\s+(\S+)/m)?.[1] ?? ''
    const dirOfImport = (imp: string) => imp === module ? root.replace(/\/$/, '') : imp.startsWith(module + '/') ? root + imp.slice(module.length + 1) : undefined
    // functions by directory (a Go package) and name; func literals by file
    const funcs = new Map<string, { p: string; f: GoFunc; dir: string; imports: Map<string, string> }>()
    for (const [p, x] of goFiles) for (const [k, f] of x.funcs) funcs.set(k.startsWith('@lit') ? `${p}::${k}` : `${x.dir}::${k}`, { p, f, dir: x.dir, imports: x.imports })
    const dirOf = new Map(goFiles.map(([p, x]) => [p, x.dir]))
    const fileOfLit = (k: string) => k.split('::')[0]
    // a function name as written in `dir` (with those imports): createOrder, api.List, h.CreateOrder (a method: by its name, if only one)
    const resolve = (name: string, at: { dir: string; imports: Map<string, string>; p: string; vars?: Map<string, string> }): string | undefined => {
      if (name.startsWith('@lit')) return `${at.p}::${name}`
      const [a, b] = name.includes('.') ? [name.slice(0, name.lastIndexOf('.')), name.slice(name.lastIndexOf('.') + 1)] : ['', name]
      if (!a) return funcs.has(`${at.dir}::${b}`) ? `${at.dir}::${b}` : undefined
      const d = at.imports.has(a) ? dirOfImport(at.imports.get(a)!) : undefined
      if (d !== undefined) return funcs.has(`${d}::${b}`) ? `${d}::${b}` : undefined
      // h.ListBoxes where h := handlers.New(...): a method in that package
      if (at.vars?.has(a)) { const vd = dirOfImport(at.vars.get(a)!); if (vd === undefined) return undefined   // (cors.New(...).Handler: a package's, not ours)
        const k = [...funcs.keys()].find(k => k.startsWith(`${vd}::`) && k.endsWith(`.${b}`)); if (k) return k }
      const ms = [...funcs.keys()].filter(k => k.endsWith(`.${b}`) && !k.includes('@lit'))
      return ms.length === 1 ? ms[0] : ms.find(k => k.startsWith(`${at.dir}::`))
    }
    type Router = { kind: string; prefix: string; parent?: Router; mws: { ref: GoRef; at: number; ctx: Ctx }[]; snap: { ref: GoRef; ctx: Ctx }[] }   // snap: what a gin / echo group copied from its parent
    type Ctx = { dir: string; imports: Map<string, string>; p: string; vars?: Map<string, string> }
    const routes: { router: Router; method: string; path: string; handler: GoRef; mws: { ref: GoRef; ctx: Ctx }[]; seq: number; ctx: Ctx }[] = []
    let seq = 0
    const mux = (kind: string, parent?: Router, prefix = ''): Router => ({ kind, prefix, parent, mws: [], snap: parent && parent.kind !== 'chi' ? [...upTo(parent, Infinity)] : [] })
    // a router's middleware that covers a route registered at `at`: chi and echo's root, all of them; gin and echo groups, those before it
    const upTo = (r: Router, at: number): { ref: GoRef; ctx: Ctx }[] => [...r.snap, ...r.mws.filter(m => r.kind === 'chi' || r.kind === 'echo' && !r.parent || m.at < at)]
    const chain = (r: Router, at: number): { ref: GoRef; ctx: Ctx }[] => r.parent && (r.kind === 'chi' || r.parent.kind === 'chi' || r.parent.kind === 'mux') ? [...chain(r.parent, Infinity), ...upTo(r, at)] : r.kind === 'echo' && r.parent ? [...chain(rootOf(r), Infinity), ...upTo(r, at)] : upTo(r, at)
    const rootOf = (r: Router): Router => r.parent ? rootOf(r.parent) : r
    const fullPrefix = (r: Router): string => (r.parent ? fullPrefix(r.parent) : '') + r.prefix
    const run = (key: string, binds: Map<string, Router>, depth: number, into?: Router): Router | undefined => {
      const fn = funcs.get(key); if (!fn || depth > 8) return undefined
      const ctx: Ctx = { dir: fn.dir, imports: fn.imports, p: key.includes('::@lit') ? fileOfLit(key) : fn.p, vars: fn.f.pkgVars }
      return exec(fn.f.routeOps, binds, depth, ctx, into)
    }
    const exec = (ops: GoOp[], binds: Map<string, Router>, depth: number, ctx: Ctx, into?: Router): Router | undefined => {
      for (const op of ops) {
        if (op.op === 'new') { binds.set(op.v, into ?? mux(op.kind)); into = undefined }
        else if (op.op === 'group') { const from = binds.get(op.from); if (from) { const g = mux(from.kind, from, op.prefix); g.mws.push(...op.mws.map(ref => ({ ref, at: -1, ctx }))); binds.set(op.v, g) } }
        else if (op.op === 'use') { const r = binds.get(op.on); if (r) r.mws.push(...op.mws.map(ref => ({ ref, at: seq++, ctx }))) }
        else if (op.op === 'route' && op.handler.fn && binds.has(op.handler.fn) && binds.get(op.on)?.kind === 'mux') {   // mux.Handle("/admin/", requireAuth(adminMux))
          const sub = binds.get(op.handler.fn)!, r = binds.get(op.on)!; if (sub !== r) { sub.parent = r; if (op.handler.wrap) sub.mws.unshift(...op.handler.wrap.map(w => ({ ref: { call: w }, at: -1, ctx }))) } }
        else if (op.op === 'subfn') { const r = binds.get(op.on), k = resolve(op.fn, ctx); if (r && k) { const child = mux(r.kind, r, op.prefix), f = funcs.get(k)!; run(k, new Map(f.f.params[0] ? [[f.f.params[0], child]] : []), depth + 1) } }
        else if (op.op === 'route') { const r = binds.get(op.on); if (r) for (const m of op.methods) routes.push({ router: r, method: m, path: op.path, handler: op.handler, mws: op.mws.map(ref => ({ ref, ctx })), seq: seq++, ctx }) }
        else if (op.op === 'sub') { const r = binds.get(op.on); if (r) exec(op.ops, new Map([...binds, [op.v, mux(r.kind, r, op.prefix)]]), depth, ctx) }
        else if (op.op === 'mount') { const r = binds.get(op.on); if (!r) continue
          const t = op.target, sub = t.fn ? binds.get(t.fn) : undefined
          if (sub) { sub.parent = r; sub.prefix = op.prefix + sub.prefix; if (t.wrap) sub.mws.unshift(...t.wrap.map(w => ({ ref: { call: w }, at: -1, ctx }))) }
          else { const k = resolve(t.call ?? t.fn ?? '', ctx); if (k) { const child = mux(r.kind, r, op.prefix); if (t.wrap) child.mws.push(...t.wrap.map(w => ({ ref: { call: w }, at: -1, ctx }))); run(k, new Map(), depth + 1, child) } } }
        else if (op.op === 'call' || op.op === 'assign') { const k = resolve(op.fn, ctx); if (!k) continue
          const callee = funcs.get(k)!, b = new Map<string, Router>()
          op.args.forEach((a, i) => { const r = binds.get(a); if (r && callee.f.params[i]) b.set(callee.f.params[i], r) })
          const out = run(k, b, depth + 1)
          if (op.op === 'assign' && out) binds.set(op.v, out) }
        else if (op.op === 'serve') { const t = op.handler, r = t.fn ? binds.get(t.fn === 'nil' ? 'http' : t.fn) : undefined
          if (r && t.wrap) r.mws.unshift(...t.wrap.map(w => ({ ref: { call: w }, at: -1, ctx })))
          else if (!r && (t.call || t.fn)) { const k = resolve(t.call ?? t.fn!, ctx); if (k) { const out = run(k, new Map(), depth + 1); if (out && t.wrap) out.mws.unshift(...t.wrap.map(w => ({ ref: { call: w }, at: -1, ctx }))) } } }   // ListenAndServe(addr, newRouter())
        else if (op.op === 'return') { const r = binds.get(op.v); if (r) { if (op.wrap) r.mws.unshift(...op.wrap.map(w => ({ ref: { call: w }, at: -1, ctx }))); return r } }
      }
      return undefined
    }
    for (const [p, x] of goFiles) if (x.pkg === 'main' && x.funcs.has('main')) run(`${x.dir}::main`, new Map([['http', mux('mux')]]), 0)
    // what a middleware or handler is: by its code; a library's, by its import path
    const kindOf = (ref: GoRef, ctx: Ctx): 'login' | 'unknown' | 'none' => {
      const name = ref.wrap?.[0] ?? ref.call ?? ref.fn ?? ''   // AuthRequired(sm): the factory, not its argument
      if (ref.lit) return funcs.get(`${ctx.p}::${ref.lit}`)?.f.mw ?? 'none'
      const alias = name.split('.')[0], path = ctx.imports.get(alias) ?? ctx.vars?.get(alias) ?? ''
      const ours = !name.includes('.') || dirOfImport(path) !== undefined || !path
      if (!ours) {   // a library's: by what it is (its import path), not its name alone
        if ((ref.args ?? []).some(a => /Skipper|ContinueOnIgnoredError|CredentialsOptional/.test(a))) return 'unknown'
        if (/go-chi\/jwtauth/.test(path)) return /\.Authenticator\w*$/.test(name) ? 'login' : 'none'
        if (/labstack\/echo-jwt|golang-jwt\/echo|clerk/.test(path) || /labstack\/echo\/v\d+\/middleware$/.test(path) && /\.(JWT\w*|BasicAuth\w*|KeyAuth\w*)$/.test(name) || /gin-gonic\/gin$/.test(path) && /\.BasicAuth\w*$/.test(name))
          return /clerk/.test(path) && !/RequireHeaderAuthorization/.test(name) ? 'none' : 'login'
        if (/go-chi\/chi\/v\d+\/middleware$|labstack\/echo\/v\d+\/middleware$|rs\/cors|go-chi\/cors|gin-contrib|gorilla\/handlers|otelhttp|go-chi\/httprate|alexedwards\/scs|gin-gonic\/gin$/.test(path)) return 'none'
        return /auth|login|session|token|jwt|guard|protect|require|admin|user|clerk|supabase/i.test(name) ? 'unknown' : 'none'
      }
      const k = resolve(name, ctx)
      if (k) return funcs.get(k)!.f.mw ?? 'none'
      return /auth|login|session|token|jwt|guard|protect|require|admin|user|clerk|supabase/i.test(name) ? 'unknown' : 'none'
    }
    // that login check is "only admins" (our own middleware whose deciding check turns away non-admins)
    const adminOf = (ref: GoRef, ctx: Ctx) => { if (ref.lit) return !!funcs.get(`${ctx.p}::${ref.lit}`)?.f.mwAdmin
      const k = resolve(ref.wrap?.[0] ?? ref.call ?? ref.fn ?? '', ctx); return !!(k && funcs.get(k)!.f.mwAdmin) }
    // facts of a handler and what it calls (a few levels down)
    const follow = (g: FileFacts, into: FileFacts, seen: Set<string>, self: string, depth = 0) => {
      for (const u of g.used) if (u.startsWith('gcall:') && !seen.has(u) && depth < 5) {
        seen.add(u)
        const imp = u.slice(6, u.lastIndexOf('.')), m = u.slice(u.lastIndexOf('.') + 1)
        // (h.store.ListBoxes from Handler.ListBoxes: the store's, not the handler itself)
        const ks = imp === '*' ? [...funcs.keys()].filter(k => k.endsWith(`.${m}`) && k !== self && !k.includes('@lit')) : (() => { const d = goFiles.find(([, x]) => x.pkg === imp)?.[1].dir ?? dirOfImport(imp); return d !== undefined && funcs.has(`${d}::${m}`) ? [`${d}::${m}`] : [] })()
        if (ks.length !== 1) continue   // (a method name several types have: plain can't tell which)
        const callee = funcs.get(ks[0])!.f
        for (const key of ['tables', 'written', 'ops', 'outside', 'env', 'envReq', 'services', 'refuses', 'used'] as const) for (const x of callee[key]) into[key].add(x)
        into.money ||= callee.money; into.writes ||= callee.writes; into.printed += '\n' + callee.printed
        follow(callee, into, seen, ks[0], depth + 1)
      }
    }
    // tables: GORM's AutoMigrate'd structs (by struct name), and the tables SQL migrations build (by table name)
    const structs = new Map(goFiles.flatMap(([, x]) => [...x.structs]))
    goDb = readDb([...snap].filter(([p]) => goMigration(p) && !!gomod).sort(([a], [b]) => a.localeCompare(b)).map(([p, t]) => [p, t.split(/^--\s*\+goose\s+Down\b/im)[0]] as [string, string]))
    for (const name of goFiles.flatMap(([, x]) => x.automigrate)) { const fs = structs.get(name); if (fs && !goDb.tables.has(pluralize(name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()))) { goModels.set(name, fs); goGorm.add(name) } }
    for (const [t, tb] of goDb!.tables) goModels.set(t, [...tb.cols, ...[...tb.refs.values()].map(r => `→${singular(r)}`)])
    const snake = (e: string) => e.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    const tableOf = (t: string) => { const e = t.replace(/^@e:/, '')
      if (e.startsWith('@t:')) { const tb = e.slice(3); return goModels.has(tb) ? tb : goModels.has(goModelOf(tb)) ? goModelOf(tb) : undefined }
      const words = e.match(/[A-Z][a-z0-9]*/g) ?? [e]
      const tries = [words.join(''), ...words.slice(1).map((_, i) => words.slice(i + 1).join('')), ...words.slice(0, -1).map((_, i) => words.slice(0, words.length - 1 - i).join(''))]
      for (const w of tries) for (const c of [w, pluralize(snake(w)), snake(w)]) if (goModels.has(c)) return c
      return undefined }
    const required = new Set(goFiles.flatMap(([, x]) => x.required))
    const finish = (g: FileFacts) => {
      for (const k of ['tables', 'written'] as const) for (const t of [...g[k]]) if (t.startsWith('@')) { g[k].delete(t); const m = tableOf(t); if (m) g[k].add(m) }
      g.writes = g.written.size > 0; if (!g.writes) g.ops.clear()
      for (const x of g.env) if (required.has(x)) g.envReq.add(x)
      return g
    }
    const finishFile = (g: FileFacts, x: GoFacts['go']) => { finish(g); for (const k of x.required) { g.env.add(k); g.envReq.add(k) }
      return g
    }
    for (const r of routes) {
      const h0 = r.handler, direct = h0.lit ? `${r.ctx.p}::${h0.lit}` : resolve(h0.fn ?? h0.call ?? '', r.ctx)
      const fk = !direct && h0.wrap?.length ? resolve(h0.wrap.at(-1)!, r.ctx) : undefined
      const factory = fk && !funcs.get(fk)!.f.takesHandler ? fk : undefined   // createOrderHandler(pool), not requireAuth(ordersHandler)
      const h = factory ? { ...h0, wrap: h0.wrap!.slice(0, -1) } : h0, hk = direct ?? factory, hf = hk ? funcs.get(hk) : undefined
      const facts = Object.assign(empty(), hf?.f, { tables: new Set(hf?.f.tables), written: new Set(hf?.f.written), ops: new Set(hf?.f.ops), env: new Set(hf?.f.env), envReq: new Set(hf?.f.envReq), services: new Set(hf?.f.services), outside: new Set(hf?.f.outside), used: new Set(hf?.f.used), refuses: new Set(hf?.f.refuses) })
      if (hf) follow(hf.f, facts, new Set(), hk!)
      finish(facts)
      const mws = [...chain(r.router, r.seq), ...r.mws, ...(h.wrap ?? []).map(w => ({ ref: { call: w } as GoRef, ctx: r.ctx }))]
      const kinds = [...mws.map(m => kindOf(m.ref, m.ctx)), hf?.f.check ?? 'none', hf ? 'none' : 'unknown']
      const guard = kinds.includes('login')
      const path = (fullPrefix(r.router) + r.path).replace(/\/+/g, '/').replace(/(.)\/$/, '$1') || '/'
      const at = hf ? (hk!.includes('::@lit') ? fileOfLit(hk!) : hf.p) : r.ctx.p
      const admin = guard && (mws.some(m => adminOf(m.ref, m.ctx)) || !!hf?.f.checkAdmin)
      files.get(at)?.handlers.push({ server: '', method: r.method === 'ANY' ? (facts.writes ? 'POST' : 'GET') : r.method, path: goPath(path), guard, admin, mw: [], facts, unknown: !guard && kinds.includes('unknown') })
    }
    for (const [p, x] of goFiles) finishFile(files.get(p)!, x)
    // Go before 1.22 reads "POST /orders/{id}" as a literal path: those routes never match
    const v = gomod?.[1].match(/^go\s+1\.(\d+)/m)?.[1]
    if (v && +v < 22 && routes.some(r => r.router.kind === 'mux' && (r.method !== 'ANY' || /\{/.test(r.path)))) goOld = `1.${v}`
  }
  // form actions outside SvelteKit aren't routes
  for (const f of files.values()) f.handlers = f.handlers.filter(h => h.server !== '@actions')
  // TanStack server actions: calling one (createBooking({ data }), useServerFn(createBooking)) talks to the server.
  for (const [p, f] of files) for (const x of f.used) {
    const q = f.serverFns.has(x) ? p : target(p, x), m = q && files.get(q)?.serverFns.get(x)
    if (m) f.fetches.add(`${m} (server action) ${x} in ${q}`)
  }
  const middleware = new Map([...files.values()].flatMap(f => [...f.middleware]))
  // React Router: the component each <Route> shows is a page at that address. It runs in the browser.
  // Angular: loadChildren: () => import('./admin/admin.routes') puts that file's routes under this path (and behind its guard)
  const childMounts = new Map<string, { path: string; guard: boolean; from: string }>()
  for (const [p, f] of files) for (const pg of f.pages) if (pg.comp.startsWith('@children:')) {
    const q = resolve(p, pg.comp.slice(10).split('#')[0]); if (!q) continue
    // an NgModule (admin.module.ts) keeps its routes in the routing module it imports (admin-routing.module.ts)
    const withRoutes = files.get(q)!.pages.length ? [q] : files.get(q)!.imports.map(i => resolve(q, i)).filter((x): x is string => !!x && !!files.get(x)?.pages.length)
    for (const x of withRoutes) childMounts.set(x, { path: pg.path, guard: pg.guard === true, from: p })
  }
  const mountOf = (p: string, seen = new Set<string>()): { path: string; guard: boolean } => { const m = childMounts.get(p); if (!m || seen.has(p)) return { path: '', guard: false }
    seen.add(p); const up = mountOf(m.from, seen); return { path: (up.path === '/' ? '' : up.path) + (m.path === '/' ? '' : m.path), guard: up.guard || m.guard } }
  for (const [p, f] of files) for (const pg of f.pages) {
    if (pg.comp.startsWith('@children:')) continue
    const q = pg.comp.startsWith('@load:') ? resolve(p, pg.comp.slice(6).split('#')[0]) : target(p, pg.comp)
    const m = mountOf(p), url = (m.path.replace(/\/$/, '') + (pg.path === '/' && m.path ? '' : pg.path)) || '/'
    if (q && !routes.has(q)) { routes.set(q, { kind: 'page', url }); browserPages.add(q); if (pg.guard === true || m.guard) files.get(q)!.auth = true
      else if (pg.guard === 'unknown') (files.get(q) as FileFacts & { guardUnknown?: boolean }).guardUnknown = true }
  }
  // Express-style servers: each address becomes its own unit "file#/api/x", with the facts of its handlers.
  const mounts = new Map<string, { path: string; guard: boolean; from: string; mw?: string[] }>()
  const guards: { from: string; path: string }[] = []
  for (const [p, f] of files) if (!p.endsWith('.py')) for (const m of f.mounts) {
    const q = m.target.startsWith('.') ? resolve(p, m.target) : target(p, m.target), file = q && files.get(q)
    if (file && (file.handlers.length || file.mounts.length)) mounts.set(q!, { ...m, from: p })   // it declares routes: a router
    else if (m.guardLike) guards.push({ from: p, path: m.path })                                  // otherwise it's a login check
  }
  // (mws: the guards' names on the way down, with the file each is written in: app.use('/api/admin', requireAuth, requireAdmin, admin))
  const prefix = (p: string, seen = new Set<string>()): { path: string; guard: boolean; mws: { p: string; n: string }[] } => {
    const m = mounts.get(p); if (!m || seen.has(p)) return { path: '', guard: false, mws: [] }
    const up = prefix(m.from, seen.add(p))
    return { path: up.path.replace(/\/$/, '') + m.path, guard: up.guard || m.guard, mws: [...up.mws, ...(m.mw ?? []).map(n => ({ p: m.from, n }))] }
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
  // Python: a route also does what the functions it calls do (create_order() in services.py), following them down.
  // Only real calls: create_order(...) or services.create_order(...) on an imported module, never ctx.update(...) or cache.delete(...).
  const pyFold = (p: string, hf: FileFacts, into: FileFacts, seen: Set<string>) => {
    const f = files.get(p)!
    for (const u of hf.used) {
      const m = u.match(/^call:(?:(\w+)\.)?(\w+)$/); if (!m) continue
      // services.create_order(): only when `services` is a module (from shop import services), not a thing inside one (from app.cache import cache)
      const isModule = (q?: string) => { const path = f.binds.get(mod!)!.slice(3).replace(/^\.+/, '').replace(/\./g, '/'); return !!q && (q.endsWith(`${path}.py`) || q.endsWith(`${path}/__init__.py`)) }
      const [, mod, fn] = m, q = mod ? (f.binds.has(mod) && isModule(target(p, mod)) ? target(p, mod) : undefined) : f.locals.has(fn) ? p : f.binds.has(fn) ? target(p, fn) : undefined
      const name = mod || f.locals.has(fn) ? fn : f.binds.get(fn)?.split('.').at(-1) ?? fn, g = q && files.get(q)?.locals.get(name)
      if (!g || seen.has(`${q}::${name}`)) continue
      seen.add(`${q}::${name}`)
      for (const k of ['tables', 'written', 'ops', 'outside', 'env', 'envReq', 'services', 'refuses'] as const) for (const y of g[k]) into[k].add(y)
      into.money ||= g.money; into.writes ||= g.writes
      pyFold(q!, g, into, seen)
    }
  }
  // Django: walk urlpatterns down from each urls.py nobody includes. Every view becomes a route in the file that defines it.
  const djOf = (p?: string) => p ? (files.get(p) as PyFacts | undefined)?.dj : undefined
  const djFiles = [...files].filter(([p]) => p.endsWith('.py') && djOf(p)).map(([p]) => [p, djOf(p)!] as const)
  const djDrf = djFiles.map(([, d]) => d.drf).find(x => x !== undefined) ?? false, djLoginMw = djFiles.some(([, d]) => d.loginMw)
  const djInclude = (p: string, inc: string) => resolve(p, `py:${inc}`) ?? target(p, inc.split('.')[0])
  type Found = { file: string; name: string; guard?: boolean; actions?: Record<string, string>; pc?: string }
  // a name in a module: defined there, assigned there (wipe = Wipe.as_view()), imported into it (views/__init__.py re-exports), or from a `from x import *`
  const djFind = (p: string | undefined, name: string, seen = new Set<string>()): Found | undefined => {
    const d = djOf(p); if (!d || seen.has(`${p}::${name}`)) return undefined
    seen.add(`${p}::${name}`)
    const al = d.aliases.get(name)
    if (d.views.has(name) || d.classes.has(name) || d.routers.has(name)) return { file: p!, name, guard: al?.view === name && al.guard }   // wipe = login_required(wipe)
    if (al) { const r = djRef(p!, al.view, seen); return r && { ...r, guard: r.guard || al.guard, actions: r.actions ?? al.actions, pc: r.pc ?? al.pc } }
    const b = files.get(p!)!.binds.get(name)
    if (b) { const q = target(p!, name); if (q && q !== p) return djFind(q, b.split('.').at(-1)!, seen) }
    for (const st of d.stars) { const r = djFind(resolve(p!, `py:${st}.x`), name, seen); if (r) return r }
  }
  const djRef = (p: string, ref: string, seen?: Set<string>) => { const [head, ...rest] = ref.split('.')
    return rest.length ? djFind(target(p, head) ?? (djOf(p)?.classes.has(head) ? p : undefined), rest.at(-1)!, seen) : djFind(p, head, seen) }
  // A class and its base classes in Python's order (depth first, a shared base after every class that uses it), followed through imports.
  // bases: the names from outside the app (ModelViewSet, LoginRequiredMixin, ...) in that order; a base imported from rest_framework counts as DRF.
  // ponytail: "last occurrence wins" depth-first order; matches C3 for diamonds, not for every pathological hierarchy
  const djChain = (p: string, name: string) => {
    const order: { key: string; cls?: DjClass; ext?: string }[] = []
    const walk = (p: string, name: string, stack: Set<string>) => {
      const c = djOf(p)?.classes.get(name), key = `${p}::${name}`
      if (!c || stack.has(key)) return
      order.push({ key, cls: c })
      for (const b of c.bases) {
        const r = djRef(p, b)
        if (r && djOf(r.file)?.classes.has(r.name)) { walk(r.file, r.name, new Set([...stack, key])); continue }
        const from = files.get(p)!.binds.get(b.split('.')[0]) ?? ''
        const ext = b.split('.').at(-1)!   // TokenViewBase from rest_framework_simplejwt is a DRF view too
        order.push({ key: b, ext: /rest_framework/.test(from) && !/APIView$|ViewSet$|Mixin$/.test(ext) ? 'APIView' : ext })
      }
    }
    walk(p, name, new Set())
    const last = order.filter((x, i) => !order.slice(i + 1).some(y => y.key === x.key))
    return { chain: last.flatMap(x => x.cls ? [x.cls] : []), bases: last.flatMap(x => x.ext ? [x.ext] : []) }
  }
  const djRouter = (p: string, inc: string) => { const r = /^\w+\.urls$/.test(inc) && djFind(p, inc.split('.')[0]); return r ? { file: r.file, regs: djOf(r.file)!.routers.get(r.name) } : undefined }
  const djIncluded = new Set(djFiles.flatMap(([p, d]) => d.urls.flatMap(u => u.include && !djRouter(p, u.include)?.regs ? [djInclude(p, u.include)] : [])))
  // <int:pk>, (?P<pk>\d+) -> [pk]; an unnamed group (\d+) -> [id]; (?:new|edit) -> new; regex marks dropped
  const djUrl = (s: string) => ('/' + s.replace(/\(\?P<(\w+)>[^)]*\)/g, '[$1]').replace(/\(\?:([^)|]*)[^)]*\)/g, '$1').replace(/<(?:\w+:)?(\w+)>/g, '[$1]').replace(/\((?!\?)[^)]*\)/g, '[id]')
    .replace(/\/\?/g, '/').replace(/[\^$?\\]/g, '')).replace(/\/+/g, '/')
  const djView = (p: string, ref: string, url: string, guard: boolean, viewset: boolean, u: { actions?: Record<string, string>; pc?: string } = {}) => {
    const r = djRef(p, ref); if (!r) return
    const d = djOf(r.file)!, actions = u.actions ?? r.actions, pc = u.pc ?? r.pc
    // as_view(permission_classes=[AllowAny]) sets it on the instance: it wins over the class's own, not over a login mixin
    let routes = d.views.get(r.name) ?? (() => { const { chain, bases } = djChain(r.file, r.name)
      return djClassRoutes(pc ? [{ bases: [], pc, md: new Set(), open: false, defs: [], rest: empty() }, ...chain] : chain, bases, () => empty()) })()
    if (actions) routes = Object.entries(actions).flatMap(([m, a]) => { const x = routes.find(x => x.act === a); return x ? [{ ...x, method: m, sub: '' }] : [] })   // as_view({'get': 'list'})
    for (const x of routes) if (viewset || x.sub === '') {
      // a function view with no method check: POST if it (or a helper it calls) changes data
      let method = x.method
      const anyMethod = method === 'ANY'
      if (anyMethod) { const t = empty(); pyFold(r.file, x.facts, t, new Set()); method = x.facts.writes || x.facts.money || x.facts.outside.size || t.writes || t.written.size || t.money || t.outside.size ? 'POST' : 'GET' }
      const own = x.guard
      const g = own === undefined ? (x.drf ? (djDrf === 'writes' ? method !== 'GET' : djDrf) : false) : own === 'writes' ? method !== 'GET' : own
      // LoginRequiredMiddleware skips @login_not_required views, and DRF views (DRF 3.16+ exempts them: its own permissions decide)
      // anyMethod: it answers a plain visit (GET) too, and does the same thing
      files.get(r.file)!.handlers.push({ server: '', method, path: djUrl(url + (viewset ? x.sub + '/' : '')), guard: guard || !!r.guard || g || djLoginMw && !x.open && !x.drf, mw: [], facts: x.facts, anyMethod })
    }
  }
  const djWalk = (p: string, pre: string, guard: boolean, seen: Set<string>) => {
    if (seen.has(p)) return
    for (const u of djOf(p)!.urls) {
      const router = u.include && djRouter(p, u.include)
      if (router && router.regs) for (const r of router.regs) djView(router.file, r.view, pre + u.path + (u.path && !u.path.endsWith('/') ? '/' : '') + r.prefix, guard, true)
      else if (u.include) { const q = djInclude(p, u.include); if (q && djOf(q)) djWalk(q, pre + u.path, guard || u.guard, new Set([...seen, p])) }
      else if (u.view) djView(p, u.view, pre + u.path, guard || u.guard, false, u)
    }
  }
  for (const [p, d] of djFiles) if (d.urls.length && !djIncluded.has(p)) djWalk(p, '', false, new Set())

  // a function whose code turns away non-admins: a top-level `if` (not inside another if, loop or try: `if (req.method === 'DELETE')`)
  // whose whole condition does (adminCond), and whose own branch rejects (403, forbidden, a redirect) and stops (return, throw)
  const DENY_NEAR = /\b40[13]\b|[Ff]orbidden|[Uu]nauthori[sz]ed|redirect|\bthrow\b|\babort\b|[Aa]ccess[Dd]enied|PermissionDenied/
  const CONTROL = /\b(?:if|else|for|while|switch|catch|try|do|finally)\b[^{};]*$/
  const adminText = (t: string) => [...t.matchAll(/\bif\s*\(/g)].some(m => {
    const k = m.index!, open = k + m[0].length - 1
    let d = 0, j = open; for (; j < t.length; j++) { if (t[j] === '(') d++; else if (t[j] === ')' && --d === 0) break }
    const cond = t.slice(open + 1, j), pos = adminPos(cond)
    if (!pos && !adminCond(cond)) return false
    // (the flag's variable set from the request earlier: `const u = req.body`, `const h = req.headers`)
    const v = cond.match(/^[\s!(]*([\w$]+)/)?.[1], src = v ? t.slice(0, k).match(new RegExp(String.raw`\b(?:const|let|var)\s+${v.replace('$', '\\$')}\s*=\s*([^;\n]+)`))?.[1] : undefined
    if (src && (FROM_REQUEST.test(src) || /^\s*(?:req|request)\.(?:query|headers|body|params|cookies)\b/.test(src))) return false
    const stack: { ctrl: boolean; at: number }[] = []
    for (let x = 0; x < k; x++) { if (t[x] === '{') stack.push({ ctrl: CONTROL.test(t.slice(Math.max(0, x - 200), x).split(/[;}]/).pop()!), at: x }); else if (t[x] === '}') stack.pop() }
    if (stack.some(s => s.ctrl)) return false
    // (nothing before it in the same function lets requests through: `if (req.method === 'GET') return next()`, a bare next())
    if (/\breturn\b|\bnext\s*\(\s*\)/.test(t.slice((stack.at(-1)?.at ?? -1) + 1, k))) return false
    const rest = t.slice(j + 1).replace(/^\s*/, '')
    let branch = rest.split(/;|\n/)[0]
    if (rest[0] === '{') { let e = 0, q = 0; for (; q < rest.length; q++) { if (rest[q] === '{') e++; else if (rest[q] === '}' && --e === 0) break } branch = rest.slice(0, q + 1) }
    // (the other way round: admins go on, and the next statement turns everyone else away)
    if (pos) { const after = rest.slice(branch.length).replace(/^[\s;]*/, '').split(/;|\n/)[0]
      return /^return\s+next\s*\(\s*\)|^\{?\s*return\s+next\s*\(\s*\)/.test(branch.replace(/^\{\s*/, '')) && DENY_NEAR.test(after) && /^(return|throw)\b/.test(after) && !/\bnext\s*\(|\?/.test(after) }   // (not `return req.method === 'GET' ? next() : res.status(403)`)
    return DENY_NEAR.test(branch) && /\breturn\b|\bthrow\b|\bnext\(\s*(?:new\b|create\w*\(|err)/.test(branch) })
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
      if (p.endsWith('.py')) pyFold(p, hf, unit, new Set())
      // a server action's helpers (sendMentionEmails in lib/email.ts, a service it calls): what they write and who they talk to
      if (h.path.startsWith('(server action) ')) { const usedAll = new Set(hf.used); const follow = (at: string, g: FileFacts, depth: number, seen: Set<string>) => { if (depth > 3) return
        for (const n of g.used) { const q = files.get(at)?.locals.has(n) ? at : target(at, n), c = q ? files.get(q)?.locals.get(n) : undefined
          if (!c || seen.has(`${q}:${n}`)) continue
          seen.add(`${q}:${n}`)
          for (const k of ['tables', 'written', 'ops', 'outside', 'env', 'envReq', 'services', 'refuses'] as const) for (const x of c[k]) unit[k].add(x)
          for (const x of c.used) usedAll.add(x); if (c.auth || c.authStop || c.sbAuth) usedAll.add('auth')
          unit.money ||= c.money; follow(q!, c, depth + 1, seen) } }
        const seen = new Set([`${p}:${h.handler}`]); follow(p, hf, 0, seen)
        // Next.js: nothing in it or its helpers about who's asking (no auth(), session, require*, user, role...): open to anyone
        if (h.nextAction) h.unknown = hf.auth || hf.authStop || [...usedAll, ...[...seen].slice(1).map(x => x.split(':').pop()!)].some(n => AUTH.has(n) || REQUIRE_LOGIN.test(n) || /auth|session|user|require|ensure|guard|member|permission|role|admin|clerk|supabase|verify|token|jwt|viewer|cookies|headers/i.test(n)) }
      // opening the address (GET) changes or deletes things: a link alone can do it
      // (not a view that checks request.method == 'POST': its GET and POST share one body; not a views counter: F('views') + 1)
      const shared = f.handlers.some(o => o !== h && o.facts === h.facts && o.method !== 'GET')
      let getWrites = false
      if (h.anyMethod || h.method === 'GET' && !shared) { const t = empty(); if (p.endsWith('.py')) pyFold(p, hf, t, new Set())
        if (['update', 'delete'].some(o => hf.ops.has(o) || t.ops.has(o)) && !([...hf.printed.matchAll(/\.a?update\(((?:[^()]|\([^()]*\))*)\)/g)].every(m => /\bF\(\s*['"]\w+['"]\s*\)\s*[+-]/.test(m[1])) && /\bF\(/.test(hf.printed) && !hf.ops.has('delete') && !/\.a?save\(/.test(hf.printed))) getWrites = (unit as FileFacts & { getWrites?: boolean }).getWrites = true }
      unit.fns.set(h.method, hf.printed)
      unit.printed += `\n${h.method} ${hf.printed}`
      // Logged in if every handler that changes something checks (or, with none, every handler does).
      // A named middleware counts unless this repo defines it and it can't stop anyone; reading the user counts only if the code acts on it.
      const mwGuard = h.guard && !(h.mw.length && h.mw.every(m => middleware.get(m) === false))
      // "only admins" for named middleware (Express-style): this repo's function, whose code turns away non-admins; a name alone
      // (requireAdmin from a package, or one plain can't find) keeps "requires login"
      // (imported under another name, `{ requireStaff as requireAdmin }`: plain would read the wrong function, so no claim)
      const readable = (at: string, m: string) => { const n = m.match(/^[\w$.]+/)?.[0] ?? '', q = files.get(at)?.locals.has(n) ? at : target(at, n)
        if (q !== at && new RegExp(String.raw`\b\w+\s+as\s+${n}\b|[{,]\s*\w+\s*:\s*${n}\s*[,}]`).test(files.get(at)?.printed ?? '')) return undefined
        return q ? files.get(q)?.locals.get(n)?.printed : undefined }
      const adminMw = (at: string, m: string) => adminText(readable(at, m) ?? '')
      if (!h.admin && (mwGuard && h.mw.some(m => adminMw(p, m)) || pre!.guard && pre!.mws.some(x => adminMw(x.p, x.n)))) h.admin = true
      // (a guard still named for it that plain can't read, requireRole('admin') from a package: it may still be there; one plain
      // reads and finds empty, a gutted requireAdmin, isn't)
      // (or a factory given the role, requireRole('admin'): its test is on a parameter plain doesn't follow)
      if ([...h.mw.map(n => ({ p, n })), ...pre!.mws].some(x => /admin|role|staff|superuser|permission/i.test(x.n) && readable(x.p, x.n) === undefined || /\(\s*['"](?:super[-_]?)?(?:admin|staff|superuser)['"]/i.test(x.n))) (unit as FileFacts & { adminish?: boolean }).adminish = true
      // (a GET that updates or deletes changes things too: its login decides, like a POST's)
      // (a Next.js server action: its own structural check, not any auth() call next to a success redirect)
      const writes = h.method !== 'GET' || getWrites, guard = h.nextAction ? handlerChecks(hf) : pre!.guard || mwGuard || !!py?.guard || (hf.auth || hf.sbAuth) && STOPS.test(hf.printed) || guardedPaths.some(g => url === g || url.startsWith(g.replace(/\/$/, '') + '/'))
      const u = unit as FileFacts & { w?: boolean[]; r?: boolean[]; wu?: string[]; ru?: string[]; wa?: boolean[]; ra?: boolean[] }
      ;(writes ? (u.w ??= []) : (u.r ??= [])).push(guard)
      unit.auth = (u.w?.length ? u.w : u.r!).every(Boolean)
      // "only admins": every handler that decides checks for an admin (and the reads, said apart when they don't)
      ;(writes ? (u.wa ??= []) : (u.ra ??= [])).push(guard && !!h.admin)
      unit.admin = unit.auth && (u.w?.length ? u.wa! : u.ra!).every(Boolean)
      // Spring: plain can't tell whether this address is open, when the handlers that decide it are unknown and none is plainly open
      ;(writes ? (u.wu ??= []) : (u.ru ??= [])).push(guard ? 'login' : h.unknown ? 'unknown' : 'open')
      const deciding = u.w?.length ? u.wu! : u.ru!
      ;(unit as FileFacts & { guardUnknown?: boolean }).guardUnknown = deciding.includes('unknown') && !deciding.includes('open')
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
  // <form method="POST"> sends to its own page: SvelteKit's form actions (also from a child component, folded in above); elsewhere it says nothing
  for (const [p, f] of files) for (const x of [...f.fetches]) if (x.endsWith(' @self')) { f.fetches.delete(x); if (svelteUrls.has(p)) f.fetches.add(`POST ${svelteUrls.get(p)}`) }
  // Reading the session in the browser redirects nobody; on a server (edge function, Next.js) it's a real check.
  for (const k of routes.keys()) if (files.get(k)!.sbAuth && !browserPages.has(k) && !(routes.get(k)!.kind === 'page' && /^(?:src\/)?(?:app|pages)\//.test(k))) files.get(k)!.auth = true
  // Whether a page or address checks login is part of what it is: losing the check counts as a change.
  for (const k of routes.keys()) files.get(k)!.printed += `\n[login: ${files.get(k)!.auth}${files.get(k)!.admin ? ', admins only' : ''}]`
  const schemaPath = [...snap.keys()].find(p => p.endsWith('schema.prisma') && !p.includes('node_modules/'))
  const db = readDb([...snap].filter(([p]) => isMigration(p)))
  const all = models(schemaPath && snap.get(schemaPath))
  for (const [t, tb] of db.tables) all.set(t, [...tb.cols, ...[...tb.refs.values()].map(r => `→${singular(r)}`)])
  // Drizzle schema: export const orders = pgTable('orders', { id: serial('id').primaryKey(), userId: integer('user_id').references(() => users.id) })
  const dzModels = new Set<string>()
  for (const [p, t] of snap) if (CODE.test(p) && !p.includes('node_modules/') && /\b(pg|sqlite|mysql)Table\s*\(/.test(t))
    for (const m of t.matchAll(/export\s+const\s+(\w+)\s*=\s*(?:pg|sqlite|mysql)Table\s*\(\s*['"`]\w+['"`]\s*,\s*\{/g)) {
      let i = m.index! + m[0].length, depth = 1, body = ''
      for (; i < t.length && depth; i++) { const ch = t[i]; depth += ch === '{' || ch === '(' || ch === '[' ? 1 : ch === '}' || ch === ')' || ch === ']' ? -1 : 0; if (depth) body += depth === 1 ? ch : ch === '\n' ? ' ' : ch }
      const name = m[1].replace(/Table$/, ''), fields: string[] = []
      // top-level keys only (nested objects were flattened onto one line above)
      for (const line of body.split(/,\s*\n|\n/)) { const k = line.match(/^\s*(\w+)\s*:\s*(.*)$/); if (!k) continue
        const ref = k[2].match(/references\(\s*\(\)\s*=>\s*(\w+)\./)?.[1]; fields.push(ref ? `→${singular(ref.replace(/Table$/, ''))}` : k[1]) }
      all.set(name, fields); dzModels.add(name)
    }
  for (const [m, fs] of csModels) all.set(m, fs)
  for (const [m, fs] of javaModels) all.set(m, fs)
  for (const [m, fs] of phpModels) all.set(m, fs)
  for (const [m, fs] of rbModels) all.set(m, fs)
  for (const [m, fs] of goModels) all.set(m, fs)
  const pyModels = new Set<string>()
  for (const f of files.values()) for (const [m, fs] of (f as PyFacts).models ?? []) { all.set(m, fs); pyModels.add(m) }
  return {
    files, routes, db, models: all, schemaPath, pyModels, dzModels, csModels: new Set(csModels.keys()), javaModels: new Set(javaModels.keys()), phpModels: new Set(phpModels.keys()), rbModels: new Set(rbModels.keys()), goModels: new Set(goModels.keys()), goGorm, goDb, goOld,
    goMigrations: [...snap.keys()].some(p => /(^|\/)go\.mod$/.test(p)) ? [...snap.keys()].filter(goMigration) : [],
    rbMigrations: [...snap.keys()].filter(p => /(^|\/)db\/migrate\/[^/]+\.rb$/.test(p)),
    phpMigrations: [...snap.keys()].filter(p => /(^|\/)database\/migrations\/[^/]+\.php$/.test(p)),
    // Flyway: src/main/resources/db/migration/V2__add_coupons.sql
    flyway: [...snap.keys()].filter(p => /(^|\/)db\/migration\/V[\d_.]+__[\w-]+\.sql$/.test(p)),
    efMigrations: [...snap.keys()].filter(p => /(^|\/)Migrations\/\d+_\w+\.cs$/.test(p) && !/\.Designer\.cs$/.test(p)),
    // drizzle-kit generate writes drizzle/0001_x.sql (or the `out` folder next to meta/_journal.json)
    dzMigrations: [...snap.keys()].filter(p => /\.sql$/.test(p) && !isMigration(p) && !/prisma\/migrations\//.test(p) && (/(^|\/)drizzle\//.test(p) || snap.has(p.replace(/[^/]+$/, 'meta/_journal.json')))),
    pyMigrations: [...snap.keys()].filter(p => /(^|\/)(migrations\/versions|alembic\/versions|migrations)\/[^/]+\.py$/.test(p) && !p.endsWith('__init__.py')),
    envExample: envKeys([...snap].filter(([p]) => /(^|\/)\.env\.example$/.test(p)).map(([, t]) => t).join('\n')), deps: deps_,
    migrations: [...snap.keys()].filter(p => /prisma\/migrations\/.+\.sql$/.test(p)), sqlMigrations: [...snap.keys()].filter(isMigration),
  }
}

// ---------- English ----------
// Every sentence below is a fixed template filled with facts. No model writes any of it.

// (AIRequest -> "AI request", ai_requests -> "AI requests": acronyms split off and kept in capitals)
const ACRONYM: Record<string, string> = { ai: 'AI', api: 'API', sms: 'SMS', pdf: 'PDF', url: 'URL', faq: 'FAQ', csv: 'CSV', sso: 'SSO', otp: 'OTP' }
const words = (s: string) => s.replace(/OAuth/g, 'Oauth').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase()
  .split(' ').map(w => ACRONYM[w] ?? w).join(' ')
const singular = (s: string) => s.endsWith('ies') ? s.slice(0, -3) + 'y' : /(sses|xes|ches|shes)$/.test(s) ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s   // boxes -> box
const pluralize = (s: string) => s.endsWith('s') ? s : /[^aeiou]y$/i.test(s) ? s.slice(0, -1) + 'ies' : s + 's'   // (keys, surveys, categories)
export const things = (model: string) => pluralize(words(model))
const an = (w: string) => ((/^[A-Z]{2}/.test(w) ? /^[AEFHILMNORSX]/.test(w) : /^([aeio]|u(?!s|ni))/i.test(w)) ? 'an ' : 'a ') + w   // a user, an umbrella, an AI request, an SMS
export const list = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`
const DATES: Record<string, string> = { createdAt: 'date created', updatedAt: 'date updated', expiresAt: 'expiry date', deletedAt: 'date deleted' }
const camel = (c: string) => c.replace(/_([a-z])/g, (_, x) => x.toUpperCase())   // created_at -> createdAt
const fieldName = (c: string) => { const f = camel(c); return f === 'id' || /Id$/.test(f) ? '' : DATES[f] ?? (/At$/.test(f) ? words(f.slice(0, -2)) + ' date' : words(f.replace(/Cents$/, '')).replace(/^(is|has) /, '')) }   // is_intro_offer: "intro offer"
const fieldList = (fs: string[]) => list(fs.filter(f => !f.startsWith('→')).map(fieldName).filter(Boolean))

// "/products/[slug]/reviews" -> ["product", "reviews"]: a segment before a [param] is one of many
export const named = (url: string): string[] => {
  if (url.startsWith('(server action) ')) return [words(url.slice(16).split(' in ')[0].replace(/(?<=\w)Action$/, ''))]
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
  if (EMAIL.has(svc) && /emails?\.send|send/.test(chain)) return svc === 'email' ? 'emails people' : `emails people through ${svc}`
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
const PUBLIC = /^(login|log in|register|registration|signup|sign up|signin|sign in|logout|log out|signout|sign out|forgot password|reset password|verify|verify email|health|token|access token|refresh|refresh token)$/   // token: OAuth2 password login
const isPublic = (url: string) => url === '/session' || /^\/passwords(\/|$)/.test(url) || !/admin/i.test(url) && (   // /session: Rails 8's login (resource :session)
  named(url).some(s => /\b(webhooks?|callback|oauth)\b/.test(s)) || PUBLIC.test(named(url).at(-1) ?? ''))

export type Analysis = ReturnType<typeof analyze>
type Opts = { ref: string; asked?: string; color?: boolean; agentSaid?: string }   // agentSaid: the agent's last message, if known
export const report = (before: Snap, after: Snap, opts: Opts) => render(analyze(before, after, opts))

// Python and PHP: the mistakes AI makes most (Bandit / Semgrep rules), reported when they're new in a change
const RISK: Record<string, Problem> = {
  debug: { kind: 'Unsafe', text: "Debug mode is turned on. If this runs on your live site, an error page can show visitors your code and settings." },
  secret: { kind: 'Unsafe', text: "The app's secret key is written in the code. Anyone who sees the code can fake logins. Move it to an environment variable." },
  sql: { kind: 'Unsafe', text: 'A database query is built by pasting in text, which lets attackers read or change your data (SQL injection). Use query parameters instead.' },
  cors: { kind: 'Check', text: "Any website can call your server from a visitor's browser (CORS allows all sites). Fine for a public API, not for one that uses logins." },
  csrf: { kind: 'Check', text: 'A form was excluded from forgery protection (csrf_exempt). Other sites could submit it for a logged-in visitor.' },
}
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
    const sends = method === '?' ? !!e?.[1].fns.has('POST') && !e[1].fns.has('GET') : method !== 'GET'
    // sending: what that address writes, when it writes one thing (a booking form on a tutor's page sends bookings, not tutors)
    const t = e && (sends && e[1].written.size === 1 ? [...e[1].written][0] : mainTable(e[1], r!.url)), noun = t ? things(t) : 'data'
    if (e?.[1].money) return 'starts a payment 💰'
    return method === 'PUT' || method === 'PATCH' ? `updates ${noun} on your server` : method === 'DELETE' ? `deletes ${noun} on your server`
      : sends ? `sends ${noun} to your server` : `loads ${noun} from your server`
  }
  const newOnly = <T,>(a: Set<T> | undefined, b: Set<T>) => [...b].filter(x => !a?.has(x))
  const newPage = (name: string, f: FileFacts, clauses: string[]) => {
    const title = f.headings.find(h => h.startsWith('h1:'))?.slice(3)
    const sections = f.headings.filter(h => !h.startsWith('h1:')).map(h => h.slice(3).replace(/[.!]$/, ''))
    const rest = merge(clauses.filter(c => c !== 'requires login ✓' && c !== 'is for admins only ✓'))
    return [
      `${cap(name)} is new${title ? `, titled "${title}"` : ''}.`,
      sections.length ? `It has sections for ${list(sections)}.` : '',
      rest.length ? `It ${list(rest)}.` : '',
      viewOnly(f) ? 'It only shows information: nothing on it lets you change anything.' : '',
      f.auth ? (f.admin ? 'Only admins can open it ✓' : 'You have to log in to open it ✓') : '',
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
      const comps = newOnly(a?.jsx, b.jsx).filter(x => /^[A-Z]/.test(x) && !/^(Link|Image|Script|Head|NuxtLink|NuxtPage|NuxtLayout|NuxtImg|NuxtLoadingIndicator|ClientOnly|RouterLink|RouterView|Teleport|Transition|KeepAlive|Suspense)$/.test(x) && !x.includes('.')
        && !/icons?|lucide|phosphor|tabler|feather/i.test(b.binds.get(x) ?? '') && !/Icon$/.test(x))
      if (a && comps.length) clauses.push(`now shows the ${list(comps.map(nice))}`)
      const price = (f: FileFacts) => f.texts.has('[price]') || [...f.jsx].some(x => /Price|Money|Amount|Currency/.test(x))   // or a <Price/> component
      if (a && price(a) && !price(b)) clauses.push('no longer shows the price')
      if (a && !price(a) && price(b)) clauses.push('now shows a price')
      const gone = [...(a?.texts ?? [])].filter(t => !b.texts.has(t)).map(t => t.toLowerCase().replace(/[^a-z]/g, ''))
      const said = newOnly(a?.texts, b.texts).filter(t => t !== '[price]' && ![...b.ui].some(u => u.includes(t)) && !b.headings.some(h => h.endsWith(t))
        && !gone.includes(t.toLowerCase().replace(/[^a-z]/g, '')))   // "Save" -> "Save!" isn't new copy
      if (a && !clauses.length && said.length) clauses.push(`now says ${list(said.slice(0, 2).map(t => `"${t.length > 90 ? t.slice(0, 87) + '…' : t}"`))}`)
      if (!a && b.auth) clauses.push(b.admin ? 'is for admins only ✓' : 'requires login ✓')
    } else {
      const t = mainTable(b, r.url), noun = t ? things(t) : 'data'
      if (!a) {
        const can: string[] = [], creates = b.ops.has('create') || (b.writes && !b.ops.size)
        if (b.fns.has('GET')) can.push(`lists ${noun}`)
        if (b.fns.has('POST') || !METHODS.some(m => b.fns.has(m))) can.push(creates ? (can.length && (!t || b.written.has(t)) ? 'saves new ones' : `saves new ${t && !b.written.has(t) && b.written.size ? things([...b.written][0]) : noun}`)
          : b.ops.has('update') && b.ops.has('delete') && !['PUT', 'PATCH', 'DELETE'].some(m => b.fns.has(m)) ? `updates and deletes ${list([...(b.written.size ? b.written : [t ?? 'data'])].map(x => x === 'data' ? x : things(x)))}`   // (not which one each: plain doesn't keep that)
          : b.ops.has('update') ? `updates ${noun}` : b.ops.has('delete') ? `deletes ${noun}` : t ? `looks up ${noun}` : 'accepts requests')
        if (b.fns.has('PUT') || b.fns.has('PATCH')) can.push(`updates ${noun}`)
        if (b.fns.has('DELETE')) can.push(`deletes ${noun}`)
        clauses.push(...new Set(can))
        if (b.money) clauses.push('charges customers 💰')
        // (when only its changes need login, and reading it doesn't, say so: one ✓ for both would hide the open part)
        // (route files with one exported function per method, Next.js route.ts / SvelteKit +server.ts: a GET whose own code checks
        // nothing may still be covered by middleware, so only the changes' login is claimed)
        const ownGet = !p.includes('#') && b.fns.has('GET') && METHODS.slice(1).some(m => b.fns.has(m)) && b.locals.has('GET') && !handlerChecks(b.locals.get('GET'))
        const u = b as FileFacts & { w?: boolean[]; ru?: string[] }, reads = u.w?.length ? u.ru ?? [] : ownGet ? ['unknown'] : []
        const ra = (u as { ra?: boolean[] }).ra, readsAdmin = !ra?.length || ra.every(Boolean)
        if (b.auth && !isPublic(r.url)) clauses.push(b.admin ? (reads.includes('open') ? 'lets only admins change anything ✓ (anyone can view it)' : reads.includes('unknown') ? 'lets only admins change anything ✓'
            : readsAdmin ? 'is for admins only ✓' : 'lets only admins change anything ✓ (anyone logged in can view it)')
          : reads.includes('open') ? 'needs login to change anything ✓ (anyone can view it)' : reads.includes('unknown') ? 'needs login to change anything ✓' : 'requires login ✓')   // a login or webhook address that rejects bad passwords isn't "login required"
        else if (!b.written.size && !METHODS.slice(1).some(m => b.fns.has(m)) && !isPublic(r.url) && !(b as FileFacts & { guardUnknown?: boolean }).guardUnknown) clauses.push('works without logging in')   // (not when plain can't tell)   // read-only; changing ones get a warning instead
      } else {
        // what it now does to them: an address that gains update and delete doesn't "save" anything new
        // (ops aren't kept per table, so only when it writes to that one table alone)
        const verbs = b.written.size > 1 ? [] : ([['create', 'saves'], ['update', 'updates'], ['delete', 'deletes']] as const).filter(([o]) => b.ops.has(o) && (!a.ops.has(o) || !a.written.size)).map(([, v]) => v)
        for (const x of newOnly(a.written, b.written)) clauses.push(`${list(verbs.length ? [...verbs] : ['saves'])} ${things(x)}`)
        for (const x of newOnly(a.tables, b.tables).filter(x => !b.written.has(x))) clauses.push(`reads ${things(x)}`)
        if (!a.money && b.money) clauses.push('charges customers 💰')
        // only when there are more ways to say no than before: a reworded message isn't a new rule
        for (const m of newOnly(a.refuses, b.refuses).slice(0, Math.min(3, b.refuses.size - a.refuses.size))) clauses.push(`refuses with "${m}"`)
      }
      for (const o of newOnly(a?.outside, b.outside).filter(o => !o.startsWith('Stripe: checkout.sessions'))) clauses.push(outsidePhrase(o))
    }
    const name = placeName(p)
    // who can use it, when that changed: login, or admins on top of it
    const lead = !a ? '' : a.auth && !b.auth ? `${cap(name)} no longer requires login.` : !a.auth && b.auth ? `${cap(name)} now ${b.admin ? 'only lets admins in' : 'requires login'} ✓`
      : a.auth && b.auth && a.admin && !b.admin ? `${cap(name)} may no longer be limited to admins.` : a.auth && b.auth && !a.admin && b.admin ? `${cap(name)} is now limited to admins ✓` : ''
    const text = !a
      ? (r.kind === 'page' ? newPage(name, b, clauses) : `New server code that ${list(merge(clauses)) || 'handles requests'}.`)
      : (lead ? `${lead}${clauses.length ? ' It also' : ''}` : '')
        + (clauses.length ? `${lead ? ' now ' : `${cap(name)} now `}${list(merge(clauses.map(c => c.replace(/^now /, ''))))}.` : lead ? '' : `${cap(name)} changed in a way plain can't describe yet.${b.money ? '' : ' Ask the agent what it does differently.'}`)
    changes.push({ group: r.kind === 'page' ? 'Pages' : 'Server', isNew: !a, text: text + (a?.money && b.money ? ' This is the code that charges your customers 💰 Make a test payment before you ship.' : ''), detail: r.url, name: r.kind === 'page' ? pageName(r.url) + (!a && b.headings.find(h => h.startsWith('h1:')) ? ` ("${b.headings.find(h => h.startsWith('h1:'))!.slice(3)}")` : '') : named(r.url).join(' ') || 'main', money: b.money, vague: !!a && !clauses.length && a.auth === b.auth && !b.money })

    // SvelteKit: the layout asks for login, but this page's own server load doesn't wait for it (no `await parent()`), so its data can be
    // fetched without logging in (client-side navigation and __data.json skip the layout's load)
    if (r.kind === 'page' && (b as FileFacts & { dataOpen?: boolean }).dataOpen && !(a as FileFacts & { dataOpen?: boolean } | undefined)?.dataOpen)
      problems.push({ kind: 'Unsafe', text: `${cap(name)}'s data can be read without logging in. Its layout asks for login, but the page loads its own data without waiting for that check. Check locals.user in the page's load (or call \`await parent()\` first), or check in hooks.server.ts.` })
    // New, lost its login check, or started changing data without one
    const changesData = (f?: FileFacts) => !!f && (f.written.size > 0 || METHODS.slice(1).some(m => f.fns.has(m)))
    // an admin check dropped, login kept: anyone with an account gets in now
    if (a?.auth && b.auth && a.admin && !b.admin && !(b as FileFacts & { adminish?: boolean }).adminish && !isPublic(r.url))
      problems.push({ kind: 'Check', text: `plain can't see an admin check on ${placeName(p)} any more. If it's really gone, anyone with an account can use it now. Make sure only admins still can.` })
    if (!b.auth && !(b as FileFacts & { guardUnknown?: boolean }).guardUnknown && (!a || a.auth || !changesData(a) && changesData(b)) && !isPublic(r.url)) {
      const writes = changesData(b), before_ = problems.length
      if (r.kind === 'page' && /admin|dashboard|account/.test(r.url) && !(b as FileFacts & { guardUnknown?: boolean }).guardUnknown)
        problems.push({ kind: 'Unsafe', text: `Anyone can open ${name} without logging in.` })
      else if (r.kind === 'endpoint' && /(^|\/)admin(\/|$)/.test(r.url) && (writes || b.tables.size))   // admin data, even just to read
        problems.push({ kind: 'Unsafe', text: `Anyone can use ${name} without logging in.` })
      else if (r.kind === 'endpoint' && writes && (SENSITIVE.test(r.url) || [...b.written].some(t => SENSITIVE.test(t)) || adminCalls(r.url)))
        problems.push({ kind: 'Unsafe', text: `Anyone can use ${name} without logging in.` })
      else if (r.kind === 'endpoint' && writes) {
        const t = mainTable(b, r.url), noun = t ? things(t) : 'data'
        problems.push({ kind: 'Check', text: `Anyone can ${b.ops.has('create') || !b.ops.size ? 'post' : 'change'} ${noun} without logging in, and nothing limits spam or fake ${noun}. That's normal for things like sign-ups or reviews, but make sure it's what you want.` })
      }
      // SvelteKit: the page asks for login (its layout or load checks), but form actions run before any load function, so that check never
      // stops them. Say why, or the "You have to log in" on the page reads as if the form were safe too.
      const page = p.split('#')[0].replace(/\+page\.server\.[cm]?[jt]s$/, '+page.svelte')
      if (problems.length > before_ && page !== p.split('#')[0] && (B.files.get(page) as FileFacts & { layoutLogin?: boolean } | undefined)?.layoutLogin)
        problems.at(-1)!.text += ' The page asks for login, but its form actions run before that check, so they need their own (check locals.user in the action, or in hooks.server.ts).'
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
  // (an Angular component's template is part of that component's page)
  const templates = new Set([...after, ...before].flatMap(([q, t]) => [...t.matchAll(/templateUrl\s*:\s*['"`]([^'"`]+)['"`]/g)].map(m => join(q, '..', m[1]))))
  for (const p of real) if (!p.includes('#') && !CODE.test(p) && !templates.has(p) && !/(^|\/)(package\.json|\.env\.example|schema\.prisma|\.gitignore|requirements[\w-]*\.txt|pyproject\.toml)$|prisma\/migrations\/|supabase\/migrations\/|\/meta\/(_journal|\d+_snapshot)\.json$/.test(p) && !B.dzMigrations.includes(p) && !A.dzMigrations.includes(p) && !B.goMigrations.includes(p) && !A.goMigrations.includes(p) && !/(^|\/)go\.sum$|\.down\.sql$/.test(p))
  {
    const media = (t = '') => new Set(t.match(/@media[^{]*max-width[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) ?? [])
    const phones = /\.(css|scss)$/.test(p) && [...media(after.get(p))].some(m => !media(before.get(p)).has(m))
    changes.push({ group: 'Other files', isNew: !before.has(p), text: phones ? `The agent changed how the app looks on small screens like phones (in ${p}).`
      : `The agent ${!before.has(p) ? 'added' : !after.has(p) ? 'deleted' : 'changed'} ${p}${/\.md$/i.test(p) ? ', a notes file (not code)' : ''}.` })
  }

  // database
  // Laravel and Rails renames (Schema::rename / renameColumn, rename_table / rename_column) keep the data: say renamed, not deleted
  const renameOps = [...B.phpMigrations.filter(m => !A.phpMigrations.includes(m)).flatMap(m => (B.files.get(m) as PhpFacts | undefined)?.php.schema ?? []),
    ...B.rbMigrations.filter(m => !A.rbMigrations.includes(m)).flatMap(m => (B.files.get(m) as RbFacts | undefined)?.rb.schema ?? [])]
  const renamedTo = new Map(renameOps.filter(x => x.op === 'rename' && x.to).map(x => [modelOf(x.table), modelOf(x.to!)]))
  const colRenamed = new Map(renameOps.flatMap(x => x.renames.map(([a, b]) => [`${modelOf(x.table)}.${a}`, b] as const)))
  for (const [from, to] of renamedTo) if (A.models.has(from) && B.models.has(to)) {
    changes.push({ group: 'Database', text: `${cap(things(from))} are renamed to ${things(to)} in the database. The data stays, but code that still uses the old name will break.` })
    ship.push(`Check that nothing still uses the old table name (${things(from)}) before you apply the migration that renames it.`)
  }
  for (const [m, fields] of B.models) {
    const old = A.models.get(m) ?? A.models.get([...renamedTo].find(([, t]) => t === m)?.[0] ?? ''), links = (fs: string[]) => fs.filter(f => f.startsWith('→')).map(f => f.slice(1))
    if (!old) {
      const l = links(fields)
      const one = l.filter(x => !x.endsWith('[]')).map(x => an(words(x))), many = l.filter(x => x.endsWith('[]')).map(x => things(x.slice(0, -2)))
      const rels = [one.length ? `belongs to ${list(one)}` : '', many.length ? `can have many ${list(many)}` : ''].filter(Boolean)
      changes.push({ group: 'Database', isNew: true, name: things(m), text: `Your database now stores ${things(m)}${fieldList(fields) ? `: ${fieldList(fields)}` : ''}.${rels.length ? ` Each one ${list(rels)}.` : ''}${ownOnly(B.db, m) && !findings(B.db, new Set(), things).some(x => new RegExp(`\\b${things(m)}\\b`).test(x.text)) ? ' Each person can only see their own ✓' : ''}` })
      continue
    }
    const moved = old.filter(x => !fields.includes(x) && fields.includes(colRenamed.get(`${m}.${x}`) ?? ''))
    for (const x of moved) changes.push({ group: 'Database', text: `The ${fieldName(x) || x} on ${things(m)} is renamed to ${fieldName(colRenamed.get(`${m}.${x}`)!) || colRenamed.get(`${m}.${x}`)} (the data stays).` })
    const add = fields.filter(x => !old.includes(x) && !moved.some(y => colRenamed.get(`${m}.${y}`) === x)), del = old.filter(x => !fields.includes(x) && !moved.includes(x))
    if (fieldList(add)) changes.push({ group: 'Database', name: things(m), text: `${cap(things(m))} now also store the ${fieldList(add)}.` })
    if (links(add).length) changes.push({ group: 'Database', text: `${cap(things(m))} are now linked to ${list(links(add).map(x => things(x.replace('[]', ''))))}.` })
    if (del.length && B.goGorm?.has(m)) changes.push({ group: 'Database', text: `${cap(things(m))} no longer use the ${fieldList(del) || list(del)}. (AutoMigrate leaves that column and its data in the database.)` })
    else if (del.length) {
      changes.push({ group: 'Database', text: `${cap(things(m))} will no longer store the ${fieldList(del) || list(del)}.` })
      ship.push(`Back up your data first: the ${fieldList(del) || list(del)} on ${things(m)} will be deleted for good.`)
    }
  }
  for (const m of A.models.keys()) if (!B.models.has(m) && !(renamedTo.has(m) && B.models.has(renamedTo.get(m)!)) && !A.goGorm?.has(m)) {
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
  // (SQLite can't alter a table in place: Prisma rebuilds it as new_X, copies every row, drops X and renames new_X back. Nothing is lost.)
  const rebuilt = (sql: string) => sql.replace(/DROP TABLE\s+["`]?(\w+)["`]?;?/gi, (m, t: string) => new RegExp(`INSERT INTO\\s+["\`]?(?:__)?new_${t}(?!\\w)["\`]?[\\s\\S]*RENAME TO\\s+["\`]?${t}(?!\\w)`, 'i').test(sql) ? '' : m)   // drizzle-kit: __new_x
  for (const m of newMigrations) if (/\bDROP\b/i.test(rebuilt(after.get(m) ?? ''))) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`)
  if (newMigrations.length) ship.push(`Apply ${list(newMigrations.map(m => m.replace(/\/migration\.sql$/, '')))} to your live database before the new code goes live (\`npx prisma migrate deploy\`), or the parts that use it will fail.`)
  // A new "no duplicates" rule (a unique index) on a table that already has rows fails to apply if the live data has duplicates
  for (const m of [...newMigrations, ...B.sqlMigrations.filter(m => !A.sqlMigrations.includes(m)), ...B.dzMigrations.filter(m => !A.dzMigrations.includes(m)), ...B.flyway.filter(m => !A.flyway.includes(m))]) {
    // (only on columns that already had data: a new column starts empty; a partial index's condition must be about old columns too)
    // (CREATE UNIQUE INDEX [CONCURRENTLY] name ON [schema.]table [USING btree] (cols) [WHERE ...]; ALTER TABLE t ADD CONSTRAINT name UNIQUE (cols))
    const oldSql = [...before].filter(([p]) => /\.sql$/.test(p)).map(([, t]) => t).join('\n')
    const forms = [...(after.get(m) ?? '').matchAll(/CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s+ON\s+(?:["`]?\w+["`]?\.)?["`]?(\w+)["`]?\s*(?:USING\s+\w+\s*)?\(([^)]*)\)([^;]*)/gi)].map(x => [x[0], x[2], x[3], x[4], x[1]])
      .concat([...(after.get(m) ?? '').matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:["`]?\w+["`]?\.)?["`]?(\w+)["`]?\s+ADD\s+CONSTRAINT\s+["`]?(\w+)["`]?\s+UNIQUE\s*\(([^)]*)\)/gi)].map(x => [x[0], x[1], x[3], '', x[2]]))
    for (const x of forms) {
      // already there before (a rebuild re-creates it; it was @unique / .unique() already): no new rule
      if (new RegExp(`["\`]?${x[4]}["\`]?`).test(oldSql)) continue
      const model = [...A.models.keys()].find(k => [k.toLowerCase(), pluralize(k.toLowerCase())].includes(x[1].toLowerCase()) || things(k).replace(/ /g, '_') === x[1].toLowerCase())
      const cols = x[2].split(',').map(c => c.replace(/["`\s]|\b(ASC|DESC)\b/gi, '')), norm_ = (c: string) => camel(c).toLowerCase()
      // (a link column like tutor_id is stored as its link, →tutor)
      const had = (c: string) => !!model && A.models.get(model)!.some(f => norm_(f) === norm_(c) || f.startsWith('→') && singular(f.slice(1)).toLowerCase() === norm_(c).replace(/id$/, ''))
      // a partial index (WHERE ...) counts only when its condition is about columns that already had data
      const where = (x[3].match(/\bWHERE\b([\s\S]*)/i)?.[1] ?? '').replace(/'[^']*'/g, '').match(/[A-Za-z_]\w*/g)?.filter(w => !/^(and|or|not|in|is|null|true|false|like)$/i.test(w)) ?? []
      if (model && cols.every(had) && where.every(had))
        ship.push(`Check your live data before applying ${m}: it adds a rule that no two ${things(model)} can share the same ${list(cols.map(c => fieldName(c) || words(camel(c).replace(/Id$/, ''))))}. If any already do, the update fails.`)
    }
  }
  // Entity Framework: a new migration (Migrations/20261028_AddCoupons.cs) runs with `dotnet ef database update`; what its Up() drops is gone
  const newEf = B.efMigrations.filter(m => !A.efMigrations.includes(m))
  // Up()'s body, comments out (Down() only runs on a rollback, and may come first)
  const efUp = (t: string) => { const u = t.replace(/@"(?:[^"]|"")*"|"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, x => x[0] === '/' ? '' : x), i = u.search(/\bvoid\s+Up\s*\(/); if (i < 0) return ''; const j = u.slice(i).search(/\bvoid\s+Down\s*\(/); return j < 0 ? u.slice(i) : u.slice(i, i + j) }
  const efName = (m: string) => m.split('/').pop()!.replace(/\.cs$/, '')
  const designerOf = (m: string) => after.get(m.replace(/\.cs$/, '.Designer.cs')) ?? ''
  // EF finds a migration through its [DbContext(typeof(...))] and [Migration("...")] attributes, normally in the .Designer.cs: without them, it never runs
  const attr = (name: string, t: string) => new RegExp(`[\\[,]\\s*(?:[\\w.]+\\.)?${name}(?:Attribute)?\\s*\\(`).test(t)   // [A, B(...)] lists too
  const found = (m: string) => attr('Migration', (after.get(m) ?? '') + designerOf(m)) && attr('DbContext', (after.get(m) ?? '') + designerOf(m))
  for (const m of newEf) if (!after.has(m.replace(/\.cs$/, '.Designer.cs')) && !found(m))   // (the attributes can sit in the file itself)
    problems.push({ kind: 'Broken', text: `${m} has no ${efName(m)}.Designer.cs next to it, which is how Entity Framework finds a migration: it will never run, and the code that needs its changes will fail. Re-create it with \`dotnet ef migrations add\`.` })
  // an app that calls Database.Migrate() at startup applies new migrations itself
  const selfMigrates = [...after].some(([p, t]) => p.endsWith('.cs') && /\.Database\.Migrate(Async)?\s*\(/.test(t))
  // SQLite can't alter a table in place: EF rebuilds it from the migration's target model (BuildTargetModel, normally in the
  // .Designer.cs), and when that model doesn't have the table these operations throw NotSupportedException (EF Core
  // SqliteMigrationsSqlGenerator; reproduced on EF Core 8). Only for an app on SQLite alone (tests aside), and only for migrations EF finds.
  const appCs = [...after].filter(([p]) => p.endsWith('.cs') && !/(^|\/)[\w.]*Tests?(\/|\.)/.test(p)).map(([, t]) => t)
  const sqliteOnly = appCs.some(t => /\.(UseSqlite\s*\(|AddSqlite\s*<)/.test(t))
    && !appCs.some(t => /\.(Use(SqlServer|Npgsql|MySql|MySQL|Oracle|Cosmos|AzureSql|AzureSynapse)\s*\(|Add(SqlServer|Npgsql|MySql|Oracle|Cosmos)(DbContext)?\s*<)/.test(t))
  const crashes = new Set<string>()
  for (const m of newEf) {
    const text = after.get(m) ?? '', model = text + designerOf(m)
    if (!sqliteOnly || !found(m)) continue
    const up = efUp(text)
    const created = [...up.matchAll(/CreateTable\s*\(\s*name:\s*"(\w+)"/g)].map(x => x[1])
    const ops = [...up.matchAll(/\.(AddCheckConstraint|DropCheckConstraint|AddUniqueConstraint|DropUniqueConstraint|AddPrimaryKey|DropPrimaryKey|DropForeignKey|AlterColumn|DropColumn|RenameIndex|AddForeignKey)\s*(?:<[^>]*>)?\s*\(([^;]*)/g)]
      .map(x => ({ op: x[1], table: x[2].match(/table:\s*"(\w+)"/)?.[1] ?? '' }))
      .filter(x => x.op !== 'AddForeignKey' || !created.includes(x.table))   // merged into the CreateTable
      .filter(x => !/BuildTargetModel/.test(model) || !(x.table && new RegExp(`ToTable\\(\\s*"${x.table}"`).test(model)))   // the model has the table: EF rebuilds it
    if (!ops.length) continue
    crashes.add(m)
    const tables = [...new Set(ops.map(x => x.table).filter(Boolean))], old = tables.filter(t => !created.includes(t))
    problems.push({ kind: 'Broken', text: `${efName(m)} will fail on your SQLite database: it changes ${tables.length ? `the ${old.length === tables.length ? 'existing ' : ''}${list(tables)} table${tables.length > 1 ? 's' : ''}` : 'a table'} in a way SQLite only allows for a migration made with \`dotnet ef migrations add\` (it needs the description of the tables that command writes in ${efName(m)}.Designer.cs).${selfMigrates ? " The app applies migrations when it starts, so it won't start." : ''} Ask the agent to re-create it with \`dotnet ef migrations add\`.` })
  }
  for (const m of newEf.filter(m => !crashes.has(m))) {   // a crashing one changes nothing
    const up = efUp(after.get(m) ?? '')
    if (/\.(DropTable|DropColumn)\s*\(/.test(up)) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`)
    // CreateIndex(..., table: "Orders", column: "Email", unique: true) on a table with rows and a column that already had data
    for (const x of up.matchAll(/CreateIndex\s*\(([^;]*?unique:\s*true[^;]*)\)/g)) {
      const table = x[1].match(/table:\s*"(\w+)"/)?.[1], col = x[1].match(/column:\s*"(\w+)"/)?.[1], model = [...A.models.keys()].find(k => [k.toLowerCase(), pluralize(k.toLowerCase())].includes((table ?? '').toLowerCase()))
      if (model && col && A.models.get(model)!.some(f => f.toLowerCase() === col.toLowerCase())) ship.push(`Check your live data before applying ${m}: it adds a rule that no two ${things(model)} can share the same ${fieldName(col) || words(col)}. If any already do, the update fails.`)
    }
  }
  const toApply = newEf.filter(m => !crashes.has(m)).map(efName)
  if (toApply.length) ship.push(selfMigrates
    ? `${list(toApply)} will change your live database by itself the next time the app starts (it calls Database.Migrate). Back up first; if it fails, the app won't start.`
    : `Apply ${list(toApply)} to your live database before the new code goes live (\`dotnet ef database update\`), or the parts that use it will fail.`)
  if ([...B.csModels, ...A.csModels].some(m => JSON.stringify(A.models.get(m)) !== JSON.stringify(B.models.get(m))) && !newEf.length)
    ship.push('Update your database: run `dotnet ef migrations add <Name>`, then `dotnet ef database update` (also on your live site). The tables changed, but no migration was created.')
  // appsettings.json is in the code: a real key or password written there is visible to anyone who can see the project
  // (provider keys in any appsettings file, Development included: it's committed too; a password or signing key only outside Development,
  // and not for a local database or a placeholder)
  for (const p of real.filter(p => /(^|\/)appsettings(\.\w+)?\.json$/.test(p))) {
    const t = after.get(p) ?? '', was = before.get(p) ?? '', dev = /\.Development\.json$/.test(p)
    const secret = (x: string) => x.match(/"(sk_live_\w{8,}|sk_test_\w{8,}|rk_live_\w{8,}|whsec_\w{8,}|re_\w{16,}|SG\.[\w-]{16,}\.[\w-]{16,})"/)?.[0]
      ?? (dev ? undefined : [...x.matchAll(/"[^"]*"\s*:\s*"([^"]*)"/g)].map(m => m[1]).find(v => /(?:Password|Pwd)\s*=\s*(?!\s*[;<{])[^;"]{4,}/i.test(v) && !/localhost|\(localdb\)|127\.0\.0\.1|host\.docker\.internal/i.test(v))
        ?? x.match(/"(?:Jwt|Token|Signing)\w*"\s*:\s*\{[^}]*"(?:Key|Secret|SigningKey)"\s*:\s*"(?![<{]|your|change|replace|placeholder)([^"]{24,})"/i)?.[1])
    if (secret(t) && !secret(was)) problems.push({ kind: 'Unsafe', text: `A secret key or password is written in ${p}. Anyone who can see the code can use it. Move it to an environment variable (or \`dotnet user-secrets\` while developing).` })
  }
  for (const p of real) if ((B.files.get(p) as CsFacts | undefined)?.cs?.risks.has('cors') && !(A.files.get(p) as CsFacts | undefined)?.cs?.risks.has('cors'))
    problems.push({ kind: 'Check', text: `Any website can call your server from a visitor's browser (CORS allows all sites). Fine for a public API, not for one that uses logins. (in ${p})` })
  // Flyway (Spring Boot): a new V2__x.sql runs by itself the next time the app starts; if it fails, the app doesn't start
  const newFlyway = B.flyway.filter(m => !A.flyway.includes(m))
  for (const m of newFlyway) if (/\bDROP\b/i.test(rebuilt(after.get(m) ?? ''))) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`)
  if (newFlyway.length && Object.keys(B.deps).some(d => /^flyway-/.test(d))) ship.push(`${list(newFlyway.map(m => m.split('/').pop()!))} will change your live database by itself the next time the app starts (Flyway). Back up first; if it fails, the app won't start.`)
  // JPA: ddl-auto=create / create-drop rebuilds every table, empty, each time the app starts (fine in tests, a wipe on a live site)
  for (const p of real.filter(p => /(^|\/)src\/main\/resources\/application\.(properties|ya?ml)$/.test(p))) {
    const wipes = (t = '') => /ddl-auto\s*[=:]\s*["']?create(-drop)?\b/.test(t)
    if (wipes(after.get(p)) && !wipes(before.get(p))) problems.push({ kind: 'Unsafe', text: `${p} sets ddl-auto to "create": every time the app starts, it deletes all your tables' data and starts empty. Use "validate" or "none" (with Flyway) on your live site.` })
    const secret = (x = '') => x.match(/(sk_live_\w{8,}|sk_test_\w{8,}|whsec_\w{8,}|re_\w{16,}|SG\.[\w-]{16,}\.[\w-]{16,})/)?.[0]
      ?? x.match(/(sk-proj-[\w-]{16,}|sk-ant-[\w-]{16,})/)?.[0]
      ?? x.match(/^\s*[\w.-]*(password|secret|api[-_]?key|token|private[-_]?key)[\w-]*\s*[=:]\s*(?!\$\{|["']?\s*$|["']?<|["']?(changeme|password|secret|root|postgres|sa)\b)([^\s#]{6,})/im)?.[3]
    if (secret(after.get(p)) && !secret(before.get(p))) problems.push({ kind: 'Unsafe', text: `A secret key or password is written in ${p}. Anyone who can see the code can use it. Put \${ENV_VAR} there and set the variable on your host.` })
  }
  for (const p of real) if ((B.files.get(p) as JavaFacts | undefined)?.java?.risks.has('cors') && !(A.files.get(p) as JavaFacts | undefined)?.java?.risks.has('cors'))
    problems.push({ kind: 'Check', text: `Any website can call your server from a visitor's browser (CORS allows all sites). Fine for a public API, not for one that uses logins. (in ${p})` })
  // Laravel: new migrations run with `php artisan migrate --force` (without --force it does nothing on a live site); what they drop is
  // listed above, from the tables they build. Said here: a raw DELETE / DROP, and a table dropped and created again (emptied).
  const newPhp = B.phpMigrations.filter(m => !A.phpMigrations.includes(m))
  for (const m of newPhp) { const ops = (B.files.get(m) as PhpFacts | undefined)?.php.schema ?? []
    const emptied = ops.filter(x => x.op === 'drop' && ops.some(y => y.op === 'create' && y.table === x.table) && A.models.has(modelOf(x.table))).map(x => things(modelOf(x.table)))
    if (emptied.length) ship.push(`Back up your data first: ${m} deletes all ${list(emptied)} (it drops the table and creates it again, empty).`)
    else if (ops.some(x => x.loses && !x.table)) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`) }
  // (one that only adds indexes just makes lookups faster: nothing breaks if it runs later)
  const phpName = (m: string) => m.split('/').pop()!.replace(/\.php$/, ''), phpOps = (m: string) => (B.files.get(m) as PhpFacts | undefined)?.php.schema ?? []
  const phpSpeed = newPhp.filter(m => phpOps(m).length > 0 && phpOps(m).every(x => x.indexOnly)), phpNeeded = newPhp.filter(m => !phpSpeed.includes(m))
  if (phpNeeded.length) ship.push(`Apply ${list(phpNeeded.map(phpName))} to your live database before the new code goes live (\`php artisan migrate --force\`), or the parts that use it will fail.`)
  if (phpSpeed.length) ship.push(`Apply ${list(phpSpeed.map(phpName))} to your live database too (\`php artisan migrate --force\`). It only makes lookups faster, so nothing breaks if it runs later.`)
  const PHP_RISK: Record<string, Problem> = {
    mass: { kind: 'Unsafe', text: 'Saves whatever the visitor sends ($request->all()) into the database, and the model accepts every field. A visitor could set fields like is_admin, price or user_id. Use $request->validated(), or list the allowed fields in $fillable.' },
    force: { kind: 'Unsafe', text: 'Saves whatever the visitor sends ($request->all()) with forceFill / forceCreate, which skips the list of allowed fields. A visitor could set fields like is_admin, price or user_id. Use $request->validated().' },
  }
  const phpX = (X: typeof A, p: string) => (X.files.get(p) as PhpFacts | undefined)?.php
  // mass assignment depends on the model too (made to accept every field in another file): every file, not only the changed ones
  for (const [p] of B.files) if (phpX(B, p)?.risks.has('mass') && !phpX(A, p)?.risks.has('mass') && !real.includes(p)) problems.push({ ...PHP_RISK.mass, text: `${PHP_RISK.mass.text} (in ${p})` })
  for (const p of real) {
    const x = phpX(B, p), was = phpX(A, p)
    if (!x || /(^|\/)tests\//.test(p)) continue
    for (const r of x.risks) if (!was?.risks.has(r)) {
      if (r.startsWith('all:') || r === 'unguard') continue
      if (PHP_RISK[r]) problems.push({ ...PHP_RISK[r], text: `${PHP_RISK[r].text} (in ${p})` })
      else if (RISK[r]) problems.push({ ...RISK[r], text: `${RISK[r].text} (in ${p})` })
      else if (r.startsWith('env:')) problems.push({ kind: 'Check', text: `${p} reads ${r.slice(4)} with env() outside the config folder. Once your live site caches its settings (\`php artisan config:cache\` or \`optimize\`, which Laravel deploys usually run), that gives nothing. Read it in a config file (like config/services.php) and use config(...) here.` })
      else if (r.startsWith('ctor:')) problems.push({ kind: 'Broken', text: `${r.slice(5)} calls $this->middleware() in its constructor, which Laravel 11 and later controllers don't have: every address it handles will crash. Use the HasMiddleware interface, or ->middleware(...) on the routes.` })
      else if (r.startsWith('authz:')) problems.push({ kind: 'Broken', text: `${r.slice(6)} calls $this->authorize(), which Laravel 11 and later controllers don't have (it needs the AuthorizesRequests trait): those addresses will crash. Use Gate::authorize(...) instead.` })
    }
    // forgery protection switched off for addresses that aren't payment or webhook callbacks ('*': for all of them)
    const off = x.csrf.filter(e => !/stripe|webhook|hook|paddle|paypal|callback|ipn|twilio|mailgun|postmark|resend|lemon/i.test(e) && !was?.csrf.includes(e))
    if (off.includes('*')) problems.push({ kind: 'Unsafe', text: `Forgery protection is turned off for the whole site. Other sites could send your forms (change settings, place orders) for a logged-in visitor. (in ${p})` })
    else if (off.length) problems.push({ kind: 'Check', text: `${list(off.map(e => `"${e}"`))} ${off.length > 1 ? 'are' : 'is'} excluded from forgery protection. Other sites could send those forms for a logged-in visitor. (in ${p})` })
    // a real key written in a PHP file (config/services.php 'secret' => 'sk_live_...') is visible to anyone who can see the code
    const secret = (t = '') => t.match(/['"](sk_live_\w{8,}|sk_test_\w{8,}|rk_live_\w{8,}|whsec_\w{8,}|re_\w{16,}|SG\.[\w-]{16,}\.[\w-]{16,}|sk-proj-[\w-]{16,}|sk-ant-[\w-]{16,}|base64:[A-Za-z0-9+/]{40,}={0,2})['"]/)?.[1]
    if (secret(after.get(p)) && !secret(before.get(p))) problems.push({ kind: 'Unsafe', text: `A secret key is written in ${p}. Anyone who can see the code can use it. Put it in .env and read it with env() in a config file.` })
  }
  // Rails: new migrations run with `bin/rails db:migrate`; apps made by `rails new` (7.1+) for Docker / Kamal run it by themselves when
  // they start (bin/docker-entrypoint runs db:prepare, which applies pending migrations), like a Procfile `release:` line on Heroku
  const newRb = B.rbMigrations.filter(m => !A.rbMigrations.includes(m)), rbOps = (m: string) => (B.files.get(m) as RbFacts | undefined)?.rb.schema ?? []
  const rbName = (m: string) => m.split('/').pop()!.replace(/\.rb$/, '')
  const entry = [...after].some(([p, t]) => /(^|\/)bin\/docker-entrypoint$/.test(p) && /db:(prepare|migrate)/.test(t))
  const release = [...after].some(([p, t]) => /(^|\/)Procfile$/.test(p) && /^release:.*db:(migrate|prepare)/m.test(t))
  const paas = [...after].some(([p, t]) => /(^|\/)Procfile$/.test(p) && !/^release:/m.test(t) || /(^|\/)(render\.yaml|app\.json)$/.test(p))
  const kamal = [...after].some(([p, t]) => /(^|\/)config\/deploy\.yml$/.test(p) && !/192\.168\.0\.1/.test(t.replace(/^\s*#[^\n]*/gm, '')))   // (the template's placeholder, outside its comments)
  const rbSelf = release || entry && kamal && !paas
  for (const m of newRb) {
    const emptied = rbOps(m).filter(x => x.op === 'drop' && rbOps(m).some(y => y.op === 'create' && y.table === x.table) && A.models.has(rbModelOf(x.table))).map(x => things(rbModelOf(x.table)))
    if (emptied.length) ship.push(`Back up your data first: ${m} deletes all ${list(emptied)} (it drops the table and creates it again, empty).`)
    else if (rbOps(m).some(x => x.loses && (!x.table || !x.drop.length && x.op === 'table'))) ship.push(`Back up your data first: ${m} deletes or rewrites data, and that can't be undone.`)
  }
  const rbSpeed = newRb.filter(m => rbOps(m).length > 0 && rbOps(m).every(x => x.indexOnly)), rbNeeded = newRb.filter(m => !rbSpeed.includes(m))
  if (newRb.length && rbSelf) ship.push(release
    ? `${list(newRb.map(rbName))} will change your live database by itself when you deploy (the Procfile's release step runs it). Back up first; if it fails, the deploy stops and the old version keeps running.`
    : `${list(newRb.map(rbName))} will change your live database by itself the next time the app starts (bin/docker-entrypoint runs db:prepare). Back up first; if it fails, the app won't start.`)
  else {
    if (rbNeeded.length) ship.push(`Apply ${list(rbNeeded.map(rbName))} to your live database before the new code goes live (\`bin/rails db:migrate\`), or the parts that use it will fail.${entry && !paas ? " (If you deploy with Docker the way `rails new` sets it up, the app does this by itself when it starts: back up first.)" : ''}`)
    if (rbSpeed.length) ship.push(`Apply ${list(rbSpeed.map(rbName))} to your live database too (\`bin/rails db:migrate\`). It only changes indexes (they make lookups faster), so nothing breaks if it runs later.`)
  }
  for (const p of real) {
    const x = (B.files.get(p) as RbFacts | undefined)?.rb, was = (A.files.get(p) as RbFacts | undefined)?.rb
    if (!x || /(^|\/)(test|spec)\//.test(p)) continue
    for (const r of x.risks) if (!was?.risks.has(r)) {
      if (r === 'mass') problems.push({ kind: 'Unsafe', text: `Saves whatever the visitor sends (params.permit!, or a field that accepts anything) into the database. A visitor could set fields like admin, price or user_id. List the allowed fields in permit / expect instead. (in ${p})` })
      else if (r === 'csrfAll') problems.push({ kind: 'Unsafe', text: `Forgery protection is turned off for the whole site. Other sites could send your forms (change settings, place orders) for a logged-in visitor. (in ${p})` })
      else if (r === 'corsCreds') problems.push({ kind: 'Unsafe', text: `Any website can make requests to your server as a logged-in visitor (CORS lets every site in, with cookies). List your own site's address in origins instead. (in ${p})` })
      else if (r === 'massField') problems.push({ kind: 'Check', text: `A form here lets the visitor set the role or admin field (permit / expect). Unless only admins use it, anyone could make themselves an admin. (in ${p})` })
      else if (r === 'basicPassword') problems.push({ kind: 'Unsafe', text: `A password is written in ${p} (http_basic_authenticate_with). Anyone who can see the code can log in. Read it from credentials or an environment variable.` })
      else if (RISK[r]) problems.push({ ...RISK[r], text: `${RISK[r].text} (in ${p})` })
    }
    // forgery protection switched off for actions that aren't payment or webhook callbacks
    for (const [c, k] of x.classes) { const before_ = was?.classes.get(c)?.csrfOff ?? []
      const off = k.csrfOff.filter(a => !before_.includes(a)).filter(a => !/webhook|stripe|hook|callback|ipn|paddle|paypal/i.test(`${c} ${a}`))
      if (off.length) problems.push({ kind: off.includes('*') ? 'Unsafe' : 'Check', text: `${off.includes('*') ? `Forgery protection is off for all of ${c}` : `${list(off.map(a => `${c}#${a}`))} ${off.length > 1 ? 'are' : 'is'} excluded from forgery protection`}. Other sites could send those forms for a logged-in visitor. (in ${p})` }) }
  }
  // the key that unlocks Rails credentials, committed
  for (const p of real.filter(p => /(^|\/)config\/(master|credentials\/\w+)\.key$/.test(p) && after.has(p) && !before.has(p)))
    problems.push({ kind: 'Unsafe', text: `${p} is in the code. It unlocks all your Rails credentials (Stripe keys and the rest): anyone who can see the code can read them. Remove it from the repository, add it to .gitignore, and set RAILS_MASTER_KEY on your host instead.` })
  // Go: new migrations (golang-migrate / goose); main() may run them by itself (m.Up(), goose.Up, AutoMigrate)
  const newGo = B.goMigrations.filter(m => !A.goMigrations.includes(m))
  const goSelf = [...B.files].some(([p, f]) => !p.endsWith('_test.go') && (f as GoFacts).go?.selfMigrates)
  for (const m of newGo) { const bad = (B.goDb?.destructive.get(m) ?? []).filter(x => !/^deletes the \S+ (column|table)/.test(x)); if (bad.length) ship.push(`Back up your data first: ${m} ${list(bad)}, and that can't be undone.`) }
  if (newGo.length) ship.push(goSelf
    ? `${list(newGo.map(m => m.split('/').pop()!))} will change your live database by itself the next time the app starts (main runs the migrations). Back up first; if it fails, the app won't start.`
    : `Apply ${list(newGo.map(m => m.split('/').pop()!))} to your live database before the new code goes live (${newGo.some(m => /\+goose/.test(after.get(m) ?? '')) ? '`goose up`' : '`migrate -path <folder> -database $DATABASE_URL up`'}), or the parts that use it will fail.`)
  if (B.goOld && !A.goOld) problems.push({ kind: 'Broken', text: `Your go.mod says go ${B.goOld}, but the routes are written the Go 1.22 way ("POST /orders/{id}"). Before 1.22 those are read as plain paths, so they never match. Change the go line in go.mod to 1.22 or later.` })
  for (const p of real) {
    const x = (B.files.get(p) as GoFacts | undefined)?.go, was = (A.files.get(p) as GoFacts | undefined)?.go
    if (!x || p.endsWith('_test.go')) continue
    for (const r of x.risks) if (!was?.risks.has(r)) {
      if (r === 'corsCreds') problems.push({ kind: 'Unsafe', text: `Any website can make requests to your server as a logged-in visitor (CORS lets every site in, with cookies). List your own site's address instead. (in ${p})` })
      else if (RISK[r]) problems.push({ ...RISK[r], text: `${RISK[r].text} (in ${p})` })
    }
    const goSecret = (t = '') => t.match(/"(sk_live_\w{8,}|sk_test_\w{8,}|rk_live_\w{8,}|whsec_\w{8,}|re_\w{16,}|SG\.[\w-]{16,}\.[\w-]{16,})"/)?.[1]
    if (goSecret(after.get(p)) && !goSecret(before.get(p))) problems.push({ kind: 'Unsafe', text: `A secret key is written in ${p}. Anyone who can see the code can use it. Read it from an environment variable (os.Getenv) instead.` })
    // a login check that answers 401 but doesn't stop: the request goes on to the handler
    for (const [k, f] of x.funcs) for (const t of new Set(f.traps)) if (!was?.funcs.get(k)?.traps.includes(t) && (!k.startsWith('@lit') || f.inUse) && !(k.startsWith('@lit') && [...was?.funcs.values() ?? []].some(o => o.inUse && o.traps.includes(t))))
      problems.push({ kind: 'Broken', text: `${k.startsWith('@lit') ? 'A middleware' : k} answers "not allowed" but doesn't stop the request, so the protected code runs anyway. ${t === 'ginNoAbort' ? 'Use c.AbortWithStatusJSON(...) (or call c.Abort())' : 'Add `return` right after it'}. (in ${p})` })
  }
  // Drizzle: a changed schema needs a migration (or `drizzle-kit push` for apps that don't keep migration files)
  const newDz = B.dzMigrations.filter(m => !A.dzMigrations.includes(m))
  if ([...B.dzModels, ...A.dzModels].some(m => JSON.stringify(A.models.get(m)) !== JSON.stringify(B.models.get(m))) && !newDz.length)
    ship.push(B.dzMigrations.length ? 'Update your database: run `npx drizzle-kit generate`, then `npx drizzle-kit migrate` (also on your live site). The tables changed, but no migration was created.'
      : 'Update your database: run `npx drizzle-kit push` (also against your live database). The tables changed, and until then the parts that use them will fail.')
  for (const m of newDz) {
    if (/\bDROP\b/i.test(rebuilt(after.get(m) ?? ''))) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`)
    ship.push(`Apply ${m} to your live database before the new code goes live (\`npx drizzle-kit migrate\`), or the parts that use it will fail.`)
  }
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
  // A page that asks for login but gets its data from a server that isn't in this project (an Angular or React app on its own):
  // its guard only hides the page; the data is safe only if that server checks login too, and plain can't see it.
  const outsideCalls = real.filter(p => route(p)?.kind === 'page' && B.files.get(p)?.auth).flatMap(p => [...B.files.get(p)!.fetches].map(x => x.slice(x.indexOf(' ') + 1))).filter(u => u.startsWith('/') && !endpoint(u))
  // (a server plain can't read yet, in this repo: NestJS, .NET, Java, Go, PHP, Ruby)
  const unread = '@nestjs/core' in B.deps || [...after.keys()].some(p => /\.(cs|java|kt|go|php|rb)$/.test(p))
  const where = [...new Set(outsideCalls.map(u => u.split('/').slice(0, 3).join('/').replace(/\/\[…\]$/, '')))].slice(0, 3)
  if (outsideCalls.length && ![...B.routes.values()].some(r => r.kind === 'endpoint'))
    notes.push(`A page's login check only hides the page. Its data comes from ${list(where)} on ${unread ? "a server plain can't read yet" : "a server that isn't in this project"}, so plain can't check that the server asks for login too. Make sure it does.`)

  for (const p of real) for (const r of (B.files.get(p) as PyFacts | undefined)?.risks ?? [])
    if (!(A.files.get(p) as PyFacts | undefined)?.risks?.has(r)) problems.push({ ...RISK[r], text: `${RISK[r].text} (in ${p})` })
  const newPyMigrations = B.pyMigrations.filter(m => !A.pyMigrations.includes(m))
  if ([...B.pyModels, ...A.pyModels].some(m => JSON.stringify(A.models.get(m)) !== JSON.stringify(B.models.get(m))) && !newPyMigrations.length) {
    // (Flask-Migrate's commands only when the app has it: not in a FastAPI app)
    const fm = Object.keys(B.deps).some(k => /^flask[-_]migrate$/i.test(k))
    ship.push('django' in B.deps
      ? 'Update your database: run `python manage.py makemigrations`, then `python manage.py migrate` (also on your live site). The models changed, but no migration was created.'
      : (fm ? 'Update your database: create a migration (`alembic revision --autogenerate`, or `flask db migrate` with Flask-Migrate) and apply it (`alembic upgrade head` / `flask db upgrade`), also on your live site.' : 'Update your database: create a migration (`alembic revision --autogenerate`) and apply it (`alembic upgrade head`), also on your live site.') + ' The models changed, but no migration was created.')
  }
  // a migration the new code depends on: until it runs on the live database, those parts fail
  // one that only adds an index just speeds things up: nothing breaks if it runs late
  const indexOnly = (m: string) => { const up = (after.get(m) ?? '').split(/def downgrade/)[0], ops = [...up.matchAll(/migrations\.(\w+)\(|\b(?:op|batch_op)\.(\w+)\(/g)].map(x => x[1] ?? x[2]).filter(o => !/^(f|batch_alter_table)$/.test(o))
    return ops.length > 0 && ops.every(o => /^(AddIndex|RemoveIndex|RenameIndex|create_index|drop_index)$/.test(o)) }
  const cmd = 'django' in B.deps ? '`python manage.py migrate`' : Object.keys(B.deps).some(k => /^flask[-_]migrate$/i.test(k)) ? '`alembic upgrade head`, or `flask db upgrade` with Flask-Migrate' : '`alembic upgrade head`'
  const needed = newPyMigrations.filter(m => !indexOnly(m)), speed = newPyMigrations.filter(indexOnly)
  if (needed.length) ship.push(`Apply ${list(needed)} to your live database before the new code goes live (${cmd}), or the parts that use it will fail.`)
  if (speed.length) ship.push(`Apply ${list(speed)} to your live database too (${cmd}). It only makes lookups faster, so nothing breaks if it runs later.`)
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
  // Linked to the request through names this change adds: a file that adds isGuest or imageId, which a file of the request
  // (it names what was asked for, or it's a page or an address) adds too
  // (only names new to the whole app: not `error`, `async`, `data` or any word the app already had)
  const ids = (t = '') => new Set(t.match(/[A-Za-z_]\w{3,}/g) ?? [])
  const known = new Set([...before.values()].flatMap(t => [...ids(t)]))
  const added_ = (a?: string, b?: string) => { const was = ids(a); return [...ids(b)].filter(x => !was.has(x) && !known.has(x) && !/^(async|await|const|function|return|export|import|static|class|self|this|true|false|null|None|True|False|error|data|value|result|items?)$/.test(x)) }
  const ownFiles = real.filter(p => !p.includes('#') && (route(p) || kw.some(k => (after.get(p) ?? '').toLowerCase().includes(k))))
  const askedIds = new Set(ownFiles.flatMap(p => added_(before.get(p), after.get(p))))
  const linked = (a?: string, b?: string) => added_(a, b).some(x => askedIds.has(x))
  for (const p of real) {
    const a = A.files.get(p), b = B.files.get(p)
    if (kw.length && a && b && !route(p) && !kw.some(k => (after.get(p) ?? '').toLowerCase().includes(k))) {
      const fns = [...b.fns].filter(([n, s]) => a.fns.has(n) && a.fns.get(n) !== s).map(([n]) => n)
      // Part of the feature if it adds something new (ApiError) that the rest of this change uses.
      const added = [...b.exports].filter(x => !a.exports.has(x))
      const feature = added.some(x => [...B.files].some(([q, f]) => q !== p && real.includes(q) && (f.used.has(x) || f.jsx.has(x))))
      if (!fns.length && !feature && !linked(before.get(p), after.get(p))) problems.push({ kind: 'Unasked', text: `The agent also changed ${p}, which doesn't look related to what you asked for.` })
      for (const n of fns.filter(n => !added.some(x => new RegExp(`\\b${x}\\b`).test(b.fns.get(n) ?? '')) && !linked(a.fns.get(n), b.fns.get(n)))) {
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

  // A Stripe webhook that starts handling a new kind of event: Stripe only sends an endpoint the events picked for it, so until the
  // new one is added there the new code never runs. An event counts where the code handles it (=== 'x', case 'x', a 'x' => handler
  // key, C#'s EventTypes.X), in a file that checks Stripe's signature; one of Stripe's own event names (src/stripe-events.ts); new to
  // the app, not just to that file. Tests and scripts aside.
  const PASCAL = new Map([...STRIPE_EVENTS].map(e => [e.replace(/[._]/g, ''), e]))
  const handled = (t = '') => {
    const code = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\w])\/\/[^\n]*/g, '$1').replace(/(^|\s)#(?!\[)[^\n]*/g, '$1')
    return new Set([...[...code.matchAll(/(?:===?|\bcase|\bwhen|Equals\()\s*['"`]([a-z_.]+)['"`]|['"`]([a-z_.]+)['"`]\s*(?:===?|=>|:)/g)].map(m => m[1] ?? m[2]),
      ...[...code.matchAll(/\bEventTypes\.(\w+)/g)].map(m => PASCAL.get(m[1].toLowerCase()) ?? '')].filter(e => STRIPE_EVENTS.has(e)))
  }
  const verifies = (t = '') => /constructEvent|construct_event|ConstructEvent|parseEventNotification|parse_event_notification/.test(t)
  const hookFiles = (X: Snap) => [...X].filter(([p, t]) => CODE.test(p) && verifies(t) && !/(^|\/)(tests?|__tests__|spec|scripts|e2e|cypress)\/|\.(test|spec)\.\w+$|Tests?\.\w+$|(^|\/)test_\w+\.py$|_test\.py$/i.test(p))
  const hadEvents = new Set(hookFiles(before).flatMap(([, t]) => [...handled(t)]))
  const newEvents = [...new Set(hookFiles(after).flatMap(([, t]) => [...handled(t)]))].filter(e => !hadEvents.has(e))
  if (newEvents.length) ship.push(hookFiles(before).length
    ? `In Stripe (Workbench → Webhooks, your endpoint), make sure it receives ${list(newEvents)} (skip this if it's set to receive all events). Stripe only sends an endpoint the events picked for it, so until then the new code for ${newEvents.length > 1 ? 'them' : 'it'} never runs.`
    : `In Stripe (Workbench → Webhooks), create an endpoint for your webhook's address that receives ${list(newEvents)}. Until then Stripe sends it nothing.`)

  // env, packages, services
  const usedBefore = new Set([...A.files.values()].flatMap(f => [...f.env]))
  // .NET: a setting with a value in a committed appsettings.json (Jwt:Issuer -> Jwt__Issuer) needs nothing on the host
  const dotnet = [...after.keys()].some(p => /\.csproj$|(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/.test(p))   // .NET and Spring don't read .env files
  const csKeys = new Set<string>()
  const flatJson = (o: unknown, pre: string) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) typeof v === 'object' ? flatJson(v, `${pre}${k}__`) : v !== '' && v !== null && csKeys.add(`${pre}${k}`) }
  for (const [p, t] of after) if (/(^|\/)appsettings\.json$/.test(p)) try { flatJson(JSON.parse(t.replace(/^\uFEFF/, '').replace(/\/\/[^\n]*/g, '')), '') } catch { /* not JSON */ }
  const required = new Set([...B.files.values()].flatMap(f => [...f.envReq]))
  for (const k of new Set([...B.files.values()].flatMap(f => [...f.env]))) if (!usedBefore.has(k)) {
    // VITE_, NEXT_PUBLIC_, ... are copied into the code every visitor downloads.
    const pub = /^(VITE|NEXT_PUBLIC|REACT_APP|EXPO_PUBLIC|PUBLIC)_/.test(k) && !/PUBLISHABLE|ANON/.test(k)
    if (pub && /SECRET|SERVICE_ROLE|PRIVATE|PASSWORD/.test(k)) problems.push({ kind: 'Unsafe', text: `${k} is a secret, but its name makes it part of the code every visitor's browser downloads, so anyone can read it. Move it to server-only code and give it a name without the ${k.split('_')[0]}_ prefix.` })
    else if (pub && /API_KEY|TOKEN/.test(k)) problems.push({ kind: 'Check', text: `${k} is sent to every visitor's browser (because of its ${k.split('_')[0]}_ prefix). That's fine for keys meant to be public, but not for secret ones.` })
    // Edge functions read their secrets from Supabase, which provides SUPABASE_URL and its keys by itself.
    const edgeOnly = [...B.files].filter(([, f]) => f.env.has(k)).every(([p]) => /(^|\/)supabase\/functions\//.test(p.split('#')[0]))
    if (edgeOnly && /^SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)$/.test(k) || !required.has(k) || csKeys.has(k)) continue
    ship.push(edgeOnly ? `Add ${k} to your Supabase project's secrets (Edge Functions → Secrets, or \`supabase secrets set\`).`
      : `Add ${k} to your hosting settings${B.pyModels.size || B.csModels.size || [...after.keys()].some(p => /\.(cs|csproj|java|php|rb|go)$|(^|\/)(pom\.xml|build\.gradle)/.test(p)) || /^(django|flask|fastapi)$/m.test(Object.keys(B.deps).join('\n')) ? '' : ' (like Vercel)'}.${B.envExample.has(k) || dotnet ? '' : ' It\'s also missing from .env.example.'}`)
  }
  for (const [d, v] of Object.entries(B.deps)) {
    if (!(d in A.deps)) ship.push(`A new package was added: ${d} (${v}). Make sure you actually need it.`)
    else if (A.deps[d] !== v) ship.push(`Test anything that uses ${d}: it was upgraded from ${A.deps[d]} to ${v}.`)
  }
  const svcBefore = new Set([...A.files.values()].flatMap(f => [...f.services]))
  for (const s of new Set([...B.files.values()].flatMap(f => [...f.services]))) if (!svcBefore.has(s))
    changes.push({ group: 'Outside services', isNew: true, text: EMAIL.has(s)
      ? `Your app now sends emails${s === 'email' ? '' : ` through ${s}`}. People's email addresses are shared with ${s === 'email' ? 'the email provider' : s}.`
        : AI.has(s) ? `Your app now uses ${s}. What people write in it can be sent to ${s}, and each request costs you money.` : `Your app now uses ${s}.` })

  // Guesses about money, worded as questions. Each says it's a guess.
  const moneyChanged = real.some(p => B.files.get(p)?.money && route(p))
  const said = (x: string | undefined) => x ?? ''
  // A deal for new sign-ups (newsletter, first order, welcome) can be claimed again with another email.
  if (moneyChanged && /(\d+\s*(%|percent)|\$\s*\d+\s+off|half[- ]?(off|price)|discount|promo|coupon|\bfree\b(\s+\w+){0,2}\s+(shipping|delivery|trial|month|week|walk|order|item|session|class|lesson|booking|visit|consultation)s?\b|\bfirst\s+\w+\s+(is\s+)?free\b)/i.test(said(opts.asked)) && /(sign ?up|newsletter|subscribe|\bfirst\b|new (customer|user|account)|welcome|referr)/i.test(said(opts.asked)))
    problems.push({ kind: 'Check', text: 'You asked for a discount. If it depends on a new account or email address, people can usually get it again by signing up with another email. What stops that? (This is a guess.)' })
  // Cancelling that can hit paid rows ('cancelled', or a Prisma enum 'CANCELLED'): a 'cancelled' write whose surroundings don't limit it to pending/unpaid ones.
  // A cancel counts when it isn't limited to pending/unpaid rows: a write that sets 'cancelled', or a validated
  // list (['completed', 'cancelled']) next to a write of `status` from the request.
  // ponytail: no control flow; a pending row cancelled right after Stripe charged it (charged, no booking) is missed
  const stmtAt = (t: string, i: number) => t.slice(t.lastIndexOf(';', i) + 1, (t.indexOf(';', i) + 1 || t.length))
  const isWrite = (x: string) => !/^\s*create\s+(table|type|domain)/i.test(x) && /\bupdate\b|\.save\(|\bdata\s*:|\bset\b/i.test(x)   // not updated_at, not a table definition
  const pendingOnly = (x: string) => /\b(pending|unpaid|expired|open)\b/i.test(x) && !/(?<!un)\bpaid\b/i.test(x.replace(/payment_status\s*={1,3}\s*['"`]paid['"`]/g, ''))
  const statusFromInput = (t: string) => [...t.matchAll(/\bstatus\s*(?=[,}])|\bstatus\s*:\s*(?!['"`])[A-Za-z_]/g)].some(m => { const x = stmtAt(t, m.index!); return isWrite(x) && !pendingOnly(x) })
  // writes of 'cancelled', plus (when status comes from the request) lists of allowed values in the file: ['completed', 'cancelled'], z.enum([...]), in (...)
  const paidCancels = (t = '', file = t) => [...t.matchAll(/['"`]cancell?ed['"`]/gi)].filter(m => !/(\bnot|notIn|!==?|<>)\s*:?\s*\[?\s*$/.test(t.slice(Math.max(0, m.index! - 12), m.index)) && isWrite(stmtAt(t, m.index!)) && !pendingOnly(stmtAt(t, m.index!))).length
    + (statusFromInput(t) ? new Set([...file.matchAll(/['"`]cancell?ed['"`]/gi)].map(m => stmtAt(file, m.index!)).filter(x => !isWrite(x) && /\[[^\]]*cancell?ed[^\]]*\]|enum\s*\(|\bin\s*\(/i.test(x))).size : 0)
  const newSql = B.sqlMigrations.filter(m => !A.sqlMigrations.includes(m)).map(m => after.get(m) ?? '').join('\n')
  // test code sets up cancelled orders; it isn't the app. A test_*.py / *_test.py counts only if it holds tests (test_drive.py may be a feature)
  const isTest = (p: string) => /(^|\/)(tests?|__tests__)\/|(^|\/)(tests|conftest)\.py$|\.(test|spec)\.[jt]sx?$/.test(p)
    || /(^|\/)(test_\w+|\w+_tests?)\.py$/.test(p) && /\bdef test_|\bTestCase\b|import pytest/.test(after.get(p) ?? before.get(p) ?? '')
  // (Python files are judged by pyCancels below: a whole Python file has no `;` to split statements on)
  const cancels = real.some(p => route(p)?.kind !== 'page' && !/\.([jt]sx|py)$/.test(p.split('#')[0]) && !isTest(p.split('#')[0]) && !!B.files.get(p)?.written.size
    && paidCancels(B.files.get(p)!.printed, B.files.get(p.split('#')[0])?.printed) > paidCancels(A.files.get(p)?.printed, A.files.get(p.split('#')[0])?.printed)) || paidCancels(newSql) > 0 && /update\s+[\w.]*\s+set/i.test(newSql)
  // stripe.Refund.create, stripe.refunds.create, refund(...); not a Refund model or Refund(...) row
  const refunds = [...B.files.values()].some(f => /refunds?\.create|Refund\.create|\brefund\(|RefundService/.test(f.printed))   // Stripe.net: new RefundService()
  // Python cancels, per def (methods too) and per statement: `.status = ...cancel...` or `update(status=...cancel...)` (the value written,
  // not a filter or a comparison). A cancel is "unpaid only" when its own statement limits it to pending/unpaid rows, or, when it's the
  // def's only cancel, the def does. Defs that react to Stripe's "payment page expired" are left out: no page is open, those were never paid.
  // afterPaid: unpaid-only cancels in a def that first checks the payment (payment_status, Session.retrieve)
  const pyCancels = (t = '') => {
    const out = { pending: 0, paid: 0, afterPaid: 0 }
    // (except blocks dropped: cleanup after something failed)
    for (const d of t.replace(/#[^\n]*/g, '').replace(/("""|''')[\s\S]*?\1/g, '').replace(/^([ \t]*)except\b[^\n]*:\n(?:\1[ \t]+[^\n]*\n?)*/gm, '').split(/\n(?=[ \t]*(?:async\s+)?def\s)/)) {
      if (/session\.expired/.test(d) || !/\.a?(update|bulk_update|save)\(/.test(d)) continue
      let depth = 0, flat = ''; for (const ch of d) { depth += '([{'.includes(ch) ? 1 : ')]}'.includes(ch) ? -1 : 0; flat += ch === '\n' && depth > 0 ? ' ' : ch }
      const lines = flat.split('\n').filter(l => /\.status\s*=(?!=)[^\n]*cancel|update\([^)]*\bstatus\s*=\s*[^,)]*cancel/i.test(l))
      for (const line of lines) {
        if (!(pendingOnly(line) || lines.length === 1 && pendingOnly(d))) { out.paid++; continue }
        out.pending++; if (/payment_status|[Ss]ession\.retrieve/.test(d)) out.afterPaid++
      }
    }
    return out
  }
  const pyPaidCancel = real.some(p => !p.includes('#') && p.endsWith('.py') && !isTest(p) && pyCancels(after.get(p)).paid > pyCancels(before.get(p)).paid)
  if ((cancels || pyPaidCancel) && !refunds && [...B.files.values()].some(f => f.services.has('Stripe')))
    problems.push({ kind: 'Check', text: "Cancelling doesn't give money back: nothing in your app refunds a Stripe payment. If someone cancels after paying, they stay charged. (This is a guess.)" })
  // "I couldn't run the tests", "didn't get a chance to test", "tests not run", "untested", "the suite still needs to be run";
  // not "I didn't change the tests", "no (new) tests need to be run"
  const NOT_RUN = /\b(did ?n[o'’]?t|could ?n[o'’]?t|was ?n[o'’]?t able to|were ?n[o'’]?t able to|unable to|not able to|have ?n[o'’]?t|has ?n[o'’]?t)\s+(?:(?:actually|yet|been able to|get to|get a chance to|have time to|manage to|be able to)\s+)?(run|test|build|verify|start|try|install|execute)\b|\b(tests?|build|it|this|app|code)\s+(?:(?:was|were|has|have)\s+)?not\s+(?:been\s+)?(run|tested|verified|built)\b|\b(tests?|test suite|suite|build|it|this|app|code)\s+(could|can|did|were|was) ?n[o'’]?t\s+be\s+(run|executed|tested|verified|built)\b|\buntested\b|\b(?:tests?|testing)\s+(?:was|were|is|are) ?n[o'’]?t\s+(?:possible|available|feasible)\b|\b(?:tests?|testing)\s+(?:was|were)\s+(?:unavailable|impossible)\b|\b(?:tests?|testing|builds?|compilation)\s+(?:could|can) ?n[o'’]?t\s+(?:run|complete)\b|\b(?<!\b(no|nothing)\s+(?:\w+\s+)?)(tests?|test suite|suite|it|this|everything)\s+(still\s+)?needs?\s+to\s+(be\s+)?(run|tested)\b/i
  // "fix it", "it's weird", "make it faster" without saying what's wrong: the agent had to guess what to fix
  const ask = said(opts.asked)
  if (/\b(fix (it|this|that|things)|broken|weird|buggy|not working|doesn'?t work|isn'?t working|glitchy|janky|(is|so|too|kinda|really) slow|make it faster|speed it up)\b/i.test(ask)
    && ask.split(/\s+/).length < 16 && !/"[^"]+"|`[^`]+`|\berror\b|\bwhen i\b|\bafter\b/i.test(ask))
    ship.unshift("You didn't say exactly what was wrong, so the agent guessed. Check that the problem you saw is gone.")
  // a file you named in your request: say it's there
  const named_ = new Set<string>()
  for (const m of ask.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|py|sql|css)\b/g)) {
    if (/\b(don'?t|do not|never|without|except|leave|not)\b[^.]{0,25}$/i.test(ask.slice(0, m.index))) continue   // "don't touch src/auth.ts"
    const hit = real.find(p => p === m[0] || p.endsWith('/' + m[0].replace(/^\.?\//, '')))
    if (hit && !named_.has(hit) && named_.add(hit)) changes.push({ group: 'Other files', isNew: !before.has(hit), text: `The agent ${before.has(hit) ? 'changed' : 'created'} ${hit}, as you asked.` })
  }
  // A cancelled unpaid order whose Stripe payment page is still open can be paid: the money comes in, the order stays cancelled.
  // Cancelling unpaid orders: Python per def and statement (pyCancels above); elsewhere per statement
  const CANCEL = /['"`]cancell?ed['"`]|\.cancell?ed\b/i
  // code reacting to Stripe's "payment page expired" has no open page left to close (Python: pyCancels skips those defs)
  // error handlers clean up after a payment page that never got made (catch / except): nothing is left open to pay on
  const noCatch = (t: string) => { let out = '', i = 0
    for (const m of t.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) { if (m.index! < i) continue; let j = m.index! + m[0].length, d = 1
      for (; j < t.length && d; j++) d += t[j] === '{' ? 1 : t[j] === '}' ? -1 : 0
      out += t.slice(i, m.index); i = j }
    return out + t.slice(i) }
  const pendingCancels = (p: string, x: typeof B, text?: string) => { const f = x.files.get(p), printed = noCatch(f?.printed ?? '')
    return !f ? { n: 0, paid: 0 } : p.endsWith('.py') ? { n: pyCancels(text).pending, paid: pyCancels(text).afterPaid } : /session\.expired/.test(f.printed) ? { n: 0, paid: 0 }
      : { n: [...printed.matchAll(new RegExp(CANCEL.source, 'gi'))].map(m => stmtAt(printed, m.index!)).filter(t => isWrite(t) && pendingOnly(t)).length,
          paid: /payment_status|sessions\.retrieve|Session\.retrieve/.test(f.printed) ? 1 : 0 } }
  const usesCheckout = [...B.files.values()].some(f => [...f.outside].some(o => o.startsWith('Stripe: checkout.sessions')))
  const cancelFiles = real.filter(p => !p.includes('#') && !isTest(p) && pendingCancels(p, B, after.get(p)).n > pendingCancels(p, A, before.get(p)).n)
  // the same code confirms the payment first (payment_status, sessions.retrieve): the customer already paid when it cancels
  const afterPaying = cancelFiles.some(p => pendingCancels(p, B, after.get(p)).paid > 0)
  const closesPages = [...B.files.values()].some(f => /Session\.expire\(|sessions\.expire\(/.test(f.printed))
  if (usesCheckout && cancelFiles.length && !refunds && !closesPages && afterPaying)
    problems.push({ kind: 'Check', text: "Someone can be charged and then have their booking cancelled (for example when the spot was taken while they paid), and nothing refunds them. Refund them when that happens. (This is a guess.)" })
  else if (usesCheckout && cancelFiles.length && !refunds && !closesPages)
    problems.push({ kind: 'Check', text: "Cancelled orders can still be paid: someone who still has the Stripe payment page open can finish paying, and their order stays cancelled, so you'd keep money for nothing. Close their payment page when you cancel (Stripe's Session.expire), or refund them. (This is a guess.)" })
  // Unpaid checkouts holding spots. The app saves a 'pending' row before sending people to Stripe, and this change makes those
  // rows count toward a limit (seats, a time slot, orders per day): a 'pending' read in a statement that counts (count, sum, any?,
  // a RESERVED / holding name), or a counter raised where the pending row is saved. A spot is freed by Stripe's "payment page
  // expired" message, or by time: a date compared next to 'pending' (only recent ones count, or a job expires old ones), with
  // no `or` in between. Without either, an abandoned checkout keeps its spot for good. With only Stripe's message, the pending
  // rows already in the live database (main never freed them) never are: their pages expired long ago.
  // ponytail: text-level, across stacks; leans to missing a warning (any nearby date comparison frees spots) over a false one.
  // A list named RESERVED_* reads as a hold wherever it is used. Enum constants (Status::Pending) and column defaults aren't seen.
  const srcFile = (p: string) => /\.(ts|tsx|js|jsx|mjs|py|php|rb|rake|go|cs|java|kt|sql|vue|svelte)$/.test(p) && !/\.blade\.php$/.test(p)
    && !isTest(p) && !/_test\.go$|_spec\.rb$|(^|\/)spec\/|Tests?\.(cs|java|kt)$/.test(p)
  // (comments dropped: `// TODO: handle checkout.session.expired` frees nothing; strings kept whole: '/api/*', `Booking #${id}`)
  const noComments = (t: string, p: string) => t.replace(/`(?:\\[\s\S]|[^\\`])*`|(['"])(?:\\[\s\S]|(?!\1)[^\\\n])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#(?!\[)[^\n]*|--[ \t][^\n]*/g,
    m => /^[`'"]/.test(m) ? m : m[0] === '#' ? (/\.(py|rb|php)$/.test(p) ? '' : m) : m[0] === '-' ? (p.endsWith('.sql') ? '' : m) : m[1] === '/' && /\.(py|rb|sql)$/.test(p) ? m : '')
  const code = (s: Snap) => new Map([...s].filter(([p]) => srcFile(p)).map(([p, t]) => [p, noComments(t, p)]))
  const CA = code(after), CB = code(before), MIGR = /(^|\/)(migrations?|migrate)\//
  // the statement around i: to the nearest `;` both sides (within 400 characters). In code without `;`: from the line of the
  // outermost bracket still open at i (a call or an object, not a block: `count({` yes, `=> {` no) to where it closes, plus the
  // chained lines before and after (`Rental.pending` / `.where(...)`, `->where('status', 'pending')` / `->update(...)`)
  const stmtNear = (t: string, i: number): [number, string] => {
    const w0 = Math.max(0, i - 400), w1 = Math.min(t.length, i + 400), s0 = t.slice(w0, i).lastIndexOf(';'), e0 = t.slice(i, w1).indexOf(';')
    if (s0 >= 0 && e0 >= 0) return [w0 + s0 + 1, t.slice(w0 + s0 + 1, i + e0 + 1)]
    let d = 0, open = i, opens = 0
    for (let k = i - 1; k >= w0; k--) { const c = t[k]
      if (c === ')' || c === ']' || c === '}') d++
      else if (c === '(' || c === '[' || c === '{') { if (d) { d--; continue }
        if (c === '{' && /^[ \t]*\r?\n/.test(t.slice(k + 1, k + 4)) && !/[([,:=]\s*$/.test(t.slice(Math.max(0, k - 3), k))) break   // a block
        open = k; opens++ } }
    let j = i; for (d = opens; j < w1 && d > 0; j++) { const c = t[j]; if (c === '(' || c === '[' || c === '{') d++; else if (c === ')' || c === ']' || c === '}') d-- }
    let a = t.lastIndexOf('\n', open - 1) + 1
    while (a > 0 && /^\s*(\.|->)/.test(t.slice(a, t.indexOf('\n', a) >>> 0))) a = t.lastIndexOf('\n', a - 2) + 1
    let b = t.indexOf('\n', j)
    while (b >= 0) { const nb = t.indexOf('\n', b + 1); if (!/^\s*(\.|->)/.test(t.slice(b + 1, nb < 0 ? t.length : nb))) break; b = nb }
    return [a, t.slice(a, b < 0 ? t.length : b)] }
  const PENDING = /['"]pending['"]|%w\[[^\]]*\bpending\b/gi
  // saved, not looked for: `status: 'pending'` / `'status' => 'pending'` / VALUES (..., 'pending'), where the nearest keyword before
  // it in its statement makes a row (create, data, new, insert, values, set, update), not a filter (where, filter, find, count)
  const savedAt = (t: string, i: number) => { const [s, x] = stmtNear(t, i), before = x.slice(0, i - s)
    if (!/\bstatus['"]?\s*(=>|:|=)\s*$|\bvalues\s*\([^)]*$/i.test(before)) return false
    // (not createdAt / updated_at / insertedAt; not `or` / `and` inside a value)
    const last = [...before.matchAll(/\b(where|filter|exclude|find\w*|count\w*)\b|\b(data|create(?!d)\w*|insert(?!ed)\w*|new(?!\s+Date)|set|values|save|update(?!d)\w*)\b/gi)].at(-1)
    // (no keyword: a filter object kept aside; `updateMany({ status: 'pending', ... }, ...)`: the first argument is a filter)
    return !!last?.[2] && !/^(update|delete|remove)\w*\s*\(\s*\{[^}]*$/i.test(before.slice(last.index)) }
  const makesPending = (t: string) => [...t.matchAll(PENDING)].some(m => savedAt(t, m.index!))
  const negated = (t: string, i: number) => { const b = t.slice(Math.max(0, i - 45), i)
    return /\b(not(?!\s+null)|notIn|exclude|whereNot\w*|neq|nin|ne|not_in)\b[^\])}\n]{0,40}$|(!==?|<>)\s*['"]?\s*,?\s*$/i.test(b) }
  const LIST = /['"]pending['"]\s*,\s*['"](paid|confirmed|completed|booked|reserved|active)['"]|['"](paid|confirmed|completed|booked|reserved|active)['"]\s*,\s*['"]pending['"]|%w\[[^\]]*\bpending\b/i
  const AGG = /\b(count\w*|sum\w*|exists\??|any\??|size|length|overlap\w*)\b|COUNT\(|SUM\(/i, HOLDW = /\b(?:[Hh]olding\w*|holds?|reserved|reserved_(?:seats|spots|tickets|count|quantity|statuses)|reserved(?:Seats|Spots|Tickets|Count|Quantity)|RESERVED_[A-Z_]+)\b/   // (not reservedFor, reserved_at)
  const LIMIT = /\bcapacity\b|sold[ _-]?out|\b(is|are|date|day|slot|class|event|show)\s+(is\s+)?full\b|already\s+(reserved|booked|taken)|not enough\s+\w+|fully booked|\bno more\s+\w+|\b(seats?|spots?|places?|tickets?|slots?)\s+(left|remaining|available)\b|\boverlap/gi
  const count = (t = '', re: RegExp) => [...t.matchAll(re)].length
  // reads of 'pending' that count toward a limit: not saving one, not left out (not / exclude / whereNotIn / !=), not a write's
  // filter, not one row's status compared (`$order->status === 'pending'`) unless inside a count (`CountAsync(b => b.Status == "pending")`)
  // (in markup, only its own line: a page's whole `return (<main>…)` isn't one statement)
  const lineAt = (t: string, i: number) => t.slice(t.lastIndexOf('\n', i) + 1, (t.indexOf('\n', i) + 1 || t.length + 1) - 1)
  // a count used against the limit: the name it's kept in is compared or subtracted (`taken >= c.capacity`, `capacity - $taken`),
  // or the statement compares it itself; not a dashboard showing `{unpaid} checkouts not finished`
  // (the name a statement keeps its result in: `const taken =`, `$reserved =`, `taken, err :=`, `export const HELD =`)
  const keptIn = (x: string) => x.match(/^\s*(?:export\s+)?(?:(?:public|private|static|readonly|final)\s+)*(?:(?:const|let|var|val)\s+|\$)?(\w+)\s*(?:,\s*\w+\s*)?(?::\s*\w+\s*)?:?=(?![=>])/)?.[1]
  // a line that checks against a limit: + - or a spaced comparison next to a limit's name (`taken >= c.capacity`,
  // `paid + held > MAX_PER_DAY`), not markup, not `unpaid > 0` (a badge) or `skip + take < total` (paging)
  // (a bare `limit` is paging: `offset + limit < total`)
  const LIMNAME = /[Cc]apacity|CAPACITY|\b[Mm]ax\w*|MAX|(?<=\w)[Ll]imit\b|\b[Ll]imit_\w+|LIMIT|\b[Ss]eats\b|SEATS|\b[Ss]pots\b|[Aa]vailable|[Rr]emaining|[Qq]uota|\bcap\b|_PER_|per_?[Dd]ay/
  // or that refuses (`raise UnavailableError, "Bike is already reserved" if conflicts`, `if (clash) return Conflict(...)`)
  const checks = (line: string, n = '') => !/<\/\w|\/>/.test(line) && ((n ? new RegExp(String.raw`(?<![\w$])\$?${n}\b\s*(?:[-+](?![->=])|\s[<>]=?\s)|(?:[-+]|\s[<>]=?\s)\s*\$?${n}\b`) : /\s[<>]=?\s|[-+]/).test(line) && LIMNAME.test(line)
    || /\b(raise|throw|abort)\b|Conflict\(|\b(409|422)\b|already|\bfull\b|not enough|overlap|unavailable/i.test(line))
  const compared = (t: string, i: number, x: string) => { const n = keptIn(x)
    if (!n) return checks(x)
    const use = new RegExp(String.raw`(?<![\w$])\$?${n}\b`)
    return t.slice(i, i + 600).split('\n').some(l => use.test(l) && checks(l, n)) }   // (the name itself is the operand, not a neighbour in `{ sold, unpaid, remaining: c.capacity - sold }`)
  // a list ('pending', 'paid') counts where it's counted: in its own statement, or the next one that uses its name
  // (`held = new[] { "pending", "paid" }` … `CountAsync(b => held.Contains(b.Status))`); a list of every status checks nothing
  const listRead = (t: string, i: number, x: string) => { if (AGG.test(x)) return compared(t, i, x)
    const n = keptIn(x), j = n ? t.slice(i).search(new RegExp(String.raw`(?<![\w$])${n}\b`)) : -1
    if (j < 0) return false
    const y = stmtNear(t, i + j)[1]; return AGG.test(y) && compared(t, i + j, y) }
  const pendingReads = (t: string) => [...t.matchAll(PENDING)].filter(m => { const i = m.index!, x0 = stmtNear(t, i)[1], x = /<\/\w|\/>/.test(x0) ? lineAt(t, i) : x0
    if (savedAt(t, i) || negated(t, i) || isWrite(x) || /\b(delete\w*|destroy\w*|remove)\b/i.test(x)) return false
    // (one row: "is this order still unpaid?", by id, key or session; not every row but this one: `NOT: { id }`, `id != ?`)
    if (/whereKey|\bfind(_by)?\(|\bid['"]?\s*(=>|:|==?(?!=))|['"]id['"]\s*,|\bpk\s*=|\bsession_id\b|params\.id/i.test(x.replace(/\bNOT\s*:\s*\{[^}]*\}|\b(where\.)?not\([^)]*\)|whereNot\w*\([^)]*\)|\.exclude\([^)]*\)|\bid['"]?\s*(!==?|<>)\s*[^,)\s]+/gi, ''))) return false
    if (/(===?)\s*$/.test(t.slice(Math.max(0, i - 6), i)) && !AGG.test(x)) return false
    // (or the function it's in is named for it: scopeHoldingSeats, `scope :reserved`): the last declaration before it, still open
    const w = Math.max(0, i - 1500), decl = [...t.slice(w, i).matchAll(/\b(?:function|def|scope)\s+:?(\w+)|\bfunc\b\s*(?:\([^)]*\)\s*)?(\w+)|\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^()]*\)|\w+)\s*=>/g)].at(-1)
    const body = decl ? t.slice(w + decl.index!, i) : '', fn = decl && (count(body, /\{/g) > count(body, /\}/g) || !/[{}]/.test(body)) ? decl[1] ?? decl[2] ?? decl[3] ?? '' : ''
    return HOLDW.test(x) || /holding|reserved|capacity/i.test(fn) || LIST.test(x) && listRead(t, i, x) || AGG.test(x) && compared(t, i, x) }).length
  const total = (c: Map<string, string>, f: (t: string) => number) => [...c].reduce((n, [, t]) => n + f(t), 0)
  const COUNTER = /\bset\s+\w+\s*=\s*[\w.]*\w+\s*\+|->increment\(|\.increment!?\(|\bincrement\s*:|\$inc\b|F\(['"]\w+['"]\)\s*\+/i
  // a counter raised where the pending row is saved, next to a limit (`SET order_count = order_count + 1 WHERE order_count < 30`)
  const counter = (c: Map<string, string>) => [...c].some(([p, t]) => !MIGR.test(p) && makesPending(t) && COUNTER.test(t) && count(t, LIMIT) > 0)
  // a date compared, in any common form: created_at < ?, createdAt: { gt: cutoff }, created__lt=, created_at: ...cutoff,
  // { [Op.lt]: cutoff }, LessThan(cutoff), .lt('created_at', x), lt(t.createdAt, x), reservedUntil > NOW(); not assigned (`'expires_at' => now()`)
  const DATE = String.raw`(?:created|updated|inserted|modified|expires)(?:_?at|_?on|At|On)?|(?:reserved|held)_?until`
  const TIMECMP = new RegExp(String.raw`\b(?:${DATE})(?:__[lg]te?\b|\W{0,40}?(?:\$?\b[lg]te?\b|\[Op\.[lg]te?\]|LessThan|MoreThan|<(?!\/)=?|(?<![=-])>=?)|['"]?\s*(?::|=>)\s*\(?\.\.\.?)|\b(?:lt|lte|gt|gte|LessThan\w*|MoreThan\w*)\s*\(\s*['"]?[\w.]*?(?:${DATE})\b`, 'i')
  const MARK = /['"]pending['"]|\.pending\b|(::|->)pending\(|%w\[[^\]]*\bpending\b/gi
  const byTime = (c: Map<string, string>) => [...c].some(([p, t]) => !MIGR.test(p) && [...t.matchAll(MARK)].some(m => { const i = m.index!
    if (negated(t, i) || savedAt(t, i)) return false
    // ponytail: any date compared within 400 characters frees it (a job, a recent-only count, two statements); an unrelated
    // rate limit next to the count is read the same: a missed warning, never a false one
    const w0 = Math.max(0, i - 400), w = t.slice(w0, i + 400)
    return [...w.matchAll(new RegExp(TIMECMP.source, 'gi'))].some(tm => { const j = w0 + tm.index!; return !/\bor(Where)?\b|\|\|/i.test(t.slice(Math.min(i, j), Math.max(i, j))) }) }))
  const byStripe = (c: Map<string, string>) => [...c].some(([p, t]) => !MIGR.test(p) && /checkout\.session\.expired|CheckoutSessionExpired/i.test(t))
  // old pending rows marked expired / cancelled / failed (or deleted) outside Stripe's message: by age anywhere, or in a migration,
  // a command or a job on the whole table (not a user cancelling their own, a job cancelling one event's, an error handler failing this order)
  const UNSCOPED = /\b[A-Z]\w*(::|\.)(where\w*|objects|query|filter|update\w*|delete\w*)\b|\b[A-Z]\w*(::|\.)\w+(\([^)]*\))?(->|\.)(update|delete|destroy)\w*|(update|delete)Many\(\s*\{\s*where:\s*\{\s*status:[^,}]*\}|DB::table|\b(update|UPDATE)\s+\w+\s+(set|SET)\b|\b(delete|DELETE)\s+(from|FROM)\b/
  const JOB = /(^|\/)(migrations?|migrate|console|commands?|jobs?|tasks?|cron|workers?|management|schedule|scripts?|cmd|bin)(\/|\.\w+$)/i
  const cleansUp = (c: Map<string, string>) => [...c].map(([p, t]) => [p, noCatch(t)]).some(([p, t]) => !/checkout\.session\.expired|CheckoutSessionExpired/i.test(t)
    && [...t.matchAll(MARK)].some(m => { const [, x] = stmtNear(t, m.index!)
      return !negated(t, m.index!) && (MIGR.test(p) || JOB.test(p) && UNSCOPED.test(x) && !/->\w+\(\)\s*->|\$this->/.test(x) || TIMECMP.test(x)) && !/whereKey|\bfind(_by)?\(|\bid['"]?\s*(=>|:|=|,)|\.id\b|_id\b/i.test(x) && (/\b(delete\w*|destroy\w*)\b/i.test(x) || (isWrite(x) || /\bupdate_all\b/.test(x)) && /['"](expired|cancell?ed|failed|abandoned)['"]/i.test(x)) }))
  const holds = usesCheckout && [...CA.values()].some(makesPending) && [...CA].some(([p, t]) => !MIGR.test(p) && count(t, LIMIT) > 0)
  const grew = total(CA, pendingReads) > total(CB, pendingReads)
  if (holds && !byStripe(CA) && !byTime(CA) && (grew || counter(CA) && !counter(CB)))
    problems.push({ kind: 'Check', text: "Unpaid checkouts now take up spots for good. An order counts toward the limit as soon as checkout starts, while it's still unpaid, and nothing ever frees it: someone who leaves the payment page (or goes back and tries again) keeps the spot, and anyone could fill every spot without paying. Count only paid orders plus recent unpaid ones (and give the Stripe payment page a short expiry), or free the spot when Stripe says the page expired. (This is a guess.)" })
  // (old rows are already freed if main freed them, if only recent pending rows count, or if the change expires them)
  else if (holds && grew && byStripe(CA) && !byTime(CA) && !byStripe(CB) && !byTime(CB) && [...CB.values()].some(makesPending) && !cleansUp(CA))
    problems.push({ kind: 'Check', text: "Old unpaid checkouts already in your database now take up spots, and nothing will free them: their payment pages expired long ago, so Stripe won't say so again. Before this goes live, mark the old unpaid (\"pending\") orders as expired. (This is a guess.)" })
  // a GET that changes things: opening a link (from another site, an email preview, a browser loading ahead) is enough
  const onlyPost = 'django' in B.deps ? 'with `@require_POST`' : 'flask' in B.deps ? "with `methods=['POST']`" : 'a POST route instead of a GET one'
  // links meant to act when opened: email confirmations, payment returns. Stripe's cancel_url sends people back by GET: that view is skipped
  // when the cancel_url names it (reverse('shop:checkout_cancel') for /checkout/[id]/cancel), not any view with "cancel" in it.
  const ACTS = new Set(['verify', 'confirm', 'unsubscribe', 'activate', 'magic', 'logout', 'callback', 'success', 'return', 'session'])
  const cancelUrls = [...B.files.values()].flatMap(f => [...f.printed.matchAll(/cancel_url\W{1,4}([^\n]{0,160})/g)].map(m => m[1].split(/,\s*['"]?\w+['"]?\s*[:=]/)[0]))
  const stripeReturn = (url: string) => { const parts = url.split('/').filter(x => x && !x.startsWith('['))
    return parts.length > 0 && cancelUrls.some(c => parts.every(x => c.includes(x))) }
  for (const p of real) {
    const r = route(p), b = B.files.get(p) as FileFacts & { getWrites?: boolean } | undefined, a = A.files.get(p) as FileFacts & { getWrites?: boolean } | undefined
    // ponytail: Python views only (a Django view answers every method unless told otherwise)
    if (r?.kind === 'endpoint' && p.split('#')[0].endsWith('.py') && b?.getWrites && !a?.getWrites && !isPublic(r.url) && !r.url.split('/').some(x => ACTS.has(x)) && !stripeReturn(r.url))
      problems.push({ kind: 'Check', text: `${cap(placeName(p))} changes things when someone just opens its address. A link on another site, or a browser loading pages ahead, can do it without the person meaning to. Make it accept only form submissions (POST, ${onlyPost}). (${r.url})` })
  }
  // Django sends email through EMAIL_BACKEND; the console one only prints it in the server log. Live settings only (not dev/local/test/ci),
  // and any of them sending for real is enough (production.py overriding base.py; `console if DEBUG else anymail`).
  // Unset means SMTP, which works when EMAIL_HOST points somewhere other than this machine.
  const settings = [...B.files].filter(([p, f]) => (f as PyFacts).dj && !/(^|\/|_)(dev|development|local|tests?|ci)\w*\.py$|(^|\/)(tests?|settings\/(dev|local|tests?|ci))\//.test(p)).map(([, f]) => (f as PyFacts).dj)
  const QUIET_MAIL = /console|locmem|dummy|filebased/, sends = /smtp|anymail|ses|sendgrid|mailgun|postmark|resend|brevo|sparkpost/i
  const realBackend = settings.some(d => d.emailBackend && (sends.test(d.emailBackend) || !QUIET_MAIL.test(d.emailBackend)))
  const consoleBackend = settings.some(d => d.emailBackend && QUIET_MAIL.test(d.emailBackend))
  const realHost = settings.some(d => d.emailHost && !/^\s*['"](localhost|127\.0\.0\.1)['"]\s*$/.test(d.emailHost))
  const mailsNow = (x: typeof B) => [...x.files.values()].some(f => f.outside.has('email: send'))
  if ('django' in B.deps && mailsNow(B) && !mailsNow(A) && !realBackend && (consoleBackend || !realHost))
    ship.push(`Turn on real email sending on your live site: set EMAIL_BACKEND to your email service (${consoleBackend ? 'right now it falls back to printing emails in the server log' : "nothing sets it, so Django tries a mail server on this same machine"}). Until then, nobody gets these emails.`)
  // a new text field with a default on a table that already has rows: every existing row gets that value
  for (const m of B.pyMigrations.filter(m => !A.pyMigrations.includes(m))) for (const x of (after.get(m) ?? '').split(/(?=migrations\.\w+\()/).map(op => op.match(/^migrations\.AddField\(\s*model_name=['"](\w+)['"],\s*name=['"](\w+)['"],([\s\S]*)/)).filter(x => !!x)) {
    // the field's own default (after its choices), on a model that existed before
    const d = x[3].match(/\b(?:db_)?default=(['"])([^'"]*)\1/), model = [...A.models.keys()].find(k => k.toLowerCase() === x[1])
    const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const label = d && x[3].match(new RegExp(`\\(\\s*['"]${esc(d[2])}['"]\\s*,\\s*(?:_\\()?['"]([^'"]+)['"]`))?.[1]   // choices: ('sm', 'Small') -> Small
    if (d && d[2] && model) problems.push({ kind: 'Check', text: `Every ${singular(things(model))} you already have gets "${label ?? d[2]}" as its ${fieldName(x[2]) || words(x[2])}. Change the ones that should be different. (in ${m})` })
  }
  // Python files the card doesn't mention otherwise (services.py, API files, tests): say they changed. Not the ones the card already
  // covers another way: models (Database), files that only wire up routers or urls, files a problem names.
  // ponytail: TypeScript components and helpers already show up through the pages that use them
  const shown = [...changes.map(c => `${c.text} ${c.detail ?? ''}`), ...problems.map(x => x.text), ...ship, ...unfinished].join('\n')
  const wiring = (f?: FileFacts) => { const x = f as PyFacts | undefined; return !!x && (x.models.size > 0 || x.mounts.length > 0 || x.servers.size > 0 || x.dj.urls.length > 0 || x.dj.routers.size > 0) }
  const quiet = real.filter(p => !p.includes('#') && p.endsWith('.py') && !route(p) && ![...B.routes.keys()].some(k => k.startsWith(p + '#')) && !shown.includes(p) && !wiring(B.files.get(p))
    && !/(^|\/)(migrations|alembic)\/|(^|\/)__init__\.py$|(^|\/)(apps|asgi|wsgi|manage)\.py$/.test(p))
  for (const [verb, xs] of [['added', quiet.filter(q => !before.has(q))], ['changed', quiet.filter(q => before.has(q) && after.has(q))], ['deleted', quiet.filter(q => !after.has(q))]] as const)
    if (xs.length) changes.push({ group: 'Other files', text: `The agent also ${verb} ${list(xs)}${xs.every(q => /(^|\/)tests?(_\w+)?\.py$|(^|\/)tests?\//.test(q)) ? ' (tests)' : ''}.` })
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

  // an unasked change is a guess ("?"), not a problem: it's for the owner to decide
  const checks = r.problems.filter(p => p.kind === 'Check' || p.kind === 'Unasked').length, bad = r.problems.length - checks
  out.push('', '  ' + [
    bad ? red(`⚠ ${plural(bad, 'problem')}`) : checks ? '' : green('✓ No problems spotted'),   // never "no problems" above something to look at
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

// a dotted key in application.yml: stripe.secret-key -> stripe:\n  secret-key: value (any indentation; ponytail: no lists, no flow style)
function yamlProp(yml: string, key: string): string | undefined {
  const parts = key.split('.'), stack: { ind: number; key: string }[] = []
  for (const line of yml.split('\n')) {
    const m = line.match(/^(\s*)([\w-]+)\s*:\s*(.*)$/); if (!m) continue
    const ind = m[1].length
    while (stack.length && stack.at(-1)!.ind >= ind) stack.pop()
    stack.push({ ind, key: m[2] })
    if (stack.map(x => x.key).join('.') === parts.join('.') && m[3]) return m[3].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '') || undefined
  }
}
