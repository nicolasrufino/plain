// Session memory: a snapshot of the code before and after every prompt, so a long session can be recapped.
//
//   UserPromptSubmit hook → onPrompt: saves the prompt and a "before" snapshot
//   Stop hook             → onStop:   saves the "after" snapshot
//   plain recap                       the whole session: your app now, each request, what's still open
//   plain recap --refs a,b,c [--asks "p1|p2"]   same, from existing git refs (for testing)
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyze, snapshot, pageName, named, things, list, cap, type Analysis } from './plain.ts'

const ID = { GIT_AUTHOR_NAME: 'plain', GIT_AUTHOR_EMAIL: 'plain@localhost', GIT_COMMITTER_NAME: 'plain', GIT_COMMITTER_EMAIL: 'plain@localhost' }
const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim()

// Commit the working tree, new files included, without touching HEAD, the branch or the staging area.
// ponytail: snapshot commits aren't referenced, so `git gc` may prune them after ~2 weeks; pin them under refs/plain/ if recaps need to last longer
export function snapshotRef(cwd: string): string {
  const env = { ...process.env, ...ID, GIT_INDEX_FILE: join(tmpdir(), `plain-index-${process.pid}-${Date.now()}`) }
  try {
    let head = ''
    try { head = git(['rev-parse', '--verify', 'HEAD'], cwd) } catch { /* no commits yet */ }
    if (head) git(['read-tree', head], cwd, env)
    git(['add', '-A'], cwd, env)
    const tree = git(['write-tree'], cwd, env)
    return git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'plain snapshot'], cwd, env)
  } finally { rmSync(env.GIT_INDEX_FILE, { force: true }) }
}

export type Step = { session: string; prompt: string; before: string; after?: string; at: string }
const logPath = (cwd: string) => resolve(cwd, git(['rev-parse', '--git-dir'], cwd), 'plain-session.jsonl')
const readSteps = (cwd: string): Step[] => existsSync(logPath(cwd))
  ? readFileSync(logPath(cwd), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

export function onPrompt(cwd: string, input: { session_id?: string; prompt?: string }) {
  if (!input.prompt || input.prompt.startsWith('/')) return // slash commands aren't requests
  const step: Step = { session: input.session_id ?? 'default', prompt: input.prompt, before: snapshotRef(cwd), at: new Date().toISOString() }
  appendFileSync(logPath(cwd), JSON.stringify(step) + '\n')
}

export function onStop(cwd: string, input: { session_id?: string }): Step | undefined {
  const steps = readSteps(cwd)
  const step = steps.findLast(s => s.session === (input.session_id ?? 'default') && !s.after)
  if (!step) return
  step.after = snapshotRef(cwd)
  writeFileSync(logPath(cwd), steps.map(s => JSON.stringify(s)).join('\n') + '\n')
  return step
}

// ---------- the recap ----------

const short = (url: string) => url === '/' ? 'home' : named(url.replace(/^\/admin/, '')).join(' ') || 'overview'
const order = (url: string) => url === '/' ? 0 : url.includes('[') ? 1 : /cart/.test(url) ? 8 : /account|wishlist/.test(url) ? 6 : 5

export function recap(cwd: string, steps: { prompt: string; before: string; after: string }[], color = false): string {
  const c = (code: string) => (t: string) => color ? `\x1b[${code}m${t}\x1b[0m` : t
  const bold = c('1'), dim = c('2'), yellow = c('33'), green = c('32'), red = c('31')
  const snaps = new Map<string, ReturnType<typeof snapshot>>()
  const snap = (ref: string) => snaps.get(ref) ?? snaps.set(ref, snapshot(cwd, ref)).get(ref)!
  const total = analyze(snap(steps[0].before), snap(steps.at(-1)!.after), { ref: 'the start of the session' })
  const per = steps.map((s, i) => ({ n: i + 1, prompt: s.prompt, a: analyze(snap(s.before), snap(s.after), { ref: '', asked: s.prompt }) }))
    .filter(x => x.a.files > 0)
  if (!per.length) return 'plain recap · nothing about the app changed in this session.'
  const { A, B } = total
  const route = (p: string) => B.routes.get(p) ?? A.routes.get(p)
  const out: string[] = [`${bold('plain recap')} · ${per.length} request${per.length === 1 ? '' : 's'} · ${total.files} files changed`]

  // --- your app now: pages, money, admin, data, with what's new or changed today
  const status = (p: string) => !A.files.has(p) ? 'new' : total.changes.some(x => x.detail === route(p)?.url) ? 'changed' : ''
  const mark = (p: string, label: string) => status(p) === 'new' ? `${label} ${green('(new)')}` : status(p) === 'changed' ? `${label} ${yellow('(changed)')}` : label
  const pages = [...B.files.keys()].filter(p => route(p)?.kind === 'page')
  const customer = pages.filter(p => !route(p)!.url.startsWith('/admin')).sort((x, y) => order(route(x)!.url) - order(route(y)!.url))
  const admin = pages.filter(p => route(p)!.url.startsWith('/admin')).sort((x, y) => (route(x)!.url === '/admin' ? -1 : route(y)!.url === '/admin' ? 1 : x.localeCompare(y)))
  const money = [...B.files].find(([p, f]) => route(p)?.kind === 'endpoint' && f.money)
  const usesStripe = [...B.files.values()].some(f => f.services.has('Stripe'))
  const flow = [...customer.map(p => mark(p, short(route(p)!.url))), ...(money ? [mark(money[0], 'checkout 💰')] : []), ...(usesStripe ? ['Stripe'] : [])]
  const tables = [...B.models.keys()].map(m => A.models.has(m) ? things(m) : `${things(m)} ${green('(new)')}`)

  out.push('', bold('YOUR APP NOW'))
  const para = [
    `Customers can visit ${list(customer.map(p => mark(p, pageName(route(p)!.url))))}.`,
    money ? `Checkout charges them${usesStripe ? ' through Stripe' : ''}${status(money[0]) === 'changed' ? ', and that code changed in this session' : ''}.` : '',
    admin.length ? `You run the shop from ${admin.length} admin page${admin.length === 1 ? '' : 's'}: ${list(admin.map(p => mark(p, short(route(p)!.url))))}.` : '',
    tables.length ? `Your database keeps ${list(tables)}.` : '',
  ].filter(Boolean).join(' ')
  out.push(...wrap(para, '  ', '  '))
  out.push('', `  ${dim('Customer:')}  ${flow.join(' → ')}`)
  if (admin.length) out.push(`  ${dim('You:')}       Admin → ${admin.map(p => mark(p, short(route(p)!.url))).join(' · ')}`)

  // --- each request, one line
  out.push('', bold('TODAY, IN ORDER'))
  for (const { n, prompt, a } of per) {
    const added = a.changes.filter(x => x.isNew && x.name && x.group !== 'Server').map(x => x.group === 'Database' ? `${x.name} to your database` : x.name!)
    const changed = [...new Set(a.changes.filter(x => !x.isNew && x.name && x.group !== 'Database').map(x => x.money ? `${x.name} 💰` : x.name!))]
    const newServer = a.changes.filter(x => x.isNew && x.group === 'Server').length
    const got = [
      added.length ? `added ${list(added)}` : newServer ? `added ${newServer} piece${newServer === 1 ? '' : 's'} of server code` : '',
      changed.length ? `changed ${list(changed)}` : '',
    ].filter(Boolean).join('; ') || 'small changes'
    const p = prompt.replace(/\s+/g, ' ')
    out.push(`  ${n}. ${dim(`"${p.length > 70 ? p.slice(0, 67) + '...' : p}"`)}`)
    out.push(...wrap(`→ ${cap(got)}.`, '     ', '       '))
  }

  // --- still open: true at the END of the session, credited to the request that caused it
  const from = (text: string) => {
    const ns = per.filter(x => [...x.a.problems.map(p => p.text), ...x.a.unfinished, ...x.a.ship].includes(text)).map(x => x.n)
    return ns.length ? dim(` (request${ns.length > 1 ? 's' : ''} ${list(ns.map(String))})`) : ''
  }
  const asked = per.flatMap(x => x.a.problems.filter(p => p.text.startsWith('You asked')).map(p => ({ ...p, n: x.n })))
  const open = [
    ...total.problems.map(p => `${p.kind === 'Check' ? yellow('!') : red('⚠')} ${p.text}${from(p.text)}`),
    ...asked.map(p => `${yellow('!')} ${p.text}${dim(` (request ${p.n})`)}`),
    ...total.unfinished.map(u => `${yellow('◐')} ${u}${from(u)}`),
    ...total.ship.map(s => `☐ ${s}${from(s)}`),
  ]
  if (open.length) {
    out.push('', bold('STILL OPEN'))
    for (const o of open) out.push(...wrap(o, '  ', '    '))
  }

  // --- three things to remember
  const moneyReqs = per.filter(x => x.a.changes.some(ch => ch.money)).map(x => x.n)
  const schemaReqs = per.filter(x => x.a.schemaChanged).map(x => x.n)
  const decisions = total.problems.filter(p => p.kind === 'Check').length + asked.length
  const authFile = [...B.files].find(([p, f]) => /auth/.test(p) && [...f.env].some(k => /PASSWORD|SECRET/.test(k)))
  const pw = authFile && [...authFile[1].env].find(k => /PASSWORD|SECRET/.test(k))
  const newServices = [...new Set([...B.files.values()].flatMap(f => [...f.services]))].filter(s => ![...A.files.values()].some(f => f.services.has(s)))
  const remember = [
    moneyReqs.length ? `Money goes through checkout, and request${moneyReqs.length > 1 ? 's' : ''} ${list(moneyReqs.map(String))} changed it. Test a real purchase before you ship.` : '',
    schemaReqs.length && total.ship.some(s => s.startsWith('Update your database')) ? `Your database changed in ${schemaReqs.length} request${schemaReqs.length > 1 ? 's' : ''} and hasn't been updated yet. Nothing new will work until you run \`npx prisma migrate dev\`.` : '',
    decisions ? `${decisions} decision${decisions > 1 ? 's are' : ' is'} waiting on you (the ! items above).` : '',
    pw && admin.length ? `The whole admin area is protected by one password (${pw}).` : '',
    newServices.length ? `Your app now depends on ${list(newServices)}.` : '',
    `${total.files} files changed in total.`,
  ].filter(Boolean).slice(0, 3)
  out.push('', bold('3 THINGS TO REMEMBER'))
  remember.forEach((r, i) => out.push(...wrap(r, `  ${i + 1}. `, '     ')))
  return out.join('\n')
}

function wrap(text: string, first: string, rest: string, width = 92) {
  const visible = (s: string) => s.replace(/\x1b\[\d+m/g, '').length
  const lines: string[] = []; let line = first
  for (const w of text.split(' ')) {
    if (line.trim() && visible(line + ' ' + w) > width) { lines.push(line); line = rest + w }
    else line = line.endsWith(' ') || !line.trim() ? line + w : line + ' ' + w
  }
  return [...lines, line]
}

export function recapCli(cwd: string, args: string[], color: boolean): string {
  const i = args.indexOf('--refs')
  if (i >= 0) {
    const refs = args[i + 1].split(',')
    const j = args.indexOf('--asks'), asks = j >= 0 ? args[j + 1].split('|') : []
    return recap(cwd, refs.slice(1).map((r, k) => ({
      before: refs[k], after: r, prompt: asks[k] ?? git(['log', '-1', '--format=%s', r], cwd),
    })), color)
  }
  const steps = readSteps(cwd).filter(s => s.after)
  if (!steps.length) return 'plain recap · no session recorded yet. Install the plain hooks, or use --refs a,b,c.'
  const latest = steps.at(-1)!.session
  return recap(cwd, steps.filter(s => s.session === latest) as Required<Step>[], color)
}
