/**
 * Formula Engine
 *
 * This module provides generic formula evaluation for computed fields.
 * The engine supports:
 * - Arithmetic operators (+, -, *, /, //, %, ^)
 * - Aggregation functions (sum, avg, min, max, count)
 * - Field navigation (self.field, parent.field)
 * - Context variables (self, parent, root, path, division, subdivision)
 * - List operations and broadcasting
 *
 * TODO: Domain-specific helpers (e.g., TIM time()) should be registered
 * by their domain modules rather than hardcoded here. The formula engine
 * itself must remain generic and only execute registered semantic helpers.
 * Current domain extensions:
 * - time(base): TIM timing aggregation (bases: t, m, p, n)
 */
import {
  PipelineState,
  PipelineResult,
  ResolvedEntry,
  createSuccess,
  createError,
  getAttributeValue,
} from './types';

type FormulaValue = number | number[] | string | string[] | boolean | boolean[] | null;
type EvaluableValue = FormulaValue | ResolvedEntry | ResolvedEntry[] | FormulaValue[];

interface EvaluationContext {
  self: ResolvedEntry;
  parent: ResolvedEntry | null;
  root: ResolvedEntry;
  state: PipelineState;
  fieldValues: Map<string, FormulaValue>;
}

function tokenize(formula: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;

  while (i < formula.length) {
    const char = formula[i];

    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      i++;
      continue;
    }

    if ('()[].,'.includes(char)) {
      if (current) tokens.push(current);
      tokens.push(char);
      current = '';
      i++;
      continue;
    }

    if ('+-*/%^'.includes(char)) {
      if (current) tokens.push(current);
      tokens.push(char);
      current = '';
      i++;
      continue;
    }

    if (char === '/' && formula[i + 1] === '/') {
      if (current) tokens.push(current);
      tokens.push('//');
      current = '';
      i += 2;
      continue;
    }

    if (char === '=' && formula[i + 1] === '=') {
      if (current) tokens.push(current);
      tokens.push('==');
      current = '';
      i += 2;
      continue;
    }

    if (char === '"') {
      if (current) tokens.push(current);
      current = '"';
      i++;
      while (i < formula.length && formula[i] !== '"') {
        current += formula[i];
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

function isResolvedEntry(value: unknown): value is ResolvedEntry {
  return (
    value !== null &&
    typeof value === 'object' &&
    'entry' in value &&
    'children' in value
  );
}

// Valid time_type base categories for TIM entries
const VALID_TIME_BASES = new Set(['t', 'm', 'p', 'n']);

function isResolvedEntryArray(value: unknown): value is ResolvedEntry[] {
  return Array.isArray(value) && value.length > 0 && isResolvedEntry(value[0]);
}

function getFieldValue(
  entry: ResolvedEntry,
  fieldName: string,
  state: PipelineState
): EvaluableValue {
  const { context } = state;
  const { fieldsByMetric, definitions } = context;

  const definition = definitions.get(entry.entry.definitionId);
  if (!definition || definition.type !== 'metric') return null;

  const fields = fieldsByMetric.get(definition.id) || [];
  const targetField = fields.find((f) => f.name === fieldName);
  if (!targetField) return null;

  const matchingChildren = entry.children.filter((c) => c.fieldId === targetField.id);

  if (matchingChildren.length === 0) return null;

  const values: EvaluableValue[] = [];
  for (const child of matchingChildren) {
    if (child.attributeEntry) {
      const val = getAttributeValue(child.attributeEntry);
      values.push(val as FormulaValue);
    } else if (child.metricEntry) {
      values.push(child);
    }
  }

  if (values.length === 1) return values[0];

  if (values.every((v) => isResolvedEntry(v))) {
    return values as ResolvedEntry[];
  }

  return values as FormulaValue[];
}

function navigateField(
  value: EvaluableValue,
  fieldName: string,
  state: PipelineState
): EvaluableValue {
  if (value === null) return null;

  if (isResolvedEntryArray(value)) {
    const results: EvaluableValue[] = [];
    for (const item of value) {
      const nav = getFieldValue(item, fieldName, state);
      if (isResolvedEntryArray(nav)) {
        results.push(...nav);
      } else if (Array.isArray(nav)) {
        results.push(...(nav as FormulaValue[]));
      } else {
        results.push(nav);
      }
    }
    if (results.length === 1) return results[0];
    if (results.every((v) => isResolvedEntry(v))) {
      return results as ResolvedEntry[];
    }
    return results as FormulaValue[];
  }

  if (isResolvedEntry(value)) {
    return getFieldValue(value, fieldName, state);
  }

  return null;
}

function toFormulaValue(value: EvaluableValue): FormulaValue {
  if (value === null) return null;
  if (isResolvedEntry(value) || isResolvedEntryArray(value)) {
    return null;
  }
  return value as FormulaValue;
}

// =============================================================================
// Domain-Specific Helpers
// =============================================================================
// TODO: These helpers should be moved to a registry pattern where domain modules
// register their own semantic helpers. The formula engine would then look up
// and invoke registered helpers by name, keeping the core engine generic.
// =============================================================================

/**
 * TIM Domain Helper: self.time(base)
 *
 * Evaluates self.time(base) for TIM entries.
 * Returns the SUM of all time_type values whose subdivision starts with the base.
 * Valid bases: t, m, p, n
 * Returns 0 if no matching values found.
 */
function evaluateTimeMethod(
  entry: ResolvedEntry,
  base: string,
  state: PipelineState
): PipelineResult<number> {
  // Validate base
  if (!VALID_TIME_BASES.has(base)) {
    return createError({
      type: 'FORMULA_ERROR',
      message: `Invalid time base "${base}". Must be one of: t, m, p, n`,
      fieldId: '',
      formula: '',
    });
  }

  const { context } = state;
  const { fieldsByMetric, definitions } = context;

  const definition = definitions.get(entry.entry.definitionId);
  if (!definition || definition.type !== 'metric') {
    return createError({
      type: 'FORMULA_ERROR',
      message: 'time() can only be called on metric entries',
      fieldId: '',
      formula: '',
    });
  }

  // Find the time_type field
  const fields = fieldsByMetric.get(definition.id) || [];
  const timeTypeField = fields.find((f) => f.name === 'time_type');

  if (!timeTypeField) {
    // Entry doesn't have time_type field - return 0
    return createSuccess(0);
  }

  // Find all children with time_type field and matching subdivision
  let sum = 0;
  for (const child of entry.children) {
    if (child.fieldId !== timeTypeField.id) continue;
    if (!child.attributeEntry) continue;

    const subdivision = child.entry.subdivision || '';
    // Match if subdivision equals base or starts with base/
    if (subdivision === base || subdivision.startsWith(base + '/')) {
      const value = child.attributeEntry.valueInt;
      if (value !== null) {
        sum += value;
      }
    }
  }

  return createSuccess(sum);
}

function applyOperator(
  left: FormulaValue,
  op: string,
  right: FormulaValue
): PipelineResult<FormulaValue> {
  if (left === null || right === null) {
    return createSuccess(null);
  }

  const leftArr = Array.isArray(left);
  const rightArr = Array.isArray(right);

  if (!leftArr && !rightArr) {
    return applyScalarOp(left as number, op, right as number);
  }

  if (leftArr && rightArr) {
    const leftNums = left as number[];
    const rightNums = right as number[];
    if (leftNums.length !== rightNums.length) {
      return createError({
        type: 'FORMULA_ERROR',
        message: `List length mismatch: ${leftNums.length} vs ${rightNums.length}`,
        fieldId: '',
        formula: '',
      });
    }
    const results: number[] = [];
    for (let i = 0; i < leftNums.length; i++) {
      const res = applyScalarOp(leftNums[i], op, rightNums[i]);
      if (!res.success) return res;
      results.push(res.value as number);
    }
    return createSuccess(results);
  }

  if (leftArr) {
    const leftNums = left as number[];
    const rightNum = right as number;
    const results: number[] = [];
    for (const l of leftNums) {
      const res = applyScalarOp(l, op, rightNum);
      if (!res.success) return res;
      results.push(res.value as number);
    }
    return createSuccess(results);
  }

  const leftNum = left as number;
  const rightNums = right as number[];
  const results: number[] = [];
  for (const r of rightNums) {
    const res = applyScalarOp(leftNum, op, r);
    if (!res.success) return res;
    results.push(res.value as number);
  }
  return createSuccess(results);
}

function applyScalarOp(left: number, op: string, right: number): PipelineResult<number> {
  switch (op) {
    case '+':
      return createSuccess(left + right);
    case '-':
      return createSuccess(left - right);
    case '*':
      return createSuccess(left * right);
    case '/':
      if (right === 0) {
        return createError({
          type: 'FORMULA_ERROR',
          message: 'Division by zero',
          fieldId: '',
          formula: '',
        });
      }
      return createSuccess(left / right);
    case '//':
      if (right === 0) {
        return createError({
          type: 'FORMULA_ERROR',
          message: 'Division by zero',
          fieldId: '',
          formula: '',
        });
      }
      return createSuccess(Math.floor(left / right));
    case '%':
      if (right === 0) {
        return createError({
          type: 'FORMULA_ERROR',
          message: 'Modulo by zero',
          fieldId: '',
          formula: '',
        });
      }
      return createSuccess(left % right);
    case '^':
      return createSuccess(Math.pow(left, right));
    default:
      return createError({
        type: 'FORMULA_ERROR',
        message: `Unknown operator: ${op}`,
        fieldId: '',
        formula: '',
      });
  }
}

function applyAggregation(fn: string, values: FormulaValue): PipelineResult<number> {
  if (values === null) {
    return createError({
      type: 'FORMULA_ERROR',
      message: `Cannot apply ${fn} to null`,
      fieldId: '',
      formula: '',
    });
  }

  const nums: number[] = Array.isArray(values) ? (values as number[]) : [values as number];

  if (nums.length === 0) {
    return createError({
      type: 'FORMULA_ERROR',
      message: `Cannot apply ${fn} to empty list`,
      fieldId: '',
      formula: '',
    });
  }

  switch (fn) {
    case 'sum':
      return createSuccess(nums.reduce((a, b) => a + b, 0));
    case 'avg':
      return createSuccess(nums.reduce((a, b) => a + b, 0) / nums.length);
    case 'min':
      return createSuccess(Math.min(...nums));
    case 'max':
      return createSuccess(Math.max(...nums));
    case 'count':
      return createSuccess(nums.length);
    default:
      return createError({
        type: 'FORMULA_ERROR',
        message: `Unknown aggregation function: ${fn}`,
        fieldId: '',
        formula: '',
      });
  }
}

function evaluateExpression(
  tokens: string[],
  ctx: EvaluationContext
): PipelineResult<FormulaValue> {
  if (tokens.length === 0) {
    return createSuccess(null);
  }

  let pos = 0;

  function parseExpression(): PipelineResult<EvaluableValue> {
    return parseAddSub();
  }

  function parseAddSub(): PipelineResult<EvaluableValue> {
    let leftResult = parseMulDiv();
    if (!leftResult.success) return leftResult;
    let left = leftResult.value;

    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos];
      pos++;
      const rightResult = parseMulDiv();
      if (!rightResult.success) return rightResult;
      const opResult = applyOperator(toFormulaValue(left), op, toFormulaValue(rightResult.value));
      if (!opResult.success) return opResult;
      left = opResult.value;
    }

    return createSuccess(left);
  }

  function parseMulDiv(): PipelineResult<EvaluableValue> {
    let leftResult = parsePower();
    if (!leftResult.success) return leftResult;
    let left = leftResult.value;

    while (
      pos < tokens.length &&
      (tokens[pos] === '*' || tokens[pos] === '/' || tokens[pos] === '//' || tokens[pos] === '%')
    ) {
      const op = tokens[pos];
      pos++;
      const rightResult = parsePower();
      if (!rightResult.success) return rightResult;
      const opResult = applyOperator(toFormulaValue(left), op, toFormulaValue(rightResult.value));
      if (!opResult.success) return opResult;
      left = opResult.value;
    }

    return createSuccess(left);
  }

  function parsePower(): PipelineResult<EvaluableValue> {
    let baseResult = parseUnary();
    if (!baseResult.success) return baseResult;
    let base = baseResult.value;

    while (pos < tokens.length && tokens[pos] === '^') {
      pos++;
      const expResult = parseUnary();
      if (!expResult.success) return expResult;
      const opResult = applyOperator(toFormulaValue(base), '^', toFormulaValue(expResult.value));
      if (!opResult.success) return opResult;
      base = opResult.value;
    }

    return createSuccess(base);
  }

  function parseUnary(): PipelineResult<EvaluableValue> {
    if (tokens[pos] === '-') {
      pos++;
      const result = parseUnary();
      if (!result.success) return result;
      const val = toFormulaValue(result.value);
      if (Array.isArray(val)) {
        return createSuccess((val as number[]).map((v) => -v));
      }
      return createSuccess(-(val as number));
    }
    return parsePostfix();
  }

  function parsePostfix(): PipelineResult<EvaluableValue> {
    let result = parsePrimary();
    if (!result.success) return result;
    let value: EvaluableValue = result.value;

    while (pos < tokens.length) {
      if (tokens[pos] === '.') {
        pos++;
        const fieldName = tokens[pos];
        pos++;

        if (fieldName === 'where' && tokens[pos] === '(') {
          pos++;
          const filterResult = parseWhereClause(value);
          if (!filterResult.success) return filterResult;
          value = filterResult.value;
          continue;
        }

        // Handle self.time("base") method for TIM entries
        if (fieldName === 'time' && tokens[pos] === '(') {
          pos++; // consume '('
          const argToken = tokens[pos];
          pos++; // consume argument

          // Validate argument is a quoted string
          if (!argToken || !argToken.startsWith('"') || !argToken.endsWith('"')) {
            return createError({
              type: 'FORMULA_ERROR',
              message: 'time() requires a quoted string argument, e.g. time("t")',
              fieldId: '',
              formula: '',
            });
          }

          const base = argToken.slice(1, -1); // Remove quotes

          if (tokens[pos] !== ')') {
            return createError({
              type: 'FORMULA_ERROR',
              message: 'Expected ) after time() argument',
              fieldId: '',
              formula: '',
            });
          }
          pos++; // consume ')'

          if (!isResolvedEntry(value)) {
            return createError({
              type: 'FORMULA_ERROR',
              message: 'time() can only be called on a metric entry (e.g., self.time("t"))',
              fieldId: '',
              formula: '',
            });
          }

          const timeResult = evaluateTimeMethod(value, base, ctx.state);
          if (!timeResult.success) return timeResult;
          value = timeResult.value;
          continue;
        }

        value = navigateField(value, fieldName, ctx.state);
      } else if (tokens[pos] === '[') {
        pos++;
        const indexResult = parseExpression();
        if (!indexResult.success) return indexResult;
        if (tokens[pos] !== ']') {
          return createError({
            type: 'FORMULA_ERROR',
            message: 'Expected ]',
            fieldId: '',
            formula: '',
          });
        }
        pos++;
        const index = toFormulaValue(indexResult.value) as number;
        if (Array.isArray(value)) {
          if (index < 0 || index >= (value as unknown[]).length) {
            return createError({
              type: 'FORMULA_ERROR',
              message: `Index ${index} out of bounds for array of length ${(value as unknown[]).length}`,
              fieldId: '',
              formula: '',
            });
          }
          value = (value as EvaluableValue[])[index];
        } else if (typeof value === 'string') {
          const parts = value.split('/');
          if (index < 0 || index >= parts.length) {
            return createError({
              type: 'FORMULA_ERROR',
              message: `Index ${index} out of bounds for hierarchy of length ${parts.length}`,
              fieldId: '',
              formula: '',
            });
          }
          value = parts[index];
        }
      } else {
        break;
      }
    }

    return createSuccess(value);
  }

  function parseWhereClause(list: EvaluableValue): PipelineResult<EvaluableValue> {
    if (!isResolvedEntryArray(list)) {
      return createError({
        type: 'FORMULA_ERROR',
        message: 'where() can only be applied to entry lists',
        fieldId: '',
        formula: '',
      });
    }

    const entries = list;
    const filtered: ResolvedEntry[] = [];

    let depth = 1;
    const conditionTokens: string[] = [];
    while (pos < tokens.length && depth > 0) {
      if (tokens[pos] === '(') depth++;
      else if (tokens[pos] === ')') {
        depth--;
        if (depth === 0) {
          pos++;
          break;
        }
      }
      conditionTokens.push(tokens[pos]);
      pos++;
    }

    const inIndex = conditionTokens.findIndex((t) => t === 'in');
    if (inIndex !== -1 && conditionTokens[0] === 'subdivision') {
      const prefix = conditionTokens[inIndex + 1]?.replace(/"/g, '') || '';
      for (const entry of entries) {
        const subdivision = entry.entry.subdivision || '';
        if (subdivision === prefix || subdivision.startsWith(prefix + '/')) {
          filtered.push(entry);
        }
      }
    }

    return createSuccess(filtered);
  }

  function parsePrimary(): PipelineResult<EvaluableValue> {
    const token = tokens[pos];

    if (token === '(') {
      pos++;
      const result = parseExpression();
      if (!result.success) return result;
      if (tokens[pos] !== ')') {
        return createError({
          type: 'FORMULA_ERROR',
          message: 'Expected )',
          fieldId: '',
          formula: '',
        });
      }
      pos++;
      return result;
    }

    if (/^-?\d+(\.\d+)?$/.test(token)) {
      pos++;
      return createSuccess(parseFloat(token));
    }

    if (token.startsWith('"') && token.endsWith('"')) {
      pos++;
      return createSuccess(token.slice(1, -1));
    }

    if (['sum', 'avg', 'min', 'max', 'count'].includes(token)) {
      const fn = token;
      pos++;
      if (tokens[pos] !== '(') {
        return createError({
          type: 'FORMULA_ERROR',
          message: `Expected ( after ${fn}`,
          fieldId: '',
          formula: '',
        });
      }
      pos++;
      const argResult = parseExpression();
      if (!argResult.success) return argResult;
      if (tokens[pos] !== ')') {
        return createError({
          type: 'FORMULA_ERROR',
          message: `Expected ) after ${fn} argument`,
          fieldId: '',
          formula: '',
        });
      }
      pos++;
      return applyAggregation(fn, toFormulaValue(argResult.value));
    }

    if (token === 'self') {
      pos++;
      return createSuccess(ctx.self);
    }

    if (token === 'parent') {
      pos++;
      return createSuccess(ctx.parent);
    }

    if (token === 'root') {
      pos++;
      return createSuccess(ctx.root);
    }

    if (token === 'path') {
      pos++;
      return createSuccess(ctx.state.path.join('/'));
    }

    if (token === 'division') {
      pos++;
      return createSuccess(ctx.state.division.join('/'));
    }

    if (token === 'subdivision') {
      pos++;
      return createSuccess(ctx.state.subdivision.join('/'));
    }

    pos++;
    return createSuccess(null);
  }

  const result = parseExpression();
  if (!result.success) return result;
  return createSuccess(toFormulaValue(result.value));
}

export function evaluateFormula(
  formula: string,
  self: ResolvedEntry,
  parent: ResolvedEntry | null,
  root: ResolvedEntry,
  state: PipelineState,
  fieldValues: Map<string, FormulaValue>
): PipelineResult<FormulaValue> {
  const tokens = tokenize(formula);
  const ctx: EvaluationContext = {
    self,
    parent,
    root,
    state,
    fieldValues,
  };

  return evaluateExpression(tokens, ctx);
}
