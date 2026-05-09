/**
 * SearchKeyTypeahead — Searchable dropdown for metric-reference fields.
 *
 * Fetches existing search_key_value entries from the API and shows
 * them in a dropdown. Users can also type free-form values.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { focusNextField } from './MetricTypeahead';

const API_URL = 'http://localhost:3001';

interface SearchKeyTypeaheadProps {
  metricCode: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function SearchKeyTypeahead({ metricCode, value, onChange, disabled }: SearchKeyTypeaheadProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const fetchSearchKeys = useCallback(async (q: string) => {
    try {
      const params = new URLSearchParams({ definitionCode: metricCode });
      if (q.trim()) params.set('q', q.trim());
      const resp = await fetch(`${API_URL}/api/entries/search-keys?${params}`);
      const data = await resp.json();
      if (data.success) {
        setResults(data.searchKeys);
      }
    } catch {
      // Silently fail
    }
  }, [metricCode]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);

    if (!isOpen) setIsOpen(true);

    // Debounce API call
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchSearchKeys(newValue);
    }, 200);
  };

  const handleFocus = () => {
    setIsOpen(true);
    fetchSearchKeys(value);
  };

  const handleSelect = (searchKey: string) => {
    onChange(searchKey);
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && isOpen && results.length > 0) {
      e.preventDefault();
      handleSelect(results[0]);
      focusNextField(containerRef.current);
    }
  };

  return (
    <div className="metric-typeahead" ref={containerRef}>
      <input
        type="text"
        className="metric-typeahead-input"
        value={value}
        onChange={handleInputChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={`Search ${metricCode} entries...`}
        disabled={disabled}
      />
      {isOpen && results.length > 0 && (
        <ul className="metric-typeahead-dropdown">
          {results.slice(0, 8).map(key => (
            <li
              key={key}
              className={`metric-typeahead-option ${key === value ? 'selected' : ''}`}
              onMouseDown={() => handleSelect(key)}
            >
              <span className="search-key-option-value">{key}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
