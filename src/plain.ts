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
        if (CLIENTS[parts[0]] && parts.length > 1) f.outside.add(`${CLIENTS[parts[0]]} ${parts.slice(1).join('.')}`)
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
      if (v && (name === 'placeholder' || name === 'aria-label')) f.ui.add(`input "${v}"`)
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
const label = (path: string) => {
  const r = route(path)
  if (!r) return path
  return r.kind === 'page' ? `page ${r.url}` : `${r.url}`
}

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

export function report(before: Snap, after: Snap, opts: { ref: string; asked?: string }): string {
  const A = appFacts(before), B = appFacts(after)
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).sort()
  const noise: string[] = [], real: string[] = []
  for (const p of changed) {
    const a = A.files.get(p), b = B.files.get(p)
    if (NOISE.test(p) || (a && b && a.printed === b.printed)) noise.push(p)
    else real.push(p)
  }
  const usersOf = (name: string, self: string) =>
    [...B.files].filter(([p, f]) => p !== self && (f.used.has(name) || f.jsx.has(name))).map(([p]) => label(p))

  const out: Record<string, string[]> = { NEW: [], CHANGED: [], ALSO: [], BROKEN: [], UNFINISHED: [], RISKS: [], SHIP: [] }
  const describe = (f: FileFacts) => [
    f.tables.size ? `${f.writes ? 'writes' : 'reads'} ${[...f.tables].join(', ')}` : '',
    [...f.services].filter(s => s !== 'Stripe').join(', '),
    f.money ? '💰 charges money' : '',
    ...[...f.outside].filter(o => !o.startsWith('Stripe checkout.sessions')).map(o => `calls ${o}`),
    ...[...f.ui], ...[...f.fetches].map(x => `calls ${x}`), ...[...f.links].map(x => `links to ${x}`),
  ].filter(Boolean).join(' · ')
  const added = (a: Set<string>, b: Set<string>, say: (x: string) => string) => [...b].filter(x => !a.has(x)).map(say)

  // routes
  for (const p of real) {
    const r = route(p); if (!r) continue
    const a = A.files.get(p), b = B.files.get(p)
    const methods = b ? METHODS.filter(m => b.fns.has(m)).join('/') : ''
    const name = r.kind === 'page' ? `page ${r.url}` : `endpoint ${methods} ${r.url}`
    if (!a && b) out.NEW.push(`${name}${describe(b) ? ' · ' + describe(b) : ''}`)
    else if (a && !b) out.CHANGED.push(`REMOVED ${name}`)
    else if (a && b) {
      const diffs = [
        ...[...b.tables].filter(t => !a.tables.has(t)).map(t => `now uses ${t}`),
        ...[...a.tables].filter(t => !b.tables.has(t)).map(t => `no longer uses ${t}`),
        !a.money && b.money ? 'now charges money 💰' : a.money && b.money ? '💰 money path touched' : '',
        a.auth && !b.auth ? 'LOGIN CHECK REMOVED' : '',
        ...added(a.outside, b.outside, x => `now calls ${x}`),
        ...added(a.ui, b.ui, x => `new ${x}`),
        ...added(a.fetches, b.fetches, x => `now calls ${x}`),
        ...added(a.links, b.links, x => `now links to ${x}`),
      ].filter(Boolean)
      out.CHANGED.push(`${name}${diffs.length ? ' · ' + diffs.join(' · ') : ''}`)
    }
    if (b && !b.auth) {
      const isNew = !a, lost = a?.auth
      const sensitive = r.kind === 'page' ? /admin|dashboard|account/.test(r.url) : (b.writes || METHODS.slice(1).some(m => b.fns.has(m)))
      if ((isNew || lost) && sensitive && !/webhook/.test(r.url))
        out.RISKS.push(`${name} has no login check, so anyone can ${r.kind === 'page' ? 'open it' : 'call it'}`)
    }
  }

  // data
  for (const [m, fields] of B.models) {
    const old = A.models.get(m)
    if (!old) out.NEW.push(`table ${m} (${fields.join(', ')})`)
    else {
      const add = fields.filter(x => !old.includes(x)), del = old.filter(x => !fields.includes(x))
      if (add.length || del.length) out.CHANGED.push(`table ${m}${add.length ? ' · +' + add.join(', +') : ''}${del.length ? ' · DROPPED ' + del.join(', ') : ''}`)
      if (del.length) out.SHIP.push(`table ${m} drops ${del.join(', ')}: that data is deleted for good`)
    }
  }
  for (const m of A.models.keys()) if (!B.models.has(m)) out.SHIP.push(`table ${m} is removed: its data is deleted for good`)
  const schemaChanged = changed.some(p => p.endsWith('schema.prisma'))
  const newMigrations = B.migrations.filter(m => !A.migrations.includes(m))
  if (schemaChanged && !newMigrations.length) out.SHIP.push('database schema changed but no migration was added: run `prisma migrate dev`')
  for (const m of newMigrations) if (/\bDROP\b/i.test(after.get(m) ?? '')) out.SHIP.push(`migration ${m} DROPs data and can't be undone`)

  // functions: broken, also-changed, unfinished
  const allBefore = new Map<string, string>(), allAfter = new Set<string>()
  for (const [p, f] of A.files) for (const n of f.fns.keys()) allBefore.set(n, p)
  for (const f of B.files.values()) for (const n of f.fns.keys()) allAfter.add(n)
  for (const [n, p] of allBefore) if (!allAfter.has(n) && !METHODS.includes(n)) {
    const users = usersOf(n, p)
    if (users.length) out.BROKEN.push(`${n}() was deleted from ${p} but ${users.join(', ')} still ${users.length > 1 ? "use" : "uses"} it`)
  }

  const kw = opts.asked ? keywords(opts.asked) : []
  for (const p of real) {
    const a = A.files.get(p), b = B.files.get(p)
    const fnChanges = b ? [...b.fns].filter(([n, s]) => a?.fns.get(n) !== s && a?.fns.has(n)).map(([n]) => n) : []
    if (kw.length && a && b && !route(p)) {
      const text = (after.get(p) ?? '').toLowerCase()
      if (!kw.some(k => text.includes(k)))
        out.ALSO.push(fnChanges.length
          ? fnChanges.map(n => { const u = usersOf(n, p); return `${p}: ${n}() changed${u.length ? ' → also affects ' + u.join(', ') : ''}` }).join('\n  ')
          : `${p} changed`)
    }
    if (!b) continue
    const newTodos = b.todos.filter(t => !a?.todos.includes(t))
    for (const t of newTodos) out.UNFINISHED.push(`${p}: ${t}`)
    for (const h of b.hardcoded.filter(h => !a?.hardcoded.includes(h))) out.UNFINISHED.push(`${h}() returns hardcoded data, not the database`)
    if (b.emptyCatch > (a?.emptyCatch ?? 0)) out.UNFINISHED.push(`${p}: an empty catch {} hides errors`)
    if (b.anys > (a?.anys ?? 0)) out.UNFINISHED.push(`${p}: ${b.anys - (a?.anys ?? 0)} new \`any\` type(s)`)
  }

  // components that nobody renders
  for (const [p, f] of B.files) if (/(^|\/)components\//.test(p)) {
    for (const n of f.fns.keys()) if (/^[A-Z]/.test(n) && !usersOf(n, p).length && (!A.files.has(p) || !A.files.get(p)!.fns.has(n)))
      out.UNFINISHED.push(`<${n}> is never shown on any page`)
  }

  // env, packages, services
  const usedBefore = new Set([...A.files.values()].flatMap(f => [...f.env]))
  const usedAfter = new Set([...B.files.values()].flatMap(f => [...f.env]))
  for (const k of usedAfter) if (!usedBefore.has(k))
    out.SHIP.push(B.envExample.has(k) ? `set ${k} on your host (e.g. Vercel)` : `${k} is used but missing from .env.example, so set it on your host too`)
  for (const [d, v] of Object.entries(B.deps)) {
    if (!(d in A.deps)) out.SHIP.push(`new package ${d}@${v}`)
    else if (A.deps[d] !== v) out.SHIP.push(`${d} upgraded ${A.deps[d]} → ${v}`)
  }
  const svcBefore = new Set([...A.files.values()].flatMap(f => [...f.services]))
  for (const s of new Set([...B.files.values()].flatMap(f => [...f.services]))) if (!svcBefore.has(s)) out.NEW.push(`outside service: ${s}`)

  // render
  const sec = (icon: string, title: string, lines: string[]) => lines.length ? `\n${icon} ${title}\n  ${[...new Set(lines)].join('\n  ')}` : ''
  const head = `plain · compared to ${opts.ref} · ${real.length} file${real.length === 1 ? '' : 's'} changed${opts.asked ? `\nasked: "${opts.asked.slice(0, 80)}"` : ''}`
  const body = [
    sec('✚', 'NEW', out.NEW),
    sec('✎', 'CHANGED', out.CHANGED),
    sec('⚠', `ALSO CHANGED (not obviously part of what you asked) [guess]`, out.ALSO),
    sec('✖', 'BROKEN', out.BROKEN),
    sec('◐', 'NOT FINISHED', out.UNFINISHED),
    sec('⚠', 'RISKS', out.RISKS),
    sec('☐', 'BEFORE YOU SHIP', out.SHIP),
    noise.length ? `\n◌ ${noise.length} file${noise.length === 1 ? '' : 's'} only reformatted or lockfiles (hidden)` : '',
  ].join('')
  return head + (body.trim() ? body : '\n\nNothing about the app changed.')
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
    console.log(report(snapshot(cwd, ref), snapshot(cwd, null), { ref, asked }))
  }
}
