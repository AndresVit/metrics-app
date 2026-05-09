/**
 * Widget System v2 — Parser
 *
 * Recursive descent parser for the widget DSL.
 * Produces a WidgetDef AST.
 *
 * DSL shape:
 *
 *   widget "name" {
 *     data {
 *       source: TIM as tims
 *       where: <expr>
 *       group {
 *         x:        period(day)
 *         category: tims.parent.subdivision[0]
 *         rows:     topk(tims.parent.project, 10, by=sum(tims.time("t")))
 *       }
 *       measure productive = sum(tims.time("t"))
 *       measure total      = sum(tims.duration)
 *       measure ratio      = productive / total
 *     }
 *     plot {
 *       type: bar
 *       x:    x
 *       y:    productive
 *     }
 *   }
 *
 * Expression operator precedence (low → high):
 *   or
 *   and
 *   not (prefix)
 *   comparison: = != < <= > >=, in [...], not in [...], under "...", not under "..."
 *   additive:   + -
 *   multiplicative: * / %
 *   unary:      - (negation)
 *   postfix:    .field  .parent  [n]  [n:m]  .time("x")  .timeUnder("x")
 *   primary:    literal  identifier  (expr)  [array]  call(...)
 */

import {
  tokenize, Token, TokenType, LexError,
} from './lexer';
import type {
  WidgetDef, DataSpec, PlotSpec, SourceDecl,
  GroupDimension, PeriodDimension, AttributeDimension, TopkDimension, PeriodType,
  MeasureDef, PlotType, FormatType,
  Expr, LiteralExpr, PathExpr, TimeExpr, ArrayExpr, CallExpr,
  BinaryExpr, BinaryOp, UnaryExpr, InExpr, UnderExpr, MeasureRefExpr,
  PathSegment,
  ParseResult,
} from './ast';

// ─────────────────────────────────────────────────────────────
// Parse error
// ─────────────────────────────────────────────────────────────

class ParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
  ) {
    super(`[${line}:${col}] ${message}`);
    this.name = 'ParseError';
  }
}

// ─────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  // ── Token navigation ───────────────────────────────────────

  private peek(offset = 0): Token {
    const idx = Math.min(this.pos + offset, this.tokens.length - 1);
    return this.tokens[idx];
  }

  private consume(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType, value?: string): Token {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      const expected = value !== undefined ? `'${value}'` : type;
      throw new ParseError(
        `Expected ${expected} but got '${t.value}' (${t.type})`,
        t.line, t.col,
      );
    }
    return this.consume();
  }

  private match(type: TokenType, value?: string): boolean {
    if (this.check(type, value)) {
      this.consume();
      return true;
    }
    return false;
  }

  private check(type: TokenType, value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }

  private checkIdent(value: string): boolean {
    const t = this.peek();
    return t.type === 'IDENT' && t.value === value;
  }

  // ── Widget ─────────────────────────────────────────────────

  parseWidget(): WidgetDef {
    this.expect('IDENT', 'widget');
    const name = this.expect('STRING').value;

    this.expect('LBRACE');

    let data: DataSpec | null = null;
    let plot: PlotSpec | null = null;

    while (!this.check('RBRACE') && !this.check('EOF')) {
      if (this.checkIdent('data')) {
        this.consume();
        data = this.parseDataSpec();
      } else if (this.checkIdent('plot')) {
        this.consume();
        plot = this.parsePlotSpec();
      } else {
        const t = this.peek();
        throw new ParseError(`Unexpected token '${t.value}' in widget body`, t.line, t.col);
      }
    }

    this.expect('RBRACE');

    if (!data) {
      throw new ParseError(`Widget '${name}' is missing a 'data' section`, 0, 0);
    }
    if (!plot) {
      throw new ParseError(`Widget '${name}' is missing a 'plot' section`, 0, 0);
    }

    return { name, data, plot };
  }

  // ── Data spec ──────────────────────────────────────────────

  private parseDataSpec(): DataSpec {
    this.expect('LBRACE');

    let source: SourceDecl | null = null;
    let where: Expr | null = null;
    const group: GroupDimension[] = [];
    const measures: MeasureDef[] = [];

    while (!this.check('RBRACE') && !this.check('EOF')) {
      if (this.checkIdent('source')) {
        this.consume();
        this.expect('COLON');
        source = this.parseSourceDecl();
      } else if (this.checkIdent('where')) {
        this.consume();
        this.expect('COLON');
        where = this.parseExpr();
      } else if (this.checkIdent('group')) {
        this.consume();
        this.expect('LBRACE');
        while (!this.check('RBRACE') && !this.check('EOF')) {
          group.push(this.parseGroupDimension());
        }
        this.expect('RBRACE');
      } else if (this.checkIdent('measure')) {
        this.consume();
        measures.push(this.parseMeasureDef());
      } else {
        const t = this.peek();
        throw new ParseError(
          `Unexpected token '${t.value}' in data section. Expected: source, where, group, measure`,
          t.line, t.col,
        );
      }
    }

    this.expect('RBRACE');

    if (!source) {
      throw new ParseError(`Data section is missing a 'source' declaration`, 0, 0);
    }
    if (measures.length === 0) {
      throw new ParseError(`Data section must define at least one measure`, 0, 0);
    }

    return { source, where, group, measures };
  }

  private parseSourceDecl(): SourceDecl {
    const codeToken = this.expect('IDENT');
    const definitionCode = codeToken.value.toUpperCase();
    this.expect('IDENT', 'as');
    const alias = this.expect('IDENT').value;
    return { definitionCode, alias };
  }

  // ── Group dimensions ───────────────────────────────────────

  private parseGroupDimension(): GroupDimension {
    // name: period(day) | topk(path, k, by=expr) | path_expr
    const nameToken = this.expect('IDENT');
    const name = nameToken.value;
    this.expect('COLON');

    if (this.checkIdent('period')) {
      return this.parsePeriodDim(name);
    }
    if (this.checkIdent('topk')) {
      return this.parseTopkDim(name);
    }
    // Otherwise, an attribute dimension — expects a path starting with an alias
    const path = this.parsePathExpr();
    return { kind: 'attribute', name, path };
  }

  private parsePeriodDim(name: string): PeriodDimension {
    this.consume(); // 'period'
    this.expect('LPAREN');
    const typeToken = this.expect('IDENT');
    const periodType = this.validatePeriodType(typeToken.value, typeToken);
    this.expect('RPAREN');
    return { kind: 'period', name, periodType };
  }

  private parseTopkDim(name: string): TopkDimension {
    this.consume(); // 'topk'
    this.expect('LPAREN');
    const path = this.parsePathExpr();
    this.expect('COMMA');
    const kToken = this.expect('NUMBER');
    const k = parseInt(kToken.value, 10);
    if (isNaN(k) || k <= 0) {
      throw new ParseError(`topk k must be a positive integer`, kToken.line, kToken.col);
    }
    this.expect('COMMA');
    this.expect('IDENT', 'by');
    this.expect('EQ');
    const by = this.parseExpr();
    this.expect('RPAREN');
    return { kind: 'topk', name, path, k, by };
  }

  // ── Measures ───────────────────────────────────────────────

  private parseMeasureDef(): MeasureDef {
    const nameToken = this.expect('IDENT');
    this.expect('EQ');
    const expr = this.parseExpr();
    return { name: nameToken.value, expr };
  }

  // ── Plot spec ──────────────────────────────────────────────

  private parsePlotSpec(): PlotSpec {
    this.expect('LBRACE');

    let plotType: PlotType | null = null;
    const roles: Record<string, string | string[]> = {};
    const format: Record<string, FormatType> = {};
    const color: Record<string, string> = {};

    while (!this.check('RBRACE') && !this.check('EOF')) {
      if (this.checkIdent('type')) {
        this.consume();
        this.expect('COLON');
        const typeToken = this.expect('IDENT');
        plotType = this.validatePlotType(typeToken.value, typeToken);
      } else if (this.checkIdent('format')) {
        // format { measureName: formatType  ... }
        this.consume();
        this.expect('LBRACE');
        while (!this.check('RBRACE') && !this.check('EOF')) {
          const nameToken = this.expect('IDENT');
          this.expect('COLON');
          const fmtToken = this.expect('IDENT');
          format[nameToken.value] = this.validateFormatType(fmtToken.value, fmtToken);
        }
        this.expect('RBRACE');
      } else if (this.checkIdent('color')) {
        // color { measureName: colorValue  ... }
        // colorValue may be an ident (green, red) or a quoted string ("#3b82f6")
        this.consume();
        this.expect('LBRACE');
        while (!this.check('RBRACE') && !this.check('EOF')) {
          const nameToken = this.expect('IDENT');
          this.expect('COLON');
          const colorVal = this.check('STRING')
            ? this.consume().value
            : this.expect('IDENT').value;
          color[nameToken.value] = colorVal;
        }
        this.expect('RBRACE');
      } else if (this.check('IDENT')) {
        // role: dimensionOrMeasureName   OR   role: [name1, name2, ...]
        const role = this.consume().value;
        this.expect('COLON');
        if (this.check('LBRACKET')) {
          // Array form: [ident, ident, ...]
          this.consume(); // [
          const items: string[] = [];
          while (!this.check('RBRACKET') && !this.check('EOF')) {
            items.push(this.expect('IDENT').value);
            if (this.check('COMMA')) this.consume();
          }
          this.expect('RBRACKET');
          roles[role] = items;
        } else {
          roles[role] = this.expect('IDENT').value;
        }
      } else {
        const t = this.peek();
        throw new ParseError(`Unexpected token '${t.value}' in plot section`, t.line, t.col);
      }
    }

    this.expect('RBRACE');

    if (!plotType) {
      throw new ParseError(`Plot section is missing a 'type' declaration`, 0, 0);
    }

    return { type: plotType, roles, format, color };
  }

  // ── Expressions ────────────────────────────────────────────

  parseExpr(): Expr {
    return this.parseOrExpr();
  }

  private parseOrExpr(): Expr {
    let left = this.parseAndExpr();
    while (this.checkIdent('or')) {
      this.consume();
      const right = this.parseAndExpr();
      left = { kind: 'binary', op: 'or', left, right } satisfies BinaryExpr;
    }
    return left;
  }

  private parseAndExpr(): Expr {
    let left = this.parseNotExpr();
    while (this.checkIdent('and')) {
      this.consume();
      const right = this.parseNotExpr();
      left = { kind: 'binary', op: 'and', left, right } satisfies BinaryExpr;
    }
    return left;
  }

  private parseNotExpr(): Expr {
    if (this.checkIdent('not')) {
      this.consume();
      const arg = this.parseNotExpr();
      return { kind: 'unary', op: 'not', arg } satisfies UnaryExpr;
    }
    return this.parseCmpExpr();
  }

  private parseCmpExpr(): Expr {
    const left = this.parseAddExpr();

    // Simple comparison operators
    const cmpMap: Partial<Record<TokenType, BinaryOp>> = {
      EQ: '=', NEQ: '!=', LT: '<', LTE: '<=', GT: '>', GTE: '>=',
    };
    const op = cmpMap[this.peek().type as TokenType];
    if (op) {
      this.consume();
      const right = this.parseAddExpr();
      return { kind: 'binary', op, left, right } satisfies BinaryExpr;
    }

    // in / not in
    if (this.checkIdent('in')) {
      this.consume();
      const values = this.parseArrayLiteralElements();
      return { kind: 'in', expr: left, values, negated: false } satisfies InExpr;
    }

    // under
    if (this.checkIdent('under')) {
      this.consume();
      const prefix = this.expect('STRING').value;
      return { kind: 'under', expr: left, prefix, negated: false } satisfies UnderExpr;
    }

    // not in / not under — peek ahead
    if (this.checkIdent('not')) {
      const savedPos = this.pos;
      this.consume(); // consume 'not'

      if (this.checkIdent('in')) {
        this.consume();
        const values = this.parseArrayLiteralElements();
        return { kind: 'in', expr: left, values, negated: true } satisfies InExpr;
      }
      if (this.checkIdent('under')) {
        this.consume();
        const prefix = this.expect('STRING').value;
        return { kind: 'under', expr: left, prefix, negated: true } satisfies UnderExpr;
      }

      // Not a comparison — backtrack
      this.pos = savedPos;
    }

    return left;
  }

  private parseAddExpr(): Expr {
    let left = this.parseMulExpr();
    while (true) {
      if (this.check('PLUS')) {
        this.consume();
        left = { kind: 'binary', op: '+', left, right: this.parseMulExpr() };
      } else if (this.check('MINUS')) {
        this.consume();
        left = { kind: 'binary', op: '-', left, right: this.parseMulExpr() };
      } else {
        break;
      }
    }
    return left;
  }

  private parseMulExpr(): Expr {
    let left = this.parseUnaryExpr();
    while (true) {
      if (this.check('STAR')) {
        this.consume();
        left = { kind: 'binary', op: '*', left, right: this.parseUnaryExpr() };
      } else if (this.check('SLASH')) {
        this.consume();
        left = { kind: 'binary', op: '/', left, right: this.parseUnaryExpr() };
      } else if (this.check('PERCENT')) {
        this.consume();
        left = { kind: 'binary', op: '%', left, right: this.parseUnaryExpr() };
      } else {
        break;
      }
    }
    return left;
  }

  private parseUnaryExpr(): Expr {
    if (this.check('MINUS')) {
      this.consume();
      const arg = this.parseUnaryExpr();
      return { kind: 'unary', op: 'neg', arg } satisfies UnaryExpr;
    }
    return this.parsePrimaryExpr();
  }

  private parsePrimaryExpr(): Expr {
    const t = this.peek();

    // Number literal
    if (t.type === 'NUMBER') {
      this.consume();
      return { kind: 'literal', value: parseFloat(t.value) } satisfies LiteralExpr;
    }

    // String literal
    if (t.type === 'STRING') {
      this.consume();
      return { kind: 'literal', value: t.value } satisfies LiteralExpr;
    }

    // Boolean / null keywords
    if (t.type === 'IDENT' && t.value === 'true') {
      this.consume();
      return { kind: 'literal', value: true } satisfies LiteralExpr;
    }
    if (t.type === 'IDENT' && t.value === 'false') {
      this.consume();
      return { kind: 'literal', value: false } satisfies LiteralExpr;
    }
    if (t.type === 'IDENT' && t.value === 'null') {
      this.consume();
      return { kind: 'literal', value: null } satisfies LiteralExpr;
    }

    // Parenthesized expression
    if (t.type === 'LPAREN') {
      this.consume();
      const expr = this.parseExpr();
      this.expect('RPAREN');
      return expr;
    }

    // Array literal
    if (t.type === 'LBRACKET') {
      return { kind: 'array', elements: this.parseArrayLiteralElements() } satisfies ArrayExpr;
    }

    // Identifier: function call, path, or measure reference
    if (t.type === 'IDENT') {
      this.consume();
      const name = t.value;

      // Function call: name(...)
      if (this.check('LPAREN')) {
        return this.parseFunctionCall(name, t);
      }

      // Path continuation: name.field or name[n]
      if (this.check('DOT') || this.check('LBRACKET')) {
        return this.continuePathOrTimeExpr(name);
      }

      // Bare identifier: either a measure reference or keyword used as value.
      // We emit a measure_ref; the analyzer will validate it.
      return { kind: 'measure_ref', name } satisfies MeasureRefExpr;
    }

    throw new ParseError(
      `Unexpected token '${t.value}' (${t.type}) in expression`,
      t.line, t.col,
    );
  }

  // ── Path expressions ───────────────────────────────────────

  /**
   * Parse a full path expression starting from the next IDENT token.
   * Used in group dimension declarations and topk.
   */
  private parsePathExpr(): PathExpr {
    const t = this.expect('IDENT');
    const result = this.continuePathOrTimeExpr(t.value);
    if (result.kind !== 'path') {
      throw new ParseError(
        `Expected a path expression but got a .time() / .timeUnder() access`,
        t.line, t.col,
      );
    }
    return result;
  }

  /**
   * Given a leading identifier name, continue consuming path segments.
   * Detects .time("label") and .timeUnder("label") and converts to TimeExpr.
   * Returns PathExpr or TimeExpr.
   */
  private continuePathOrTimeExpr(firstName: string): PathExpr | TimeExpr {
    const segments: PathSegment[] = [{ kind: 'field', name: firstName }];

    while (true) {
      if (this.check('DOT')) {
        this.consume(); // consume '.'
        const next = this.peek();

        // .parent
        if (next.type === 'IDENT' && next.value === 'parent') {
          this.consume();
          segments.push({ kind: 'parent' });
          continue;
        }

        // .time("label") or .timeUnder("label")
        if (next.type === 'IDENT' && (next.value === 'time' || next.value === 'timeUnder')) {
          const hierarchical = next.value === 'timeUnder';
          this.consume();
          this.expect('LPAREN');
          const label = this.expect('STRING').value;
          this.expect('RPAREN');
          const path: PathExpr = { kind: 'path', segments };
          return { kind: 'time', path, label, hierarchical } satisfies TimeExpr;
        }

        // .fieldName
        if (next.type === 'IDENT') {
          this.consume();
          segments.push({ kind: 'field', name: next.value });
          continue;
        }

        throw new ParseError(
          `Expected field name after '.', got '${next.value}'`,
          next.line, next.col,
        );
      }

      if (this.check('LBRACKET')) {
        this.consume(); // consume '['
        const idx = this.parseIndexOrSlice();
        segments.push(idx);
        continue;
      }

      break;
    }

    return { kind: 'path', segments } satisfies PathExpr;
  }

  /**
   * Parse the content of [...] — either an index [n] or a slice [n:m] / [n:] / [:m] / [:]
   */
  private parseIndexOrSlice(): PathSegment {
    const t = this.peek();

    // [:m] or [:]
    if (t.type === 'COLON') {
      this.consume();
      if (this.check('RBRACKET')) {
        this.consume();
        return { kind: 'slice', start: null, end: null };
      }
      const end = parseInt(this.expect('NUMBER').value, 10);
      this.expect('RBRACKET');
      return { kind: 'slice', start: null, end };
    }

    // [n] or [n:m] or [n:]
    if (t.type === 'NUMBER') {
      const n = parseInt(t.value, 10);
      this.consume();

      if (this.check('COLON')) {
        this.consume();
        if (this.check('RBRACKET')) {
          this.consume();
          return { kind: 'slice', start: n, end: null };
        }
        const end = parseInt(this.expect('NUMBER').value, 10);
        this.expect('RBRACKET');
        return { kind: 'slice', start: n, end };
      }

      this.expect('RBRACKET');
      return { kind: 'index', index: n };
    }

    throw new ParseError(
      `Expected number or ':' inside [...], got '${t.value}'`,
      t.line, t.col,
    );
  }

  // ── Function calls ─────────────────────────────────────────

  private parseFunctionCall(name: string, nameTok: Token): CallExpr {
    this.expect('LPAREN');

    const args: Expr[] = [];
    const namedArgs: Record<string, Expr> = {};

    if (!this.check('RPAREN')) {
      do {
        // Named arg: ident = expr
        if (this.check('IDENT') && this.peek(1).type === 'EQ') {
          const argName = this.consume().value;
          this.consume(); // =
          namedArgs[argName] = this.parseExpr();
        } else {
          args.push(this.parseExpr());
        }
      } while (this.match('COMMA') && !this.check('RPAREN'));
    }

    this.expect('RPAREN');

    return { kind: 'call', fn: name, args, namedArgs } satisfies CallExpr;
  }

  // ── Array literals ─────────────────────────────────────────

  private parseArrayLiteralElements(): Expr[] {
    this.expect('LBRACKET');
    const elements: Expr[] = [];

    if (!this.check('RBRACKET')) {
      elements.push(this.parseExpr());
      while (this.match('COMMA')) {
        if (this.check('RBRACKET')) break; // trailing comma OK
        elements.push(this.parseExpr());
      }
    }

    this.expect('RBRACKET');
    return elements;
  }

  // ── Validation helpers ─────────────────────────────────────

  private validatePeriodType(value: string, token: Token): PeriodType {
    const valid: PeriodType[] = [
      'hour', 'day', 'week', 'month',
      'weekday', 'day_of_month', 'month_of_year',
    ];
    if (valid.includes(value as PeriodType)) return value as PeriodType;
    throw new ParseError(
      `Invalid period type '${value}'. Valid types: ${valid.join(', ')}`,
      token.line, token.col,
    );
  }

  private validatePlotType(value: string, token: Token): PlotType {
    const valid: PlotType[] = ['kpi', 'bar', 'stacked_bar', 'line', 'donut', 'hbar', 'ranked_list', 'table'];
    if (valid.includes(value as PlotType)) return value as PlotType;
    throw new ParseError(
      `Invalid plot type '${value}'. Valid types: ${valid.join(', ')}`,
      token.line, token.col,
    );
  }

  private validateFormatType(value: string, token: Token): FormatType {
    const valid: FormatType[] = ['number', 'float', 'duration'];
    if (valid.includes(value as FormatType)) return value as FormatType;
    throw new ParseError(
      `Invalid format type '${value}'. Valid types: ${valid.join(', ')}`,
      token.line, token.col,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Parse a widget DSL string into a WidgetDef AST.
 * Returns ParseResult with ok=true on success or ok=false with error details.
 */
export function parseWidgetDef(source: string): ParseResult {
  try {
    const tokens = tokenize(source);
    const parser = new Parser(tokens);
    const widget = parser.parseWidget();
    return { ok: true, widget };
  } catch (e) {
    if (e instanceof ParseError) {
      return { ok: false, error: e.message, line: e.line, col: e.col };
    }
    if (e instanceof LexError) {
      return { ok: false, error: e.message, line: e.line, col: e.col };
    }
    return { ok: false, error: String(e) };
  }
}
