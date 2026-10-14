/**
 * Tiny, safe arithmetic evaluator used to verify numerical answers with code
 * instead of trusting a model's claimed result. No eval(), no identifiers
 * other than a fixed allow-list.
 */

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
  round: Math.round,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token =
  | { kind: "num"; value: number }
  | { kind: "id"; value: string }
  | { kind: "op"; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (/[0-9.]/.test(ch)) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(i));
      if (!match) throw new Error("Bad number");
      tokens.push({ kind: "num", value: Number(match[0]) });
      i += match[0].length;
    } else if (/[a-zA-Z_]/.test(ch)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(input.slice(i))!;
      tokens.push({ kind: "id", value: match[0].toLowerCase() });
      i += match[0].length;
    } else if (input.startsWith("**", i)) {
      tokens.push({ kind: "op", value: "^" });
      i += 2;
    } else if ("+-*/^(),×÷".includes(ch)) {
      tokens.push({ kind: "op", value: ch === "×" ? "*" : ch === "÷" ? "/" : ch });
      i += 1;
    } else {
      throw new Error(`Unsupported character: ${ch}`);
    }
  }
  return tokens;
}

export function evaluateExpression(source: string): number {
  if (source.length > 300) throw new Error("Expression too long");
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const takeOp = (value: string) => {
    const token = tokens[pos];
    if (token && token.kind === "op" && token.value === value) {
      pos += 1;
      return true;
    }
    return false;
  };

  function parseExpression(): number {
    let left = parseTerm();
    for (;;) {
      if (takeOp("+")) left += parseTerm();
      else if (takeOp("-")) left -= parseTerm();
      else return left;
    }
  }
  function parseTerm(): number {
    let left = parseUnary();
    for (;;) {
      if (takeOp("*")) left *= parseUnary();
      else if (takeOp("/")) left /= parseUnary();
      else return left;
    }
  }
  function parseUnary(): number {
    if (takeOp("-")) return -parseUnary();
    if (takeOp("+")) return parseUnary();
    return parsePower();
  }
  function parsePower(): number {
    const base = parseAtom();
    if (takeOp("^")) return Math.pow(base, parseUnary());
    return base;
  }
  function parseAtom(): number {
    const token = peek();
    if (!token) throw new Error("Unexpected end");
    if (token.kind === "num") {
      pos += 1;
      return token.value;
    }
    if (token.kind === "id") {
      pos += 1;
      if (takeOp("(")) {
        const fn = Object.hasOwn(FUNCTIONS, token.value) ? FUNCTIONS[token.value] : undefined;
        if (!fn) throw new Error(`Unknown function: ${token.value}`);
        const args: number[] = [];
        if (!takeOp(")")) {
          do {
            args.push(parseExpression());
          } while (takeOp(","));
          if (!takeOp(")")) throw new Error("Missing )");
        }
        return fn(...args);
      }
      if (Object.hasOwn(CONSTANTS, token.value)) return CONSTANTS[token.value];
      throw new Error(`Unknown name: ${token.value}`);
    }
    if (takeOp("(")) {
      const value = parseExpression();
      if (!takeOp(")")) throw new Error("Missing )");
      return value;
    }
    throw new Error("Unexpected token");
  }

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error("Trailing input");
  if (!Number.isFinite(result)) throw new Error("Not a finite number");
  return result;
}

/** Extracts the first number from free text such as "3.2 m/s" or "1,250". */
export function parseNumberLoose(text: string): number | null {
  const cleaned = text.replace(/,/g, "").replace(/×\s*10\^?/g, "e");
  const match = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|-?\.\d+/i.exec(cleaned);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

export function withinTolerance(actual: number, expected: number, tolerancePct: number): boolean {
  const tolerance = Math.max(Math.abs(expected) * (tolerancePct / 100), 1e-9);
  return Math.abs(actual - expected) <= tolerance;
}
