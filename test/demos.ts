// Regression check against the local demo apps in examples/ (each its own git repo, not in this repo).
// Writes plain's card for every demo branch vs. its parent, one file each. Run before and after a change, then diff:
//   node test/demos.ts /tmp/before   (change code)   node test/demos.ts /tmp/after   diff -r /tmp/before /tmp/after
import { report, snapshot } from '../src/plain.ts'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const out = process.argv[2] ?? 'demo-cards', E = join(import.meta.dirname, '..', 'examples')
const EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'   // git's empty tree: "the whole app is new"
const branches = (app: string) => execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: join(E, app), encoding: 'utf8' }).split('\n').filter(Boolean)
// ponytail: parents hard-coded per demo; read them from a file in each demo if there get to be many
const runs: [string, string, string][] = []
if (existsSync(join(E, 'bracelet-shop'))) for (const b of branches('bracelet-shop').filter(b => b !== 'main'))
  runs.push(['bracelet-shop', b.startsWith('p') ? 'dashboard' : 'main', b])
if (existsSync(join(E, 'dog-walks'))) for (const b of branches('dog-walks'))
  runs.push(['dog-walks', b === 'main' ? EMPTY : 'main', b])
mkdirSync(out, { recursive: true })
for (const [app, base, b] of runs) writeFileSync(join(out, `${app}--${b}.txt`), report(snapshot(join(E, app), base), snapshot(join(E, app), b), { ref: base === EMPTY ? 'nothing' : base }))
console.log(`${runs.length} cards in ${out}`)
