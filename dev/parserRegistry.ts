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
   * @param rawBlock - The raw input text (single line or multiline)
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
   * @param rawBlock - The raw input text
   * @param parsedDefs - Full parsed definitions for lookups
   * @param userId - User ID for the entries
   * @returns Array of MetricEntryInput (may be multiple for timing blocks)
   */
  parse(
    definition: Definition,
    rawBlock: string,
    parsedDefs: ParsedDefinitions,
    userId: string
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

// -----------------------------------------------------------------------------
// Parser Registry
// -----------------------------------------------------------------------------

/**
 * Registry for parsers.
 *
 * Workflow:
 *   1. Register parsers via register()
 *   2. Call parseBlock() with raw input
 *   3. Registry extracts definition code from header
 *   4. Registry finds all parsers where canParse() === true
 *   5. Errors if not exactly 1 parser matches
 *   6. Delegates to the matching parser
 */
export class ParserRegistry {
  private parsers: Parser[] = [];

  register(parser: Parser): void {
    this.parsers.push(parser);
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
    // Extract definition code from the first line
    const definitionCode = this.extractDefinitionCode(rawBlock);
    if (!definitionCode) {
      return parserError('Could not extract definition code from input block');
    }

    // Lookup definition
    const definition = parsedDefs.definitionsByCode.get(definitionCode);
    if (!definition) {
      return parserError(`Unknown definition code: ${definitionCode}`);
    }

    // Find matching parsers
    const matchingParsers = this.parsers.filter((p) =>
      p.canParse(definition, rawBlock, parsedDefs)
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

    // Exactly one parser matches
    const parser = matchingParsers[0];
    return parser.parse(definition, rawBlock, parsedDefs, userId);
  }

  /**
   * Extract the definition code from the first non-comment line of a raw block.
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
