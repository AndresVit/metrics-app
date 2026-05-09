/**
 * parseEntries.ts
 *
 * Parses entries.txt into MetricEntryInput[].
 *
 * Input format:
 *   DEF_CODE[:subdivision];key:value,key:value
 *
 * Examples:
 *   BOOK;title:Dune,total_pages:240,total_words:60000
 *   READ:Dune/chapter3;pages_read:12,duration:30
 *
 * Rules:
 *   - subdivision is optional (defaults to empty string)
 *   - Values are parsed as int if numeric, otherwise string
 *   - No validation beyond syntax
 *   - No lookup or resolution
 */

import * as fs from 'fs';
import { MetricEntryInput, FieldInput, AttributeValueInput } from '../src/pipeline/types';
import { ParsedDefinitions } from './parseDefinitions';

// -----------------------------------------------------------------------------
// Types for parsed output
// -----------------------------------------------------------------------------

export interface RawParsedEntry {
  definitionCode: string;
  subdivision: string;
  attributes: Map<string, string | number>;
}

// -----------------------------------------------------------------------------
// Parsing functions
// -----------------------------------------------------------------------------

function parseValue(value: string): string | number {
  // Try to parse as integer
  const trimmed = value.trim();
  const asInt = parseInt(trimmed, 10);
  if (!isNaN(asInt) && String(asInt) === trimmed) {
    return asInt;
  }
  // Return as string
  return trimmed;
}

function parseEntryLine(line: string, lineNumber: number): RawParsedEntry | null {
  const trimmed = line.trim();

  // Skip empty lines
  if (trimmed === '') return null;

  // Skip comment lines (optional, for convenience)
  if (trimmed.startsWith('#')) return null;

  // Format: DEF_CODE[:subdivision];key:value,key:value
  const semicolonIndex = trimmed.indexOf(';');
  if (semicolonIndex === -1) {
    throw new Error(`Line ${lineNumber}: Missing ';' separator: ${trimmed}`);
  }

  const header = trimmed.substring(0, semicolonIndex);
  const body = trimmed.substring(semicolonIndex + 1);

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
    throw new Error(`Line ${lineNumber}: Missing definition code: ${trimmed}`);
  }

  // Parse body: key:value,key:value
  const attributes = new Map<string, string | number>();

  if (body.trim() !== '') {
    const pairs = body.split(',');
    for (const pair of pairs) {
      const pairColonIndex = pair.indexOf(':');
      if (pairColonIndex === -1) {
        throw new Error(`Line ${lineNumber}: Invalid key:value pair (missing ':'): ${pair}`);
      }
      const key = pair.substring(0, pairColonIndex).trim();
      const rawValue = pair.substring(pairColonIndex + 1).trim();

      if (key === '') {
        throw new Error(`Line ${lineNumber}: Empty key in pair: ${pair}`);
      }

      attributes.set(key, parseValue(rawValue));
    }
  }

  return {
    definitionCode,
    subdivision,
    attributes,
  };
}

function parseEntriesFile(content: string): RawParsedEntry[] {
  const lines = content.split('\n');
  const entries: RawParsedEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const entry = parseEntryLine(lines[i], i + 1);
    if (entry !== null) {
      entries.push(entry);
    }
  }

  return entries;
}

// -----------------------------------------------------------------------------
// Conversion to MetricEntryInput
// -----------------------------------------------------------------------------

/**
 * Converts raw parsed entries to MetricEntryInput[].
 *
 * Requires ParsedDefinitions for:
 *   - definitionCode -> definitionId mapping
 *   - fieldName -> fieldId mapping
 */
export function convertToMetricEntryInputs(
  rawEntries: RawParsedEntry[],
  parsedDefs: ParsedDefinitions,
  userId: string
): MetricEntryInput[] {
  const results: MetricEntryInput[] = [];

  for (const raw of rawEntries) {
    // Lookup definition by code
    const definition = parsedDefs.definitionsByCode.get(raw.definitionCode);
    if (!definition) {
      throw new Error(`Unknown definition code: ${raw.definitionCode}`);
    }

    // Get fields for this metric
    const metricFields = parsedDefs.fieldsByMetricCode.get(raw.definitionCode) || [];
    const fieldsByName = new Map(metricFields.map((f) => [f.name, f]));

    // Build FieldInput[]
    const fields: FieldInput[] = [];

    for (const [key, value] of raw.attributes) {
      const field = fieldsByName.get(key);
      if (!field) {
        // TODO: Unknown field - skip for now, could be an error
        console.warn(`Warning: Unknown field "${key}" for metric "${raw.definitionCode}"`);
        continue;
      }

      const valueInput: AttributeValueInput = {};
      if (typeof value === 'number') {
        valueInput.valueInt = value;
      } else {
        valueInput.valueString = value;
      }

      fields.push({
        fieldId: field.id,
        values: [valueInput],
      });
    }

    const input: MetricEntryInput = {
      definitionId: definition.id,
      timestamp: new Date(),
      subdivision: raw.subdivision || undefined,
      fields,
    };

    results.push(input);
  }

  return results;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function parseEntriesRaw(filePath: string): RawParsedEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseEntriesFile(content);
}

export function parseEntriesRawFromString(content: string): RawParsedEntry[] {
  return parseEntriesFile(content);
}

export function parseEntries(
  filePath: string,
  parsedDefs: ParsedDefinitions,
  userId: string
): MetricEntryInput[] {
  const raw = parseEntriesRaw(filePath);
  return convertToMetricEntryInputs(raw, parsedDefs, userId);
}

export function parseEntriesFromString(
  content: string,
  parsedDefs: ParsedDefinitions,
  userId: string
): MetricEntryInput[] {
  const raw = parseEntriesRawFromString(content);
  return convertToMetricEntryInputs(raw, parsedDefs, userId);
}
