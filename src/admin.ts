// "Only admins": a check that turns people away when they aren't an admin (or staff, or superuser), in any stack's words.
// Used only on a check the stack's reader already found stops people (a deciding `if`, a guard method, a middleware), so this
// decides the wording, never whether there's a check at all. The sense matters: `abort_if($user->is_admin)` keeps admins out.
//   Go `!u.IsAdmin`, `u.Role != "admin"`; PHP `abort_unless($request->user()?->is_admin, 403)`, `! $user->isAdmin()`,
//   `!$user->hasRole('admin')`; Ruby `unless Current.user&.admin?`, `unless current_user.admin?`; JS `!req.user?.isAdmin`,
//   `user.role !== 'admin'`; Python `not request.user.is_staff`
const PRED = String.raw`(?:is_?admin|isAdmin|IsAdmin|admin\?|admin|Admin|is_?staff|isStaff|IsStaff|staff\?|is_?superuser|isSuperuser|IsSuperuser|superuser\?)`
export const NOT_ADMIN = new RegExp([
  String.raw`!\s*\(?\s*[\w$.>?()\-\[\]'"&]*?(?:\.|->|\?\.|&\.)${PRED}\b\s*\(?\)?`,   // !u.IsAdmin, ! $user->isAdmin(), !req.user?.isAdmin
  String.raw`\bnot\s+[\w.]*?\.${PRED}\b`,                                             // not request.user.is_staff
  String.raw`\bunless\s+[\w.&?()]*?(?:\.|&\.)${PRED}`,                                  // unless Current.user&.admin?
  String.raw`\babort_unless\s*\(\s*[^,;]*?(?:\.|->|\?->)${PRED}\b`,                     // abort_unless($request->user()?->is_admin, 403)
  String.raw`\b[Rr]ole['"]?\]?\s*(?:!==?|<>|!=)\s*['"](?:admin|staff|superuser)['"]`,       // user.role !== 'admin', u.Role != "admin"
  String.raw`!\s*[\w$.>?()\-]*?(?:hasRole|has_role|hasAnyRole|is_role|isRole)\(\s*['"](?:admin|staff|superuser)['"]`,
].join('|'))
// a flag the visitor sends (?isAdmin=1, a header, the request body) proves nothing
export const FROM_REQUEST = /\b(?:req|request)\.(?:query|headers|body|params|cookies|GET|POST|data|query_params)\b|\b(?:req|request)\.(?:get|header)\s*\(|\br\.(?:URL|Header|Form|PostForm|Body|FormValue|PathValue)\b|\bc\.(?:Query|Param|GetHeader|PostForm|DefaultQuery)\b|\$request->(?:input|query|header|get|post|boolean)\(|\bparams\[|\bbody\./
// The whole condition turns away non-admins, and nobody else gets past it. `if (!admin ...)` (true for non-admins): no `&&` (an owner,
// an editor or a GET slips by) and no `!(admin || owner)`. `unless admin ...` / `abort_unless(admin ...)` (true for admins): no `||`.
export function adminCond(cond: string): boolean {
  if (!NOT_ADMIN.test(cond) || FROM_REQUEST.test(cond)) return false
  if (/\bunless\b|abort_unless/.test(cond)) return !/\|\||\bor\b/.test(cond)
  return !/&&|\band\b/.test(cond) && !/!\s*\([^()]*(?:\([^()]*\)[^()]*)*\|\|/.test(cond)
}
// The same check written the other way: `if (req.user?.role === 'admin') return next()`, then a rejection for everyone else
// (the caller checks that part). The condition is only the admin test: no `||` (an editor gets in), no `!`, nothing the request sends.
export function adminPos(cond: string): boolean {
  return /^\s*(?:[\w$.?]+(?:\.|\?\.|->)(?:isAdmin|is_admin|IsAdmin|isStaff|is_staff|isSuperuser|is_superuser)(?:\(\))?|[\w$.?]+(?:\.|\?\.|->)role\s*===?\s*['"](?:admin|staff|superuser)['"])\s*$/.test(cond)
    && !FROM_REQUEST.test(cond)
}
