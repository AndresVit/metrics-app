/**
 * parseDefinitions.ts
 *
 * Parses definitions.txt into in-memory domain structures.
 *
 * Input format:
 *   METRIC <CODE>
 *     <field_name>: <type>
 *     ...
 *   END
 *
 * Where <type> is:
 *   - "int" or "string" (primitives)
 *   - Another metric CODE (reference)
 *
 * Output:
 *   - Definition[] (one per metric, one per attribute)
 *   - MetricDefinition[] (one per metric)
 *   - AttributeDefinition[] (one per primitive field)
 *   - Field[] (one per field)
 */

import * as fs from 'fs';
import {
  Definition,
  MetricDefinition,
  AttributeDefinition,
  Field,
  AttributeDatatype,
} from '../src/domain';

// -----------------------------------------------------------------------------
// Types for parsed output
// -----------------------------------------------------------------------------

export interface ParsedDefinitions {
  definitions: Definition[];
  metricDefinitions: MetricDefinition[];
  attributeDefinitions: AttributeDefinition[];
  fields: Field[];
  // Lookup maps for convenience
  definitionsByCode: Map<string, Definition>;
  fieldsByMetricCode: Map<string, Field[]>;
}

// -----------------------------------------------------------------------------
// Internal types for parsing
// -----------------------------------------------------------------------------

interface RawMetricDefinition {
  code: string;
  fields: RawFieldDefinition[];
}

interface RawFieldDefinition {
  name: string;
  type: string; // "int", "string", or a metric CODE
  formula: string | null; // optional formula (e.g., "subdivision[0]")
  optional: boolean; // field is optional (minInstances = 0)
  minInstances: number | null; // explicit cardinality from (min,max) syntax
  maxInstances: number | null; // explicit cardinality; null = unlimited (n)
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const USER_ID = 'sandbox-user';
// Supported primitive types:
// - 'int': integer values only
// - 'float': decimal values (NOT 'number' - that's invalid)
// - 'string': text values
const PRIMITIVE_TYPES = new Set(['int', 'float', 'string']);

// -----------------------------------------------------------------------------
// Parsing functions
// -----------------------------------------------------------------------------

function parseDefinitionsFile(content: string): RawMetricDefinition[] {
  const lines = content.split('\n');
  const metrics: RawMetricDefinition[] = [];

  let currentMetric: RawMetricDefinition | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed === '') continue;

    // METRIC <CODE> opens a definition
    if (trimmed.startsWith('METRIC ')) {
      const code = trimmed.substring(7).trim();
      if (code === '') {
        throw new Error(`Line ${i + 1}: METRIC missing code`);
      }
      currentMetric = { code, fields: [] };
      continue;
    }

    // END closes the definition
    if (trimmed === 'END') {
      if (currentMetric === null) {
        throw new Error(`Line ${i + 1}: END without matching METRIC`);
      }
      metrics.push(currentMetric);
      currentMetric = null;
      continue;
    }

    // Indented lines define fields: name[?]: type [= formula]
    // The ? suffix makes the field optional (minInstances = 0)
    if (currentMetric !== null) {
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) {
        throw new Error(`Line ${i + 1}: Invalid field syntax (missing ':'): ${trimmed}`);
      }
      let name = trimmed.substring(0, colonIndex).trim();
      let rest = trimmed.substring(colonIndex + 1).trim();

      // Check for optional marker
      let optional = false;
      if (name.endsWith('?')) {
        optional = true;
        name = name.substring(0, name.length - 1).trim();
      }

      // Check for formula: "type = formula"
      let type: string;
      let formula: string | null = null;
      const equalsIndex = rest.indexOf('=');
      if (equalsIndex !== -1) {
        type = rest.substring(0, equalsIndex).trim();
        formula = rest.substring(equalsIndex + 1).trim();
      } else {
        type = rest;
      }

      // Parse explicit cardinality: "type (min,max)" or "type (min,n)"
      let minInstances: number | null = null;
      let maxInstances: number | null = null;
      const cardinalityMatch = type.match(/^(\S+)\s+\((\d+),(\d+|n)\)$/);
      if (cardinalityMatch) {
        type = cardinalityMatch[1];
        minInstances = parseInt(cardinalityMatch[2], 10);
        maxInstances = cardinalityMatch[3] === 'n' ? null : parseInt(cardinalityMatch[3], 10);
      }

      if (name === '' || type === '') {
        throw new Error(`Line ${i + 1}: Invalid field syntax: ${trimmed}`);
      }
      currentMetric.fields.push({ name, type, formula, optional, minInstances, maxInstances });
    }
  }

  if (currentMetric !== null) {
    throw new Error(`Unclosed METRIC block: ${currentMetric.code}`);
  }

  return metrics;
}

function mapPrimitiveToDatatype(primitiveType: string): AttributeDatatype {
  switch (primitiveType) {
    case 'int':
      return 'int';
    case 'float':
      return 'float';
    case 'string':
      return 'string';
    default:
      // Fail fast if 'number' or other invalid type is used
      if (primitiveType === 'number') {
        throw new Error(
          `Invalid type 'number'. Use 'int' for integers or 'float' for decimals.`
        );
      }
      throw new Error(`Unknown primitive type: ${primitiveType}`);
  }
}

function buildDomainObjects(rawMetrics: RawMetricDefinition[]): ParsedDefinitions {
  const now = new Date();

  const definitions: Definition[] = [];
  const metricDefinitions: MetricDefinition[] = [];
  const attributeDefinitions: AttributeDefinition[] = [];
  const fields: Field[] = [];

  const definitionsByCode = new Map<string, Definition>();
  const fieldsByMetricCode = new Map<string, Field[]>();
  // Track MetricDefinition by defId for later update of primaryIdentifierFieldId
  const metricDefinitionsByDefId = new Map<string, MetricDefinition>();

  // Collect all metric codes for reference validation
  const metricCodes = new Set(rawMetrics.map((m) => m.code));

  // First pass: create Definition and MetricDefinition for each metric
  for (const raw of rawMetrics) {
    const defId = `def-${raw.code.toLowerCase()}`;

    const definition = new Definition(
      defId,
      USER_ID,
      'metric',
      raw.code,
      raw.code, // displayName = code for simplicity
      null,
      null,
      now,
      now
    );
    definitions.push(definition);
    definitionsByCode.set(raw.code, definition);

    // primaryIdentifierFieldId will be set in third pass after fields are created
    const metricDefinition = new MetricDefinition(defId, null);
    metricDefinitions.push(metricDefinition);
    metricDefinitionsByDefId.set(defId, metricDefinition);

    fieldsByMetricCode.set(raw.code, []);
  }

  // Second pass: create fields (and attribute definitions for primitives)
  for (const raw of rawMetrics) {
    const metricDefId = `def-${raw.code.toLowerCase()}`;
    const metricFields: Field[] = [];

    for (const rawField of raw.fields) {
      const fieldId = `field-${raw.code.toLowerCase()}-${rawField.name}`;
      const isPrimitive = PRIMITIVE_TYPES.has(rawField.type);
      const isReference = metricCodes.has(rawField.type);

      if (!isPrimitive && !isReference) {
        throw new Error(
          `Unknown type "${rawField.type}" for field "${rawField.name}" in metric "${raw.code}". ` +
          `Must be a primitive (int, string) or a metric code.`
        );
      }

      let baseDefinitionId: string;

      if (isPrimitive) {
        // Create an attribute definition for this field
        // Code is scoped by metric to avoid collisions (e.g., "est.adv" vs "tim.duration")
        // Logical ID uses def- prefix for consistency with DefinitionRepository
        const scopedCode = `${raw.code.toLowerCase()}.${rawField.name}`;
        const attrDefId = `def-${scopedCode}`;

        const attrDefinition = new Definition(
          attrDefId,
          USER_ID,
          'attribute',
          scopedCode,
          rawField.name, // displayName remains just the field name
          null,
          null,
          now,
          now
        );
        definitions.push(attrDefinition);
        definitionsByCode.set(`${raw.code}:${rawField.name}`, attrDefinition);

        const attributeDefinition = new AttributeDefinition(
          attrDefId,
          mapPrimitiveToDatatype(rawField.type)
        );
        attributeDefinitions.push(attributeDefinition);

        baseDefinitionId = attrDefId;
      } else {
        // Reference to another metric
        baseDefinitionId = `def-${rawField.type.toLowerCase()}`;
      }

      // Determine input mode based on whether formula is present
      const inputMode = rawField.formula ? 'formula' : 'input';

      // Determine cardinality:
      // 1. Explicit (min,max) syntax takes precedence
      // 2. Otherwise: optional ? 0 : 1 for min, 1 for max
      let minInstances: number;
      let maxInstances: number | null;
      if (rawField.minInstances !== null) {
        minInstances = rawField.minInstances;
        maxInstances = rawField.maxInstances;
      } else {
        minInstances = rawField.optional ? 0 : 1;
        maxInstances = 1;
      }

      const field = new Field(
        fieldId,
        USER_ID,
        metricDefId,
        rawField.name,
        baseDefinitionId,
        minInstances,
        maxInstances,
        inputMode,
        rawField.formula,
        now,
        now
      );
      fields.push(field);
      metricFields.push(field);
    }

    fieldsByMetricCode.set(raw.code, metricFields);
  }

  // Third pass: set primaryIdentifierFieldId for each metric
  // MVP convention: first string field is the primary identifier
  // TODO: Allow explicit declaration in definitions.txt format if needed
  for (const raw of rawMetrics) {
    const metricDefId = `def-${raw.code.toLowerCase()}`;
    const metricDef = metricDefinitionsByDefId.get(metricDefId);
    if (!metricDef) continue;

    const metricFields = fieldsByMetricCode.get(raw.code) || [];
    // Find first field with string type (primitive string, not a metric reference)
    for (const rawField of raw.fields) {
      if (rawField.type === 'string') {
        const fieldId = `field-${raw.code.toLowerCase()}-${rawField.name}`;
        metricDef.primaryIdentifierFieldId = fieldId;
        break;
      }
    }
    // If no string field found, primaryIdentifierFieldId remains null
    // This is valid for metrics that don't need instance resolution
  }

  return {
    definitions,
    metricDefinitions,
    attributeDefinitions,
    fields,
    definitionsByCode,
    fieldsByMetricCode,
  };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function parseDefinitions(filePath: string): ParsedDefinitions {
  const content = fs.readFileSync(filePath, 'utf-8');
  const rawMetrics = parseDefinitionsFile(content);
  return buildDomainObjects(rawMetrics);
}

export function parseDefinitionsFromString(content: string): ParsedDefinitions {
  const rawMetrics = parseDefinitionsFile(content);
  return buildDomainObjects(rawMetrics);
}
