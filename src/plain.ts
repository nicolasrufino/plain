#!/usr/bin/env node
// plain v0: what changed in your app compared to a git ref. Static facts, no AI.
//
//   plain [ref] [--asked "what you asked for"]   ref defaults to HEAD (uncommitted work)
//   plain --hook                                  Claude Code Stop hook: reads the last prompt
//
// ponytail: Next.js (app/ and pages/), Express-style servers, React Router, Prisma, Supabase, Stripe. Each framework is one more fact extractor.
import { adminCond, adminPos, FROM_REQUEST } from './admin.ts'
import { memberCheck, keepsTo, scan, topLevel, roleGate, roomOnly, free, boundAll, aroundNames, inside } from './members.ts'
import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { readDb, findings, isMigration, ownOnly, type Db } from './supabase.ts'
import { pyFacts, djClassRoutes, pySwallows, dbWrite, FAILS, type PyFacts, type DjClass } from './python.ts'
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
const TESTS = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?(_\w+)?|conftest)\.py$|_test\.(go|py|rb)$|_spec\.rb$/
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
  exportEarly?: boolean; exportChain?: boolean; exportG?: FileFacts   // (an early return before that check; next-connect's export default nc().get(...).post(...))
  leadCalls?: string[]   // a function's first, unconditional `await X(...)` calls (see collect)
  socketEvents?: Map<string, FileFacts>; socketRefs?: Map<string, string>; socketAuth?: boolean; socketGuardish?: boolean   // Socket.IO: socket.on('send message', ...) and what each does; io.use(...) turning away connections without a login
  pageFns?: number[]   // Next.js: where the default export (the page or layout itself) and getServerSideProps start
  authIfs: { g: string; at: number; fn: number; req?: boolean; cond?: string; ret?: boolean; noReturn?: boolean }[]; tries?: [number, number][]; skipIfs: { c: string; at: number; fn: number; login?: boolean; rej?: boolean }[]   // where those checks apply (their path tests, '' = everywhere); early returns that let requests through
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
const NOT_GUARD = /(^|\.)session\(|(^|\.|express|cookie)[sS]ession\(\s*\{|passport\.(initialize|session)|cookie|csrf|cors|helmet|(routes?|router)$|\boptional\w*\(|\w*Optional\(|^\s*optional\w*\s*$|^\s*\w*(?:auth|user|login|session)Optional\s*$|optional\s*:\s*true|credentialsRequired\s*:\s*false|sessionRequired\s*:\s*false/i   // (expressSession({...}), optionalAuth(), expressjwt({ credentialsRequired: false }) let everyone through)   // sets up sessions or mounts routes; checks nothing
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
// `const s = await auth()`: s is the session whatever it's called (the nearest declaration of that name, in the blocks around it)
// Only with nothing or the request passed in: getUser(params.id) looks up someone else's record, not who's logged in.
// Not a name that's reassigned, or redeclared nearer (a parameter, a loop variable, a catch).
// (awaited: a Promise is always truthy, so `if (!s)` on one stops nobody; Clerk's auth() / getAuth() may be sync)
const AUTH_CALL = /^(?:await\s+(?:auth|getServerSession|getSession|currentUser|getCurrentUser|getUser|getAuth|getServerAuthSession|requireUser|requireAdmin)|(?:await\s+)?(?:auth|getAuth))\s*\(([^()]*(?:\(\))?[^()]*)\)$/
const REQ_ARG = /^(?:req|request|res|response|event|ctx|context|opts|options|\w*[Aa]uth(?:Options|Config)|\{\s*req\b[^}]*\}|(?:await\s+)?(?:headers|cookies)\(\))$/
const authAlias = (e: ts.Expression, sf: ts.SourceFile): boolean => {
  const s = strip(e), root = ts.isPropertyAccessExpression(s) ? s.expression : s
  if (!ts.isIdentifier(root) || ts.isPropertyAccessExpression(s) && !/^(user|session|userId)$/.test(s.name.text)) return false
  const x = root.text, named = (b: ts.BindingName) => ts.isIdentifier(b) && b.text === x
  for (let c: ts.Node | undefined = e.parent; c; c = c.parent) {
    if ((ts.isFunctionDeclaration(c) || ts.isFunctionExpression(c) || ts.isArrowFunction(c) || ts.isMethodDeclaration(c)) && c.parameters.some(q => named(q.name))) return false
    if ((ts.isForOfStatement(c) || ts.isForInStatement(c) || ts.isForStatement(c)) && c.initializer && ts.isVariableDeclarationList(c.initializer) && c.initializer.declarations.some(d => named(d.name))) return false
    if (ts.isCatchClause(c) && c.variableDeclaration && named(c.variableDeclaration.name)) return false
    if (ts.isBlock(c) || ts.isSourceFile(c)) for (const st of c.statements) if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations)
      if (named(d.name)) {
        // (not a getSession() imported from a chat store: only from somewhere about auth or users, or written in this file)
        const callee = d.initializer?.getText(sf).match(/^(?:await\s+)?([\w$]+)/)?.[1]
        const from = sf.statements.find((st): st is ts.ImportDeclaration => ts.isImportDeclaration(st) && !!st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)
          && st.importClause.namedBindings.elements.some(el => el.name.text === callee))
        if (from && ts.isStringLiteral(from.moduleSpecifier) && !/auth|session|clerk|supabase|lucia|iron|kinde|user|account|login|firebase|next-auth|better-auth/i.test(from.moduleSpecifier.text)) return false
        // (assigned again in that scope: not the session anymore)
        if ((c.getText(sf).match(new RegExp(String.raw`(?<![\w$.])${x.replace(/\$/g, '\\$')}\s*(?:[-+*/|&?]{0,2})=(?![=>])`, 'g')) ?? []).length > 1) return false
        const m = d.initializer?.getText(sf).match(AUTH_CALL); return !!m && (!m[1].trim() || m[1].split(',').every(a => REQ_ARG.test(a.trim())))
      }
  }
  return false
}
const isLoginRef = (e: ts.Expression, sf: ts.SourceFile) => { const t = strip(e).getText(sf).replace(/\s/g, ''); return LOGIN_REF.test(t) && !NOT_LOGIN.test(t) || authAlias(e, sf) }
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
  // (exportEarly: an early return lets some requests through before that check)
  const early = (g: FileFacts) => { const at = Math.min(...g.authIfs.filter(x => !x.g).map(x => x.at), ...g.skipIfs.filter(x => x.login).map(x => x.at), Infinity)
    return at < Infinity && g.skipIfs.some(sk => !sk.login && !sk.rej && sk.at < at) }
  for (const st of sf.statements) if (ts.isExportAssignment(st)) {
    const g = collect(sf, st.expression, empty(printer.printNode(ts.EmitHint.Unspecified, st.expression, sf))); f.exportAuth = handlerChecks(g); f.exportEarly = early(g); f.exportG = g
    f.exportChain = ts.isCallExpression(st.expression) && ts.isPropertyAccessExpression(st.expression.expression)
  }
  // export default async function (req, res) { ... }: no name to look up
    else if (ts.isFunctionDeclaration(st) && !st.name && st.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) { const g = collect(sf, st, empty(printer.printNode(ts.EmitHint.Unspecified, st, sf))); f.exportAuth = handlerChecks(g); f.exportEarly = early(g); f.exportG = g }
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
      // API_URL is this app's server: a const in this file named for it (not OLLAMA_URL, OPENAI_BASE), made only of env reads named
      // the same way and localhost, and not declared again inside the helper
      const OWN = (n: string) => /^(api|apibase|apibaseurl|apiurl|apiorigin|baseurl|serverurl|backendurl)$/.test(n.replace(/^(VITE|NEXT_PUBLIC|REACT_APP|PUBLIC|EXPO_PUBLIC|NUXT_PUBLIC)_/, '').replace(/_/g, '').toLowerCase())
      const declares = (n: ts.Node, name: string): boolean => (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n)) && !!n.name && ts.isIdentifier(n.name) && n.name.text === name
        || !!ts.forEachChild(n, c => declares(c, name) || undefined)
      const ownOrigin = (e: ts.Expression): boolean => {
        if (!ts.isIdentifier(e) || !OWN(e.text) || declares(node, e.text)) return false
        const d = sf.statements.flatMap(s => ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.Const ? [...s.declarationList.declarations] : [])
          .filter(x => ts.isIdentifier(x.name) && x.name.text === e.text)
        const ok = (x: ts.Expression): boolean => ts.isParenthesizedExpression(x) ? ok(x.expression)
          : ts.isBinaryExpression(x) ? /^(\?\?|\|\|)$/.test(x.operatorToken.getText(sf)) && ok(x.left) && ok(x.right)
          : ts.isStringLiteralLike(x) ? /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)?\/?$/.test(x.text)
          : /^(import\.meta\.env|process\.env)\.\w+$/.test(x.getText(sf)) && OWN(x.getText(sf).split('.').pop()!)
        return d.length === 1 && !!d[0].initializer && ok(d[0].initializer)
      }
      const wraps = (n: ts.Node): string | undefined => {
        if (ts.isCallExpression(n) && n.expression.getText(sf) === 'fetch') {
          const a = n.arguments[0], sp = a && ts.isTemplateExpression(a) ? a.templateSpans : undefined
          if (sp?.[0].expression.getText(sf) === param) return (a as ts.TemplateExpression).head.text
          // `${API_URL}/api${path}`: this app's own server at another origin (only env reads and localhost in API_URL)
          if (sp?.[1]?.expression.getText(sf) === param && (a as ts.TemplateExpression).head.text === '' && ownOrigin(sp[0].expression)) return sp[0].literal.text
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
const clientsOf = new WeakMap<ts.SourceFile, Set<string>>(), appNamesOf = new WeakMap<ts.SourceFile, Set<string>>()   // one set per file: a client made at the top is used inside handlers
function collect(sf: ts.SourceFile, root: ts.Node, f: FileFacts): FileFacts {
  // lead calls: `await X(...)` / `const … = await X(...)` statements at the top of a function body, before anything that writes,
  // loops, branches or catches (an early `if (...) return` is fine): what runs first, every time. Not `X().catch(...)`, not
  // without await, not in a try, a loop, a ternary or Promise.all.
  const body0 = ts.isFunctionDeclaration(root) || ts.isArrowFunction(root) || ts.isFunctionExpression(root) || ts.isMethodDeclaration(root) ? root.body : undefined
  if (body0 && ts.isBlock(body0)) {
    const LEAD_WRITE = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany|insert|destroy|save|remove|execute\w*)\s*\(|\bsql`|\$executeRaw|\bresolve\s*\(/
    // (a statement passed over calls nothing of the app: built-ins and methods like String(...) / formData.get(...), not an app
    // function and not a method on something imported from the app: `repo.removeAll()` from `import * as repo from "@/lib/repo"`)
    // (once per file: collect runs for every function, and a file with thousands of them made this quadratic)
    let appNames = appNamesOf.get(sf)
    if (!appNames) appNamesOf.set(sf, appNames = new Set(sf.statements.filter(ts.isImportDeclaration).filter(d => /^(\.|@\/|~\/)/.test((d.moduleSpecifier as ts.StringLiteral).text)).flatMap(d => {
      const c = d.importClause; return c ? [...c.name ? [c.name.text] : [], ...c.namedBindings && ts.isNamespaceImport(c.namedBindings) ? [c.namedBindings.name.text] : []] : [] })))
    const callsApp = (t: string) => [...t.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].some(m => !/^(String|Number|Boolean|BigInt|JSON|parseInt|parseFloat|Date|Array|Object|Math|URL|URLSearchParams|encodeURIComponent|decodeURIComponent|isNaN|Symbol|Error|if|return|typeof|await|new|async|function)$/.test(m[1]))
      || [...t.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\.\s*[\w$.]+\s*\(/g)].some(m => appNames.has(m[1]))
    // (and its arguments do nothing first: no await, no app call: not getMember(purge()))
    const callOf = (e?: ts.Expression) => e && ts.isAwaitExpression(e) && ts.isCallExpression(e.expression) && ts.isIdentifier(e.expression.expression) && !e.expression.arguments.some(a => /\bawait\b/.test(a.getText(sf)) || callsApp(a.getText(sf))) ? e.expression.expression.text : undefined
    const lead: string[] = []
    for (const st of body0.statements) {
      const t = st.getText(sf)
      if (ts.isIfStatement(st) && !st.elseStatement && /^\s*\{?\s*return\b/.test(st.thenStatement.getText(sf)) && !LEAD_WRITE.test(t) && !/\bawait\b/.test(t) && !callsApp(t)) continue
      const c = ts.isExpressionStatement(st) || ts.isReturnStatement(st) ? callOf(st.expression) : ts.isVariableStatement(st) && st.declarationList.declarations.length === 1 ? callOf(st.declarationList.declarations[0].initializer) : undefined   // (`return await requireUser()` too)
      if (c) { lead.push(c); continue }
      if (ts.isVariableStatement(st) && !/\bawait\b/.test(t) && !LEAD_WRITE.test(t) && !/=>|function\b/.test(t) && !callsApp(t)) continue   // const id = String(formData.get('id'))
      break
    }
    f.leadCalls = lead
  }
  const servers = new Set<string>(), guarded = new Set<string>(), guardMw = new Map<string, string[]>()   // guardMw: router.use(requireAuth, requireAdmin)'s names
  let sbClients = clientsOf.get(sf)
  if (!sbClients) {
    clientsOf.set(sf, sbClients = new Set())
    for (const st of sf.statements) if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.initializer && CLIENT_MAKER.test(d.initializer.getText(sf))) sbClients.add(d.name.text)
  }
  const inlineMw = new Map<string, string[]>()
  const scopeAt = (n: ts.Node) => { let x: ts.Node | undefined = n.parent; while (x && !ts.isFunctionLike(x)) x = x.parent; return x ? x.pos : -1 }
  const isGuard = (a: ts.Node) => !fnLike(a) && GUARD.test(a.getText(sf)) && !NOT_GUARD.test(a.getText(sf))
  const addHandler = (server: string, method: string, path: string, mw: readonly ts.Expression[], h: ts.Expression) =>
    f.handlers.push({ server, method: method.toUpperCase(), path, guard: guarded.has(server) || mw.some(isGuard), mw: [...guardMw.get(server) ?? [], ...mw.map(m => m.getText(sf))], adminInline: inlineMw.get(`${server}@${scopeAt(h)}`) ?? [],
      handler: ts.isIdentifier(h) ? h.text : undefined, facts: fnLike(h) ? collect(sf, h, empty(printer.printNode(ts.EmitHint.Unspecified, h, sf))) : empty(h.getText(sf)) })
  const labelFor = new Map<string, string>(), boxes: { id?: string; type: string; v?: string; aria: boolean }[] = []
  const str = (e?: ts.Node) => e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text
    : e && ts.isTemplateExpression(e) ? e.head.text + e.templateSpans.map(t => '[…]' + t.literal.text).join('') : undefined
  // Next.js: the page or layout itself (the default export) and getServerSideProps, where a page's own login check has to be
  // (the whole file's collect only: it reads every statement, and runs once per function otherwise)
  if (root === sf) {
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
  if (root === sf && first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use server')
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
  const frameworkThrow = (name: string) => sf.statements.some(st => ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && /^(?:next\/navigation|@sveltejs\/kit)$/.test(st.moduleSpecifier.text)
    && !!st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings) && st.importClause.namedBindings.elements.some(el => el.name.text === name))
  const visit = (n: ts.Node) => {
    // (where the try blocks are: a login check inside one may be caught and swallowed)
    if (ts.isTryStatement(n)) (f.tries ??= []).push([n.tryBlock.getStart(sf), n.tryBlock.getEnd()])
    // A real login check: an `if` that tests the logged-in user and stops inside that branch, or a require*() helper that does it.
    if (ts.isIfStatement(n)) {
      const groups = authSourced(n.expression) ? loginGroups(n.expression, sf) : []
      const positive = isLoginRef(n.expression, sf) && authSourced(n.expression) && n.elseStatement   // if (locals.user) { ... } else { redirect(...) }
      const branchNode = groups.length ? n.thenStatement : positive ? n.elseStatement! : undefined
      const branch = branchNode ? own(branchNode) : '', ctx = branch ? context(n) : null
      // SvelteKit hides admin pages with a 404 too: error(404) under `!locals.user` turns people away
      // (and pages/api's documented `{ res.status(401).json(...); return }`: the status, then a return)
      const stops = hardStop(branch) || /\berror\s*\(\s*404/.test(branch) && /\blocals\./.test(n.expression.getText(sf)) || /\.status\(\s*40[13]\s*\)/.test(branch) && /^\s*return\b/m.test(branch)
      // (Next.js pages router: getServerSideProps turns guests away with `return { redirect: ... }` / `return { notFound: true }`)
      if (ctx && !stops && /\breturn\s*\{\s*(?:redirect|notFound)\b/.test(branch)) { f.authStop = true; f.authIfs.push(...(groups.length ? groups : ['']).map(g => ({ g: [g, ...ctx.conds].filter(Boolean).join(' && '), at: n.getStart(sf), fn: ctx.fn, cond: n.expression.getText(sf) }))) }
      // (ret: it stops by returning a response, which stops a handler but not the caller of a helper)
      // (redirect(), notFound(), unauthorized(), forbidden(), error(401) throw only when they're Next's or SvelteKit's: an app's own
      // `const unauthorized = () => NextResponse.json(..., { status: 401 })` returns)
      else if (ctx && stops) { const ret = !/\bthrow\b/.test(branch) && ![...branch.matchAll(/(?<![.\w$])(redirect|notFound|unauthorized|forbidden|error)\s*\(/g)].some(m => frameworkThrow(m[1]))
        // (noReturn: `if (!session) NextResponse.redirect(...)` builds a response and goes on)
        f.authStop = true; f.authIfs.push(...(groups.length ? groups : ['']).map(g => ({ g: [g, ...ctx.conds].filter(Boolean).join(' && '), at: n.getStart(sf), fn: ctx.fn, cond: n.expression.getText(sf), ret, noReturn: ret && !/\breturn\b/.test(branch) }))) }
      else if (ctx && RETURNS.test(branch)) {
        // in a handler a return-style check stops the request; in a hook or middleware it lets anonymous visitors through: a skip for them
        f.authReturn = true; f.skipIfs.push({ c: groups.length ? groups.join(' || ') || 'true' : 'true', at: n.getStart(sf), fn: ctx.fn, login: true })
      }
      // an early return that lets requests through before any check (`if (pathname === '/health') return ...`, `if (!sessionId) return resolve(event)`):
      // those requests skip the check. Nuxt's `if (import.meta.server) return` is no skip: the middleware runs again in the browser.
      else if (!groups.length && !positive && /\breturn\b/.test(n.thenStatement.getText(sf)) && !/import\.meta\.(server|client)/.test(n.expression.getText(sf)) && !hardStop(own(n.thenStatement))) {
        // (rej: it answers with an error, a 405 or a 400: those requests are turned away, not let through)
        const c = context(n); if (c) f.skipIfs.push({ c: n.expression.getText(sf), at: n.getStart(sf), fn: c.fn, rej: /^\s*\{?\s*return\b(?![^;]*\?)[^;]*(?:status\(\s*|status\s*:\s*)4\d\d\b[^;]*;?\s*\}?\s*$/.test(own(n.thenStatement)) })
      }
    }
    // locals.user ?? redirect(303, '/login'), user || error(401)
    if (ts.isBinaryExpression(n) && /^(\?\?|\|\|)$/.test(n.operatorToken.getText(sf)) && isLoginRef(n.left, sf) && hardStop(n.right.getText(sf))) {
      const ctx = context(n); if (ctx) { f.authStop = true; f.authIfs.push({ g: ctx.conds.join(' && '), at: n.getStart(sf), fn: ctx.fn }) }
    }
    // requireUserSession(event): everywhere, or only where the ifs around it say
    if (ts.isCallExpression(n) && (REQUIRE_LOGIN.test(n.expression.getText(sf).split('.').at(-1)!) || /^(?:auth|auth\(\)|\(\s*await\s+auth\(\)\s*\))\.protect$/.test(n.expression.getText(sf).replace(/\s+/g, ' '))
      || ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'protect' && ts.isIdentifier(n.expression.expression) && authAlias(n.expression.expression, sf))) {   // (Clerk's auth.protect(), v5's auth().protect())
      const ctx = context(n); if (ctx) { f.authStop = true; f.authIfs.push({ g: ctx.conds.join(' && '), at: n.getStart(sf), fn: ctx.fn, req: true }) }   // (req: by name; a server action counts it only as a lead call)
    }
    // Socket.IO (server only: a file importing 'socket.io', not the client): inside io.on('connection', socket => ...), each
    // socket.on / once('event', handler) is an event the live connection takes (not the built-in disconnect / error).
    // io.use((socket, next) => { if (!token) return next(new Error(...)) }) on that same server: connecting needs a login.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(on|use)$/.test(n.expression.name.text) && (/from\s+['"]socket\.io['"]|require\(\s*['"]socket\.io['"]\s*\)/.test(sf.text) || /\bio\.on\(\s*['"]connection/.test(sf.text) && !/socket\.io-client|from\s+['"]ws['"]|require\(\s*['"]ws['"]\s*\)/.test(sf.text)) && !/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[jt]sx?$/.test(sf.fileName)) {
      const recv = n.expression.expression.getText(sf)
      // (the Server that socket.io gives, under the name it's imported as: not node:http's Server)
      const ioName = sf.text.match(/import\s*\{[^}]*\bServer(?:\s+as\s+(\w+))?[^}]*\}\s*from\s*['"]socket\.io['"]/)?.[1] ?? (/import\s*\{[^}]*\bServer\b[^}]*\}\s*from\s*['"]socket\.io['"]/.test(sf.text) ? 'Server' : undefined)
      const servers = new Set(['io', ...ioName ? [...sf.text.matchAll(new RegExp(String.raw`(\w+)\s*=\s*new\s+${ioName}\s*\(`, 'g'))].map(m => m[1]) : []])
      const cb = n.arguments.at(-1)
      if (n.expression.name.text === 'on' && servers.has(recv) && /^(connection|connect)$/.test(str(n.arguments[0]) ?? '') && cb && fnLike(cb)) {
        const sock = (cb as ts.ArrowFunction).parameters[0]?.name.getText(sf)
        const walk = (x: ts.Node): void => {
          if (sock && ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && /^(on|once)$/.test(x.expression.name.text) && x.expression.expression.getText(sf) === sock) {
            const ev = str(x.arguments[0]), fn = x.arguments.at(-1)
            if (ev && fn && !/^(disconnect|disconnecting|error)$/.test(ev)) {
              ;(f.socketEvents ??= new Map()).set(ev, fnLike(fn) ? collect(sf, fn, empty(printer.printNode(ts.EmitHint.Unspecified, fn, sf))) : empty(''))
              if (ts.isIdentifier(fn)) (f.socketRefs ??= new Map()).set(ev, fn.text)
            }
          }
          ts.forEachChild(x, walk)
        }
        walk(cb)
      }
      // (a guard plain may not read: a named one, io.use(requireLogin), or one that can turn people away, next(new Error(...)):
      // its being there means a guard isn't gone; not io.use(wrap(session)) or one that only logs)
      // (a local one is read: it has to be able to turn people away and be about who's asking, not a logger or a rate limiter)
      const looksLogin = (t: string) => /next\s*\(\s*new\s+Error/.test(t) && /token|cookie|auth|jwt|session|user/i.test(t)
      if (n.expression.name.text === 'use' && servers.has(recv) && cb) {
        const local = ts.isIdentifier(cb) ? sf.statements.map(st => ts.isFunctionDeclaration(st) && st.name?.text === cb.text ? st.getText(sf) : ts.isVariableStatement(st) ? st.declarationList.declarations.find(d => ts.isIdentifier(d.name) && d.name.text === cb.text)?.getText(sf) : undefined).find(Boolean) : undefined
        if (ts.isIdentifier(cb) ? local === undefined || looksLogin(local) : fnLike(cb) && looksLogin(cb.getText(sf))) f.socketGuardish = true
      }
      // (the guard's own test is about who's asking: `if (!token)`, not `if (!room)`)
      if (n.expression.name.text === 'use' && servers.has(recv) && cb && fnLike(cb) && /^socket$/.test((cb as ts.ArrowFunction).parameters[0]?.name.getText(sf) ?? '')) {
        const m = cb.getText(sf).match(/if\s*\(\s*!\s*([\w.?]+)\s*\)\s*(?:\{\s*)?return\s+next\s*\(\s*new\s+Error/)
        if (m && /token|cookie|auth|jwt|session|user/i.test(m[1])) f.socketAuth = true
      }
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
          // (an inline one, `router.use((req, res, next) => ...)`: not a login check by itself, but read for "only admins" on the routes
          // after it. Only with no path, written straight in a function body or the file (not under an if), not an error handler (four
          // parameters), and kept by router and enclosing function: two functions' `router`s are different routers)
          if (args[0] && fnLike(args[0]) && ts.isExpressionStatement(n.parent) && (ts.isSourceFile(n.parent.parent) || ts.isBlock(n.parent.parent) && ts.isFunctionLike(n.parent.parent.parent)))
            for (const a of args) if (fnLike(a) && (a as ts.ArrowFunction).parameters.length < 4) { const k = `${obj}@${scopeAt(n)}`; inlineMw.set(k, [...inlineMw.get(k) ?? [], a.getText(sf)]) }
        } else if (servers.has(obj) && HTTP.test(last) && arg?.startsWith('/') && args.length > 1) {
          addHandler(obj, last, arg, args.slice(1, -1), args.at(-1)!)
          return   // the handler's facts belong to the route, not to the whole file
        } else if (chain && servers.has(chain[1]) && HTTP.test(last) && args.length) {
          // (a guard for the whole chain: `router.route('/x').all(requireAuth).get(h)`)
          const all: ts.Expression[] = []
          for (let e: ts.Expression = callee.expression; ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression); e = e.expression.expression)
            if (e.expression.name.text === 'all') all.push(...e.arguments)
          addHandler(chain[1], last, chain[3], [...all, ...args.slice(0, -1)], args.at(-1)!)
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
        // (money: what charges someone; a refund, a price or a coupon is said apart, by outsidePhrase)
        // (Stripe's docs: capturing or confirming a payment, paying or finalizing an invoice and accepting a quote charge too)
        if (parts[0] === 'stripe' && (parts.at(-1) === 'create' && /^(?:checkout|paymentIntents|charges|subscriptions|subscriptionItems|subscriptionSchedules|invoices|invoiceItems|paymentLinks)$/.test(parts[1] ?? '')
          || /^(?:paymentIntents\.(?:capture|confirm)|charges\.capture|invoices\.(?:pay|finalizeInvoice)|quotes\.accept)$/.test(parts.slice(1).join('.')))) f.money = true
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
  // (made up: nothing in it reads a value from somewhere, apart from Date, Math, undefined or a mock list; not
  // `{ termsUrl: config.TERMS_URL }` or `{ ...settings }`, which read settings)
  const fixed = (e: ts.Node): boolean => {
    let ok = true
    const walk = (n: ts.Node) => {
      if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
        && !/^(Date|Math|Set|Map|Array|Object|String|Number|Boolean|undefined|NaN|Infinity)$/.test(n.text) && !/mock|fake|dummy|sample|demo|placeholder/i.test(n.text)) ok = false
      if (ts.isSpreadAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isFunctionLike(n)) ok = false
      if (ok && !ts.isTypeNode(n)) ts.forEachChild(n, walk)   // (`as Status`, `satisfies O`, `<string>` name types, not values)
    }
    walk(e)
    return ok
  }
  const bare = (e: ts.Expression): ts.Expression => ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) ? bare(e.expression) : e
  const made = (e: ts.Expression) => (ts.isArrayLiteralExpression(bare(e)) || ts.isObjectLiteralExpression(bare(e))) && !calc(e) && fixed(e)
  const visit = (n: ts.Node) => {
    if (ts.isAwaitExpression(n) || (ts.isCallExpression(n) && /prisma|fetch|supabase|db\./.test(n.expression.getText()))) real = true
    if (ts.isReturnStatement(n) && n.expression && made(n.expression)) literal = true
    if (ts.isArrowFunction(n) && !ts.isBlock(n.body) && made(n.body)) literal = true
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
  // Next.js route handlers and pages/api: logged in when each method that changes something (each method, when none does) checks in
  // its own code (`if (!session) return 401`, requireUser()). Calling auth() and ignoring the answer stops nobody.
  // (Before, calling auth() anywhere in the file was a ✓. Where that old ✓ isn't backed by a check plain can read, it now says
  // neither: no ✓, and no warning it didn't give before. Where it warned before, it still does unless the check is there.)
  // early: a return that lets requests through before the check (`if (req.method === 'DELETE') return deletePost(req, res)`);
  // not one that turns them away (`if (req.method !== 'POST') return res.status(405).end()`)
  const early = (g: FileFacts) => { const at = Math.min(...g.authIfs.filter(x => !x.g).map(x => x.at), ...g.skipIfs.filter(x => x.login).map(x => x.at), Infinity)
    return at < Infinity && g.skipIfs.some(sk => !sk.login && !sk.rej && sk.at < at) }
  // A ✓ also needs the session itself: the `if` tests a name that was set from auth(), getServerSession(), supabase.auth.getUser(),
  // ... (or from one of those names: `const user = session?.user`). An `if (!userId) return 400` on a userId from the body, or
  // `if (!user) return 404` after a findById, isn't a login, even next to an unrelated getToken() or firebase-admin's getAuth().
  // (Calls with no receiver, octokit.auth() isn't one; with nothing or the request passed in, getSession(chatId) isn't one.)
  const AUTHY = /auth|session|clerk|supabase|lucia|iron|kinde|user|account|login|firebase|next-auth|better-auth|@\/auth$|\/auth$/i
  const SESSION_CALL = /(?<![.\w$])(?:await\s+)?(auth|getServerSession|getSession|currentUser|getCurrentUser|getUser|getAuth|getServerAuthSession|getToken|validateRequest|requireUser|requireAuth|requireSession|requireLogin|requireAdmin)\s*\(([^()]*(?:\([^()]*\))?[^()]*)\)|\.auth\.getUser\s*\(|(?<![.\w$])auth\.api\.getSession\s*\(|(?<![.\w$])(?:await\s+)?getIronSession\s*\(/
  // (imported from somewhere about auth or users, or written in this file: not getSession() from '@/lib/chat-store')
  // (the call itself, not `(await getSession()) ?? { user: { id: body.userId } }` or `.catch(() => DEMO_SESSION)`)
  const sessionCall = (init: string, binds: Map<string, string>) => { const m = init.match(SESSION_CALL); if (!m || /\?\?|\|\||\.catch\s*\(|\s\?\s/.test(init)) return false
    if (!m[1]) return /^\(?\s*await\b/.test(init)
    if (binds.has(m[1]) && !AUTHY.test(binds.get(m[1])!)) return false
    // (awaited: a Promise is always there; Clerk's auth() / getAuth() may be sync)
    if (!/^(?:auth|getAuth)$/.test(m[1]) && !/^\(?\s*await\b/.test(init)) return false
    return (!m[2].trim() ? m[1] !== 'getAuth' : m[2].split(',').every(a => REQ_ARG.test(a.trim()))) }
  // the names, each true when the session object is always there (iron-session: test session.user, not session)
  // (one hop only as a plain property chain, `const user = session?.user`: not `searchParams.get('userId') || me?.id`;
  // not a name assigned again, `if (!user) user = await prisma.user.findUnique(...)`; one declarator per statement)
  const sessionNames = (text: string, binds: Map<string, string>) => {
    const out = new Map<string, boolean>(), re = (x: string) => x.replace(/\$/g, '\\$')
    for (let pass = 0; pass < 2; pass++) for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+|\{[^=]*\})\s*(?::\s*[^=;\n]+)?=\s*([^;\n]+)/g)) {
      if (/,\s*[\w$]+\s*(?::[^=]+)?=(?![=>])/.test(m[2])) continue
      const from = m[2].trim(), src = pass === 0 && sessionCall(from, binds)
      const hop = pass === 1 && [...out.keys()].find(x => new RegExp(String.raw`^(?:await\s+)?\(?\s*${re(x)}(?:\s*\??\.\s*[\w$]+)*\s*\)?!?$`).test(from))
      if (!src && !hop) continue
      for (const id of m[1].startsWith('{') ? m[1].replace(/[\w$]+\s*:/g, '').match(/[\w$]+/g) ?? [] : [m[1]])
        if ((text.match(new RegExp(String.raw`(?<![\w$.])${re(id)}\s*(?:[-+*/|&?]{0,2})=(?![=>])`, 'g')) ?? []).length <= 1)
          out.set(id, src ? /getIronSession/.test(from) && !m[1].startsWith('{') : out.get(hop as string)! && from.trim() === hop)
    }
    return out
  }
  const testsSession = (g: FileFacts, binds: Map<string, string>) => {
    const names = sessionNames(g.printed, binds)
    // (testing that it's there: `!session`, `session?.user == null`, `user.role !== 'admin'`; not `session?.user?.id !== userId`, which a
    // guest passes by leaving userId out)
    const uses = (c?: string) => !!c && [...names].some(([x, always]) => { const n = String.raw`(?<![\w$.])${x.replace(/\$/g, '\\$')}${always ? LOGIN_FIELD : '\\b'}`
      return new RegExp(String.raw`!\s*\(?\s*${n}|${n}[\w$?.\s]*(?:===?\s*(?:null|undefined|false)\b|!==?\s*['"\x60])`).test(c) })
    const free = (at: number) => !(g.tries ?? []).some(([a, b]) => at > a && at < b)
    return g.authIfs.some(x => !x.g && !x.req && !x.noReturn && free(x.at) && uses(x.cond)) || g.skipIfs.some(x => x.login && free(x.at) && uses(x.c)) }
  // (an iron-session object is always there: only its login fields say who's logged in, not session.csrfToken or session.cartId)
  const LOGIN_FIELD = String.raw`\s*\??\.\s*(?:user|userId|isLoggedIn|loggedIn|uid|account|accountId|email)\b`
  // a helper's own check stops its caller: it throws or redirects for guests (not a returned 401, not inside a try)
  const helperStops = (h: FileFacts, binds: Map<string, string>) => { if (h.skipIfs.length || /\btry\b/.test(h.printed)) return false
    const names = sessionNames(h.printed, binds)
    return h.authIfs.some(x => !x.g && !x.req && !x.ret && !!x.cond && [...names].some(([n, always]) => new RegExp(String.raw`(?<![\w$.])${n.replace(/\$/g, '\\$')}\b${always ? LOGIN_FIELD : ''}`).test(x.cond!))) }
  const nextHandlers = new Set<string>()
  for (const [p, r] of routes) if (r.kind === 'endpoint' && 'next' in deps_ && /^(?:src\/)?(?:app\/(?:.*\/)?route|pages\/api\/.*)\.[jt]sx?$/.test(p)) {
    nextHandlers.add(p)
    const f = files.get(p)!, t = snap.get(p) ?? ''
    // A require*() call counts only when plain finds it (in this file, or the file it's imported from under that name) and its
    // check stops guests by throwing or redirecting; one it can't find (a barrel, a package, cache(), a rename) or one that returns
    // a 401 the route ignores doesn't. Clerk's protect() counts. So does a helper in this file awaited first (getUserOrThrow()).
    const found = (n: string) => { const q = f.locals.has(n) ? p : target(p, n), h = q ? files.get(q)?.locals.get(n) : undefined; return h && helperStops(h, files.get(q!)!.binds) }
    // (not when the route catches what they throw: a try around them, `.catch(() => null)`; Clerk v6's auth.protect() awaited)
    const reqOk = (g: FileFacts) => !/\btry\b|\.catch\s*\(/.test(g.printed) && (/\bawait\s+auth\.protect\s*\(|(?<![\w$.])auth\(\)\.protect\s*\(|\(\s*await\s+auth\(\)\s*\)\s*\.protect\s*\(/.test(g.printed) || (() => {
      const calls = [...g.printed.matchAll(new RegExp(String.raw`(?<![.\w$])(?:await\s+)?${REQUIRE_LOGIN.source.slice(1, -1)}\s*\(`, 'g'))]
      return calls.length > 0 && calls.every(m => /^await\s/.test(m[0]) && found(m[1])) })())
    const lead = (g: FileFacts) => (g.leadCalls ?? []).some(n => f.locals.has(n) && helperStops(f.locals.get(n)!, f.binds))
    // (no switch: a case may hand a method off before the check; a check inside a try may be caught, see testsSession)
    const checks = (g?: FileFacts) => !!g && !early(g) && !/\bswitch\s*\(/.test(g.printed)
      && (g.authIfs.some(x => !x.g && x.req) && reqOk(g) || testsSession(g, f.binds) || lead(g))
    let yes: boolean
    // (a method exported under another name, `export { remove as DELETE }`, `export const DELETE = remove`: plain may not see it)
    const hidden = /export\s*\{[^}]*\b(?:GET|POST|PUT|PATCH|DELETE)\b|export\s*\*\s*from|export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE)\s*=\s*[\w$.]+\s*;?\s*$|export\s+const\s+[^;]*,\s*(?:GET|POST|PUT|PATCH|DELETE)\s*=/m.test(t)
    if (/^(?:src\/)?pages\/api\//.test(p)) {
      // the default-exported handler: export default function handler(req, res) / export default handler / export default async (req, res) => ...
      // (read from the printed file: no comments, so a commented-out check is gone). Not next-connect's chain: a check in .get()
      // says nothing about .delete().
      const pt = f.printed, name = pt.match(/export\s+default\s+(?:async\s+)?function\s+(\w+)/)?.[1] ?? pt.match(/export\s+default\s+(\w+)\s*;?\s*$/m)?.[1]
      yes = !f.exportChain && checks(name ? f.locals.get(name) : f.exportG)
    } else {
      const ms = METHODS.filter(m => f.fns.has(m)), writes = ms.filter(m => m !== 'GET'), deciding = writes.length ? writes : ms
      yes = deciding.length > 0 && deciding.every(m => checks(f.locals.get(m))) && !hidden
    }
    // A check plain can see but not prove: `const session = await getMobileCompatibleSession(req); if (!session?.user) return 401`,
    // the helper imported from a module about auth or sessions. No ✓, but no "anyone can use" either. The same rules as a ✓ otherwise:
    // nothing hands the request off before it (early, a switch), and inside a try it returns (a throw there may be caught). The
    // helper is named like a session getter (not hashPassword), takes the request (not parsed options), and its name isn't set again.
    const seen = (g?: FileFacts) => !!g && !early(g) && !/\bswitch\s*\(/.test(g.printed) && [...g.printed.matchAll(/\b(?:const|let)\s+([\w$]+)\s*(?::[^=]+)?=\s*await\s+([\w$]+)\s*\(([^()]*)\)/g)]
      .some(m => AUTHY.test(f.binds.get(m[2]) ?? '') && /session|user|auth|current|viewer|me$/i.test(m[2]) && !/hash|password|create|update|delete|sign(?:in|up|out)|log(?:in|out)|register/i.test(m[2])
        && (!m[3].trim() || m[3].split(',').every(a => /^(?:req|request|ctx|context|event|(?:await\s+)?(?:headers|cookies)\(\))$/.test(a.trim())))
        && (g.printed.match(new RegExp(String.raw`(?<![\w$.])${m[1].replace(/\$/g, '\\$')}\s*(?:[-+*/|&?]{0,2})=(?![=>])`, 'g')) ?? []).length <= 1
        // (and the check is the very next statement: nothing writes before it, and it isn't inside a loop a guest can skip)
        && new RegExp(String.raw`^\s*;?\s*if\s*\(\s*(?:!\s*\(?\s*${m[1].replace(/\$/g, '\\$')}\b|${m[1].replace(/\$/g, '\\$')}\b[\w$?.\s]*===?\s*(?:null|undefined)\b)`).test(g.printed.slice(m.index! + m[0].length))
        && g.authIfs.some(x => {
        const n = m[1].replace(/\$/g, '\\$'), inTry = (g.tries ?? []).some(([a, b]) => x.at > a && x.at < b)
        return !x.g && !x.noReturn && (x.ret || !inTry) && !!x.cond && new RegExp(String.raw`!\s*\(?\s*${n}\b|(?<![\w$.])${n}\b[\w$?.\s]*===?\s*(?:null|undefined)\b`).test(x.cond) }))
    const handlers = /^(?:src\/)?pages\/api\//.test(p) ? [f.exportG ?? f.locals.get(f.printed.match(/export\s+default\s+(?:async\s+)?function\s+(\w+)/)?.[1] ?? f.printed.match(/export\s+default\s+(\w+)\s*;?\s*$/m)?.[1] ?? '')]
      : (ms => (ms.some(m => m !== 'GET') ? ms.filter(m => m !== 'GET') : ms).map(m => f.locals.get(m)))(METHODS.filter(m => f.fns.has(m)))
    if (!yes && (f.auth || f.sbAuth || !hidden && !f.exportChain && handlers.length > 0 && handlers.every(seen))) (f as FileFacts & { guardUnknown?: boolean }).guardUnknown = true
    f.auth = yes
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
  const pyPrefix = (file: string, server: string, seen = new Set<string>()): { path: string; guard: boolean; override: boolean; found?: boolean } => {
    const k = `${file}::${server}`, m = pyMounts.get(k)
    if (!m || seen.has(k)) return { path: '', guard: false, override: false }
    seen.add(k)
    const pf = !pyServer(m.from, m.server) && files.get(m.from)!.binds.has(m.server) ? target(m.from, m.server) ?? m.from : m.from   // parent imported too
    const up = pyPrefix(pf, m.server, seen), parent = pyServer(pf, m.server)
    return { path: up.path + (up.override ? '' : (parent?.prefix ?? '').replace(/\/$/, '')) + m.path, guard: up.guard || !!parent?.guard || m.guard, override: m.override, found: true }
  }
  const pyAliases = new Map([...files.values()].flatMap(f => [...((f as PyFacts).aliases ?? [])]))
  const pyAppGuard = [...files.values()].some(f => (f as PyFacts).appGuard)
  const pyRoute = (p: string, h: FileFacts['handlers'][number]) => {
    let file = p, own = h.own ?? '', g = false
    if (h.imported) { const q = target(p, h.server); if (q) { file = q; own = pyServer(q, h.server)?.prefix ?? ''; g = !!pyServer(q, h.server)?.guard } }
    const P = pyPrefix(file, h.server)
    // (a router mounted nowhere plain can see, `for m in ROUTER_MOUNTS: router.include_router(m.router, prefix=m.prefix)`: its address
    // is only the end of the real one, written "…/x", and the place is named for its folder)
    // (no include_router(...) anywhere leads to it: not `include_router(api_router)` after `from app.api import router as api_router`,
    // not `include_router(users.router)`; `include_router(mount.router)` over a list does)
    const traced = () => [...files].some(([q, f]) => q.endsWith('.py') && [...f.printed.matchAll(/include_router\(\s*([\w.]+)/g)].some(m => { const [head, attr] = m[1].split('.')
      return target(q, head) === file && (!attr || attr === h.server) || q === file && head === h.server }))
    const lost = !!pyServer(file, h.server)?.router && !P.found && !pyServer(file, h.server)?.prefix && [...files.values()].some(f => /\binclude_router\b/.test(f.printed)) && !traced()
    const url = (P.path + (P.override ? '' : own.replace(/\/$/, '')) + h.path).replace(/(.)\/$/, '$1') || '/'
    return { url: lost ? ('/…' + url).replace(/(.)\/$/, '$1') : url,
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
  // (not an error handler, `(err, req, res, next)`: Express skips it on ordinary requests; nor one that sets the user or the role from
  // what the visitor sends: `req.user.role = req.body.role`)
  const setsFromRequest = (t: string) => [...t.matchAll(/\b(?:req|request)\.user\b[\w.?!]*\s*=(?!=)\s*([^;\n]+)/g)].some(m => FROM_REQUEST.test(m[1]))
  const adminText = (t: string) => !setsFromRequest(t) && !/^\s*(?:export\s+)?(?:const\s+\w+\s*=\s*)?(?:async\s*)?(?:function\s*\w*\s*)?\(\s*[\w$]+(?:\s*:[^,)]*)?\s*,\s*[\w$]+(?:\s*:[^,)]*)?\s*,\s*[\w$]+(?:\s*:[^,)]*)?\s*,\s*[\w$]+(?:\s*:[^,)]*)?\s*\)/.test(t) && [...t.matchAll(/\bif\s*\(/g)].some(m => {
    const k = m.index!, open = k + m[0].length - 1
    let d = 0, j = open; for (; j < t.length; j++) { if (t[j] === '(') d++; else if (t[j] === ')' && --d === 0) break }
    const cond = t.slice(open + 1, j), pos = adminPos(cond)
    if (!pos && !adminCond(cond)) return false
    // (the flag's variable set from the request earlier: `const u = req.body`, `const h = req.headers`)
    const v = cond.match(/^[\s!(]*([\w$]+)/)?.[1], src = v ? t.slice(0, k).match(new RegExp(String.raw`\b(?:const|let|var)\s+(?:${v.replace('$', '\\$')}|\{[^}]*\b${v.replace('$', '\\$')}\b[^}]*\})\s*=\s*([^;\n]+)`))?.[1] : undefined   // (or destructured: `const { role } = req.query`)
    if (src && (FROM_REQUEST.test(src) || /^\s*(?:req|request)\.(?:query|headers|body|params|cookies)\b/.test(src))) return false
    const stack: { ctrl: boolean; fn: boolean; at: number }[] = []
    for (let x = 0; x < k; x++) { if (t[x] === '{') { const before = t.slice(Math.max(0, x - 200), x)
        stack.push({ ctrl: CONTROL.test(before.split(/[;}]/).pop()!), fn: /=>\s*$|\bfunction\b[^{;]*\)\s*(?::[^{;]*)?$|\)\s*(?::[^{;=]*)?$/.test(before) && !CONTROL.test(before.split(/[;}]/).pop()!), at: x }) } else if (t[x] === '}') stack.pop() }
    // (not inside another if, loop or try, nor inside a callback: `.then(u => { if (...) ... })` runs later, if at all)
    if (stack.some(s => s.ctrl) || stack.filter(s => s.fn).length > 1) return false
    // (nothing before it in the same function lets requests through: `if (req.method === 'GET') return next()`, a bare next(), next
    // handed on: `.then(next)`)
    if (/\breturn\b|\bnext\b/.test(t.slice((stack.at(-1)?.at ?? -1) + 1, k))) return false
    const rest = t.slice(j + 1).replace(/^\s*/, '')
    let branch = rest.split(/;|\n/)[0]
    if (rest[0] === '{') { let e = 0, q = 0; for (; q < rest.length; q++) { if (rest[q] === '{') e++; else if (rest[q] === '}' && --e === 0) break } branch = rest.slice(0, q + 1) }
    // (the other way round: admins go on, and the next statement turns everyone else away)
    if (pos) { const after = rest.slice(branch.length).replace(/^[\s;]*/, '').split(/;|\n/)[0]
      return /^return\s+next\s*\(\s*\)|^\{?\s*return\s+next\s*\(\s*\)/.test(branch.replace(/^\{\s*/, '')) && DENY_NEAR.test(after) && /^(return|throw)\b/.test(after) && !/\bnext\s*\(|\?/.test(after) }   // (not `return req.method === 'GET' ? next() : res.status(403)`)
    return DENY_NEAR.test(branch) && /\breturn\b|\bthrow\b|\bnext\(\s*(?:new\b|create\w*\(|err)/.test(branch) && !/\bnext\s*\(\s*\)/.test(branch) })   // (not a 403 that goes on anyway: `return next()`)
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
        // Next.js: a helper of this app that turns guests away (requireWorkspaceMember -> requireUser -> redirect('/login')), among
        // the action's lead calls (first, awaited, unconditional). The helper has to stop them itself (redirect, throw, notFound:
        // not `return null`, which the action carries on from), with no early way out, or lead-call one that does (two levels).
        // Not one imported under another name (plain would read the wrong function).
        if (h.nextAction) { const stops = (at: string, n: string, depth: number): boolean => { const q = files.get(at)?.locals.has(n) ? at : target(at, n), c = q ? files.get(q)?.locals.get(n) : undefined
            if (q && q !== at && new RegExp(String.raw`\b\w+\s+as\s+${n}\b`).test(files.get(at)?.printed ?? '')) return false
            if (!c) return REQUIRE_LOGIN.test(n)   // (a requireUser plain can't read: trusted by its name, as a lead call)
            // (its own check: not by a require* call (that counts only as its lead call), and no try whose catch doesn't rethrow)
            // (a catch rethrows only with `throw <its error>` or unstable_rethrow; one that throws only for other errors swallows the redirect)
            // (rethrows: `throw e` first, or guarded by isRedirectError(e), or unstable_rethrow(e); `if (e instanceof ZodError) throw e`
            // still swallows the redirect)
            const swallows = [...c.printed.matchAll(/\bcatch\s*(?:\(\s*(\w+)[^)]*\))?\s*\{([^}]*)\}/g)].some(m => { const v = m[1], body = m[2].trim()
              // (each only as the catch's first statement; `if (!isRedirectError(e)) throw e` rethrows everything but the redirect)
              return !v || !new RegExp(String.raw`^(?:throw\s+${v}\b|unstable_rethrow\(\s*${v}\s*\)|if\s*\(\s*isRedirectError\(\s*${v}\s*\)\s*\)\s*\{?\s*throw\s+${v}\b)`).test(body) })
            // (and its check throws or redirects: one that returns a 401 Response leaves the action going)
            return c.authIfs.some(x => !x.g && !x.req) && !c.skipIfs.length && !swallows && (/\bthrow\b|(?<!\.)\bredirect\s*\(|(?<!\.)\bnotFound\s*\(/.test(c.printed) || !/\breturn\b[^;\n]*(?:status\s*:\s*40[13]|\.status\(\s*40[13])/.test(c.printed)) || depth < 2 && (c.leadCalls ?? []).some(m => stops(q!, m, depth + 1)) }
          ;(h as { helperGuard?: boolean }).helperGuard = (hf.leadCalls ?? []).some(n => stops(p, n, 0))
          // "Only the workspace's members": a lead-call helper that stops guests (above) and checks the logged-in user's membership of the
          // value it's given (src/members.ts), directly or through a helper it passes that same value to; and the action keeps every read
          // and write to that value. No write made by a helper plain follows (it couldn't check it). Not one imported under another name.
          // (and which roles: a helper that runs the member check, then right away turns away every role but some, on the role the member
          // check returns from the user's own membership: requireWorkspaceAdmin -> "owners and admins")
          const navOf = (q: string) => new Set([...files.get(q)!.binds].filter(([, m]) => m === 'next/navigation').map(([x]) => x))
          const memberOf = (at: string, n: string, depth: number, info: { ownRole?: boolean; roles?: string[] } = {}): string | undefined => { const q = files.get(at)?.locals.has(n) ? at : target(at, n), c = q ? files.get(q)?.locals.get(n) : undefined
            // (nor a default import: `import requireWorkspaceMember from ...` runs the module's default, whatever it's named)
            if (!c || q !== at && new RegExp(String.raw`\b\w+\s+as\s+${n}\b|\bimport\s+${n}\s*(?:,|from\b)`).test(files.get(at)?.printed ?? '')) return undefined
            const params = c.printed.match(/^[^(]*\(([^)]*)\)/)?.[1].split(',').map(x => x.trim().split(/[\s:=?]/)[0]).filter(Boolean) ?? []
            if (params.length !== 1) return undefined   // (one value in: not `(workspaceId, userId)`, where the user is given)
            const own = memberCheck(c.printed, params[0], c.leadCalls ?? [], navOf(q!), info)
            if (own) return own
            if (depth >= 1) return undefined
            for (const m of (c.leadCalls ?? []).filter(m => new RegExp(String.raw`\bawait\s+${m}\s*\(\s*${params[0]}\s*\)`).test(c.printed))) {
              const sub: { ownRole?: boolean } = {}, g = memberOf(q!, m, depth + 1, sub)
              if (g) { info.roles = sub.ownRole ? roleGate(c.printed, m, params[0], navOf(q!)) : undefined; return g } }
            return undefined }
          const lead = (hf.leadCalls ?? []).find(n => stops(p, n, 0) && memberOf(p, n, 0)), arg = lead && hf.printed.match(new RegExp(String.raw`\bawait\s+${lead}\s*\(\s*(\w+)\s*\)`))?.[1]
          const roleInfo: { roles?: string[] } = {}, group = lead && memberOf(p, lead, 0, roleInfo)
          // (helpers it follows, other than its login and membership checks, touch no tables: plain doesn't check their reads)
          const checks = new Set<string>(); const chain = (at: string, n: string, d: number) => { const q = files.get(at)?.locals.has(n) ? at : target(at, n); if (!q) return
            checks.add(`${q}:${n}`); if (d < 3) for (const m of files.get(q)?.locals.get(n)?.leadCalls ?? []) chain(q, m, d + 1) }
          if (lead) chain(p, lead, 0)
          // (and every name it takes from its file is Prisma, Next's own, zod, the login helper, or a small local function that touches
          // nothing (`validStatus`): not a helper that may write elsewhere (`projectRepo.archive(id)`, a namespace, a barrel, a class, a
          // function passed to `.map`), nor any `import()` / `require`. By the parser.)
          const nsImports = [...(files.get(p)?.printed ?? '').matchAll(/\bimport\s*\*\s*as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]/g)].map(m => [m[1], m[2]] as [string, string])
          const modOf = new Map([...(files.get(p)?.binds ?? []), ...nsImports]), tops = topLevel(files.get(p)?.printed ?? ''), sc = scan(hf.printed)
          const pure = (x: string) => { const t = tops.get(x); if (!t?.fn || /\bprisma\b|\bawait\b/.test(t.text)) return false
            const s2 = scan(t.text); return !s2.dynamic && [...s2.idents].every(y => y === x || !tops.has(y) && !modOf.has(y)) }
          const importsKnown = !sc.dynamic && !tops.has('...') && [...sc.idents].every(x => x === h.handler || x === lead || !tops.has(x) && !modOf.has(x)
            || x === 'prisma' && modOf.has('prisma') && !tops.has('prisma') || /^(?:next\/(?:cache|navigation|headers)|zod)$/.test(modOf.get(x) ?? '') || pure(x))
          if (lead && arg && group && importsKnown && keepsTo(hf.printed, arg, group[0].toLowerCase() + group.slice(1) + 'Id', lead) && [...seen].slice(1).every(x => { const i = x.lastIndexOf(':'), g = files.get(x.slice(0, i))?.locals.get(x.slice(i + 1)); return checks.has(x) ? !g?.written.size : !g?.tables.size && !g?.written.size }))
            (h as { member?: string }).member = words(group) + (roleInfo.roles?.length ? `|${roleInfo.roles.join(',')}` : '') }
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
      if (!h.admin && (mwGuard && (h.mw.some(m => adminMw(p, m)) || ((h as { adminInline?: string[] }).adminInline ?? []).some(m => adminText(m))) || pre!.guard && pre!.mws.some(x => adminMw(x.p, x.n)))) h.admin = true
      // (a guard still named for it that plain can't read, requireRole('admin') from a package: it may still be there; one plain
      // reads and finds empty, a gutted requireAdmin, isn't)
      // (or a factory given the role, requireRole('admin'): its test is on a parameter plain doesn't follow)
      if ([...h.mw.map(n => ({ p, n })), ...pre!.mws].some(x => /admin|role|staff|superuser|permission/i.test(x.n) && readable(x.p, x.n) === undefined || /\(\s*['"](?:super[-_]?)?(?:admin|staff|superuser)['"]/i.test(x.n))) (unit as FileFacts & { adminish?: boolean }).adminish = true
      // (a GET that updates or deletes changes things too: its login decides, like a POST's)
      // (a Next.js server action: its own structural check, not any auth() call next to a success redirect)
      const writes = h.method !== 'GET' || getWrites, guard = h.nextAction ? hf.authIfs.some(x => !x.g && !x.req) || hf.authReturn || !!(h as { helperGuard?: boolean }).helperGuard : pre!.guard || mwGuard || !!py?.guard || (hf.auth || hf.sbAuth) && STOPS.test(hf.printed) || guardedPaths.some(g => url === g || url.startsWith(g.replace(/\/$/, '') + '/'))
      const u = unit as FileFacts & { w?: boolean[]; r?: boolean[]; wu?: string[]; ru?: string[]; wa?: boolean[]; ra?: boolean[] }
      ;(writes ? (u.w ??= []) : (u.r ??= [])).push(guard)
      unit.auth = (u.w?.length ? u.w : u.r!).every(Boolean)
      // "only admins": every handler that decides checks for an admin (and the reads, said apart when they don't)
      ;(writes ? (u.wa ??= []) : (u.ra ??= [])).push(guard && !!h.admin)
      unit.admin = unit.auth && (u.w?.length ? u.wa! : u.ra!).every(Boolean)
      if (h.nextAction) (unit as FileFacts & { member?: string }).member = guard ? (h as { member?: string }).member : undefined
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
      // (a local import plain can't find, a file not in the project: the page may do things plain can't see)
      // (code only, with no file anywhere ending in that path: `~/components/Box` may live in app/, `./logo.svg?react` is an image,
      // SvelteKit's `./$types` and React Router's `./+types/x` are made at build time)
      const tail = spec.replace(/\?.*$/, '').replace(/^(?:\.{1,2}\/)+|^[@~]\//, '')
      if (!q && /^(?:\.{1,2}\/|@\/|~\/)/.test(spec) && !/\.\w+$/.test(tail) && !/(?:^|\/)(?:\$types|\+types\/\S*)$/.test(tail) && ![...files.keys()].some(k => new RegExp(String.raw`(^|/)${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/index)?\.(?:[cm]?[jt]sx?|vue|svelte)$`).test(k)))
        (into as FileFacts & { unread?: boolean }).unread = true
      // lib/ and server code (server actions, server/, *.server.ts) aren't part of what the page shows; calls to them are
      if (!q || seen.has(q) || /(^|\/)lib\//.test(q) || page && (/(^|\/)server\/|\.server\.[jt]sx?$/.test(q) || files.get(q)!.serverFns.size)) continue
      // the app's own frame isn't the page: a layout (or anything in layouts/), shell, sidebar, navbar, header or footer. (Not "used by
      // many pages": shared buttons and boxes are too.)
      // (papermark's AppLayout put every menu, billing button and settings link on a new redaction page)
      if (page && (CHROME.test(q.split('/').pop()!.replace(/\..*$/, '')) || /(^|\/)layouts?\//.test(q))) continue
      seen.add(q)
      const c = files.get(q)!, self = files.get(p)!
      // useAuth() from a context: its login/logout calls are the whole app's, not this page's, unless the page renders the provider.
      // Only the app's own auth addresses (/api/auth/login, /logout, GET /me), not /me/favorites or a tutor's /sessions; and they still
      // count as something the page can change (a sign-up page isn't "only shows information").
      const appWide = /\bcreateContext\s*[<(]/.test(snap.get(q) ?? '') && ![...self.binds].some(([k, m]) => m === spec && self.jsx.has(k))
        ? /^GET (\/api)?\/(auth\/)?me$|^\S+ (\/api)?\/(auth\/)?(login|logout|signin|signout|sign-in|sign-out|signup|sign-up|register|session|refresh|guest)$/ : undefined
      const quiet = ((into as FileFacts & { quiet?: Set<string> }).quiet ??= new Set())
      for (const x of (c as FileFacts & { quiet?: Set<string> }).quiet ?? []) quiet.add(x)
      for (const k of ['ui', 'fetches', 'links', 'outside', 'tables', 'written', 'ops'] as const) for (const x of c[k]) if (k === 'fetches' && appWide?.test(x)) quiet.add(x); else into[k].add(x)
      into.headings.push(...c.headings); into.forms += c.forms
      fold(q, into, seen, page)
    }
  }
  // (only bare frame names: Header, AppHeader, site-footer, Navbar; not PricingHeader or TableHeader, which are content)
  const CHROME = /^(?:(?:app|site|main|root|page|dashboard|admin|top|global)[-_]?)?(?:layout|shell|sidebar|side-bar|navbar|nav-bar|navigation|topbar|top-bar|header|footer)$/i
  for (const p of files.keys()) if (routes.has(p) && !p.includes('#')) fold(p, files.get(p)!, new Set([p]), routes.get(p)!.kind === 'page')
  // <form method="POST"> sends to its own page: SvelteKit's form actions (also from a child component, folded in above); elsewhere it says nothing
  for (const [p, f] of files) for (const x of [...f.fetches]) if (x.endsWith(' @self')) { f.fetches.delete(x); if (svelteUrls.has(p)) f.fetches.add(`POST ${svelteUrls.get(p)}`) }
  // Reading the session in the browser redirects nobody; on a server (edge function, Next.js) it's a real check.
  for (const k of routes.keys()) if (files.get(k)!.sbAuth && !browserPages.has(k) && !(routes.get(k)!.kind === 'page' && /^(?:src\/)?(?:app|pages)\//.test(k)) && !nextHandlers.has(k)) files.get(k)!.auth = true
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
    files, routes, db, models: all, schemaPath, target, pyModels, dzModels, csModels: new Set(csModels.keys()), javaModels: new Set(javaModels.keys()), phpModels: new Set(phpModels.keys()), rbModels: new Set(rbModels.keys()), goModels: new Set(goModels.keys()), goGorm, goDb, goOld,
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
const US = 'status|bus|campus|census|virus|bonus|corpus|focus|radius|syllabus|nexus|stimulus|genus|chorus|cactus|octopus|plus|surplus|consensus|abacus|onus|prospectus|thesaurus'
const singular = (s: string) => s.endsWith('ies') ? s.slice(0, -3) + 'y' : new RegExp(`(?:${US})es$`, 'i').test(s) ? s.slice(0, -2) : /(sses|xes|ches|shes)$/.test(s) ? s.slice(0, -2) : new RegExp(`(?:ss|sis|axis|tennis|chassis)$|(?:${US})$`, 'i').test(s) ? s : s.endsWith('s') ? s.slice(0, -1) : s   // boxes -> box (status, address, analysis stay)
// "owners and admins"; a role that isn't a kind of person reads as itself: "members with the billing or staff role"
const roleWords = (roles: string[]) => { const w = roles.map(x => words(x))
  return w.every(x => /^(?:owner|admin|super admin|superadmin|editor|member|manager|moderator|viewer|maintainer|contributor|guest|writer|reader|collaborator|developer|analyst|author|reviewer)$/.test(x))
    ? list(w.map(pluralize)) : `members with the ${w.length < 2 ? w[0] : `${w.slice(0, -1).join(', ')} or ${w.at(-1)}`} role` }
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
  const segs = url.replace(/^\/functions\/v1\//, '/').split('/').filter(s => s && s !== 'api' && s !== '…')
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
  if (svc === 'Stripe' && /^refunds\.create$/.test(chain)) return 'gives customers money back 💰'
  if (svc === 'Stripe' && /^(?:prices|plans)\.create$/.test(chain)) return 'adds a price in Stripe 💰'   // (an update can't change the amount)
  if (svc === 'Stripe' && /^(?:paymentIntents\.(?:capture|confirm)|charges\.capture|invoices\.(?:pay|finalizeInvoice)|quotes\.accept)$/.test(chain)) return `asks Stripe to ${{ capture: 'collect a payment', confirm: 'confirm a payment', pay: 'collect an invoice', finalizeInvoice: 'send an invoice for payment', accept: 'accept a quote' }[chain.split('.')[1]]}`
  if (svc === 'Stripe' && chain === 'creditNotes.create') return 'gives customers credit or money back 💰'
  if (svc === 'Stripe' && /^(?:transfers|payouts)\.create$/.test(chain)) return 'sends money out of your Stripe balance 💰'
  if (svc === 'Stripe' && chain === 'coupons.create') return 'creates a Stripe discount 💰'   // (often a one-off amount off at checkout)
  if (svc === 'Stripe' && chain === 'promotionCodes.create') return 'makes Stripe discount codes 💰'
  const parts = chain.split('.'), verb = parts.at(-1)!, what = singular(words(parts.at(-2) ?? ''))
  return VERBS[verb] ? `asks ${svc} to ${VERBS[verb]} ${verb === 'list' ? pluralize(what) : an(what)}` : `calls ${svc} (${chain})`
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

export type Change = { group: 'Pages' | 'Server' | 'Database' | 'Outside services' | 'Other files'; isNew?: boolean; text: string; detail?: string; name?: string; money?: boolean; vague?: boolean }
export type Problem = { kind: 'Broken' | 'Unsafe' | 'Check'; text: string }
// ponytail: name-based guess at what's sensitive; a config file can override it later
const SENSITIVE = /admin|account|user|order|payment|coupon|refund|checkout|settings/i
// Addresses that have to work before you're logged in (or are called by other services): never "missing a login check".
// Webhooks and sign-in callbacks anywhere in the address; login pages only as the last part, and never under admin.
const PUBLIC = /^(login|log in|register|registration|signup|sign up|signin|sign in|logout|log out|signout|sign out|forgot password|reset password|verify|verify email|health|token|access token|refresh|refresh token)$/   // token: OAuth2 password login
const isPublic = (url: string) => url === '/session' || /^\/passwords(\/|$)/.test(url) || !/admin/i.test(url) && (   // /session: Rails 8's login (resource :session)
  named(url).some(s => /\b(webhooks?|callback|oauth)\b/.test(s)) || PUBLIC.test(named(url).at(-1) ?? ''))

// The same code, or the same apart from parameters nobody reads at the end of a function's list (`async (event) => {...}` ->
// `async () => {...}`): dropping those changes nothing when the function runs. Not one in the middle (the ones after it move),
// a destructured one or one with a default, nor in a function that reads `arguments`. Not in a function of 4 or more
// (Express tells error handlers by their 4 parameters), nor a constructor's `private db: Db` or a decorated one.
// (whether a name is read is decided on the syntax tree: `...props` and `$request` count, a property name `x.event` doesn't)
const reads = (body: ts.Node, name: string) => { let hit = false
  const v = (x: ts.Node) => { if (hit) return
    if (ts.isIdentifier(x) && x.text === name && !(x.parent && (ts.isPropertyAccessExpression(x.parent) && x.parent.name === x || ts.isPropertyAssignment(x.parent) && x.parent.name === x))) hit = true
    else ts.forEachChild(x, v) }
  v(body); return hit }
const SAFE_WRAPPER = /^(?:defineEventHandler|eventHandler|defineCachedEventHandler|defineNitroPlugin|defineNuxtPlugin|defineNuxtRouteMiddleware|defineWebSocketHandler)$/
// (libraries that count a callback's parameters to decide how to call it: vue-router's next, mongoose and fastify's next/done)
const CALLBACK = /^(?:next|done|cb|callback|resolve|reject)$/
const shape = (t0: string, p: string) => {
  // (plain's own `[login: …]` note at the end isn't code: set aside, and kept, so a login change still counts)
  const tail = t0.match(/\s*\[login: \w+\]\s*$/)?.[0] ?? '', t = t0.slice(0, t0.length - tail.length)
  // (parsed as what the file is: a `<string>x` cast in a .ts file read as TSX turns the rest into JSX text. Code that doesn't parse cleanly isn't cut)
  const kind = /\.[cm]?ts$/.test(p) ? ts.ScriptKind.TS : /\.[cm]?jsx?$/.test(p) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX
  const sf = ts.createSourceFile(`x.${kind === ts.ScriptKind.TS ? 'ts' : kind === ts.ScriptKind.JSX ? 'jsx' : 'tsx'}`, t, ts.ScriptTarget.Latest, true, kind), cuts: [number, number][] = []
  if ((sf as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) return t0
  const visit = (n: ts.Node) => {
    // (a function handed to a call only when that call is a wrapper known not to count parameters: libraries do count them,
    // Svelte's derived, vue-router guards, mongoose hooks, Ramda's curry)
    const passed = !!n.parent && ts.isCallExpression(n.parent) && n.parent.arguments.includes(n as ts.Expression), callee = passed ? (n.parent as ts.CallExpression).expression.getText(sf).split('.').at(-1)! : ''
    if (ts.isFunctionLike(n) && 'body' in n && n.body && !ts.isSetAccessor(n) && (!passed || SAFE_WRAPPER.test(callee)) && !reads(n.body, 'arguments') && !reads(n.body, 'eval')) {
      const ps = n.parameters
      for (let i = ps.length - 1; i >= 0; i--) {
        const q = ps[i]
        if (!ts.isIdentifier(q.name) || CALLBACK.test(q.name.text) || q.initializer || q.dotDotDotToken || ts.getModifiers(q)?.length || ts.getDecorators(q)?.length || ps.length >= 4 || reads(n.body, q.name.text)) break
        cuts.push([i ? ps[i - 1].end : q.getStart(sf), q.end])
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  let out = t; for (const [x, y] of cuts.sort((a, b) => b[0] - a[0])) out = out.slice(0, x) + out.slice(y); return out + tail
}
// (JavaScript and TypeScript only, Vue and Svelte read as TypeScript; never PHP, Go or Python text)
// (Ruby, C#, Python... keep their code without comments and with spaces squeezed: a comment removed at the very top leaves a space)
// { minus } in a file's text, with strings, comments and heredocs taken out in one left-to-right pass (so '#fff' in a string or
// '//cdn' in a URL stays a string), and C#'s #else branches dropped (each branch may open the same block)
const braces = (t = '', q = '') => { const x = (/\.cs$/.test(q) ? t.replace(/^[ \t]*#(?:else|elif)\b[\s\S]*?(?=^[ \t]*#endif\b)/gm, '') : t)
    .replace(/<<<\s*['"]?(\w+)['"]?\n[\s\S]*?\n\s*\1\b|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#(?![\[{])[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`/g, '')
  return (x.match(/\{/g) ?? []).length - (x.match(/\}/g) ?? []).length }
// (JS and TS: TypeScript's own "'}' expected", exact where counting can't be)
const cutTs = (q: string, t?: string) => t !== undefined && !!(ts.createSourceFile(q, t, ts.ScriptTarget.Latest, false, /x$/.test(q) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(q) ? ts.ScriptKind.TS : ts.ScriptKind.JSX) as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics?.some(d => d.messageText === "'}' expected.")
const same = (p: string, a?: string, b?: string) => a === b || a !== undefined && b !== undefined && (a.trim() === b.trim()
  || /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(p.split('#')[0]) && shape(a, p.split('#')[0]) === shape(b, p.split('#')[0]))

const STORAGE_DELETE = /\b(?:utapi|UTApi\(\))\s*\.\s*deleteFiles\s*\(|\bDeleteObjects?Command\b|\.deleteObjects?\s*\(|->deleteObjects?\s*\(|\bdelete_objects?\s*\(|\buploader\s*\.\s*destroy\s*\(|\.storage\s*\.\s*from\s*\([^;]*?\)\s*\.\s*remove\s*\(|\bdeleteObject\s*\(\s*ref\b|\bStorage::(?:disk\([^)]*\)\s*->\s*)?delete\s*\(/

export type Analysis = ReturnType<typeof analyze>
type Opts = { ref: string; asked?: string; color?: boolean; agentSaid?: string }   // agentSaid: the agent's last message, if known
// Python call arguments, split at top-level commas (brackets and strings respected, # comments dropped): positional ones keyed '0', '1'…
function pyArgs(src: string): Map<string, string> {
  const parts: string[] = []; let cur = '', depth = 0, q = ''
  for (let i = 0; i < src.length; i++) { const c = src[i]
    if (q) { cur += c; if (c === '\\') cur += src[++i] ?? ''; else if (c === q) q = ''; continue }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === "'" || c === '"') q = c; else if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += c }
  parts.push(cur)
  const out = new Map<string, string>(); let n = 0
  for (const p of parts.map(x => x.trim()).filter(Boolean)) { const m = p.match(/^(\w+)\s*=(?!=)\s*([\s\S]*)$/); out.set(m ? m[1] : String(n++), (m ? m[2] : p).replace(/\s+/g, ' ')) }
  return out
}
// each `<re>(` call in Python source with its argument text (the re's first group names the call)
function pyCalls(src: string, re: RegExp): [string, string][] {
  const out: [string, string][] = []
  for (const m of src.matchAll(re)) { let depth = 0, q = '', i = m.index! + m[0].length - 1; const start = i + 1
    for (; i < src.length; i++) { const c = src[i]
      if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue }
      if (c === "'" || c === '"') q = c; else if (c === '(') depth++; else if (c === ')' && --depth === 0) break }
    out.push([m[1], src.slice(start, i)]) }
  return out
}
// A Django app's earlier migrations, read once: each operation with its arguments named (positional ones too: hand-written
// `AlterField('order', 'status', ...)`), in file order
const MIG_ARGS: Record<string, string[]> = { AddField: ['model_name', 'name', 'field'], AlterField: ['model_name', 'name', 'field'], RemoveField: ['model_name', 'name'],
  RenameField: ['model_name', 'old_name', 'new_name'], CreateModel: ['name', 'fields'], DeleteModel: ['name'], RenameModel: ['old_name', 'new_name'] }
function migOps(src: string): [string, Map<string, string>, string][] | undefined {
  // (the items of `operations = [...]`, every one: an imported RunSQL or TrigramExtension() counts too, under its own name; not the
  // dependencies, not code in functions above the class. Undefined when plain can't be sure that list is all of it: more than one
  // Migration class, `operations` named twice (a docstring, `+=`), a list joined with `+` or held in a variable, nested
  // state_operations or database_operations that aren't written out)
  const at = /\boperations\s*=\s*\[/.exec(src)
  if (!at || (src.match(/\(\s*migrations\.Migration\s*\)/g) ?? []).length !== 1 || (src.match(/(?<![\w.])operations\s*\+?=/g) ?? []).length !== 1
    || /\b(?:state|database)_operations\s*=\s*(?!\[)/.test(src)) return
  let depth = 0, q = '', i = at.index + at[0].length - 1
  for (; i < src.length; i++) { const c = src[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === "'" || c === '"') q = c; else if ('([{'.includes(c)) depth++; else if (')]}'.includes(c) && --depth === 0) break }
  if (!/^\s*(?:#[^\n]*)?(?:\n|$)/.test(src.slice(i + 1))) return   // (`[...] + [...]`)
  return [...pyArgs(src.slice(at.index + at[0].length, i)).values()].map(item => {
    const m = item.match(/^((?:\w+\.)*\w+)\s*\(([\s\S]*)\)$/), op = m ? m[1].replace(/^migrations\.(?=\w+$)/, '') : item
    const kw = m ? pyArgs(m[2]) : new Map<string, string>(); (MIG_ARGS[op] ?? []).forEach((k, n) => { if (kw.has(String(n)) && !kw.has(k)) { kw.set(k, kw.get(String(n))!); kw.delete(String(n)) } })
    return [op, kw, item] })
}
// the app's history in Django's order, when plain can be sure of it: every migration numbered 0001_ and so on, no two with one number
// (a branch and its merge), the new one depending on the one before it. Else undefined.
function migHistory(after: Snap, m: string) {
  const dirOf = m.replace(/[^/]*$/, ''), files = [...after.keys()].filter(p => p.startsWith(dirOf) && !p.slice(dirOf.length).includes('/') && p.endsWith('.py') && !p.endsWith('/__init__.py')).sort()
  const nums = files.map(p => p.slice(dirOf.length).match(/^(\d{4})_\w+\.py$/)?.[1])
  if (nums.some(n => !n) || new Set(nums).size !== nums.length) return
  const prev = files[files.indexOf(m) - 1]; if (!prev) return
  const deps = /\bdependencies\s*=\s*\[([^\]]*)\]/.exec(after.get(m) ?? '')?.[1] ?? ''
  if (!new RegExp(String.raw`['"]${prev.slice(dirOf.length, -3)}['"]`).test(deps)) return
  return files.slice(0, files.indexOf(m))
}
const unq = (x?: string) => x?.replace(/^['"]|['"]$/g, '')
// a Django field as the app's earlier migrations left it (the last CreateModel, AddField or AlterField that defines it; undefined
// when none does, or when a later operation renames, removes or replaces it)
function migField(ops: [string, Map<string, string>, string][], model: string, name: string): string | undefined {
  let last: string | undefined; const is = (x: string | undefined, y: string) => unq(x)?.toLowerCase() === y.toLowerCase()
  for (const [op, kw, raw] of ops) {
    // (anything else that names the field, a RunSQL or a SeparateDatabaseAndState: plain can't tell what it left)
    if (!/^(AddField|AlterField|RemoveField|RenameField|CreateModel|DeleteModel|RenameModel|AddIndex|RemoveIndex|RenameIndex|AddConstraint|RemoveConstraint|AlterModelOptions|AlterModelManagers|AlterUniqueTogether|AlterIndexTogether|AlterOrderWithRespectTo|RunPython)$/.test(op) && new RegExp(String.raw`\b${name.replace(/\W/g, '\\$&')}\b`, 'i').test(raw)) last = undefined
    else if ((op === 'AddField' || op === 'AlterField') && is(kw.get('model_name'), model) && is(kw.get('name'), name)) last = kw.get('field')
    else if ((op === 'RenameField' && (is(kw.get('new_name'), name) || is(kw.get('old_name'), name)) || op === 'RemoveField' && is(kw.get('name'), name)) && is(kw.get('model_name'), model)) last = undefined
    else if (op === 'DeleteModel' && is(kw.get('name'), model) || op === 'RenameModel' && (is(kw.get('old_name'), model) || is(kw.get('new_name'), model))) last = undefined
    else if (op === 'CreateModel' && is(kw.get('name'), model)) {
      // (each `('name', models.X(...))` in the fields list, read as a tuple: not a `('status', ...)` inside some field's choices)
      last = undefined
      for (const item of pyArgs((kw.get('fields') ?? '').trim().replace(/^\[|\]$/g, '')).values()) {
        const t = pyArgs(item.trim().replace(/^\(|\)$/g, '')); if (is(t.get('0'), name)) last = t.get('1') }
    }
  }
  return last
}
// the part of a Django field definition that reaches the database: its type and every option but the ones Django keeps only in code
// (positional arguments named; undefined for one plain can't read). The type keeps its module (`jsonfield.fields.JSONField` stores
// text, `models.JSONField` JSON), `to` its app (the migration's own when bare). on_delete counts when it's Django 6's DB_CASCADE and
// friends, which the database enforces.
function dbPart(field: string, model: string, app: string): string | undefined {
  const m = field.match(/^\s*((?:\w+\.)*\w+)\s*\(([\s\S]*)\)\s*$/); if (!m) return
  const type = m[1].replace(/^django\.db\.models\.(?:fields\.(?:related\.)?)?/, 'models.'), rel = /(?:^|\.)(ForeignKey|OneToOneField|ManyToManyField)$/.test(type), kw = pyArgs(m[2])
  for (const [i, k] of (rel ? ['to', 'on_delete'] : ['verbose_name']).entries()) if (kw.has(String(i))) { kw.set(k, kw.get(String(i))!); kw.delete(String(i)) }
  if ([...kw.keys()].some(k => /^\d+$/.test(k))) return
  const to = unq(kw.get('to'))
  if (to) kw.set('to', (to.toLowerCase() === 'self' ? `${app}.${model}` : /^['"]/.test(kw.get('to')!) && !to.includes('.') ? `${app}.${to}` : to).toLowerCase())
  // (only Django's own fields: another library's can keep an option in the column, like django-mysql's EnumField its choices)
  return [type, ...[...kw].filter(([k, v]) => !type.startsWith('models.') || !/^(blank|choices|editable|error_messages|help_text|limit_choices_to|related_name|related_query_name|validators|verbose_name)$/.test(k) && !(k === 'on_delete' && !/\bDB_/.test(v)))
    .sort().map(([k, v]) => `${k}=${v}`)].join(' ')
}
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
  // (an address plain only knows the end of, "…/[username]": named for the folder its file is in, `modules/user/routes.py` -> user)
  const GENERIC = /^(?:routes?|routers?|api|apis|views?|endpoints?|v\d+|app|src|backend|server|modules?|interfaces?|controllers?|handlers?|main|__init__|index)$/i
  // (the file's own name when it says something, views/orders.py -> orders, or else its nearest folder: modules/user/routes.py -> user)
  const folderName = (p: string) => { const parts = p.split('#')[0].split('/'); return [parts.at(-1)!.replace(/\.\w+$/, ''), ...parts.slice(0, -1).reverse()].find(s => !GENERIC.test(s)) }
  const placeName = (p: string) => { const r = route(p); if (!r) return p
    if (r.kind !== 'page' && r.url.startsWith('/…') && !named(r.url).length && folderName(p)) { const f = words(folderName(p)!), rest = named(r.url)
      const n = (rest.length && singular(rest[0].split(' ')[0]) === singular(f) ? rest : [f, ...rest]).join(' '); return `the ${n} part of your server` }
    return r.kind === 'page' ? pageName(r.url) : serverName(r.url) }
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).sort()
  const noise: string[] = [], real: string[] = []
  for (const p of changed) {
    const a = A.files.get(p), b = B.files.get(p)
    // (TypeScript's printer closes braces a cut-off file left open: a change in the raw balance is a change)
    if (NOISE.test(p) || (a && b && same(p, a.printed, b.printed) && !(/\.[cm]?[jt]sx?$/.test(p) && cutTs(p, after.get(p)) && !cutTs(p, before.get(p))))) noise.push(p)
    else real.push(p)
  }
  // Pages and addresses can change without their file changing: an Express route ("file#/api/x") inside a bigger file,
  // or a login check added or removed where the route is declared (a mount, a <RequireAuth> wrapper).
  for (const k of new Set([...A.routes.keys(), ...B.routes.keys()])) if (!real.includes(k) && !same(k, A.files.get(k)?.printed, B.files.get(k)?.printed)) real.push(k)
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
    // POST /rooms/[id]/leave whose one write is a delete: what it does, not how it's sent
    return method === 'PUT' || method === 'PATCH' ? `updates ${noun} on your server` : method === 'DELETE' ? `deletes ${noun} on your server`
      : sends ? `sends ${noun} to your server` : `loads ${noun} from your server`
  }
  const newOnly = <T,>(a: Set<T> | undefined, b: Set<T>) => [...b].filter(x => !a?.has(x))
  const newPage = (name: string, url: string, f: FileFacts, clauses: string[]) => {
    const title = f.headings.find(h => h.startsWith('h1:'))?.slice(3)
    const sections = f.headings.filter(h => !h.startsWith('h1:')).map(h => h.slice(3).replace(/[.!]$/, ''))
    const rest = merge(clauses.filter(c => c !== 'requires login ✓' && c !== 'is for admins only ✓'))
    return [
      `${cap(name)} is new${title ? `, titled "${title}"` : ''}.`,
      sections.length ? `It has sections for ${list(sections)}.` : '',
      rest.length ? `It ${list(rest)}.` : '',
      viewOnly(f) ? 'It only shows information: nothing on it lets you change anything.' : '',
      f.auth ? (f.admin ? 'Only admins can open it ✓' : 'You have to log in to open it ✓') : privateLink(url, f) ? 'It opens from a private link, so only people who have the link can find it.' : '',
    ].filter(Boolean).join(' ')
  }
  // Server code that an admin page calls is admin-only, whatever its name.
  const adminCalls = (url: string) => [...B.files].some(([p, f]) => route(p)?.kind === 'page' && /(^|\/)(admin|dashboard)(\/|$)/.test(route(p)!.url)
    && [...f.fetches, ...(f as FileFacts & { quiet?: Set<string> }).quiet ?? []].some(x => norm(x.slice(x.indexOf(' ') + 1)) === norm(url)))
  // A private link: the address carries a secret (/share/[token], /s/{public_id}) and the lookup uses it (`where: { token }`,
  // `.where(Document.public_id == public_id)`, on one line). Only people holding the link find it, whether or not they also log in. (Pages say
  // only that: an app-wide guard plain can't read, Next's middleware, Nuxt's Supabase module, a SvelteKit hook, may still ask for login.)
  // Only tokens named for a link (not a cursor's [nextToken], a phone's [deviceToken], a coin's or an API key's [token]), a public_id only in
  // a share address (elsewhere it's often just the id in URLs), and not a number (`Number(shareId)` can be guessed).
  const privateLink = (url: string, f: FileFacts) => {
    const m = /\[(token|secret|(?:share|invite|access|magic|link|view|guest|public|reset|verify|verification|confirm|confirmation|unsubscribe|download|embed|portal)_?token|(?:share|access|invite)_?(?:id|key|code))\]/i.exec(url)
      ?? /\/(?:s|share|shared|public|links?)\/\[(public_?id)\]/i.exec(url)
    if (!m || !f.tables.size || /(^|\/)(admin|dashboard|tokens?|coins?|nfts?|secrets|keys|api[-_]?tokens|api[-_]?keys)(\/|$)/i.test(url)) return false
    // the field the param is compared with: `where: { token }`, `{ code: req.params.inviteCode }`, `Document.public_id == public_id`,
    // `find_by(share_token: params[:token])`, `->where('share_token', $token)`, `.eq('token', token)`, `objects.get(token=token)`
    const code = [...f.fns.values()].join('\n'), n = m[1], v = String.raw`(?:[\w$]+(?:\.|\[:?))*\$?${n}\]?\b`
    const fields = [
      ...[...code.matchAll(new RegExp(String.raw`\bwhere\s*:\s*\{(?:[^{}]*,)?\s*(${n})\s*[,}]`, 'g'))].map(x => x[1]),   // (not `const { token } = await params`)
      // (a field named like the param counts only on a lookup's line: `where: { shareId: shareId }`, not `const shareId = params.shareId`,
      // `url_for(..., share_id=share_id)` or `{ token: token }` in props)
      ...[...code.matchAll(new RegExp(String.raw`(?<!\b(?:const|let|var)\s+)\b(\w+)\s*(?::|=(?!=)|==|===)\s*${v}`, 'g'))].filter(x => x[1] !== n
        || /\b(?:where|filter|filter_by|find_by|findBy|findUnique|findFirst|findOne|get|eq|objects)\b/.test(code.slice(code.lastIndexOf('\n', x.index) + 1, x.index))).map(x => x[1]),
      ...[...code.matchAll(new RegExp(String.raw`['"](\w+)['"]\s*,\s*${v}`, 'g'))].map(x => x[1]),
    ]
    // a field named for a link, or a bare token / code / secret on a table that holds links (not a coin's symbol, not a row's own id)
    return fields.some(x => /^(?:(?:share|public|access|invite|link|magic|download|reset|verify|verification|guest|view)_?(?:token|id|code|key)|(?:share|public|access|invite|link|magic|download|reset|verify|verification|guest|view)(?:Token|Id|Code|Key))$/.test(x)
      || /^(?:token|code|secret)$/.test(x) && [...f.tables].some(t => /share|link|invite|reset|verif|magic|download|access|guest|portal/i.test(t)))
  }
  // login-ish words in the code (`const u = await auth(); if (!u) ...`, `export const GET = withAuth(...)`: checks plain can't read)
  const loginish = (f: FileFacts) => [...f.fns.values(), f.printed.replace(/\[login: \w+\]/g, '')].some(x =>
    /auth|session|user|account|team|login|sign_?in|require_?[a-z]|ensure|guard|protect|member|permission|role|admin|clerk|verify|jwt|viewer|cookie|middleware|api_?key|password|headers?\b|export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE)\s*=\s*[\w$.]+\(/i.test(x.replace(/\bSession\b/g, '')))   // (SQLAlchemy's db: Session; a wrapper: `export const POST = withWorkspace(...)`)   // (SQLAlchemy's db: Session)
  // Somewhere the app may ask for login before any route runs, in a way plain can't map to one address: Next's middleware or proxy, a
  // SvelteKit hook, Nuxt server middleware, `app.use(...)`, FastAPI `dependencies=[...]`, Flask `before_request`, Rails `before_action`
  const appGuardMaybe = [...B.files].some(([k, f]) => /(^|\/)(?:(?:middleware|proxy|hooks\.server)\.[cm]?[jt]s|server\/middleware\/[^/]+)$/.test(k)
    || /\.use\s*\(|\.middleware\s*\(|add_middleware\s*\((?!\s*(?:Session|CORS|GZip|TrustedHost|HTTPSRedirect|ProxyHeaders)Middleware)|\bMiddleware\s*\(|\bmiddleware\s*=\s*\[|addHook|useGlobalGuards|APP_GUARD|dependencies\s*=\s*\[|before_request|before_action|MIDDLEWARE/.test(f.printed))
  // (the same, but only an app-wide guard whose own code mentions logging in: next-intl's language middleware isn't one)
  const loginGuardMaybe = [...B.files].some(([k, f]) => (/(^|\/)(?:(?:middleware|proxy|hooks\.server)\.[cm]?[jt]s|server\/middleware\/[^/]+)$/.test(k) || /\.use\s*\(|before_request|before_action|MIDDLEWARE|useGlobalGuards|APP_GUARD/.test(f.printed))
    && /auth|session|login|sign_?in|clerk|token|jwt|current_?user|\buser\b|protect|guard|authenticate|\b401\b|unauthori[sz]ed/i.test(f.printed))
  // Server code that only reads, every read open, nothing login-ish anywhere: anyone with the link gets it, no login needed. (Not login,
  // reset or webhook addresses: there the token is the check.)
  const linkOnly = (url: string, f: FileFacts) => privateLink(url, f) && !isPublic(url) && !f.auth && !(f as FileFacts & { guardUnknown?: boolean }).guardUnknown
    && !f.written.size && !f.writes && !METHODS.slice(1).some(m => f.fns.has(m)) && ((f as FileFacts & { ru?: string[] }).ru ?? ['open']).every(x => x === 'open')
    && !loginish(f) && !appGuardMaybe && [...f.fns.values()].every(onlyKnownCalls)   // (a helper may write, a file download isn't "shows")
  // An address ending in /share whose every changing handler only sets link fields (a token, a public id, an is-public flag) on its one table
  // and calls nothing else plain can't account for: it turns sharing on or off (its DELETE removes the link, not the document). The fields
  // read are the ones written: Prisma `data: {...}` (flat, not a variable), `x.field = ...`, Rails `update(field: ...)` / Laravel
  // `update(['field' => ...])`, never a `where`. Not a share counter (shares, shareCount), sharing with a person (sharedWith), several rows
  // (updateMany), outside services, or any other call (a helper may delete or email): only lookups, login checks (named for one: requireOwner,
  // not ensureNoVersions), responses and new tokens.
  const LINK_FIELD = /^['"]?(?:share_?(?:token|id|key|slug|code)|share(?:Token|Id|Key|Slug|Code)|public_?id|publicId|public_?token|publicToken|link_?token|linkToken|is_?public|isPublic|is_?shared|isShared|public|shared|sharing_?enabled|sharingEnabled)['"]?$/
  const writtenFields = (x: string) => [
    ...[...x.matchAll(/\bdata\s*:\s*\{([^{}]*)\}/g)].flatMap(m => m[1].split(',').map(kv => kv.split(':')[0].trim()).filter(Boolean)),
    ...[...x.matchAll(/\b\w+\.(\w+)\s*=(?![=>])/g)].map(m => m[1]),
    // (`update(share_params)`, `update(**body)`: fields plain can't see, so not only link fields)
    ...[...x.matchAll(/\.update!?\s*\((?!\s*\{)\s*\[?([^()]*)\]?\s*\)/g)].flatMap(m => { const ks = [...m[1].matchAll(/(['"]?\w+['"]?)\s*(?::(?!:)|=>)/g)].map(k => k[1])
      return ks.length && !/\*\*|\.\.\./.test(m[1]) ? ks : ['*'] }),
  ]
  const SHARE_CALL = /^(?:if|for|while|switch|catch|return|function|async|await|typeof|def|update!?|save|commit|refresh|flush|findUnique|findFirst|findUniqueOrThrow|findFirstOrThrow|get|get_object_or_404|scalar|scalars|select|where|first|one|one_or_none|filter_by|find|find_by!?|findOrFail|firstOrFail|json|jsonify|redirect|revalidatePath|revalidateTag|url_for|render|abort|abort_unless|abort_if|notFound|response|noContent|head|randomUUID|randomBytes|toString|token_urlsafe|token_hex|urlsafe_base64|nanoid|cuid|createId|uuid4?|hex|random|random_bytes|bin2hex|str|String|Depends|Request|params|status|Error|HTTPException|\w*Response|auth|getServerSession|currentUser|current_user|get_db)$/i
  // a login check named for one (requireUser, owned_document, require_api_csrf: a guard verb and a login word), or a lookup that does
  // nothing else (getDocument, not fetchAndPurgeVersions, getOrCreateShare or a bare fetch(), which may post anywhere)
  const knownCall = (n: string) => SHARE_CALL.test(n)
    || /^(?:require|ensure|assert|check|verify|authorize|authenticate|get_?current|getCurrent|current|get_?owned|getOwned|owned)/i.test(n) && /user|owner|owned|auth|session|member|login|csrf|permission|viewer|account|access|signed/i.test(n) && !/delete|remove|purge|archive|create|transfer|invite|grant|revoke|send|notify|mail/i.test(n)
    || /^(?:get|find|fetch|load)\w/i.test(n) && n !== 'fetch' && !/And[A-Z]|_and_|Or[A-Z]|_or_|delete|remove|purge|archive|create|update|save|transfer|invite|grant|revoke|send|notify|mail|set[A-Z_]/i.test(n)
  const onlyKnownCalls = (x: string) => [...x.replace(/^[^\n]*\n/, '').matchAll(/(?<![\w$])([A-Za-z_$][\w$]*!?)\s*\(/g)].every(c => knownCall(c[1]))
  const shareRoute = (url: string, f: FileFacts, t?: string) => !!t && /^(?:share|sharing|share[-_]?links?)$/.test(url.split('/').at(-1) ?? '') && !f.outside.size
    && [...f.ops].every(o => o === 'update') && [...f.written].every(x => x === t) && ['POST', 'PUT', 'PATCH', 'DELETE'].some(m => f.fns.has(m))
    && ['POST', 'PUT', 'PATCH', 'DELETE'].every(m => { const x = f.fns.get(m); if (x === undefined) return true
      const fs = writtenFields(x)
      return fs.length > 0 && fs.every(k => LINK_FIELD.test(k)) && !/updateMany|update_all|setattr|\$executeRaw|\$queryRaw|\bsql`|\bdata\s*:(?!\s*\{)|\bdata\s*:\s*\{[^{}]*\{/.test(x)
        && onlyKnownCalls(x) })
  const viewOnly = (f: FileFacts) => !(f as FileFacts & { unread?: boolean }).unread && ![...f.fetches, ...(f as FileFacts & { quiet?: Set<string> }).quiet ?? []].some(x => !x.startsWith('GET ')) && !f.forms && !f.written.size && ![...f.ui].some(u => u.startsWith('button ') || u.startsWith('box '))

  // A new way to delete your own account: a DELETE on /me, /account, /profile (not /users/[id], not admin), or new server code
  // named for it (deleteAccount, /account/delete)
  // (/api/user, and server code named for it, only when it deletes from the users table: removeAccount may unlink a Google login,
  // deleteProfile one of several profiles)
  const selfDelete = (url: string, a: FileFacts | undefined, b: FileFacts) => { const nm = named(url).join(' '), newDelete = b.fns.has('DELETE') && !a?.fns.has('DELETE')
    const deletesUser = b.ops.has('delete') && [...b.written].some(t => /^users?$/i.test(t))
    // (the address is only that: /api/me, /api/users/me, /settings/account; not /teams/[id]/members/me (leaving a team) or
    // /api/stripe/account (disconnecting a service). A handler plain can read must delete something: clearing a photo isn't it)
    const segs = url.split('/').filter(Boolean), own = !url.includes('[') && segs.slice(0, -1).every(s => /^(?:api|v\d+|users?|auth|settings|me)$/.test(s))
    return !/admin/i.test(url) && !/\]$/.test(url) && (own && /(?:^|\s)(?:me|account|my account|profile|my profile|self|current user)$/.test(nm) && newDelete
      && (b.ops.has('delete') && [...b.written].some(t => /^(?:users?|accounts?|profiles?)$/i.test(t)) || !b.ops.size && !b.written.size && !b.outside.size && !/cookie|session\.(?:destroy|delete|flush|invalidate|revoke|clear)|(?:invalidate|revoke|delete|destroy|end)_?Sessions?\b|\.del\s*\(|logout|log_out|sign_?out|signOut|storage|\.(?:remove|delete|destroy)\s*\(/i.test(b.fns.get('DELETE') ?? ''))
      || /(?:^|\s)user$/.test(nm) && newDelete && deletesUser
      || !a && deletesUser && /(?:^|\s)(?:delete|remove|destroy) (?:my )?(?:account|profile|me|self)$|(?:^|\s)(?:account|profile|me) (?:delete|remove|destroy)$/.test(nm)) }
  const changes: Change[] = [], problems: Problem[] = [], unfinished: string[] = [], ship: string[] = []
  const limiterSomewhere = [...after].some(([p, x]) => /\.(?:[cm]?[jt]sx?|py|rb|php|go|cs|java|kt)$|(?:^|\/)(?:Gemfile|package\.json|requirements\.txt|pyproject\.toml|composer\.json|go\.mod|pom\.xml|build\.gradle(?:\.kts)?)$/.test(p)
    && /express-rate-limit|\brateLimit\s*\(|@upstash\/ratelimit|\bslowapi\b|\bLimiter\s*\(|@ratelimit|django-ratelimit|\bRateLimiter\b|rack-attack|Rack::Attack|\brate_limit\s+to:|AddRateLimiter|EnableRateLimiting|RequireRateLimiting|['"]throttle:|throttleApi|throttle_classes|RateThrottle\b|@Throttle|httprate|ulule\/limiter|golang\.org\/x\/time\/rate|middleware\/limiter|tollbooth|bucket4j|resilience4j|rate-limiter-flexible|RateLimiter(?:Memory|Redis|Postgres|Mongo)|\brate-?limit\b|@nestjs\/throttler|Throttler(?:Module|Guard)|@arcjet\/|checkRateLimit/i.test(x))

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
      // (loading the same things from a new address, /rooms -> /rooms/[id], isn't new: "now loads rooms" would say it didn't before.
      // A send to a new address is a new action, and "data" says too little to tell.)
      const did = new Set([...a?.fetches ?? []].map(fetchPhrase).filter(x => x.startsWith('loads ') && !x.startsWith('loads data ')))
      for (const x of newOnly(a?.fetches, b.fetches)) if (!did.has(fetchPhrase(x))) clauses.push((a ? 'now ' : '') + fetchPhrase(x))
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
        // (what it changes: a table it writes, or one its address names; not just the first one it reads)
        const wnoun = b.written.size || named(r.url).some(seg => [...b.tables].some(x => things(x) === pluralize(seg))) ? noun : 'data'
        const link = linkOnly(r.url, b), share = shareRoute(r.url, b, t)
        // (an address ending in an id whose GET only looks up one row, `findUnique`, `db.get(Model, id)`, `find_by`: one, not a list)
        const getText = b.fns.get('GET') ?? '', oneRow = !!t && /\]$/.test(r.url) && /\b(?:findUnique|findFirst|findUniqueOrThrow|findFirstOrThrow|findOne|findByPk|findById|find_by!?|get_object_or_404|firstOrFail|findOrFail)\s*\(|\b(?:db|session)\.get\s*\(|\.first\s*\(\s*\)/.test(getText)
          && !/\b(?:findMany|findAll|\.all\s*\(|\.filter\s*\(|\.where\s*\(|select\s*\(|\.list\s*\(|\$queryRaw|\.from\s*\()/.test(getText.replace(/\b(?:findUnique|findFirst)\w*\s*\(\s*\{[^]*?\}\s*\)/g, ''))
        // (only the logged-in person's own user row: every lookup is `where: { id: session.user.id }` or Django's `request.user`, never a list)
        // (only the login's own id: session.user.id, req.user.id, locals.user.id; never req.params.id, query or body ids)
        const ME = String.raw`(?:session(?:\??\.user)?|ctx\??\.session\??\.user|currentUser|current_user|req\??\.user|request\??\.user|locals\??\.user|viewer)\??\.id`
        // (each method on its own, strictly: its only calls are the login check, reading and validating the request, and `prisma.user` lookups or updates
        // that start `({ where: { id: <the login's id> }`. A helper, raw SQL, updateMany or any other call: not claimed)
        const OWN_CALL = /^(?:auth|get\w*Session|currentUser|getCurrentUser|console\.\w+|\w+\.(?:safeParse|parse)|\w+\.error\.(?:format|flatten)|(?:Next)?Response(?:\.json)?|(?:req|request)\.json|JSON\.\w+|prisma\.user\.(?:findUnique|findFirst|findUniqueOrThrow|update))$/
        const self = !!t && /^users?$/i.test(t) && (b.auth || !!(b as FileFacts & { guardUnknown?: boolean }).guardUnknown) && b.fns.size > 0 && [...b.fns.values()].every(x => {
          const body = x.replace(/^[^]*?\)\s*(?::\s*[^{]+)?\{/, ''), calls = [...body.matchAll(/((?:[\w$]+\??\.)*[\w$]+)\s*\(/g)].filter(m => !/^(?:if|for|while|switch|catch|function|return|await|typeof)$/.test(m[1]))
          return calls.some(m => m[1].startsWith('prisma.user.')) && calls.every(m => OWN_CALL.test(m[1].replace(/\?/g, '')) && (!m[1].startsWith('prisma.user.')
            || new RegExp(String.raw`^\(\s*\{\s*where\s*:\s*\{\s*id\s*:\s*${ME}\s*[,}]`).test(body.slice(m.index! + m[0].length - 1)))) })
        // (a GET that reads no table at all, a status or a health check, lists nothing)
        // (a GET whose code only answers with literals, `res.json({ message: "Ok" })`, a status check: it lists nothing)
        const bare = !t && !!getText && [...getText.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '').replace(/^[^]*?(?:=>|\{|:\s*\n)/, '').matchAll(/[A-Za-z_$][\w$]*/g)].every(m => /^(?:res|req|request|response|reply|ctx|c|event|json|send|status|sendStatus|end|Response|NextResponse|JsonResponse|HttpResponse|jsonify|return|async|await|const|let|new|true|false|null|None|True|False|message|ok|status_code|content|body|headers|text)$/.test(m[0]))
        if (b.fns.has('GET')) can.push(link ? `shows ${noun} to anyone with the link, no login needed` : self ? "shows the logged-in person their own account" : oneRow ? `looks up one ${words(t!)}` : bare ? 'answers requests' : `lists ${noun}`)
        if (share) can.push(`turns sharing on or off for ${noun}`)   // (not which: a POST may set the token to nothing)
        if (!share && (b.fns.has('POST') || !METHODS.some(m => b.fns.has(m)))) can.push(creates ? (can.length && (!t || b.written.has(t)) ? 'saves new ones' : `saves new ${t && !b.written.has(t) && b.written.size ? things([...b.written][0]) : noun}`)
          : b.ops.has('update') && b.ops.has('delete') && !['PUT', 'PATCH', 'DELETE'].some(m => b.fns.has(m)) ? `updates and deletes ${list([...(b.written.size ? b.written : [t ?? 'data'])].map(x => x === 'data' ? x : things(x)))}`   // (not which one each: plain doesn't keep that)
          : b.ops.has('update') ? `updates ${wnoun}` : b.ops.has('delete') ? `deletes ${wnoun}` : t ? `looks up ${noun}` : 'accepts requests')
        if (!share && (b.fns.has('PUT') || b.fns.has('PATCH'))) can.push(self ? "updates the logged-in person's own account" : `updates ${noun}`)
        if (!share && b.fns.has('DELETE')) can.push(`deletes ${noun}`)
        if (can.includes("shows the logged-in person their own account") && can.includes("updates the logged-in person's own account"))
          can.splice(0, can.length, ...can.filter(x => !/logged-in person/.test(x)), "shows and updates the logged-in person's own account")
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
          : reads.includes('open') ? 'needs login to change anything ✓ (anyone can view it)' : reads.includes('unknown') ? 'needs login to change anything ✓'
          : (b as FileFacts & { member?: string }).member ? (([g, r]) => `only lets the ${g}'s ${r ? roleWords([...new Set(r.split(','))]) : 'members'} in ✓`)((b as FileFacts & { member?: string }).member!.split('|')) : 'requires login ✓')   // a login or webhook address that rejects bad passwords isn't "login required"
        else if (!link && !b.written.size && !METHODS.slice(1).some(m => b.fns.has(m)) && !isPublic(r.url) && !(b as FileFacts & { guardUnknown?: boolean }).guardUnknown) clauses.push('works without logging in')   // (not when plain can't tell)   // read-only; changing ones get a warning instead
      } else {
        // what it now does to them: an address that gains update and delete doesn't "save" anything new
        // (ops aren't kept per table, so only when it writes to that one table alone)
        // (when plain can't tell which verb goes with which table: the one kind of write it does, or "changes", never a "saves" it didn't see:
        // a leave route that now also deletes read receipts doesn't save them)
        const verbs = b.written.size > 1 ? [] : ([['create', 'saves'], ['update', 'updates'], ['delete', 'deletes']] as const).filter(([o]) => b.ops.has(o) && (!a.ops.has(o) || !a.written.size)).map(([, v]) => v)
        const only = ([['create', 'saves'], ['update', 'updates'], ['delete', 'deletes']] as const).filter(([o]) => b.ops.has(o)).map(([, v]) => v)
        for (const x of newOnly(a.written, b.written)) clauses.push(`${list(verbs.length ? [...verbs] : only.length === 1 ? only : b.ops.size ? ['changes'] : ['saves'])} ${things(x)}`)
        for (const x of newOnly(a.tables, b.tables).filter(x => !b.written.has(x))) clauses.push(`reads ${things(x)}`)
        if (!a.money && b.money) clauses.push('charges customers 💰')
        // only when there are more ways to say no than before: a reworded message isn't a new rule
        for (const m of newOnly(a.refuses, b.refuses).slice(0, Math.min(3, b.refuses.size - a.refuses.size))) clauses.push(`refuses with "${m}"`)
        // a new condition that turns requests away with 401/403/404 (OpnForm's export status: abort_unless($token->can('forms-read'), 403)):
        // often a security fix, worth saying even when plain can't say what it checks. Per method that was there before and still is
        // (a new POST's own checks aren't stricter rules); compared as the conditions' parts split on ||, so splitting one check in
        // two, rewording its message or reformatting it isn't new; never an error class matched in a catch.
        const REJECT = /\babort(?:_unless|_if)?\s*\([^;\n]*\b(40[134])\b|\b(?:status(?:Code|_code)?\s*[:=(]\s*|\.status\s*\(\s*|sendStatus\s*\(\s*)(40[134])\b|HTTP_(40[134])|\braise\s+(?:PermissionDenied|Http404)\b|\bthrow\s+new\s+(?:Forbidden|NotFound|Unauthorized)\w*\s*\(|\b(?:Forbid|NotFound|Unauthorized|notFound|forbidden|unauthorized)\s*\(\s*\)|\bhead\s*\(?\s*:(forbidden|not_found|unauthorized)|status:\s*:(forbidden|not_found|unauthorized)/
        const KIND = (m: RegExpMatchArray) => { const x = m.slice(1).find(Boolean) ?? m[0]; return /403|forbid|PermissionDenied/i.test(x) ? 403 : /401|unauthori/i.test(x) ? 401 : 404 }
        const atoms = (t: string) => { const out = new Map<string, { k: number; msgs: string[] }>(), ls = t.split('\n')
          ls.forEach((l, k) => { const m = l.match(REJECT); if (!m) return
            const prev = ls.slice(0, k).reverse().find(x => x.trim()) ?? ''
            const cond = l.match(/\babort_(?:unless|if)\s*\((.+),\s*40[134]/)?.[1] ?? l.match(/\bif\s*\(?(.+?)\)?\s*(?:\{|:|return\b|throw\b|raise\b|abort\b)/)?.[1] ?? prev.match(/\bif\s*\(?(.+?)\)?\s*[{:]?\s*$/)?.[1]
            if (!cond || /instanceof|\bcatch\b|\bexcept\b/.test(cond)) return
            // (with the message it answers: the same "Session progress not found" the old code already sent isn't a new rule)
            const near = l.slice(Math.max(0, (m.index ?? 0) - 160), (m.index ?? 0) + 160)   // (some languages' code comes squeezed onto one line)
            const msgs = [...near.matchAll(/(['"`])([^'"`]{4,})\1/g)].map(x => x[2]).filter(x => /\w\s+\w/.test(x))   // (words, not a permission name like 'forms-read')
            for (const x of cond.split(/\|\||\bor\b/).map(y => y.replace(/[\s()]/g, '')).filter(Boolean)) out.set(x, { k: KIND(m), msgs }) })
          return out }
        const fresh = new Set<number>()
        for (const [mth, tb] of b.fns) { const ta = a.fns.get(mth); if (ta === undefined) continue
          // (not 401s: login is read on its own, and `!session` -> `!session?.user` isn't a new rule; a 404 only when it compares,
          // `job.form_id !== form.id`, the record isn't yours; `!program` is a row that isn't there)
          const was = atoms(ta)
          // (a message the old code already answered with the same status is the same refusal moved; never a generic one like
          // "Not found", which a new ownership check reuses)
          const oldMsgs = new Set([...was.values()].flatMap(v => v.msgs.filter(mm => !/^(?:not found|forbidden|not allowed|unauthori[sz]ed|access denied|permission denied|no access)\.?$/i.test(mm.trim())).map(mm => `${v.k}:${mm}`)))
          for (const [x, { k, msgs }] of atoms(tb)) if (!was.has(x) && !msgs.some(mm => oldMsgs.has(`${k}:${mm}`)) && (k === 403 || k === 404 && /!==?|===?|<>/.test(x))) fresh.add(k) }
        if (fresh.size && a.auth === b.auth) clauses.push(`turns away more requests than before (a new ${list([...fresh].sort().map(k => `"${({ 403: 'not allowed', 404: 'not found', 401: 'not logged in' } as Record<number, string>)[k]}"`))} check)`)
        // a DELETE where there was none (its handler may be elsewhere, a controller plain doesn't follow)
        if (b.fns.has('DELETE') && !a.fns.has('DELETE') && !clauses.some(c => /\bdeletes\b/.test(c)) && (selfDelete(r.url, a, b) || b.ops.has('delete'))) clauses.push(selfDelete(r.url, a, b) ? "lets people delete their own account" : `deletes ${noun}`)
      }
      for (const o of newOnly(a?.outside, b.outside).filter(o => !o.startsWith('Stripe: checkout.sessions'))) clauses.push(outsidePhrase(o))
    }
    const name = placeName(p)
    // who can use it, when that changed: login, or admins on top of it
    const lead = !a ? '' : a.auth && !b.auth && !(b as FileFacts & { guardUnknown?: boolean }).guardUnknown ? `${cap(name)} no longer requires login.` : !a.auth && b.auth ? `${cap(name)} now ${b.admin ? 'only lets admins in' : 'requires login'} ✓`
      : a.auth && b.auth && a.admin && !b.admin ? `${cap(name)} may no longer be limited to admins.` : a.auth && b.auth && !a.admin && b.admin ? `${cap(name)} is now limited to admins ✓` : ''
    // a server action that was a plain helper before, in another file: it isn't new, but "use server" now lets the browser call it
    const fn_ = r.url.startsWith('(server action) ') ? r.url.slice(16).split(' in ')[0] : '', file_ = p.split('#')[0]
    // (gone from where it was, not already a server action there, and not a browser-side fetch wrapper of the same name)
    const movedFrom = fn_ && !a ? [...A.files].find(([q, f]) => !q.includes('#') && q !== file_ && f.fns.has(fn_) && !B.files.get(q)?.fns.has(fn_)
      && ![...A.routes.values()].some(x => x.url === `(server action) ${fn_} in ${q}`) && !/\bfetch\s*\(/.test(f.fns.get(fn_) ?? ''))?.[0] : undefined
    const text = !a
      ? (r.kind === 'page' ? newPage(name, r.url, b, clauses) : movedFrom ? `${fn_}() was a helper in ${movedFrom}. It moved into a "use server" file, so the browser can now call it directly.${clauses.length ? ` It ${list(merge(clauses))}.` : ''}`
        : `New server code that ${list(merge(clauses)) || 'handles requests'}.`)
      : (lead ? `${lead}${clauses.length ? ' It also' : ''}` : '')
        + (clauses.length ? `${lead ? ' now ' : `${cap(name)} now `}${list(merge(clauses.map(c => c.replace(/^now /, ''))))}.` : lead ? '' : `${cap(name)} changed in a way plain can't describe yet.${b.money ? '' : ' Ask the agent what it does differently.'}`)
    changes.push({ group: r.kind === 'page' ? 'Pages' : 'Server', isNew: !a, text: text + (a?.money && b.money ? ' This is the code that charges your customers 💰 Make a test payment before you ship.' : ''), detail: r.url, name: r.kind === 'page' ? pageName(r.url) + (!a && b.headings.find(h => h.startsWith('h1:')) ? ` ("${b.headings.find(h => h.startsWith('h1:'))!.slice(3)}")` : '') : named(r.url).join(' ') || 'main', money: b.money, vague: !!a && !clauses.length && a.auth === b.auth && !b.money })

    // SvelteKit: the layout asks for login, but this page's own server load doesn't wait for it (no `await parent()`), so its data can be
    // fetched without logging in (client-side navigation and __data.json skip the layout's load)
    if (r.kind === 'page' && (b as FileFacts & { dataOpen?: boolean }).dataOpen && !(a as FileFacts & { dataOpen?: boolean } | undefined)?.dataOpen)
      problems.push({ kind: 'Unsafe', text: `${cap(name)}'s data can be read without logging in. Its layout asks for login, but the page loads its own data without waiting for that check. Check locals.user in the page's load (or call \`await parent()\` first), or check in hooks.server.ts.` })
    // (not when it already asks for the password: Laravel Breeze's `current_password` rule, a password compare)
    if (r.kind === 'endpoint' && selfDelete(r.url, a, b) && !/current_password|password_verify|check_password|checkPassword|verifyPassword|comparePassword|(?:bcrypt|argon2?)\.(?:compare|verify)|Hash::check/.test([...b.fns.values(), b.printed].join('\n')))
      problems.push({ kind: 'Check', text: `People can now delete their own account (${name}). That can't be undone, so make sure the app asks them to confirm first (like typing their password), and that the rest of their data is deleted or kept the way you want.` })
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
      // anyone can publish anyone's documents (not when its code has login-ish words, or a Next middleware may ask: then the Check below)
      else if (r.kind === 'endpoint' && shareRoute(r.url, b, mainTable(b, r.url)) && !loginish(b) && !appGuardMaybe)
        problems.push({ kind: 'Unsafe', text: `Anyone can turn sharing on or off for your ${things(mainTable(b, r.url)!)} without logging in.` })
      else if (r.kind === 'endpoint' && writes) {
        const t = mainTable(b, r.url), noun = t ? things(t) : 'data'
        // ("nothing limits spam" only when no server code mentions a rate limiter: Rails 8's `rate_limit to:`, express-rate-limit,
        // slowapi, Laravel's throttle, DRF throttles, ASP.NET's rate limiter, Rack::Attack... plain doesn't map one to an address)
        problems.push({ kind: 'Check', text: `Anyone can ${b.ops.has('create') || !b.ops.size ? 'post' : 'change'} ${noun} without logging in${limiterSomewhere ? '' : `, and nothing limits spam or fake ${noun}`}. That's normal for things like sign-ups or reviews, but make sure it's what you want.` })
      }
      // SvelteKit: the page asks for login (its layout or load checks), but form actions run before any load function, so that check never
      // stops them. Say why, or the "You have to log in" on the page reads as if the form were safe too.
      const page = p.split('#')[0].replace(/\+page\.server\.[cm]?[jt]s$/, '+page.svelte')
      if (problems.length > before_ && page !== p.split('#')[0] && (B.files.get(page) as FileFacts & { layoutLogin?: boolean } | undefined)?.layoutLogin)
        problems.at(-1)!.text += ' The page asks for login, but its form actions run before that check, so they need their own (check locals.user in the action, or in hooks.server.ts).'
    }
    // Code with no login check that deletes stored files (UploadThing's deleteFiles, S3 and boto3 delete_object, Cloudinary destroy,
    // Supabase storage remove, Vercel Blob del, Firebase deleteObject, Laravel Storage::delete), whenever it changed: anyone may be
    // able to call it, and what it deletes may come from them (chadnext's removeUserOldImageFromCDN now deletes whatever URL the
    // browser sends). Read in the function's own code. Not when that code checks something: a login call, a secret header
    // (a cron job's CRON_SECRET), a webhook signature; nor when an app-wide guard mentions login; nor twice (a new address already
    // warned about above).
    const fnText = [...b.fns.values()].join('\n')
    const delFiles = STORAGE_DELETE.test(fnText) || /\bdel\s*\(/.test(fnText) && /\{[^}]*\bdel\b[^}]*\}\s*from\s*['"]@vercel\/blob['"]/.test(b.printed + (after.get(p.split('#')[0]) ?? ''))
    const ownCheck = /\b(?:auth|getAuth|getSession|getServerSession|getServerAuthSession|currentUser|getCurrentUser|getUser|getToken|validateRequest|validateSession|verifyIdToken|getKindeServerSession|require\w+|ensure\w+|withAuth|protect|verify\w*)\s*\(|\bjwt\.verify\b|\bsession\b|\buserId\b\s*=\s*await|headers?\b[^\n]*(?:process\.env|settings\.|ENV\[)|(?:process\.env|settings\.)\w*[^\n]*headers?\b|\bauthorization\b|CRON_SECRET|constructEvent|construct_event|ConstructEvent/i.test(fnText)
    if (r.kind === 'endpoint' && delFiles && !b.auth && !(b as FileFacts & { guardUnknown?: boolean }).guardUnknown && !isPublic(r.url) && !ownCheck && !loginGuardMaybe
      && !problems.some(x => x.text.includes(`${name} without logging in`) || x.text.includes(`${cap(name)} without logging in`)))
      problems.push({ kind: 'Unsafe', text: `Anyone may be able to use ${name} to delete files from your storage: plain sees no login check in it. Add one, and make sure it only deletes files the person is allowed to delete.` })
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
  // Bank account, card and ID numbers saved as they are: anyone who gets a copy of the database (a leaked backup or password) can
  // read them. Not when a line anywhere names the field and encryption (Rails `encrypts :account_number`, a Laravel 'encrypted' cast,
  // EncryptedCharField, prisma-field-encryption's `/// @encrypted`). Routing and SWIFT codes are public: they name the bank.
  const squash = (x: string) => x.toLowerCase().replace(/[_-]/g, '')
  // (an account number only on a bank model, or next to a routing, IBAN, SWIFT or payout field: a CRM's `Customer.accountNumber` is
  // a reference. A card number only on a payment card, or next to a CVV or expiry: not a loyalty card or a flashcard)
  const secretNumber = (m: string, x: string, fs: string[]) => { const f = squash(x), mm = squash(m), near = fs.map(squash).join(' ')
    const bankish = /bank|payout|beneficiar/.test(mm) || /routing|iban|swift|sortcode|beneficiar|bankname/.test(near)
    const cardish = !/gift|loyalty|membership|reward|library|student/.test(mm) && (/^(?:credit|debit|payment)?cards?$|payment|billing|credit|debit/.test(mm) || /cv[cv]|expir|cardholder/.test(near))
    return /^(?:bank)?(?:account|acct)(?:number|num|no)$/.test(f) && bankish || /^(?:credit)?card(?:number|num|no)$/.test(f) && cardish
      || /^iban$|^cv[cv]\d?$|^ssn$|^socialsecurity(?:number|num|no)?$|^passport(?:number|num|no)$/.test(f)
      || f === 'number' && (/^bankaccounts?$/.test(mm) || /^(?:credit|debit|payment)?cards?$/.test(mm) && /cv[cv]|expir|cardholder/.test(near)) }
  const encrypted = (x: string) => [...after].some(([, t]) => t.split('\n').some(l => /encrypt|cipher/i.test(l) && squash(l).includes(squash(x))))
  for (const [m, fields] of B.models) {
    // (a field renamed from one that held the same number, acctNo -> accountNumber, isn't new)
    const had = (A.models.get(m) ?? []).some(x => !fields.includes(x) && /acct|accountn|iban|cardn|ssn|socialsec|passport/.test(squash(x)))
    const fs = had ? [] : fields.filter(x => !x.startsWith('→') && !A.models.get(m)?.includes(x) && secretNumber(m, x, fields) && !encrypted(x))
    if (fs.length) problems.push({ kind: 'Check', text: `${cap(things(m))} now store the ${list(fs.map(x => ({ iban: "IBAN", ssn: "Social Security number" } as Record<string, string>)[squash(x)] ?? (fieldName(x) || words(x))))} as plain text. Anyone who gets a copy of your database (a leaked backup or password) can read ${fs.length > 1 ? 'them' : 'it'}. Encrypt ${fs.length > 1 ? "them" : "it"}${fs.some(x => /account|acct|iban|card|cv[cv]|^number$/i.test(squash(x))) ? `, or let your payment provider keep ${fs.length > 1 ? "them" : "it"}` : ""}.` })
  }
  const newMigrations = B.migrations.filter(m => !A.migrations.includes(m))
  if (changed.some(p => p.endsWith('schema.prisma')) && !newMigrations.length)
  {
    const sp = B.schemaPath ?? '', std = /(^|\/)prisma\/schema\.prisma$/.test(sp), dir = std ? sp.replace(/prisma\/schema\.prisma$/, '') : ''
    const flag = std || sp === 'schema.prisma' ? '' : ` --schema ${sp}`, added = [...B.models.keys()].filter(m => !A.models.has(m) && !B.db.tables.has(m))
    // (a project with no migrations whose own script runs `prisma db push` updates its database that way: migrate deploy would do nothing)
    // Only a script that does nothing else (prisma generate or format aside, and the scripts it runs, npm's pre/post ones too): not
    // one that also seeds, builds or starts the app, resets or accepts data loss, nor one that pushes another schema. Not with
    // migrations anywhere, a script that deploys them, or a prisma.config file (it can move both).
    const pkgJson = (() => { try { return JSON.parse(after.get(`${dir}package.json`) ?? '{}') ?? {} } catch { return {} } })() as { scripts?: Record<string, unknown>, prisma?: { schema?: unknown } }
    const scripts = pkgJson.scripts && typeof pkgJson.scripts === 'object' ? pkgJson.scripts : {}, run = (k: string) => typeof scripts[k] === 'string' ? scripts[k] as string : undefined
    const pushes = (x: string) => { const s0 = /--schema[=\s]+["']?([^\s"']+)/.exec(x)?.[1] ?? (typeof pkgJson.prisma?.schema === 'string' ? pkgJson.prisma.schema : undefined)
      return s0 ? `${dir}${s0.replace(/^\.\//, '')}` === sp : sp === `${dir}prisma/schema.prisma` || sp === `${dir}schema.prisma` }
    const only = (k: string, depth = 0): 'push' | 'ok' | 'no' => { let r: 'push' | 'ok' = 'ok'
      for (const c of [run(`pre${k}`), run(k), run(`post${k}`)]) for (const x of (c ?? '').split(/&&|;|\n/).map(y => y.trim()).filter(Boolean)) {
        const cmd = x.replace(/^(?:npx|bunx|pnpm(?: exec)?|yarn)\s+(?=prisma\b)/, ''), sub = /^(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\s+([\w:.-]+)$/.exec(cmd)?.[1]
        if (/^prisma\s+(?:generate|format|validate)\b/.test(cmd) && !/&|\||;|`|\$\(/.test(cmd)) continue
        if (/^prisma\s+db\s+push\b/.test(cmd) && !/--force-reset|--accept-data-loss|--config|--url|[|&`]|\$\(/.test(cmd) && pushes(cmd)) { r = 'push'; continue }
        const inner = sub && depth < 3 && run(sub) !== undefined ? only(sub, depth + 1) : 'no'; if (inner === 'no') return 'no'; if (inner === 'push') r = 'push' }
      return run(k) === undefined ? 'no' : r }
    const migrated = [...after.keys()].some(p => /(^|\/)migration\.sql$/.test(p) || /(^|\/)prisma\.config\.[cm]?[jt]s$/.test(p)) || Object.values(scripts).some(c => /\bprisma\s+migrate\b[^&;|\n]*\s(deploy|reset)\b/.test(String(c)))
    const push = migrated || !changed.includes(sp) ? undefined : Object.keys(scripts).find(k => !/^(?:pre|post)/.test(k) && only(k) === 'push')
    const until = added.length ? ` Until you do, anything that uses ${list(added.map(things))} will fail.` : ''
    ship.push(push ? `Update your database: ${dir ? `in ${dir}, ` : ''}run \`npm run ${push}\` (it runs \`prisma db push\`) on your computer and on your live database. The database's structure changed.${until}`
      : `Update your database: ${dir ? `in ${dir}, ` : ''}run \`npx prisma migrate dev${flag}\` (on your live site: \`npx prisma migrate deploy${flag}\`). The database's structure changed, but no migration was created.${until}`)
  }
  // (SQLite can't alter a table in place: Prisma rebuilds it as new_X, copies every row, drops X and renames new_X back. Nothing is lost.)
  // Deletes data: a table, a column (MySQL's `ALTER TABLE t DROP c` too), a schema, TRUNCATE, DELETE FROM. Not dropping a constraint, an
  // index, a foreign key, a default, NOT NULL or a check: those change rules, and the rows stay.
  // (a type, domain or extension dropped with CASCADE takes its columns with it; a dropped partition its rows. SQL comments and function
  // bodies (`AS $$...$$`, not a `DO $$...$$` block, which runs right away) aside. `ci` false for Python, where only upper-case SQL counts: not "drop table" in a docstring)
  const dropsData = (sql0: string, ci = true) => { const sql = sql0.replace(/--[^\n]*/g, '').replace(/\bAS\s+\$\$[\s\S]*?\$\$/gi, ''), f = ci ? 'i' : ''
    return new RegExp(String.raw`\bDROP\s+(?:TABLE|COLUMN|SCHEMA|DATABASE)\b|\bTRUNCATE\b|\bDELETE\b[^;]*?\bFROM\b|\bDROP\s+(?:TYPE|DOMAIN|EXTENSION)\b[^;]*\bCASCADE\b`, f).test(sql)
    || new RegExp(String.raw`\bALTER\s+TABLE\b[^;]*?\bDROP\s+(?!CONSTRAINT\b|INDEX\b|FOREIGN\b|PRIMARY\b|DEFAULT\b|NOT\b|CHECK\b|KEY\b|UNIQUE\b|IDENTITY\b|EXPRESSION\b|TRIGGER\b|COLUMN\b|IF\s+EXISTS\s+(?:CONSTRAINT|INDEX)\b)["\`\[]?\w`, f).test(sql) }
  const rebuilt = (sql: string) => sql.replace(/DROP TABLE\s+["`]?(\w+)["`]?;?/gi, (m, t: string) => new RegExp(`INSERT INTO\\s+["\`]?(?:__)?new_${t}(?!\\w)["\`]?[\\s\\S]*RENAME TO\\s+["\`]?${t}(?!\\w)`, 'i').test(sql) ? '' : m)   // drizzle-kit: __new_x
  for (const m of newMigrations) if (dropsData(rebuilt(after.get(m) ?? ''))) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`)
  if (newMigrations.length) {
    // a new column on a table the app already had: Prisma asks for every column by default, so until it's applied, loading those rows fails
    // anywhere, not just in the new parts (`ALTER TABLE "Workspace" ADD COLUMN "plan"`, the table named for its model, no @@map, and the
    // column a plain field of it: Prisma never asks for an Unsupported("tsvector") or @ignore field, or one only the SQL has)
    const schemaText = after.get(B.schemaPath ?? '') ?? ''
    const plainField = (t: string, col: string) => { const body = schemaText.match(new RegExp(String.raw`\bmodel\s+${t}\s*\{([^}]*)\}`))?.[1] ?? ''
      const line = body.split('\n').find(l => new RegExp(String.raw`^\s*${col}\s+\w`).test(l)); return !!line && !/Unsupported\s*\(|@ignore\b/.test(line) }
    const widened = [...new Set(newMigrations.flatMap(m => [...(after.get(m) ?? '').replace(/--[^\n]*/g, '').matchAll(/ALTER TABLE\s+["`]?(?:\w+["`]?\.["`]?)?(\w+)["`]?\s+((?:ADD COLUMN\s+["`]?\w+["`]?[^,;]*,?\s*)+)/gi)]
      .filter(x => A.models.has(x[1]) && B.models.has(x[1]) && [...x[2].matchAll(/ADD COLUMN\s+["`]?(\w+)/gi)].some(c => plainField(x[1], c[1]))).map(x => x[1])))]
    // the project's own migrate script is `prisma migrate dev`: that's for your computer (it can offer to wipe the database), not a live one
    const root = newMigrations[0].replace(/prisma\/migrations\/.*$/, ''), scripts = (() => { try { return JSON.parse(after.get(`${root}package.json`) ?? '{}').scripts ?? {} } catch { return {} } })() as Record<string, string>
    const devOnly = Object.entries(scripts).filter(([, c]) => /\bprisma\s+migrate\s+dev\b/.test(c)).sort(([, a], [, b]) => +/--create-only/.test(a) - +/--create-only/.test(b)).map(([k]) => k), deploys = Object.values(scripts).some(c => /\bprisma\s+migrate\s+deploy\b/.test(c))
    // (one that only adds or drops plain indexes, not unique ones (Prisma names those _key): lookups get faster, nothing else changes, so
    // the new code doesn't need it first. A changed foreign key (onDelete), a new rule, a MODIFY, a view or a backfill: it may.)
    const rulesOnly = newMigrations.every(m => { const st = (after.get(m) ?? '').replace(/--[^\n]*/g, '').split(';').map(x => x.trim()).filter(Boolean)
      return st.length > 0 && st.every(x => /^CREATE\s+INDEX\b/i.test(x) || /^DROP\s+INDEX\b/i.test(x) && /_idx["`]?\s*(?:ON\b|$)/i.test(x)) })   // (a plain index as Prisma names it: not `_key`, nor a custom-named unique one)
    ship.push(rulesOnly ? `Apply ${list(newMigrations.map(m => m.replace(/\/migration\.sql$/, '')))} to your live database (\`npx prisma migrate deploy\`). It only adds or removes indexes, which make lookups faster, so the new code doesn't need it first.`
      + (devOnly.length && !deploys ? ` Don't use the \`${devOnly[0]}\` script there: it runs \`prisma migrate dev\`, which is for your own computer and can offer to wipe the database.` : '')
      : `Apply ${list(newMigrations.map(m => m.replace(/\/migration\.sql$/, '')))} to your live database before the new code goes live (\`npx prisma migrate deploy\`), or ${widened.length ? `pages that load ${list(widened.map(things))} can fail too, not just the new parts (Prisma asks for every column).` : 'the parts that use it will fail.'}`
      + (devOnly.length && !deploys ? ` Don't use the \`${devOnly[0]}\` script there: it runs \`prisma migrate dev\`, which is for your own computer and can offer to wipe the database.` : ''))
  }
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
      // (a rule that includes the row's own id can't fail when that id is the model's one key: `id String @id`, no @@id)
      const body = (after.get(B.schemaPath ?? '') ?? '').match(new RegExp(String.raw`\bmodel\s+${model}\s*\{([^}]*)\}`))?.[1] ?? ''
      const soleId = /^\s*id\s+\w+[^\n]*@id\b/m.test(body) && !/@@id\s*\(/.test(body)
      if (model && cols.every(had) && where.every(had) && !(soleId && cols.some(c => /^id$/i.test(c))))
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
  for (const m of newFlyway) if (dropsData(rebuilt(after.get(m) ?? ''))) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`)
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
    if (dropsData(rebuilt(after.get(m) ?? ''))) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`)
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
  const outsideCalls = real.filter(p => route(p)?.kind === 'page' && B.files.get(p)?.auth).flatMap(p => [...B.files.get(p)!.fetches, ...(B.files.get(p) as FileFacts & { quiet?: Set<string> }).quiet ?? []].map(x => x.slice(x.indexOf(' ') + 1))).filter(u => u.startsWith('/') && !endpoint(u))
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
  // (a Django migration's own operations list: not `migrations.swappable_dependency` in its dependencies)
  const indexOnly = (m: string) => { const up = (after.get(m) ?? '').split(/def downgrade/)[0], django = /\bmigrations\.Migration\b/.test(up), dj = django ? migOps(up) : []
    if (!dj) return false
    const ops = django ? dj.map(([o]) => o) : [...up.matchAll(/\b(?:op|batch_op)\.(\w+)\(/g)].map(x => x[1]).filter(o => !/^(f|batch_alter_table)$/.test(o))
    return ops.length > 0 && ops.every(o => /^(AddIndex|RemoveIndex|RenameIndex|create_index|drop_index)$/.test(o)) }
  // one that only changes field options Django keeps in code (labels, help text, choices, related_name…) or model options emits no SQL:
  // nothing breaks if it runs late. Each AlterField is checked against the field as the app's earlier migrations left it (the
  // database as it is, even when the models had drifted), those options stripped: anything that doesn't match exactly, or a field
  // plain can't find there, still counts as needed.
  // (the app's migrations before this one, new ones in the same change included, each read once)
  const opsOf = new Map<string, [string, Map<string, string>, string][] | undefined>(), cached = (p: string) => opsOf.has(p) ? opsOf.get(p) : opsOf.set(p, migOps(after.get(p) ?? '')).get(p)
  const codeOnly = (m: string) => {
    const app = m.replace(/migrations\/[^/]*$/, ''), label = app.replace(/\/$/, '').split('/').pop() ?? ''
    const history = migHistory(after, m); if (!history) return false
    const each = history.map(cached), ops = cached(m); if (!ops || each.some(x => !x)) return false
    const earlier = each.flatMap(x => x!)
    // (new permissions in a model's options only exist once it runs: has_perm says no until then)
    return ops.length > 0 && ops.every(([op, kw]) => op === 'AlterModelManagers' || op === 'AlterModelOptions' && !/permissions/.test(kw.get('options') ?? '') || op === 'AlterField' && (() => {
      const model = unq(kw.get('model_name')), name = unq(kw.get('name')), field = kw.get('field')
      if (!model || !name || !field) return false
      const was0 = migField(earlier, model, name), was = was0 && dbPart(was0, model, label)
      return was !== undefined && was === dbPart(field, model, label)
    })())
  }
  const cmd = 'django' in B.deps ? '`python manage.py migrate`' : Object.keys(B.deps).some(k => /^flask[-_]migrate$/i.test(k)) ? '`alembic upgrade head`, or `flask db upgrade` with Flask-Migrate' : '`alembic upgrade head`'
  const codeOnlyMigs = 'django' in B.deps ? newPyMigrations.filter(m => !indexOnly(m) && codeOnly(m)) : []
  const needed = newPyMigrations.filter(m => !indexOnly(m) && !codeOnlyMigs.includes(m)), speed = newPyMigrations.filter(indexOnly)
  if (needed.length) ship.push(`Apply ${list(needed)} to your live database before the new code goes live (${cmd}), or the parts that use it will fail.`)
  if (speed.length) ship.push(`Apply ${list(speed)} to your live database too (${cmd}). It only makes lookups faster, so nothing breaks if it runs later.`)
  if (codeOnlyMigs.length) ship.push(`Apply ${list(codeOnlyMigs)} too (${cmd}). It only records settings Django keeps in your code (like labels, or the name for related records), not changes to your tables, so nothing breaks if it runs later.`)
  for (const m of newPyMigrations) {
    const up = (after.get(m) ?? '').split(/def downgrade|def backwards/)[0]
    if (/op\.drop_(table|column)|RemoveField|DeleteModel/.test(up) || dropsData(up, false)) ship.push(`Back up your data first: ${m} deletes data and can't be undone.`)
  }

  // broken, unasked, unfinished
  const allBefore = new Map<string, string>(), allAfter = new Set<string>()
  for (const [p, f] of A.files) for (const n of f.fns.keys()) allBefore.set(n, p)
  for (const f of B.files.values()) for (const n of f.fns.keys()) allAfter.add(n)
  for (const [n, p] of allBefore) if (!allAfter.has(n) && !METHODS.includes(n)) {
    const users = usersOf(n, p)
    if (users.length) problems.push({ kind: 'Broken', text: `${n}() was deleted from ${p}, but ${list(users)} still ${users.length > 1 ? 'use' : 'uses'} it, so that will break.` })
  }
  // PHP: a global function defined before and nowhere now, still called as one (`block_asset(...)`, not `->x(` or `::x(`) in
  // another PHP or Blade file: those pages crash (LinkStack deleted its block helpers from functions.php)
  // (JavaScript in <script> blocks isn't PHP)
  const noScript = (t: string) => t.replace(/<script\b[\s\S]*?<\/script>/gi, '')
  const phpFns = (snap: Snap) => { const out = new Map<string, string>(); for (const [k, t0] of snap) if (/\.php$/.test(k) && !/\.blade\.php$/.test(k) && !k.includes('vendor/'))
    for (const t of [noScript(t0)]) for (const m of t.matchAll(/^([ \t]*)function\s+(\w+)\s*\(/gm)) {
      // (not a method: one with a visibility word, or an indented one in a file that declares a class; not a polyfill of a function
      // PHP itself now has (str_contains behind function_exists); an app's own helpers behind function_exists still count)
      if (/^[ \t]*(?:public|private|protected|static|abstract|final)\b/m.test(t.slice(t.lastIndexOf('\n', m.index!) + 1, m.index! + m[0].length))) continue
      if (m[1] && /^[ \t]*(?:abstract\s+|final\s+|readonly\s+)*(?:class|trait|interface|enum)\s+\w+/m.test(t) || /^(?:str_|array_|mb_|json_|iterator_|spl_|is_|get_debug_type$|fdiv$)/.test(m[2]) && new RegExp(String.raw`function_exists\(\s*['"]${m[2]}['"]`).test(t)) continue
      out.set(m[2], k) }
    return out }
  // (not when a Composer package was added: a helper may have moved into it, and vendor/ isn't in the project)
  const pkgs = (snap: Snap) => new Set([...snap].filter(([k]) => /(^|\/)composer\.json$/.test(k)).flatMap(([, t]) => { try { const j = JSON.parse(t); return [...Object.keys(j.require ?? {}), ...Object.keys(j['require-dev'] ?? {})] } catch { return [] } }))
  const pkgsBefore = pkgs(before), phpBefore = phpFns(before), phpAfter = phpFns(after), composerMoved = [...pkgs(after)].some(x => !pkgsBefore.has(x))
  for (const [n, from] of phpBefore) if (!composerMoved && !phpAfter.has(n) && n.length > 2 && !/^(?:asset|route|config|url|trans|view|redirect|response|request|auth|session|now|today|collect|data_get|data_set|str|value|optional|env|app|abort|back|old|csrf_token|csrf_field|method_field|logger|report|rescue|retry|tap|throw_if|throw_unless|cache|cookie|encrypt|decrypt|bcrypt|event|dispatch|policy|resolve|public_path|storage_path|base_path|app_path|resource_path|database_path|config_path|mix|vite)$/.test(n)) {
    const call = new RegExp(String.raw`(?<![\w$\\])(?<!(?:->|::)\s*)(?<!function\s+)${n}\s*\(`)   // (not a method call or a definition)
    // (a class method of the same name is still a method, not this function: only files outside a class body count, roughly:
    // calls not preceded by -> or ::)
    // (strings taken out in PHP, not in Blade, where calls sit inside HTML attributes: src="{{ block_asset('a.png') }}")
    const users = [...after].filter(([k, t]) => /\.php$/.test(k) && !k.includes('vendor/') && !TESTS.test(k) && call.test(/\.blade\.php$/.test(k) ? noScript(t).replace(/\{\{--[\s\S]*?--\}\}/g, '').replace(/\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}/g, x => x.replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, '""')) : noScript(t).replace(/\/\*[\s\S]*?\*\/|(?:\/\/|#)[^\n]*/g, '').replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, '""'))).map(([k]) => k)
    if (users.length) problems.push({ kind: 'Broken', text: `${n}() was deleted from ${from}, but ${list(users.length > 3 ? [...users.slice(0, 2), `${users.length - 2} more files`] : users)} still ${users.length > 1 ? 'use' : 'uses'} it, so those pages will crash.` })
  }
  // Python request models (Pydantic `class AddUserParam(SchemaBase): roles: list[int]`) whose field was renamed: anything that still
  // sends the old name (an admin screen, a mobile app) is turned away until it changes at the same time (fastapi-best-architecture
  // renamed roles/menus/scopes/rules to *_ids).
  // (a rename only, one field out and one in, and only when the new one is required: Pydantic ignores fields it doesn't know, so a
  // removed or optional one breaks nothing. Never a class with aliases, a dataclass, a response model or a private attribute.)
  const REQ = /^(?:\w*(?:Param|Params|Request|Body|Input|Payload)|(?:Create|Update|Add|Edit)(?=[A-Z])\w*)$/
  const reqFields = (t = '') => { const out = new Map<string, Map<string, boolean>>()
    if (!/\bfrom\s+(?:pydantic|ninja)\b|\bimport\s+pydantic\b/.test(t)) return out
    for (const m of t.matchAll(/^(@[^\n]*\n)?class\s+(\w+)\s*\(([^)]+)\)\s*:\s*\n((?:[ \t]+[^\n]*\n|[ \t]*\n)*)/gm)) {
      if (!REQ.test(m[2]) || /(?:Result|Response|Out|Detail|Info|Read|View)$/.test(m[2]) || /dataclass/.test(m[1] ?? '') || /Enum\b|Exception\b|Error\b|\bBase\b|db\.Model|models\.Model|TypedDict|DeclarativeBase/.test(m[3])) continue
      const body = m[4].replace(/(?:"""|''')[\s\S]*?(?:"""|''')/g, '')
      if (/alias/.test(body)) continue
      out.set(m[2], new Map([...body.matchAll(/^[ \t]{4}([a-z]\w*)[ \t]*:[ \t]*([^\n]+)/gm)].filter(x => !/ClassVar/.test(x[2]) && x[1] !== 'model_config')
        // (required: no default, or a Field(...) with no default; `x: str = 'a'`, Field(default=...) or `| None` aren't)
        .map(x => { const [type, val] = x[2].split(/=(.*)/s), field = /^\s*Field\s*\(/.test(val ?? '')
          return [x[1], !/\bOptional\b|\|\s*None\b|None\s*\|/.test(type) && (val === undefined || field && !/\bdefault(?:_factory)?\s*=|Field\s*\(\s*(?!\.\.\.)[^\s,)a-z_]/.test(val))] as const }))) }
    return out }
  const renamed: string[] = []
  for (const p of real.filter(q => q.endsWith('.py') && !TESTS.test(q) && !/(?:^|\/)(?:migrations|alembic|management\/commands)\//.test(q) && before.has(q) && after.has(q))) {
    const was = reqFields(before.get(p)), now = reqFields(after.get(p))
    for (const [cls, fs] of now) { const old = was.get(cls); if (!old) continue
      const gone = [...old.keys()].filter(x => !fs.has(x)), added = [...fs.keys()].filter(x => !old.has(x))
      if (gone.length === 1 && added.length === 1 && fs.get(added[0])) renamed.push(`"${added[0]}" instead of "${gone[0]}"`) }
  }
  const pairs = [...new Set(renamed)]
  if (pairs.length) problems.push({ kind: 'Check', text: `The data your server expects changed: it now needs ${list(pairs.length > 3 ? [...pairs.slice(0, 2), `${pairs.length - 2} more`] : pairs)}. Anything that sends the old names (your own screens, a mobile app, other services) will be turned away until it changes at the same time.` })
  // A migration that starts with terminal output pasted in ("Already up to date", "Done in 225ms using pnpm"): applying it fails.
  // (Only output plain recognizes: T-SQL, SQL*Plus, DuckDB and others start migrations with lines no keyword list covers.
  // No check for imports of missing files either: generated, gitignored files look the same as missing ones.)
  const CLI_OUTPUT = /^(?:Already up[- ]to[- ]date\b|Done in \d|(?:npm|pnpm|yarn|npx|bunx?|git|prisma|drizzle-kit)\s+(?:run|exec|dlx|install|i|add|migrate|generate|push|db|warn|ERR!|WARN)\b|Environment variables loaded\b|Prisma schema loaded\b|Datasource "|(?:\$|❯|➜)\s+\S)/
  for (const m of real.filter(q => /\.sql$/i.test(q) && /migrat/i.test(q) && after.get(q) !== undefined && after.get(q) !== before.get(q))) {
    const first = (after.get(m) ?? '').replace(/^\uFEFF/, '').split('\n').map(l => l.trim()).find(Boolean)
    if (first && CLI_OUTPUT.test(first)) problems.push({ kind: 'Broken', text: `${m} starts with "${first.slice(0, 60)}", which is terminal output, not SQL, so applying it will fail. Remove the lines that aren't SQL.` })
  }
  // A new import of a file that isn't in the project (papermark imported four redaction components from ee/features/redaction/, a
  // folder that isn't there): the build fails. Strict, since files made at build time look missing too: only an import line new in
  // this commit, in a JS/TS/Vue/Svelte file, starting `./`, `../` or `@/`; its folder has no files at all while a folder above it
  // (not the project's top) has some; not a path .gitignore covers, not a generated-looking one, and not one any file already imported before.
  // (built once: every file without its extension, and every folder that holds something)
  const stems = new Set<string>(), dirs = new Set<string>(), lowStems = new Set<string>()
  for (const k of after.keys()) { const st = k.replace(/\.[^/]*$/, ''); stems.add(st); stems.add(k); lowStems.add(st.toLowerCase()); lowStems.add(k.toLowerCase())
    for (let d = k; d.includes('/');) { d = d.slice(0, d.lastIndexOf('/')); if (dirs.has(d)) break; dirs.add(d) } }
  const exists = (q: string) => stems.has(q) || stems.has(q + '/index') || stems.has(q.replace(/\.[cm]?jsx?$/, ''))   // (ESM's './x.js' for x.ts)
  const hasFiles = (d: string) => dirs.has(d)
  // (.gitignore lines as path pieces: `/dist` or `generated/` match that folder anywhere below the .gitignore, `*.gen.ts` by pattern)
  const ignored = [...after].filter(([k]) => /(^|\/)\.gitignore$/.test(k)).flatMap(([, t]) => t.split('\n').map(l => l.trim().replace(/^\/|\/$/g, '')).filter(l => l && !l.startsWith('#') && !l.startsWith('!')))
    .map(g => new RegExp(`(?:^|/)${g.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}(?:/|$)`))
  const GENERATED = /(?:^|\/)(?:generated|__generated__|_generated|\.generated|gen|paraglide|wayfinder|\.svelte-kit|\.next|\.nuxt|\$types|\+types)(?:\/|$)|\.gen(?:\.|$)|(?:^|\/)resources\/js\/(?:routes|actions)(?:\/|$)/
  // (where tsconfig or jsconfig `paths` sends `@/`: "@/*": ["./app/*"])
  const atBases = [...after].filter(([k]) => /(^|\/)[tj]sconfig[\w.]*\.json$/.test(k)).flatMap(([k, t]) => { const dir = k.replace(/\/?[^/]*$/, ''), base = t.match(/"baseUrl"\s*:\s*"([^"]*)"/)?.[1] ?? '.'
      return [...t.matchAll(/"@\/\*"\s*:\s*\[([^\]]*)\]/g)].flatMap(m => [...m[1].matchAll(/"([^"*]*)\*"/g)].map(x => normalize(join(dir || '.', base, x[1])).replace(/^\.\/?/, '').replace(/\/+$/, '') + '/').map(x => x === '/' ? '' : x)) })
    // (and Vite's resolve.alias: '@': path.resolve(__dirname, './client'), or '@': '/src')
    .concat([...after].filter(([k]) => /(^|\/)vite\.config\.[cm]?[jt]s$/.test(k)).flatMap(([k, t]) => [...t.matchAll(/['"]@['"]\s*:\s*(?:\w+\.resolve\([^,]*,\s*)?['"]\.?\/?([^'"]*)['"]/g)].map(m => normalize(join(k.replace(/\/?[^/]*$/, '') || '.', m[1])).replace(/^\.\/?/, '').replace(/\/+$/, '') + '/').map(x => x === '/' ? '' : x)))
  const oldImports = new Set([...before].flatMap(([, t]) => [...t.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1])))
  // (imports read from the syntax tree, multi-line ones too, never text inside a string; a .vue or .svelte file's <script> part)
  const importsOf = (q: string, t = '') => { const code = /\.(?:vue|svelte)$/.test(q) ? [...t.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n') : t
    const sf = ts.createSourceFile('x.tsx', code, ts.ScriptTarget.Latest, false, /\.[cm]?ts$/.test(q) ? ts.ScriptKind.TS : ts.ScriptKind.TSX)
    return sf.statements.filter(ts.isImportDeclaration).filter(d => !d.importClause?.isTypeOnly).map(d => (d.moduleSpecifier as ts.StringLiteral).text) }   // (not `import type`: most builds drop it)
  // (the importing file's own project: the nearest folder above it with a package.json or tsconfig; `@/` starts there)
  const projectOf = (q: string) => { const parts = q.split('/').slice(0, -1); for (let n = parts.length; n >= 0; n--) { const d = parts.slice(0, n).join('/'), pre = d ? d + '/' : ''
    if (after.has(pre + 'package.json') || after.has(pre + 'tsconfig.json') || after.has(pre + 'jsconfig.json')) return pre }; return '' }
  // (a generator's own config or scripts naming that folder: graphql-codegen's gql/, Prisma's custom output, openapi-ts's client/)
  const genText = [...after].filter(([k]) => /(?:^|\/)(?:package\.json|schema\.prisma|codegen\.\w+|\.graphqlrc\w*|[\w-]+\.config\.\w+)$|(?:^|\/)scripts\//.test(k)).map(([, t]) => t).join('\n')
  for (const p of real.filter(q => !q.includes('#') && /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(q) && !TESTS.test(q) && after.has(q))) {
    const had = new Set(importsOf(p, before.get(p) ?? '')), proj = projectOf(p)
    const missing = [...new Set(importsOf(p, after.get(p)).filter(x => /^(?:\.{1,2}\/|@\/)/.test(x) && !had.has(x)))]
      .filter(spec => !oldImports.has(spec) && !GENERATED.test(spec) && !/\.(?:css|scss|sass|less|svg|png|jpe?g|gif|webp|json|md|mdx)(?:\?|$)/.test(spec)).filter(spec => {
        const dir = p.split('/').slice(0, -1).join('/')
        // (`@/` from the project folder, the tsconfig's target, and, in case the project has no config of its own, every folder above)
        const ups = dir.split('/').map((_, k, xs) => xs.slice(0, k + 1).join('/') + '/')
        const cands = spec.startsWith('@/') ? [proj + spec.slice(2), `${proj}src/${spec.slice(2)}`, ...atBases.map(x => x + spec.slice(2)), ...ups.flatMap(u => [u + spec.slice(2), `${u}src/${spec.slice(2)}`])] : [join(dir, spec).replace(/^\.\//, '')]
        const under = (c: string) => c.split('/').some((_, k, xs) => k > 0 && after.has(xs.slice(0, k).join('/')))   // a symlink or submodule is one entry
        const near = (c: string) => lowStems.has(c.toLowerCase()) || lowStems.has(c.toLowerCase() + '/index')
        return cands.every(c => !exists(c) && !near(c) && !under(c) && !['', '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'].some(e => ignored.some(re => re.test(c + e)))) && [cands[0]].filter(c => c.startsWith(proj) && !c.startsWith('..')).some(c => { const d = c.split('/').slice(0, -1).join('/')
          const top = d.split('/').find((_, k, xs) => !hasFiles(xs.slice(0, k + 1).join('/'))) ?? ''
          return d && !hasFiles(d) && !(top && new RegExp(String.raw`['"/]${top.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"/]`).test(genText)) && d.split('/').slice(1).some((_, k, xs) => hasFiles(d.split('/').slice(0, xs.length - k).join('/'))) }) })
    if (missing.length) problems.push({ kind: 'Broken', text: `${p} imports ${list(missing.slice(0, 2).map(x => `"${x}"`))}${missing.length > 2 ? ` and ${missing.length - 2} more` : ''}, which ${missing.length > 1 ? "aren't" : "isn't"} in the project, so the app won't build (unless ${missing.length > 1 ? 'they are' : "it's"} made when it builds). Add the missing ${missing.length > 1 ? 'files' : 'file'}, or ask the agent where ${missing.length > 1 ? 'they are' : 'it is'}.` })
  }
  // A file cut off or left unbalanced (LinkStack's functions.php lost the end of a function: every page that loads it crashed). Two
  // signs together: the parser finds an error it didn't before, and the braces no longer balance (strings and comments aside). A
  // newer language feature the parser doesn't know never unbalances braces. Brace languages only (not Python or Ruby).
  for (const p of real.filter(q => !q.includes('#') && /\.(?:[cm]?[jt]sx?|php|java|cs|go)$/.test(q) && !/\.blade\.php$/.test(q) && after.has(q) && before.has(q))) {
    const js = /\.[cm]?[jt]sx?$/.test(p), err = (F: typeof A, q: string) => !!(F.files.get(q) as FileFacts & { parseError?: boolean } | undefined)?.parseError
    const cut = js ? cutTs(p, after.get(p)) && !cutTs(p, before.get(p))
      // (not a PHP file with HTML after a `?>`: plain's PHP grammar can't read HTML, and its CSS isn't PHP)
      : !err(A, p) && err(B, p) && !(/\.php$/.test(p) && /\?>\s*\S/.test(after.get(p) ?? '')) && braces(before.get(p), p) === 0 && braces(after.get(p), p) > 0
    if (cut) problems.push({ kind: 'Broken', text: `${p} looks cut off: some of its { brackets are never closed, so it no longer runs.${/\.php$/.test(p) ? ' Every page that loads it will crash.' : " The app won't build."} Ask the agent to restore the end of the file.` })
  }
  // An upload list that now takes SVG: an SVG can carry a script that runs when someone opens it from your site (stored XSS).
  // A list is a line (a [...] list joined into one) naming svg next to png/jpg/gif/webp, about uploads: Laravel `mimes:`, an `accept`,
  // an allowed or valid list, or in an upload/validation file. Not bundler rules (`test: /\.(png|svg)$/`), globs (`*.svg`) or imports.
  // Counted over the changed files together, so a list moved from one file to another isn't new.
  // ponytail: a list spread over lines without brackets (a PHP `array(` or a Python tuple over lines) is missed
  // (svg as an item in code, lower case: 'svg', ".svg", image/svg+xml, mimes:png,svg; not help text like "SVG, PNG or JPG", output
  // or export formats (a QR code's ["png", "svg"]), or a content-type map. Not docs, translations or data files.)
  const svgLists = (p: string, t = '') => TESTS.test(p) || /\.(?:md|mdx|txt|json|po|ya?ml|lock)$|(^|\/)(?:locales?|i18n|lang)\//i.test(p) ? 0 : t.replace(/\[[^[\]]*\]/g, x => x.replace(/\s+/g, ' ')).split('\n')
    .filter(l => /['"`,|:]\s*(?:\.|image\/)?svg(?:\+xml)?\s*(?=['"`,|\]])/.test(l) && /\b(?:png|jpe?g|gif|webp)\b/i.test(l)
    && (/mimes?\b|mime_?types?|\baccept|\ballow|\bpermit|whitelist|\bvalid|upload/i.test(l) || /upload|valid/i.test(p) && !/\.(?:[jt]sx|vue|svelte)$|(^|\/)(?:scripts|tools|bin)\//.test(p))
    && !/\\\.|\*\.svg|\btest\s*:|loader|^\s*import\b|\bfrom\s+['"]|require\(|formats?\b|\boutput|export_?(?:as|to|formats?)|\bsvg(?:\+xml)?['"]?\s*:|sharp\(|\.png\(|\.toFormat\(/i.test(l)).length
  // A server template whose link now goes straight to an address someone saved: `href="{{ $link->link }}"` (Blade), `<%= user.website %>` or
  // `link_to ..., user.website` (ERB), `href="{{ site.url }}"` (Django, Jinja). A saved "javascript:..." runs in whoever clicks it. Only
  // fields named for an address, on an object (not a bare variable or a route helper), new in that file; not a Django URLField (it only
  // takes http, https and ftp).
  // ponytail: JSX, Vue and Svelte are left out: their links mostly come from fixed menu lists in the same file
  // (nor a field some line limits to web addresses: `format: URI::DEFAULT_PARSER.make_regexp(%w[http https])`, `starts_with:http`)
  const SCHEME_CHECK = /\bvalidates?\b[^\n]*\burl\s*:|(?:validat|format\s*:|\brules?\b|regexp?|starts_with|schemes?|protocols?)[^\n]*\bhttps?\b|\bhttps?\b[^\n]*(?:schemes?|protocols?)|make_regexp|URI::regexp|URI\.regexp/i
  const URL_FIELD = /^(?:link|url|website|web_?site|homepage|home_?page|site_?url|web_?url|profile_?url|external_?url|social_?url|link_?url|target_?url)$/i
  // (a `.url` on an upload or a page, `d.file.url`, `post.url`, is made by the app; Jekyll's `| relative_url` too. Angular templates
  // (.component.html) clean "javascript:" links themselves. The scheme check is looked for in the app's own code, not vendor or CSS.)
  // (the field's object names a model that stores it: `$link->link` and a links table with a link column, `@user.website` and users)
  const storedBy = new Map<string, Set<string>>()
  const keep = (m: string, fs: string[]) => { const k = squash(singular(m)); storedBy.set(k, new Set([...storedBy.get(k) ?? [], ...fs.map(squash)])) }
  for (const [m, fs] of B.models) keep(m, fs)
  for (const m of [...B.phpMigrations, ...B.rbMigrations]) for (const x of ((B.files.get(m) as PhpFacts | undefined)?.php ?? (B.files.get(m) as RbFacts | undefined)?.rb)?.schema ?? []) keep(x.table, x.add)
  const stored = (obj: string, x: string) => !!storedBy.get(squash(singular(obj.replace(/^[@$]/, ''))))?.has(squash(x))
  const ownCode = [...after].filter(([q]) => CODE.test(q) && !/(^|\/)(?:vendor|node_modules|public|assets|dist|build|static)\//.test(q))
  // (a loop's item is read as one of its list: `{% for b in bookmarks %}`, `@foreach ($links as $link)`, `@links.each do |link|`)
  const loops = (t: string) => new Map([...t.matchAll(/\{%-?\s*for\s+(\w+)\s+in\s+(?:\w+\.)*?(\w+)(?:\.all)?\s*(?:-?%\}|\|)|@foreach\s*\(\s*\$[\w>-]*?(\w+)\s+as\s+(?:\$\w+\s*=>\s*)?\$(\w+)|@?[\w.]*?(\w+)\.each\s+do\s*\|(\w+)\|/g)].map(m => m[1] ? [m[1], m[2]] : m[3] ? [m[4], m[3]] : [m[6], m[5]]))
  const savedHrefs = (p: string, t = '') => /\.(?:blade\.php|erb|html|jinja2?|j2|twig)$/.test(p) && !/\.component\.html$/.test(p) ? [...t.matchAll(/href\s*=\s*["']\s*(?:\{[{!]!?\s*(\$\w+(?:->\w+)+)\s*!?[!}]\}|<%=\s*(@?\w+(?:\.\w+)+)\s*-?%>|\{\{\s*(\w+(?:\.\w+)+)\s*(\|[^}]*)?\}\})\s*["']|\blink_to\b[^\n,]*,\s*(@?\w+(?:\.\w+)+)\s*(?=[,)\n]|-?%>|$)/gm)]
    .filter(m => !/relative_url|absolute_url/.test(m[4] ?? '')).map(m => (m[1] ?? m[2] ?? m[3] ?? m[5]).split(/->|\./))
    .filter(s => !(/url/i.test(s.at(-1)!) && /^(?:file|image|img|avatar|photo|picture|pic|attachment|document|doc|media|logo|cover|thumbnail|thumb|icon|banner|video|audio|upload|post|page|article|request|self)$/i.test(s.at(-2)!.replace(/^[@$]/, ''))))
    // (only a field some model stores: not a menu item's url, a config value (`settings.SITE_URL`) or a Stripe session's url)
    .filter(s => stored(s.at(-2)!, s.at(-1)!) || s.length === 2 && stored(loops(t).get(s[0].replace(/^[@$]/, '')) ?? '', s[1])).map(s => s.at(-1)!).filter(x => URL_FIELD.test(x) && x !== x.toUpperCase() && !ownCode.some(([, t]) => new RegExp(String.raw`\b${x}\s*=\s*(?:models\.)?URLField\b`).test(t) || t.split('\n').some(l => l.length < 300 && new RegExp(String.raw`\b${x}\b`).test(l) && SCHEME_CHECK.test(l)))) : []
  const hrefNow = real.filter(p => savedHrefs(p, after.get(p)).length > savedHrefs(p, before.get(p)).length)
  if (hrefNow.length) problems.push({ kind: 'Check', text: `Links in ${list(hrefNow)} now go straight to an address people saved. If someone saves one that starts with "javascript:", it runs code in the browser of whoever clicks it, admins included. Make sure saved links can only start with http:// or https://.` })
  const svgNow = real.filter(p => svgLists(p, after.get(p)) > svgLists(p, before.get(p)))
  if (real.reduce((n, p) => n + svgLists(p, after.get(p)) - svgLists(p, before.get(p)), 0) > 0)
    problems.push({ kind: 'Unsafe', text: `Uploads now accept SVG files (in ${list(svgNow)}). An SVG can carry a script that runs when someone opens it from your site, so one user could attack others, admins included. Leave SVG out, or serve uploaded files from a separate domain.` })

  // (No "doesn't look related to what you asked for" guess: on 70 real commits it was wrong 42 times in 45, mostly on the
  // file that was the fix. See docs/production-eval.md.)
  for (const p of real) {
    const a = A.files.get(p), b = B.files.get(p)
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
  const VERIFIES = /constructEvent|construct_event|ConstructEvent|parseEventNotification|parse_event_notification/
  const verifies = (t = '') => VERIFIES.test(t)
  const hookFiles = (X: Snap) => [...X].filter(([p, t]) => CODE.test(p) && verifies(t) && !/(^|\/)(tests?|__tests__|spec|scripts|e2e|cypress)\/|\.(test|spec)\.\w+$|Tests?\.\w+$|(^|\/)test_\w+\.py$|_test\.py$/i.test(p))
  // A webhook that catches a failed database write and carries on: it still answers 200, so Stripe counts it delivered and never
  // retries, and the customer paid for nothing. A catch counts when its try writes (update, create, upsert, save, delete, a commit)
  // and it neither throws nor answers with an error status (a 4xx/5xx, next(err)). Python: pySwallows.
  const swallows = (p: string, t: string) => {
    if (/\.py$/.test(p)) return pySwallows(t, VERIFIES)
    if (!/\.[cm]?[jt]sx?$/.test(p)) return 0
    const sf = ts.createSourceFile(p, t, ts.ScriptTarget.Latest, true, /x$/.test(p) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    // (only in the function that checks the signature, the innermost one)
    const fns: ts.Node[] = [], find = (x: ts.Node) => { if (ts.isFunctionLike(x) && VERIFIES.test(x.getText(sf))) fns.push(x); ts.forEachChild(x, find) }
    find(sf)
    let n = 0
    // (a catch that answers on purpose, `return new Response("already processed")` for an event seen before, is a decision: only one
    // that logs and carries on counts)
    const exits = (x: ts.Node): boolean => ts.isThrowStatement(x) || ts.isReturnStatement(x) || !ts.isFunctionLike(x) && ts.forEachChild(x, exits) === true
    // (nor one that sets a flag the code checks later, `failed = true`, or a best-effort write inside a try whose own catch answers)
    // (a flag: a name the catch assigns, `failed = true`, that the function reads again after the try)
    let fn: ts.Node = sf
    // (any assignment, `+=`, `||=`, `++`, a destructuring, or `errors.push(e)`. The name is the whole dotted chain, `ctx.failed`,
    // `this.failed`: a bare `res` or `s` is read after any try, so `res.set(...)` or `s.failed = true` alone isn't a flag)
    const root = (e: ts.Node): string[] => { while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression
      if (ts.isIdentifier(e)) return [e.text]
      if (ts.isPropertyAccessExpression(e)) { const r = e.expression.kind === ts.SyntaxKind.ThisKeyword ? ['this'] : root(e.expression); return r.length === 1 ? [`${r[0]}.${e.name.text}`] : [] }
      if (ts.isElementAccessExpression(e)) return root(e.expression)
      if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e)) { const out: string[] = []; const f = (y: ts.Node) => { if (ts.isIdentifier(y)) out.push(y.text); else ts.forEachChild(y, f) }; f(e); return out }
      return [] }
    const flag = (c: ts.CatchClause) => { const names: string[] = [], find = (y: ts.Node) => {
        if (ts.isBinaryExpression(y) && y.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && y.operatorToken.kind <= ts.SyntaxKind.LastAssignment) names.push(...root(y.left))
        if ((ts.isPrefixUnaryExpression(y) || ts.isPostfixUnaryExpression(y)) && (y.operator === ts.SyntaxKind.PlusPlusToken || y.operator === ts.SyntaxKind.MinusMinusToken)) names.push(...root(y.operand))
        if (ts.isCallExpression(y) && ts.isPropertyAccessExpression(y.expression) && /^(?:push|add|set|unshift)$/.test(y.expression.name.text)) names.push(...root(y.expression.expression))
        if (!ts.isFunctionLike(y)) ts.forEachChild(y, find) }
      find(c.block); const after = sf.text.slice(c.parent.end, fn.end)
      return names.some(n => /^[\w$]+(?:\.[\w$]+)*$/.test(n) && !/^(?:req|res|request|response|reply|event|evt|err|error)$/.test(n.split('.')[0]) && new RegExp(String.raw`(?<![\w$.])${n.replace(/[.$]/g, '\\$&')}(?![\w$])`).test(after)) }
    const handled = (c: ts.CatchClause) => exits(c.block) || FAILS.test(c.block.getText(sf)) || flag(c)
    // (the try's own writes: an inner try that answers for its write already handles it)
    const own = (b: ts.Block) => { let t = b.getText(sf); const inner: ts.TryStatement[] = [], find = (y: ts.Node) => { if (ts.isTryStatement(y) && y.catchClause && handled(y.catchClause)) inner.push(y); else if (!ts.isFunctionLike(y)) ts.forEachChild(y, find) }
      ts.forEachChild(b, find); for (const i of inner.reverse()) t = t.slice(0, i.getStart(sf) - b.getStart(sf)) + t.slice(i.end - b.getStart(sf)); return t }
    const visit = (x: ts.Node, inside = false) => {
      if (ts.isTryStatement(x) && x.catchClause && !inside && dbWrite(own(x.tryBlock)) && !handled(x.catchClause)) n++
      if (ts.isTryStatement(x) && x.catchClause && handled(x.catchClause)) { ts.forEachChild(x.tryBlock, y => visit(y, true)); ts.forEachChild(x.catchClause, y => visit(y, inside)); return }
      ts.forEachChild(x, y => visit(y, inside))
    }
    for (const f of fns) if (!fns.some(g => g !== f && g.pos >= f.pos && g.end <= f.end)) { fn = f; visit(f) }
    return n
  }
  const swallowed = hookFiles(after).filter(([p, t]) => swallows(p, t) > swallows(p, before.get(p) ?? '')).map(([p]) => p)
  if (swallowed.length) problems.push({ kind: 'Unsafe', text: `If saving to your database fails in your Stripe webhook (${list(swallowed)}), the error is caught and Stripe is still told it worked, so it won't try again. A customer can pay and never get what they paid for. Answer with an error (status 500) so Stripe retries.` })
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
  // A package removed from package.json that the app's code still imports: the build fails, unless another package happens to bring
  // it along. Not when any package.json still lists it (a monorepo), not @types/ packages, and only imports in the app's own code
  // (not tests, not node_modules).
  // (any kind of listing counts: peer and optional too; and Node's own modules (events, buffer, url) never need one)
  const listed = (snap: Snap) => new Set([...snap].filter(([k]) => /(^|\/)package\.json$/.test(k) && !k.includes('node_modules/')).flatMap(([, t]) => { try { const j = JSON.parse(t)
    return [...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {}), ...Object.keys(j.peerDependencies ?? {}), ...Object.keys(j.optionalDependencies ?? {})] } catch { return [] } }))
  const listedB = listed(after)
  // (modules a file uses, from its syntax tree: import, export ... from, require('x'), import('x'); never text in a string or comment)
  const modulesOf = (q: string, t: string) => { const code = /\.(?:vue|svelte)$/.test(q) ? [...t.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n') : t
    const sf = ts.createSourceFile('x.tsx', code, ts.ScriptTarget.Latest, false, /\.[cm]?ts$/.test(q) ? ts.ScriptKind.TS : ts.ScriptKind.TSX), out: string[] = []
    const v = (n: ts.Node) => { if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text)
      else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(n.expression) && n.expression.text === 'require') && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text)
      ts.forEachChild(n, v) }
    v(sf); return out }
  // (a name a bundler, tsconfig, Babel or Deno config mentions may be aliased or come from elsewhere: `alias: { react: 'preact/compat' }`)
  const configText = [...after].filter(([k]) => /(?:^|\/)(?:[\w-]+\.config\.[cm]?[jt]s|[tj]sconfig[\w.]*\.json|\.babelrc\w*|babel\.config\.\w+|deno\.jsonc?|import_map\.json)$/.test(k)).map(([, t]) => t).join('\n')
  const SETUP = /(?:^|\/)(?:setupTests|setup-tests|test-setup)\.[cm]?[jt]sx?$|\.setup\.[cm]?[jt]sx?$|(?:^|\/)(?:cypress|playwright|e2e|\.storybook)\/|\.stories\.[cm]?[jt]sx?$/
  for (const d of [...listed(before)].filter(x => !listedB.has(x) && !x.startsWith('@types/') && !builtinModules.includes(x) && !/^(?:server-only|client-only)$/.test(x)
    && !new RegExp(String.raw`['"]${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"/]|[{,\s]${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*:`).test(configText))) {
    const users = [...after].filter(([k, t]) => /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(k) && !k.includes('node_modules/') && !TESTS.test(k) && !SETUP.test(k) && t.includes(d)
      && modulesOf(k, t).some(m => m === d || m.startsWith(d + '/'))).map(([k]) => k)
    const names = users.length > 3 ? [...users.slice(0, 2), `${users.length - 2} more files`] : users
    if (users.length) problems.push({ kind: 'Check', text: `${d} was removed from package.json, but ${list(names)} still ${users.length > 1 ? 'use' : 'uses'} it. The app may not build or start (it only works if another package happens to bring ${d} along). Add it back, or remove those imports.` })
  }
  const svcBefore = new Set([...A.files.values()].flatMap(f => [...f.services]))
  for (const s of new Set([...B.files.values()].flatMap(f => [...f.services]))) if (!svcBefore.has(s))
    changes.push({ group: 'Outside services', isNew: true, text: EMAIL.has(s)
      ? `Your app now sends emails${s === 'email' ? '' : ` through ${s}`}. People's email addresses are shared with ${s === 'email' ? 'the email provider' : s}.`
        : AI.has(s) ? `Your app now uses ${s}. What people write in it can be sent to ${s}, and each request costs you money.` : `Your app now uses ${s}.` })

  // Guesses about money, worded as questions. Each says it's a guess.
  // (a discount or a new price counts too: a Stripe coupon, promotion code or price)
  const moneyChanged = real.some(p => route(p) && (B.files.get(p)?.money || [...B.files.get(p)?.outside ?? []].some(o => /^Stripe: (?:coupons|promotionCodes|prices|plans)\.create$/.test(o))))
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
  const appAfter = [...after].filter(([q]) => srcFile(q) && !isTest(q)).map(([, t]) => t).join('\n')
  const appBefore = [...before].filter(([q]) => srcFile(q) && !isTest(q)).map(([, t]) => t).join('\n')
  // Limits written as constants (DAILY_REQUEST_LIMIT = 50, MAX_PROJECTS = 3, FREE_EDIT_LIMIT = 20): new, changed, replaced, gone,
  // judged across the app (a limit moved to another file isn't new or gone). Replaced: the new one takes the old one's exact place
  // in a comparison (`used >= FREE_EDIT_LIMIT` where `used >= DAILY_REQUEST_LIMIT` was). A limit that reset every day (hour,
  // minute, week, month, window) replaced by one that doesn't, with fewer date checks in the code around them (the files that use
  // either, and what those import), counts everything ever: people who already used it up lose access (Quill p1).
  // ponytail: constants only (not settings or the database); whole name parts; a name defined twice in a file (per plan) is
  // skipped; Go MixedCaps aren't read
  const LIMIT_RE = /^[ \t]*(?:export\s+)?(?:(?:const|let|var|final|static|readonly|public|private|protected|val|int|long|Integer|Long|number)\s+)*([A-Z][A-Z0-9_]*)\s*(?::\s*[\w[\]]+\s*)?[:=]\s*([\d_]+(?:\.\d+)?)\s*(?:as\s+const\s*)?(?:[;,]|$|#|\/\/)/gm
  const isLimit = (n: string) => /(^|_)(LIMIT|MAX|QUOTA|CAP|ALLOWANCE|BUDGET)(_|$)/.test(n) && !/(^|_)(MS|SECONDS?|SECS?|MINUTES?|AGE|TTL|TIMEOUT|WINDOW|RETRIES|RETRY|POOL|WIDTH|HEIGHT|PX|DELAY|INTERVAL|BACKOFF|CONNECTIONS?|WORKERS?|THREADS?|ENABLED?|DISABLED?|SKIP|CHECK|FLAG|ON|OFF|MODE)(_|$)/.test(n) && !/UNLIMITED/.test(n)
  // (also a limit whose number is the fallback for a setting: `MAX_PAGE = getattr(settings, "MAX_PAGE", 10_000)`,
  // `int(os.getenv("X", "50"))`, `Number(process.env.X ?? 50)`; said with "your settings can change it")
  const LIMIT_SETTING = /^[ \t]*(?:export\s+)?(?:(?:const|let|var)\s+)?([A-Z][A-Z0-9_]*)\s*(?::\s*\w+\s*)?=\s*(?:int\(\s*|Number\(\s*|parseInt\(\s*)?(?:getattr\(\s*settings\s*,\s*['"](\w+)['"]\s*,\s*|os\.(?:getenv|environ\.get)\(\s*['"](\w+)['"]\s*,\s*|process\.env\.(\w+)\s*(?:\?\?|\|\|)\s*)['"]?([\d_]+)['"]?\s*\)?\s*(?:,\s*10\s*)?\)?\s*;?\s*(?:#[^\n]*|\/\/[^\n]*)?$/gm
  // (not a fallback of 0, usually "off"; not one the app's settings set to a number elsewhere, settings.py's MAX_PAGE = 500: that one counts)
  const settingLimits = (t = '', snap: Snap = after) => [...t.matchAll(LIMIT_SETTING)].filter(m => isLimit(m[1]) && Number(m[5].replace(/_/g, '')) > 0
    && ![...snap.values()].some(x => x !== t && new RegExp(String.raw`^[ \t]*${m[2] ?? m[3] ?? m[4]}\s*=\s*[\d_]+`, 'm').test(x))).map(m => { const r = [m[0], m[1], m[5]] as unknown as RegExpExecArray; r.index = m.index; return r })
  const fromSettings = (t: string | undefined, n: string) => settingLimits(t ?? '').some(m => m[1] === n)
  const limitsOf = (t = '', snap: Snap = after) => { const set_ = settingLimits(t, snap)
    const all_ = [...[...t.matchAll(LIMIT_RE)].filter(m => isLimit(m[1])), ...set_], n = new Map<string, number>()
    for (const m of all_) n.set(m[1], (n.get(m[1]) ?? 0) + 1)
    return new Map(all_.filter(m => n.get(m[1]) === 1).map(m => [m[1], m[2].replace(/_/g, '')])) }   // (repeated per plan: skipped)
  const definedIn = (m: Snap) => { const out = new Map<string, Set<string>>()
    for (const [q, t] of m) if (srcFile(q) && !isTest(q)) for (const k of limitsOf(t).keys()) out.set(k, (out.get(k) ?? new Set()).add(q))
    return out }
  const defA = definedIn(before), defB = definedIn(after)
  const PERIOD = /DAILY|HOURLY|WEEKLY|MONTHLY|YEARLY|ANNUAL|ROLLING|WINDOW|(^|_)(PER_)?(MINUTE|MIN|HOUR|HR|DAY|WEEK|MONTH|YEAR|\d+[HDM])(_|$)/
  const DATE_CHECK = /\b(?:created_?at|createdAt|inserted_?at)\b[^\n]{0,60}(?:>=?|\bgte?\b|__gte?\b|__date\b|==)|today|startOf(?:Day|Week|Month|Today)|start_of_(?:day|today)|\bday_?[Ss]tart|\bdate\.today\(\)|timedelta\(|subDays\(|time\.min\b|DATE\(\s*'now'|CURRENT_DATE|beginning_of_day|all_day|Date\.current|func\.date\(|gte\([^)]*createdAt/gi
  // (the files that use a name, and the app files they import: relative, @/ and ~/ paths, Python's from .x / from app.x)
  const importsOf_ = (m: Snap, p: string) => { const t = m.get(p) ?? '', noExt = (x: string) => x.replace(/\.(?:[jt]sx?|mjs|py)$/, '')
    const specs = [...t.matchAll(/from\s+['"]((?:\.{1,2}|@|~)\/[^'"]+)['"]/g)].map(x => x[1])
    const py = [...t.matchAll(/^\s*from\s+(\.+|[\w.]+)\s*(\w*)\s+import/gm)].map(x => x[1].startsWith('.') ? p.split('/').slice(0, -1).join('/') + '/' + (x[2] || '') : x[1].replace(/\./g, '/'))
    return [...m.keys()].filter(k => !k.includes('#') && (py.some(x => noExt(k) === x || noExt(k) === x + '/__init__') || specs.some(spec => {
      if (/^[@~]\//.test(spec)) { const rest = noExt(spec.slice(2)); return noExt(k) === rest || noExt(k).endsWith('/' + rest) }
      const parts = p.split('/').slice(0, -1); for (const seg of spec.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg) }
      return noExt(k) === noExt(parts.join('/')) || noExt(k) === noExt(parts.join('/')) + '/index' }))) }
  const around = (m: Snap, names: string[]) => { const users = [...m.keys()].filter(q => srcFile(q) && !isTest(q) && names.some(n => new RegExp(String.raw`\b${n}\b`).test(m.get(q) ?? '')))
    return [...new Set([...users, ...users.flatMap(q => importsOf_(m, q))])].reduce((n, q) => n + [...(m.get(q) ?? '').matchAll(DATE_CHECK)].length, 0) }
  const nice_ = (v: string) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 })
  // (MAX_PROJECTS: "a maximum of 3 projects"; NAME_MAX_LENGTH: "a maximum name length of 80"; MAX_UPLOAD_MB: "a maximum upload size
  // of 10 MB"; COST_LIMIT_USD: "a cost limit of $0.0005")
  const UNIT: Record<string, string> = { MB: 'MB', KB: 'KB', GB: 'GB', BYTES: 'bytes', CHARS: 'characters', CHARACTERS: 'characters' }
  // (a count limit in a file with one time window, used as one: `MAX_MESSAGES = 5` and `WINDOW_MS = 10_000`, with `now - WINDOW_MS`
  // within a few lines of the limit's comparison, nothing else between: "a maximum of 5 messages per 10 seconds". Only WINDOW names, a
  // unit from the name's last part, and only when the file has no other limit: a POLL_INTERVAL or a token's PERIOD isn't one.)
  const windowOf = (t: string, limit: string) => { const ws = [...t.matchAll(/^[ \t]*(?:export\s+)?(?:const|let|var)?\s*(\w*WINDOW\w*)\s*(?::\s*\w+\s*)?=\s*([\d_]+(?:\s*\*\s*[\d_]+)*)\s*;?\s*$/gm)]
    if (ws.length !== 1) return ''
    const n = ws[0][1], raw = ws[0][2].split('*').reduce((x, y) => x * Number(y.replace(/[_\s]/g, '')), 1)
    const sec = /_(?:MS|MILLIS|MILLISECONDS)$/.test(n) ? raw / 1000 : /_(?:S|SEC|SECS|SECONDS)$/.test(n) ? raw : /_(?:MIN|MINS|MINUTES)$/.test(n) ? raw * 60 : /_(?:H|HR|HRS|HOURS)$/.test(n) ? raw * 3600 : /_DAYS?$/.test(n) ? raw * 86400 : NaN
    if (!(sec > 0)) return ''
    const lines = t.split('\n'), sub = lines.findIndex(l => new RegExp(String.raw`(?:\b\w*[Nn]ow\b(?:\(\))?|Date\.now\(\)|time\.time\(\)|time\.monotonic\(\)|Time\.(?:now|current))\s*-\s*${n}\b`).test(l))
    const cmp = lines.findIndex(l => new RegExp(String.raw`[<>]=?\s*${limit}\b|\b${limit}\s*[<>]`).test(l))
    if (sub < 0 || cmp < 0 || Math.abs(sub - cmp) > 10 || lines.slice(Math.min(sub, cmp) + 1, Math.max(sub, cmp)).some(l => /\bfunction\b|\bdef\s|\bfunc\s|=>\s*\{|\bclass\s/.test(l))) return ''
    const [k, u] = sec % 86400 === 0 ? [sec / 86400, 'day'] : sec % 3600 === 0 ? [sec / 3600, 'hour'] : sec % 60 === 0 ? [sec / 60, 'minute'] : [sec, 'second']
    return ` per ${k === 1 ? u : `${nice_(String(k))} ${u}s`}` }
  const phrase = (n: string, v: string, t = '') => { const parts = n.split('_').filter(Boolean), last = parts.at(-1)!, usd = last === 'USD', unit = UNIT[last]
    if (usd || unit) parts.pop()
    const num = usd ? `$${nice_(v)}` : unit ? `${nice_(v)} ${unit}` : nice_(v)
    if (parts[0] === 'MAX' && !unit && !usd) return `a maximum of ${num} ${words(parts.slice(1).join('_').toLowerCase().replace(/_/g, ' '))}${PERIOD.test(n) || !t ? '' : windowOf(t, n)}`
    const mi = parts.indexOf('MAX'); if (mi > 0) { parts.splice(mi, 1); parts.unshift('MAX') }
    let w = words(parts.join('_').toLowerCase().replace(/_/g, ' ').replace(/^max\b/, 'maximum')); if (unit && !/size|length/.test(w)) w += unit === 'characters' ? ' length' : ' size'
    return `a ${w} of ${num}` }
  // (the limit's name alone, and a value with its unit: "maximum upload size", "10 MB", "$5")
  const nameOf = (n: string) => { const parts = n.split('_').filter(Boolean), unit = UNIT[parts.at(-1)!]; if (parts.at(-1) === 'USD' || unit) parts.pop()
    const mi = parts.indexOf('MAX'); if (mi > 0) { parts.splice(mi, 1); parts.unshift('MAX') }
    let w = words(parts.join('_').toLowerCase().replace(/_/g, ' ').replace(/^max\b/, 'maximum')); if (unit && !/size|length/.test(w)) w += unit === 'characters' ? ' length' : ' size'
    return w }
  const valueOf = (n: string, v: string) => { const last = n.split('_').at(-1)!; return last === 'USD' ? `$${nice_(v)}` : UNIT[last] ? `${nice_(v)} ${UNIT[last]}` : nice_(v) }
  for (const p of real.filter(q => !q.includes('#') && srcFile(q) && !isTest(q))) {
    const a = limitsOf(before.get(p), before), b = limitsOf(after.get(p))
    const movedHere = (n: string) => [...defA.get(n) ?? []].some(q => q !== p && !defB.get(n)?.has(q))   // (from another file)
    // (assigned at all, any value: `= int(os.getenv("X", "50"))` still sets it; a name the file had, even per plan, isn't new)
    const assigned = (n: string, t: string) => new RegExp(String.raw`^[ \t]*(?:export\s+)?(?:(?:const|let|var|final|static|readonly|public|private|protected|val|int|long)\s+)*${n}\s*(?::\s*[\w[\]]+\s*)?=(?!=)|(?:^|[{,]\s*)${n}\s*:\s*(?!string\b|number\b|boolean\b|any\b)[^\s,}]`, 'm').test(t)
    const movedAway = (n: string) => [...defB.get(n) ?? []].some(q => q !== p && !defA.get(n)?.has(q))
    const cmpLines = (t: string, n: string) => (t.match(new RegExp(String.raw`^[^\n]*(?:[<>]=?\s*${n}\b|\b${n}\s*[<>-])[^\n]*$`, 'gm')) ?? []).map(l => l.trim())
    const useLines = (t: string, n: string) => (t.match(new RegExp(String.raw`^[^\n]*\b${n}\b[^\n]*$`, 'gm')) ?? []).map(l => l.trim())
    // (set to "no limit": None, null, Infinity, inf, -1, sys.maxsize, Number.MAX_SAFE_INTEGER)
    const unlimited = (n: string) => new RegExp(String.raw`\b${n}\s*(?::\s*[\w[\]]+\s*)?[:=]\s*(?:None|null|undefined|Infinity|Number\.POSITIVE_INFINITY|Number\.MAX_SAFE_INTEGER|float\(\s*['"]inf['"]\s*\)|math\.inf|sys\.maxsize|-1)(?=\s*(?:[;,]|#|\/\/|$))`, 'm').test(after.get(p) ?? '')
    // (a limit read from a setting isn't gone when the code reads the setting another way now: settings.MAX_PAGE)
    const goneRaw = [...a].filter(([n]) => !b.has(n) && !movedAway(n) && (!assigned(n, appAfter) || unlimited(n)) && !settingLimits(before.get(p), before).some(m => m[1] === n))
    const addedRaw = [...b].filter(([n]) => !a.has(n) && !movedHere(n) && !assigned(n, before.get(p) ?? ''))
    // a replacement first: the new one in the old one's exact place in a comparison
    const swap = goneRaw.length === 1 && addedRaw.length === 1 && !unlimited(goneRaw[0][0]) && cmpLines(before.get(p) ?? '', goneRaw[0][0]).some(l => cmpLines(after.get(p) ?? '', addedRaw[0][0]).includes(l.replace(new RegExp(String.raw`\b${goneRaw[0][0]}\b`, 'g'), addedRaw[0][0]))) ? [goneRaw[0], addedRaw[0]] as const : undefined
    // a rename (no line): another name in the old one's place in the lines that used it (or its definition, when nothing used it)
    // (its uses in every file, not just this one; the definition line only when nothing anywhere used it; and the new name new to
    // the app: `pro ? PRO_LIMIT : PRO_LIMIT` in place of FREE_LIMIT isn't a rename)
    const renamedTo = (n: string) => { const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), isDef = (l: string) => new RegExp(String.raw`^(?:export\s+)?(?:\w+\s+)*${n}\s*(?::\s*[\w[\]]+\s*)?[:=]`).test(l)
      const where = [...before].filter(([q]) => srcFile(q) && !isTest(q)).map(([q, t]) => [q, useLines(t, n).filter(l => !isDef(l))] as const).filter(([, ls]) => ls.length)
      const pairs = where.length ? where : [[p, useLines(before.get(p) ?? '', n)] as const]
      const knownBefore = (x: string) => new RegExp(String.raw`(^|[^\w])${x}\s*(?::\s*[\w[\]]+\s*)?[:=]`, 'm').test(appBefore)
      return pairs.every(([q, ls]) => ls.length > 0 && ls.every(l => { const re = new RegExp('^' + esc(l).replace(new RegExp(String.raw`\b${n}\b`, 'g'), '([A-Z][A-Z0-9_]*)') + '$')
        return (after.get(q) ?? '').split('\n').map(x => x.trim()).some(x => { const mm = re.exec(x); return !!mm && !x.includes(n) && mm.slice(1).every(r => !knownBefore(r)) }) })) }
    const gone = swap ? [] : goneRaw.filter(([n]) => unlimited(n) || !renamedTo(n)), added = swap ? [] : addedRaw.filter(([n]) => !goneRaw.some(([g]) => !unlimited(g) && renamedTo(g) && (after.get(p) ?? '').split('\n').some(x => x.includes(n) && useLines(before.get(p) ?? '', g).some(l => x.trim() === l.replace(new RegExp(String.raw`\b${g}\b`, 'g'), n)))))
    const changed_ = [...b].filter(([n, v]) => a.has(n) && a.get(n) !== v)
    const line: string[] = []
    if (swap) line.push(`The ${nameOf(swap[0][0])} (${valueOf(swap[0][0], swap[0][1])}) is replaced by ${phrase(swap[1][0], swap[1][1])}`)
    else { if (added.length) line.push(`There's now ${list(added.map(([n, v]) => phrase(n, v, added.length === 1 && b.size === 1 ? after.get(p) ?? '' : '') + (fromSettings(after.get(p), n) ? ' (your settings can change it)' : '')))}`); for (const [n, v] of gone) line.push(`The ${nameOf(n)} (${valueOf(n, v)}) is gone${unlimited(n) ? ' (no limit now)' : ''}`) }
    for (const [n, v] of changed_) line.push(`The ${nameOf(n)} changed from ${valueOf(n, a.get(n)!)} to ${valueOf(n, v)}${fromSettings(after.get(p), n) && !settingLimits(before.get(p), before).some(m => m[1] === n) ? ' (your settings can change it now)' : ''}`)
    if (line.length) changes.push({ group: 'Server', text: `${line.join('. ')}.`, detail: p })
    // (date checks in the function with the comparison and the helpers it calls, in this file or by name in the app)
    const fnAround = (t: string, n: string) => { const i = t.search(new RegExp(String.raw`(?:[<>]=?\s*${n}\b|\b${n}\s*[<>-])`)); if (i < 0) return ''
      const heads = [...t.matchAll(/^[ 	]*(?:async\s+)?(?:def|function|func|export\s+(?:async\s+)?function)\s+\w+|^[ 	]*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(/gm)]
      const from = heads.filter(h => h.index! <= i).at(-1)?.index ?? 0, to = heads.find(h => h.index! > i)?.index ?? t.length; return t.slice(from, to) }
    // (a helper's body: `def used(...)` / `function used(...)` up to the next top-level definition, in any app file)
    // (def h / function h / const h = (...) => / h(...) { as a method; up to the next line as far left, or further)
    const helperBody = (t: string, h: string) => { const m = new RegExp(String.raw`^([ \t]*)(?:(?:export\s+)?(?:async\s+)?(?:def|function)\s+${h}\s*\(|(?:export\s+)?(?:const|let|var)\s+${h}\s*(?::\s*[^=]+?)?=\s*(?:async\s*)?(?:(?:\([^)]*\)|\w+)\s*(?::\s*[^=]+?)?=>|function\b)|(?:async\s+)?${h}\s*\([^)]*\)\s*(?::\s*[\w<>[\]|, ]+\s*)?\{)`, 'm').exec(t)
      if (!m) return ''
      const ind = m[1].length, lines = t.slice(m.index).split('\n'); let k = 1
      for (; k < lines.length; k++) { const l = lines[k]; if (!l.trim()) continue; const li = l.length - l.trimStart().length; if (li <= ind && !/^[ \t]*[)}\]]/.test(l)) break }
      return lines.slice(0, k).join('\n') }
    const withHelpers = (m: Snap, n: string) => { const body = fnAround(m.get(p) ?? '', n), app_ = [...m].filter(([q]) => srcFile(q) && !isTest(q)).map(([, t]) => t)
      const helpers = [...new Set([...body.matchAll(/\b([a-z_]\w*)\s*\(/g)].map(x => x[1]))].flatMap(h => app_.map(t => helperBody(t, h)))
      return [body, ...helpers].reduce((k, x) => k + [...x.matchAll(DATE_CHECK)].length, 0) }
    if (swap && PERIOD.test(swap[0][0]) && !PERIOD.test(swap[1][0]) && withHelpers(after, swap[1][0]) < withHelpers(before, swap[0][0])) {
      const n0 = swap[0][0], [n1, v1] = swap[1]
      problems.push({ kind: 'Check', text: `The ${nameOf(n0)} reset every ${/MINUTE|MIN(_|$)/.test(n0) ? 'minute' : /HOUR|HR/.test(n0) ? 'hour' : /WEEK/.test(n0) ? 'week' : /MONTH/.test(n0) ? 'month' : /YEAR|ANNUAL/.test(n0) ? 'year' : /ROLLING|WINDOW/.test(n0) ? 'little while' : 'day'}. The new ${nameOf(n1)} doesn't: it counts everything ever, so anyone who has already used ${nice_(v1)} loses it as soon as this ships, and nobody gets more later. (This is a guess.)` })
    }
  }
  // AI answers capped (max_tokens) with nothing checking whether one was cut short: a cut-off answer looks complete (Quill p5).
  // In an app with an AI library (a dependency, or an import anywhere: the client is often made in lib/openai.ts), a file that calls
  // a model; new across the app (a moved cap isn't new); not a tiny classifier cap (max_tokens=1).
  const AI_SDK = /from\s+['"](?:openai|@anthropic-ai\/sdk|@ai-sdk\/[\w-]+|ai|@google\/genai|@google\/generative-ai|groq-sdk|@mistralai\/mistralai)['"]|^\s*(?:from|import)\s+(?:openai|anthropic|google\.genai|google\.generativeai|langchain_openai|langchain_anthropic)\b|require\(?\s*['"](?:openai|@anthropic-ai\/sdk|anthropic|ruby\/openai)['"]/m
  const hasAI = AI_SDK.test(appAfter) || [...after].some(([q, t]) => /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|Gemfile)$/.test(q) && /["']?(?:openai|@anthropic-ai\/sdk|anthropic|ruby-openai|@ai-sdk\/[\w-]+|google-genai|google-generativeai)["']?/.test(t))
  const MODEL_CALL = /chat\.completions\.(?:create|parse|stream)|responses\.(?:create|stream)|\b(?:client|anthropic|openai|ai|llm|claude)\.messages\.(?:create|stream)|generateText|streamText|generateObject|generate_content|generateContent|ChatCompletion/
  const CAP = /['"]?\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxTokens|maxOutputTokens)\b['"]?\s*[:=]>?\s*([\w.]+)/g
  // (LangChain's .invoke( only in a file that imports langchain: not supabase.functions.invoke or ipcRenderer.invoke)
  const calls = (t: string) => MODEL_CALL.test(t) || /\.invoke\(/.test(t) && /langchain/.test(t)
  const capsIn = (m: Snap) => [...m].filter(([q, t]) => srcFile(q) && !isTest(q) && calls(t)).flatMap(([, t]) => [...t.matchAll(CAP)].map(x => x[1]))
  const capsA = capsIn(before), capsB = capsIn(after)
  // (per value: a second max_tokens=500 is new even though another call already had 500)
  const tally = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())
  const ta = tally(capsA), newCaps = hasAI ? [...tally(capsB)].flatMap(([v, k]) => Array(Math.max(0, k - (ta.get(v) ?? 0))).fill(v)) : []
  // (the Responses API's status compared to "incomplete": not `record.status = "incomplete"`, the app's own)
  const checksEnd = /finish_reason|finishReason|stop_reason|stopReason|incomplete_details|(?:===?|!==?)\s*['"]incomplete['"]|['"]incomplete['"]\s*(?:===?|!==?)/.test(appAfter)
  if (newCaps.length && !newCaps.every(v => /^\d+$/.test(v) && +v <= 50) && !checksEnd)
    problems.push({ kind: 'Check', text: `AI answers now have a length cap (max_tokens), and nothing checks whether an answer was cut short. A cut-off answer looks complete to people, and gets used as if it were. Check the finish reason and tell them. (This is a guess.)` })
  // An AI client that now gives up sooner (`OpenAI(timeout=15)`) than its longest answer takes to write, with nothing streaming it: long
  // answers fail every time (Quill p6). The SDKs wait 10 minutes by default; ~60 tokens a second; the cap is the largest number in the
  // max_tokens expression (`min(6_000, ...)`), or ~4,000 when there's none.
  const aiFiles = (m: Snap) => [...m].filter(([q, t]) => srcFile(q) && !isTest(q) && (calls(t) || /\b(?:Async)?(?:OpenAI|Anthropic)\s*\(/.test(t)))
  // (a timeout is a number or a plain product, `15 * 1000`; anything else, `httpx.Timeout(...)`, a setting, is skipped)
  const num = (e: string) => /^[\d_.]+(?:\s*\*\s*[\d_.]+)*$/.test(e.trim()) ? e.split('*').reduce((x, y) => x * Number(y.replace(/[_\s]/g, '')), 1) : NaN
  // (an argument's value: up to the next comma or closing bracket at its own level)
  const argAt = (t: string, i: number) => { let d = 0, j = i; for (; j < t.length; j++) { const ch = t[j]
    if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) { if (d === 0) break; d-- } else if ((ch === ',' || ch === '\n') && d === 0) break }
    return t.slice(i, j) }
  const timeoutOf = (m: Snap) => Math.min(...aiFiles(m).flatMap(([q, t]) => [...t.matchAll(/\b(?:new\s+)?(?:Async)?(?:OpenAI|Anthropic)\s*\(/g)]
    .map(x => { const args = inside(t, x.index! + x[0].length - 1) ?? '', k = args.match(/\btimeout\s*[=:]\s*/); return k ? num(argAt(args, k.index! + k[0].length)) : NaN })
    .filter(v => v > 0).map(v => /\.py$/.test(q) ? v : v / 1000)), 600)
  const tA = timeoutOf(before), tB = timeoutOf(after), aiText = aiFiles(after).map(([, t]) => t).join('\n')
  // (streaming, or maybe: `stream=True`, `stream=want_stream`; a timeout set again on a call overrides the client's)
  const streams = /\bstream\s*[=:]\s*(?!False\b|false\b)\w|\.stream\(|streamText|\bstream_?mode\b/.test(aiText)
  const clientTimeouts = [...aiText.matchAll(/\b(?:new\s+)?(?:Async)?(?:OpenAI|Anthropic)\s*\(/g)].filter(x => /\btimeout\s*[=:]/.test(inside(aiText, x.index! + x[0].length - 1) ?? '')).length
  const perCall = (aiText.match(/\btimeout\s*[=:]/g) ?? []).length > clientTimeouts
  if (hasAI && tB < tA && tB < 600 && !streams && !perCall) {
    const caps = aiFiles(after).flatMap(([, t]) => [...t.matchAll(/\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxTokens|maxOutputTokens)\b['"]?\s*[:=]>?\s*/g)].map(x => argAt(t, x.index! + x[0].length)))
    const cap = Math.max(0, ...caps.flatMap(e => (e.match(/\d[\d_]*/g) ?? []).map(d => Number(d.replace(/_/g, '')))))
    // (a clear miss only: speeds vary, 60 tokens a second is on the slow side)
    if (cap / 60 > tB * 1.5) problems.push({ kind: 'Check', text: `Long AI answers may now always fail: the AI service now gets ${nice_(String(tB))} seconds to write a whole answer, nothing streams it, and an answer can be up to ${nice_(String(cap))} tokens (about ${Math.round(cap / 60)} seconds to write). Give it longer, or stream the answer. (This is a guess.)` })
  }
  // Socket.IO: events the live connection now takes, what each one does, and whether connecting needs a login (that file's own
  // io.use guard). A guard that's gone is a problem.
  // ponytail: per event name; room members are read (roomOnly), moderators aren't; plain WebSockets (ws) aren't read
  const evsBefore = new Set([...A.files.values()].flatMap(f => [...f.socketEvents?.keys() ?? []]))
  // (room members only: its first step turns away anyone not in the room it names, and it stays in that room; src/members.ts. Read on
  // either side of the change: F is the app's facts, S its files)
  const roomFor = (F: typeof B, S: Snap, p: string, ev: string, g: FileFacts) => { const b = F.files.get(p)!
    const ft = S.get(p) ?? '', tl = topLevel(ft), scalars = new Set([...F.models.values()].flat().filter(x => !x.startsWith('→')))
    // (a function it calls: one of this file or one it imports, read, that takes nothing from around it but JavaScript's built-ins, and
    // binds no name its own file declares at the top, which would make `free` miss a use of the outer one)
    const callOk = (n: string) => { const q = b.locals.has(n) ? p : F.target(p, n), c = q ? F.files.get(q)?.locals.get(n) : undefined
      const tops = q ? aroundNames(S.get(q) ?? '').top : new Set<string>()
      return !!c && !c.tables.size && !c.writes && !c.outside.size && !/prisma|\bawait\b|\.emit\s*\(|\.to\s*\(|\.join\s*\(|\.send\s*\(|\.write\s*\(|fetch\s*\(|\.constructor\b/.test(c.printed)
        && [...free(c.printed)].every(x => x === n) && ![...boundAll(c.printed)].some(x => x !== n && tops.has(x)) }
    return !!b.socketAuth && roomOnly(g.printed, ft, new Map([...tl, ...[...b.binds.keys()].map(k => [k, { fn: true, text: '' }] as [string, { fn: boolean; text: string }])].filter(([k]) => k !== 'prisma')),
      { callOk, scalars, fields: m => F.models.get(m), ev }) }
  const factsOf = (f: FileFacts, ev: string, g: FileFacts) => { const r = f.socketRefs?.get(ev); return r ? f.locals.get(r) ?? g : g }
  // (one kind of write: its verb; more than one: "changes", since plain doesn't keep which table gets which)
  const evVerb = (g: FileFacts) => { const ts_ = list([...g.written].map(things))
    return !g.written.size ? '' : g.ops.size > 1 ? `changes ${ts_}` : g.ops.has('create') ? `saves new ${ts_}` : g.ops.has('delete') ? `deletes ${ts_}` : g.ops.has('update') ? `updates ${ts_}` : `saves ${ts_}` }
  for (const p of real) { const a = A.files.get(p), b = B.files.get(p)
    if (!b) continue
    const evs = [...b.socketEvents ?? []].filter(([ev]) => !evsBefore.has(ev))
    const one = ([ev, g0]: [string, FileFacts]) => { const g = factsOf(b, ev, g0)
      const what = [evVerb(g), roomFor(B, after, p, ev, g) ? 'room members only ✓' : ''].filter(Boolean).join(', ')
      return `"${ev}"${what ? ` (${what})` : ''}` }
    if (evs.length) changes.push({ group: 'Server', isNew: true, text: `Your server now takes ${list(evs.map(one))} over its live connection.${b.socketAuth ? ' Connecting needs a login ✓' : ''}`, detail: p })
    // events it already took whose code changed: what they now do differently, and a room check that's gone
    const changed = [...b.socketEvents ?? []].filter(([ev]) => a?.socketEvents?.has(ev)).map(([ev, g0]) => [ev, factsOf(b, ev, g0), factsOf(a!, ev, a!.socketEvents!.get(ev)!)] as const)
      .filter(([, g, h]) => g.printed !== h.printed)
    if (!changed.length) continue
    const weaker: string[] = [], gone: string[] = []
    const said = changed.map(([ev, g, h]) => { const vb = evVerb(g), va = evVerb(h), rb = roomFor(B, after, p, ev, g), ra = roomFor(A, before, p, ev, h)
      // (only when the handler mentions membership nowhere anymore: one that still calls isMember, or looks the member row up itself
      // inside a transaction, is quiet, even if plain can't vouch for it)
      // (nor when it hands the room to a function of the app, `sendMessage(io, { roomId, ... })` or `if (!isInRoom(roomId, ...))`: the
      // check may live there. Arguments are read ahead so a call inside an if's condition is seen; a room-name helper inside
      // `.rooms.has(...)` or `.to(...)` isn't a check)
      const handsRoom = [...g.printed.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\((?=([^()]*(?:\([^()]*\)[^()]*)*)\))/g)].some(x => !/^(?:if|for|while|switch|catch|return|typeof|String|Number|Boolean|ack|next)$/.test(x[1])
        && /\broom\w*/i.test(x[2]) && !/\.(?:rooms\.has|to|in|join|leave)\s*\(\s*$/.test(g.printed.slice(0, x.index)))
      // (checking the rooms the socket joined, `socket.rooms.has(...)`, is a weaker check: membership is read once, when joining)
      if (ra && !rb && !/member/i.test(g.printed) && !handsRoom) (/\.rooms\.has\s*\(/.test(g.printed) ? weaker : gone).push(ev)
      const bits = [vb && vb !== va ? `now ${vb}` : '', rb && !ra ? 'now lets only room members in ✓' : ''].filter(Boolean)
      return `"${ev}"${bits.length ? ` (${list(bits)})` : ''}` })
    const evs_ = (xs: string[]) => `${list(xs.map(e => `"${e}"`))} ${xs.length > 1 ? 'events' : 'event'}`
    if (weaker.length) problems.push({ kind: 'Check', text: `The ${evs_(weaker)} no longer ${weaker.length > 1 ? 'check' : 'checks'} room membership each time: ${weaker.length > 1 ? 'they trust' : 'it trusts'} the room the person joined. Someone removed from a room (or banned) can keep using ${weaker.length > 1 ? 'them' : 'it'} there until they reconnect. Make sure that's acceptable.` })
    if (gone.length) problems.push({ kind: 'Check', text: `plain can't see the room check on the ${evs_(gone)} anymore. If it's really gone, anyone logged in can use ${gone.length > 1 ? 'them' : 'it'} in any room, not just rooms they're in. Make sure only room members still can.` })
    changes.push({ group: 'Server', text: `${cap(list(said))} on your live connection changed${said.some(x => x.includes('(')) ? '' : ` in ${said.length > 1 ? 'ways' : 'a way'} plain can't describe yet. Ask the agent what ${said.length > 1 ? 'they do' : 'it does'} differently`}.`, detail: p })
  }
  // (gone for real: no guard plain reads anywhere, and no io.use left at all: a moved, renamed or rewritten one isn't gone)
  const anyUse = [...B.files.values()].some(f => f.socketAuth || f.socketGuardish)
  for (const p of real) { const a = A.files.get(p), b = B.files.get(p)
    if (a?.socketAuth && b?.socketEvents?.size && !b.socketAuth && !anyUse)
      problems.push({ kind: 'Check', text: `Connecting to your server's live connection no longer needs a login (in ${p}): anyone can send ${list([...b.socketEvents.keys()].map(e => `"${e}"`))}. Make sure that's what you want.` }) }
  // Uploads: a new way for people to send files. Counted where files come in from a request (multer, express.raw with a file
  // type, formData().get(...) as File in server code, readMultipartFormData, Fastify's req.file(), request.files / FILES,
  // UploadFile, MultiPartParser, ImageField / FileField, Active Storage, $request->file / ->store, FormFile, IFormFile,
  // MultipartFile, UploadThing) or from a page the visitor uses (a storage service's upload in a component). A file the server
  // makes itself (a nightly export to S3, an invoice PDF) isn't one. New only when the app's count grows (a move isn't new).
  // Said: what's accepted (the allow-list, not what's rejected), how big (from a limit, or the framework's default), where
  // files go (the upload code and its own imports; the database only when it writes a binary field). Guessed: no size limit;
  // nothing caps how much one person can upload (not for an admins-only upload); SVG allowed.
  // ponytail: text-level, across stacks; a per-person cap is a server-side rate limiter or a count next to the upload
  // Size is judged per file: a new unlimited upload beside an existing size-checked one in the same file says nothing (a miss).
  const UPLOAD = /\bmulter\s*\(|\bupload\.(?:single|array|fields|any)\s*\(|express\.raw\s*\(\s*\{[^}]*type\s*:[^}]*(?:image|IMAGE|octet|video|audio|pdf)|\bbusboy\b|\bformidable\b|\breadMultipartFormData\b|\b(?:req|request)\.file\(\s*\)|\brequest\.(?:files|FILES)\b|\bUploadFile\b|\bMultiPartParser\b|models\.(?:Image|File)Field\b|\b(?:has_one|has_many)_attached\b|\$request->(?:file\s*\(|hasFile\s*\(|\w+->store(?:As)?\s*\()|\bFormFile\s*\(|\bIFormFile\b|\bMultipartFile\b|\bcreateUploadthing\b/
  const SINK = /\.storage\s*\.from\([^)]*\)\s*\.upload\s*\(|\bPutObjectCommand\b|\bupload_fileobj\b|cloudinary\.\w*uploader\.\w*\(/
  // (Next.js app/ files are server components unless 'use client')
  const clientFile = (p: string, t: string) => /^\s*['"]use client['"]/.test(t) || /\.(tsx|jsx|vue|svelte)$/.test(p) && !/(^|\/)app\//.test(p) && !/\+page\.server|\+server|\/api\//.test(p)
  // (server code that answers requests: a Next.js route handler or pages/api, a 'use server' file, SvelteKit server files, Nuxt server/api)
  const serverFile = (p: string, t: string) => /(^|\/)app\/.*\/route\.[jt]s$|(^|\/)pages\/api\/|\+(page\.)?server\.[jt]s$|(^|\/)server\/(api|routes)\//.test(p) || /^\s*['"]use server['"]/.test(t)
  // where a hit sits: the route or function around it (two endpoints are two uploads; reading the same file again in one isn't)
  const owner = (t: string, i: number) => [...t.slice(0, i).matchAll(/\.(?:post|put|patch|route)\(\s*['"]([^'"]+)['"]|\b(?:def|function|func)\s+(\w+)|\bpublic\s+function\s+(\w+)|(\w+)\s*(?::\s*\w+\s*)?=\s*async\b/g)].at(-1)?.slice(1).find(Boolean) ?? ''
  const upHits = (p: string, t = '') => { if (!srcFile(p) || isTest(p)) return 0
    const keys = [...t.matchAll(new RegExp(UPLOAD.source, 'g'))].map(m => `${owner(t, m.index!)}|${m[0].replace(/\s+/g, '').replace(/\(.*$/, '')}`)
    // (formData().get('file') as File / instanceof File in server code; a storage service's upload call from a page or component
    // the visitor drives, not from a job or a server-made file)
    if (serverFile(p, t)) for (const m of t.matchAll(/\.get\(\s*['"][^'"]+['"]\s*\)\s*as\s+File\b|\binstanceof\s+File\b/g)) keys.push(`${owner(t, m.index!)}|file`)
    if (clientFile(p, t)) for (const m of t.matchAll(new RegExp(SINK.source + (/@vercel\/blob/.test(t) ? String.raw`|\bput\s*\(` : ''), 'g'))) keys.push(`${owner(t, m.index!)}|sink`)
    return new Set(keys).size }
  const upTotal = (m: Snap) => [...m].reduce((n, [p, t]) => n + upHits(p, t), 0)
  const upFiles = real.filter(p => !p.includes('#') && upHits(p, after.get(p)) > upHits(p, before.get(p)))
  if (upFiles.length && upTotal(after) > upTotal(before)) {
    // the upload code and the files it imports (a storage helper in lib/)
    const noExt = (x: string) => x.replace(/\.(?:[jt]sx?|mjs)$/, '')
    const importsOf = (p: string) => [...(after.get(p) ?? '').matchAll(/from\s+['"]((?:\.{1,2}|@|~)\/[^'"]+)['"]/g)].map(m => m[1]).flatMap(spec => {
      if (/^[@~]\//.test(spec)) { const rest = noExt(spec.slice(2)); return [...after.keys()].filter(k => !k.includes('#') && (noExt(k) === rest || noExt(k).endsWith('/' + rest))) }
      const parts = p.split('/').slice(0, -1); for (const seg of spec.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg) }
      const want = noExt(parts.join('/')); return [...after.keys()].filter(k => !k.includes('#') && (noExt(k) === want || noExt(k) === want + '/index'))
    })
    const t = upFiles.map(p => after.get(p) ?? '').join('\n'), near = [...new Set([...upFiles, ...upFiles.flatMap(importsOf)])].map(p => after.get(p) ?? '').join('\n')
    // accepted types: the allow-list (not `mimetype !== 'image/svg+xml'`, not a reject / deny / block list)
    const types = [...new Set([...t.matchAll(/['"]image\/(jpeg|jpg|png|webp|gif|svg\+xml|heic|avif)['"]/gi)]
      .filter(m => !/(!==?|!=|\bnot\s+in\b)\s*[[(]?\s*$/.test(t.slice(Math.max(0, m.index! - 16), m.index)) && !/(?:reject|deny|block|disallow|banned|forbidden)\w*\s*[=:]\s*[[{(]?[^\]\n;]*$/i.test(t.slice(Math.max(0, m.index! - 120), m.index)))
      .map(m => m[1].toLowerCase().replace('jpg', 'jpeg').replace('svg+xml', 'svg')))]
    const docs = /['"]application\/pdf['"]/.test(t)
    // size: only from a limit (multer's fileSize, express.raw's limit, maxFileSize, bodySizeLimit, max:<KB>, 5.megabytes, size checks)
    const SZ = String.raw`(\d+(?:\.\d+)?)\s*(?:\*\s*1024\s*\*\s*1024|(?:mb|MB)\b)`
    const mbRaw = t.match(new RegExp(String.raw`(?:fileSize|maxFileSize|bodySizeLimit|max_?(?:file|upload|image)?_?size|MAX_\w*(?:SIZE|BYTES))\s*[:=]\s*['"]?${SZ}`, 'i'))?.[1]
      ?? t.match(new RegExp(String.raw`express\.raw\s*\(\s*\{[^}]*limit\s*:\s*['"]?${SZ}`))?.[1] ?? t.match(/(\d+)\.megabytes?/)?.[1]
      ?? ((k => k ? String(Math.round(+k / 1024 * 10) / 10) : undefined)([...t.matchAll(/['"]([^'"]*\bmax:(\d+)[^'"]*)['"]/g)].find(m => /\b(?:image|file|mimes:)/.test(m[1]))?.[2]))   // (Laravel max: in KB, on a file rule)
    const mb = mbRaw && +mbRaw > 0 ? String(+mbRaw) : undefined
    const cfg = [...after].filter(([p]) => /next\.config\.|application\.(properties|ya?ml)$/.test(p)).map(([, x]) => x).join('\n')
    const sized = !!mb || /\bfileSize\s*:|express\.raw\s*\(\s*\{[^}]*type\s*:[^}]*(?:image|IMAGE|octet|video|audio|pdf)|\.size\s*>|\bbyte_size\s*>|\blen\(\s*\w+\s*\)\s*>|\bMaxBytesReader\b|max_upload_size|upload_max_filesize|RequestSizeLimit|\bmaxFileSize\b|\bcontent_length\b/.test(t)
      || /bodySizeLimit|max-file-size|max_file_size/.test(cfg) || /\bMultipartFile\b/.test(t)   // (Spring caps a file at 1 MB unless set)
      || upFiles.some(p => /^\s*['"]use server['"]/.test(after.get(p) ?? ''))   // (Next.js server actions: 1 MB unless bodySizeLimit)
    // where files go: the upload code and its own imports
    // (binary columns: Prisma's Bytes, LargeBinary, BinaryField, t.binary, BLOB / bytea; comments skipped, not short or generic names)
    const bin = [...after].filter(([p]) => /schema\.prisma$|models\.py$|migrat|\.sql$|schema\.(?:ts|rb)$/.test(p))
      .flatMap(([, x]) => [...x.replace(/(^|\s)(?:#|\/\/|--)[^\n]*/g, '$1').matchAll(/(\w+)\s+Bytes\b|(\w+)\s*[:=][^\n]*\b(?:LargeBinary|BinaryField)\b|t\.binary\s+:(\w+)|(\w+)\s+(?:BLOB|bytea|varbinary)\b/g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]))
      .filter(n => n && n.length > 2 && !/^(data|body|content|value|file|blob|payload|raw|bytes)$/i.test(n))
    const where = /\b(?:PutObjectCommand|S3Client|upload_fileobj|boto3)\b|->store\w*\([^)]*['"]s3['"]|Storage::disk\(\s*['"]s3['"]/.test(near) ? 'Amazon S3' : /\.storage\s*\.from\(/.test(near) ? 'Supabase Storage'
      : /@vercel\/blob/.test(near) ? 'Vercel Blob' : /cloudinary/i.test(near) ? 'Cloudinary' : /\bcreateUploadthing\b/.test(near) ? 'UploadThing'
      : /\b(?:has_one|has_many)_attached\b/.test(t) ? 'Active Storage'
      : /writeFile|createWriteStream|diskStorage|\bdest\s*:|->store(?:As)?\s*\(|MEDIA_ROOT|default_storage|open\([^)]*['"]wb['"]|copyfileobj|\.save\s*\(\s*(?:path|os\.path)|os\.Create\(|File\.Create|transferTo\(|models\.(?:Image|File)Field/.test(near) ? 'disk'
      : bin.some(n => new RegExp(String.raw`\b${n}\b\s*[:,}=]`).test(t)) ? 'database' : undefined
    const placeOf: Record<string, string> = { disk: "on your server's disk", database: 'in your database', 'Active Storage': 'with Active Storage (on the server\'s disk unless config/storage.yml says otherwise)' }
    const nice = (x: string) => ({ svg: 'SVG', webp: 'WebP', heic: 'HEIC', avif: 'AVIF' } as Record<string, string>)[x] ?? x.toUpperCase()
    const or = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`
    const what = types.length ? `pictures (${or(types.map(nice))})` : docs ? 'files (PDFs)' : 'files'
    changes.push({ group: 'Server', isNew: true, text: `People can now upload ${what}${mb ? `, up to ${mb} MB each` : ''}.${where ? ` They're stored ${placeOf[where] ?? `in ${where}`}.` : ''}`, detail: upFiles[0] })
    if (!sized) problems.push({ kind: 'Check', text: `Uploads have no size limit plain can see: one person can send huge files. Set a maximum size. (This is a guess.)` })
    // a per-person cap: a server-side rate limiter (not lodash's throttle in a component), or a count next to the upload; and
    // only when ordinary accounts can upload (not an admins-only upload)
    const server = [...after].filter(([p, x]) => srcFile(p) && !clientFile(p, x)).map(([, x]) => x).join('\n')
    const capped = /express-rate-limit|\brateLimit\s*\(|@upstash\/ratelimit|\bslowapi\b|@ratelimit|\bRateLimiter\b|\bLimiter\s*\(|rack-attack|AddRateLimiter|middleware\([^)]*throttle|throttle_classes|UserRateThrottle|@Throttle|\bquota\b/i.test(server)
      || /\.count\b|\bcount\s*\(|COUNT\(/.test(t)   // (a count in the upload code itself: photos.count > 20, not an unread counter elsewhere)
    // (Active Storage's has_one_attached keeps one file per record: a new one replaces the old, so nothing piles up)
    const oneEach = /\bhas_one_attached\b/.test(t) && /\bclass\s+(?:User|Account|Profile|Member)\b/.test(t) && !/\bhas_many_attached\b/.test(t) && upFiles.every(p => !/\b(?:multer|FormFile|IFormFile|MultipartFile|UploadFile|request\.files|\$request->file)\b/i.test(after.get(p) ?? ''))
    // (admins only: an admin path, or an admin check right around the upload itself, not elsewhere in the file)
    // (the route statement the upload sits in: `router.post('/admin/banner', requireAdmin, upload.single(...)`, not text nearby)
    // (isAdmin only as a gate: a bare middleware argument, or `if (!…isAdmin)` / `role !== 'admin'` that turns people away;
    // not `if (user.isAdmin) console.log(...)`)
    const ADMIN_GATE = /\brequire(?:Admin|Staff|Superuser)\b|\badminOnly\b|[(,]\s*isAdmin\s*,|middleware\(\s*\[?\s*['"](?:admin|role:admin)|['"]\/?admin(?:\/|['"])|if\s*\(\s*(?:!\s*[\w.?]*\bis_?[Aa]dmin\b|[\w.?]*\brole\s*!==?\s*['"]admin['"])[^)]*\)\s*\{?\s*(?:return|throw|redirect|abort)\b/
    // (inside a route call: from that call's opening, found by counting brackets back across lines; otherwise the function
    // around it, up to the upload: `await requireAdmin()` two lines above `form.get('logo') as File`)
    const stmtOf = (i: number) => { let d = 0
      for (let k = i - 1; k >= Math.max(0, i - 3000); k--) { const c = t[k]
        if (c === ')') d++; else if (c === '(') { if (d) d--; else if (/\.(?:post|put|patch|route)$/.test(t.slice(Math.max(0, k - 8), k))) return t.slice(Math.max(0, k - 8), i) } }
      const heads = [...t.slice(0, i).matchAll(/\b(?:def|function|func)\s+\w+|\bpublic\s+function\s+\w+|\w+\s*(?::\s*\w+\s*)?=\s*async\b|\bexport\s+(?:async\s+)?function\b/g)]
      return t.slice(heads.at(-1)?.index ?? Math.max(0, i - 400), i) }
    const adminOnly = oneEach || upFiles.some(p => /(^|\/)admin(\/|$)/.test(p)) || (ms => ms.length > 0 && ms.every(m => ADMIN_GATE.test(stmtOf(m.index!))))((ms => { const r = ms.filter(m => /\.(?:post|put|patch|route)\(/.test(stmtOf(m.index!))); return r.length ? r : ms })([...t.matchAll(new RegExp(UPLOAD.source + (upFiles.some(p => serverFile(p, after.get(p) ?? '')) ? String.raw`|\.get\(\s*['"][^'"]+['"]\s*\)\s*as\s+File\b|\binstanceof\s+File\b` : ''), 'g'))]))   // (the routes that take uploads, not `const upload = multer(...)`)
    if (!capped && !adminOnly) problems.push({ kind: 'Check', text: `Nothing limits how many files one person can upload${where === 'database' || where === 'disk' ? `: one account can fill ${where === 'database' ? 'your database' : "your server's disk"} and stop the whole app` : where && where !== 'Active Storage' ? `, and each one adds to your ${where} bill` : ''}. Add a limit per person (a few per minute, or a total). (This is a guess.)` })
    if (types.includes('svg')) problems.push({ kind: 'Check', text: `SVG pictures are allowed. An SVG can carry code that runs for whoever opens it. Leave SVG out unless you need it. (This is a guess.)` })
  }
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
  // Python files the card doesn't mention otherwise (services.py, API files, tests): say they changed, and that plain can't say how.
  // Not the ones the card already covers another way: models (Database), files that only wire up routers or urls, files a problem names.
  // ponytail: in other languages, models, route files and components show up through what they declare, so their files are listed
  // only when the card has nothing else to say (below); listing them all named files the card had described.
  const shown = [...changes.map(c => `${c.text} ${c.detail ?? ''}`), ...problems.map(x => x.text), ...ship, ...unfinished].join('\n')
  const wiring = (f?: FileFacts) => { const x = f as PyFacts | undefined; return !!x?.models && (x.models.size > 0 || x.mounts.length > 0 || x.servers.size > 0 || x.dj.urls.length > 0 || x.dj.routers.size > 0) }
  // Other languages, when the card says something else (an empty card lists them below, worded for that): existing code files that
  // changed and that the card doesn't cover another way (a new helper is what a new route or page uses). Covered: routes and files that declare them, models, schemas, migrations, types, config, seeds,
  // tests, and any file whose functions a route or page uses (a controller, a service, a component: the card describes them
  // through that route or page).
  // (and what those use in turn, a few levels down: a route calls handlers.go, which calls store.go; `prisma` from lib/prisma.ts)
  const names = (f?: FileFacts) => f ? [...f.fns.keys(), ...f.exports] : [], stem = (q: string) => q.split('#')[0].split('/').pop()!.replace(/\..*$/, '')   // (PriceCard.vue is <PriceCard>)
  // (seeded only from routes and pages the card describes, not from every route: a helper an unchanged page uses still changed)
  const described = new Set(changes.filter(c => !c.vague && c.detail).map(c => c.detail))
  // (with the files it imports: `import Plans from './PlanList'` covers PlanList.tsx)
  // (an Express route `file#/api/x` takes its imports from its file: require('../controllers/userController'))
  const seed = (f?: FileFacts) => f ? [...f.used, ...f.jsx, ...[...f.binds.values()].map(m => m.split('/').pop()!.replace(/^py:/, '').split('.').pop()!)] : []   // (and every module its file imports)
  const usedByRoutes = new Set([...B.routes.keys()].filter(q => real.includes(q) && described.has(route(q)!.url)).flatMap(q => [...seed(B.files.get(q)), ...q.includes('#') ? seed(B.files.get(q.split('#')[0])) : []]))
  for (let i = 0; i < 3; i++) for (const [q, f] of B.files) if ([...names(f), stem(q)].some(n => usedByRoutes.has(n))) for (const n of [...f.used, ...f.jsx]) usedByRoutes.add(n)
  const otherCode = (p: string) => changes.length > 0 && before.has(p) && after.has(p) && CODE.test(p) && !p.endsWith('.py') && !TESTS.test(p)
    && !/(^|\/)(models?|schemas?|entities|migrations?|db\/migrate|database\/migrations|types?|dtos?|seeds?|seeders|routes)(\/|\.)|\.d\.ts$|(^|\/)[\w.-]+\.config\.[cm]?[jt]s$|(^|\/)(seed|main|server|app|index|DbContext|AppDbContext|Contracts|Program|Startup)\.\w+$|DbContext\.cs$|(^|\/)\+(page|layout|server|error)(\.server)?\.[jt]s$/i.test(p)
    && ![...names(B.files.get(p) ?? A.files.get(p)), stem(p)].some(n => usedByRoutes.has(n))
    // (Go, Ruby, PHP, C#, Java: plain doesn't follow what their routes call, and a changed route in the same language already says
    // that part changed)
    && !(/\.(?:go|rb|php|cs|java|kt)$/.test(p) && real.some(q => route(q) && q.split('#')[0].split('.').pop() === p.split('.').pop()))
    && !((f?: FileFacts) => !!f && (f.pages.length > 0 || f.mounts.length > 0 || f.handlers.length > 0))(B.files.get(p) ?? A.files.get(p))   // (declares routes: React Router's <Route>, app.use(...))
  // A component (not a page or a route) with something new on screen: say what (inbox-zero's IntegrationRow.tsx now shows "Test
  // connection"), in place of "can't describe". Words new to the file, not ones that only changed case or punctuation.
  // Not text or buttons the app already had anywhere (code moved into a new component isn't new on screen), not pieces cut around
  // {expressions} ("! You have"), not Storybook stories or emails; replaced words say what they replaced.
  const oldTexts = new Set([...A.files.values()].flatMap(f => [...f.texts])), oldUi = new Set([...A.files.values()].flatMap(f => [...f.ui]))
  // (and not a component a page the card describes uses: its words are already on that page's line)
  const visible = (q: string) => { if (!/\.(?:[jt]sx|vue|svelte)$/.test(q) || route(q) || TESTS.test(q) || shown.includes(q) || /\.stories\.|(?:^|\/)(?:emails?|mails?|templates\/emails?)\//i.test(q)
      || [...names(B.files.get(q)), stem(q)].some(n => usedByRoutes.has(n))
      || /from\s+['"](?:@react-email\/|react-email|mjml)/.test(after.get(q) ?? '')) return ''
    const a = A.files.get(q), b = B.files.get(q); if (!b) return ''
    const key = (t: string) => t.toLowerCase().replace(/[^a-z]/g, '')
    const newUi = newOnly(a?.ui, b.ui).filter(u => !oldUi.has(u)), ui = uiList(newUi), goneUi = uiList([...a?.ui ?? []].filter(u => !b.ui.has(u)))
    const gone = [...a?.texts ?? []].filter(t => !b.texts.has(t) && t !== '[price]' && ![...a?.ui ?? []].some(u => u.includes(t))), goneKeys = new Set(gone.map(key))
    const said = newOnly(a?.texts, b.texts).filter(t => t !== '[price]' && !oldTexts.has(t) && ![...b.ui].some(u => u.includes(t)) && !goneKeys.has(key(t)) && /[a-z]{4}/i.test(t) && !/^[^\w"“(]|[,:;]$/.test(t.trim()))
    const q_ = (t: string) => `"${t.length > 60 ? t.slice(0, 57) + '…' : t}"`
    const parts = [ui.length ? `${a ? 'now has' : 'has'} ${list(ui.slice(0, 3))}${a && goneUi.length === 1 && ui.length === 1 ? ` in place of ${goneUi[0]}` : ''}` : '',
      said.length ? `${a ? 'now shows' : 'shows'} ${list(said.slice(0, 2).map(q_))}${a && gone.length && said.length === 1 && gone.length === 1 ? ` in place of ${q_(gone[0])}` : ''}` : ''].filter(Boolean)
    return parts.length ? list(parts) : '' }
  const vis = new Map(real.filter(q => !q.includes('#') && after.has(q)).map(q => [q, visible(q)] as const).filter(([, v]) => v))
  for (const [q, v] of vis) changes.push({ group: 'Other files', isNew: !before.has(q), text: `The agent ${before.has(q) ? 'changed' : 'added'} ${q}: it ${v}.` })
  const quiet = real.filter(p => !p.includes('#') && !vis.has(p) && (p.endsWith('.py') || otherCode(p)) && !route(p) && ![...B.routes.keys(), ...A.routes.keys()].some(k => k.startsWith(p + '#')) && !shown.includes(p) && !wiring(B.files.get(p))
    && !/(^|\/)(migrations|alembic)\/|(^|\/)__init__\.py$|(^|\/)(apps|asgi|wsgi|manage)\.py$/.test(p))
  for (const tests of [false, true]) for (const [verb, xs] of [['added', quiet.filter(q => !before.has(q))], ['changed', quiet.filter(q => before.has(q) && after.has(q))], ['deleted', quiet.filter(q => !after.has(q))]] as const) {
    const ys = xs.filter(q => TESTS.test(q) === tests), names = ys.length > 6 ? [...ys.slice(0, 5), `${ys.length - 5} more files`] : ys
    if (ys.length) changes.push({ group: 'Other files', text: `The agent also ${verb} ${list(names)}${tests ? ' (tests)' : verb === 'changed' ? `, in ${ys.length > 1 ? 'ways' : 'a way'} plain can't describe yet` : ''}.` })
  }
  // nothing else to say, but app files changed (a component, a helper plain doesn't read): not "Nothing about the app changed"
  // (that was wrong 7 times in 11 on real commits)
  const unsaid = real.filter(p => !p.includes('#') && !TESTS.test(p) && !shown.includes(p) && !quiet.includes(p) && !vis.has(p))
  if (!changes.length && !problems.length && !unfinished.length && !ship.length && unsaid.length)
    for (const [verb, xs] of [['added', unsaid.filter(q => !before.has(q))], ['changed', unsaid.filter(q => before.has(q) && after.has(q))], ['deleted', unsaid.filter(q => !after.has(q))]] as const) {
      const names = xs.length > 6 ? [...xs.slice(0, 5), `${xs.length - 5} more files`] : xs
      if (xs.length) changes.push({ group: 'Other files', text: verb === 'changed'
        ? `The agent changed ${list(names)} in ${xs.length > 1 ? 'ways' : 'a way'} plain can't describe yet. Ask the agent what ${xs.length > 1 ? 'they do' : 'it does'} differently.`
        : `The agent ${verb} ${list(names)}. plain can't describe ${xs.length > 1 ? 'them' : 'it'} yet.` })
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
    bad ? red(`⚠ ${plural(bad, 'problem')}`) : checks ? '' : 'Nothing flagged',   // never above something to look at; no green ✓, it isn't a safety check
    checks ? yellow(`${plural(checks, 'thing')} to decide`) : '',
    r.unfinished.length ? yellow(`${plural(r.unfinished.length, 'loose end')}`) : '',
    r.ship.length ? `${plural(r.ship.length, 'step')} before you ship` : '',
  ].filter(Boolean).join('  ·  '))
  // ("✓ No problems spotted" read as "this is safe": on 70 real commits it sat above broken builds, XSS, an unscoped search and a
  // webhook that swallows errors. Say what plain is, not that the change is fine.)
  if (!r.problems.length) out.push(dim("    plain reads logins, payments, database changes and secrets. It doesn't run the code, and it can miss bugs."))

  if (r.problems.length) {
    out.push('', bold('LOOK AT THIS FIRST'))
    const icon = { Broken: red('✖'), Unsafe: red('⚠'), Check: yellow('!') }
    for (const p of r.problems) out.push(...wrap(p.text, `  ${icon[p.kind]} `, '    '))
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
  if (r.noise) out.push('', dim(`(Hidden: ${plural(r.noise, 'file')} whose changes don't change what the code does (formatting, unused parameters), or lockfiles.)`))
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
