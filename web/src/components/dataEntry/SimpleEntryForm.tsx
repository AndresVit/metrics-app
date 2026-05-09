/**
 * SimpleEntryForm — Form-based data entry for non-advanced users.
 *
 * Generates raw DSL text via serializeSimpleEntry and feeds it
 * into the same Preview/Insert flow as Advanced mode.
 */

import { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from 'react';
import { MetricTypeahead, type MetricOption } from './MetricTypeahead';
import { SearchKeyTypeahead } from './SearchKeyTypeahead';
import { TimingRow } from './TimingRow';
import { serializeSimpleEntry, type SimpleFormState } from './serializeSimpleEntry';
import { useSettings } from '../settings/SettingsContext';

const API_URL = 'http://localhost:3001';

export interface MetricField {
  name: string;
  type: string; // 'int' | 'float' | 'string'
  optional: boolean;
  isKey?: boolean; // marked with @key — the primary identifier field
  isFormula?: boolean; // computed by the server — not user-input
  referencedMetricCode?: string; // if set, this field is a metric reference
  description?: string; // optional helper text shown under the input
}

export interface MetricDefinitionInfo {
  code: string;
  displayName: string;
  name: string;
  description: string;
  timingCapable: boolean;
  fields: MetricField[];
}

// ─── InfoBox ─────────────────────────────────────────────────────────────────

function MetricInfoBox({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    setExpanded(false);
  }, [description]);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    // Detect whether the text overflows the 3-line clamp
    setOverflows(el.scrollHeight > el.clientHeight + 2);
  }, [description, expanded]);

  if (!description) return null;

  return (
    <div className="metric-info-box">
      <p
        ref={textRef}
        className={`metric-info-box-text${!expanded ? ' metric-info-box-clamped' : ''}`}
      >
        {description}
      </p>
      {(overflows || expanded) && (
        <button
          className="metric-info-box-toggle"
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

interface SimpleEntryFormProps {
  onDslGenerated: (dsl: string) => void;
  onPreview: () => void;
  onInsert: () => Promise<boolean>;
  onClear: () => void;
  isProcessing: boolean;
  error: string | null;
  insertSuccess: string | null;
  /** Called when the selected definition changes (or becomes null) */
  onDefinitionChange?: (def: MetricDefinitionInfo | null) => void;
  /** Called on field blur or Preview click — snapshot of current form values */
  onFormStateChange?: (attrs: Record<string, string>, subdivision: string) => void;
}

const EMPTY_TIMING = { startTime: '', endTime: '', letters: {} as Record<string, string> };

export function SimpleEntryForm({
  onDslGenerated,
  onPreview,
  onInsert,
  onClear,
  isProcessing,
  error,
  insertSuccess,
  onDefinitionChange,
  onFormStateChange,
}: SimpleEntryFormProps) {
  const [definitions, setDefinitions] = useState<MetricDefinitionInfo[]>([]);
  const [loadingDefs, setLoadingDefs] = useState(true);

  const { settings } = useSettings();
  const letterOrder = useMemo(
    () => (settings?.timeTags ?? []).map(t => t.letter),
    [settings]
  );

  const [metricCode, setMetricCode] = useState('');
  const [subdivision, setSubdivision] = useState('');
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [tags, setTags] = useState('');
  const [timing, setTiming] = useState(EMPTY_TIMING);
  const formRef = useRef<HTMLDivElement>(null);

  // Load definitions on mount
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`${API_URL}/api/definitions`);
        const data = await resp.json();
        if (data.success) {
          setDefinitions(data.definitions);
        }
      } catch {
        // Silently fail; form will just show empty metric list
      } finally {
        setLoadingDefs(false);
      }
    })();
  }, []);

  const selectedMetric = definitions.find(d => d.code === metricCode);

  // Notify parent when selected definition changes
  useEffect(() => {
    onDefinitionChange?.(selectedMetric ?? null);
  }, [metricCode, selectedMetric, onDefinitionChange]);

  // Reset attributes when metric changes
  const handleMetricChange = useCallback((code: string) => {
    setMetricCode(code);
    setAttributes({});
    setTags('');
    setTiming(EMPTY_TIMING);
  }, []);

  // Regenerate DSL whenever form state changes
  useEffect(() => {
    if (!metricCode) {
      onDslGenerated('');
      return;
    }

    const fieldTypes: Record<string, string> = {};
    const metricRefs: Record<string, string> = {};
    if (selectedMetric) {
      for (const f of selectedMetric.fields) {
        fieldTypes[f.name] = f.type;
        if (f.referencedMetricCode) {
          metricRefs[f.name] = f.referencedMetricCode;
        }
      }
    }

    const form: SimpleFormState = {
      metricCode,
      subdivision,
      attributes,
      tags,
      timing,
    };

    onDslGenerated(serializeSimpleEntry(form, fieldTypes, metricRefs));
  }, [metricCode, subdivision, attributes, tags, timing, selectedMetric, onDslGenerated]);

  const handleAttributeChange = (name: string, value: string) => {
    setAttributes(prev => ({ ...prev, [name]: value }));
  };

  const handleClear = useCallback(() => {
    setMetricCode('');
    setSubdivision('');
    setAttributes({});
    setTags('');
    setTiming(EMPTY_TIMING);
    onClear();
  }, [onClear]);

  const focusMetricInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = formRef.current?.querySelector<HTMLInputElement>('.metric-typeahead-input');
      input?.focus();
    });
  }, []);

  const handleEnterSubmit = useCallback(async (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    if (!metricCode || isProcessing) return;
    // Don't intercept Enter inside a textarea
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;

    e.preventDefault();
    const success = await onInsert();
    if (success) {
      handleClear();
      focusMetricInput();
    }
  }, [metricCode, isProcessing, onInsert, handleClear, focusMetricInput]);

  const metricOptions: MetricOption[] = definitions.map(d => ({
    code: d.code,
    displayName: d.displayName,
  }));

  const hasContent = metricCode !== '';

  return (
    <div className="simple-entry-form" ref={formRef} onKeyDown={handleEnterSubmit}>
      <div className="simple-attributes">
        {/* Metric selector */}
        <div className="simple-attribute-row">
          <span className="simple-attr-name">metric</span>
          <div className="simple-attr-input-col">
            <MetricTypeahead
              options={metricOptions}
              value={metricCode}
              onChange={handleMetricChange}
              disabled={isProcessing || loadingDefs}
            />
            {selectedMetric && selectedMetric.description && (
              <MetricInfoBox description={selectedMetric.description} />
            )}
          </div>
        </div>

        {/* Subdivision */}
        {selectedMetric && (
          <div className="simple-attribute-row">
            <span className="simple-attr-name">subdivision</span>
            <div className="simple-attr-input-col">
              <input
                type="text"
                className="simple-attr-input"
                value={subdivision}
                onChange={e => setSubdivision(e.target.value)}
                onBlur={e => onFormStateChange?.(attributes, e.target.value)}
                placeholder="e.g. project/task"
                disabled={isProcessing}
              />
            </div>
          </div>
        )}

        {/* Attributes */}
        {selectedMetric && selectedMetric.fields.some(f => !f.isFormula) && (
          <>
            {selectedMetric.fields.filter(f => !f.isFormula).map(field => (
              <div key={field.name} className="simple-attribute-row">
                <span className="simple-attr-name">
                  {field.name}
                  {field.optional && <span className="simple-attr-optional">?</span>}
                  {field.description && (
                    <span
                      className="attr-info-icon"
                      tabIndex={0}
                      role="img"
                      aria-label={`${field.name} info: ${field.description}`}
                      data-tooltip={field.description}
                    >
                      &#9432;
                    </span>
                  )}
                </span>
                <div className="simple-attr-input-col">
                  {field.referencedMetricCode ? (
                    <SearchKeyTypeahead
                      metricCode={field.referencedMetricCode}
                      value={attributes[field.name] || ''}
                      onChange={val => {
                        handleAttributeChange(field.name, val);
                        onFormStateChange?.({ ...attributes, [field.name]: val }, subdivision);
                      }}
                      disabled={isProcessing}
                    />
                  ) : (
                    <input
                      type={field.type === 'int' || field.type === 'float' ? 'number' : 'text'}
                      className="simple-attr-input"
                      value={attributes[field.name] || ''}
                      onChange={e => handleAttributeChange(field.name, e.target.value)}
                      onBlur={e => onFormStateChange?.({ ...attributes, [field.name]: e.target.value }, subdivision)}
                      placeholder={
                        field.optional
                          ? 'optional'
                          : field.type === 'int' || field.type === 'float'
                            ? '0'
                            : ''
                      }
                      step={field.type === 'float' ? 'any' : undefined}
                      disabled={isProcessing}
                    />
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Tags */}
      {selectedMetric && (
        <div className="simple-attribute-row">
          <span className="simple-attr-name">
            tags
            <span className="simple-attr-optional">?</span>
          </span>
          <div className="simple-attr-input-col">
            <input
              type="text"
              className="simple-attr-input"
              value={tags}
              onChange={e => setTags(e.target.value)}
              placeholder="key:value, key:value"
              disabled={isProcessing}
            />
          </div>
        </div>
      )}

      {/* Timing */}
      {selectedMetric?.timingCapable && (
        <div className="simple-field-group">
          <label className="simple-field-label">Timing</label>
          <TimingRow
            timing={timing}
            onChange={setTiming}
            letterOrder={letterOrder}
            disabled={isProcessing}
          />
        </div>
      )}

      {/* Actions */}
      <div className="panel-actions-bottom">
        <button
          className="btn-text"
          onClick={handleClear}
          disabled={isProcessing}
        >
          Clear
        </button>
        <button
          className="btn-outline"
          onClick={() => {
            onFormStateChange?.(attributes, subdivision);
            onPreview();
          }}
          disabled={isProcessing || !hasContent}
        >
          {isProcessing ? 'Processing...' : 'Preview'}
        </button>
        <button
          className="btn-contained-sm"
          onClick={onInsert}
          disabled={isProcessing || !hasContent}
        >
          Insert
        </button>
      </div>

      {error && (
        <div className="entry-error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {insertSuccess && (
        <div className="entry-success">
          {insertSuccess}
        </div>
      )}
    </div>
  );
}
