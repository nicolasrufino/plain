// Roll grades/*.json up into the numbers: per stack and overall.
import { readFileSync, readdirSync } from 'node:fs'
const P = import.meta.dirname
type St = { text: string; kind: string; verdict: string; why: string }
type G = { id: string; summary: string; statements: St[]; misses: { what: string; severity: string }[]; silent: boolean }
const picks: { repo: string; stack: string; sha: string }[] = JSON.parse(readFileSync(`${P}/picks.json`, 'utf8'))
const stackOf = (id: string) => picks.find(p => id.startsWith(p.repo.replace('/', '_')) && id.endsWith(p.sha.slice(0, 8)))?.stack ?? '?'
const grades: (G & { stack: string; crashed: boolean })[] = readdirSync(`${P}/${process.env.GRADES ?? "grades"}`).filter(f => f.endsWith('.json')).map(f => {
  const g = JSON.parse(readFileSync(`${P}/${process.env.GRADES ?? "grades"}/${f}`, 'utf8')) as G
  return { ...g, stack: stackOf(g.id), crashed: readFileSync(`${P}/${process.env.CARDS ?? "cards"}/${g.id}.txt`, 'utf8').startsWith('PLAIN CRASHED') }
})
const pct = (a: number, b: number) => b ? `${Math.round(100 * a / b)}%` : '-'
const row = (name: string, gs: typeof grades) => {
  const s = gs.flatMap(g => g.statements), k = (kind: string) => s.filter(x => x.kind === kind)
  const bad = (xs: St[]) => xs.filter(x => x.verdict === 'wrong' || x.verdict === 'misleading').length
  const re = k('reassurance'), wa = k('warning'), de = k('description'), stp = k('step')
  return [name, gs.length, `${bad(re)}/${re.length} (${pct(bad(re), re.length)})`, `${bad(wa)}/${wa.length} (${pct(bad(wa), wa.length)})`,
    `${bad(de)}/${de.length} (${pct(bad(de), de.length)})`, `${bad(stp)}/${stp.length}`,
    gs.reduce((a, g) => a + g.misses.filter(m => m.severity === 'high').length, 0), gs.reduce((a, g) => a + g.misses.filter(m => m.severity === 'medium').length, 0),
    `${gs.filter(g => g.silent).length} (${pct(gs.filter(g => g.silent).length, gs.length)})`, gs.filter(g => g.crashed).length].join(' | ')
}
console.log('| stack | cards | wrong reassurance | wrong warning | wrong description | wrong step | high misses | medium misses | silent | crashed |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const st of [...new Set(grades.map(g => g.stack))].sort()) console.log('| ' + row(st, grades.filter(g => g.stack === st)) + ' |')
console.log('| ' + row('**all**', grades) + ' |')
console.log('\n## Wrong or misleading reassurances')
for (const g of grades) for (const x of g.statements.filter(x => x.kind === 'reassurance' && x.verdict !== 'right' && x.verdict !== 'unverifiable')) console.log(`- ${g.id}: "${x.text}" — ${x.why}`)
console.log('\n## Wrong warnings')
for (const g of grades) for (const x of g.statements.filter(x => x.kind === 'warning' && (x.verdict === 'wrong' || x.verdict === 'misleading'))) console.log(`- ${g.id}: "${x.text}" — ${x.why}`)
console.log('\n## High-severity misses')
for (const g of grades) for (const m of g.misses.filter(m => m.severity === 'high')) console.log(`- ${g.id}: ${m.what}`)
