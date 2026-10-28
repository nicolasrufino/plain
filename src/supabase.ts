// Supabase: the database as built by supabase/migrations/*.sql, and who its Row Level Security rules let in.
// SQL is read with libpg-query, the real Postgres parser (WebAssembly), so comments, quoting and function
// bodies can't fool it. Every migration is replayed in order: one change can make an old table unsafe.
type Node = any   // libpg-query's JSON tree

let pg: typeof import('libpg-query') | undefined
try { pg = await import('libpg-query'); await pg.loadModule() } catch { pg = undefined }   // not installed: SQL is skipped

export type Policy = { name: string; cmd: string; roles: string[]; qual?: Node; check?: Node }
export type Table = { cols: string[]; refs: Map<string, string>; rls: boolean; policies: Map<string, Policy> }
export type Db = { tables: Map<string, Table>; publicBuckets: Set<string>; destructive: Map<string, string[]> }

export const isMigration = (p: string) => /(^|\/)supabase\/migrations\/[^/]+\.sql$/.test(p)

const name = (rel: Node) => rel?.relname as string | undefined
const schemaOk = (rel: Node) => !rel?.schemaname || rel.schemaname === 'public'
const sval = (n: Node) => n?.String?.sval as string | undefined

export function readDb(files: [string, string][]): Db {
  const db: Db = { tables: new Map(), publicBuckets: new Set(), destructive: new Map() }
  if (!pg) return db
  for (const [path, sql] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    let stmts: Node[]
    try { stmts = pg.parseSync(sql).stmts ?? [] } catch { continue }   // a file Postgres can't parse: report nothing about it
    const bad: string[] = []
    for (const { stmt } of stmts) {
      const [kind, s] = Object.entries(stmt as Node)[0] as [string, Node]
      if (kind === 'CreateStmt' && schemaOk(s.relation)) {
        const t: Table = { cols: [], refs: new Map(), rls: false, policies: new Map() }
        for (const e of s.tableElts ?? []) if (e.ColumnDef) {
          t.cols.push(e.ColumnDef.colname)
          const fk = (e.ColumnDef.constraints ?? []).find((c: Node) => c.Constraint?.contype === 'CONSTR_FOREIGN')?.Constraint
          if (fk) t.refs.set(e.ColumnDef.colname, name(fk.pktable)!)
        }
        db.tables.set(name(s.relation)!, t)
      }
      if (kind === 'AlterTableStmt' && schemaOk(s.relation)) {
        const t = db.tables.get(name(s.relation)!)
        for (const { AlterTableCmd: c } of s.cmds ?? []) {
          if (!t || !c) continue
          if (c.subtype === 'AT_EnableRowSecurity') t.rls = true
          if (c.subtype === 'AT_DisableRowSecurity') t.rls = false
          if (c.subtype === 'AT_AddColumn' && c.def?.ColumnDef) t.cols.push(c.def.ColumnDef.colname)
          if (c.subtype === 'AT_DropColumn') { t.cols = t.cols.filter(x => x !== c.name); bad.push(`deletes the ${c.name} column of ${name(s.relation)}`) }
          if (c.subtype === 'AT_AlterColumnType') bad.push(`changes what the ${c.name} column of ${name(s.relation)} holds`)
        }
      }
      if (kind === 'CreatePolicyStmt' && schemaOk(s.table)) db.tables.get(name(s.table)!)?.policies.set(s.policy_name, {
        name: s.policy_name, cmd: s.cmd_name ?? 'all',
        roles: (s.roles ?? []).map((r: Node) => r.RoleSpec?.rolename ?? (r.RoleSpec?.roletype === 'ROLESPEC_PUBLIC' ? 'public' : '?')),
        qual: s.qual, check: s.with_check,
      })
      if (kind === 'AlterPolicyStmt') {
        const p = db.tables.get(name(s.table)!)?.policies.get(s.policy_name)
        if (p) { if (s.qual) p.qual = s.qual; if (s.with_check) p.check = s.with_check; if (s.roles) p.roles = s.roles.map((r: Node) => r.RoleSpec?.rolename ?? 'public') }
      }
      if (kind === 'DropStmt') for (const o of s.objects ?? []) {
        const parts = (o.List?.items ?? []).map(sval).filter(Boolean) as string[]
        if (s.removeType === 'OBJECT_TABLE' && parts.length && (parts.length === 1 || parts[0] === 'public')) {
          db.tables.delete(parts.at(-1)!); bad.push(`deletes the ${parts.at(-1)} table`)
        }
        if (s.removeType === 'OBJECT_POLICY') db.tables.get(parts.at(-2)!)?.policies.delete(parts.at(-1)!)   // drop policy "x" on t
      }
      if (kind === 'TruncateStmt') bad.push(`empties ${(s.relations ?? []).map((r: Node) => name(r.RangeVar)).join(', ')}`)
      if (kind === 'DeleteStmt' && !s.whereClause) bad.push(`deletes every row of ${name(s.relation)}`)
      // insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
      if (kind === 'InsertStmt' && s.relation?.schemaname === 'storage' && name(s.relation) === 'buckets') {
        const cols = (s.cols ?? []).map((c: Node) => c.ResTarget?.name)
        for (const row of s.selectStmt?.SelectStmt?.valuesLists ?? []) {
          const vals = row.List?.items ?? [], at = (c: string) => vals[cols.indexOf(c)]?.A_Const
          if (at('public')?.boolval?.boolval) db.publicBuckets.add(at('name')?.sval?.sval ?? at('id')?.sval?.sval ?? '?')
        }
      }
    }
    if (bad.length) db.destructive.set(path, bad)
  }
  return db
}

// ---------- who gets in ----------

const text = (n: Node) => JSON.stringify(n ?? null)
const isTrue = (n: Node) => n?.A_Const?.boolval?.boolval === true
const ownRows = (n: Node) => /"sval":"uid"/.test(text(n))                        // auth.uid() = user_id
const onlyLoggedIn = (n: Node) => !ownRows(n) && /"sval":"role"/.test(text(n)) && /authenticated/.test(text(n))   // auth.role() = 'authenticated'
const metadata = (n: Node) => /user_metadata|raw_user_meta_data/.test(text(n))
// ponytail: name-based guess at what's private, like plain.ts SENSITIVE; a config file can override it later
const PRIVATE_TABLE = /user|profile|account|order|payment|invoice|subscription|message|booking|address|customer|admin|coupon|refund|setting/i
const PRIVATE_COL = /email|phone|address|password|token|secret|stripe|birth|ssn/i
const MONEY_COL = /^(status|paid|is_paid|payment_status|role|is_admin|admin|credits|balance|plan|tier|verified|is_verified|approved)$/

export type Finding = { kind: 'Unsafe' | 'Check'; text: string }

// What the rules allow, in plain words. `things` names a table for people ("orders", "order items").
export function findings(db: Db, used: Set<string>, things: (t: string) => string): Finding[] {
  const out: Finding[] = []
  for (const [t, tb] of db.tables) {
    const n = things(t), priv = PRIVATE_TABLE.test(t) || tb.cols.some(c => PRIVATE_COL.test(c))
    if (!tb.rls) { out.push({ kind: 'Unsafe', text: `Anyone can read and change every row of ${n}: the table has no access rules (Row Level Security is off).` }); continue }
    if (!tb.policies.size) {
      if (used.has(t)) out.push({ kind: 'Check', text: `Your app uses ${n}, but no access rule lets anyone in, so it can't read or save them.` })
      continue
    }
    for (const p of tb.policies.values()) {
      const anyone = p.roles.some(r => r === 'public' || r === 'anon')
      const loggedInOnly = onlyLoggedIn(p.qual) || onlyLoggedIn(p.check)
      const who = anyone && !loggedInOnly ? 'Anyone, even without logging in,' : 'Every logged-in user'
      const reads = p.cmd === 'select' || p.cmd === 'all', writes = p.cmd !== 'select'
      const openRead = reads && (isTrue(p.qual) || onlyLoggedIn(p.qual))
      const openWrite = writes && (isTrue(p.check) || isTrue(p.qual) || onlyLoggedIn(p.check ?? p.qual))
      if (openRead) out.push(priv
        ? { kind: 'Unsafe', text: `${who} can read every one of your ${n}, including other people's (rule "${p.name}").` }
        : { kind: 'Check', text: `${who} can read all ${n} (rule "${p.name}"). That's fine for public things like a catalog, not for private ones.` })
      const owned = [...tb.refs.values()].some(r => r === 'users' || r === 'profiles')
      if (openWrite && p.cmd === 'insert') out.push(owned
        ? { kind: 'Unsafe', text: `${who} can add ${n} in someone else's name (rule "${p.name}").` }
        : { kind: 'Check', text: `${who} can add ${n}, and nothing limits spam or fake ones (rule "${p.name}"). That's normal for things like a contact form, but make sure it's what you want.` })
      else if (openWrite) out.push({ kind: 'Unsafe', text: `${who} can ${p.cmd === 'delete' ? 'delete' : p.cmd === 'update' ? 'change' : 'change and delete'} every one of your ${n}, including other people's (rule "${p.name}").` })
      if (metadata(p.qual) || metadata(p.check))
        out.push({ kind: 'Unsafe', text: `The rule "${p.name}" on ${n} trusts user_metadata, which every user can edit for themselves.` })
      // Own rows, but a column the user shouldn't set: CVE-2025-48757 marked orders paid this way.
      const col = writes && !openWrite && ownRows(p.check ?? p.qual) && tb.cols.find(c => MONEY_COL.test(c) && !text(p.check).includes(`"${c}"`))
      if (col) out.push({ kind: 'Check', text: `People can ${p.cmd === 'insert' ? 'add' : 'edit'} their own ${n}, including the ${col} column (rule "${p.name}"). If ${col} should only change after a payment or by an admin, users shouldn't be able to set it themselves.` })
    }
  }
  for (const b of db.publicBuckets) out.push({ kind: 'Check', text: `Files in the "${b}" storage bucket can be opened by anyone who has the link.` })
  return out
}
