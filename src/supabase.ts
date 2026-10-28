// Supabase: the database as built by supabase/migrations/*.sql, and who its Row Level Security rules let in.
// SQL is read with libpg-query, the real Postgres parser (WebAssembly), so comments, quoting and function
// bodies can't fool it. Every migration is replayed in order: one change can make an old table unsafe.
type Node = any   // libpg-query's JSON tree

let pg: typeof import('libpg-query') | undefined
try { pg = await import('libpg-query'); await pg.loadModule() } catch { pg = undefined }   // not installed: SQL is skipped

export type Policy = { name: string; cmd: string; roles: string[]; permissive: boolean; qual?: Node; check?: Node }
export type Table = { cols: string[]; refs: Map<string, string>; rls: boolean; policies: Map<string, Policy>; revoked: Set<string> }
export type View = { invoker: boolean; reads: string[] }
export type Db = { tables: Map<string, Table>; views: Map<string, View>; publicBuckets: Set<string>; destructive: Map<string, string[]>
  functions: Set<string>; replaced: Map<string, string[]>
  definers: Map<string, { name: string; checksUser: boolean; writes: boolean; revoked: Set<string> }>; defaultRevoked: Set<string> }   // keyed name(argtypes)   // security definer functions: who's asked, who can still call them   // replaced: migration -> existing database functions it rewrote

export const isMigration = (p: string) => /(^|\/)supabase\/migrations\/[^/]+\.sql$/.test(p)

const name = (rel: Node) => rel?.relname as string | undefined
const schemaOk = (rel: Node) => !rel?.schemaname || rel.schemaname === 'public'
const sval = (n: Node) => n?.String?.sval as string | undefined
const typeName = (t: Node) => sval(t?.TypeName?.names?.at(-1) ?? t?.names?.at(-1)) ?? '?'
// a function that looks at who's calling: auth.uid(), auth.jwt(), the JWT claims, or a helper like is_admin() / has_role()
const CALLER = /auth\.(uid|role|jwt|email)\s*\(|is_admin\s*\(|has_role\s*\(|has_permission\s*\(|current_setting\s*\(\s*'request\.jwt|\bcurrent_user\b/i
const roleNames = (rs: Node[] = []) => rs.map((r: Node) => r.RoleSpec?.rolename ?? (r.RoleSpec?.roletype === 'ROLESPEC_PUBLIC' ? 'public' : '?'))
const relnames = (n: Node): string[] => [...JSON.stringify(n ?? null).matchAll(/"RangeVar":\{(?:"schemaname":"public",)?"relname":"([^"]+)"/g)].map(m => m[1])
const invoker = (opts: Node[] = []) => opts.some((o: Node) => o.DefElem?.defname === 'security_invoker' && /^(on|true|1)$/i.test(sval(o.DefElem.arg) ?? String(o.DefElem.arg?.Integer?.ival ?? '')))

export function readDb(files: [string, string][]): Db {
  const db: Db = { tables: new Map(), views: new Map(), publicBuckets: new Set(), destructive: new Map(), functions: new Set(), replaced: new Map(), definers: new Map(), defaultRevoked: new Set() }
  if (!pg) return db
  for (const [path, sql] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    let stmts: Node[]
    try { stmts = pg.parseSync(sql).stmts ?? [] } catch { continue }   // a file Postgres can't parse: report nothing about it
    const bad: string[] = []
    for (const { stmt } of stmts) {
      const [kind, s] = Object.entries(stmt as Node)[0] as [string, Node]
      // `create table if not exists` for a table that's already there changes nothing (and mustn't reset its rules)
      if (kind === 'CreateStmt' && schemaOk(s.relation) && !(s.if_not_exists && db.tables.has(name(s.relation)!))) {
        const t: Table = { cols: [], refs: new Map(), rls: false, policies: new Map(), revoked: new Set() }
        for (const e of s.tableElts ?? []) {
          if (e.ColumnDef) {
            t.cols.push(e.ColumnDef.colname)
            const fk = (e.ColumnDef.constraints ?? []).find((c: Node) => c.Constraint?.contype === 'CONSTR_FOREIGN')?.Constraint
            if (fk) t.refs.set(e.ColumnDef.colname, name(fk.pktable)!)
          }
          if (e.Constraint?.contype === 'CONSTR_FOREIGN') for (const a of e.Constraint.fk_attrs ?? []) t.refs.set(sval(a)!, name(e.Constraint.pktable)!)   // foreign key (a) references ...
        }
        db.tables.set(name(s.relation)!, t)
      }
      // create or replace function on one that already exists: a rule the app relies on was rewritten
      if (kind === 'CreateFunctionStmt') {
        const names = (s.funcname ?? []).map(sval), fn = names.at(-1) as string | undefined
        const key = `${fn}(${(s.parameters ?? []).filter((q: Node) => !/OUT|TABLE/.test(q.FunctionParameter?.mode ?? '')).map((q: Node) => typeName(q.FunctionParameter?.argType)).join(',')})`
        if (fn && s.replace && db.functions.has(fn)) db.replaced.set(path, [...(db.replaced.get(path) ?? []), fn])
        if (fn) db.functions.add(fn)
        // security definer skips every access rule. Only public-schema functions are reachable from the API; trigger functions aren't callable.
        const opt = (k: string) => (s.options ?? []).find((o: Node) => o.DefElem?.defname === k)?.DefElem?.arg
        const body = (opt('as')?.List?.items ?? []).map(sval).join('\n')
        const definer = !!opt('security')?.Boolean?.boolval && (names.length < 2 || names[0] === 'public') && !/"sval":"trigger"/.test(JSON.stringify(s.returnType ?? ''))
        if (fn && definer) db.definers.set(key, { name: fn, checksUser: CALLER.test(body), writes: /\b(insert\s+into|update\s+[\w."]+\s+set|delete\s+from)\b/i.test(body),
          revoked: new Set(db.definers.get(key)?.revoked ?? db.defaultRevoked) })
        else db.definers.delete(key)   // recreated as security invoker
      }
      // revoke execute on function f(uuid) from anon, authenticated (revoking from public isn't enough: Supabase grants anon and authenticated directly)
      const definersFor = (o: Node) => { const n = sval(o.ObjectWithArgs?.objname?.at(-1)), args = o.ObjectWithArgs?.objargs
        return [...db.definers].filter(([k, d]) => d.name === n && (!args || k === `${n}(${args.map(typeName).join(',')})`)).map(([, d]) => d) }
      if (kind === 'GrantStmt' && s.objtype === 'OBJECT_FUNCTION') {
        const ds = s.targtype === 'ACL_TARGET_ALL_IN_SCHEMA' ? [...db.definers.values()] : (s.objects ?? []).flatMap(definersFor)   // on all functions in schema public
        for (const d of ds) for (const r of roleNames(s.grantees)) s.is_grant ? d.revoked.delete(r) : d.revoked.add(r)
      }
      // alter default privileges ... revoke execute on functions from anon: applies to functions made after it
      if (kind === 'AlterDefaultPrivilegesStmt' && s.action?.objtype === 'OBJECT_FUNCTION')
        for (const r of roleNames(s.action.grantees)) s.action.is_grant ? db.defaultRevoked.delete(r) : db.defaultRevoked.add(r)
      if (kind === 'AlterFunctionStmt' && (s.actions ?? []).some((a: Node) => a.DefElem?.defname === 'security' && !a.DefElem.arg?.Boolean?.boolval))
        for (const d of definersFor({ ObjectWithArgs: s.func })) db.definers.forEach((v, k) => v === d && db.definers.delete(k))
      if (kind === 'ViewStmt' && schemaOk(s.view)) db.views.set(name(s.view)!, { invoker: invoker(s.options), reads: relnames(s.query) })
      if (kind === 'RenameStmt' && schemaOk(s.relation)) {
        const t = db.tables.get(name(s.relation)!)
        if (s.renameType === 'OBJECT_TABLE' && t) { db.tables.delete(name(s.relation)!); db.tables.set(s.newname, t) }
        if (s.renameType === 'OBJECT_COLUMN' && t) t.cols = t.cols.map(c => c === s.subname ? s.newname : c)
        const v = db.views.get(name(s.relation)!)
        if (s.renameType === 'OBJECT_VIEW' && v) { db.views.delete(name(s.relation)!); db.views.set(s.newname, v) }
      }
      // revoke ... from anon, authenticated: the API can't reach the table at all, whatever its rules say
      if (kind === 'GrantStmt' && s.objtype === 'OBJECT_TABLE') for (const o of s.objects ?? []) {
        const t = o.RangeVar && schemaOk(o.RangeVar) && db.tables.get(name(o.RangeVar)!)
        if (t) for (const r of roleNames(s.grantees)) s.is_grant ? t.revoked.delete(r) : t.revoked.add(r)
      }
      if (kind === 'AlterTableStmt' && schemaOk(s.relation)) {
        const t = db.tables.get(name(s.relation)!), v = db.views.get(name(s.relation)!)
        for (const { AlterTableCmd: c } of s.cmds ?? []) {
          if (v && c?.subtype === 'AT_SetRelOptions') v.invoker = invoker(c.def?.List?.items)
          if (!t || !c) continue
          if (c.subtype === 'AT_EnableRowSecurity') t.rls = true
          if (c.subtype === 'AT_DisableRowSecurity') t.rls = false
          if (c.subtype === 'AT_AddColumn' && c.def?.ColumnDef) t.cols.push(c.def.ColumnDef.colname)
          if (c.subtype === 'AT_DropColumn') { t.cols = t.cols.filter(x => x !== c.name); bad.push(`deletes the ${c.name} column of ${name(s.relation)}`) }
          if (c.subtype === 'AT_AlterColumnType') bad.push(`changes what the ${c.name} column of ${name(s.relation)} holds`)
        }
      }
      if (kind === 'CreatePolicyStmt' && schemaOk(s.table)) db.tables.get(name(s.table)!)?.policies.set(s.policy_name, {
        name: s.policy_name, cmd: s.cmd_name ?? 'all', roles: roleNames(s.roles), permissive: !!s.permissive, qual: s.qual, check: s.with_check,
      })
      if (kind === 'AlterPolicyStmt') {
        const p = db.tables.get(name(s.table)!)?.policies.get(s.policy_name)
        if (p) { if (s.qual) p.qual = s.qual; if (s.with_check) p.check = s.with_check; if (s.roles) p.roles = roleNames(s.roles) }
      }
      if (kind === 'DropStmt') for (const o of s.objects ?? []) {
        const parts = (o.List?.items ?? []).map(sval).filter(Boolean) as string[]
        if (s.removeType === 'OBJECT_TABLE' && parts.length && (parts.length === 1 || parts[0] === 'public')) {
          db.tables.delete(parts.at(-1)!); bad.push(`deletes the ${parts.at(-1)} table`)
        }
        if (s.removeType === 'OBJECT_POLICY') db.tables.get(parts.at(-2)!)?.policies.delete(parts.at(-1)!)   // drop policy "x" on t
        if (s.removeType === 'OBJECT_VIEW') db.views.delete(parts.at(-1)!)
        if (s.removeType === 'OBJECT_FUNCTION') { const n = sval(o.ObjectWithArgs?.objname?.at(-1)); db.definers.forEach((v, k) => v.name === n && db.definers.delete(k)) }
      }
      if (kind === 'TruncateStmt') bad.push(`empties ${(s.relations ?? []).map((r: Node) => name(r.RangeVar)).join(', ')}`)
      if (kind === 'DeleteStmt' && !s.whereClause) bad.push(`deletes every row of ${name(s.relation)}`)
      // insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
      const bucket = (rel: Node) => rel?.schemaname === 'storage' && name(rel) === 'buckets'
      if (kind === 'InsertStmt' && bucket(s.relation)) {
        const cols = (s.cols ?? []).map((c: Node) => c.ResTarget?.name)
        for (const row of s.selectStmt?.SelectStmt?.valuesLists ?? []) {
          const vals = row.List?.items ?? [], at = (c: string) => vals[cols.indexOf(c)]?.A_Const
          // without a column list, any `true` in the row can only be the public flag
          const pub = cols.length ? at('public')?.boolval?.boolval : vals.some((v: Node) => v.A_Const?.boolval?.boolval)
          if (pub) db.publicBuckets.add(at('name')?.sval?.sval ?? at('id')?.sval?.sval ?? vals[0]?.A_Const?.sval?.sval ?? '?')
        }
      }
      // update storage.buckets set public = true where id = 'avatars'
      if (kind === 'UpdateStmt' && bucket(s.relation) && (s.targetList ?? []).some((t: Node) => t.ResTarget?.name === 'public' && t.ResTarget.val?.A_Const?.boolval?.boolval))
        db.publicBuckets.add(JSON.stringify(s.whereClause ?? null).match(/"sval":\{"sval":"([^"]+)"/)?.[1] ?? '?')
    }
    if (bad.length) db.destructive.set(path, bad)
  }
  return db
}

// ---------- who gets in ----------
// A rule's condition is read as a tree, top level only (AND / OR): a check buried in a subquery,
// like `exists (select 1 from profiles where id = auth.uid() and role = 'admin')`, is neither "own rows"
// nor "open"; it's treated as a real restriction, so it never raises an alarm.

const text = (n: Node) => JSON.stringify(n ?? null)
const fn = (n: Node, name: string) => n?.FuncCall?.funcname?.map(sval).join('.') === name
const uid = (n: Node) => fn(n, 'auth.uid') || fn(n?.SubLink?.subselect?.SelectStmt?.targetList?.[0]?.ResTarget?.val, 'auth.uid')   // auth.uid(), (select auth.uid())
const eq = (n: Node) => n?.A_Expr?.kind === 'AEXPR_OP' && sval(n.A_Expr.name?.[0]) === '=' ? [n.A_Expr.lexpr, n.A_Expr.rexpr] : undefined
const parts = (n: Node, op: string): Node[] => n?.BoolExpr?.boolop === op ? n.BoolExpr.args.flatMap((a: Node) => parts(a, op)) : [n]
// ponytail: top-level AND/OR only; a rule that hides its logic in a helper function is trusted
const anyTop = (n: Node, test: (x: Node) => boolean): boolean => parts(n, 'AND_EXPR').some(a => parts(a, 'OR_EXPR').some(test))
const bare = (n: Node) => JSON.stringify(n ?? null).replace(/,?"location":-?\d+/g, '')
const isTrue = (n: Node): boolean => n?.A_Const?.boolval?.boolval === true
  || !!eq(n) && !!eq(n)![0]?.A_Const && bare(eq(n)![0]) === bare(eq(n)![1])                    // 1 = 1
  || parts(n, 'OR_EXPR').length > 1 && parts(n, 'OR_EXPR').some(isTrue)
const own = (n: Node) => !!n && anyTop(n, x => { const e = eq(x); return !!e && (uid(e[0]) && !!e[1]?.ColumnRef || uid(e[1]) && !!e[0]?.ColumnRef) })   // auth.uid() = user_id
const loggedIn = (n: Node) => !!n && !own(n) && anyTop(n, x =>
  x?.NullTest?.nulltesttype === 'IS_NOT_NULL' && uid(x.NullTest.arg)                                                       // auth.uid() is not null
  || !!eq(x) && /"sval":"authenticated"/.test(text(x)) && /"sval":"auth"\}\},\{"String":\{"sval":"(role|jwt)"/.test(text(x)))   // auth.role() / auth.jwt()->>'role' = 'authenticated'
const open = (n: Node) => isTrue(n) || loggedIn(n)
const metadata = (n: Node) => /user_metadata|raw_user_meta_data/.test(text(n))
const ADMIN_ROLES = /^(service_role|postgres|supabase_admin|supabase_auth_admin|supabase_storage_admin)$/
// ponytail: name-based guess at what's private, like plain.ts SENSITIVE; a config file can override it later
const PRIVATE_TABLE = /user|profile|account|order|payment|invoice|subscription|message|booking|address|customer|admin|coupon|refund|setting/i
const PRIVATE_COL = /email|phone|address|password|token|secret|stripe|birth|ssn/i
const MONEY_COL = /^(status|paid|is_paid|payment_status|role|is_admin|admin|credits|balance|plan|tier|verified|is_verified|approved)$/

// Every rule that lets people read the table limits them to their own rows: worth saying out loud.
export function ownOnly(db: Db, t: string): boolean {
  const tb = db.tables.get(t), reads = [...tb?.policies.values() ?? []].filter(p => p.permissive && (p.cmd === 'select' || p.cmd === 'all') && !p.roles.every(r => ADMIN_ROLES.test(r)))
  // strict: one AND part where every OR choice is "your own row" (auth.uid() = user_id OR is_public isn't)
  const admin = (x: Node) => /is_admin|has_role|"sval":"admin"/.test(text(x))   // ... OR is_admin(): admins may see everything
  const strictOwn = (n: Node) => parts(n, 'AND_EXPR').some(a => parts(a, 'OR_EXPR').every(x => own(x) || admin(x)) && parts(a, 'OR_EXPR').some(x => own(x)))
  return !!tb?.rls && reads.length > 0 && reads.every(p => strictOwn(p.qual))
}

export type Finding = { kind: 'Unsafe' | 'Check'; text: string }
const list_ = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`

// What the rules allow, in plain words. `things` names a table for people ("orders", "order items").
export function findings(db: Db, used: Set<string>, things: (t: string) => string): Finding[] {
  const out: Finding[] = []
  const isPriv = (t: string) => PRIVATE_TABLE.test(t) || !!db.tables.get(t)?.cols.some(c => PRIVATE_COL.test(c))
  for (const [t, tb] of db.tables) {
    const n = things(t), priv = isPriv(t), reachable = ['anon', 'authenticated'].filter(r => !tb.revoked.has(r) && !tb.revoked.has('public'))
    if (!reachable.length) continue   // the API can't reach it
    if (!tb.rls) {
      out.push({ kind: 'Unsafe', text: `${reachable.includes('anon') ? 'Anyone' : 'Every logged-in user'} can read and change every row of ${n}: the table has no access rules (Row Level Security is off).` })
      continue
    }
    const policies = [...tb.policies.values()].filter(p => !p.roles.every(r => ADMIN_ROLES.test(r)))   // service_role skips the rules anyway
    if (!policies.some(p => p.permissive)) {
      if (used.has(t)) out.push({ kind: 'Check', text: `Your app uses ${n}, but no access rule lets anyone in, so it can't read or save them.` })
      continue
    }
    // A restrictive rule limiting a command to the user's own rows wins over any open permissive one.
    const limited = (cmd: string) => policies.some(p => !p.permissive && (p.cmd === cmd || p.cmd === 'all') && (own(p.qual) || own(p.check)))
    for (const p of policies.filter(p => p.permissive)) {
      const anyone = p.roles.some(r => r === 'public' || r === 'anon')
      const who = (x: Node) => anyone && !loggedIn(x) ? 'Anyone, even without logging in,' : 'Every logged-in user'
      const does = (cmd: string) => p.cmd === cmd || p.cmd === 'all'
      // which condition decides: select/delete use USING; insert uses WITH CHECK; update uses USING to pick the rows
      if (does('select') && open(p.qual) && !limited('select')) out.push(priv
        ? { kind: 'Unsafe', text: `${who(p.qual)} can read every one of your ${n}, including other people's (rule "${p.name}").` }
        : { kind: 'Check', text: `${who(p.qual)} can read all ${n} (rule "${p.name}"). That's fine for public things like a catalog, not for private ones.` })
      const insertCheck = p.check ?? (p.cmd === 'all' ? p.qual : undefined)
      if (does('insert') && open(insertCheck) && !limited('insert')) {
        const owned = [...tb.refs.values()].some(r => r === 'users' || r === 'profiles')
        out.push(owned
          ? { kind: 'Unsafe', text: `${who(insertCheck)} can add ${n} in someone else's name (rule "${p.name}").` }
          : { kind: 'Check', text: `${who(insertCheck)} can add ${n}, and nothing limits spam or fake ones (rule "${p.name}"). That's normal for things like a contact form, but make sure it's what you want.` })
      }
      const change = does('update') && open(p.qual) && !limited('update'), del = does('delete') && open(p.qual) && !limited('delete')
      if (change || del) out.push({ kind: 'Unsafe', text: `${who(p.qual)} can ${change && del ? 'change and delete' : change ? 'change' : 'delete'} every one of your ${n}, including other people's (rule "${p.name}").` })
      if (does('update') && own(p.qual) && isTrue(p.check))
        out.push({ kind: 'Check', text: `People can edit their own ${n} and hand them over to someone else: rule "${p.name}" doesn't check who owns the result.` })
      if (metadata(p.qual) || metadata(p.check))
        out.push({ kind: 'Unsafe', text: `The rule "${p.name}" on ${n} trusts user_metadata, which every user can edit for themselves.` })
      // Own rows, but a column the user shouldn't set: CVE-2025-48757 marked orders paid this way.
      const ownWrite = p.cmd !== 'select' && p.cmd !== 'delete' && own(p.check ?? p.qual)
      const col = ownWrite && tb.cols.find(c => MONEY_COL.test(c) && !text(p.check).includes(`"${c}"`))
      if (col) out.push({ kind: 'Check', text: `People can ${p.cmd === 'insert' ? 'add' : 'edit'} their own ${n}, including the ${col} column (rule "${p.name}"). If ${col} should only change after a payment or by an admin, users shouldn't be able to set it themselves.` })
    }
  }
  // Views run with their creator's rights unless made with security_invoker, so they skip the tables' rules.
  for (const [v, view] of db.views) if (!view.invoker) {
    const priv = view.reads.filter(isPriv)
    out.push(priv.length
      ? { kind: 'Unsafe', text: `The view ${v} shows ${list_(priv.map(things))} to anyone, skipping their access rules. Create it with security_invoker = on.` }
      : { kind: 'Check', text: `The view ${v} skips the access rules of the tables it reads (${list_(view.reads.map(things)) || 'its tables'}). Create it with security_invoker = on unless that's on purpose.` })
  }
  for (const { name: fn, ...d } of db.definers.values()) if (!d.checksUser && !(d.revoked.has('anon') && d.revoked.has('authenticated')))
    out.push(d.writes
      ? { kind: 'Unsafe', text: `Anyone with your app's public key can run the database function ${fn}, which changes data. It skips your access rules (security definer) and never checks who's calling. Revoke it from anon and authenticated, or check auth.uid() inside.` }
      : { kind: 'Check', text: `Anyone with your app's public key can run the database function ${fn}. It only reads, but it skips your access rules (security definer) and doesn't check who's calling, so it can reveal data about other people.` })
  for (const b of db.publicBuckets) out.push({ kind: 'Check', text: `Files in the "${b}" storage bucket can be opened by anyone who has the link.` })
  return out
}
