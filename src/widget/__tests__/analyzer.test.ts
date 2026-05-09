import { describe, it, expect } from 'vitest';
import { analyzeWidget } from '../analyzer';
import { parseWidgetDef } from '../parser';
import type { ExecutionPlan } from '../analyzer';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function plan(src: string): ExecutionPlan {
  const pr = parseWidgetDef(src);
  if (!pr.ok) throw new Error(`Parse failed: ${pr.error}`);
  const ar = analyzeWidget(pr.widget);
  if (!ar.ok) throw new Error(`Analysis failed: ${ar.errors.join('; ')}`);
  return ar.plan;
}

function errors(src: string): string[] {
  const pr = parseWidgetDef(src);
  if (!pr.ok) throw new Error(`Parse failed: ${pr.error}`);
  const ar = analyzeWidget(pr.widget);
  if (ar.ok) throw new Error('Expected analysis failure but it succeeded');
  return ar.errors;
}

// ─────────────────────────────────────────────────────────────
// Basic plan fields
// ─────────────────────────────────────────────────────────────

describe('analyzer — basic plan', () => {
  it('sets source alias and code', () => {
    const p = plan(`widget "w" {
      data { source: TIM as tims  measure v = count() }
      plot { type: kpi  value: v }
    }`);
    expect(p.sourceAlias).toBe('tims');
    expect(p.sourceCode).toBe('TIM');
  });

  it('zero parent depth when no .parent used', () => {
    const p = plan(`widget "w" {
      data { source: TIM as tims  measure v = count() }
      plot { type: kpi  value: v }
    }`);
    expect(p.parentDepthRequired).toBe(0);
  });

  it('depth 1 when .parent used in WHERE', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        where: tims.parent.code in ["EST"]
        measure v = count()
      }
      plot { type: kpi  value: v }
    }`);
    expect(p.parentDepthRequired).toBe(1);
  });

  it('depth 1 when .parent used in group dimension', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        group { proj: tims.parent.project }
        measure v = count()
      }
      plot { type: donut  category: proj  value: v }
    }`);
    expect(p.parentDepthRequired).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// requiresTimeData and requiresParentCode
// ─────────────────────────────────────────────────────────────

describe('analyzer — requiresTimeData', () => {
  it('false when no time() used', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        measure dur = sum(tims.duration)
      }
      plot { type: kpi  value: dur }
    }`);
    expect(p.requiresTimeData).toBe(false);
  });

  it('true when time() used in measure', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        measure t = sum(tims.time("t"))
      }
      plot { type: kpi  value: t }
    }`);
    expect(p.requiresTimeData).toBe(true);
  });

  it('true when timeUnder() used', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        measure m = sum(tims.timeUnder("m"))
      }
      plot { type: kpi  value: m }
    }`);
    expect(p.requiresTimeData).toBe(true);
  });

  it('needsTimPart false for exact time()', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        measure t = sum(tims.time("t"))
      }
      plot { type: kpi  value: t }
    }`);
    expect(p.needsTimPart).toBe(false);
  });

  it('needsTimPart true for timeUnder()', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        measure m = sum(tims.timeUnder("m"))
      }
      plot { type: kpi  value: m }
    }`);
    expect(p.needsTimPart).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// time() inside arithmetic in aggregate args — must be rejected
// ─────────────────────────────────────────────────────────────

describe('analyzer — time() inside arithmetic rejection', () => {
  it('rejects sum(time("a") + time("b"))', () => {
    const errs = errors(`widget "w" {
      data {
        source: TIM as tims
        measure tm = sum(tims.time("t") + tims.time("m"))
      }
      plot { type: kpi  value: tm }
    }`);
    expect(errs.some(e => e.includes('time()'))).toBe(true);
  });

  it('rejects sum(time("a") - time("b"))', () => {
    const errs = errors(`widget "w" {
      data {
        source: TIM as tims
        measure diff = sum(tims.time("t") - tims.time("m"))
      }
      plot { type: kpi  value: diff }
    }`);
    expect(errs.some(e => e.includes('time()'))).toBe(true);
  });

  it('accepts sum(time("a")) + sum(time("b"))', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        measure total = sum(tims.time("t"))
        measure tm    = sum(tims.time("t")) + sum(tims.time("m"))
      }
      plot { type: kpi  value: tm }
    }`);
    expect(p.requiresTimeData).toBe(true);
  });

  it('accepts sum(time("a")) alone', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        measure t = sum(tims.time("t"))
      }
      plot { type: kpi  value: t }
    }`);
    expect(p.requiresTimeData).toBe(true);
  });
});

describe('analyzer — requiresParentCode', () => {
  it('false when no .parent.code', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        group { proj: tims.parent.project }
        measure v = count()
      }
      plot { type: donut  category: proj  value: v }
    }`);
    expect(p.requiresParentCode).toBe(false);
  });

  it('true when .parent.code in WHERE', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        where: tims.parent.code in ["EST"]
        measure v = count()
      }
      plot { type: kpi  value: v }
    }`);
    expect(p.requiresParentCode).toBe(true);
  });

  it('code excluded from requiredFields parent set', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        where: tims.parent.code in ["EST"]
        measure v = count()
      }
      plot { type: kpi  value: v }
    }`);
    const parentFields = p.requiredFields.get('parent');
    // 'parent' key may not exist at all when 'code' was the only parent reference
    expect(parentFields?.has('code') ?? false).toBe(false);
  });

  it('real attr fields still in requiredFields', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        group { proj: tims.parent.project }
        measure v = count()
      }
      plot { type: donut  category: proj  value: v }
    }`);
    expect(p.requiredFields.get('parent')?.has('project')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Measure dependency resolution
// ─────────────────────────────────────────────────────────────

describe('analyzer — measure order', () => {
  it('single measure', () => {
    const p = plan(`widget "w" {
      data { source: TIM as tims  measure v = count() }
      plot { type: kpi  value: v }
    }`);
    expect(p.measureOrder).toEqual(['v']);
  });

  it('independent measures in declaration order', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        measure a = count()
        measure b = count()
      }
      plot { type: kpi  value: a }
    }`);
    expect(p.measureOrder).toEqual(['a', 'b']);
  });

  it('derived measure comes after its dependencies', () => {
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        measure productive = sum(tims.time("t"))
        measure total      = sum(tims.duration)
        measure ratio      = productive / total
      }
      plot { type: kpi  value: ratio }
    }`);
    const order = p.measureOrder;
    expect(order.indexOf('productive')).toBeLessThan(order.indexOf('ratio'));
    expect(order.indexOf('total')).toBeLessThan(order.indexOf('ratio'));
    expect(order).toHaveLength(3);
  });

  it('derived measure declared before its dependencies', () => {
    // ratio declared before productive and total — should still resolve correctly
    const p = plan(`widget "w" {
      data {
        source: TIM as tims
        measure ratio      = productive / total
        measure productive = sum(tims.time("t"))
        measure total      = sum(tims.duration)
      }
      plot { type: kpi  value: ratio }
    }`);
    const order = p.measureOrder;
    expect(order.indexOf('productive')).toBeLessThan(order.indexOf('ratio'));
    expect(order.indexOf('total')).toBeLessThan(order.indexOf('ratio'));
  });

  it('detects circular measure dependency', () => {
    const errs = errors(`widget "w" {
      data {
        source: TIM as tims
        measure a = b + 1
        measure b = a + 1
      }
      plot { type: kpi  value: a }
    }`);
    expect(errs.some(e => e.toLowerCase().includes('circular'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Plot role validation
// ─────────────────────────────────────────────────────────────

describe('analyzer — plot validation', () => {
  it('rejects unknown role target', () => {
    const errs = errors(`widget "w" {
      data { source: TIM as tims  measure v = count() }
      plot { type: kpi  value: nonexistent }
    }`);
    expect(errs.some(e => e.includes('nonexistent'))).toBe(true);
  });

  it('rejects bar missing required roles', () => {
    const errs = errors(`widget "w" {
      data {
        source: TIM as tims
        group { x: period(day) }
        measure v = count()
      }
      plot { type: bar  x: x }
    }`);
    expect(errs.some(e => e.includes("'y'"))).toBe(true);
  });

  it('rejects x role pointing at measure for bar', () => {
    const errs = errors(`widget "w" {
      data {
        source: TIM as tims
        group { x: period(day) }
        measure v = count()
      }
      plot { type: bar  x: v  y: v }
    }`);
    expect(errs.some(e => e.includes("'x'") && e.includes('dimension'))).toBe(true);
  });

  it('rejects topk by with inline expression', () => {
    const errs = errors(`widget "w" {
      data {
        source: TIM as tims
        group { proj: topk(tims.parent.project, 3, by=sum(tims.duration)) }
        measure v = count()
      }
      plot { type: donut  category: proj  value: v }
    }`);
    expect(errs.some(e => e.includes("'by' must reference a declared measure"))).toBe(true);
  });

  it('rejects topk by referencing undeclared measure', () => {
    const errs = errors(`widget "w" {
      data {
        source: TIM as tims
        group { proj: topk(tims.parent.project, 3, by=ghost) }
        measure v = count()
      }
      plot { type: donut  category: proj  value: v }
    }`);
    expect(errs.some(e => e.includes('ghost') || e.includes("'by' must reference"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Path validation
// ─────────────────────────────────────────────────────────────

describe('analyzer — path validation', () => {
  it('rejects path not starting with alias', () => {
    const errs = errors(`widget "w" {
      data {
        source: TIM as tims
        where: reads.duration > 0
        measure v = count()
      }
      plot { type: kpi  value: v }
    }`);
    expect(errs.some(e => e.includes("'tims'"))).toBe(true);
  });
});
