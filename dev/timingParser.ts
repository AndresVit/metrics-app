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
  ParserConfig,
  parserSuccess,
  parserError,
  parserMultiError,
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
  timingTokens: Map<string, number>; // subdivision string (e.g., "t", "m/thk") -> value
  attributeOverrides: Map<string, string | number>;
  tags: Map<string, string>;
  isInferred: boolean; // true if this line used -- syntax
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
    userId: string,
    config: ParserConfig
  ): ParserResult {
    // Date header is already handled by ParserRegistry - use entryDate from config
    const entryDate = config.entryDate;

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

    // First line is the header (date header already stripped by registry)
    const headerResult = this.parseHeader(
      nonEmptyLines[0].line,
      nonEmptyLines[0].lineNumber
    );
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

    // Parse timing lines (start from index 1, after header)
    if (nonEmptyLines.length < 2) {
      return parserError('Timing block must have at least one timing line', nonEmptyLines[0].lineNumber);
    }

    const timingLines: ParsedTimingLine[] = [];
    const lineErrors: Array<{ lineNumber: number; message: string; details?: string }> = [];

    for (let i = 1; i < nonEmptyLines.length; i++) {
      const line = nonEmptyLines[i].line;
      const lineNumber = nonEmptyLines[i].lineNumber;

      // Check if this is an inferred timing line (starts with --)
      const isInferredLine = line.startsWith('--');

      let result;
      if (isInferredLine) {
        // Inferred timing: --tokens [| attr overrides] [| tags]
        const previousTiming = timingLines.length > 0 ? timingLines[timingLines.length - 1] : null;
        result = this.parseInferredTimingLine(line, lineNumber, previousTiming);
      } else {
        // Explicit timing: HHMM-HHMM tokens [| attr overrides] [| tags]
        result = this.parseTimingLine(line, lineNumber);
      }

      if (!result.success) {
        lineErrors.push({
          lineNumber: result.error.lineNumber ?? lineNumber,
          message: result.error.message,
          details: result.error.details,
        });
        continue; // keep checking the remaining lines
      }
      timingLines.push(result.value);
    }

    // Only validate ordering if all lines parsed successfully
    if (lineErrors.length === 0) {
      const validationError = this.validateTimingLines(timingLines);
      if (validationError) {
        return validationError;
      }
    }

    // Return all collected line errors at once
    if (lineErrors.length > 0) {
      return parserMultiError(lineErrors);
    }

    // Generate entries with the resolved date
    return this.generateEntries(
      header,
      timingLines,
      def,
      timDef,
      timField,
      parsedDefs,
      userId,
      entryDate
    );
  }

  // ---------------------------------------------------------------------------
  // Header Parsing
  // ---------------------------------------------------------------------------

  private parseHeader(
    line: string,
    lineNumber: number
  ): { success: true; value: ParsedHeader } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
    // Format: DEF_CODE[:subdivision][;key:value,key:value[;tags]]
    // The semicolon and attributes/tags are optional.
    const semicolonIndex = line.indexOf(';');

    const header = semicolonIndex === -1 ? line : line.substring(0, semicolonIndex);
    const rest = semicolonIndex === -1 ? '' : line.substring(semicolonIndex + 1);

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

  /**
   * Parse a timing line with explicit time range: HHMM-HHMM tokens [| attr overrides] [| tags]
   */
  private parseTimingLine(
    line: string,
    lineNumber: number
  ): { success: true; value: ParsedTimingLine } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
    // Format: HHMM-HHMM [tokens] [| attr overrides] [| tags]
    // Tokens are optional — a line with only a time range records duration with no time_type values.
    const parts = line.split('|').map((p) => p.trim());

    // First part: time range and (optionally) tokens
    const mainPart = parts[0];
    const timeAndTokens = mainPart.split(/\s+/).filter((s) => s !== '');

    if (timeAndTokens.length < 1) {
      return {
        success: false,
        error: { message: 'Invalid timing line: must have a time range', lineNumber, details: line },
      };
    }

    // Parse time range: HHMM-HHMM
    const timeResult = this.parseTimeRange(timeAndTokens[0], lineNumber);
    if (!timeResult.success) {
      return timeResult;
    }
    const { timeInit, timeEnd, duration } = timeResult.value;

    // Parse tokens (optional). If absent, the line carries no time_type values.
    const timingTokens = new Map<string, number>();
    if (timeAndTokens.length > 1) {
      const tokenStr = timeAndTokens.slice(1).join('');
      const tokensResult = this.parseTimingTokens(tokenStr, lineNumber);
      if (!tokensResult.success) {
        return tokensResult;
      }
      for (const [k, v] of tokensResult.value) {
        timingTokens.set(k, v);
      }

      // Validate token values sum exactly to duration (only when tokens provided)
      let totalTokenValue = 0;
      for (const value of timingTokens.values()) {
        totalTokenValue += value;
      }
      if (totalTokenValue !== duration) {
        return {
          success: false,
          error: {
            message: `Token values (${totalTokenValue}) must equal duration (${duration} min)`,
            lineNumber,
            details: line,
          },
        };
      }
    }

    // Parse attribute overrides and tags
    const overridesResult = this.parseOverridesAndTags(parts, lineNumber);
    if (!overridesResult.success) {
      return overridesResult;
    }

    return {
      success: true,
      value: {
        lineNumber,
        timeInit,
        timeEnd,
        duration,
        timingTokens,
        attributeOverrides: overridesResult.value.attributeOverrides,
        tags: overridesResult.value.tags,
        isInferred: false,
      },
    };
  }

  /**
   * Parse an inferred timing line: --tokens [| attr overrides] [| tags]
   *
   * Inferred timing lines start with -- and have no explicit time range.
   * The start time is inferred from the previous timing's end time.
   * The duration is calculated from the sum of token values.
   */
  private parseInferredTimingLine(
    line: string,
    lineNumber: number,
    previousTiming: ParsedTimingLine | null
  ): { success: true; value: ParsedTimingLine } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
    // Validate that we have a previous timing to infer from
    if (previousTiming === null) {
      return {
        success: false,
        error: {
          message: 'Inferred timing (--) cannot be the first timing line',
          lineNumber,
          details: 'Use explicit time range for the first timing line',
        },
      };
    }

    // Format: --tokens [| attr overrides] [| tags]
    const parts = line.split('|').map((p) => p.trim());

    // First part: -- followed by tokens (no spaces between -- and tokens)
    const mainPart = parts[0];
    if (!mainPart.startsWith('--')) {
      return {
        success: false,
        error: { message: 'Expected inferred timing line to start with --', lineNumber, details: line },
      };
    }

    // Extract tokens after --
    const tokenStr = mainPart.substring(2).trim();
    if (tokenStr === '') {
      return {
        success: false,
        error: { message: 'Inferred timing line must have tokens after --', lineNumber, details: line },
      };
    }

    const tokensResult = this.parseTimingTokens(tokenStr, lineNumber);
    if (!tokensResult.success) {
      return tokensResult;
    }
    const timingTokens = tokensResult.value;

    // Calculate duration from sum of token values
    let duration = 0;
    for (const value of timingTokens.values()) {
      duration += value;
    }

    if (duration <= 0) {
      return {
        success: false,
        error: {
          message: 'Inferred timing must have positive total duration',
          lineNumber,
          details: `Token sum is ${duration}`,
        },
      };
    }

    // Infer start and end times from previous timing
    const timeInit = previousTiming.timeEnd;
    const timeEnd = timeInit + duration;

    // Parse attribute overrides and tags
    const overridesResult = this.parseOverridesAndTags(parts, lineNumber);
    if (!overridesResult.success) {
      return overridesResult;
    }

    return {
      success: true,
      value: {
        lineNumber,
        timeInit,
        timeEnd,
        duration,
        timingTokens,
        attributeOverrides: overridesResult.value.attributeOverrides,
        tags: overridesResult.value.tags,
        isInferred: true,
      },
    };
  }

  /**
   * Parse attribute overrides and tags from pipe-separated parts.
   */
  private parseOverridesAndTags(
    parts: string[],
    lineNumber: number
  ): { success: true; value: { attributeOverrides: Map<string, string | number>; tags: Map<string, string> } } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
    const attributeOverrides = new Map<string, string | number>();
    const tags = new Map<string, string>();

    // Parse attribute overrides (second part, if present)
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
      value: { attributeOverrides, tags },
    };
  }

  private parseTimeRange(
    timeStr: string,
    lineNumber: number
  ): { success: true; value: { timeInit: number; timeEnd: number; duration: number } } | { success: false; error: { message: string; lineNumber?: number; details?: string } } {
    // Accepts flexible formats:
    //   HHMM-HHMM  (standard)
    //   HMM-HHMM   (3-digit start, e.g. 900-0930)
    //   HHMM-MM    (minutes-only end, e.g. 1134-56 → 1134-1156)
    //   HMM-MM     (both short, e.g. 900-30 → 0900-0930)
    const match = timeStr.match(/^(\d{3,4})-(\d{1,4})$/);
    if (!match) {
      return {
        success: false,
        error: { message: 'Invalid time range format (expected HHMM-HHMM)', lineNumber, details: timeStr },
      };
    }

    const startStr = match[1].length === 3 ? '0' + match[1] : match[1];
    const endStr = match[2];

    const startHH = parseInt(startStr.substring(0, 2), 10);
    const startMM = parseInt(startStr.substring(2, 4), 10);

    if (startMM >= 60) {
      return {
        success: false,
        error: { message: 'Invalid time: start minutes must be < 60', lineNumber, details: timeStr },
      };
    }

    const timeInit = startHH * 60 + startMM;

    let timeEnd: number;
    if (endStr.length <= 2) {
      // Minutes-only end: infer the smallest hour that keeps end > start
      const endMM = parseInt(endStr, 10);
      if (endMM >= 60) {
        return {
          success: false,
          error: { message: 'Invalid time: end minutes must be < 60', lineNumber, details: timeStr },
        };
      }
      let endHH = startHH;
      timeEnd = endHH * 60 + endMM;
      if (timeEnd <= timeInit) {
        endHH += 1;
        timeEnd = endHH * 60 + endMM;
      }
    } else {
      const fullEndStr = endStr.length === 3 ? '0' + endStr : endStr;
      const endHH = parseInt(fullEndStr.substring(0, 2), 10);
      const endMM = parseInt(fullEndStr.substring(2, 4), 10);
      if (endMM >= 60) {
        return {
          success: false,
          error: { message: 'Invalid time: end minutes must be < 60', lineNumber, details: timeStr },
        };
      }
      timeEnd = endHH * 60 + endMM;
    }

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
    // Format: t15m10n5 or t12m/thk5m3
    // Supports hierarchical types: m/thk, t/deep, p/admin, etc.
    //
    // Examples:
    //   t15m10n5    → t:15, m:10, n:5
    //   t12m/thk5m3 → t:12, m/thk:5, m:3
    //   t20m/thk10  → t:20, m/thk:10
    //
    // Token format:
    //   <base>[/<subcategory>]<number>
    //   - base: single letter (t, m, p, n)
    //   - subcategory: optional hierarchy (e.g., thk, deep, admin)
    //   - number: minutes allocated to this category
    const tokens = new Map<string, number>();

    // Regex for hierarchical tokens: base letter, optional /subcategory, then number
    // e.g., "t12", "m/thk5", "p3", "n/break10"
    const tokenRegex = /([a-zA-Z])(?:\/([a-zA-Z]+))?(\d+)/g;
    let match;
    let lastIndex = 0;

    while ((match = tokenRegex.exec(tokenStr)) !== null) {
      // Check for unexpected characters between tokens
      if (match.index > lastIndex) {
        const between = tokenStr.substring(lastIndex, match.index);
        if (between.trim() !== '') {
          return {
            success: false,
            error: { message: `Invalid token syntax`, lineNumber, details: tokenStr },
          };
        }
      }

      const baseLetter = match[1].toLowerCase();
      const subcategory = match[2] ? match[2].toLowerCase() : null;
      const value = parseInt(match[3], 10);

      // Build the full subdivision key
      // If there's a subcategory, store as "m/thk"; otherwise just "m"
      const subdivisionKey = subcategory ? `${baseLetter}/${subcategory}` : baseLetter;

      if (tokens.has(subdivisionKey)) {
        // Duplicate subdivision - add values
        tokens.set(subdivisionKey, tokens.get(subdivisionKey)! + value);
      } else {
        tokens.set(subdivisionKey, value);
      }

      lastIndex = match.index + match[0].length;
    }

    // Check for trailing garbage
    if (lastIndex < tokenStr.length) {
      const trailing = tokenStr.substring(lastIndex);
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
    // Base types are user-namespaced single-letter strings (a-z), enforced by
    // the token regex above. We don't validate against a fixed enum — the user's
    // configured letter set lives in settings and only governs simple-mode UI.

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
    userId: string,
    entryDate: Date
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
      // Use the resolved entryDate (from date header or anchor date)
      const timEntry: MetricEntryInput = {
        definitionId: timDef.id,
        timestamp: entryDate,
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

      // Merge tags: header tags apply to all lines; line tags override per-key.
      const mergedTags = new Map<string, string>(header.tags);
      for (const [k, v] of timing.tags) {
        mergedTags.set(k, v);
      }

      // Create parent MetricEntryInput - TIM is referenced via timing field, not children
      // Use the same entryDate as the TIM entry
      const parentEntry: MetricEntryInput = {
        definitionId: parentDef.id,
        timestamp: entryDate,
        subdivision: header.subdivision,
        fields: parentEntryFields,
        tags: mergedTags.size > 0 ? mergedTags : undefined,
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
