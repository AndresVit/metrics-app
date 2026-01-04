/**
 * defaultParser.ts
 *
 * Default parser for single-line metric entry format.
 *
 * Format: DEF_CODE[:subdivision];key:value,key:value
 *
 * Examples:
 *   BOOK;title:Dune,total_pages:240,total_words:60000
 *   READ:Dune/chapter3;pages_read:12,duration:30
 *
 * This parser handles all metrics that don't require specialized parsing.
 * It is the fallback for non-timing-capable definitions.
 */

import { MetricEntryInput, FieldInput, AttributeValueInput } from '../src/pipeline/types';
import { ParsedDefinitions } from './parseDefinitions';
import { Definition } from '../src/domain';
import { Parser, ParserResult, parserSuccess, parserError, isTimingCapable } from './parserRegistry';

// -----------------------------------------------------------------------------
// Default Parser
// -----------------------------------------------------------------------------

export class DefaultParser implements Parser {
  readonly name = 'DefaultParser';

  /**
   * DefaultParser handles single-line entries for non-timing-capable definitions.
   *
   * Decision: DefaultParser also handles single-line entries for timing-capable
   * definitions IF the input is a single line (backward compatibility).
   * TimingParser only kicks in for multiline blocks.
   */
  canParse(
    definition: Definition,
    rawBlock: string,
    parsedDefs: ParsedDefinitions
  ): boolean {
    const lines = rawBlock.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));

    // Single-line input: DefaultParser handles it
    if (lines.length === 1) {
      return true;
    }

    // Multiline input: only handle if NOT timing-capable
    // (TimingParser will handle timing-capable multiline inputs)
    if (lines.length > 1) {
      return !isTimingCapable(definition, parsedDefs);
    }

    return false;
  }

  parse(
    definition: Definition,
    rawBlock: string,
    parsedDefs: ParsedDefinitions,
    userId: string
  ): ParserResult {
    const lines = rawBlock.split('\n');
    const entries: MetricEntryInput[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip empty lines and comments
      if (line === '' || line.startsWith('#')) continue;

      const result = this.parseSingleLine(line, i + 1, parsedDefs, userId);
      if (!result.success) {
        return result;
      }
      entries.push(...result.entries);
    }

    return parserSuccess(entries);
  }

  private parseSingleLine(
    line: string,
    lineNumber: number,
    parsedDefs: ParsedDefinitions,
    userId: string
  ): ParserResult {
    // Format: DEF_CODE[:subdivision];key:value,key:value
    const semicolonIndex = line.indexOf(';');
    if (semicolonIndex === -1) {
      return parserError(`Missing ';' separator`, lineNumber, line);
    }

    const header = line.substring(0, semicolonIndex);
    const body = line.substring(semicolonIndex + 1);

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
      return parserError('Missing definition code', lineNumber, line);
    }

    // Lookup definition
    const definition = parsedDefs.definitionsByCode.get(definitionCode);
    if (!definition) {
      return parserError(`Unknown definition code: ${definitionCode}`, lineNumber);
    }

    // Get fields for this metric
    const metricFields = parsedDefs.fieldsByMetricCode.get(definitionCode) || [];
    const fieldsByName = new Map(metricFields.map((f) => [f.name, f]));

    // Parse body: key:value,key:value
    const fields: FieldInput[] = [];

    if (body.trim() !== '') {
      const pairs = body.split(',');
      for (const pair of pairs) {
        const pairColonIndex = pair.indexOf(':');
        if (pairColonIndex === -1) {
          return parserError(
            `Invalid key:value pair (missing ':')`,
            lineNumber,
            pair
          );
        }
        const key = pair.substring(0, pairColonIndex).trim();
        const rawValue = pair.substring(pairColonIndex + 1).trim();

        if (key === '') {
          return parserError('Empty key in pair', lineNumber, pair);
        }

        const field = fieldsByName.get(key);
        if (!field) {
          // Unknown field - warning but continue
          console.warn(`Warning: Unknown field "${key}" for metric "${definitionCode}" (line ${lineNumber})`);
          continue;
        }

        const valueInput: AttributeValueInput = {};
        const parsedValue = this.parseValue(rawValue);

        if (typeof parsedValue === 'number') {
          valueInput.valueInt = parsedValue;
        } else {
          valueInput.valueString = parsedValue;
        }

        fields.push({
          fieldId: field.id,
          values: [valueInput],
        });
      }
    }

    const input: MetricEntryInput = {
      definitionId: definition.id,
      timestamp: new Date(),
      subdivision: subdivision || undefined,
      fields,
    };

    return parserSuccess([input]);
  }

  private parseValue(value: string): string | number {
    const trimmed = value.trim();
    const asInt = parseInt(trimmed, 10);
    if (!isNaN(asInt) && String(asInt) === trimmed) {
      return asInt;
    }
    // Try float
    const asFloat = parseFloat(trimmed);
    if (!isNaN(asFloat) && String(asFloat) === trimmed) {
      return asFloat;
    }
    return trimmed;
  }
}
