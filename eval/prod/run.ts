// Production pilot: for each cloned repo, pick 3 real commits that change server code, and write plain's card for each.
// Usage: clone each repo in repos.txt to repos/<owner>_<name> (git clone --depth 300), then
//   node run.ts   -> picks commits (picks.json, kept if present) and writes cards/<repo>__<sha>.txt + diffs/<repo>__<sha>.diff
import { report, snapshot, type Snap } from '../../src/plain.ts'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const P = import.meta.dirname   // repos/, cards/, diffs/ and grades/ live next to this file
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 })
const SERVER = /(^|\/)(api|app\/api|pages\/api|routes?|controllers?|server|actions?|views\.py|views|serializers\.py|models?|migrations?|middleware|policies|handlers?|services?)(\/|\.|$)|route\.[jt]s$|schema\.prisma$|\+server\.[jt]s$|\+page\.server\.[jt]s$|urls\.py$|routes\.rb$|web\.php$|api\.php$/

// all files of a commit, the way plain reads them (binary and very large files stand in as their git object id)
const snap = (cwd: string, ref: string): Snap => snapshot(cwd, ref)

const OUT = process.argv[2] ?? 'cards'
const repos = readFileSync(`${P}/repos.txt`, 'utf8').trim().split('\n').map(l => { const [stack, name] = l.split(' '); return { stack, name, dir: `${P}/repos/${name.replace('/', '_')}` } })
mkdirSync(`${P}/${OUT}`, { recursive: true }); mkdirSync(`${P}/diffs`, { recursive: true })
const picks: { repo: string; stack: string; sha: string; subject: string; lines: number; files: number }[] = existsSync(`${P}/picks.json`) ? JSON.parse(readFileSync(`${P}/picks.json`, 'utf8')) : []
for (const r of repos) {
  if (!picks.some(p => p.repo === r.name)) {
    // non-merge commits that touch server code, 2-40 files, under 600 changed lines; the newest, then every 10th further back
    const log = git(r.dir, ['log', '--no-merges', '--format=@%H %s', '--numstat', 'HEAD~1']).split('\n@').map(b => b.replace(/^@/, ''))
    const ok = log.map(b => { const [h, ...rest] = b.split('\n'); const sha = h.slice(0, 40), subject = h.slice(41)
      const st = rest.filter(Boolean).map(x => x.split('\t')); const lines = st.reduce((a, x) => a + (+x[0] || 0) + (+x[1] || 0), 0)
      return { sha, subject, lines, files: st.length, server: st.some(x => SERVER.test(x[2] ?? '')) } })
      .filter(c => c.server && c.files >= 2 && c.files <= 40 && c.lines >= 10 && c.lines <= 600 && !/^(chore\(deps\)|bump|build\(deps\)|merge|revert|release|v?\d+\.\d+)/i.test(c.subject))
    const chosen = [ok[0], ok[10], ok[20]].filter(Boolean)
    for (const c of chosen) picks.push({ repo: r.name, stack: r.stack, sha: c.sha, subject: c.subject, lines: c.lines, files: c.files })
    writeFileSync(`${P}/picks.json`, JSON.stringify(picks, null, 1))
  }
  for (const p of picks.filter(p => p.repo === r.name)) {
    const id = `${r.name.replace('/', '_')}__${p.sha.slice(0, 8)}`
    if (existsSync(`${P}/${OUT}/${id}.txt`)) continue
    const t = Date.now()
    let card: string
    try { card = report(snap(r.dir, `${p.sha}~1`), snap(r.dir, p.sha), { ref: `${p.sha.slice(0, 8)}~1`, asked: p.subject }) } catch (e) { card = `PLAIN CRASHED: ${(e as Error).stack}` }
    writeFileSync(`${P}/${OUT}/${id}.txt`, card)
    writeFileSync(`${P}/diffs/${id}.diff`, git(r.dir, ['show', '--format=%H%n%an%n%s%n%n%b', '--stat', '-p', p.sha]))
    console.log(`${id}  ${((Date.now() - t) / 1000).toFixed(1)}s  ${p.subject.slice(0, 60)}`)
  }
}
