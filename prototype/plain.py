"""plain: a small LLM-friendly language that compiles to English.

The language is a Python subset (LLMs already write it well and it tokenizes cheaply).
The compiler to English is deterministic, with no LLM in it, so the explanation can't make
things up. Anything it can't explain is a syntax error: the explainer defines the language.

  python3 plain.py prog.pln         # print the English
  python3 plain.py prog.pln --run   # run it
  python3 plain.py                  # self-check
"""
import ast, sys

OPS = {ast.Add: 'plus', ast.Sub: 'minus', ast.Mult: 'times', ast.Div: 'divided by',
       ast.FloorDiv: 'whole-divided by', ast.Mod: 'modulo', ast.Pow: 'to the power of'}
CMP = {ast.Gt: 'is greater than', ast.Lt: 'is less than', ast.GtE: 'is at least',
       ast.LtE: 'is at most', ast.Eq: 'equals', ast.NotEq: 'is not', ast.In: 'is in',
       ast.NotIn: 'is not in'}
AUG = {ast.Add: 'Add {v} to {t}.', ast.Sub: 'Subtract {v} from {t}.',
       ast.Mult: 'Multiply {t} by {v}.', ast.Div: 'Divide {t} by {v}.'}
NOUNS = {'len': 'the length of', 'sum': 'the sum of', 'max': 'the largest of',
         'min': 'the smallest of', 'sorted': 'a sorted copy of', 'abs': 'the absolute value of'}


def reject(n):
    raise SyntaxError(f"line {getattr(n, 'lineno', '?')}: not in plain: {ast.unparse(n)}")


def e(n):
    """Expression -> noun phrase."""
    t, I = type(n), isinstance
    if t is ast.Name: return n.id
    if t is ast.Constant: return repr(n.value)
    if t is ast.BinOp and type(n.op) in OPS: return f"{e(n.left)} {OPS[type(n.op)]} {e(n.right)}"
    if t is ast.Compare and len(n.ops) == 1 and type(n.ops[0]) in CMP:
        return f"{e(n.left)} {CMP[type(n.ops[0])]} {e(n.comparators[0])}"
    if t is ast.BoolOp: return (' and ' if I(n.op, ast.And) else ' or ').join(map(e, n.values))
    if t is ast.UnaryOp and I(n.op, ast.Not): return f"not ({e(n.operand)})"
    if t is ast.UnaryOp and I(n.op, ast.USub): return f"negative {e(n.operand)}"
    if t is ast.List: return f"the list [{', '.join(map(e, n.elts))}]" if n.elts else 'an empty list'
    if t is ast.Subscript: return f"item {e(n.slice)} of {e(n.value)}"
    if t is ast.Call and I(n.func, ast.Name) and not n.keywords:
        f, a = n.func.id, n.args
        if f == 'range' and len(a) == 1: return f"the numbers from 0 up to (not including) {e(a[0])}"
        if f == 'range' and len(a) == 2: return f"the numbers from {e(a[0])} up to (not including) {e(a[1])}"
        if f in NOUNS and len(a) == 1: return f"{NOUNS[f]} {e(a[0])}"
        return f"the result of {f}" + (f" with {', '.join(map(e, a))}" if a else '')
    reject(n)


def s(n, d):
    """Statement -> list of indented sentences."""
    pad, t = '  ' * d, type(n)
    body = lambda b: [l for x in b for l in s(x, d + 1)]
    if t is ast.FunctionDef:
        ps = ', '.join(a.arg for a in n.args.args) or 'nothing'
        return [f"{pad}Function {n.name} takes {ps}:"] + body(n.body)
    if t is ast.Assign and len(n.targets) == 1: return [f"{pad}Set {e(n.targets[0])} to {e(n.value)}."]
    if t is ast.AugAssign and type(n.op) in AUG:
        return [pad + AUG[type(n.op)].format(t=e(n.target), v=e(n.value))]
    if t is ast.For and not n.orelse: return [f"{pad}For each {e(n.target)} in {e(n.iter)}:"] + body(n.body)
    if t is ast.While and not n.orelse: return [f"{pad}Repeat while {e(n.test)}:"] + body(n.body)
    if t is ast.If:
        out = [f"{pad}If {e(n.test)}:"] + body(n.body)
        return out + ([f"{pad}Otherwise:"] + body(n.orelse) if n.orelse else [])
    if t is ast.Return: return [f"{pad}Return {e(n.value)}." if n.value else f"{pad}Stop."]
    if t is ast.Expr and type(n.value) is ast.Call and not n.value.keywords:
        f, a = n.value.func, n.value.args
        if isinstance(f, ast.Name) and f.id == 'print': return [f"{pad}Print {', '.join(map(e, a))}."]
        if isinstance(f, ast.Attribute) and f.attr == 'append' and len(a) == 1:
            return [f"{pad}Append {e(a[0])} to {e(f.value)}."]
    if t is ast.Break: return [f"{pad}Stop the loop."]
    if t is ast.Continue: return [f"{pad}Skip to the next round."]
    reject(n)


def explain(src):
    return '\n'.join(l for n in ast.parse(src).body for l in s(n, 0))


DEMO = """
def big_total(xs, limit):
    t = 0
    for x in xs:
        if x > limit:
            t += x
    return t

print(big_total([5, 20, 30], 10))
"""

if __name__ == '__main__':
    if len(sys.argv) == 1:  # self-check
        out = explain(DEMO)
        print(out)
        assert 'For each x in xs:' in out and '    Add x to t.' in out
        try:
            explain('import os')
            raise AssertionError('should reject')
        except SyntaxError:
            pass
        print('\nok')
    else:
        src = open(sys.argv[1]).read()
        explain(src)  # always validate, even when running
        exec(src, {}) if '--run' in sys.argv else print(explain(src))
