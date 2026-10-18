#!/usr/bin/env node
// plain v0: what changed in your app compared to a git ref. Static facts, no AI.
//
//   plain [ref] [--asked "what you asked for"]   ref defaults to HEAD (uncommitted work)
//   plain --hook                                  Claude Code Stop hook: reads the last prompt
//
// ponytail: Next.js App Router + Prisma + Stripe only. Each framework is one more fact extractor.
import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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
const WRITES = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/
const SERVICES: Record<string, string> = {
  stripe: 'Stripe', openai: 'OpenAI', '@anthropic-ai/sdk': 'Anthropic', resend: 'Resend',
  '@supabase/supabase-js': 'Supabase', nodemailer: 'email', twilio: 'Twilio', '@vercel/blob': 'Vercel Blob',
}
// ponytail: client variable names by convention; follow imports if apps name them differently
const CLIENTS: Record<string, string> = { stripe: 'Stripe', openai: 'OpenAI', anthropic: 'Anthropic', resend: 'Resend', supabase: 'Supabase' }
const CODE = /\.(ts|tsx|js|jsx|mjs)$/
const NOISE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/
const printer = ts.createPrinter({ removeComments: true })

type FileFacts = {
  fns: Map<string, string>; used: Set<string>; jsx: Set<string>; services: Set<string>
  tables: Set<string>; writes: boolean; env: Set<string>; auth: boolean; money: boolean
  emptyCatch: number; todos: string[]; hardcoded: string[]; anys: number; printed: string
  outside: Set<string>; links: Set<string>; fetches: Set<string>; ui: Set<string>; imports: string[]; written: Set<string>; headings: string[]; forms: number
}

export const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const isExported = (n: ts.Node) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)

export function fileFacts(path: string, text: string): FileFacts {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    /x$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const f: FileFacts = {
    fns: new Map(), used: new Set(), jsx: new Set(), services: new Set(), tables: new Set(),
    writes: false, env: new Set(), auth: false, money: false, emptyCatch: 0,
    todos: text.match(/\/\/\s*(TODO|FIXME|HACK)\b[^\n]*/g)?.map(t => t.replace(/^\/\/\s*/, '')) ?? [],
    hardcoded: [], anys: 0, printed: printer.printFile(sf),
    outside: new Set(), links: new Set(), fetches: new Set(), ui: new Set(), imports: [], written: new Set(), headings: [], forms: 0,
  }
  const str = (e?: ts.Node) => e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text
    : e && ts.isTemplateExpression(e) ? e.head.text + e.templateSpans.map(t => '[…]' + t.literal.text).join('') : undefined
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      if (ts.isIdentifier(callee)) {
        f.used.add(callee.text)
        if (AUTH.has(callee.text)) f.auth = true
        const arg = str(n.arguments[0])
        if (callee.text === 'fetch' && arg?.startsWith('/')) f.fetches.add(arg.split('?')[0])
      } else if (ts.isPropertyAccessExpression(callee)) {
        const parts = callee.getText(sf).replace(/\s|\?/g, '').split('.')
        if (parts[0] === 'prisma' && parts.length === 3 && !parts[1].startsWith('$')) {
          f.tables.add(cap(parts[1]))
          if (WRITES.test(parts[2])) { f.writes = true; f.written.add(cap(parts[1])) }
        }
        if (parts[0] === 'stripe' && parts.at(-1) === 'create') f.money = true
        if (CLIENTS[parts[0]] && parts.length > 1) f.outside.add(`${CLIENTS[parts[0]]}: ${parts.slice(1).join('.')}`)
        if (parts.at(-1) === 'push' && /router/.test(parts[0]) && str(n.arguments[0])?.startsWith('/')) f.links.add(str(n.arguments[0])!)
      }
    }
    if (ts.isPropertyAccessExpression(n) && n.expression.getText(sf) === 'process.env') f.env.add(n.name.text)
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) f.jsx.add(n.tagName.getText(sf))
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const mod = n.moduleSpecifier.text
      f.imports.push(mod)
      if (SERVICES[mod]) f.services.add(SERVICES[mod])
      const c = n.importClause
      if (c?.name) f.used.add(c.name.text)
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings))
        for (const el of c.namedBindings.elements) f.used.add((el.propertyName ?? el.name).text)
    }
    if (ts.isJsxAttribute(n) && n.initializer) {
      const v = str(n.initializer), name = n.name.getText(sf)
      if (v && name === 'href' && v.startsWith('/')) f.links.add(v)
      const tag = n.parent.parent.tagName.getText(sf)
      if (v && (name === 'placeholder' || name === 'aria-label') && /^(input|textarea|select)$/.test(tag)) f.ui.add(`box "${v}"`)
    }
    const textOf = (el: ts.JsxElement): string => el.children.map(c => ts.isJsxText(c) ? c.text : ts.isJsxElement(c) ? textOf(c) : '').join('').replace(/\s+/g, ' ').trim()
    if (ts.isJsxElement(n) && /^h[1-3]$/.test(n.openingElement.tagName.getText(sf))) {
      const t = textOf(n)
      if (t) f.headings.push(`${n.openingElement.tagName.getText(sf)}:${t}`)
    }
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === 'form') f.forms++
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === 'button') {
      const t = n.children.filter(ts.isJsxText).map(c => c.text.trim()).join(' ').trim()
      if (t) f.ui.add(`button "${t}"`)
    }
    if (ts.isCatchClause(n) && n.block.statements.length === 0) f.emptyCatch++
    if (n.kind === ts.SyntaxKind.AnyKeyword) f.anys++
    ts.forEachChild(n, visit)
  }
  visit(sf)

  const addFn = (name: string, node: ts.Node) => {
    f.fns.set(name, printer.printNode(ts.EmitHint.Unspecified, node, sf))
    if (/^(get|fetch|load|list)[A-Z]/.test(name) && returnsLiteralOnly(node)) f.hardcoded.push(name)
  }
  for (const st of sf.statements) {
    if (!isExported(st)) continue
    if (ts.isFunctionDeclaration(st) && st.name) addFn(st.name.text, st)
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)))
          addFn(d.name.text, d.initializer)
  }
  return f
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

type Route = { kind: 'page' | 'endpoint'; url: string }
export function route(path: string): Route | null {
  const m = path.match(/^(?:src\/)?app\/(.*?)\/?(page|route)\.[jt]sx?$/)
  if (!m) return null
  const url = '/' + m[1].split('/').filter(s => s && !/^\(.*\)$/.test(s)).join('/')
  return { kind: m[2] === 'page' ? 'page' : 'endpoint', url }
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
  // A page also does what its own components do: fold in facts from local imports.
  // ponytail: '@/' and relative paths only; read tsconfig paths if a repo uses other aliases
  const resolve = (from: string, spec: string) => {
    const base = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? join(from, '..', spec) : null
    return base && ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts'].map(e => base + e).find(c => files.has(c))
  }
  const fold = (p: string, into: FileFacts, seen: Set<string>) => {
    for (const spec of files.get(p)!.imports) {
      const q = resolve(p, spec)
      if (!q || seen.has(q) || /(^|\/)lib\//.test(q)) continue
      seen.add(q)
      const c = files.get(q)!
      for (const k of ['ui', 'fetches', 'links', 'outside', 'tables', 'written'] as const) for (const x of c[k]) into[k].add(x)
      into.headings.push(...c.headings); into.forms += c.forms
      fold(q, into, seen)
    }
  }
  for (const p of files.keys()) if (route(p)) fold(p, files.get(p)!, new Set([p]))
  const schemaPath = [...snap.keys()].find(p => p.endsWith('schema.prisma'))
  return {
    files, models: models(schemaPath && snap.get(schemaPath)),
    envExample: envKeys(snap.get('.env.example')), deps: deps(snap.get('package.json')),
    migrations: [...snap.keys()].filter(p => /prisma\/migrations\/.+\.sql$/.test(p)),
  }
}

// ---------- English ----------
// Every sentence below is a fixed template filled with facts. No model writes any of it.

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase()
const singular = (s: string) => s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('sses') ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s
const pluralize = (s: string) => s.endsWith('s') ? s : s.endsWith('y') ? s.slice(0, -1) + 'ies' : s + 's'
export const things = (model: string) => pluralize(words(model))
const an = (w: string) => (/^[aeiou]/.test(w) ? 'an ' : 'a ') + w
export const list = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`
const DATES: Record<string, string> = { createdAt: 'date created', updatedAt: 'date updated', expiresAt: 'expiry date', deletedAt: 'date deleted' }
const fieldName = (f: string) =>
  f === 'id' || /Id$/.test(f) ? '' : DATES[f] ?? (/At$/.test(f) ? words(f.slice(0, -2)) + ' date' : words(f.replace(/Cents$/, '')))
const fieldList = (fs: string[]) => list(fs.filter(f => !f.startsWith('→')).map(fieldName).filter(Boolean))

// "/products/[slug]/reviews" -> ["product", "reviews"]: a segment before a [param] is one of many
export const named = (url: string) => {
  const segs = url.split('/').filter(s => s && s !== 'api')
  return segs.flatMap((s, i) => s.startsWith('[') ? [] : [segs[i + 1]?.startsWith('[') ? singular(words(s)) : words(s)])
}
export function pageName(url: string) {
  if (url === '/') return 'the home page'
  const n = named(url)
  return url.endsWith(']') ? `each ${n.join(' ')} page` : `the ${n.join(' ')} page`
}
const serverName = (url: string) => `the ${named(url).join(' ') || 'main'} part of your server`
const placeName = (path: string) => { const r = route(path); return r ? (r.kind === 'page' ? pageName(r.url) : serverName(r.url)) : path }

const VERBS: Record<string, string> = { create: 'create', retrieve: 'look up', update: 'update', del: 'delete', delete: 'delete', list: 'list', send: 'send' }
function outsidePhrase(o: string) {
  const [svc, chain] = o.split(': ')
  if (chain === 'checkout.sessions.create') return `starts a ${svc} checkout`
  const parts = chain.split('.'), verb = parts.at(-1)!, what = singular(words(parts.at(-2) ?? ''))
  return VERBS[verb] ? `asks ${svc} to ${VERBS[verb]} ${verb === 'list' ? pluralize(what) : `a ${what}`}` : `calls ${svc} (${chain})`
}
const VERB = /^((?:now )?(?:shows|links to|has|reads|saves|sends|loads|lists|looks up|asks \w+ to \w+))\s(.+)$/
function merge(clauses: string[]): string[] {
  const groups = new Map<string, string[]>()
  for (const c of clauses) {
    const m = c.match(VERB), key = m ? m[1] : c
    groups.set(key, [...(groups.get(key) ?? []), ...(m ? [m[2]] : [])])
  }
  return [...groups].map(([verb, objs]) => objs.length ? `${verb} ${list(objs)}` : verb)
}
const NICE: Record<string, string> = { nav: 'navigation menu', btn: 'button', img: 'image' }
const nice = (s: string) => words(s).split(' ').map(w => NICE[w] ?? w).join(' ')
const uiPhrase = (u: string) => u.startsWith('box ') ? `a box for ${u.slice(4)}` : `a ${u.slice(7)} button`
const norm = (u: string) => u.replace(/\[[^\]]*\]/g, '*')

// ---------- the diff ----------

const STOP = new Set(['with', 'that', 'this', 'from', 'make', 'code', 'codes', 'page', 'some', 'please', 'have', 'into', 'when', 'also', 'should', 'want'])
const keywords = (asked: string) =>
  asked.toLowerCase().match(/[a-z]{4,}/g)?.filter(w => !STOP.has(w)).map(w => w.replace(/(es|s)$/, '')) ?? []

export type Change = { group: 'Pages' | 'Server' | 'Database' | 'Outside services' | 'Other files'; isNew?: boolean; text: string; detail?: string; name?: string; money?: boolean }
export type Problem = { kind: 'Broken' | 'Unsafe' | 'Check' | 'Unasked'; text: string }
// ponytail: name-based guess at what's sensitive; a config file can override it later
const SENSITIVE = /admin|account|user|order|payment|coupon|refund|checkout|settings/i

export type Analysis = ReturnType<typeof analyze>
export const report = (before: Snap, after: Snap, opts: { ref: string; asked?: string; color?: boolean }) => render(analyze(before, after, opts))

export function analyze(before: Snap, after: Snap, opts: { ref: string; asked?: string; color?: boolean }) {
  const A = appFacts(before), B = appFacts(after)
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).sort()
  const noise: string[] = [], real: string[] = []
  for (const p of changed) {
    const a = A.files.get(p), b = B.files.get(p)
    if (NOISE.test(p) || (a && b && a.printed === b.printed)) noise.push(p)
    else real.push(p)
  }
  const usersOf = (name: string, self: string) =>
    [...B.files].filter(([p, f]) => p !== self && (f.used.has(name) || f.jsx.has(name))).map(([p]) => placeName(p))
  const mainTable = (f: FileFacts, url: string) =>
    named(url).reverse().map(seg => [...f.tables].find(t => things(t) === pluralize(seg))).find(Boolean)
      ?? [...f.written][0] ?? [...f.tables][0]
  const endpoint = (path: string) => [...B.files].find(([p]) => { const r = route(p); return r?.kind === 'endpoint' && norm(r.url) === norm(path) })
  const fetchPhrase = (path: string) => {
    const e = endpoint(path), r = e && route(e[0])!
    const t = e && mainTable(e[1], r!.url), noun = t ? things(t) : 'data'
    return e?.[1].fns.has('POST') ? `sends ${noun} to your server` : `loads ${noun} from your server`
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
  const viewOnly = (f: FileFacts) => !f.fetches.size && !f.forms && !f.written.size && ![...f.ui].some(u => u.startsWith('button ') || u.startsWith('box '))

  const changes: Change[] = [], problems: Problem[] = [], unfinished: string[] = [], ship: string[] = []

  // pages and server code
  for (const p of real) {
    const r = route(p); if (!r) continue
    const a = A.files.get(p), b = B.files.get(p)
    if (!b) { changes.push({ group: r.kind === 'page' ? 'Pages' : 'Server', text: `${cap(placeName(p))} was removed.`, detail: r.url, name: placeName(p) }); continue }
    const clauses: string[] = []
    if (r.kind === 'page') {
      const ui = newOnly(a?.ui, b.ui).map(uiPhrase)
      if (ui.length) clauses.push(`${a ? 'now has' : 'has'} ${list(ui)}`)
      for (const t of newOnly(a?.tables, b.tables).filter(t => !b.written.has(t))) clauses.push(`${a ? 'now shows' : 'shows'} ${things(t)}`)
      for (const x of newOnly(a?.fetches, b.fetches)) clauses.push((a ? 'now ' : '') + fetchPhrase(x))
      for (const x of newOnly(a?.links, b.links)) clauses.push(`${a ? 'now links' : 'links'} to ${pageName(x)}`)
      const comps = newOnly(a?.jsx, b.jsx).filter(x => /^[A-Z]/.test(x) && !/^(Link|Image|Script|Head)$/.test(x) && !x.includes('.'))
      if (a && comps.length) clauses.push(`now shows the ${list(comps.map(nice))}`)
      if (!a && b.auth) clauses.push('requires login ✓')
    } else {
      const t = mainTable(b, r.url), noun = t ? things(t) : 'data'
      if (!a) {
        const can: string[] = []
        if (b.fns.has('GET')) can.push(`lists ${noun}`)
        if (b.fns.has('POST')) can.push(b.written.size ? (can.length ? 'saves new ones' : `saves new ${noun}`) : t ? `looks up ${noun}` : 'accepts requests')
        if (b.fns.has('PUT') || b.fns.has('PATCH')) can.push(`updates ${noun}`)
        if (b.fns.has('DELETE')) can.push(`deletes ${noun}`)
        clauses.push(...can)
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
      : clauses.length ? `${cap(name)} now ${list(merge(clauses.map(c => c.replace(/^now /, ''))))}.` : `${cap(name)} had small behind-the-scenes changes.`
    changes.push({ group: r.kind === 'page' ? 'Pages' : 'Server', isNew: !a, text: text + (a?.money && b.money ? ' This is the code that charges your customers 💰' : ''), detail: r.url, name: r.kind === 'page' ? pageName(r.url) + (!a && b.headings.find(h => h.startsWith('h1:')) ? ` ("${b.headings.find(h => h.startsWith('h1:'))!.slice(3)}")` : '') : named(r.url).join(' ') || 'main', money: b.money })

    if (!b.auth && (!a || a.auth) && !/webhook/.test(r.url)) {
      const writes = b.written.size || METHODS.slice(1).some(m => b.fns.has(m))
      if (r.kind === 'page' && /admin|dashboard|account/.test(r.url))
        problems.push({ kind: 'Unsafe', text: `Anyone can open ${name} without logging in.` })
      else if (r.kind === 'endpoint' && writes && (SENSITIVE.test(r.url) || [...b.written].some(t => SENSITIVE.test(t))))
        problems.push({ kind: 'Unsafe', text: `Anyone can use ${name} without logging in.` })
      else if (r.kind === 'endpoint' && writes) {
        const t = mainTable(b, r.url), noun = t ? things(t) : 'data'
        problems.push({ kind: 'Check', text: `Anyone can post ${noun} without logging in, and nothing limits spam or fake ${noun}. That's normal for some things (like reviews), but make sure it's what you want.` })
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
  for (const p of real) if (!CODE.test(p) && !/(^|\/)(package\.json|\.env\.example|schema\.prisma|\.gitignore)$|prisma\/migrations\//.test(p))
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
    if (!b) continue
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
  for (const k of new Set([...B.files.values()].flatMap(f => [...f.env]))) if (!usedBefore.has(k))
    ship.push(`Add ${k} to your hosting settings (like Vercel).${B.envExample.has(k) ? '' : ' It\'s also missing from .env.example.'}`)
  for (const [d, v] of Object.entries(B.deps)) {
    if (!(d in A.deps)) ship.push(`A new package was added: ${d} (${v}). Make sure you actually need it.`)
    else if (A.deps[d] !== v) ship.push(`Test anything that uses ${d}: it was upgraded from ${A.deps[d]} to ${v}.`)
  }
  const svcBefore = new Set([...A.files.values()].flatMap(f => [...f.services]))
  for (const s of new Set([...B.files.values()].flatMap(f => [...f.services]))) if (!svcBefore.has(s))
    changes.push({ group: 'Outside services', isNew: true, text: `Your app now uses ${s}.` })

  return { ...opts, files: real.length, noise: noise.length, changes, problems, unfinished, ship, A, B, schemaChanged: changed.some(p => p.endsWith('schema.prisma')) }
}

export function render(r: {
  ref: string; asked?: string; color?: boolean; files: number; noise: number
  changes: Change[]; problems: Problem[]; unfinished: string[]; ship: string[]
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
  if (r.noise) out.push('', dim(`(Hidden: ${plural(r.noise, 'file')} with only formatting changes, or lockfiles.)`))
  return out.join('\n')
}
