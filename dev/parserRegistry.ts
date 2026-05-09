/**
 * parserRegistry.ts
 *
 * Parser registry for routing raw input blocks to the appropriate parser.
 *
 * Architecture:
 *   - A Parser has: canParse(definition, rawBlock) and parse(definition, rawBlock)
 *   - The registry receives raw input + definition and finds the matching parser
 *   - Errors if 0 or >1 parsers match (no silent fallback, no priority)
 *
 * Decision: No priority system for now. If multiple parsers could handle
 * the same input, that's a configuration error that must be resolved.
 */

import { MetricEntryInput } from '../src/pipeline/types';
import { ParsedDefinitions } from './parseDefinitions';
import { Definition, Field } from '../src/domain';

// -----------------------------------------------------------------------------
// Parser Interface
// -----------------------------------------------------------------------------

/**
 * Configuration passed to parsers from the registry.
 */
export interface ParserConfig {
  /**
   * The resolved entry date.
   * If a date header was present, this is the resolved date.
   * Otherwise, this is the anchor date (or current date if no anchor set).
   */
  entryDate: Date;

  /**
   * Warnings collected during preprocessing (e.g., weekday mismatches).
   */
  warnings: string[];
}

/**
 * A Parser handles conversion of raw text blocks into MetricEntryInput[].
 *
 * Each parser:
 *   - Declares what it can parse via canParse()
 *   - Performs the actual parsing via parse()
 */
export interface Parser {
  /**
   * Unique name for this parser (used in error messages).
   */
  readonly name: string;

  /**
   * Returns true if this parser can handle the given definition and raw block.
   *
   * @param definition - The metric definition (looked up from the header)
   * @param rawBlock - The raw input text (single line or multiline), with date header removed
   * @param parsedDefs - Full parsed definitions for context
   */
  canParse(
    definition: Definition,
    rawBlock: string,
    parsedDefs: ParsedDefinitions
  ): boolean;

  /**
   * Parse the raw block into MetricEntryInput[].
   *
   * @param definition - The metric definition
   * @param rawBlock - The raw input text (with date header removed if present)
   * @param parsedDefs - Full parsed definitions for lookups
   * @param userId - User ID for the entries
   * @param config - Parser configuration including resolved entry date
   * @returns Array of MetricEntryInput (may be multiple for timing blocks)
   */
  parse(
    definition: Definition,
    rawBlock: string,
    parsedDefs: ParsedDefinitions,
    userId: string,
    config: ParserConfig
  ): ParserResult;
}

// -----------------------------------------------------------------------------
// Parser Result Types
// -----------------------------------------------------------------------------

export type ParserResult =
  | { success: true; entries: MetricEntryInput[] }
  | { success: false; error: ParserError };

export interface ParserError {
  message: string;
  lineNumber?: number;
  details?: string;
  /** Present when multiple errors were collected (e.g., from timing line parsing) */
  allErrors?: Array<{ lineNumber: number; message: string; details?: string }>;
}

export function parserSuccess(entries: MetricEntryInput[]): ParserResult {
  return { success: true, entries };
}

export function parserError(
  message: string,
  lineNumber?: number,
  details?: string
): ParserResult {
  return { success: false, error: { message, lineNumber, details } };
}

export function parserMultiError(
  errors: Array<{ lineNumber: number; message: string; details?: string }>
): ParserResult {
  const summary = errors.map((e) => `Line ${e.lineNumber}: ${e.message}`).join('; ');
  return { success: false, error: { message: summary, allErrors: errors } };
}

// -----------------------------------------------------------------------------
// Weekday Constants (Spanish)
// -----------------------------------------------------------------------------

const WEEKDAY_TO_DAY_OF_WEEK: Record<string, number> = {
  D: 0, // Sunday (Domingo)
  L: 1, // Monday (Lunes)
  M: 2, // Tuesday (Martes)
  X: 3, // Wednesday (Miércoles)
  J: 4, // Thursday (Jueves)
  V: 5, // Friday (Viernes)
  S: 6, // Saturday (Sábado)
};

const DAY_OF_WEEK_TO_LETTER = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const WEEKDAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// -----------------------------------------------------------------------------
// Parser Registry
// -----------------------------------------------------------------------------

/**
 * Registry for parsers.
 *
 * Workflow:
 *   1. Register parsers via register()
 *   2. Call parseBlock() with raw input
 *   3. Registry extracts date header (if present) and resolves entry date
 *   4. Registry extracts definition code from header (skipping date header)
 *   5. Registry finds all parsers where canParse() === true
 *   6. Errors if not exactly 1 parser matches
 *   7. Delegates to the matching parser with config (including entryDate)
 */
export class ParserRegistry {
  private parsers: Parser[] = [];

  /**
   * Anchor date for year context when resolving date headers.
   * If not set, defaults to current date.
   */
  private _anchorDate: Date = new Date();

  /**
   * Warnings from the last parse operation.
   */
  private _warnings: string[] = [];

  register(parser: Parser): void {
    this.parsers.push(parser);
  }

  /**
   * Set the anchor date for year context in date headers.
   */
  setAnchorDate(date: Date): void {
    this._anchorDate = date;
  }

  /**
   * Get warnings from the last parse operation.
   */
  getWarnings(): string[] {
    return [...this._warnings];
  }

  /**
   * Parse a raw input block.
   *
   * @param rawBlock - Raw text (single line or multiline block)
   * @param parsedDefs - Parsed definitions for lookups
   * @param userId - User ID for the entries
   */
  parseBlock(
    rawBlock: string,
    parsedDefs: ParsedDefinitions,
    userId: string
  ): ParserResult {
    // Reset warnings
    this._warnings = [];

    // Preprocess: extract date header if present
    const { entryDate, blockWithoutDateHeader } = this.preprocessDateHeader(rawBlock);

    // Extract definition code from the block (date header already removed)
    const definitionCode = this.extractDefinitionCode(blockWithoutDateHeader);
    if (!definitionCode) {
      return parserError('Could not extract definition code from input block');
    }

    // Lookup definition
    const definition = parsedDefs.definitionsByCode.get(definitionCode);
    if (!definition) {
      return parserError(`Unknown definition code: ${definitionCode}`);
    }

    // Find matching parsers (pass block without date header)
    const matchingParsers = this.parsers.filter((p) =>
      p.canParse(definition, blockWithoutDateHeader, parsedDefs)
    );

    if (matchingParsers.length === 0) {
      return parserError(
        `No parser available for definition: ${definitionCode}`,
        1,
        `Registered parsers: ${this.parsers.map((p) => p.name).join(', ')}`
      );
    }

    if (matchingParsers.length > 1) {
      return parserError(
        `Ambiguous parsers for definition: ${definitionCode}`,
        1,
        `Matching parsers: ${matchingParsers.map((p) => p.name).join(', ')}`
      );
    }

    // Build parser config
    const config: ParserConfig = {
      entryDate,
      warnings: this._warnings,
    };

    // Exactly one parser matches
    const parser = matchingParsers[0];
    return parser.parse(definition, blockWithoutDateHeader, parsedDefs, userId, config);
  }

  /**
   * Preprocess a raw block to extract date header if present.
   *
   * Date header formats:
   *   - "15/1" (day/month)
   *   - "V2/1" (weekday + day/month)
   *   - "J15/1" (weekday + day/month)
   *
   * @returns The resolved entry date and the block with date header removed
   */
  private preprocessDateHeader(rawBlock: string): { entryDate: Date; blockWithoutDateHeader: string } {
    const lines = rawBlock.split('\n');
    let entryDate = this._anchorDate;
    let dateHeaderLineIndex = -1;

    // Find the first non-empty, non-comment line
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed !== '' && !trimmed.startsWith('#')) {
        // Check if this line is a date header
        const dateHeader = this.parseDateHeader(trimmed);
        if (dateHeader) {
          entryDate = this.resolveDateFromHeader(dateHeader);
          this._anchorDate = entryDate; // sticky: subsequent blocks without a date header inherit this date
          dateHeaderLineIndex = i;
        }
        break; // Only check the first non-empty, non-comment line
      }
    }

    // If we found a date header, remove that line from the block
    if (dateHeaderLineIndex >= 0) {
      const newLines = [...lines];
      newLines.splice(dateHeaderLineIndex, 1);
      return { entryDate, blockWithoutDateHeader: newLines.join('\n') };
    }

    return { entryDate, blockWithoutDateHeader: rawBlock };
  }

  /**
   * Parse a date header line.
   *
   * @returns Parsed date header or null if not a date header
   */
  private parseDateHeader(line: string): { day: number; month: number; weekdayPrefix?: string } | null {
    // Pattern: optional weekday prefix (L,M,X,J,V,S,D) + day (1-2 digits) + "/" + month (1-2 digits)
    const dateHeaderRegex = /^([LMXJVSD])?(\d{1,2})\/(\d{1,2})$/;
    const match = line.match(dateHeaderRegex);

    if (!match) {
      return null;
    }

    const weekdayPrefix = match[1] || undefined;
    const day = parseInt(match[2], 10);
    const month = parseInt(match[3], 10);

    // Validate day and month ranges
    if (day < 1 || day > 31 || month < 1 || month > 12) {
      return null;
    }

    return { day, month, weekdayPrefix };
  }

  /**
   * Resolve a parsed date header to a concrete Date using the anchor year.
   */
  private resolveDateFromHeader(dateHeader: { day: number; month: number; weekdayPrefix?: string }): Date {
    const year = this._anchorDate.getFullYear();
    const resolvedDate = new Date(year, dateHeader.month - 1, dateHeader.day, 0, 0, 0, 0);

    // Validate weekday prefix if provided
    if (dateHeader.weekdayPrefix) {
      const actualDayOfWeek = resolvedDate.getDay();
      const expectedDayOfWeek = WEEKDAY_TO_DAY_OF_WEEK[dateHeader.weekdayPrefix];

      if (actualDayOfWeek !== expectedDayOfWeek) {
        const actualWeekday = DAY_OF_WEEK_TO_LETTER[actualDayOfWeek];
        this._warnings.push(
          `Weekday mismatch: ${dateHeader.weekdayPrefix}${dateHeader.day}/${dateHeader.month} - ` +
          `actual weekday is ${actualWeekday} (${WEEKDAY_NAMES[actualDayOfWeek]})`
        );
      }
    }

    return resolvedDate;
  }

  /**
   * Extract the definition code from the first non-comment line of a raw block.
   *
   * Note: This method is called AFTER date headers have been stripped by
   * preprocessDateHeader(), so the first line should be the definition header.
   *
   * Supports formats:
   *   - "DEF_CODE;..." (single-line)
   *   - "DEF_CODE:subdivision;..." (single-line with subdivision)
   *   - "DEF_CODE:TIM/subdivision;..." (timing header)
   */
  private extractDefinitionCode(rawBlock: string): string | null {
    const lines = rawBlock.split('\n');

    // Find first non-empty, non-comment line
    let firstLine = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed !== '' && !trimmed.startsWith('#')) {
        firstLine = trimmed;
        break;
      }
    }

    if (firstLine === '') return null;

    // Find the first delimiter (: or ;)
    let endIndex = firstLine.length;
    const colonIndex = firstLine.indexOf(':');
    const semicolonIndex = firstLine.indexOf(';');

    if (colonIndex !== -1) {
      endIndex = Math.min(endIndex, colonIndex);
    }
    if (semicolonIndex !== -1) {
      endIndex = Math.min(endIndex, semicolonIndex);
    }

    const code = firstLine.substring(0, endIndex).trim();
    return code || null;
  }
}

// -----------------------------------------------------------------------------
// Helper: Check if a definition is timing-capable
// -----------------------------------------------------------------------------

/**
 * A MetricDefinition supports timing input IF AND ONLY IF
 * it has a Field whose baseDefinition is TIM.
 *
 * No flags. No interfaces. No config files. No special casing.
 */
export function isTimingCapable(
  definition: Definition,
  parsedDefs: ParsedDefinitions
): boolean {
  const fields = parsedDefs.fieldsByMetricCode.get(definition.code) || [];

  for (const field of fields) {
    // Check if this field's baseDefinition is TIM
    const baseDefinition = parsedDefs.definitionsByCode.get('TIM');
    if (baseDefinition && field.baseDefinitionId === baseDefinition.id) {
      return true;
    }
  }

  return false;
}

/**
 * Get the TIM field from a timing-capable definition.
 */
export function getTimField(
  definition: Definition,
  parsedDefs: ParsedDefinitions
): Field | null {
  const fields = parsedDefs.fieldsByMetricCode.get(definition.code) || [];
  const timDef = parsedDefs.definitionsByCode.get('TIM');
  if (!timDef) return null;

  for (const field of fields) {
    if (field.baseDefinitionId === timDef.id) {
      return field;
    }
  }

  return null;
}
