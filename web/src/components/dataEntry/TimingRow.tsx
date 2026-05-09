/**
 * TimingRow — Input fields for timing data: start/end time + one numeric input
 * per user-configured time-tag letter (1–6 letters from settings).
 */

export interface TimingState {
  startTime: string;
  endTime: string;
  /** Per-letter minute values, keyed by single a-z. Empty string = unset. */
  letters: Record<string, string>;
}

interface TimingRowProps {
  timing: TimingState;
  onChange: (timing: TimingState) => void;
  /** Letters to render as numeric inputs, in display order. */
  letterOrder: string[];
  disabled?: boolean;
}

export function TimingRow({ timing, onChange, letterOrder, disabled }: TimingRowProps) {
  const setTime = (field: 'startTime' | 'endTime', value: string) => {
    onChange({ ...timing, [field]: value });
  };

  const setLetter = (letter: string, value: string) => {
    onChange({ ...timing, letters: { ...timing.letters, [letter]: value } });
  };

  return (
    <div className="timing-row">
      <div className="timing-time-inputs">
        <div className="timing-field">
          <label className="timing-label">Start</label>
          <input
            type="time"
            className="timing-time-input"
            value={timing.startTime}
            onChange={e => setTime('startTime', e.target.value)}
            disabled={disabled}
          />
        </div>
        <span className="timing-separator">—</span>
        <div className="timing-field">
          <label className="timing-label">End</label>
          <input
            type="time"
            className="timing-time-input"
            value={timing.endTime}
            onChange={e => setTime('endTime', e.target.value)}
            disabled={disabled}
          />
        </div>
      </div>
      <div className="timing-token-inputs">
        {letterOrder.map(letter => (
          <div key={letter} className="timing-token-field">
            <label className="timing-label">{letter}</label>
            <input
              type="number"
              className="timing-token-input"
              value={timing.letters[letter] ?? ''}
              onChange={e => setLetter(letter, e.target.value)}
              placeholder="0"
              min="0"
              disabled={disabled}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
