/**
 * Widget Expression Evaluator
 *
 * Evaluates widget expressions over collections of loaded entries.
 * Supports aggregation functions (sum, avg, count) and arithmetic.
 *
 * Key difference from formula engine:
 * - Formula engine operates on single entries (self.field)
 * - Widget evaluator operates on collections (alias.field, sum(alias.field))
 *
 * Supported expressions:
 * - sum(alias.field)
 * - avg(alias.field)
 * - count(alias)
 * - sum(alias.time("t"))  -- for TIM collections
 * - arithmetic: +, -, *, /
 * - parentheses
 */

import { LoadedEntry, WidgetEvaluationContext } from './types';

// Valid time_type base categories for TIM entries
const VALID_TIME_BASES = new Set(['t', 'm', 'p', 'n']);

/**
 * Evaluation result type
 */
type EvalResult =
  | { success: true; value: number }
  | { success: false; error: string };

/**
 * Intermediate value types during evaluation
 * - number: scalar result
 * - number[]: array of values (from field access before aggregation)
 */
type IntermediateValue = number | number[];

/**
 * Evaluate a widget expression
 *
 * @param expression - The expression string
 * @param ctx - Evaluation context with datasets
 * @returns Evaluation result
 */
export function evaluateWidgetExpression(
  expression: string,
  ctx: WidgetEvaluationContext
): EvalResult {
  try {
    const tokens = tokenize(expression);
    const result = parseExpression(tokens, ctx);
    if (!result.success) {
      return result;
    }

    // Final result must be a scalar
    if (Array.isArray(result.value)) {
      return {
        success: false,
        error: `Expression must evaluate to a scalar, got array of ${result.value.length} values`,
      };
    }

    return { success: true, value: result.value };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Tokenize expression string
 */
function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;

  while (i < expression.length) {
    const char = expression[i];

    // Skip whitespace
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      i++;
      continue;
    }

    // Single-char operators and delimiters
    if ('()[].,'.includes(char)) {
      if (current) tokens.push(current);
      tokens.push(char);
      current = '';
      i++;
      continue;
    }

    // Operators
    if ('+-*/%'.includes(char)) {
      if (current) tokens.push(current);
      tokens.push(char);
      current = '';
      i++;
      continue;
    }

    // Handle quoted strings
    if (char === '"') {
      if (current) tokens.push(current);
      current = '"';
      i++;
      while (i < expression.length && expression[i] !== '"') {
        current += expression[i];
        i++;
      }
      current += '"';
      tokens.push(current);
      current = '';
      i++;
      continue;
    }

    current += char;
    i++;
  }

  if (current) tokens.push(current);
  return tokens;
}

/**
 * Parse and evaluate expression
 */
function parseExpression(
  tokens: string[],
  ctx: WidgetEvaluationContext
): { success: true; value: IntermediateValue } | { success: false; error: string } {
  let pos = 0;

  function parseAddSub(): { success: true; value: IntermediateValue } | { success: false; error: string } {
    let leftResult = parseMulDiv();
    if (!leftResult.success) return leftResult;
    let left = leftResult.value;

    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos];
      pos++;
      const rightResult = parseMulDiv();
      if (!rightResult.success) return rightResult;
      const right = rightResult.value;

      const opResult = applyOperator(left, op, right);
      if (!opResult.success) return opResult;
      left = opResult.value;
    }

    return { success: true, value: left };
  }

  function parseMulDiv(): { success: true; value: IntermediateValue } | { success: false; error: string } {
    let leftResult = parseUnary();
    if (!leftResult.success) return leftResult;
    let left = leftResult.value;

    while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/' || tokens[pos] === '%')) {
      const op = tokens[pos];
      pos++;
      const rightResult = parseUnary();
      if (!rightResult.success) return rightResult;
      const right = rightResult.value;

      const opResult = applyOperator(left, op, right);
      if (!opResult.success) return opResult;
      left = opResult.value;
    }

    return { success: true, value: left };
  }

  function parseUnary(): { success: true; value: IntermediateValue } | { success: false; error: string } {
    if (tokens[pos] === '-') {
      pos++;
      const result = parseUnary();
      if (!result.success) return result;
      const val = result.value;
      if (Array.isArray(val)) {
        return { success: true, value: val.map((v) => -v) };
      }
      return { success: true, value: -val };
    }
    return parsePostfix();
  }

  function parsePostfix(): { success: true; value: IntermediateValue } | { success: false; error: string } {
    let result = parsePrimary();
    if (!result.success) return result;
    let value = result.value;

    // Handle postfix operations: .field, .time("base")
    while (pos < tokens.length && tokens[pos] === '.') {
      pos++; // consume '.'
      const fieldName = tokens[pos];
      pos++;

      // Check for method call: .time("base")
      if (fieldName === 'time' && tokens[pos] === '(') {
        pos++; // consume '('
        const argToken = tokens[pos];
        pos++; // consume argument

        if (!argToken || !argToken.startsWith('"') || !argToken.endsWith('"')) {
          return {
            success: false,
            error: 'time() requires a quoted string argument, e.g. time("t")',
          };
        }

        const base = argToken.slice(1, -1);

        if (tokens[pos] !== ')') {
          return {
            success: false,
            error: 'Expected ) after time() argument',
          };
        }
        pos++; // consume ')'

        // Apply time method to collection
        const timeResult = evaluateTimeOnCollection(value, base, ctx);
        if (!timeResult.success) return timeResult;
        value = timeResult.value;
        continue;
      }

      // Regular field access
      const accessResult = accessField(value, fieldName, ctx);
      if (!accessResult.success) return accessResult;
      value = accessResult.value;
    }

    return { success: true, value };
  }

  function parsePrimary(): { success: true; value: IntermediateValue } | { success: false; error: string } {
    const token = tokens[pos];

    // Parenthesized expression
    if (token === '(') {
      pos++;
      const result = parseAddSub();
      if (!result.success) return result;
      if (tokens[pos] !== ')') {
        return { success: false, error: 'Expected )' };
      }
      pos++;
      return result;
    }

    // Number literal
    if (/^-?\d+(\.\d+)?$/.test(token)) {
      pos++;
      return { success: true, value: parseFloat(token) };
    }

    // Aggregation functions
    if (['sum', 'avg', 'count'].includes(token)) {
      const fn = token;
      pos++;
      if (tokens[pos] !== '(') {
        return { success: false, error: `Expected ( after ${fn}` };
      }
      pos++;
      const argResult = parseAddSub();
      if (!argResult.success) return argResult;
      if (tokens[pos] !== ')') {
        return { success: false, error: `Expected ) after ${fn} argument` };
      }
      pos++;
      return applyAggregation(fn, argResult.value);
    }

    // Dataset alias reference
    if (ctx.datasets.has(token)) {
      pos++;
      // Return a marker that represents the collection
      // We use a special array format where the first element is a marker
      const entries = ctx.datasets.get(token)!;
      // Store entries as a number array (placeholder) for now
      // The actual values will be extracted via field access
      return { success: true, value: entries.map((_, i) => i) as number[] };
    }

    // Unknown token
    pos++;
    return { success: false, error: `Unknown token: ${token}` };
  }

  return parseAddSub();
}

/**
 * Apply arithmetic operator
 */
function applyOperator(
  left: IntermediateValue,
  op: string,
  right: IntermediateValue
): { success: true; value: IntermediateValue } | { success: false; error: string } {
  // Both must be scalars for arithmetic in widget context
  if (Array.isArray(left) || Array.isArray(right)) {
    return {
      success: false,
      error: 'Arithmetic operations require scalar values. Use sum(), avg(), or count() to aggregate first.',
    };
  }

  const l = left as number;
  const r = right as number;

  switch (op) {
    case '+':
      return { success: true, value: l + r };
    case '-':
      return { success: true, value: l - r };
    case '*':
      return { success: true, value: l * r };
    case '/':
      if (r === 0) {
        return { success: false, error: 'Division by zero' };
      }
      return { success: true, value: l / r };
    case '%':
      if (r === 0) {
        return { success: false, error: 'Modulo by zero' };
      }
      return { success: true, value: l % r };
    default:
      return { success: false, error: `Unknown operator: ${op}` };
  }
}

/**
 * Apply aggregation function
 */
function applyAggregation(
  fn: string,
  values: IntermediateValue
): { success: true; value: number } | { success: false; error: string } {
  if (!Array.isArray(values)) {
    // Single value - treat as array of one
    values = [values];
  }

  const nums = values.filter((v): v is number => typeof v === 'number' && !isNaN(v));

  if (nums.length === 0) {
    // Return 0 for empty collections
    return { success: true, value: 0 };
  }

  switch (fn) {
    case 'sum':
      return { success: true, value: nums.reduce((a, b) => a + b, 0) };
    case 'avg':
      return { success: true, value: nums.reduce((a, b) => a + b, 0) / nums.length };
    case 'count':
      return { success: true, value: nums.length };
    default:
      return { success: false, error: `Unknown aggregation function: ${fn}` };
  }
}

/**
 * Access field on collection
 *
 * When accessing a field on a collection (array), returns array of field values.
 */
function accessField(
  value: IntermediateValue,
  fieldName: string,
  ctx: WidgetEvaluationContext
): { success: true; value: IntermediateValue } | { success: false; error: string } {
  // If value is an array (collection indices), get field values from entries
  if (Array.isArray(value)) {
    // Find which dataset this came from
    // For MVP, we assume there's only one dataset
    const [alias] = ctx.datasets.keys();
    const entries = ctx.datasets.get(alias);

    if (!entries) {
      return { success: false, error: `No dataset found` };
    }

    // Extract field values from all entries
    const fieldValues: number[] = [];
    for (const entry of entries) {
      const val = entry.attributes.get(fieldName);
      if (typeof val === 'number') {
        fieldValues.push(val);
      } else if (val !== null && val !== undefined) {
        // Try to convert to number
        const num = Number(val);
        if (!isNaN(num)) {
          fieldValues.push(num);
        }
      }
    }

    return { success: true, value: fieldValues };
  }

  return { success: false, error: `Cannot access field "${fieldName}" on scalar value` };
}

/**
 * Evaluate time() method on a collection of TIM entries
 *
 * For a collection of TIM entries, this sums the time values for the given base
 * across ALL entries in the collection.
 *
 * Example: sum(tims.time("t")) returns the sum of all 't' time values across all TIM entries
 */
function evaluateTimeOnCollection(
  value: IntermediateValue,
  base: string,
  ctx: WidgetEvaluationContext
): { success: true; value: number[] } | { success: false; error: string } {
  // Validate base
  if (!VALID_TIME_BASES.has(base)) {
    return {
      success: false,
      error: `Invalid time base "${base}". Must be one of: t, m, p, n`,
    };
  }

  // Must be a collection
  if (!Array.isArray(value)) {
    return {
      success: false,
      error: 'time() can only be called on a collection of TIM entries',
    };
  }

  // Get the dataset entries
  const [alias] = ctx.datasets.keys();
  const entries = ctx.datasets.get(alias);

  if (!entries) {
    return { success: false, error: 'No dataset found' };
  }

  // For each entry, get the time value for the base
  const timeValues: number[] = [];

  for (const entry of entries) {
    if (!entry.timeValues) {
      timeValues.push(0);
      continue;
    }

    // Sum values matching the base (exact match or prefix match)
    let sum = 0;
    for (const [subdivision, val] of entry.timeValues.entries()) {
      if (subdivision === base || subdivision.startsWith(base + '/')) {
        sum += val;
      }
    }
    timeValues.push(sum);
  }

  return { success: true, value: timeValues };
}
