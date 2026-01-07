/**
 * Widget API Server
 *
 * Minimal HTTP API for running widgets.
 * Run with: npx tsx server/api.ts
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { runWidget, loadWidgets } from '../src/widget';
import { DEV_CONFIG } from '../dev/config';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Use fixed userId from config (no auth for MVP)
const USER_ID = process.env.USER_ID || DEV_CONFIG.USER_ID;

/**
 * POST /api/run-widget
 *
 * Input: { widgetSource: string }
 * Output: { success: true, name: string, result: Record<string, number> }
 *      or { success: false, error: string }
 */
app.post('/api/run-widget', async (req: Request, res: Response) => {
  try {
    const { widgetSource } = req.body;

    if (!widgetSource || typeof widgetSource !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing or invalid widgetSource',
      });
      return;
    }

    console.log('[API] Running widget for userId:', USER_ID);
    const result = await runWidget(widgetSource, { userId: USER_ID });
    console.log('[API] Widget result:', JSON.stringify(result, null, 2));

    if (result.success) {
      res.json({
        success: true,
        name: result.name,
        result: result.result,
      });
    } else {
      res.json({
        success: false,
        error: result.error,
      });
    }
  } catch (err) {
    console.error('Widget API error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/health
 *
 * Health check endpoint
 */
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', userId: USER_ID });
});

/**
 * GET /api/widgets
 *
 * List all stored widgets for the user
 */
app.get('/api/widgets', async (_req: Request, res: Response) => {
  try {
    const widgets = await loadWidgets(USER_ID);
    res.json({
      success: true,
      widgets: widgets.map((w) => ({
        id: w.id,
        name: w.name,
        createdAt: w.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('Widget list error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
});

// Map frontend bigPeriod to internal Period type
type BigPeriod = 'day' | 'week' | 'month' | 'year';
type Period = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

function mapBigPeriodToInternal(bigPeriod: string): Period {
  const mapping: Record<BigPeriod, Period> = {
    day: 'DAY',
    week: 'WEEK',
    month: 'MONTH',
    year: 'YEAR',
  };
  return mapping[bigPeriod as BigPeriod] || 'DAY';
}

/**
 * GET /api/dashboard
 *
 * Loads all widgets for the user from Supabase and executes each one.
 * Returns results for all widgets; individual failures don't break the response.
 *
 * Query params:
 * - anchorDate: ISO date string for temporal filtering (optional, defaults to today)
 * - period: bigPeriod from temporal context (day/week/month/year, defaults to day)
 */
app.get('/api/dashboard', async (req: Request, res: Response) => {
  console.log('[API] GET /api/dashboard hit');

  // Parse anchorDate from query params
  const anchorDateParam = req.query.anchorDate as string | undefined;
  const anchorDate = anchorDateParam ? new Date(anchorDateParam) : new Date();

  // Parse period (bigPeriod) from query params
  const periodParam = req.query.period as string | undefined;
  const period = mapBigPeriodToInternal(periodParam || 'day');

  // Validate date
  if (isNaN(anchorDate.getTime())) {
    res.status(400).json({
      success: false,
      error: `Invalid anchorDate: ${anchorDateParam}`,
    });
    return;
  }

  console.log(`[API] anchorDate=${anchorDate.toISOString().split('T')[0]}, period=${period}`);

  try {
    // Load all widgets for the user from Supabase
    const storedWidgets = await loadWidgets(USER_ID);
    console.log(`[API] Loaded ${storedWidgets.length} widgets for user ${USER_ID}`);

    // Execute each widget and collect results
    const widgetResults = await Promise.all(
      storedWidgets.map(async (widget) => {
        try {
          const result = await runWidget(widget.dsl, { userId: USER_ID, anchorDate, period });

          if (result.success) {
            return {
              id: widget.id,
              name: result.name,
              result: result.result,
              error: null,
            };
          } else {
            console.log(`[API] Widget "${widget.name}" (${widget.id}) failed: ${result.error}`);
            return {
              id: widget.id,
              name: widget.name,
              result: null,
              error: result.error,
            };
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          console.log(`[API] Widget "${widget.name}" (${widget.id}) threw: ${errorMessage}`);
          return {
            id: widget.id,
            name: widget.name,
            result: null,
            error: errorMessage,
          };
        }
      })
    );

    res.json({
      success: true,
      widgets: widgetResults,
    });
  } catch (err) {
    console.error('[API] Dashboard error:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to load dashboard',
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Widget API server running on http://localhost:${PORT}`);
  console.log(`Using userId: ${USER_ID}`);
  console.log('\nEndpoints:');
  console.log(`  POST /api/run-widget - Run a widget from DSL`);
  console.log(`  GET  /api/widgets    - List stored widgets`);
  console.log(`  GET  /api/dashboard  - Execute all widgets`);
  console.log(`  GET  /api/health     - Health check`);
});
