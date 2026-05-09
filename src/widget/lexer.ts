/**
 * Widget System v2 — Lexer
 *
 * Tokenizes the widget DSL source into a flat token stream.
 * Keywords are case-insensitive (normalized to lowercase).
 * Line comments start with //.
 */

export type TokenType =
  | 'IDENT'      // identifiers + keywords
  | 'NUMBER'     // 42, 3.14
  | 'STRING'     // "hello"
  | 'LBRACE'     // {
  | 'RBRACE'     // }
  | 'LBRACKET'   // [
  | 'RBRACKET'   // ]
  | 'LPAREN'     // (
  | 'RPAREN'     // )
  | 'DOT'        // .
  | 'COLON'      // :
  | 'COMMA'      // ,
  | 'EQ'         // =
  | 'NEQ'        // !=
  | 'LT'         // <
  | 'LTE'        // <=
  | 'GT'         // >
  | 'GTE'        // >=
  | 'PLUS'       // +
  | 'MINUS'      // -
  | 'STAR'       // *
  | 'SLASH'      // /
  | 'PERCENT'    // %
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

/**
 * Words that are reserved as keywords.
 * Identifiers matching these (case-insensitively) are normalized to lowercase.
 */
export const KEYWORDS = new Set([
  'widget', 'data', 'plot',
  'source', 'where', 'group', 'measure',
  'type', 'as',
  'in', 'not', 'under', 'and', 'or',
  'true', 'false', 'null',
  'period', 'topk', 'by',
]);

export class LexError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
  ) {
    super(`[${line}:${col}] ${message}`);
    this.name = 'LexError';
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  function currentCol(): number {
    return i - lineStart + 1;
  }

  function tok(type: TokenType, value: string, startCol: number): Token {
    return { type, value, line, col: startCol };
  }

  while (i < source.length) {
    const startI = i;
    const startLine = line;
    const startCol = i - lineStart + 1;
    const ch = source[i];

    // ── Whitespace ────────────────────────────────────────────
    if (ch === '\n') {
      line++;
      lineStart = i + 1;
      i++;
      continue;
    }
    if (ch === '\r' || ch === ' ' || ch === '\t') {
      i++;
      continue;
    }

    // ── Line comments ─────────────────────────────────────────
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    // ── String literals ───────────────────────────────────────
    if (ch === '"') {
      i++;
      let s = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\n') {
          throw new LexError('Unterminated string (newline in string)', startLine, startCol);
        }
        if (source[i] === '\\') {
          i++;
          if (i >= source.length) break;
          switch (source[i]) {
            case 'n':  s += '\n'; break;
            case 't':  s += '\t'; break;
            case '"':  s += '"';  break;
            case '\\': s += '\\'; break;
            default:   s += source[i];
          }
        } else {
          s += source[i];
        }
        i++;
      }
      if (i >= source.length) {
        throw new LexError('Unterminated string literal', startLine, startCol);
      }
      i++; // consume closing "
      tokens.push(tok('STRING', s, startCol));
      continue;
    }

    // ── Number literals ───────────────────────────────────────
    if (ch >= '0' && ch <= '9') {
      let num = '';
      while (i < source.length && source[i] >= '0' && source[i] <= '9') {
        num += source[i++];
      }
      if (source[i] === '.' && i + 1 < source.length && source[i + 1] >= '0' && source[i + 1] <= '9') {
        num += source[i++];
        while (i < source.length && source[i] >= '0' && source[i] <= '9') {
          num += source[i++];
        }
      }
      tokens.push(tok('NUMBER', num, startCol));
      continue;
    }

    // ── Identifiers and keywords ──────────────────────────────
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let id = '';
      while (
        i < source.length &&
        ((source[i] >= 'a' && source[i] <= 'z') ||
          (source[i] >= 'A' && source[i] <= 'Z') ||
          (source[i] >= '0' && source[i] <= '9') ||
          source[i] === '_')
      ) {
        id += source[i++];
      }
      const lower = id.toLowerCase();
      // Normalize keywords to lowercase so the parser can compare case-insensitively
      tokens.push(tok('IDENT', KEYWORDS.has(lower) ? lower : id, startCol));
      continue;
    }

    // ── Symbols ───────────────────────────────────────────────
    switch (ch) {
      case '{': tokens.push(tok('LBRACE',   '{', startCol)); i++; break;
      case '}': tokens.push(tok('RBRACE',   '}', startCol)); i++; break;
      case '[': tokens.push(tok('LBRACKET', '[', startCol)); i++; break;
      case ']': tokens.push(tok('RBRACKET', ']', startCol)); i++; break;
      case '(': tokens.push(tok('LPAREN',   '(', startCol)); i++; break;
      case ')': tokens.push(tok('RPAREN',   ')', startCol)); i++; break;
      case '.': tokens.push(tok('DOT',      '.', startCol)); i++; break;
      case ':': tokens.push(tok('COLON',    ':', startCol)); i++; break;
      case ',': tokens.push(tok('COMMA',    ',', startCol)); i++; break;
      case '+': tokens.push(tok('PLUS',     '+', startCol)); i++; break;
      case '-': tokens.push(tok('MINUS',    '-', startCol)); i++; break;
      case '*': tokens.push(tok('STAR',     '*', startCol)); i++; break;
      case '%': tokens.push(tok('PERCENT',  '%', startCol)); i++; break;

      case '/':
        tokens.push(tok('SLASH', '/', startCol));
        i++;
        break;

      case '=':
        tokens.push(tok('EQ', '=', startCol));
        i++;
        break;

      case '!':
        if (source[i + 1] === '=') {
          tokens.push(tok('NEQ', '!=', startCol));
          i += 2;
        } else {
          throw new LexError(`Unexpected character '!'`, startLine, startCol);
        }
        break;

      case '<':
        if (source[i + 1] === '=') {
          tokens.push(tok('LTE', '<=', startCol));
          i += 2;
        } else {
          tokens.push(tok('LT', '<', startCol));
          i++;
        }
        break;

      case '>':
        if (source[i + 1] === '=') {
          tokens.push(tok('GTE', '>=', startCol));
          i += 2;
        } else {
          tokens.push(tok('GT', '>', startCol));
          i++;
        }
        break;

      default:
        throw new LexError(`Unexpected character '${ch}'`, startLine, startCol);
    }
  }

  tokens.push({ type: 'EOF', value: '', line, col: currentCol() });
  return tokens;
}
