// "Only lets the workspace's members in": a Next.js server action whose login helper also checks that the logged-in user is a member of
// the workspace it's given, and whose every Prisma read and write is limited to that same workspace. Read structurally (balanced braces,
// top-level keys only), and strict: anything plain can't follow (OR/NOT, transactions, raw SQL, connect, a try, a reassigned value) means
// no claim, and the card keeps "requires login ✓".

import ts from 'typescript'

// What the TypeScript parser sees in some code: regex literals and dynamic imports (either means no claim), how many times each name is
// bound (parameters, variables, destructured names, loop variables), which names are assigned or changed, and every name it refers to
export function scan(text: string) {
  const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const r = { regex: false, dynamic: false, bound: new Map<string, number>(), assigned: new Set<string>(), idents: new Set<string>() }
  const bind = (n: ts.BindingName) => { if (ts.isIdentifier(n)) r.bound.set(n.text, (r.bound.get(n.text) ?? 0) + 1); else for (const e of n.elements) if (!ts.isOmittedExpression(e)) bind(e.name) }
  const target = (n: ts.Node): void => { if (ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) return target(n.expression)
    if (ts.isIdentifier(n)) r.assigned.add(n.text); else if (ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n)) n.forEachChild(target)
    else if (ts.isShorthandPropertyAssignment(n)) r.assigned.add(n.name.text); else if (ts.isPropertyAssignment(n) || ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) target(ts.isPropertyAssignment(n) ? n.initializer : n.expression) }
  const visit = (n: ts.Node) => {
    if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) r.regex = true
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(n.expression) && n.expression.text === 'require')) r.dynamic = true
    if (ts.isParameter(n) || ts.isVariableDeclaration(n)) bind(n.name)
    if ((ts.isForInStatement(n) || ts.isForOfStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) target(n.initializer)   // for (projectId of ...)
    if (ts.isIdentifier(n) && /^(?:eval|globalThis|Function|window|global)$/.test(n.text)) r.dynamic = true
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target(n.left)
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) target(n.operand)
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) r.idents.add(n.text)
    n.forEachChild(visit)
  }
  visit(sf)
  return r
}
// A file's top-level names: functions (with their code) and everything else (objects, classes, values)
// (anything else at the top, a namespace, `import x = require(...)`, a top-level `if` holding a `var`, or a name declared or assigned twice,
// shows up as '...', and the action's claim is dropped)
export function topLevel(text: string): Map<string, { fn: boolean; text: string }> {
  const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), m = new Map<string, { fn: boolean; text: string }>()
  const set = (k: string, v: { fn: boolean; text: string }) => m.set(m.has(k) ? '...' : k, m.has(k) ? { fn: false, text: '' } : v)
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isEnumDeclaration(st)
      || ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)) {
      if (ts.isImportDeclaration(st) && st.importClause?.name && st.importClause.namedBindings && ts.isNamespaceImport(st.importClause.namedBindings)) m.set('...', { fn: false, text: '' })
      continue
    }
    if (ts.isFunctionDeclaration(st) && st.name) set(st.name.text, { fn: true, text: st.getText(sf) })
    else if (ts.isClassDeclaration(st) && st.name) set(st.name.text, { fn: false, text: '' })
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) { m.set('...', { fn: false, text: '' }); continue }
      const fn = !!d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && !!(st.declarationList.flags & ts.NodeFlags.Const)
      set(d.name.text, { fn, text: fn ? d.getText(sf) : '' })
    }
    else if (!ts.isFunctionDeclaration(st) && !ts.isClassDeclaration(st)) m.set('...', { fn: false, text: '' })
  }
  // (a top-level function the file replaces later: `clean = ...`)
  for (const x of scan(text).assigned) if (m.has(x)) m.set(x, { fn: false, text: '' })
  return m
}

// The text inside the bracket that opens at s[i], or undefined when it doesn't close
export function inside(s: string, i: number): string | undefined {
  let d = 0
  for (let j = i; j < s.length; j++) {
    const ch = s[j]
    if (ch === '"' || ch === "'" || ch === '`') { const k = s.indexOf(ch, j + 1); if (k < 0) return undefined; j = k; continue }
    if ('({['.includes(ch)) d++
    else if (')}]'.includes(ch) && --d === 0) return s.slice(i + 1, j)
  }
  return undefined
}
// An object literal's top-level keys and their values: `{ id: x, workspaceId, a: { b } }` -> id: x, workspaceId: workspaceId, a: { b }
// (a spread is kept as '...')
export function keys(obj: string | undefined): Map<string, string> {
  const m = new Map<string, string>(), t = (obj ?? '').trim()
  const body = t.startsWith('{') ? inside(t, 0) ?? '' : t
  let d = 0, start = 0
  const parts: string[] = []
  for (let j = 0; j <= body.length; j++) {
    const ch = body[j]
    if (ch === '"' || ch === "'" || ch === '`') { const k = body.indexOf(ch, j + 1); if (k > 0) j = k; continue }
    if (ch !== undefined && '({['.includes(ch)) d++
    else if (ch !== undefined && ')}]'.includes(ch)) d--
    else if ((ch === ',' || ch === undefined) && d === 0) { parts.push(body.slice(start, j).trim()); start = j + 1 }
  }
  for (const p of parts.filter(Boolean)) {
    if (p.startsWith('...')) { m.set('...', p.slice(3)); continue }
    const c = p.indexOf(':')
    if (c < 0) m.set(p, p)
    else m.set(p.slice(0, c).trim().replace(/^['"]|['"]$/g, ''), p.slice(c + 1).trim())
  }
  return m
}
// How many blocks deep `at` sits in `text` (counting `{` that haven't closed), and the text just before the innermost one
export function depth(text: string, at: number): { n: number; opener: string } {
  const open: number[] = []
  for (let j = 0; j < at; j++) {
    const ch = text[j]
    if (ch === '"' || ch === "'" || ch === '`') { const k = text.indexOf(ch, j + 1); if (k < 0 || k >= at) break; j = k; continue }
    if (ch === '{') open.push(j)
    else if (ch === '}') open.pop()
  }
  return { n: open.length, opener: open.length ? text.slice(Math.max(0, open.at(-1)! - 80), open.at(-1)! + 1) : '' }
}
// Every `prisma.<model>.<op>(...)` call, with its argument's top-level keys
export const prismaCalls = (code: string) => [...code.matchAll(/\bprisma\.(\w+)\.(\w+)\s*\(/g)].map(m => {
  const arg = inside(code, m.index! + m[0].length - 1)
  return { model: m[1], op: m[2], at: m.index!, end: m.index! + m[0].length + (arg?.length ?? 0) + 1, arg, top: keys(arg) }
})
const LOGIC = /^(?:OR|AND|NOT)$/
// a where (or data) limited to the value by the group's own key: `workspaceId` or `workspaceId: workspaceId`, with no OR/AND/NOT
// (not `{ id: taskId }` after checking membership of taskId)
const limitedTo = (obj: Map<string, string>, v: string, key: string) => obj.get(key) === v && ![...obj.keys()].some(k => LOGIC.test(k) || k === '...')

// The helper's own membership check. `text` is the helper's code; `param` its first parameter; `logins` the login helpers it calls first
// (requireUser); `nav` the names it imports from next/navigation. Returns the group's name ("workspace") when it looks up a membership of the logged-in user for `param` and stops right
// after when there's none, with nothing before it that returns or could swallow the stop.
export function memberCheck(text: string, param: string, logins: string[], nav: Set<string>): string | undefined {
  // (a regex literal, `.replace(/'/g, "")`: its quotes and braces would throw off the bracket counting)
  const sc = scan(text)
  if (/\btry\s*\{/.test(text) || sc.regex || sc.dynamic) return undefined
  // the logged-in user: `const user = await requireUser()` (or `{ user }`), or `const session = await auth()` (session.user.id)
  const users = [...text.matchAll(/\b(?:const|let)\s+(\{\s*user\s*\}|\w+)\s*=\s*await\s+(\w+)\s*\(\s*\)/g)].filter(m => logins.includes(m[2]) || m[2] === 'auth')
    // (from auth() only when the id itself is checked: `if (!session?.user?.id)`; Prisma drops a `userId: undefined` and any row matches)
    .filter(m => m[2] !== 'auth' || new RegExp(String.raw`\bif\s*\(\s*!\s*${m[1]}\??\.user\??\.id\s*\)`).test(text))
    .map(m => m[1].startsWith('{') ? 'user' : m[2] === 'auth' ? `${m[1]}?.user` : m[1])
  const isUser = (x: string) => users.some(u => new RegExp(String.raw`^${u.replace(/[.?]/g, c => '\\' + c)}(?:\??\.user)?\??\.id$`).test(x.replace(/!/g, '')))
  for (const c of prismaCalls(text)) {
    if (!/^find(?:First|Unique)(?:OrThrow)?$/.test(c.op)) continue
    const where = keys(c.top.get('where'))
    if ([...where.keys()].some(k => LOGIC.test(k) || k === '...')) continue
    let group: string | undefined
    // the workspace, through its memberships: `{ id: workspaceId, memberships: { some: { userId: user.id } } }`
    const rel = where.get('memberships') ?? where.get('members')
    if (rel && where.get('id') === param) {
      const some = keys(keys(rel).get('some')), relKeys = [...keys(rel).keys()]
      if (relKeys.length === 1 && some.size === 1 && isUser(some.get('userId') ?? '')) group = c.model
    }
    // the membership row: `{ workspaceId, userId: user.id }` or `{ workspaceId_userId: { workspaceId, userId: user.id } }`
    if (/^(?:member|membership|(?:workspace|team|org|organization|group|company|space|board)(?:Member|Membership))$/.test(c.model)) {
      const compound = [...where].find(([k]) => /^\w+Id_userId$|^userId_\w+Id$/.test(k)), w = compound && where.size === 1 ? keys(compound[1]) : where
      const own = [...w].find(([k, x]) => /Id$/.test(k) && k !== 'userId' && x === param)
      if (own && isUser(w.get('userId') ?? '') && w.size === 2) group = own[0].slice(0, -2)
    }
    if (!group) continue
    // at the helper's top level, nothing before it returns (a site admin let through), and the very next statement stops when it's
    // missing (an OrThrow not caught with `.catch(...)`)
    const before = text.slice(text.indexOf('{') + 1, c.at)
    if (/\breturn\b/.test(before) || depth(text, c.at).n !== 1) continue
    const decl = text.slice(0, c.at).match(/\b(?:const|let)\s+(\w+)\s*=\s*await\s*$/)
    if (c.op.endsWith('OrThrow')) { if ((decl || /\bawait\s*$/.test(text.slice(0, c.at))) && !/^\s*[.?]/.test(text.slice(c.end))) return group; continue }
    if (!decl) continue
    const next = text.slice(c.end).replace(/^\s*;?\s*/, '')
    // (Next's own notFound / redirect / forbidden / unauthorized, which throw; not a local `forbidden()` that returns a value)
    const stop = next.match(new RegExp(String.raw`^if\s*\(\s*!\s*${decl[1]}\s*\)\s*\{?\s*(?:return\s+)?(?:(notFound|redirect|forbidden|unauthorized)\s*\(|(throw)\b)`))?.slice(1).find(Boolean)
    if (stop === 'throw' || stop && nav.has(stop)) return group
  }
  return undefined
}

// The action keeps to that workspace: `v` (what it gave the member check) is never reassigned, and every Prisma call is limited to it:
// reads and updates and deletes by their where, creates by their data, each written out as an object. Updates don't move rows (no
// workspace key in their data, no connect). Every id it writes is the logged-in user's (`user.id`, from `const { user } = await
// requireWorkspaceMember(...)`) or was found first, at the top level (or under `if (thatId)`), by a lookup limited to the workspace with a
// stop when missing, and not reassigned since. Nothing reads related rows past the first level (`include: { assignee: { include:
// { tasks: true } } }` reaches other workspaces).
export function keepsTo(text: string, v: string, key: string, lead: string): boolean {
  const sc = scan(text)
  if (/\$transaction|\$executeRaw|\$queryRaw|\$runCommandRaw|\bsql`|\btx\.|\bdb\.|\btry\s*\{|connectOrCreate|\bconnect\s*:|\bset\s*:|\bdisconnect\s*:/.test(text) || sc.regex || sc.dynamic) return false
  // bound once and never changed (by the parser: a second binding anywhere, `({ user }) => ...`, `for (const { projectId } of moves)`,
  // `(title, workspaceId) =>`, or any assignment means it may not be the value that was checked)
  const reassigned = (x: string) => sc.bound.get(x) !== 1 || sc.assigned.has(x)
  if (reassigned(v)) return false
  const calls = prismaCalls(text), writes = calls.filter(c => /^(?:create|update|updateMany|delete|deleteMany)$/.test(c.op))
  if (!writes.length || calls.some(c => !/^(?:create|update|updateMany|delete|deleteMany|findFirst|findUnique|findMany|count)$/.test(c.op))) return false
  // every Prisma use is one plain read (not `prisma["task"]`, `prisma?.task`, `const m = prisma.task`), and every write-looking call too
  if ((text.match(/\bprisma\b/g) ?? []).length !== calls.length) return false
  if ((text.match(/\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g) ?? []).length !== writes.length) return false
  const me = new RegExp(String.raw`\bconst\s*\{\s*user\s*\}\s*=\s*await\s+${lead}\s*\(\s*${v}\s*\)`).test(text) && !reassigned('user') ? 'user.id' : undefined
  const verified = (id: string, before: number) => !reassigned(id) && calls.some(c => c.end < before && /^find(?:First|Unique)$/.test(c.op) && limitedTo(keys(c.top.get('where')), v, key)
    // (found as the row's own id, or as the user of a membership: not `name: projectId`)
    && (keys(c.top.get('where')).get('id') === id || /^(?:member|membership|\w+Member|\w+Membership)$/.test(c.model) && keys(c.top.get('where')).get('userId') === id) && (() => {
      const d = depth(text, c.at), top = text.indexOf('{') < c.at && (d.n === 1 || d.n === 2 && new RegExp(String.raw`(?<!\belse\s+)\bif\s*\(\s*${id}\s*\)\s*\{$`).test(d.opener))
      const decl = text.slice(0, c.at).match(/\b(?:const|let)\s+(\w+)\s*=\s*await\s*$/), after = text.slice(c.end).replace(/^\s*;?\s*/, '')
      return top && (decl ? new RegExp(String.raw`^if\s*\(\s*!\s*${decl[1]}\s*\)\s*\{?\s*(?:return\b|throw\b|notFound\s*\(|redirect\s*\()`).test(after)
        : d.n === 1 && new RegExp(String.raw`\bif\s*\(\s*${id}\s*&&\s*!\s*\(\s*await\s*$`).test(text.slice(0, c.at)) && /^\s*\)\s*\)\s*\{?\s*(?:return|throw)\b/.test(text.slice(c.end))) })())
  for (const c of calls) {
    for (const part of ['where', 'data', 'include', 'select']) { const x = c.top.get(part); if (x !== undefined && !x.startsWith('{')) return false }
    for (const part of ['include', 'select']) if ([...keys(c.top.get(part))].some(([, x]) => x !== 'true')) return false
    const where = keys(c.top.get('where')), data = keys(c.top.get('data'))
    if (c.op === 'create') { if (!limitedTo(data, v, key)) return false }
    else if (!limitedTo(where, v, key)) return false
    if (c.op === 'create' || c.op.startsWith('update')) for (const [k, x] of data) {
      if (k === key && c.op !== 'create' || k === '...' || /^[{[]/.test(x)) return false   // (moves the row; spreads and nested writes)
      if (k === key) continue
      if (/Ids?$/.test(k) && !(x === 'null' || x === me || /^\w+$/.test(x) && verified(x, c.at))) return false
    }
  }
  return true
}
