// Java (Spring Boot): controllers, Spring Security's rules, Spring Data JPA, Stripe. The same facts plain.ts reads from other stacks.
// Login, as Spring decides it (resolved in plain.ts):
//  - the security chains of your own (SecurityFilterChain beans, or a WebSecurityConfigurerAdapter), in @Order, the first whose
//    securityMatcher fits the address; no chain fits: no security filters run, it's open;
//  - in that chain, the request rules in the order written, first match wins (permitAll / anonymous: open; authenticated / hasRole...:
//    login; denyAll: nobody). No rule matches: Spring Security 6's authorizeHttpRequests denies, the older authorizeRequests lets it
//    through. A rule plain can't read ends the reading: from there on, plain claims nothing;
//  - a chain with no request rules checks nothing; with no chain of your own, Spring Security on the classpath means login everywhere;
//  - @PreAuthorize / @Secured / @RolesAllowed add a check only when their kind is switched on (@EnableMethodSecurity: @PreAuthorize;
//    securedEnabled / jsr250Enabled for the others). @PostAuthorize runs after the method, so it doesn't stop a write.
// ponytail: no Kotlin, no WebFlux.
import type { FileFacts } from './plain.ts'
import { parserFor } from './treesitter.ts'
const parser = await parserFor('tree-sitter-java.wasm')   // 0.4 MB; null when web-tree-sitter isn't installed: Java files are skipped

type N = import('web-tree-sitter').Node
export type Rule = { methods: string[]; patterns: string[]; decision: 'open' | 'login' | 'deny' }
// one security chain: where it applies (securityMatcher; empty: everywhere), its @Order, its rules (undefined: no request rules),
// whether the rules were read to the end, and which style (authorizeRequests lets unmatched requests through)
export type Chain = { order: number; matchers: string[]; rules?: Rule[]; complete: boolean; legacy: boolean }
export type Family = 'pre' | 'secured' | 'jsr250'
export type JavaRoute = { method: string; path: string; cls: string; name: string; checks: Family[] }
export type JavaFacts = FileFacts & { java: {
  routes: JavaRoute[]
  methods: Map<string, FileFacts & { checks?: Family[] }>   // Class.method -> facts ('jcall:Type.method' in used: calls followed in plain.ts)
  implements: Map<string, string[]>                         // class -> the interfaces it implements (annotations there count too)
  repos: Map<string, string>                                // OrderRepository extends JpaRepository<Order, Long> -> Order
  repoWrites: Map<string, string>                           // OrderRepository.markCancelled -> update (@Modifying @Query)
  restRepos: Map<string, string>                            // @RepositoryRestResource(path = "orders") -> repository -> its path ('' if default)
  entities: Map<string, string[]>                           // @Entity fields ("→Type" for @ManyToOne / @OneToOne)
  chains: Chain[]
  enabled: Family[]                                         // method security switched on here
  risks: Set<string>
} }

const all = (n: N, type: string) => n.descendantsOfType(type).filter((x): x is N => !!x)
const str = (n?: N | null) => n?.type === 'string_literal' ? n.namedChildren.filter(c => c?.type === 'string_fragment').map(c => c!.text).join('') : undefined
const annos = (decl: N) => (decl.namedChildren.find(c => c?.type === 'modifiers')?.namedChildren ?? []).filter((a): a is N => !!a && /annotation$/.test(a.type))
const annoName = (a: N) => a.childForFieldName('name')!.text.split('.').at(-1)!
// @GetMapping("/x"), @GetMapping(value = "/x"), @GetMapping(path = {"/a", "/b"}), @RequestMapping(value = "/x", method = RequestMethod.POST)
const annoPaths = (a: N): string[] => {
  const args = a.childForFieldName('arguments')
  if (!args) return ['']
  const direct = args.namedChildren.filter(c => c?.type === 'string_literal' || c?.type === 'element_value_array_initializer')
  const named = args.namedChildren.filter(c => c?.type === 'element_value_pair' && /^(value|path)$/.test(c.childForFieldName('key')?.text ?? '')).map(c => c!.childForFieldName('value')!)
  const vals = [...direct, ...named].flatMap(v => v!.type === 'element_value_array_initializer' ? v!.namedChildren : [v])
  const out = vals.map(v => str(v)).filter((x): x is string => x !== undefined)
  return out.length ? out : ['']
}
const VERB: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE' }
const join = (a: string, b: string) => (`/${a.replace(/^\/|\/$/g, '')}/${b.replace(/^\//, '')}`).replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
// {id}, {id:\d+} -> [id]
export const jPath = (p: string) => p.replace(/\{(\w+)(:[^}]*)?\}/g, '[$1]')
// @PreAuthorize("hasRole('ADMIN')") -> pre; @Secured -> secured; @RolesAllowed -> jsr250 (not permitAll() / isAnonymous(); not @PostAuthorize)
const checksOf = (as: N[]): Family[] => as.flatMap(a => { const n = annoName(a)
  return n === 'PreAuthorize' && !/permitAll|isAnonymous/.test(a.text) ? ['pre' as const] : n === 'Secured' ? ['secured' as const] : n === 'RolesAllowed' ? ['jsr250' as const] : [] })
// from `text` at an opening "(", the index after its closing ")" (strings skipped)
const close = (t: string, i: number) => { let d = 0; for (; i < t.length; i++) { const c = t[i]; if (c === '"') { i = t.indexOf('"', i + 1); if (i < 0) return t.length; continue } if (c === '(') d++; else if (c === ')' && --d === 0) return i + 1 } return t.length }

// The request rules in one chain's text: every authorizeHttpRequests(...) / authorizeRequests(...) in order. A matcher or decision plain
// can't read (regexMatchers, a custom RequestMatcher, hasIpAddress, access("...") it doesn't know) stops the reading there.
function readRules(t: string): { rules: Rule[]; complete: boolean; legacy: boolean } | undefined {
  const blocks = [...t.matchAll(/\bauthorize(HttpRequests|Requests)\s*\(/g)]
  if (!blocks.length) return undefined
  const rules: Rule[] = []
  const legacy = blocks.every(b => b[1] === 'Requests')
  for (const b of blocks) {
    const body = t.slice(b.index! + b[0].length, close(t, b.index! + b[0].length - 1) - 1)
    for (let i = 0; i < body.length;) {
      const m = body.slice(i).match(/\b(requestMatchers|antMatchers|mvcMatchers|regexMatchers|anyRequest)\s*\(/)
      if (!m) break
      const at = i + m.index! + m[0].length - 1, end = close(body, at), args = body.slice(at + 1, end - 1)
      const d = body.slice(end).match(/^\s*\.\s*(\w+)\s*\(/)
      if (!d) { i = end; continue }
      const dEnd = close(body, end + d[0].length - 1), dArgs = body.slice(end + d[0].length, dEnd - 1)
      const decision = /^(permitAll|anonymous)$/.test(d[1]) || d[1] === 'access' && /^\s*"\s*permitAll\s*"\s*$/.test(dArgs) ? 'open' as const
        : d[1] === 'denyAll' ? 'deny' as const
        : /^(authenticated|fullyAuthenticated|hasRole|hasAnyRole|hasAuthority|hasAnyAuthority|rememberMe)$/.test(d[1]) || d[1] === 'access' && /^\s*"\s*(isAuthenticated|isFullyAuthenticated|hasRole|hasAnyRole|hasAuthority|hasAnyAuthority)\b/.test(dArgs) ? 'login' as const : undefined
      // matchers: "/x" strings, also inside new AntPathRequestMatcher("/x"), antMatcher("/x"), mvc.pattern("/x"); HttpMethod.X
      const patterns = m[1] === 'anyRequest' ? ['/**'] : [...args.matchAll(/"(\/[^"]*)"/g)].map(x => x[1]).concat(/^\s*HttpMethod\.\w+\s*$/.test(args) ? ['/**'] : [])
      const readable = m[1] !== 'regexMatchers' && (m[1] === 'anyRequest' || patterns.length > 0) && !/PathRequest\.|\bnew\s+(?!AntPathRequestMatcher|MvcRequestMatcher)\w+RequestMatcher|RegexRequestMatcher/.test(args)
      if (/PathRequest\.toStaticResources/.test(args)) { i = dEnd; continue }   // css/js/images: not an address with data
      if (!decision || !readable) return { rules, complete: false, legacy }
      rules.push({ methods: [...args.matchAll(/HttpMethod\.(\w+)/g)].map(x => x[1]), patterns, decision })
      i = dEnd
    }
  }
  return { rules, complete: true, legacy }
}

export function javaFacts(path: string, text: string, empty: (printed?: string) => FileFacts): JavaFacts | undefined {
  if (!parser) return undefined
  const tree = parser.parse(text)
  if (!tree) return undefined
  const root = tree.rootNode
  // comments found by the parser, not by text: "/orders/**" in a string isn't the start of one
  let code = text
  for (const c of ['line_comment', 'block_comment'].flatMap(k => all(root, k)).sort((a, b) => b.startIndex - a.startIndex)) code = code.slice(0, c.startIndex) + code.slice(c.endIndex)
  // method security switches: @EnableMethodSecurity (prePostEnabled on by default; securedEnabled / jsr250Enabled off);
  // @EnableGlobalMethodSecurity (all off unless set)
  const enabled: Family[] = []
  for (const m of code.matchAll(/@Enable(Global)?MethodSecurity\b(\s*\(([^)]*)\))?/g)) {
    const a = m[3] ?? '', on = (k: string, dflt: boolean) => new RegExp(`${k}\\s*=\\s*true`).test(a) || dflt && !new RegExp(`${k}\\s*=\\s*false`).test(a)
    if (on('prePostEnabled', !m[1])) enabled.push('pre'); if (on('securedEnabled', false)) enabled.push('secured'); if (on('jsr250Enabled', false)) enabled.push('jsr250')
  }
  const f: JavaFacts = Object.assign(collect(root, empty(code.replace(/\s+/g, ' ')), new Map(), ''), { java: { routes: [], methods: new Map(), implements: new Map(), repos: new Map(), repoWrites: new Map(),
    restRepos: new Map(), entities: new Map(), chains: [], enabled, risks: new Set<string>() } })
  f.todos = [...text.matchAll(/\/\/\s*((TODO|FIXME|HACK)\b[^\n]*)/g)].map(m => m[1])
  // CORS open to every site: @CrossOrigin with no origins or "*", allowedOrigins("*"), setAllowedOrigins(List.of("*")), addAllowedOrigin("*"), patterns too
  if (/@CrossOrigin\b(?!\s*\([^)]*origins\s*=\s*(?!\{?\s*"\*")[{"])|allowed?Origin(s|Patterns?)?\s*\(\s*(List\.of\(|Arrays\.asList\()?\s*"\*"|setAllowedOrigin(s|Patterns)\s*\(\s*(List\.of|Arrays\.asList|Collections\.singletonList)\(\s*"\*"/i.test(code)) f.java.risks.add('cors')

  for (const i of all(root, 'interface_declaration')) {   // interface OrderRepository extends JpaRepository<Order, Long>
    const name = i.childForFieldName('name')!.text, ext = i.namedChildren.find(c => c?.type === 'extends_interfaces')?.text ?? ''
    const m = ext.match(/\b(\w*Repository|CrudRepository|JpaRepository|PagingAndSortingRepository|ListCrudRepository)\s*<\s*(\w+)/)
    if (m) {
      f.java.repos.set(name, m[2])
      const rest = annos(i).find(a => annoName(a) === 'RepositoryRestResource')
      if (rest && !/exported\s*=\s*false/.test(rest.text) || !rest) f.java.restRepos.set(name, rest?.text.match(/path\s*=\s*"([^"]*)"/)?.[1] ?? '')
      // @Modifying @Query("delete from Order o where ...") void purgeOld(): a write
      for (const md of all(i, 'method_declaration')) { const q = annos(md).find(a => annoName(a) === 'Query')?.text ?? ''
        if (annos(md).some(a => annoName(a) === 'Modifying')) f.java.repoWrites.set(`${name}.${md.childForFieldName('name')!.text}`, /\bdelete\b/i.test(q) ? 'delete' : /\binsert\b/i.test(q) ? 'create' : 'update') }
    }
    // @PreAuthorize on an interface method counts for the classes that implement it
    for (const md of all(i, 'method_declaration')) { const c = checksOf(annos(md)); if (c.length) f.java.methods.set(`${name}.${md.childForFieldName('name')!.text}`, Object.assign(empty(''), { checks: c })) }
  }
  for (const cls of all(root, 'class_declaration')) {
    const name = cls.childForFieldName('name')!.text, ca = annos(cls), body = cls.childForFieldName('body')!
    f.java.implements.set(name, (cls.namedChildren.find(c => c?.type === 'super_interfaces')?.text.replace(/^implements\s+/, '').split(',') ?? []).map(x => x.trim().replace(/<.*$/, '')))
    const fields = new Map<string, string>()   // orderService -> OrderService (also constructor parameters, for constructor injection)
    for (const fd of body.namedChildren.filter((x): x is N => x?.type === 'field_declaration'))
      for (const v of fd.namedChildren.filter((x): x is N => x?.type === 'variable_declarator')) fields.set(v.childForFieldName('name')!.text, fd.childForFieldName('type')!.text.replace(/<.*$/, ''))
    for (const p of all(body, 'formal_parameter')) if (p.parent?.parent?.type === 'constructor_declaration') fields.set(p.childForFieldName('name')!.text, p.childForFieldName('type')!.text.replace(/<.*$/, ''))
    // entities: @Entity class Order { @Id Long id; String status; @ManyToOne User user; } (not @Transient, static, or @OneToMany lists)
    if (ca.some(a => annoName(a) === 'Entity')) {
      const props: string[] = []
      for (const fd of body.namedChildren.filter((x): x is N => x?.type === 'field_declaration')) {
        const fa = annos(fd), mods = fd.namedChildren.find(c => c?.type === 'modifiers')?.text ?? '', type = fd.childForFieldName('type')!.text
        if (/\bstatic\b/.test(mods) || fa.some(a => /^(Transient|OneToMany|ManyToMany)$/.test(annoName(a))) || /^(List|Set|Collection)</.test(type)) continue
        for (const v of fd.namedChildren.filter((x): x is N => x?.type === 'variable_declarator'))
          props.push(fa.some(a => /^(ManyToOne|OneToOne)$/.test(annoName(a))) ? `→${type}` : v.childForFieldName('name')!.text)
      }
      f.java.entities.set(name, props)
    }
    const classChecks = checksOf(ca)
    // every method's facts (overloads of the same name add up); class-level checks count for each
    for (const m of all(body, 'method_declaration')) {
      const key = `${name}.${m.childForFieldName('name')!.text}`, g = Object.assign(collect(m, empty(m.text), fields, name), { checks: [...classChecks, ...checksOf(annos(m))] })
      const had = f.java.methods.get(key)
      if (had) { for (const k of ['tables', 'written', 'ops', 'outside', 'env', 'envReq', 'services', 'refuses', 'used'] as const) for (const x of g[k]) had[k].add(x); had.money ||= g.money; had.writes ||= g.writes; had.checks = [...had.checks ?? [], ...g.checks]; had.printed += '\n' + g.printed }
      else f.java.methods.set(key, g)
    }
    // security chains: a @Bean method returning SecurityFilterChain (its @Order, its securityMatcher), or a WebSecurityConfigurerAdapter
    for (const m of all(body, 'method_declaration')) {
      const t = m.text, adapter = /WebSecurityConfigurerAdapter/.test(cls.text) && m.childForFieldName('name')!.text === 'configure' && /HttpSecurity/.test(t)
      if (!/\bSecurityFilterChain\b/.test(m.childForFieldName('type')?.text ?? '') && !adapter) continue
      const order = Number(annos(m).find(a => annoName(a) === 'Order')?.text.match(/-?\d+/)?.[0] ?? 2147483647)
      const sm = t.match(/\bsecurityMatchers?\s*\(([\s\S]*?)\)\s*\.\s*(?:authorize|csrf|cors|sessionManagement|httpBasic|formLogin|oauth2|exceptionHandling|headers|addFilter)/)?.[1] ?? t.match(/(?:\bhttp\s*\.\s*(?:requestMatcher|antMatcher)|\bsecurityMatcher)\s*\(\s*"([^"]+)"\s*\)/)?.[0] ?? ''   // not an antMatcher("/x") inside the rules
      const matchers = [...sm.matchAll(/"(\/[^"]*)"/g)].map(x => x[1])
      const r = readRules(t.replace(/\/\/[^\n]*/g, ''))
      f.java.chains.push({ order, matchers, rules: r?.rules, complete: r?.complete ?? true, legacy: r?.legacy ?? false })
    }
    // controllers: @RestController / @Controller, @RequestMapping("/api/orders") on the class, @GetMapping("/{id}") on methods
    if (!ca.some(a => /^(RestController|Controller)$/.test(annoName(a)))) continue
    const bases = ca.filter(a => annoName(a) === 'RequestMapping').flatMap(annoPaths)
    for (const m of all(body, 'method_declaration')) {
      const ma = annos(m), mname = m.childForFieldName('name')!.text
      for (const a of ma) {
        const n = annoName(a)
        const methods = VERB[n] ? [VERB[n]] : n === 'RequestMapping' ? [...a.text.matchAll(/RequestMethod\.(\w+)/g)].map(x => x[1]).filter(x => /^(GET|POST|PUT|PATCH|DELETE)$/.test(x)) : []
        if (n === 'RequestMapping' && !methods.length) methods.push('ANY')   // no method: answers every one
        for (const method of methods) for (const b of bases.length ? bases : ['']) for (const p of annoPaths(a))
          f.java.routes.push({ method, path: jPath(join(b, p)), cls: name, name: mname, checks: [...classChecks, ...checksOf(ma)] })
      }
    }
  }
  ;(f as FileFacts & { parseError?: boolean }).parseError = tree.rootNode.hasError   // (see the cut-off file check in plain.ts)
  tree.delete()   // trees live in WebAssembly memory, which JavaScript never frees: a big repo filled it and the parser aborted
  return f

  // Facts from one subtree: Spring Data repositories, calls into other classes and the class's own helpers, Stripe, email, config, "no" messages.
  function collect(node: N, g: FileFacts, fields: Map<string, string>, cls: string): FileFacts {
    const vars = new Map<string, string>()   // Order order = new Order() -> create; Order o = orders.findById(id).orElseThrow() -> update
    for (const d of all(node, 'variable_declarator')) { const v = d.childForFieldName('value')?.text ?? ''; vars.set(d.childForFieldName('name')!.text, /^new\s/.test(v) ? 'new' : /\.find\w*\(/.test(v) ? 'found' : '') }
    for (const call of all(node, 'method_invocation')) {
      const name = call.childForFieldName('name')!.text, obj = call.childForFieldName('object')?.text ?? '', a0 = call.childForFieldName('arguments')?.namedChildren[0]
      g.used.add(name)
      const type = obj ? fields.get(obj.replace(/^this\./, '')) : cls
      if (type) g.used.add(`jcall:${type}.${name}`)   // orderService.cancel(id), or doCancel(id) on this class: followed in plain.ts
      // repositories: orders.save(o), orders.deleteById(id), orders.findAll(); the entity comes from the repository's type (plain.ts)
      if (type && obj && /Repository$|Repo$/.test(type)) {
        const t = `@repo:${type}`
        g.tables.add(t)
        if (/^(save|saveAll|saveAndFlush|saveAllAndFlush)$/.test(name)) { g.written.add(t); g.writes = true; g.ops.add(a0 && (/^new\s/.test(a0.text) || vars.get(a0.text) === 'new') ? 'create' : a0 && vars.get(a0.text) === 'found' ? 'update' : 'create') }
        if (/^delete/.test(name)) { g.written.add(t); g.writes = true; g.ops.add('delete') }
      }
      // Stripe Java: Session.create(params) (checkout), Webhook.constructEvent(...), Refund.create(...)
      if (/^(Session|com\.stripe\.model\.checkout\.Session)$/.test(obj) && name === 'create') { g.money = true; g.services.add('Stripe'); g.outside.add('Stripe: checkout.sessions.create') }
      if (/^(PaymentIntent|Charge)$/.test(obj) && name === 'create') { g.money = true; g.services.add('Stripe') }
      if (obj === 'Refund' && name === 'create') { g.services.add('Stripe'); g.outside.add('Stripe: refunds.create') }
      if (obj === 'Webhook' && name === 'constructEvent') { g.services.add('Stripe'); g.outside.add('Stripe: webhooks.constructEvent') }
      if (/mail\w*Sender/i.test(obj) && name === 'send' || /^(sendEmail|sendMail)$/.test(name)) { g.services.add('email'); g.outside.add('email: send') }
      if (obj === 'System' && name === 'getenv' && str(a0)) { g.env.add(str(a0)!); g.envReq.add(str(a0)!) }
    }
    // "no" messages: new ResponseStatusException(HttpStatus.CONFLICT, "...")
    for (const n of all(node, 'object_creation_expression')) if (/ResponseStatusException/.test(n.childForFieldName('type')?.text ?? '')) {
      const a = n.childForFieldName('arguments')?.namedChildren ?? [], m = str(a[1] ?? null)
      if (m && /BAD_REQUEST|CONFLICT|UNPROCESSABLE|PAYMENT_REQUIRED/.test(a[0]?.text ?? '')) g.refuses.add(m)
    }
    // @Value("${stripe.secret-key}") / @Value("${STRIPE_SECRET_KEY}"): read by plain.ts from application.properties for the env var
    for (const a of all(node, 'annotation').filter(a => annoName(a) === 'Value')) { const v = str(a.childForFieldName('arguments')?.namedChildren[0]); const k = v?.match(/^\$\{([\w.-]+)(:[^}]*)?\}$/); if (k) { g.env.add(`@prop:${k[1]}`); if (!k[2]) g.envReq.add(`@prop:${k[1]}`) } }
    g.emptyCatch += all(node, 'catch_clause').filter(c => /^\{\s*\}$/.test(c.childForFieldName('body')?.text ?? '')).length
    return g
  }
}
