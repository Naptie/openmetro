/**
 * Minimal JavaScript-literal → JSON converter.
 *
 * The operator publishes its network data as plain literals inside production
 * JavaScript files (`serve.js`, `fareData.js`). Evaluating them would need
 * `eval` on remote content, and they are not valid JSON either: the literal in
 * `serve.js` uses bare identifier keys and single-quoted strings, and both
 * files end their last entry with a trailing comma.
 *
 * This module walks the literal **string-aware** and rewrites exactly those
 * three differences — comments are skipped, strings are decoded, bare
 * identifier keys are quoted and trailing commas are dropped. Nothing else is
 * touched, so the result is plain JSON that `JSON.parse` accepts.
 */

/** Character offsets of a balanced `[]` / `{}` literal inside `src`. */
export interface BalancedLiteral {
  /** The literal text, including the opening and closing delimiter. */
  text: string;
  /** Offset just past the closing delimiter. */
  end: number;
}

/**
 * Extract the balanced bracket literal that starts at `start`.
 *
 * String literals are skipped so a `]` or `}` inside a string cannot end the
 * scan early.
 */
export function extractBalancedLiteral(src: string, start: number): BalancedLiteral {
  const open = src[start];
  if (open !== '[' && open !== '{') {
    throw new Error(`extractBalancedLiteral: expected '[' or '{' at ${start}`);
  }
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      i = skipString(src, i);
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 };
    }
    i++;
  }
  throw new Error(`extractBalancedLiteral: unbalanced literal at ${start}`);
}

/** Offset just past the string literal that starts at `start`. */
function skipString(src: string, start: number): number {
  const quote = src[start]!;
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * Convert a JavaScript object/array literal into JSON text.
 *
 * Handles: `//` and `/* *\/` comments, single- or double-quoted strings,
 * bare identifier keys, and trailing commas. Numbers, booleans and `null` are
 * already valid JSON and pass through untouched.
 */
export function jsLiteralToJson(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;

    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      const raw = text.slice(i, end);
      out += JSON.stringify(decodeJsString(raw));
      i = end;
      continue;
    }

    // A bare identifier is either an object key (followed by `:`) or a
    // literal keyword (`true` / `false` / `null`) — only the former needs
    // quoting.
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j]!)) j++;
      const ident = text.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(text[k]!)) k++;
      out += text[k] === ':' ? JSON.stringify(ident) : ident;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  // Drop trailing commas before `}` / `]`.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Decode a quoted JavaScript string literal into its value. */
function decodeJsString(raw: string): string {
  const quote = raw[0]!;
  const body = raw.slice(1, -1);
  if (quote === '"') {
    // A double-quoted literal is already JSON syntax, escapes included.
    return JSON.parse(raw) as string;
  }
  let value = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      value += ch;
      continue;
    }
    const next = body[i + 1];
    i++;
    switch (next) {
      case 'n':
        value += '\n';
        break;
      case 'r':
        value += '\r';
        break;
      case 't':
        value += '\t';
        break;
      case 'b':
        value += '\b';
        break;
      case 'f':
        value += '\f';
        break;
      case 'v':
        value += '\v';
        break;
      case '0':
        value += '\0';
        break;
      case 'x': {
        const hex = body.slice(i + 1, i + 3);
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2;
        break;
      }
      case 'u': {
        if (body[i + 1] === '{') {
          const close = body.indexOf('}', i);
          value += String.fromCodePoint(Number.parseInt(body.slice(i + 2, close), 16));
          i = close;
        } else {
          value += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16));
          i += 4;
        }
        break;
      }
      default:
        value += next ?? '';
    }
  }
  return value;
}

/**
 * Parse the JS literal assigned to `pattern` (a regular expression whose
 * match ends right before the assigned value) and return it as JSON text.
 */
export function extractAssignedLiteral(src: string, pattern: RegExp): string {
  const m = pattern.exec(src);
  if (!m) throw new Error(`extractAssignedLiteral: pattern ${pattern} did not match`);
  const afterAssign = m.index + m[0].length;
  const open = src.slice(afterAssign).search(/[[{]/);
  if (open < 0) throw new Error('extractAssignedLiteral: no literal after assignment');
  const { text } = extractBalancedLiteral(src, afterAssign + open);
  return jsLiteralToJson(text);
}
