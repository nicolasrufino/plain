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

type Snap = Map<string, string>

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
  outside: Set<string>; links: Set<string>; fetches: Set<string>; ui: Set<string>; imports: string[]
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
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
    outside: new Set(), links: new Set(), fetches: new Set(), ui: new Set(), imports: [],
  }
  const str = (e?: ts.Node) => e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text
    : e && ts.isTemplateExpression(e) ? e.head.text : undefined
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
          if (WRITES.test(parts[2])) f.writes = true
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
      if (v && (name === 'placeholder' || name === 'aria-label')) f.ui.add(`box "${v}"`)
    }
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
      .map(([w, type = '']) => names.has(type.replace(/[\[\]?]/g, '')) ? `→${type.replace(/[\[\]?]/g, '')}` : w))
  return out
}

const envKeys = (text = '') => new Set([...text.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map(m => m[1]))
const deps = (text = '{}') => { try { const p = JSON.parse(text); return { ...p.dependencies, ...p.devDependencies } as Record<string, string> } catch { return {} } }

function appFacts(snap: Snap) {
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
      for (const k of ['ui', 'fetches', 'links', 'outside', 'tables'] as const) for (const x of c[k]) into[k].add(x)
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

// ---------- the diff ----------

const STOP = new Set(['with', 'that', 'this', 'from', 'make', 'code', 'codes', 'page', 'some', 'please', 'have', 'into', 'when', 'also', 'should', 'want'])
const keywords = (asked: string) =>
  asked.toLowerCase().match(/[a-z]{4,}/g)?.filter(w => !STOP.has(w)).map(w => w.replace(/(es|s)$/, '')) ?? []

type Item = { sign: '+' | '~' | '-'; name: string; notes: string[] }
type Problem = { kind: 'Broken' | 'Unsafe' | 'Unasked'; text: string }

export function report(before: Snap, after: Snap, opts: { ref: string; asked?: string; color?: boolean }): string {
  const A = appFacts(before), B = appFacts(after)
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).sort()
  const noise: string[] = [], real: string[] = []
  for (const p of changed) {
    const a = A.files.get(p), b = B.files.get(p)
    if (NOISE.test(p) || (a && b && a.printed === b.printed)) noise.push(p)
    else real.push(p)
  }
  const usersOf = (name: string, self: string) =>
    [...B.files].filter(([p, f]) => p !== self && (f.used.has(name) || f.jsx.has(name))).map(([p]) => route(p)?.url ?? p)

  const pages: Item[] = [], api: Item[] = [], db: Item[] = [], services: Item[] = []
  const problems: Problem[] = [], unfinished: string[] = [], ship: string[] = []
  const added = (a: Set<string>, b: Set<string>, say: (x: string) => string) => [...b].filter(x => !a.has(x)).map(say)
  const describe = (f: FileFacts) => [
    f.money ? '💰 charges money' : '',
    f.tables.size ? `${f.writes ? 'saves to' : 'reads'} ${[...f.tables].join(', ')}` : '',
    ...[...f.outside].filter(o => !o.startsWith('Stripe: checkout.sessions')).map(o => `calls ${o}`),
    ...f.ui, ...[...f.fetches].map(x => `sends to ${x}`), ...[...f.links].map(x => `links to ${x}`),
    f.auth ? 'login required ✓' : '',
  ].filter(Boolean)

  // pages and API
  for (const p of real) {
    const r = route(p); if (!r) continue
    const a = A.files.get(p), b = B.files.get(p)
    const list = r.kind === 'page' ? pages : api
    const methods = b ? METHODS.filter(m => b.fns.has(m)).join(', ') : ''
    if (!a && b) list.push({ sign: '+', name: r.url, notes: [...(methods ? [methods] : []), ...describe(b)] })
    else if (a && !b) list.push({ sign: '-', name: r.url, notes: ['removed'] })
    else if (a && b) {
      const notes = [
        !a.money && b.money ? '💰 now charges money' : a.money && b.money ? '💰 money code changed' : '',
        a.auth && !b.auth ? 'login check REMOVED' : '',
        ...added(a.tables, b.tables, t => `now uses ${t}`),
        ...added(b.tables, a.tables, t => `no longer uses ${t}`),
        ...added(a.outside, b.outside, x => `now calls ${x}`),
        ...added(a.ui, b.ui, x => `new ${x}`),
        ...added(a.fetches, b.fetches, x => `now sends to ${x}`),
        ...added(a.links, b.links, x => `now links to ${x}`),
      ].filter(Boolean)
      list.push({ sign: '~', name: r.url, notes: notes.length ? notes : ['behind-the-scenes changes'] })
    }
    if (b && !b.auth) {
      const sensitive = r.kind === 'page' ? /admin|dashboard|account/.test(r.url) : (b.writes || METHODS.slice(1).some(m => b.fns.has(m)))
      if ((!a || a.auth) && sensitive && !/webhook/.test(r.url))
        problems.push({ kind: 'Unsafe', text: `${r.url} has no login check, so anyone can ${r.kind === 'page' ? 'open it' : 'call it'}` })
    }
  }

  // database
  const rel = (fs: string[]) => {
    const cols = fs.filter(x => !x.startsWith('→')), links = fs.filter(x => x.startsWith('→')).map(x => x.slice(1))
    return [cols.join(', '), links.length ? `linked to ${links.join(', ')}` : ''].filter(Boolean)
  }
  for (const [m, fields] of B.models) {
    const old = A.models.get(m)
    if (!old) { db.push({ sign: '+', name: m, notes: rel(fields) }); continue }
    const add = fields.filter(x => !old.includes(x)), del = old.filter(x => !fields.includes(x))
    if (add.length || del.length) db.push({ sign: '~', name: m, notes: [
      ...rel(add).map((n, i) => i === 0 && !n.startsWith('linked') ? `+ ${n}` : `now ${n}`),
      ...(del.length ? [`DELETES ${del.join(', ')}`] : []),
    ] })
    if (del.length) ship.push(`Back up first: ${del.map(d => `${m}.${d}`).join(', ')} will be deleted for good`)
  }
  for (const m of A.models.keys()) if (!B.models.has(m)) {
    db.push({ sign: '-', name: m, notes: ['removed'] })
    ship.push(`Back up first: the ${m} table will be deleted for good`)
  }
  const newMigrations = B.migrations.filter(m => !A.migrations.includes(m))
  if (changed.some(p => p.endsWith('schema.prisma')) && !newMigrations.length)
    ship.push('Run `prisma migrate dev`: the database changed but no migration was added')
  for (const m of newMigrations) if (/\bDROP\b/i.test(after.get(m) ?? '')) ship.push(`Back up first: ${m} deletes data and can't be undone`)

  // broken, unasked, unfinished
  const allBefore = new Map<string, string>(), allAfter = new Set<string>()
  for (const [p, f] of A.files) for (const n of f.fns.keys()) allBefore.set(n, p)
  for (const f of B.files.values()) for (const n of f.fns.keys()) allAfter.add(n)
  for (const [n, p] of allBefore) if (!allAfter.has(n) && !METHODS.includes(n)) {
    const users = usersOf(n, p)
    if (users.length) problems.push({ kind: 'Broken', text: `${n}() was deleted, but ${users.join(', ')} still ${users.length > 1 ? 'use' : 'uses'} it` })
  }
  const kw = opts.asked ? keywords(opts.asked) : []
  for (const p of real) {
    const a = A.files.get(p), b = B.files.get(p)
    if (kw.length && a && b && !route(p) && !kw.some(k => (after.get(p) ?? '').toLowerCase().includes(k))) {
      const fns = [...b.fns].filter(([n, s]) => a.fns.has(n) && a.fns.get(n) !== s).map(([n]) => n)
      if (!fns.length) problems.push({ kind: 'Unasked', text: `${p} changed` })
      for (const n of fns) {
        const u = usersOf(n, p)
        problems.push({ kind: 'Unasked', text: `${n}() in ${p} changed${u.length ? `, which also affects ${u.join(', ')}` : ''}` })
      }
    }
    if (!b) continue
    for (const t of b.todos.filter(t => !a?.todos.includes(t))) unfinished.push(`Left a note: "${t}" (${p})`)
    for (const h of b.hardcoded.filter(h => !a?.hardcoded.includes(h))) unfinished.push(`${h}() returns made-up data, not the database`)
    if (b.emptyCatch > (a?.emptyCatch ?? 0)) unfinished.push(`Errors are silently ignored in ${p} (empty catch)`)
    if (b.anys > (a?.anys ?? 0)) { const n = b.anys - (a?.anys ?? 0); unfinished.push(`${n} spot${n === 1 ? '' : 's'} skip${n === 1 ? 's' : ''} type checking in ${p} (\`any\`)`) }
  }
  for (const [p, f] of B.files) if (/(^|\/)components\//.test(p))
    for (const n of f.fns.keys()) if (/^[A-Z]/.test(n) && !usersOf(n, p).length && !A.files.get(p)?.fns.has(n))
      unfinished.push(`<${n}> was built but isn't shown on any page`)

  // env, packages, services
  const usedBefore = new Set([...A.files.values()].flatMap(f => [...f.env]))
  for (const k of new Set([...B.files.values()].flatMap(f => [...f.env]))) if (!usedBefore.has(k))
    ship.push(B.envExample.has(k) ? `Set ${k} on your host (e.g. Vercel)` : `Set ${k} on your host, and add it to .env.example (it's missing)`)
  for (const [d, v] of Object.entries(B.deps)) {
    if (!(d in A.deps)) ship.push(`Check the new package ${d}@${v}`)
    else if (A.deps[d] !== v) ship.push(`Test everything that uses ${d}: upgraded ${A.deps[d]} → ${v}`)
  }
  const svcBefore = new Set([...A.files.values()].flatMap(f => [...f.services]))
  for (const s of new Set([...B.files.values()].flatMap(f => [...f.services]))) if (!svcBefore.has(s))
    services.push({ sign: '+', name: s, notes: ['new outside service'] })

  return render({ ...opts, files: real.length, noise: noise.length, pages, api, db, services, problems, unfinished, ship })
}

function render(r: {
  ref: string; asked?: string; color?: boolean; files: number; noise: number
  pages: Item[]; api: Item[]; db: Item[]; services: Item[]; problems: Problem[]; unfinished: string[]; ship: string[]
}): string {
  const c = (code: string) => (t: string) => r.color ? `\x1b[${code}m${t}\x1b[0m` : t
  const bold = c('1'), dim = c('2'), red = c('31'), yellow = c('33'), green = c('32')
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const out: string[] = [`${bold('plain')} · ${plural(r.files, 'file')} changed since ${r.ref}`]
  if (r.asked) out.push(dim(`You asked: "${r.asked.length > 80 ? r.asked.slice(0, 77) + '...' : r.asked}"`))

  const groups: [string, Item[]][] = [['Pages', r.pages], ['API', r.api], ['Database', r.db], ['Services', r.services]]
  if (!groups.some(([, g]) => g.length) && !r.problems.length && !r.unfinished.length && !r.ship.length)
    return [...out, '', 'Nothing about the app changed.'].join('\n')

  const verdict = [
    r.problems.length ? red(`⚠ ${plural(r.problems.length, 'problem')}`) : green('✓ No problems found'),
    r.unfinished.length ? yellow(`${r.unfinished.length} unfinished`) : '',
    r.ship.length ? `${plural(r.ship.length, 'step')} before shipping` : '',
  ].filter(Boolean).join('  ·  ')
  out.push('', `  ${verdict}`)

  if (r.problems.length) {
    out.push('', bold('NEEDS ATTENTION'))
    const icon = { Broken: red('✖'), Unsafe: red('⚠'), Unasked: yellow('?') }
    for (const p of r.problems) out.push(`  ${icon[p.kind]} ${p.kind.padEnd(8)} ${p.text}${p.kind === 'Unasked' ? dim('  (guess)') : ''}`)
  }

  if (groups.some(([, g]) => g.length)) {
    out.push('', bold('WHAT YOU GOT'))
    const sign = { '+': green('+'), '~': yellow('~'), '-': red('-') }
    const order = { '+': 0, '~': 1, '-': 2 }
    for (const [title, items] of groups) {
      if (!items.length) continue
      out.push(`  ${title}`)
      const w = Math.max(...items.map(i => i.name.length))
      for (const i of items.sort((x, y) => order[x.sign] - order[y.sign])) {
        const [first = '', ...rest] = i.notes
        out.push(`    ${sign[i.sign]} ${i.name.padEnd(w)}   ${first}`)
        for (const n of rest) out.push(`      ${' '.repeat(w)}   ${dim(n)}`)
      }
    }
  }

  if (r.unfinished.length) {
    out.push('', bold('UNFINISHED'))
    for (const u of r.unfinished) out.push(`  ${yellow('◐')} ${u}`)
  }
  if (r.ship.length) {
    out.push('', bold('BEFORE YOU SHIP'))
    r.ship.forEach((s, i) => out.push(`  ${i + 1}. ${s}`))
  }
  if (r.noise) out.push('', dim(`◌ Hidden: ${plural(r.noise, 'file')} only reformatted or lockfiles`))
  return out.join('\n')
}

// Last real user prompt from a Claude Code transcript (JSONL).
function lastPrompt(transcriptPath: string): string | undefined {
  let last: string | undefined
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e.type !== 'user') continue
      const c = e.message?.content
      const text = typeof c === 'string' ? c : c?.find?.((x: any) => x.type === 'text')?.text
      if (text && !text.startsWith('<')) last = text
    } catch { /* partial line */ }
  }
  return last
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const cwd = process.cwd()
  const i = args.indexOf('--asked')
  let asked = i >= 0 ? args[i + 1] : undefined
  const ref = args.find((a, j) => !a.startsWith('--') && (i < 0 || j !== i + 1)) ?? 'HEAD'
  if (args.includes('--hook')) {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
    if (input.transcript_path && existsSync(input.transcript_path)) asked ??= lastPrompt(input.transcript_path)
    const text = report(snapshot(cwd, ref), snapshot(cwd, null), { ref, asked })
    if (!text.endsWith('Nothing about the app changed.')) console.log(JSON.stringify({ systemMessage: text }))
  } else {
    console.log(report(snapshot(cwd, ref), snapshot(cwd, null), { ref, asked, color: process.stdout.isTTY && !process.env.NO_COLOR }))
  }
}
