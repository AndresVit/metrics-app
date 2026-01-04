/**
 * timingParser.ts
 *
 * Parser for multiline timing input blocks.
 *
 * Format:
 *   HEADER LINE: DEF_CODE:subdivision;key:value,key:value[;tags]
 *   TIMING LINES: HHMM-HHMM tokens [| attr overrides] [| tags]
 *
 * Examples:
 *   EST:TFG/coding;adv:10
 *   1230-1310 t15m15n10
 *   1310-1315 t5 | adv:2
 *   1320-1340 t12m/thk5m3 | adv:10 | place:library,mode:focus
 *
 * Timing DSL:
 *   - Time format: HHMM-HHMM (e.g., 1230-1310)
 *   - time_init = HH*60 + MM, time_end same (may exceed 24h, e.g., 2430)
 *   - duration = time_end - time_init (must be > 0)
 *   - Attribute tokens: t15m10n5 (letter = TIM subdivision, number = value)
 *   - Optional: | key:value overrides for parent metric
 *   - Optional: | key:value,key:value for tags
 *
 * Output:
 *   - Each timing line generates:
 *     - One TIM MetricEntry (the timing entry itself)
 *     - One parent MetricEntry (EST) referencing that TIM
 *
 * Error handling:
 *   - If ANY timing line is invalid, abort entire block
 *   - Return error with line number and reason
 *   - Do NOT partially create entries
 */

import { MetricEntryInput, FieldInput, AttributeValueInput } from '../src/pipeline/types';
import { ParsedDefinitions } from './parseDefinitions';
import { Definition, Field } from '../src/domain';
import {
  Parser,
  ParserResult,
  parserSuccess,
  parserError,
  isTimingCapable,
  getTimField,
} from './parserRegistry';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ParsedHeader {
  definitionCode: string;
  subdivision: string;
  attributes: Map<string, string | number>;
  tags: Map<string, string>;
}

interface ParsedTimingLine {
  lineNumber: number;
  timeInit: number; // minutes from midnight
  timeEnd: number; // minutes from midnight
  duration: number; // minutes
  timingTokens: Map<string, number>; // subdivision letter -> value
  attributeOverrides: Map<string, string | number>;
  tags: Map<string, string>;
}

// -----------------------------------------------------------------------------
// Timing Parser
// -----------------------------------------------------------------------------

export class TimingParser implements Parser {
  readonly name = 'TimingParser';

  /**
   * TimingParser handles multiline input for timing-capable definitions.
   *
   * A definition is timing-capable if it has a Field whose baseDefinition is TIM.
   */
  canParse(
    definition: Definition,
    rawBlock: string,
    parsedDefs: ParsedDefinitions
  ): boolean {
    // Must be timing-capable
    if (!isTimingCapable(definition, parsedDefs)) {
      return false;
    }

    // Must be multiline (otherwise DefaultParser handles single-line)
    const lines = rawBlock.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    return lines.length > 1;
  }

  parse(
    definition: Definition,
    rawBlock: string,
    parsedDefs: ParsedDefinitions,
    userId: string
  ): ParserResult {
    const lines = rawBlock.split('\n');
    const nonEmptyLines: { line: string; lineNumber: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line !== '' && !line.startsWith('#')) {
        nonEmptyLines.push({ line, lineNumber: i + 1 });
      }
    }

    if (nonEmptyLines.length === 0) {
      return parserError('Empty timing block');
    }

    // First line is the header
    const headerResult = this.parseHeader(nonEmptyLines[0].line, nonEmptyLines[0].lineNumber);
    if (!headerResult.success) {
      return headerResult;
    }
    const header = headerResult.value;

    // Lookup definition from header
    const def = parsedDefs.definitionsByCode.get(header.definitionCode);
    if (!def) {
      return parserError(
        `Unknown definition code: ${header.definitionCode}`,
        nonEmptyLines[0].lineNumber
      );
    }

    // Verify definition is timing-capable
    const timField = getTimField(def, parsedDefs);
    if (!timField) {
      return parserError(
        `Definition ${header.definitionCode} has no TIM field`,
        nonEmptyLines[0].lineNumber,
        'A timing-capable metric must have a field with baseDefinition = TIM'
      );
    }

    // Get TIM definition
    const timDef = parsedDefs.definitionsByCode.get('TIM');
    if (!timDef) {
      return parserError(
        'TIM metric definition not found',
        nonEmptyLines[0].lineNumber
      );
    }

    // Parse timing lines
    if (nonEmptyLines.length < 2) {
      return parserError('Timing block must have at least one timing line', nonEmptyLines[0].lineNumber);
    }

    const timingLines: ParsedTimingLine[] = [];
    for (let i = 1; i < nonEmptyLines.length; i++) {
      const result = this.parseTimingLine(
        nonEmptyLines[i].line,
        nonEmptyLines[i].lineNumber
      );
      if (!result.success) {
        return result;
      }
      timingLines.push(result.value);
    }

    // Validate timing lines
    const validationError = this.validateTimingLines(timingLines);
    if (validationError) {
      return validationError;
    }

    // Generate entries
    return this.generateEntries(
      header,
      timingLines,
      def,
      timDef,
      timField,
      parsedDefs,
      userId
    );
  }

  // ---------------------------------------------------------------------------
  // Header Parsing
  // ---------------------------------------------------------------------------

  private parseHeader(
    line: string,
    lineNumber: number
  ): { success: true; value: ParsedHeader } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
    // Format: DEF_CODE[:subdivision];key:value,key:value[;tags]
    const semicolonIndex = line.indexOf(';');
    if (semicolonIndex === -1) {
      return { success: false, error: { message: "Missing ';' separator in header", lineNumber } };
    }

    const header = line.substring(0, semicolonIndex);
    const rest = line.substring(semicolonIndex + 1);

    // Parse header: DEF_CODE[:subdivision]
    let definitionCode: string;
    let subdivision: string = '';

    const colonIndex = header.indexOf(':');
    if (colonIndex === -1) {
      definitionCode = header.trim();
    } else {
      definitionCode = header.substring(0, colonIndex).trim();
      subdivision = header.substring(colonIndex + 1).trim();
    }

    if (definitionCode === '') {
      return { success: false, error: { message: 'Missing definition code in header', lineNumber } };
    }

    // Parse attributes and optional tags
    // Format: key:value,key:value[;tag:value,tag:value]
    const attributes = new Map<string, string | number>();
    const tags = new Map<string, string>();

    const tagsSeparatorIndex = rest.indexOf(';');
    let attributesPart: string;
    let tagsPart: string | null = null;

    if (tagsSeparatorIndex !== -1) {
      attributesPart = rest.substring(0, tagsSeparatorIndex);
      tagsPart = rest.substring(tagsSeparatorIndex + 1);
    } else {
      attributesPart = rest;
    }

    // Parse attributes
    if (attributesPart.trim() !== '') {
      const pairs = attributesPart.split(',');
      for (const pair of pairs) {
        const colonIdx = pair.indexOf(':');
        if (colonIdx === -1) {
          return {
            success: false,
            error: { message: `Invalid attribute pair (missing ':')`, lineNumber, details: pair },
          };
        }
        const key = pair.substring(0, colonIdx).trim();
        const value = this.parseValue(pair.substring(colonIdx + 1).trim());
        if (key !== '') {
          attributes.set(key, value);
        }
      }
    }

    // Parse tags
    if (tagsPart && tagsPart.trim() !== '') {
      const pairs = tagsPart.split(',');
      for (const pair of pairs) {
        const colonIdx = pair.indexOf(':');
        if (colonIdx === -1) {
          return {
            success: false,
            error: { message: `Invalid tag pair (missing ':')`, lineNumber, details: pair },
          };
        }
        const key = pair.substring(0, colonIdx).trim();
        const value = pair.substring(colonIdx + 1).trim();
        if (key !== '') {
          tags.set(key, value);
        }
      }
    }

    return {
      success: true,
      value: { definitionCode, subdivision, attributes, tags },
    };
  }

  // ---------------------------------------------------------------------------
  // Timing Line Parsing
  // ---------------------------------------------------------------------------

  private parseTimingLine(
    line: string,
    lineNumber: number
  ): { success: true; value: ParsedTimingLine } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
    // Format: HHMM-HHMM tokens [| attr overrides] [| tags]
    const parts = line.split('|').map((p) => p.trim());

    // First part: time range and tokens
    const mainPart = parts[0];
    const timeAndTokens = mainPart.split(/\s+/);

    if (timeAndTokens.length < 2) {
      return {
        success: false,
        error: { message: 'Invalid timing line: must have time range and tokens', lineNumber, details: line },
      };
    }

    // Parse time range: HHMM-HHMM
    const timeResult = this.parseTimeRange(timeAndTokens[0], lineNumber);
    if (!timeResult.success) {
      return timeResult;
    }
    const { timeInit, timeEnd, duration } = timeResult.value;

    // Parse tokens: t15m10n5 or t12m/thk5m3 (multiple token groups)
    const tokenStr = timeAndTokens.slice(1).join('');
    const tokensResult = this.parseTimingTokens(tokenStr, lineNumber);
    if (!tokensResult.success) {
      return tokensResult;
    }
    const timingTokens = tokensResult.value;

    // Validate token values against duration
    let totalTokenValue = 0;
    for (const value of timingTokens.values()) {
      totalTokenValue += value;
    }
    if (totalTokenValue > duration) {
      return {
        success: false,
        error: {
          message: `Token values (${totalTokenValue}) exceed duration (${duration} min)`,
          lineNumber,
          details: line,
        },
      };
    }

    // Parse attribute overrides (second part, if present)
    const attributeOverrides = new Map<string, string | number>();
    if (parts.length >= 2 && parts[1] !== '') {
      const pairs = parts[1].split(',');
      for (const pair of pairs) {
        const colonIdx = pair.indexOf(':');
        if (colonIdx === -1) {
          return {
            success: false,
            error: { message: `Invalid attribute override (missing ':')`, lineNumber, details: pair },
          };
        }
        const key = pair.substring(0, colonIdx).trim();
        const value = this.parseValue(pair.substring(colonIdx + 1).trim());
        if (key !== '') {
          attributeOverrides.set(key, value);
        }
      }
    }

    // Parse tags (third part, if present)
    const tags = new Map<string, string>();
    if (parts.length >= 3 && parts[2] !== '') {
      const pairs = parts[2].split(',');
      for (const pair of pairs) {
        const colonIdx = pair.indexOf(':');
        if (colonIdx === -1) {
          return {
            success: false,
            error: { message: `Invalid tag (missing ':')`, lineNumber, details: pair },
          };
        }
        const key = pair.substring(0, colonIdx).trim();
        const value = pair.substring(colonIdx + 1).trim();
        if (key !== '') {
          tags.set(key, value);
        }
      }
    }

    return {
      success: true,
      value: {
        lineNumber,
        timeInit,
        timeEnd,
        duration,
        timingTokens,
        attributeOverrides,
        tags,
      },
    };
  }

  private parseTimeRange(
    timeStr: string,
    lineNumber: number
  ): { success: true; value: { timeInit: number; timeEnd: number; duration: number } } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
    // Format: HHMM-HHMM
    const match = timeStr.match(/^(\d{4})-(\d{4})$/);
    if (!match) {
      return {
        success: false,
        error: { message: 'Invalid time range format (expected HHMM-HHMM)', lineNumber, details: timeStr },
      };
    }

    const startStr = match[1];
    const endStr = match[2];

    const startHH = parseInt(startStr.substring(0, 2), 10);
    const startMM = parseInt(startStr.substring(2, 4), 10);
    const endHH = parseInt(endStr.substring(0, 2), 10);
    const endMM = parseInt(endStr.substring(2, 4), 10);

    // Validate minutes
    if (startMM >= 60 || endMM >= 60) {
      return {
        success: false,
        error: { message: 'Invalid time: minutes must be < 60', lineNumber, details: timeStr },
      };
    }

    const timeInit = startHH * 60 + startMM;
    const timeEnd = endHH * 60 + endMM;

    // Duration must be positive
    if (timeEnd <= timeInit) {
      return {
        success: false,
        error: { message: 'Invalid time range: end must be after start', lineNumber, details: timeStr },
      };
    }

    const duration = timeEnd - timeInit;

    return { success: true, value: { timeInit, timeEnd, duration } };
  }

  private parseTimingTokens(
    tokenStr: string,
    lineNumber: number
  ): { success: true; value: Map<string, number> } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
    // Format: t15m10n5 or t12m/thk5m3 (/ separates token groups)
    // Each letter = subdivision letter, followed by number = value
    const tokens = new Map<string, number>();

    // Remove any slashes (they just separate groups visually)
    const cleanedStr = tokenStr.replace(/\//g, '');

    // Parse tokens: letter followed by number
    // e.g., t15m10n5 -> t:15, m:10, n:5
    const tokenRegex = /([a-zA-Z])(\d+)/g;
    let match;
    let lastIndex = 0;

    while ((match = tokenRegex.exec(cleanedStr)) !== null) {
      // Check for unexpected characters between tokens
      if (match.index > lastIndex) {
        const between = cleanedStr.substring(lastIndex, match.index);
        if (between.trim() !== '') {
          return {
            success: false,
            error: { message: `Invalid token syntax`, lineNumber, details: tokenStr },
          };
        }
      }

      const letter = match[1].toLowerCase();
      const value = parseInt(match[2], 10);

      if (tokens.has(letter)) {
        // Duplicate letter - add values
        tokens.set(letter, tokens.get(letter)! + value);
      } else {
        tokens.set(letter, value);
      }

      lastIndex = match.index + match[0].length;
    }

    // Check for trailing garbage
    if (lastIndex < cleanedStr.length) {
      const trailing = cleanedStr.substring(lastIndex);
      if (trailing.trim() !== '') {
        return {
          success: false,
          error: { message: `Invalid token syntax (trailing characters)`, lineNumber, details: tokenStr },
        };
      }
    }

    if (tokens.size === 0) {
      return {
        success: false,
        error: { message: 'No timing tokens found', lineNumber, details: tokenStr },
      };
    }

    return { success: true, value: tokens };
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  private validateTimingLines(lines: ParsedTimingLine[]): ParserResult | null {
    // Check for overlapping or unordered times
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const curr = lines[i];

      // Times must be in order
      if (curr.timeInit < prev.timeEnd) {
        return parserError(
          'Overlapping or unordered timing lines',
          curr.lineNumber,
          `Line starts at ${this.formatTime(curr.timeInit)} but previous line ends at ${this.formatTime(prev.timeEnd)}`
        );
      }
    }

    return null; // No errors
  }

  private formatTime(minutes: number): string {
    const hh = Math.floor(minutes / 60)
      .toString()
      .padStart(2, '0');
    const mm = (minutes % 60).toString().padStart(2, '0');
    return `${hh}${mm}`;
  }

  // ---------------------------------------------------------------------------
  // Entry Generation
  // ---------------------------------------------------------------------------

  /**
   * Generates MetricEntryInput objects for each timing line.
   *
   * TIM model:
   * - time_init, time_end, duration: single-value int fields
   * - time_type: multi-value int field where each value's subdivision is the token letter
   *
   * Each timing token (t15, m10, etc.) becomes a separate AttributeValueInput
   * on the SAME time_type field, with subdivision = token letter.
   */
  private generateEntries(
    header: ParsedHeader,
    timingLines: ParsedTimingLine[],
    parentDef: Definition,
    timDef: Definition,
    timField: Field,
    parsedDefs: ParsedDefinitions,
    userId: string
  ): ParserResult {
    const entries: MetricEntryInput[] = [];

    // Get fields for TIM metric
    const timFields = parsedDefs.fieldsByMetricCode.get('TIM') || [];
    const timFieldsByName = new Map(timFields.map((f) => [f.name, f]));

    // Get fields for parent metric
    const parentFields = parsedDefs.fieldsByMetricCode.get(parentDef.code) || [];
    const parentFieldsByName = new Map(parentFields.map((f) => [f.name, f]));

    // Find the single time_type field for timing tokens
    const timeTypeField = timFieldsByName.get('time_type');

    for (const timing of timingLines) {
      // Build TIM entry's fields from timing tokens
      const timEntryFields: FieldInput[] = [];

      // Add time_init, time_end, duration as fields if they exist on TIM
      const timeInitField = timFieldsByName.get('time_init');
      const timeEndField = timFieldsByName.get('time_end');
      const durationField = timFieldsByName.get('duration');

      if (timeInitField) {
        timEntryFields.push({
          fieldId: timeInitField.id,
          values: [{ valueInt: timing.timeInit }],
        });
      }
      if (timeEndField) {
        timEntryFields.push({
          fieldId: timeEndField.id,
          values: [{ valueInt: timing.timeEnd }],
        });
      }
      if (durationField) {
        timEntryFields.push({
          fieldId: durationField.id,
          values: [{ valueInt: timing.duration }],
        });
      }

      // Add all timing tokens as multiple values of the SINGLE time_type field
      // Each value has subdivision = token letter (t, m, n, r, p, etc.)
      if (timeTypeField && timing.timingTokens.size > 0) {
        const timeTypeValues: AttributeValueInput[] = [];
        for (const [letter, value] of timing.timingTokens) {
          timeTypeValues.push({
            valueInt: value,
            subdivision: letter,
          });
        }
        timEntryFields.push({
          fieldId: timeTypeField.id,
          values: timeTypeValues,
        });
      }

      // Create TIM MetricEntryInput
      const timEntry: MetricEntryInput = {
        definitionId: timDef.id,
        timestamp: new Date(),
        subdivision: header.subdivision,
        fields: timEntryFields,
      };

      // Build parent entry's fields
      const parentEntryFields: FieldInput[] = [];

      // Start with header attributes
      for (const [key, value] of header.attributes) {
        const field = parentFieldsByName.get(key);
        if (field) {
          const valueInput: AttributeValueInput = {};
          if (typeof value === 'number') {
            valueInput.valueInt = value;
          } else {
            valueInput.valueString = value;
          }
          parentEntryFields.push({
            fieldId: field.id,
            values: [valueInput],
          });
        }
      }

      // Apply line-level attribute overrides
      for (const [key, value] of timing.attributeOverrides) {
        const field = parentFieldsByName.get(key);
        if (field) {
          // Remove any existing entry for this field
          const existingIndex = parentEntryFields.findIndex((f) => f.fieldId === field.id);
          if (existingIndex !== -1) {
            parentEntryFields.splice(existingIndex, 1);
          }

          const valueInput: AttributeValueInput = {};
          if (typeof value === 'number') {
            valueInput.valueInt = value;
          } else {
            valueInput.valueString = value;
          }
          parentEntryFields.push({
            fieldId: field.id,
            values: [valueInput],
          });
        }
      }

      // Add the timing field with inline TIM entry (no children[])
      parentEntryFields.push({
        fieldId: timField.id,
        values: [{ metricEntry: timEntry }],
      });

      // Create parent MetricEntryInput - TIM is referenced via timing field, not children
      const parentEntry: MetricEntryInput = {
        definitionId: parentDef.id,
        timestamp: new Date(),
        subdivision: header.subdivision,
        fields: parentEntryFields,
      };

      entries.push(parentEntry);
    }

    return parserSuccess(entries);
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private parseValue(value: string): string | number {
    const trimmed = value.trim();
    const asInt = parseInt(trimmed, 10);
    if (!isNaN(asInt) && String(asInt) === trimmed) {
      return asInt;
    }
    const asFloat = parseFloat(trimmed);
    if (!isNaN(asFloat) && String(asFloat) === trimmed) {
      return asFloat;
    }
    return trimmed;
  }
}
