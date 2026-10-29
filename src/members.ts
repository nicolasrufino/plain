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
// The names some code uses at run time that it doesn't bind itself (types, property names and JavaScript's own built-ins left out):
// what it takes from around it
const BUILTIN = /^(?:String|Number|Boolean|Date|JSON|Math|Array|Promise|Error|TypeError|RangeError|console|undefined|NaN|Infinity|parseInt|parseFloat|isNaN|Symbol|BigInt|Map|Set|encodeURIComponent|decodeURIComponent|arguments)$/
export function free(text: string): Set<string> {
  const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), bound = new Set<string>(), used = new Set<string>()
  const bind = (n: ts.BindingName) => { if (ts.isIdentifier(n)) bound.add(n.text); else for (const e of n.elements) if (!ts.isOmittedExpression(e)) bind(e.name) }
  const visit = (n: ts.Node): void => {
    if (ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return
    if (ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n) && ts.isIdentifier(n.name)) bind(n.name)
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassDeclaration(n)) && n.name) bound.add(n.name.text)
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
      && !(ts.isBindingElement(n.parent) && n.parent.propertyName === n) && !ts.isLabeledStatement(n.parent) && !ts.isBreakOrContinueStatement(n.parent)) used.add(n.text)
    n.forEachChild(visit)
  }
  visit(sf)
  return new Set([...used].filter(x => !bound.has(x) && !BUILTIN.test(x)))
}

// Every name some code binds: parameters, variables, destructured names, catch variables, named functions and classes (declared or not)
export function boundAll(text: string): Set<string> {
  const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), out = new Set<string>()
  const bind = (n: ts.BindingName) => { if (ts.isIdentifier(n)) out.add(n.text); else for (const e of n.elements) if (!ts.isOmittedExpression(e)) bind(e.name) }
  const visit = (n: ts.Node): void => {
    if (ts.isParameter(n) || ts.isVariableDeclaration(n)) bind(n.name)
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.name) out.add(n.name.text)
    n.forEachChild(visit)
  }
  visit(sf)
  return out
}
// The names around a Socket.IO handler: the file's top level and imports, and what the `io.on("connection", ...)` callback declares
// directly (its parameters and its own statements' names, not those inside the event handlers)
export function aroundNames(text: string): { top: Set<string>; conn: Set<string> } {
  const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), top = new Set<string>(), conn = new Set<string>()
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) { const c = st.importClause; if (c.name) top.add(c.name.text)
      if (c.namedBindings) { if (ts.isNamespaceImport(c.namedBindings)) top.add(c.namedBindings.name.text); else for (const e of c.namedBindings.elements) top.add(e.name.text) } }
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) top.add(st.name.text)
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) for (const x of boundAll(`let ${d.name.getText(sf)} = 0`)) top.add(x)
    else if (ts.isImportEqualsDeclaration(st)) top.add(st.name.text)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'on' && ts.isStringLiteral(n.arguments[0] ?? n) && /^(?:connection|connect)$/.test((n.arguments[0] as ts.StringLiteral).text)) {
      const cb = n.arguments[1]
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) { for (const prm of cb.parameters) for (const x of boundAll(prm.name.getText(sf) + ' => 0')) conn.add(x)
        if (ts.isBlock(cb.body)) for (const st of cb.body.statements) {
          if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) conn.add(st.name.text)
          else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) for (const x of boundAll(`let ${d.name.getText(sf)} = 0`)) conn.add(x) } }
    }
    n.forEachChild(visit)
  }
  visit(sf)
  return { top, conn }
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

// A function's only top-level return (not one in a nested function), when it's the last statement of its body
export function lastReturn(text: string): ts.Expression | undefined {
  const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fn = sf.statements.find(x => ts.isFunctionDeclaration(x) || ts.isVariableStatement(x))
  const body = fn && ts.isFunctionDeclaration(fn) ? fn.body : fn && ts.isVariableStatement(fn) ? (() => { const i = fn.declarationList.declarations[0]?.initializer; return i && (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) && ts.isBlock(i.body) ? i.body : undefined })() : undefined
  if (!body) return undefined
  const returns: ts.ReturnStatement[] = []
  const visit = (n: ts.Node) => { if (ts.isFunctionLike(n)) return; if (ts.isReturnStatement(n)) returns.push(n); n.forEachChild(visit) }
  body.statements.forEach(visit)
  const last = body.statements.at(-1)
  return returns.length === 1 && last === returns[0] ? returns[0].expression : undefined
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
// `out.ownRole` says whether the role it returns is the user's own in that workspace: `role: workspace.memberships[0].role` with the
// lookup's include keeping only the user's membership, or `role: m.role` / the row itself when it looked up the membership row.
export function memberCheck(text: string, param: string, logins: string[], nav: Set<string>, out: { ownRole?: boolean } = {}): string | undefined {
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
    // (by the parser: the helper's only top-level return, its last statement, is the membership row itself or an object, no spread,
    // whose role is exactly the row's role (`m.role`) or the filtered relation's first one (`workspace.memberships[0].role`): not
    // `m.user`, `?? user.role`, nor an early `return { user, role: "owner" }` for staff)
    const own = (v?: string) => { if (!v || (sc.bound.get(v) ?? 0) !== 1 || sc.assigned.has(v)) return false
      const relName = rel ? (keys(c.top.get('include')).has('memberships') ? 'memberships' : 'members') : ''
      if (rel) { const w = keys(keys(keys(c.top.get('include')).get(relName)).get('where')); if (w.size !== 1 || !isUser(w.get('userId') ?? '')) return false }
      const r = lastReturn(text)
      if (!r) return false
      // (nothing touches it between the lookup and the return: not `m.role = "owner"`, `Object.assign(m, ...)`, an alias: only the
      // declaration and the `if (!m)` stop, or the declaration alone with OrThrow)
      const uses = (text.slice(0, r.getStart()).match(new RegExp(String.raw`(?<![\w$.])${v}\b`, 'g')) ?? []).length
      if (uses !== (c.op.endsWith('OrThrow') ? 1 : 2)) return false
      if (ts.isIdentifier(r)) return !rel && r.text === v
      if (!ts.isObjectLiteralExpression(r) || r.properties.some(x => !ts.isPropertyAssignment(x) && !ts.isShorthandPropertyAssignment(x))) return false
      const roles = r.properties.filter(x => x.name && x.name.getText().replace(/^[\['"]+|['"\]]+$/g, '') === 'role'), role = roles[0] as ts.PropertyAssignment | undefined
      const other = r.properties.filter(x => x !== role).every(x => ts.isShorthandPropertyAssignment(x) || !new RegExp(String.raw`(?<![\w$.])${v}\b`).test((x as ts.PropertyAssignment).initializer.getText()) || (x as ts.PropertyAssignment).initializer.getText() === v)
      return roles.length === 1 && other && !!role && ts.isPropertyAssignment(role) && role.initializer.getText().replace(/\s+/g, '') === (rel ? `${v}.${relName}[0].role` : `${v}.role`) }
    if (c.op.endsWith('OrThrow')) { if ((decl || /\bawait\s*$/.test(text.slice(0, c.at))) && !/^\s*[.?]/.test(text.slice(c.end))) { out.ownRole = own(decl?.[1]); return group } continue }
    if (!decl) continue
    const next = text.slice(c.end).replace(/^\s*;?\s*/, '')
    // (Next's own notFound / redirect / forbidden / unauthorized, which throw; not a local `forbidden()` that returns a value)
    const stop = next.match(new RegExp(String.raw`^if\s*\(\s*!\s*${decl[1]}\s*\)\s*\{?\s*(?:return\s+)?(?:(notFound|redirect|forbidden|unauthorized)\s*\(|(throw)\b)`))?.slice(1).find(Boolean)
    if (stop === 'throw' || stop && nav.has(stop) && !sc.bound.has(stop) && !new RegExp(String.raw`\bfunction\s+${stop}\b`).test(text)) { out.ownRole = own(decl[1]); return group }
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

// The roles a helper lets through once the member check has run: `const r = await requireWorkspaceMember(workspaceId)` as its first step,
// then right away `if (r.role !== "owner" && r.role !== "admin") notFound()` (or `if (!["owner", "admin"].includes(r.role))`), stopping
// with Next's own function or a throw. Nothing else comes first.
export function roleGate(text: string, inner: string, param: string, nav: Set<string>): string[] | undefined {
  const sc = scan(text)
  if (/\btry\s*\{/.test(text) || sc.regex || sc.dynamic) return undefined
  const m = text.match(new RegExp(String.raw`^[^{]*\{\s*(?:const|let)\s+(\w+)\s*=\s*await\s+${inner}\s*\(\s*${param}\s*\)\s*;?\s*if\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*\{?\s*(?:return\s+)?(?:(notFound|redirect|forbidden|unauthorized)\s*\(|(throw)\b)`))
  if (!m || (sc.bound.get(m[1]) ?? 0) !== 1 || sc.assigned.has(m[1]) || m[3] && (!nav.has(m[3]) || sc.bound.has(m[3]) || new RegExp(String.raw`\bfunction\s+${m[3]}\b`).test(text))) return undefined
  const r = m[1].replace(/\$/g, '\\$'), cond = m[2].trim()
  const list = cond.match(new RegExp(String.raw`^!\s*\[\s*((?:['"]\w+['"]\s*,?\s*)+)\]\s*\.includes\(\s*${r}\.role\s*\)$`))
  if (list) return [...list[1].matchAll(/['"](\w+)['"]/g)].map(x => x[1])
  const parts = cond.split('&&').map(x => x.trim().match(new RegExp(String.raw`^${r}\.role\s*!==?\s*['"](\w+)['"]$`))?.[1])
  return parts.length && parts.every(Boolean) ? parts as string[] : undefined
}

// "Room members only" for a Socket.IO event: the handler's first step turns away anyone not in the room it names
// (`if (... || !(await isMember(roomId, user.id))) { ack(...); return }`), where `user` is the logged-in socket user
// (`socket.data.user`) and `isMember` is a function of the same file that looks up the room-member row for exactly those two
// values and answers whether it exists. Everything after it stays in that room: each Prisma call is limited to it (`roomId`), and every
// `.to(...)` / `.join(...)` names it. The guard may sit at the top of the handler or of a try whose catch only reports back.
// `helpers` maps the file's top-level function names to their code. `o.callOk(name)` says whether a function the handler calls is one plain
// read and that does nothing (no database, no sockets, no network: `serializeMessage`); `o.scalars` are the schema's plain field names (a
// nested `select` may only pick those, not `messages`); `o.fields(model)` the member model's fields (a `leftAt` or `banned` column means
// a row alone doesn't make someone a member).
export function roomOnly(handler: string, fileText: string, helpers: Map<string, { fn: boolean; text: string }>,
  o: { callOk: (name: string) => boolean; scalars: Set<string>; fields: (model: string) => string[] | undefined; ev?: string } = { callOk: () => false, scalars: new Set(), fields: () => undefined }): boolean {
  const sc = scan(handler)
  if (sc.regex || sc.dynamic || /\$transaction|\$executeRaw|\$queryRaw|\btx\.|\bdb\./.test(handler)) return false
  // the logged-in user: `const user = socket.data.user` (once in the whole file, never rebound in the handler from what the client sends),
  // and `socket.data.user` set once, from a verify call (not `jwt.decode`, not the handshake's own fields)
  const user = fileText.match(/\bconst\s+(\w+)\s*=\s*socket\.data\.user\b/)?.[1]
  const fsc = scan(fileText)
  if (!user || fsc.bound.get(user) !== 1 || sc.bound.has(user) || fsc.assigned.has(user) || new RegExp(String.raw`Object\.assign\s*\(\s*${user}\b`).test(fileText)) return false
  const sets = [...fileText.matchAll(/\bsocket\.data\.user\s*=(?!=)\s*([^;\n]+)/g)].map(m => m[1])
  if (sets.length !== 1 || !/^(?:await\s+)?[\w.]*verify\w*\s*\(/i.test(sets[0].trim()) || /handshake|decode/i.test(sets[0])) return false
  // everything it takes from around it is the user, the server, its own socket, Prisma (imported, under that name), the member check, or
  // a function plain read that touches nothing of the app (`serializeMessage`): not a helper of the connection, a service object, a
  // function passed to `.map`. And nothing talks to everyone, or to sockets other than its own.
  const outside = free(handler)
  if (sc.bound.has('socket') || sc.bound.has('io') || sc.assigned.has('socket') || sc.assigned.has('io') || !/\bimport\s*\{[^}]*\bprisma\b[^}]*\}\s*from\b/.test(fileText) || helpers.has('prisma')) return false
  // (the user, the server and the socket are only read from or talked to, never handed to anything; the user's fields never set)
  if (new RegExp(String.raw`[(,]\s*(?:io|socket|${user})\s*[,)]`).test(handler) || new RegExp(String.raw`\b${user}\s*(?:\.\s*\w+|\[[^\]]*\])\s*(?:=(?![=>])|\+\+|--|[-+*/|&?]=)`).test(fileText)) return false
  if (/\bio\s*\.\s*(?!to\s*\(|in\s*\()\w|\bwith\s*\(|\.broadcast\b|\bio\s*\.\s*(?:send|write)\b|\.constructor\b|\.sockets\b|\.of\s*\(|\.local\b|\.except\s*\(|\bnsp\b|\bio\s*\.\s*emit\b|serverSideEmit|\.emit\s*\?\.|fetchSockets|\b(?:io|socket)\s*(?:\?\.|\[)|\.bind\s*\(/.test(handler)) return false
  for (const m of handler.matchAll(/\.emit\s*\(/g)) { const before = handler.slice(0, m.index)
    if (!/(?:\bio|\bsocket)\s*\.\s*(?:to|in)\s*\(\s*(?:`[^`]*`|\w+)\s*\)\s*$|\bsocket\s*$/.test(before)) return false }
  const sf = ts.createSourceFile('x.tsx', handler, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fn = (sf.statements[0] as ts.ExpressionStatement | undefined)?.expression
  const f = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : sf.statements.find(ts.isFunctionDeclaration)
  if (!f?.body || !ts.isBlock(f.body)) return false
  let stmts = [...f.body.statements]
  if (stmts.length === 1 && ts.isTryStatement(stmts[0])) {
    const c = stmts[0].catchClause?.block.getText(sf) ?? ''
    if (stmts[0].finallyBlock || /prisma|\.emit\s*\(|\.to\s*\(|\.join\s*\(|\.in\s*\(/.test(c)) return false
    stmts = [...stmts[0].tryBlock.statements]
  }
  // the guard: an `if` whose condition is the member check, or-ed with other ways to say no, and whose branch ends in return
  const gi = stmts.findIndex(st => ts.isIfStatement(st) && /\bisMember|member/i.test(st.expression.getText(sf)))
  if (gi < 0) return false
  const g = stmts[gi] as ts.IfStatement, then = g.thenStatement
  const returns = ts.isReturnStatement(then) || ts.isBlock(then) && then.statements.length > 0 && ts.isReturnStatement(then.statements.at(-1)!)
  // (and the way out only answers the sender: no database, no sockets)
  if (!returns || g.elseStatement || /prisma|\.emit\s*\(|\.to\s*\(|\.in\s*\(|\.join\s*\(|\.leave\s*\(/.test(then.getText(sf))) return false
  const disj: ts.Expression[] = []; const split = (e: ts.Expression): void => { if (ts.isParenthesizedExpression(e)) return split(e.expression)
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) { split(e.left); split(e.right) } else disj.push(e) }
  split(g.expression)
  let room: string | undefined, helper: string | undefined
  for (const d of disj) {
    const m = d.getText(sf).replace(/\s+/g, ' ').match(new RegExp(String.raw`^!\s*\(\s*await (\w+)\(\s*(\w+)\s*,\s*${user}\.id\s*\)\s*\)$`))
    if (m) { helper = m[1]; room = m[2] }
  }
  if (!room || !helper) return false
  // (each name it takes from outside, by what it really refers to in the file (src: outerRefs): the user from `socket.data.user` in the
  // connection, the connection's socket, the server, imported Prisma, the top-level member check, a top-level function or import that
  // plain read and that touches nothing, or JavaScript's own built-ins. Anything else, or a handler plain can't find, means no claim.)
  const refs = o.ev === undefined ? undefined : outerRefs(fileText, o.ev)
  if (!refs || outside.size === 0 && refs.length === 0) return false
  for (const r of refs) {
    const d = r.decl
    if (r.name === user) { if (r.where !== 'between' || !d || !ts.isVariableDeclaration(d) || !/^socket\.data\.user\b/.test(d.initializer?.getText() ?? '')) return false; continue }
    if (r.name === 'socket') { if (r.where !== 'between' || !d || !ts.isParameter(d)) return false; continue }
    if (r.name === 'io') { if (r.where === 'global' || !d || !(ts.isParameter(d) || ts.isVariableDeclaration(d) && /^new\s+\w+\s*\(/.test(d.initializer?.getText() ?? ''))) return false; continue }
    if (r.name === 'prisma') { if (r.where !== 'import') return false; continue }
    if (r.name === helper) { if (r.where !== 'top' || !r.fn) return false; continue }
    if (r.where === 'global') { if (!BUILTIN.test(r.name)) return false; continue }
    if ((r.where === 'top' && r.fn || r.where === 'import') && o.callOk(r.name)) continue
    return false
  }
  // (the member check defined once in the file, its whole body the one lookup it returns)
  if ((fileText.match(new RegExp(String.raw`\bfunction\s+${helper}\b|\b(?:const|let|var)\s+${helper}\b`, 'g')) ?? []).length !== 1 || sc.bound.has(helper) || sc.assigned.has(helper) || fsc.bound.has(helper) || fsc.assigned.has(helper)) return false
  // nothing before the guard does anything (reads of the payload only)
  if (stmts.slice(0, gi).some(st => /prisma|\.emit\s*\(|\.to\s*\(|\.join\s*\(|\.in\s*\(|\bawait\b/.test(st.getText(sf)))) return false
  if (sc.bound.get(room) !== 1 || sc.assigned.has(room)) return false
  // the room is a string (a socket payload is any JSON: `{ not: "" }` would match every room in a Prisma filter): checked in the guard
  // (`typeof roomId !== "string" || ...`) or made one (`const roomId = typeof x === "string" ? x : ""`, `String(...)`)
  const R = room.replace(/\$/g, '\\$')
  if (!disj.some(d => new RegExp(String.raw`^typeof\s+${R}\s*!==?\s*['"]string['"]$`).test(d.getText(sf).trim()))
    && !(() => { const m = handler.match(new RegExp(String.raw`\b(?:const|let)\s+${R}\s*(?::\s*string\s*)?=\s*(?:typeof\s+([\w.?]+)\s*===?\s*['"]string['"]\s*\?\s*([\w.?]+)\s*:\s*['"][^'"]*['"]|(String)\s*\([^()]*\))\s*(?:;|\n)`))
      return !!m && (!!m[3] || m[1].replace(/\?/g, '') === m[2].replace(/\?/g, '')) })()) return false   // (`data?.roomId` ... `data.roomId`)
  // the helper: (room, user) -> whether the room-member row for exactly those exists
  const h = helpers.get(helper)
  if (!h?.fn) return false
  const hp = h.text.match(new RegExp(String.raw`\b${helper}\s*(?:=\s*(?:async\s*)?)?\(\s*(\w+)[^,)]*,\s*(\w+)[^,)]*\)`))
  if (!hp) return false
  const [, hr, hu] = hp, hc = prismaCalls(h.text)
  if (hc.length !== 1 || !/^find(?:First|Unique)$/.test(hc[0].op) || !/^(?:room|channel|chat|group|conversation)?(?:Member|member|Membership|membership)s?$/.test(hc[0].model) || /\btry\b|\bif\b|\|\||\?\?/.test(h.text.slice(h.text.indexOf('{') + 1))) return false
  // (a member model with a way to have left or been banned: a row alone doesn't make someone a member)
  const mf = o.fields(hc[0].model[0].toUpperCase() + hc[0].model.slice(1))
  if (!mf || mf.some(x => /^(?:left|deleted|removed|banned|kicked|revoked|ended)At$|^(?:is)?(?:banned|active|accepted|approved|pending|muted)$|^status$/i.test(x))) return false
  const hr0 = lastReturn(h.text); if (!hr0) return false
  const hsf = ts.createSourceFile('h.tsx', h.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), hfn = hsf.statements[0]
  if (!hfn || !ts.isFunctionDeclaration(hfn) || hfn.body?.statements.length !== 1) return false
  const where = keys(hc[0].top.get('where')), comp = [...where].find(([k]) => /_/.test(k)), w = comp && where.size === 1 ? keys(comp[1]) : where
  const vals = [...w]
  if (vals.length !== 2 || !vals.some(([k, x]) => /^room\w*Id$|^roomId$/.test(k) && x === hr) || !vals.some(([k, x]) => k === 'userId' && x === hu)) return false
  if (!new RegExp(String.raw`\breturn\s+(?:Boolean\s*\(\s*await\b|!!\s*\(?\s*await\b|\(\s*await\b[\s\S]*\)\s*!==?\s*null\b)`).test(h.text)) return false
  // after it: every Prisma call in that room, every room it talks to is that one
  const rest = stmts.slice(gi + 1).map(st => st.getText(sf)).join('\n')
  for (const c of prismaCalls(rest)) {
    const part = keys(c.top.get(c.op === 'create' ? 'data' : 'where'))
    if (!c.top.get(c.op === 'create' ? 'data' : 'where')?.startsWith('{') || part.get('roomId') !== room || [...part.keys()].some(k => LOGIC.test(k) || k === '...')) return false
    if (!/^(?:create|findFirst|findUnique|findMany|count)$/.test(c.op)) return false
    for (const [k, x] of keys(c.top.get('data'))) if (/Ids?$/.test(k) && k !== 'roomId' && x !== `${user}.id` || /^[{[]/.test(x) || k === '...') return false   // (no nested writes)
    // (one level of related rows, and from those only plain fields: `user: { select: { displayName: true } }`, not their `messages`)
    for (const part2 of ['include', 'select']) for (const [, x] of keys(c.top.get(part2))) {
      if (x === 'true') continue
      const inner = keys(x); if ([...inner.keys()].some(k => k !== 'select')) return false
      if (![...keys(inner.get('select'))].every(([k, y]) => y === 'true' && o.scalars.has(k))) return false }
  }
  if ((rest.match(/\bprisma\b/g) ?? []).length !== prismaCalls(rest).length) return false
  for (const m of rest.matchAll(/\.(?:to|in|join)\s*\(\s*([^)]*)\)/g)) if (!new RegExp(String.raw`^\`[^\`$]*\$\{${room}\}[^\`$]*\`$|^${room}$`).test(m[1].trim())) return false
  return true
}

// Where each name a Socket.IO event's handler uses from outside itself really comes from, by the language's own scoping (blocks,
// functions, catch, hoisted var and function declarations, imports): 'import' / 'top' (the file's top level, with whether it's a
// function declaration) / 'between' (a scope between the top level and the handler: the connection callback, a setup function) /
// 'global' (bound nowhere in the file). Undefined when the handler isn't found (`socket.on("<ev>", fn)` with fn written inline).
type Scope = { parent?: Scope; names: Map<string, ts.Node> }
export function outerRefs(fileText: string, ev: string): { name: string; where: 'import' | 'top' | 'between' | 'global'; fn: boolean; decl?: ts.Node }[] | undefined {
  const sf = ts.createSourceFile('x.tsx', fileText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const scopes = new Map<ts.Node, Scope>()
  const makes = (n: ts.Node) => ts.isSourceFile(n) || ts.isBlock(n) || ts.isFunctionLike(n) || ts.isCatchClause(n) || ts.isForStatement(n) || ts.isForInStatement(n)
    || ts.isForOfStatement(n) || ts.isCaseBlock(n) || ts.isClassLike(n) || ts.isModuleBlock(n) || ts.isClassStaticBlockDeclaration(n)
  const scopeOf = (n: ts.Node): Scope => { let x: ts.Node | undefined = n.parent; while (x && !scopes.has(x)) x = x.parent; return scopes.get(x ?? sf)! }
  const fnScope = (n: ts.Node): Scope => { let x: ts.Node | undefined = n.parent; while (x && !(ts.isFunctionLike(x) || ts.isSourceFile(x) || ts.isClassStaticBlockDeclaration(x))) x = x.parent; return scopes.get(x ?? sf)! }
  // pass 1: scopes
  const mk = (n: ts.Node): void => { if (makes(n)) { let x: ts.Node | undefined = n.parent; while (x && !scopes.has(x)) x = x.parent; scopes.set(n, { parent: x ? scopes.get(x) : undefined, names: new Map() }) } n.forEachChild(mk) }
  mk(sf)
  // pass 2: declarations
  const add = (s: Scope, name: ts.BindingName, decl: ts.Node) => { if (ts.isIdentifier(name)) s.names.set(name.text, decl); else for (const e of name.elements) if (!ts.isOmittedExpression(e)) add(s, e.name, decl) }
  const decl = (n: ts.Node): void => {
    // (a catch's variable is the catch's own, below)
    if (ts.isVariableDeclaration(n) && !ts.isCatchClause(n.parent)) { const list = n.parent; const block = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped)   // (let, const, using)
      add(block ? scopeOf(ts.isVariableDeclarationList(list) && (ts.isForStatement(list.parent) || ts.isForInStatement(list.parent) || ts.isForOfStatement(list.parent)) ? list : n) : fnScope(n), n.name, n) }
    if (ts.isParameter(n)) add(scopes.get(n.parent)!, n.name, n)
    if (ts.isFunctionDeclaration(n) && n.name) scopeOf(n).names.set(n.name.text, n)
    if ((ts.isFunctionExpression(n) || ts.isClassExpression(n)) && n.name) scopes.get(n)!.names.set(n.name.text, n)
    if (ts.isClassDeclaration(n) && n.name) scopeOf(n).names.set(n.name.text, n)
    if (ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) scopeOf(n).names.set((n.name as ts.Identifier).text, n)
    if (ts.isCatchClause(n) && n.variableDeclaration) add(scopes.get(n)!, n.variableDeclaration.name, n.variableDeclaration)
    if (ts.isImportClause(n)) { if (n.name) scopes.get(sf)!.names.set(n.name.text, n)
      if (n.namedBindings) { if (ts.isNamespaceImport(n.namedBindings)) scopes.get(sf)!.names.set(n.namedBindings.name.text, n); else for (const e of n.namedBindings.elements) scopes.get(sf)!.names.set(e.name.text, e) } }
    if (ts.isImportEqualsDeclaration(n)) scopes.get(sf)!.names.set(n.name.text, n)
    if (ts.isVariableDeclaration(n) || ts.isCatchClause(n)) { n.forEachChild(decl); return }
    n.forEachChild(decl)
  }
  decl(sf)
  // the handler: `<x>.on("<ev>", fn)` (or a template string without parts). Not when another listener may also take it: a second one, one
  // added another way (addListener, prependListener, onAny), or one whose event name plain can't read (`socket.on(EV, ...)`)
  let handler: ts.Node | undefined, unsure = false
  const find = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) { const m = n.expression.name.text
      if (/^(?:onAny|prependAny|onAnyOutgoing)$/.test(m)) unsure = true
      if (/^(?:on|once|addListener|prependListener|prependOnceListener)$/.test(m)) {
        const a = n.arguments[0], fn = n.arguments.at(-1)
        if (!a || !(ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) { if (n.arguments.length >= 2) unsure = true }
        else if (a.text === ev) { if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && /^(?:on|once)$/.test(m) && !handler) handler = fn; else unsure = true }
      } }
    n.forEachChild(find) }
  find(sf)
  if (!handler || unsure) return undefined
  // (code in its parameters' defaults runs before any guard, and sees outer names its body hides)
  if ((handler as ts.ArrowFunction).parameters.some(prm => prm.initializer)) return undefined
  const inside = (n: ts.Node) => { let x: ts.Node | undefined = n; while (x) { if (x === handler) return true; x = x.parent } return false }
  const out: { name: string; where: 'import' | 'top' | 'between' | 'global'; fn: boolean; decl?: ts.Node }[] = []
  const top = scopes.get(sf)!
  const ref = (n: ts.Node): void => {
    if (ts.isTypeNode(n)) return
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
      && !(ts.isBindingElement(n.parent) && n.parent.propertyName === n) && !ts.isLabeledStatement(n.parent) && !ts.isBreakOrContinueStatement(n.parent)
      && !((ts.isVariableDeclaration(n.parent) || ts.isParameter(n.parent) || ts.isFunctionLike(n.parent) || ts.isClassLike(n.parent) || ts.isBindingElement(n.parent)) && (n.parent as ts.NamedDeclaration).name === n)) {
      let s: Scope | undefined = scopeOf(n), found: ts.Node | undefined, at: Scope | undefined
      while (s) { if (s.names.has(n.text)) { found = s.names.get(n.text); at = s; break } s = s.parent }
      if (!found || !inside(found)) {
        const where = !found ? 'global' : at === top ? (ts.isImportClause(found) || ts.isImportSpecifier(found) || ts.isImportEqualsDeclaration(found) ? 'import' : 'top') : 'between'
        out.push({ name: n.text, where, fn: !!found && ts.isFunctionDeclaration(found), decl: found })
      }
    }
    n.forEachChild(ref)
  }
  ref(handler)
  return out
}
