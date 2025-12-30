import { MetricEntryInput, FieldInput, AttributeValueInput } from './types';

/**
 * Raw parsed result before ID resolution.
 *
 * MVP Limitation: This structure uses codes/names instead of actual IDs.
 * The definitionCode maps to a Definition by code, and fieldName maps to a Field by name.
 * A separate resolution step (not implemented yet) would convert these to actual IDs.
 *
 * TODO: Add a resolveToIds(parsed: ParsedLine[], config: SomeConfig) function
 * that converts codes/names to proper IDs for use with runPipeline.
 */
export interface ParsedLine {
  definitionCode: string;
  subdivision: string;
  attributes: Map<string, string | number>;
  tags: Map<string, string>;
}

/**
 * Parses a single line in the format:
 * <DEF_CODE>[:subdivision] ; <attributes> ; <tags>
 *
 * Blocks:
 * - Block 0: DEF_CODE[:subdivision] (required)
 * - Block 1: attributes as key:value pairs separated by ',' (required)
 * - Block 2: tags as key:value pairs separated by ',' (optional)
 *
 * @returns ParsedLine with extracted data
 */
function parseLine(line: string): ParsedLine {
  const blocks = line.split(';').map((b) => b.trim());

  if (blocks.length < 2) {
    throw new Error(`Invalid line format: expected at least 2 blocks separated by ';', got ${blocks.length}`);
  }

  // Block 0: DEF_CODE[:subdivision]
  const headerBlock = blocks[0];
  let definitionCode: string;
  let subdivision = '';

  const colonIndex = headerBlock.indexOf(':');
  if (colonIndex === -1) {
    definitionCode = headerBlock;
  } else {
    definitionCode = headerBlock.substring(0, colonIndex);
    subdivision = headerBlock.substring(colonIndex + 1);
  }

  if (!definitionCode) {
    throw new Error(`Invalid line format: definition code is empty`);
  }

  // Block 1: attributes (required)
  const attributesBlock = blocks[1];
  const attributes = parseKeyValuePairs(attributesBlock);

  // Block 2: tags (optional)
  const tags = new Map<string, string>();
  if (blocks.length >= 3 && blocks[2]) {
    const tagPairs = parseKeyValuePairs(blocks[2]);
    for (const [key, value] of tagPairs) {
      // Tags are always stored as strings
      tags.set(key, String(value));
    }
  }

  return {
    definitionCode,
    subdivision,
    attributes,
    tags,
  };
}

/**
 * Parses key:value pairs separated by ','.
 * Values are converted to int if numeric, otherwise kept as string.
 */
function parseKeyValuePairs(block: string): Map<string, string | number> {
  const result = new Map<string, string | number>();

  if (!block.trim()) {
    return result;
  }

  const pairs = block.split(',').map((p) => p.trim());

  for (const pair of pairs) {
    if (!pair) continue;

    const colonIndex = pair.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`Invalid key:value pair: "${pair}" (missing ':')`);
    }

    const key = pair.substring(0, colonIndex).trim();
    const rawValue = pair.substring(colonIndex + 1).trim();

    if (!key) {
      throw new Error(`Invalid key:value pair: "${pair}" (empty key)`);
    }

    // Convert to int if numeric, otherwise keep as string
    const numValue = Number(rawValue);
    const value = !isNaN(numValue) && rawValue !== '' ? numValue : rawValue;

    result.set(key, value);
  }

  return result;
}

/**
 * Parses multiline input into ParsedLine objects.
 * Empty lines are skipped.
 *
 * MVP Format (frozen for this task):
 * <DEF_CODE>[:subdivision] ; <attributes> ; <tags>
 *
 * Examples:
 * BOOK;title:Dune,total_pages:240,total_words:60000
 * READ:Dune/chapter3;pages_read:12,duration:30
 * READ:Dune/chapter3;pages_read:12,duration:30;place:library,mode:focus
 */
export function parseInputRaw(input: string): ParsedLine[] {
  const lines = input.split('\n').filter((line) => line.trim() !== '');
  return lines.map(parseLine);
}

/**
 * Converts a ParsedLine to MetricEntryInput.
 *
 * MVP Limitation: Uses codes/names directly as IDs.
 * This works with stub configs where IDs match codes/names.
 *
 * @param parsed - The parsed line
 * @param userId - User ID for the entry
 * @param fieldNameToId - Maps field names to field IDs for the given definition
 */
export function toMetricEntryInput(
  parsed: ParsedLine,
  userId: string,
  fieldNameToId: Map<string, string>
): MetricEntryInput {
  const fields: FieldInput[] = [];

  for (const [fieldName, value] of parsed.attributes) {
    const fieldId = fieldNameToId.get(fieldName);
    if (!fieldId) {
      // MVP: Skip unknown fields with a warning
      // TODO: This should throw an error in production
      console.warn(`Unknown field "${fieldName}" for definition "${parsed.definitionCode}", skipping`);
      continue;
    }

    const valueInput: AttributeValueInput = {};
    if (typeof value === 'number') {
      // MVP: Assume int for numeric values
      // TODO: Should check field datatype to determine int vs float
      valueInput.valueInt = value;
    } else {
      valueInput.valueString = value;
    }

    fields.push({
      fieldId,
      values: [valueInput],
    });
  }

  return {
    definitionId: parsed.definitionCode, // MVP: Using code as ID
    timestamp: new Date(),
    subdivision: parsed.subdivision || undefined,
    fields,
  };
}

/**
 * Configuration for parseInput to resolve codes/names to IDs.
 */
export interface ParseInputConfig {
  /** Maps definition code to definition ID */
  definitionCodeToId: Map<string, string>;
  /** Maps (definitionCode, fieldName) to fieldId. Key format: "defCode:fieldName" */
  fieldNameToId: Map<string, string>;
}

/**
 * Main entry point: parses input string and returns MetricEntryInput[].
 *
 * @param input - Multiline string in MVP format
 * @param userId - User ID for all entries
 * @param config - Optional config to resolve codes to IDs. If not provided, uses codes as IDs.
 */
export function parseInput(
  input: string,
  userId: string,
  config?: ParseInputConfig
): MetricEntryInput[] {
  const parsedLines = parseInputRaw(input);

  return parsedLines.map((parsed) => {
    // Build fieldNameToId map for this definition
    const fieldNameToId = new Map<string, string>();

    if (config) {
      // Use config to resolve IDs
      for (const [key, fieldId] of config.fieldNameToId) {
        const [defCode, fieldName] = key.split(':');
        if (defCode === parsed.definitionCode) {
          fieldNameToId.set(fieldName, fieldId);
        }
      }
    } else {
      // MVP fallback: use field names as field IDs
      for (const fieldName of parsed.attributes.keys()) {
        fieldNameToId.set(fieldName, fieldName);
      }
    }

    const entry = toMetricEntryInput(parsed, userId, fieldNameToId);

    // Resolve definitionId if config provided
    if (config) {
      const defId = config.definitionCodeToId.get(parsed.definitionCode);
      if (defId) {
        entry.definitionId = defId;
      }
      // else: keep code as ID (will fail in pipeline, but that's expected)
    }

    return entry;
  });
}

/**
 * Extended result that includes tags (not part of MetricEntryInput).
 * Use this when you need to access parsed tags.
 */
export interface ParsedEntryWithTags {
  entry: MetricEntryInput;
  tags: Map<string, string>;
}

/**
 * Parses input and returns extended results including tags.
 */
export function parseInputWithTags(
  input: string,
  userId: string,
  config?: ParseInputConfig
): ParsedEntryWithTags[] {
  const parsedLines = parseInputRaw(input);

  return parsedLines.map((parsed) => {
    const fieldNameToId = new Map<string, string>();

    if (config) {
      for (const [key, fieldId] of config.fieldNameToId) {
        const [defCode, fieldName] = key.split(':');
        if (defCode === parsed.definitionCode) {
          fieldNameToId.set(fieldName, fieldId);
        }
      }
    } else {
      for (const fieldName of parsed.attributes.keys()) {
        fieldNameToId.set(fieldName, fieldName);
      }
    }

    const entry = toMetricEntryInput(parsed, userId, fieldNameToId);

    if (config) {
      const defId = config.definitionCodeToId.get(parsed.definitionCode);
      if (defId) {
        entry.definitionId = defId;
      }
    }

    return {
      entry,
      tags: parsed.tags,
    };
  });
}
