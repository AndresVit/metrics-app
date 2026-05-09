/**
 * MetricTypeahead — Searchable dropdown for selecting a MetricDefinition.
 *
 * Filters by code or displayName. Shows max 8 results while typing.
 */

import { useState, useRef, useEffect } from 'react';

/**
 * Find the next form input (input/select/textarea, not buttons) in DOM order
 * after the given container and focus it. Deferred to next tick so React
 * has time to render newly-visible fields (e.g. subdivision after metric select).
 */
export function focusNextField(container: HTMLElement | null): void {
  if (!container) return;
  requestAnimationFrame(() => {
    const form = container.closest('.simple-entry-form') || document;
    const inputs = Array.from(
      form.querySelectorAll<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])'
      )
    );
    // Find the last input inside the container
    const containerInputs = inputs.filter(el => container.contains(el));
    if (containerInputs.length === 0) return;
    const lastInContainer = containerInputs[containerInputs.length - 1];
    const idx = inputs.indexOf(lastInContainer);
    if (idx >= 0 && idx + 1 < inputs.length) {
      inputs[idx + 1].focus();
    }
  });
}

export interface MetricOption {
  code: string;
  displayName: string;
}

interface MetricTypeaheadProps {
  options: MetricOption[];
  value: string; // selected metric code
  onChange: (code: string) => void;
  disabled?: boolean;
}

export function MetricTypeahead({ options, value, onChange, disabled }: MetricTypeaheadProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedOption = options.find(o => o.code === value);

  const filtered = query.trim()
    ? options.filter(o => {
        const q = query.toLowerCase();
        return o.code.toLowerCase().includes(q) || o.displayName.toLowerCase().includes(q);
      }).slice(0, 8)
    : options.slice(0, 8);

  const handleSelect = (code: string) => {
    onChange(code);
    setQuery('');
    setIsOpen(false);
  };

  const handleInputFocus = () => {
    setIsOpen(true);
    setQuery('');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    if (!isOpen) setIsOpen(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && isOpen && filtered.length > 0) {
      e.preventDefault();
      handleSelect(filtered[0].code);
      // Focus next focusable element after this container
      focusNextField(containerRef.current);
    }
  };

  return (
    <div className="metric-typeahead" ref={containerRef}>
      <input
        type="text"
        className="metric-typeahead-input"
        value={isOpen ? query : (selectedOption ? `${selectedOption.code} — ${selectedOption.displayName}` : '')}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onKeyDown={handleKeyDown}
        placeholder="Search metric by code or name..."
        disabled={disabled}
      />
      {isOpen && filtered.length > 0 && (
        <ul className="metric-typeahead-dropdown">
          {filtered.map(o => (
            <li
              key={o.code}
              className={`metric-typeahead-option ${o.code === value ? 'selected' : ''}`}
              onMouseDown={() => handleSelect(o.code)}
            >
              <span className="metric-option-code">{o.code}</span>
              <span className="metric-option-name">{o.displayName}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
