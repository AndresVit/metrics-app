import { useState, useEffect, useCallback } from 'react';
import { AutocompleteSelect } from './AutocompleteSelect';

const API_URL = 'http://localhost:3001';

// ─── Data model ──────────────────────────────────────────────────────────────

interface AttributeModel {
  id: string;
  internalName: string;
  displayName: string;
  description: string;
  type: string; // 'int' | 'float' | 'string' | METRIC_CODE
  optional: boolean;
  isKey: boolean;
  mode: 'input' | 'formula';
  formula: string;
  /** True for the locked TIM timing primitives (time_init/time_end/duration/time_type). */
  isSystemAttr?: boolean;
}

interface DefinitionModel {
  code: string;
  name: string;
  description: string;
  /** Free-form, optionally hierarchical (e.g. "productive", "maintenance/getting-ready"). */
  category: string | null;
  isSystem: boolean;
  attributes: AttributeModel[];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function toSnakeCase(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function toRawFormat(def: DefinitionModel | CreateForm): string {
  const code = 'code' in def ? def.code : '';
  const name = 'name' in def ? def.name : '';
  const description = 'description' in def ? def.description : '';
  const category = 'category' in def ? (def.category || '') : '';
  const attrs: AttributeModel[] = 'attributes' in def ? def.attributes : [];
  const lines = [`METRIC ${code}`];
  if (name && name !== code) lines.push(`  NAME "${name}"`);
  if (description) lines.push(`  DESCRIPTION "${description}"`);
  if (category) lines.push(`  CATEGORY "${category}"`);
  if ((name && name !== code) || description || category) lines.push('');
  for (const attr of attrs) {
    let line = `  ${attr.internalName}`;
    if (attr.optional) line += '?';
    line += `: ${attr.type}`;
    if (attr.isKey) line += ' @key';
    if (attr.mode === 'formula' && attr.formula) line += ` = ${attr.formula}`;
    lines.push(line);
  }
  lines.push('END');
  return lines.join('\n');
}

const EMPTY_ATTR: AttributeFormState = {
  displayName: '',
  internalName: '',
  description: '',
  type: 'int',
  optional: false,
  isKey: false,
  mode: 'input',
  formula: '',
};

// ─── Form state types ─────────────────────────────────────────────────────────

interface AttributeFormState {
  displayName: string;
  internalName: string;
  description: string;
  type: string;
  optional: boolean;
  isKey: boolean;
  mode: 'input' | 'formula';
  formula: string;
}

interface CreateForm {
  name: string;
  code: string;
  description: string;
  category: string;
  attributes: AttributeModel[];
}

// ─── Attribute form ───────────────────────────────────────────────────────────

interface AttributeFormProps {
  value: AttributeFormState;
  onChange: (v: AttributeFormState) => void;
  existingDefinitions: DefinitionModel[];
  isCreatingDefinition: boolean; // true = allow isKey, false = isKey locked after creation
  hasKeyAlready: boolean;
}

function AttributeForm({ value, onChange, existingDefinitions, isCreatingDefinition, hasKeyAlready }: AttributeFormProps) {
  const typeOptions = [
    { value: 'int', label: 'int' },
    { value: 'float', label: 'float' },
    { value: 'string', label: 'string' },
    ...existingDefinitions
      .filter((d) => !d.isSystem)
      .map((d) => ({ value: d.code, label: `${d.code} – ${d.name}` })),
  ];

  const isPrimitive = ['int', 'float', 'string'].includes(value.type);

  const handleDisplayNameChange = (displayName: string) => {
    onChange({ ...value, displayName, internalName: toSnakeCase(displayName) });
  };

  const handleTypeChange = (type: string) => {
    const updates: Partial<AttributeFormState> = { type };
    // If not primitive, key is not allowed
    if (!['int', 'string'].includes(type)) {
      updates.isKey = false;
      updates.optional = false;
    }
    // Formula not allowed for reference types
    if (!['int', 'float', 'string'].includes(type) && value.mode === 'formula') {
      updates.mode = 'input';
      updates.formula = '';
    }
    onChange({ ...value, ...updates });
  };

  const handleIsKeyChange = (isKey: boolean) => {
    const updates: Partial<AttributeFormState> = { isKey };
    if (isKey) {
      // Key must be: string or int, not optional, input mode
      updates.optional = false;
      updates.mode = 'input';
      updates.formula = '';
    }
    onChange({ ...value, ...updates });
  };

  return (
    <div className="attr-form">
      <div className="form-row-2">
        <div className="form-field">
          <label>Display Name</label>
          <input
            type="text"
            value={value.displayName}
            onChange={(e) => handleDisplayNameChange(e.target.value)}
            placeholder="e.g. Total Pages"
          />
        </div>
        <div className="form-field">
          <label>Internal Name (auto)</label>
          <input
            type="text"
            value={value.internalName}
            onChange={(e) => onChange({ ...value, internalName: e.target.value })}
            placeholder="total_pages"
          />
        </div>
      </div>

      <div className="form-field">
        <label>Description</label>
        <input
          type="text"
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          placeholder="Optional description"
        />
      </div>

      <div className="form-row-3">
        <div className="form-field">
          <label>Type</label>
          <AutocompleteSelect
            options={typeOptions}
            value={value.type}
            onChange={handleTypeChange}
            placeholder="int / float / string / CODE"
          />
        </div>

        <div className="form-field form-field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={value.optional}
              disabled={value.isKey}
              onChange={(e) => onChange({ ...value, optional: e.target.checked })}
            />
            {' '}Optional
          </label>
        </div>

        <div className="form-field form-field-checkbox">
          <label title={!isCreatingDefinition ? 'Key can only be set at creation time' : (hasKeyAlready && !value.isKey ? 'Only one key allowed' : '')}>
            <input
              type="checkbox"
              checked={value.isKey}
              disabled={!isCreatingDefinition || (!['int', 'string'].includes(value.type) && !isPrimitive) || (hasKeyAlready && !value.isKey)}
              onChange={(e) => handleIsKeyChange(e.target.checked)}
            />
            {' '}Key
          </label>
        </div>
      </div>

      {isPrimitive && (
        <div className="form-row-2">
          <div className="form-field">
            <label>Mode</label>
            <div className="segmented-control">
              <button
                type="button"
                className={value.mode === 'input' ? 'active' : ''}
                onClick={() => onChange({ ...value, mode: 'input', formula: '' })}
                disabled={value.isKey}
              >
                Input
              </button>
              <button
                type="button"
                className={value.mode === 'formula' ? 'active' : ''}
                onClick={() => onChange({ ...value, mode: 'formula' })}
                disabled={value.isKey}
              >
                Formula
              </button>
            </div>
          </div>
          {value.mode === 'formula' && (
            <div className="form-field">
              <label>Formula</label>
              <input
                type="text"
                value={value.formula}
                onChange={(e) => onChange({ ...value, formula: e.target.value })}
                placeholder="self.total_words / self.total_pages"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Backfill Dialog ──────────────────────────────────────────────────────────

interface BackfillDialogProps {
  attr: AttributeFormState;
  onConfirm: (backfill: { type: 'none' | 'fixed_value'; value?: string }) => void;
  onCancel: () => void;
}

function BackfillDialog({ attr, onConfirm, onCancel }: BackfillDialogProps) {
  const [backfillType, setBackfillType] = useState<'none' | 'fixed_value'>(
    attr.optional ? 'none' : 'fixed_value'
  );
  const [fixedValue, setFixedValue] = useState('');

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Backfill existing entries</h3>
          <button className="modal-close" onClick={onCancel}>&times;</button>
        </div>
        <div className="modal-body">
          <p>
            This definition already has entries. Choose how to populate the new attribute
            <strong> {attr.displayName || attr.internalName}</strong>:
          </p>
          <div className="backfill-options">
            {attr.optional && (
              <label className="backfill-option">
                <input
                  type="radio"
                  name="backfill"
                  checked={backfillType === 'none'}
                  onChange={() => setBackfillType('none')}
                />
                <span>No backfill (leave empty — attribute is optional)</span>
              </label>
            )}
            <label className="backfill-option">
              <input
                type="radio"
                name="backfill"
                checked={backfillType === 'fixed_value'}
                onChange={() => setBackfillType('fixed_value')}
              />
              <span>Set a fixed value for all existing entries</span>
            </label>
          </div>
          {backfillType === 'fixed_value' && (
            <div className="form-field" style={{ marginTop: '0.75rem' }}>
              <label>Fixed value</label>
              <input
                type={attr.type === 'int' ? 'number' : attr.type === 'float' ? 'number' : 'text'}
                step={attr.type === 'float' ? 'any' : undefined}
                value={fixedValue}
                onChange={(e) => setFixedValue(e.target.value)}
                placeholder={`Enter ${attr.type} value`}
                autoFocus
              />
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            onClick={() => onConfirm({ type: backfillType, value: backfillType === 'fixed_value' ? fixedValue : undefined })}
            disabled={backfillType === 'fixed_value' && !fixedValue.trim()}
          >
            Add Attribute
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete Confirm Dialog ────────────────────────────────────────────────────

interface DeleteConfirmProps {
  attrName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteConfirmDialog({ attrName, onConfirm, onCancel }: DeleteConfirmProps) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content modal-content-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Delete attribute</h3>
          <button className="modal-close" onClick={onCancel}>&times;</button>
        </div>
        <div className="modal-body">
          <p>
            This will remove <strong>{attrName}</strong> from all existing entries.
            This cannot be undone.
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ─── Raw Drawer ───────────────────────────────────────────────────────────────

function RawDrawer({
  definition,
  onClose,
}: {
  definition: DefinitionModel | CreateForm | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const raw = definition ? toRawFormat(definition) : '';

  const handleCopy = () => {
    navigator.clipboard.writeText(raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="def-raw-drawer-overlay" onClick={onClose}>
      <div className="def-raw-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="def-raw-drawer-header">
          <span className="panel-title">Raw Format</span>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <button className="btn-sm btn-text" onClick={handleCopy} disabled={!definition}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button className="modal-close" onClick={onClose}>&times;</button>
          </div>
        </div>
        <div className="def-raw-drawer-body">
          {definition ? (
            <pre className="def-raw-preview def-raw-preview-drawer">{raw}</pre>
          ) : (
            <div className="def-preview-empty">Select or create a definition to see the raw format.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Create Definition Form ───────────────────────────────────────────────────

interface CreateDefinitionFormProps {
  definitions: DefinitionModel[];
  onCreated: () => void;
  onCancel: () => void;
  formState: CreateForm;
  onFormChange: (f: CreateForm) => void;
  onToggleRaw: () => void;
}

function CreateDefinitionForm({ definitions, onCreated, onCancel, formState, onFormChange, onToggleRaw }: CreateDefinitionFormProps) {
  const [attrForm, setAttrForm] = useState<AttributeFormState>(EMPTY_ATTR);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasKey = formState.attributes.some((a) => a.isKey);
  const hasTiming = formState.attributes.some((a) => a.internalName === 'timing' && a.type === 'TIM');

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFormChange({ ...formState, code: e.target.value.toUpperCase().slice(0, 4) });
  };

  const handleTimingToggle = (checked: boolean) => {
    if (checked) {
      const timingAttr: AttributeModel = { id: '', internalName: 'timing', displayName: 'timing', description: '', type: 'TIM', optional: false, isKey: false, mode: 'input', formula: '' };
      onFormChange({ ...formState, attributes: [timingAttr, ...formState.attributes] });
    } else {
      onFormChange({ ...formState, attributes: formState.attributes.filter((a) => !(a.internalName === 'timing' && a.type === 'TIM')) });
    }
  };

  const handleAddAttribute = () => {
    if (!attrForm.internalName.trim()) {
      setError('Attribute internal name is required');
      return;
    }
    if (attrForm.internalName.trim() === 'timing') {
      setError('"timing" is reserved — use the "Includes timing" checkbox above.');
      return;
    }
    if (formState.attributes.some((a) => a.internalName === attrForm.internalName)) {
      setError(`Attribute "${attrForm.internalName}" already added`);
      return;
    }
    if (attrForm.isKey && hasKey) {
      setError('Only one key attribute is allowed');
      return;
    }
    setError(null);
    const newAttr: AttributeModel = {
      id: '',
      internalName: attrForm.internalName,
      displayName: attrForm.displayName || attrForm.internalName,
      description: attrForm.description,
      type: attrForm.type,
      optional: attrForm.optional,
      isKey: attrForm.isKey,
      mode: attrForm.mode,
      formula: attrForm.formula,
    };
    onFormChange({ ...formState, attributes: [...formState.attributes, newAttr] });
    setAttrForm(EMPTY_ATTR);
  };

  const handleRemovePendingAttr = (internalName: string) => {
    onFormChange({ ...formState, attributes: formState.attributes.filter((a) => a.internalName !== internalName) });
  };

  const handleSubmit = async () => {
    if (!formState.name.trim()) { setError('Name is required'); return; }
    if (!/^[A-Z]{3,4}$/.test(formState.code)) { setError('Code must be 3–4 uppercase letters'); return; }
    setError(null);
    setSaving(true);
    try {
      const resp = await fetch(`${API_URL}/api/schema/definitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formState.name,
          code: formState.code,
          description: formState.description,
          category: formState.category,
          attributes: formState.attributes,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        onCreated();
      } else {
        setError(data.error || 'Failed to create definition');
      }
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="def-panel def-panel-center">
      <div className="panel-title-row">
        <span className="panel-title">New Definition</span>
        <button className="btn-raw-toggle" onClick={onToggleRaw}>&lt;/&gt; Raw</button>
      </div>

      <div className="def-form-section">
        <div className="form-row-2">
          <div className="form-field">
            <label>Name</label>
            <input
              type="text"
              value={formState.name}
              onChange={(e) => onFormChange({ ...formState, name: e.target.value })}
              placeholder="e.g. Book"
            />
          </div>
          <div className="form-field">
            <label>Code <span className="field-hint">(3–4 uppercase, permanent)</span></label>
            <input
              type="text"
              value={formState.code}
              onChange={handleCodeChange}
              placeholder="BOOK"
              maxLength={4}
            />
          </div>
        </div>
        <div className="form-field">
          <label>Description</label>
          <textarea
            value={formState.description}
            onChange={(e) => onFormChange({ ...formState, description: e.target.value })}
            placeholder="Optional description"
            rows={2}
          />
        </div>
        <div className="form-field">
          <label>Category <span className="field-hint">(optional, hierarchical with /)</span></label>
          <input
            type="text"
            value={formState.category}
            onChange={(e) => onFormChange({ ...formState, category: e.target.value })}
            placeholder="e.g. productive  or  productive/uni"
          />
        </div>
      </div>

      <div className="def-form-section">
        <label className="form-field-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '13px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={hasTiming}
            onChange={(e) => handleTimingToggle(e.target.checked)}
          />
          Includes timing <span className="def-code-badge" style={{ marginLeft: '0.25rem' }}>TIM</span>
        </label>
      </div>

      {formState.attributes.length > 0 && (
        <div className="def-form-section">
          <div className="def-attr-list-label">Added attributes</div>
          <div className="def-attr-list">
            {hasTiming && (
              <div className="def-attr-chip" style={{ opacity: 0.6, cursor: 'default' }}>
                <span className="attr-chip-name">timing</span>
                <span className="attr-chip-type">TIM</span>
              </div>
            )}
            {formState.attributes
              .filter((a) => !(a.internalName === 'timing' && a.type === 'TIM'))
              .map((attr) => (
                <div key={attr.internalName} className="def-attr-chip">
                  <span className="attr-chip-name">{attr.internalName}</span>
                  <span className="attr-chip-type">{attr.type}</span>
                  {attr.isKey && <span className="attr-chip-badge">@key</span>}
                  {attr.optional && <span className="attr-chip-badge optional">opt</span>}
                  {attr.mode === 'formula' && <span className="attr-chip-badge formula">formula</span>}
                  <button className="attr-chip-remove" onClick={() => handleRemovePendingAttr(attr.internalName)} title="Remove">×</button>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="def-form-section">
        <div className="def-attr-list-label">Add attribute</div>
        <AttributeForm
          value={attrForm}
          onChange={setAttrForm}
          existingDefinitions={definitions}
          isCreatingDefinition={true}
          hasKeyAlready={hasKey && !attrForm.isKey}
        />
        <button className="btn-outline" style={{ marginTop: '0.5rem' }} onClick={handleAddAttribute}>
          + Add Attribute
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="panel-actions-bottom">
        <button className="btn-text" onClick={onCancel} disabled={saving}>Cancel</button>
        <button onClick={handleSubmit} disabled={saving || !formState.name.trim() || !formState.code}>
          {saving ? 'Creating...' : 'Create Definition'}
        </button>
      </div>
    </div>
  );
}

// ─── Edit Definition Form ─────────────────────────────────────────────────────

interface EditDefinitionFormProps {
  definition: DefinitionModel;
  definitions: DefinitionModel[];
  onUpdated: () => void;
  onToggleRaw: () => void;
}

function EditDefinitionForm({ definition, definitions, onUpdated, onToggleRaw }: EditDefinitionFormProps) {
  const [name, setName] = useState(definition.name);
  const [desc, setDesc] = useState(definition.description);
  const [category, setCategory] = useState(definition.category ?? '');
  const [savedName, setSavedName] = useState(definition.name);
  const [savedDesc, setSavedDesc] = useState(definition.description);
  const [savedCategory, setSavedCategory] = useState(definition.category ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Inline edit state for attributes
  const [editingAttrName, setEditingAttrName] = useState<string | null>(null);
  const [editAttrForm, setEditAttrForm] = useState<Partial<AttributeFormState>>({});

  // Add attribute state
  const [addingAttr, setAddingAttr] = useState(false);
  const [newAttrForm, setNewAttrForm] = useState<AttributeFormState>(EMPTY_ATTR);
  const [addError, setAddError] = useState<string | null>(null);
  const [backfillPending, setBackfillPending] = useState(false);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Sync when definition changes (user selected different definition)
  useEffect(() => {
    setName(definition.name);
    setDesc(definition.description);
    setCategory(definition.category ?? '');
    setSavedName(definition.name);
    setSavedDesc(definition.description);
    setSavedCategory(definition.category ?? '');
    setEditingAttrName(null);
    setAddingAttr(false);
    setError(null);
    setSuccessMsg(null);
  }, [definition.code, definition.category, definition.description, definition.name]);

  const handleSaveMeta = async () => {
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const resp = await fetch(`${API_URL}/api/schema/definitions/${definition.code}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc, category }),
      });
      const data = await resp.json();
      if (data.success) {
        setSavedName(name);
        setSavedDesc(desc);
        setSavedCategory(category);
        setSuccessMsg('Saved');
        onUpdated();
      } else {
        setError(data.error || 'Failed to save');
      }
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAttr = async (attrName: string) => {
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch(`${API_URL}/api/schema/definitions/${definition.code}/attributes/${attrName}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editAttrForm),
      });
      const data = await resp.json();
      if (data.success) {
        setEditingAttrName(null);
        onUpdated();
      } else {
        setError(data.error || 'Failed to save attribute');
      }
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAttr = async (attrName: string) => {
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch(`${API_URL}/api/schema/definitions/${definition.code}/attributes/${attrName}`, {
        method: 'DELETE',
      });
      const data = await resp.json();
      if (data.success) {
        setDeleteConfirm(null);
        onUpdated();
      } else {
        setError(data.error || 'Failed to delete attribute');
      }
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleAddAttr = async (backfill?: { type: 'none' | 'fixed_value'; value?: string }) => {
    setAddError(null);
    if (!newAttrForm.internalName.trim()) { setAddError('Internal name is required'); return; }
    setSaving(true);
    try {
      const resp = await fetch(`${API_URL}/api/schema/definitions/${definition.code}/attributes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newAttrForm, backfill }),
      });
      const data = await resp.json();
      if (data.success) {
        setAddingAttr(false);
        setNewAttrForm(EMPTY_ATTR);
        setBackfillPending(false);
        onUpdated();
      } else {
        setAddError(data.error || 'Failed to add attribute');
      }
    } catch {
      setAddError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleAddAttrClick = async () => {
    if (!newAttrForm.internalName.trim()) { setAddError('Internal name is required'); return; }
    if (newAttrForm.internalName.trim() === 'timing') { setAddError('"timing" is reserved for the TIM timing attribute.'); return; }
    // Check if there are existing entries — if formula mode, no backfill needed
    if (newAttrForm.mode === 'formula') {
      await handleAddAttr();
      return;
    }
    // Check if entries exist
    try {
      const resp = await fetch(
        `${API_URL}/api/entries/recent?definitionCode=${definition.code}&limit=1`
      );
      const data = await resp.json();
      const hasEntries = data.success && data.entries.length > 0;
      if (hasEntries) {
        setBackfillPending(true);
      } else {
        await handleAddAttr();
      }
    } catch {
      await handleAddAttr();
    }
  };

  const hasKey = definition.attributes.some((a) => a.isKey);
  const isDirty = name !== savedName || desc !== savedDesc || category !== savedCategory;

  return (
    <div className="def-panel def-panel-center">
      <div className="panel-title-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="panel-title">{definition.name}</span>
          <span className="def-code-badge">{definition.code}</span>
        </div>
        <button className="btn-raw-toggle" onClick={onToggleRaw}>&lt;/&gt; Raw</button>
      </div>

      {/* Basic info — locked for system definitions (e.g. TIM); attributes below
          remain editable for non-primitive ones. */}
      <div className="def-form-section">
        <div className="form-field">
          <label>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={definition.isSystem}
          />
        </div>
        <div className="form-field">
          <label>Description</label>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={2}
            disabled={definition.isSystem}
          />
        </div>
        <div className="form-field">
          <label>Category <span className="field-hint">(optional, hierarchical with /)</span></label>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. productive  or  productive/uni"
            disabled={definition.isSystem}
          />
        </div>
        {!definition.isSystem && (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              className={isDirty ? 'btn-save-dirty' : 'btn-save-clean'}
              onClick={handleSaveMeta}
              disabled={saving || !isDirty}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            {successMsg && !isDirty && <span className="form-success-inline">{successMsg}</span>}
          </div>
        )}
        {definition.isSystem && (
          <div className="field-hint">
            System definition — name, description and category are locked. You can still edit and add formula attributes below.
          </div>
        )}
      </div>

      {/* Attribute list */}
      <div className="def-form-section">
        <div className="def-attr-list-label">Attributes</div>

        {definition.attributes.map((attr) => {
          const isTiming = attr.internalName === 'timing' && attr.type === 'TIM';
          const locked = attr.isSystemAttr || isTiming;
          return (
          <div key={attr.internalName} className={`def-attr-row${editingAttrName === attr.internalName ? ' editing' : ''}`}>
            <div className="def-attr-row-header">
              <div className="def-attr-row-info">
                <span className="attr-row-name">{attr.internalName}</span>
                <span className="attr-row-type">{attr.type}</span>
                {attr.isKey && <span className="attr-chip-badge">@key</span>}
                {attr.optional && <span className="attr-chip-badge optional">opt</span>}
                {attr.mode === 'formula' && <span className="attr-chip-badge formula">= formula</span>}
                {attr.isSystemAttr && <span className="attr-chip-badge">system</span>}
              </div>
              {!locked && (
                <div className="def-attr-row-actions">
                  {editingAttrName === attr.internalName ? (
                    <>
                      <button className="btn-sm" onClick={() => handleSaveAttr(attr.internalName)} disabled={saving}>Save</button>
                      <button className="btn-sm btn-text" onClick={() => setEditingAttrName(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn-sm btn-text"
                        onClick={() => {
                          setEditingAttrName(attr.internalName);
                          setEditAttrForm({
                            displayName: attr.displayName,
                            description: attr.description,
                            optional: attr.optional,
                            formula: attr.formula,
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="btn-sm btn-text btn-danger-text"
                        onClick={() => setDeleteConfirm(attr.internalName)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Inline edit form */}
            {editingAttrName === attr.internalName && !locked && (
              <div className="def-attr-inline-edit">
                <div className="form-row-2">
                  <div className="form-field">
                    <label>Display Name</label>
                    <input
                      type="text"
                      value={editAttrForm.displayName ?? ''}
                      onChange={(e) => setEditAttrForm({ ...editAttrForm, displayName: e.target.value })}
                    />
                  </div>
                  <div className="form-field">
                    <label>Description</label>
                    <input
                      type="text"
                      value={editAttrForm.description ?? ''}
                      onChange={(e) => setEditAttrForm({ ...editAttrForm, description: e.target.value })}
                    />
                  </div>
                </div>
                {!attr.isKey && (
                  <label className="form-field form-field-checkbox">
                    <input
                      type="checkbox"
                      checked={editAttrForm.optional ?? attr.optional}
                      onChange={(e) => setEditAttrForm({ ...editAttrForm, optional: e.target.checked })}
                    />
                    {' '}Optional
                  </label>
                )}
                {attr.mode === 'formula' && (
                  <div className="form-field">
                    <label>Formula</label>
                    <input
                      type="text"
                      value={editAttrForm.formula ?? ''}
                      onChange={(e) => setEditAttrForm({ ...editAttrForm, formula: e.target.value })}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
          );
        })}

        {definition.attributes.length === 0 && (
          <div className="def-empty-attrs">No attributes yet.</div>
        )}
      </div>

      {/* Add attribute section — allowed even on system definitions, since users
          can add formula attributes to TIM. The backend rejects reserved names. */}
      {(
        <div className="def-form-section">
          {addingAttr ? (
            <>
              <div className="def-attr-list-label">New attribute</div>
              <AttributeForm
                value={newAttrForm}
                onChange={setNewAttrForm}
                existingDefinitions={definitions}
                isCreatingDefinition={false}
                hasKeyAlready={hasKey}
              />
              {addError && <div className="form-error" style={{ marginTop: '0.5rem' }}>{addError}</div>}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button onClick={handleAddAttrClick} disabled={saving}>Add</button>
                <button className="btn-text" onClick={() => { setAddingAttr(false); setNewAttrForm(EMPTY_ATTR); setAddError(null); }}>Cancel</button>
              </div>
            </>
          ) : (
            <button className="btn-outline" onClick={() => setAddingAttr(true)}>+ Add Attribute</button>
          )}
        </div>
      )}

      {error && <div className="form-error">{error}</div>}

      {/* Dialogs */}
      {backfillPending && (
        <BackfillDialog
          attr={newAttrForm}
          onConfirm={(backfill) => handleAddAttr(backfill)}
          onCancel={() => setBackfillPending(false)}
        />
      )}
      {deleteConfirm && (
        <DeleteConfirmDialog
          attrName={deleteConfirm}
          onConfirm={() => handleDeleteAttr(deleteConfirm)}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}

// ─── Main DefinitionsEditor ───────────────────────────────────────────────────

type EditorMode = 'idle' | 'create' | 'edit';

const EMPTY_CREATE_FORM: CreateForm = { name: '', code: '', description: '', category: '', attributes: [] };

export function DefinitionsEditor() {
  const [definitions, setDefinitions] = useState<DefinitionModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>('idle');
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [rawDrawerOpen, setRawDrawerOpen] = useState(false);

  const loadDefinitions = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const resp = await fetch(`${API_URL}/api/schema/definitions`);
      const data = await resp.json();
      if (data.success) {
        setDefinitions(data.definitions);
      } else {
        setLoadError(data.error || 'Failed to load definitions');
      }
    } catch {
      setLoadError('Network error — is the server running?');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDefinitions();
  }, [loadDefinitions]);

  const selectedDefinition = definitions.find((d) => d.code === selectedCode) ?? null;

  const handleSelectDefinition = (code: string) => {
    setSelectedCode(code);
    setMode('edit');
  };

  const handleNewDefinition = () => {
    setSelectedCode(null);
    setCreateForm(EMPTY_CREATE_FORM);
    setMode('create');
  };

  const handleCreated = async () => {
    await loadDefinitions();
    setMode('idle');
    setSelectedCode(null);
  };

  const handleUpdated = async () => {
    await loadDefinitions();
  };

  const previewDefinition: DefinitionModel | CreateForm | null =
    mode === 'create' ? createForm : selectedDefinition;

  return (
    <div className="definitions-editor">
      {/* Left panel: list */}
      <div className="def-panel def-panel-left">
        <div className="panel-title-row">
          <span className="panel-title">Definitions</span>
        </div>

        {loading && <div className="def-loading">Loading...</div>}
        {loadError && <div className="form-error">{loadError}</div>}

        <div className="def-list">
          {definitions.map((def) => (
            <button
              key={def.code}
              className={`def-list-item${def.isSystem ? ' def-list-item-system' : ''}${selectedCode === def.code && mode === 'edit' ? ' active' : ''}`}
              onClick={() => handleSelectDefinition(def.code)}
              title={def.isSystem ? 'System definition — metadata is locked, but you can edit/add formula attributes.' : undefined}
            >
              <span className="def-list-code">{def.code}</span>
              <span className="def-list-name">{def.name}</span>
              {def.isSystem && <span className="def-list-system-badge">system</span>}
            </button>
          ))}
        </div>

        <button
          className="def-new-btn"
          onClick={handleNewDefinition}
        >
          + New Definition
        </button>
      </div>

      {/* Center panel: editor */}
      {mode === 'idle' && (
        <div className="def-panel def-panel-center def-panel-idle">
          <p>Select a definition to edit, or create a new one.</p>
        </div>
      )}

      {mode === 'create' && (
        <CreateDefinitionForm
          definitions={definitions}
          onCreated={handleCreated}
          onCancel={() => setMode('idle')}
          formState={createForm}
          onFormChange={setCreateForm}
          onToggleRaw={() => setRawDrawerOpen((o) => !o)}
        />
      )}

      {mode === 'edit' && selectedDefinition && (
        <EditDefinitionForm
          key={selectedDefinition.code}
          definition={selectedDefinition}
          definitions={definitions}
          onUpdated={handleUpdated}
          onToggleRaw={() => setRawDrawerOpen((o) => !o)}
        />
      )}

      {/* Raw drawer overlay */}
      {rawDrawerOpen && (
        <RawDrawer
          definition={previewDefinition}
          onClose={() => setRawDrawerOpen(false)}
        />
      )}
    </div>
  );
}
