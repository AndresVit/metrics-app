/**
 * Widget DSL Parser
 *
 * Parses widget definitions from the Widget DSL syntax.
 *
 * Syntax:
 *   WIDGET "<name>"
 *
 *   <alias> = <DEF>
 *
 *   "<label>": <type> = <expression>
 *   "<label>": <type> = <expression>
 *   END
 *
 * Note: Period (day/week/month/year) comes from the temporal context,
 * not from the widget DSL.
 *
 * Example:
 *   WIDGET "Daily Productivity"
 *
 *   tims = TIM
 *
 *   "good": int = sum(tims.time("t"))
 *   "prod": float = sum(tims.time("t")) / sum(tims.time("t") + tims.time("m") + tims.time("p"))
 *   END
 */

import {
  ParsedWidget,
  DatasetDeclaration,
  ComputedField,
  WidgetParseResult,
} from './types';

/**
 * Parse a widget definition from source text
 */
export function parseWidget(source: string): WidgetParseResult {
  const lines = source.split('\n');
  let lineIndex = 0;

  // Skip empty lines and find WIDGET declaration
  while (lineIndex < lines.length && lines[lineIndex].trim() === '') {
    lineIndex++;
  }

  // Parse WIDGET header
  const widgetResult = parseWidgetHeader(lines, lineIndex);
  if (!widgetResult.success) {
    return widgetResult;
  }
  const { name, nextLine: afterHeader } = widgetResult;
  lineIndex = afterHeader;

  // Skip empty lines
  while (lineIndex < lines.length && lines[lineIndex].trim() === '') {
    lineIndex++;
  }

  // Parse dataset declaration
  const datasetResult = parseDatasetDeclaration(lines, lineIndex);
  if (!datasetResult.success) {
    return datasetResult;
  }
  const { dataset, nextLine: afterDataset } = datasetResult;
  lineIndex = afterDataset;

  // Skip empty lines
  while (lineIndex < lines.length && lines[lineIndex].trim() === '') {
    lineIndex++;
  }

  // Parse computed fields until END
  const computedFields: ComputedField[] = [];
  while (lineIndex < lines.length) {
    const line = lines[lineIndex].trim();

    if (line === '') {
      lineIndex++;
      continue;
    }

    if (line === 'END') {
      break;
    }

    const fieldResult = parseComputedField(lines, lineIndex);
    if (!fieldResult.success) {
      return fieldResult;
    }
    computedFields.push(fieldResult.field);
    lineIndex = fieldResult.nextLine;
  }

  if (lineIndex >= lines.length || lines[lineIndex].trim() !== 'END') {
    return {
      success: false,
      error: {
        message: 'Missing END keyword',
        lineNumber: lineIndex + 1,
      },
    };
  }

  if (computedFields.length === 0) {
    return {
      success: false,
      error: {
        message: 'Widget must have at least one computed field',
        lineNumber: lineIndex + 1,
      },
    };
  }

  return {
    success: true,
    widget: {
      name,
      dataset,
      computedFields,
    },
  };
}

/**
 * Parse WIDGET "<name>" header
 */
function parseWidgetHeader(
  lines: string[],
  lineIndex: number
): { success: true; name: string; nextLine: number } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
  if (lineIndex >= lines.length) {
    return {
      success: false,
      error: {
        message: 'Expected WIDGET declaration',
        lineNumber: lineIndex + 1,
      },
    };
  }

  const line = lines[lineIndex].trim();
  const match = line.match(/^WIDGET\s+"([^"]+)"$/);

  if (!match) {
    return {
      success: false,
      error: {
        message: 'Invalid WIDGET declaration. Expected: WIDGET "<name>"',
        lineNumber: lineIndex + 1,
        details: `Got: ${line}`,
      },
    };
  }

  return {
    success: true,
    name: match[1],
    nextLine: lineIndex + 1,
  };
}

/**
 * Parse dataset declaration: alias = DEF
 *
 * Period is no longer specified in DSL - it comes from the temporal context.
 */
function parseDatasetDeclaration(
  lines: string[],
  lineIndex: number
): { success: true; dataset: DatasetDeclaration; nextLine: number } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
  if (lineIndex >= lines.length) {
    return {
      success: false,
      error: {
        message: 'Expected dataset declaration',
        lineNumber: lineIndex + 1,
      },
    };
  }

  const line = lines[lineIndex].trim();
  // Match: alias = DEF (no period - comes from temporal context)
  const match = line.match(/^(\w+)\s*=\s*(\w+)$/);

  if (!match) {
    return {
      success: false,
      error: {
        message: 'Invalid dataset declaration. Expected: alias = DEF',
        lineNumber: lineIndex + 1,
        details: `Got: ${line}`,
      },
    };
  }

  const [, alias, definitionCode] = match;

  return {
    success: true,
    dataset: {
      alias,
      definitionCode,
    },
    nextLine: lineIndex + 1,
  };
}

/**
 * Parse computed field: "label": type = expression
 */
function parseComputedField(
  lines: string[],
  lineIndex: number
): { success: true; field: ComputedField; nextLine: number } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
  if (lineIndex >= lines.length) {
    return {
      success: false,
      error: {
        message: 'Expected computed field',
        lineNumber: lineIndex + 1,
      },
    };
  }

  const line = lines[lineIndex].trim();

  // Match: "label": type = expression
  const match = line.match(/^"([^"]+)":\s*(int|float)\s*=\s*(.+)$/);

  if (!match) {
    return {
      success: false,
      error: {
        message: 'Invalid computed field. Expected: "label": type = expression',
        lineNumber: lineIndex + 1,
        details: `Got: ${line}`,
      },
    };
  }

  const [, label, datatype, expression] = match;

  return {
    success: true,
    field: {
      label,
      datatype: datatype as 'int' | 'float',
      expression: expression.trim(),
    },
    nextLine: lineIndex + 1,
  };
}

/**
 * Parse widget from string (convenience wrapper)
 */
export function parseWidgetFromString(source: string): WidgetParseResult {
  return parseWidget(source);
}
