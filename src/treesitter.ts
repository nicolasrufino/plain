// One web-tree-sitter for every language: Parser.init() sets up the WebAssembly runtime, and calling it again resets it
// (a parser made before would stop working). Each language file asks for its grammar here.
import { fileURLToPath } from 'node:url'
type TS = typeof import('web-tree-sitter')
let ready: Promise<TS | null> | undefined
export async function parserFor(grammar: string): Promise<import('web-tree-sitter').Parser | null> {
  ready ??= import('web-tree-sitter').then(async m => { await m.Parser.init(); return m }).catch(() => null)
  const m = await ready
  if (!m) return null   // not installed: files in this language are skipped
  try {
    const p = new m.Parser()
    p.setLanguage(await m.Language.load(fileURLToPath(new URL(`../vendor/${grammar}`, import.meta.url))))
    return p
  } catch { return null }
}
