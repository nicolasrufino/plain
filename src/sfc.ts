// Vue (.vue) and Svelte (.svelte) components, turned into TSX so plain.ts reads them like React: the <script> part as is,
// the template as JSX (visible text, buttons, forms, links). No compiler dependency: the two formats are close enough to JSX
// once directives are dropped. ponytail: the template is read for what it shows, not executed; a template that still doesn't parse
// gives fewer facts, never wrong ones.
const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i

const ENTITIES: Record<string, string> = { amp: '&', lt: '‹', gt: '›', quot: '"', apos: "'", nbsp: ' ', times: '×', copy: '©', rarr: '→', larr: '←', hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•' }

// template = false: the script part only (used when the template didn't convert cleanly)
export function sfcToTsx(path: string, text: string, template = true): string {
  const scripts: string[] = []
  let rest = text.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, s: string) => { scripts.push(s); return '' })
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  if (path.endsWith('.vue')) {
    // the outer <template>: from the first <template> to the last </template> (inner ones are slots and v-if groups)
    const a = rest.search(/<template\b[^>]*>/i), b = rest.toLowerCase().lastIndexOf('</template>')
    rest = a >= 0 && b > a ? rest.slice(rest.indexOf('>', a) + 1, b) : ''
    rest = rest.replace(/\{\{([\s\S]*?)\}\}/g, (_, e: string) => `{${e}}`)   // {{ price }} -> {price}
  } else {
    // Svelte blocks: {#if}, {:else}, {/if}, {@html x}, {@render x()} hold no visible words of their own
    let out = '', i = 0
    while (i < rest.length) {
      const k = rest.indexOf('{', i)
      if (k < 0) { out += rest.slice(i); break }
      const j = skipBraces(rest, k)   // {#each items as { id }} has braces inside
      out += rest.slice(i, k) + (/^\{[#:/@]/.test(rest.slice(k, k + 2)) ? '' : rest.slice(k, j)); i = j
    }
    rest = out
  }
  if (!template) return `${scripts.join('\n')}\n`
  // inner <template> tags (Vue slots, groups) are just wrappers; &times; and friends read as the character they show
  const tsx = rewriteTags(rest.replace(/<\/?template\b[^>]*>/gi, '')).replace(/&(\w+);/g, (m, e: string) => ENTITIES[e] ?? m)
  return `${scripts.join('\n')}\nexport function __Template() { return (<>${tsx}</>) }\n`
}

// Past a string (the index of its closing quote), or a balanced {...} (the index after it). Template literals' ${...} count as braces.
const skipString = (s: string, j: number): number => {
  const q = s[j]
  for (j++; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue }
    if (q === '`' && s[j] === '$' && s[j + 1] === '{') { j = skipBraces(s, j + 1) - 1; continue }
    if (s[j] === q) return j
  }
  return j
}
const skipBraces = (s: string, j: number): number => {
  for (let d = 0; j < s.length; j++) {
    const c = s[j]
    if (c === '"' || c === "'" || c === '`') { j = skipString(s, j); continue }
    if (c === '{') d++
    else if (c === '}' && --d === 0) return j + 1
  }
  return j
}
// Tags as JSX: keep plain attributes (href, to, type, action, method, aria-label, placeholder, name), drop directives and bindings
// (v-if, :prop, @click, on:click, bind:value, {...spread}), self-close void elements, `svelte:head` -> `svelte_head`.
function rewriteTags(src: string): string {
  let out = '', i = 0
  const name = (t: string) => t.replace(/[:.]/g, '_')
  while (i < src.length) {
    if (src[i] === '{') { const j = skipBraces(src, i); out += src.slice(i, j); i = j; continue }   // an expression in the text, kept whole
    const close = src[i] === '<' && src[i + 1] === '/' ? src.slice(i).match(/^<\/([A-Za-z][\w:.-]*)\s*>/) : null
    if (close) { out += VOID.test(close[1]) ? '' : `</${name(close[1])}>`; i += close[0].length; continue }
    const open = src[i] === '<' ? src.slice(i).match(/^<([A-Za-z][\w:.-]*)/) : null
    if (!open) { out += src[i++]; continue }
    let j = i + open[0].length, self = false
    const kept: string[] = []
    while (j < src.length) {
      while (/\s/.test(src[j] ?? '')) j++
      if (src[j] === '>') { j++; break }
      if (src[j] === '/' && src[j + 1] === '>') { self = true; j += 2; break }
      if (src[j] === '{') { j = skipBraces(src, j); continue }   // Svelte {shorthand} / {...spread}
      const nm = src.slice(j).match(/^[^\s"'>/={]+/)
      if (!nm) { j++; continue }
      j += nm[0].length
      let val: string | undefined
      const eq = src.slice(j).match(/^\s*=\s*/)
      if (eq) {
        j += eq[0].length
        const start = j
        if (src[j] === '"' || src[j] === "'") j = skipString(src, j) + 1
        else if (src[j] === '{') j = skipBraces(src, j)
        else while (j < src.length && !/[\s>]/.test(src[j])) j++
        val = src.slice(start, j)
        if (/^['"]/.test(val)) val = val.replace(/\{[^{}]*\}/g, '[id]')   // Svelte: href="/orders/{o.id}" -> /orders/[id], like other dynamic addresses
      }
      if (/^[A-Za-z][\w-]*$/.test(nm[0]) && !/^v-/.test(nm[0])) kept.push(` ${nm[0]}${val === undefined ? '' : `=${/^['"{]/.test(val) ? val : `"${val}"`}`}`)
    }
    out += `<${name(open[1])}${kept.join('')}${self || VOID.test(open[1]) ? ' /' : ''}>`
    i = j
  }
  return out
}

// Nuxt file routes. Pages: pages/orders/[id].vue -> /orders/[id] (also app/pages in Nuxt 4); (group) folders add nothing.
// Server: server/api/orders.post.ts -> POST /api/orders, server/routes/rss.ts -> /rss; no method suffix answers every method.
export function nuxtRoute(path: string): { kind: 'page' | 'endpoint'; url: string; method?: string } | null {
  const seg = (s: string) => s.split('/').filter(x => x && x !== 'index' && !/^\(.*\)$/.test(x)).map(x => x.replace(/^\[\.\.\.(\w*)\]$/, (_, n) => `[${n || 'rest'}]`))
  const pg = path.match(/^(?:app\/)?pages\/(.+)\.vue$/)
  if (pg) return { kind: 'page', url: '/' + seg(pg[1]).join('/') }
  const sv = path.match(/^server\/(api|routes)\/(.+?)(?:\.(get|post|put|patch|delete))?\.[cm]?[jt]s$/)
  if (sv) return { kind: 'endpoint', url: (sv[1] === 'api' ? '/api/' : '/') + seg(sv[2]).join('/'), method: sv[3]?.toUpperCase() }
  return null
}

// SvelteKit: src/routes/(app)/orders/[id=integer]/+page.svelte -> page /orders/[id]; +server.ts is an endpoint; id keeps the groups
// (hooks often check event.route.id?.startsWith('/(app)')).
export function svelteRoute(path: string): { file: 'page' | 'pageServer' | 'pageLoad' | 'layout' | 'server'; url: string; id: string } | null {
  const m = path.match(/^src\/routes\/(?:(.*)\/)?\+(page|layout|server)(\.server)?\.(svelte|[cm]?[jt]s)$/)
  if (!m) return null
  const dir = m[1] ?? '', id = '/' + dir
  const url = '/' + dir.split('/').filter(x => x && !/^\(.*\)$/.test(x)).map(x => x.replace(/^\[\[?(?:\.\.\.)?(\w+)(?:=\w+)?\]?\]$/, '[$1]')).join('/')
  const file = m[2] === 'server' ? 'server' : m[2] === 'layout' ? 'layout' : m[4] === 'svelte' ? 'page' : m[3] ? 'pageServer' : 'pageLoad'
  return { file, url, id }
}
