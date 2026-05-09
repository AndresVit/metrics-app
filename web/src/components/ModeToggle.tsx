/**
 * ModeToggle — Simple / Advanced mode toggle for Data Entry.
 *
 * Renders a segmented control in the top bar area.
 * The mode state is lifted to the parent (App) so it can be shared
 * between TemporalBar and DataEntryView.
 */

export type EntryMode = 'simple' | 'advanced';

interface ModeToggleProps {
  mode: EntryMode;
  onChange: (mode: EntryMode) => void;
}

export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="segmented-control mode-toggle">
      <button
        className={mode === 'simple' ? 'active' : ''}
        onClick={() => onChange('simple')}
      >
        Simple
      </button>
      <button
        className={mode === 'advanced' ? 'active' : ''}
        onClick={() => onChange('advanced')}
      >
        Advanced
      </button>
    </div>
  );
}
