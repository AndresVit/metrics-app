/**
 * serializeSimpleEntry.ts
 *
 * Converts Simple mode form state into raw DSL text
 * that can be fed into the existing parse-preview / insert pipeline.
 *
 * ## Generated DSL formats
 *
 * Non-timing entry:
 *   DEF_CODE[:subdivision];key:value,key:value
 *
 * Timing-capable entry:
 *   DEF_CODE[:subdivision];key:value,key:value
 *   HHMM-HHMM tXmYpZnW
 *
 * ## Adding support for new attribute types
 *
 * The serializer uses `serializeAttributeValue()` to convert form values
 * to DSL strings. To support a new attribute type:
 *
 * 1. Add the type to the `MetricField.type` union in SimpleEntryForm.tsx
 * 2. Add a case to `serializeAttributeValue()` below for formatting
 * 3. Add an appropriate input element in SimpleEntryForm.tsx's attribute row renderer
 *
 * Current supported types: int, float, string.
 * Bool/timestamp/hierarchyString can be added following the same pattern.
 */

export interface SimpleFormState {
  metricCode: string;
  subdivision: string;
  attributes: Record<string, string>; // field name → string value from input
  /** Free-form tag string: "key:value, key:value". Empty string = no tags. */
  tags: string;
  /** Timing fields (only used when metric is timing-capable) */
  timing: {
    startTime: string; // HH:MM format
    endTime: string;   // HH:MM format
    /** Per-letter minute values, keyed by single a-z. */
    letters: Record<string, string>;
  };
}

function serializeAttributeValue(value: string, _type: string, referencedMetricCode?: string): string {
  // Metric-reference fields: serialize as METRIC_CODE="value"
  if (referencedMetricCode) {
    return `${referencedMetricCode}="${value}"`;
  }
  // All other values are serialized as-is in DSL; the parser handles type coercion.
  // Empty values are excluded by the caller.
  return value;
}

/**
 * Convert HH:MM to HHMM format for DSL.
 * Returns null if the input is empty or invalid.
 */
function formatTime(hhMm: string): string | null {
  const trimmed = hhMm.trim();
  if (!trimmed) return null;

  // Accept HH:MM or HHMM
  const match = trimmed.match(/^(\d{1,2}):?(\d{2})$/);
  if (!match) return null;

  const hh = match[1].padStart(2, '0');
  const mm = match[2];
  return `${hh}${mm}`;
}

export function serializeSimpleEntry(
  form: SimpleFormState,
  fieldTypes: Record<string, string>,
  metricRefs?: Record<string, string>
): string {
  if (!form.metricCode) return '';

  // Build header: DEF_CODE[:subdivision]
  let header = form.metricCode;
  if (form.subdivision.trim()) {
    header += `:${form.subdivision.trim()}`;
  }

  // Build attributes: key:value,key:value
  const attrParts: string[] = [];
  for (const [name, value] of Object.entries(form.attributes)) {
    if (value.trim() === '') continue;
    const serialized = serializeAttributeValue(value.trim(), fieldTypes[name] || 'string', metricRefs?.[name]);
    attrParts.push(`${name}:${serialized}`);
  }

  // Tags block (optional 3rd ;-separated section).
  // We always emit the attributes ';' so the tags ';' is positionally correct
  // even when no attributes are set: DEF;[attrs];tags
  const tagsPart = form.tags.trim();
  const hasTags = tagsPart !== '';
  if (attrParts.length > 0 || hasTags) {
    header += `;${attrParts.join(',')}`;
  }
  if (hasTags) {
    header += `;${tagsPart}`;
  }

  // Build timing line if times are provided. Letter order is preserved from
  // the form (which renders settings.timeTags in their configured order).
  const startFormatted = formatTime(form.timing.startTime);
  const endFormatted = formatTime(form.timing.endTime);

  if (startFormatted && endFormatted) {
    const tokens: string[] = [];
    for (const [letter, raw] of Object.entries(form.timing.letters)) {
      const v = parseInt(raw, 10);
      if (Number.isFinite(v) && v > 0) tokens.push(`${letter}${v}`);
    }
    const tokenStr = tokens.join('');
    const timingLine = `${startFormatted}-${endFormatted}${tokenStr ? ' ' + tokenStr : ''}`;
    return `${header}\n${timingLine}`;
  }

  return header;
}
