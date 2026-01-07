import { useState, useEffect, createContext, useContext, type ReactNode } from 'react';
import './App.css';

const API_URL = 'http://localhost:3001';

// ============================================
// Temporal Context
// ============================================

type BigPeriod = 'day' | 'week' | 'month' | 'year';
type SmallPeriod = 'hour' | 'day' | 'week' | 'month';

interface TemporalContextState {
  bigPeriod: BigPeriod;
  smallPeriod: SmallPeriod;
  anchorDate: Date;
}

interface TemporalContextValue extends TemporalContextState {
  setBigPeriod: (period: BigPeriod) => void;
  setSmallPeriod: (period: SmallPeriod) => void;
  setAnchorDate: (date: Date) => void;
  navigateBack: () => void;
  navigateForward: () => void;
}

const TemporalContext = createContext<TemporalContextValue | null>(null);

function TemporalContextProvider({ children }: { children: ReactNode }) {
  const [bigPeriod, setBigPeriod] = useState<BigPeriod>('day');
  const [smallPeriod, setSmallPeriod] = useState<SmallPeriod>('hour');
  const [anchorDate, setAnchorDate] = useState<Date>(() => new Date());

  const navigateBack = () => {
    setAnchorDate((prev) => {
      const next = new Date(prev);
      switch (bigPeriod) {
        case 'day':
          next.setDate(next.getDate() - 1);
          break;
        case 'week':
          next.setDate(next.getDate() - 7);
          break;
        case 'month':
          next.setMonth(next.getMonth() - 1);
          break;
        case 'year':
          next.setFullYear(next.getFullYear() - 1);
          break;
      }
      return next;
    });
  };

  const navigateForward = () => {
    setAnchorDate((prev) => {
      const next = new Date(prev);
      switch (bigPeriod) {
        case 'day':
          next.setDate(next.getDate() + 1);
          break;
        case 'week':
          next.setDate(next.getDate() + 7);
          break;
        case 'month':
          next.setMonth(next.getMonth() + 1);
          break;
        case 'year':
          next.setFullYear(next.getFullYear() + 1);
          break;
      }
      return next;
    });
  };

  return (
    <TemporalContext.Provider
      value={{
        bigPeriod,
        smallPeriod,
        anchorDate,
        setBigPeriod,
        setSmallPeriod,
        setAnchorDate,
        navigateBack,
        navigateForward,
      }}
    >
      {children}
    </TemporalContext.Provider>
  );
}

function useTemporalContext(): TemporalContextValue {
  const context = useContext(TemporalContext);
  if (!context) {
    throw new Error('useTemporalContext must be used within a TemporalContextProvider');
  }
  return context;
}

// ============================================
// Temporal Bar Component
// ============================================

const BIG_PERIODS: { value: BigPeriod; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

const SMALL_PERIODS: { value: SmallPeriod; label: string }[] = [
  { value: 'hour', label: 'Hour' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

function formatAnchorDate(date: Date, bigPeriod: BigPeriod): string {
  const options: Intl.DateTimeFormatOptions = {};

  switch (bigPeriod) {
    case 'day':
      options.weekday = 'short';
      options.month = 'short';
      options.day = 'numeric';
      options.year = 'numeric';
      break;
    case 'week':
      options.month = 'short';
      options.day = 'numeric';
      options.year = 'numeric';
      break;
    case 'month':
      options.month = 'long';
      options.year = 'numeric';
      break;
    case 'year':
      options.year = 'numeric';
      break;
  }

  return date.toLocaleDateString('en-US', options);
}

function TemporalBar() {
  const {
    bigPeriod,
    smallPeriod,
    anchorDate,
    setBigPeriod,
    setSmallPeriod,
    setAnchorDate,
    navigateBack,
    navigateForward,
  } = useTemporalContext();

  const [showDatePicker, setShowDatePicker] = useState(false);

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newDate = new Date(e.target.value + 'T12:00:00');
    if (!isNaN(newDate.getTime())) {
      setAnchorDate(newDate);
      setShowDatePicker(false);
    }
  };

  const formatDateForInput = (date: Date): string => {
    return date.toISOString().split('T')[0];
  };

  return (
    <div className="temporal-bar">
      <div className="temporal-bar-section">
        <span className="temporal-bar-label">Range:</span>
        <div className="segmented-control">
          {BIG_PERIODS.map((period) => (
            <button
              key={period.value}
              className={bigPeriod === period.value ? 'active' : ''}
              onClick={() => setBigPeriod(period.value)}
            >
              {period.label}
            </button>
          ))}
        </div>
      </div>

      <div className="temporal-bar-section">
        <span className="temporal-bar-label">Group by:</span>
        <select
          value={smallPeriod}
          onChange={(e) => setSmallPeriod(e.target.value as SmallPeriod)}
          className="temporal-select"
        >
          {SMALL_PERIODS.map((period) => (
            <option key={period.value} value={period.value}>
              {period.label}
            </option>
          ))}
        </select>
      </div>

      <div className="temporal-bar-section temporal-navigation">
        <button
          className="nav-btn"
          onClick={navigateBack}
          title={`Previous ${bigPeriod}`}
        >
          ←
        </button>

        <div className="anchor-date-container">
          <button
            className="anchor-date-btn"
            onClick={() => setShowDatePicker(!showDatePicker)}
          >
            {formatAnchorDate(anchorDate, bigPeriod)}
          </button>
          {showDatePicker && (
            <input
              type="date"
              className="date-picker-input"
              value={formatDateForInput(anchorDate)}
              onChange={handleDateChange}
              onBlur={() => setShowDatePicker(false)}
              autoFocus
            />
          )}
        </div>

        <button
          className="nav-btn"
          onClick={navigateForward}
          title={`Next ${bigPeriod}`}
        >
          →
        </button>
      </div>

      {/* Filters stub - for future implementation */}
      <div className="temporal-bar-section temporal-filters-stub">
        <span className="temporal-bar-label filters-placeholder">Filters</span>
      </div>
    </div>
  );
}

const EXAMPLE_WIDGET = `WIDGET "Daily Productivity"

tims = TIM FROM TODAY

"productive_time": int = sum(tims.time("t"))
"meeting_time": int = sum(tims.time("m"))
"total_duration": int = sum(tims.duration)
"productivity": float = sum(tims.time("t")) / sum(tims.duration)
END`;

type Tab = 'dashboard' | 'runner';

interface WidgetResult {
  success: boolean;
  name?: string;
  result?: Record<string, number>;
  error?: string;
}

interface DashboardWidget {
  id: string;
  name: string;
  result: Record<string, number> | null;
  error: string | null;
}

interface DashboardResponse {
  success: boolean;
  widgets?: DashboardWidget[];
  error?: string;
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');

  return (
    <TemporalContextProvider>
      <div className="app">
        <header className="app-header">
          <h1>Metrics Dashboard</h1>
          <nav className="tabs">
            <button
              className={activeTab === 'dashboard' ? 'active' : ''}
              onClick={() => setActiveTab('dashboard')}
            >
              Dashboard
            </button>
            <button
              className={activeTab === 'runner' ? 'active' : ''}
              onClick={() => setActiveTab('runner')}
            >
              Widget Runner
            </button>
          </nav>
        </header>

        <TemporalBar />

        {activeTab === 'dashboard' ? <Dashboard /> : <WidgetRunner />}
      </div>
    </TemporalContextProvider>
  );
}

// Map bigPeriod to backend period parameter
function mapBigPeriodToBackend(bigPeriod: BigPeriod, anchorDate: Date): string {
  // For now, only 'day' is fully implemented as TODAY
  // Other periods are stubbed but structure is correct
  const today = new Date();
  const isToday =
    anchorDate.getFullYear() === today.getFullYear() &&
    anchorDate.getMonth() === today.getMonth() &&
    anchorDate.getDate() === today.getDate();

  switch (bigPeriod) {
    case 'day':
      return isToday ? 'TODAY' : formatDateParam(anchorDate);
    case 'week':
      return 'WEEK'; // Stubbed
    case 'month':
      return 'MONTH'; // Stubbed
    case 'year':
      return 'YEAR'; // Stubbed
    default:
      return 'TODAY';
  }
}

function formatDateParam(date: Date): string {
  return date.toISOString().split('T')[0];
}

function Dashboard() {
  const { bigPeriod, smallPeriod, anchorDate } = useTemporalContext();
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = async () => {
    setLoading(true);
    setError(null);

    try {
      const period = mapBigPeriodToBackend(bigPeriod, anchorDate);
      const params = new URLSearchParams({
        period,
        groupBy: smallPeriod,
        anchorDate: formatDateParam(anchorDate),
      });

      const response = await fetch(`${API_URL}/api/dashboard?${params}`);
      const data: DashboardResponse = await response.json();

      if (data.success && data.widgets) {
        setWidgets(data.widgets);
      } else {
        setError(data.error || 'Failed to load dashboard');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  // Reload dashboard when temporal context changes
  useEffect(() => {
    loadDashboard();
  }, [bigPeriod, smallPeriod, anchorDate]);

  if (loading) {
    return <div className="dashboard-loading">Loading widgets...</div>;
  }

  if (error) {
    return (
      <div className="dashboard-error">
        <h2>Error</h2>
        <p>{error}</p>
        <button onClick={loadDashboard}>Retry</button>
      </div>
    );
  }

  if (widgets.length === 0) {
    return (
      <div className="dashboard-empty">
        <h2>No Widgets</h2>
        <p>No widgets found. Seed widgets using:</p>
        <pre>npx tsx dev/seedWidgets.ts</pre>
        <button onClick={loadDashboard}>Refresh</button>
      </div>
    );
  }

  const getHeaderTitle = () => {
    const dateStr = formatAnchorDate(anchorDate, bigPeriod);
    switch (bigPeriod) {
      case 'day':
        return `Metrics for ${dateStr}`;
      case 'week':
        return `Week of ${dateStr}`;
      case 'month':
        return `${dateStr} Metrics`;
      case 'year':
        return `${dateStr} Metrics`;
      default:
        return 'Metrics';
    }
  };

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>{getHeaderTitle()}</h2>
        <button onClick={loadDashboard} className="refresh-btn">
          Refresh
        </button>
      </div>

      <div className="widget-grid">
        {widgets.map((widget) => (
          <div key={widget.id} className="widget-card">
            <h3>{widget.name}</h3>
            {widget.error ? (
              <div className="widget-error">
                <p>{widget.error}</p>
              </div>
            ) : (
              <table className="widget-table">
                <tbody>
                  {Object.entries(widget.result || {}).map(([key, value]) => (
                    <tr key={key}>
                      <td className="label">{key}</td>
                      <td className="value">
                        {typeof value === 'number' && !Number.isInteger(value)
                          ? value.toFixed(4)
                          : value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function WidgetRunner() {
  const [widgetSource, setWidgetSource] = useState(EXAMPLE_WIDGET);
  const [result, setResult] = useState<WidgetResult | null>(null);
  const [loading, setLoading] = useState(false);

  const runWidget = async () => {
    setLoading(true);
    setResult(null);

    try {
      const response = await fetch(`${API_URL}/api/run-widget`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ widgetSource }),
      });

      const data = await response.json();
      setResult(data);
    } catch (err) {
      setResult({
        success: false,
        error: err instanceof Error ? err.message : 'Network error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="runner">
      <div className="editor-section">
        <label htmlFor="widget-source">Widget DSL:</label>
        <textarea
          id="widget-source"
          value={widgetSource}
          onChange={(e) => setWidgetSource(e.target.value)}
          rows={15}
          placeholder="Paste your widget DSL here..."
        />
      </div>

      <div className="button-section">
        <button onClick={runWidget} disabled={loading || !widgetSource.trim()}>
          {loading ? 'Running...' : 'Run Widget'}
        </button>
      </div>

      {result && (
        <div className="result-section">
          {result.success ? (
            <>
              <h2>{result.name}</h2>
              <table className="result-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(result.result || {}).map(([key, value]) => (
                    <tr key={key}>
                      <td>{key}</td>
                      <td className="value">
                        {typeof value === 'number' && !Number.isInteger(value)
                          ? value.toFixed(4)
                          : value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="error">
              <h2>Error</h2>
              <pre>{result.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
