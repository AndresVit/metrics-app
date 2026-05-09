import { useState, useRef, useEffect } from 'react';

export interface AutocompleteOption {
  value: string;
  label: string;
}

interface AutocompleteSelectProps {
  options: AutocompleteOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * On Tab from inside `container`, focus the next focusable input/select/textarea
 * in DOM order. Used by autocompletes to keep keyboard flow moving forward.
 */
function focusNextField(container: HTMLElement | null): void {
  if (!container) return;
  requestAnimationFrame(() => {
    const all = Array.from(
      document.querySelectorAll<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])'
      )
    );
    const insideContainer = all.filter((el) => container.contains(el));
    if (insideContainer.length === 0) return;
    const last = insideContainer[insideContainer.length - 1];
    const idx = all.indexOf(last);
    if (idx >= 0 && idx + 1 < all.length) all[idx + 1].focus();
  });
}

export function AutocompleteSelect({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  disabled,
}: AutocompleteSelectProps) {
  const selected = options.find((o) => o.value === value);
  const [inputValue, setInputValue] = useState(selected?.label ?? value);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep input in sync when value changes externally
  useEffect(() => {
    const opt = options.find((o) => o.value === value);
    setInputValue(opt?.label ?? value);
  }, [value, options]);

  // Close when clicking outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        // Restore display to selected value
        const opt = options.find((o) => o.value === value);
        setInputValue(opt?.label ?? value);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [value, options]);

  const filtered = options.filter(
    (o) =>
      o.label.toLowerCase().includes(inputValue.toLowerCase()) ||
      o.value.toLowerCase().includes(inputValue.toLowerCase())
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setOpen(true);
  };

  const handleSelect = (opt: AutocompleteOption) => {
    onChange(opt.value);
    setInputValue(opt.label);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && open && filtered.length > 0) {
      e.preventDefault();
      handleSelect(filtered[0]);
      focusNextField(containerRef.current);
    }
  };

  return (
    <div className="autocomplete-select" ref={containerRef}>
      <input
        type="text"
        className="autocomplete-input"
        value={inputValue}
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
      />
      {open && filtered.length > 0 && (
        <div className="autocomplete-dropdown">
          {filtered.map((opt) => (
            <div
              key={opt.value}
              className={`autocomplete-option${opt.value === value ? ' selected' : ''}`}
              onMouseDown={() => handleSelect(opt)}
            >
              <span className="autocomplete-option-code">{opt.value}</span>
              {opt.label !== opt.value && (
                <span className="autocomplete-option-label"> – {opt.label}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
