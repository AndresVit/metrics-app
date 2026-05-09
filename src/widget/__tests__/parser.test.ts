import { describe, it, expect } from 'vitest';
import { parseWidgetDef } from '../parser';
import type { WidgetDef, PeriodDimension, TopkDimension, AttributeDimension } from '../ast';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function ok(src: string): WidgetDef {
  const r = parseWidgetDef(src);
  if (!r.ok) throw new Error(`Parse failed: ${r.error}`);
  return r.widget;
}

function fail(src: string): string {
  const r = parseWidgetDef(src);
  if (r.ok) throw new Error('Expected parse failure but it succeeded');
  return r.error;
}

// ─────────────────────────────────────────────────────────────
// Minimal valid widget
// ─────────────────────────────────────────────────────────────

const MINIMAL = `
widget "kpi_test" {
  data {
    source: TIM as tims
    measure total = count()
  }
  plot { type: kpi  value: total }
}`;

describe('parser — minimal widget', () => {
  it('parses name', () => {
    expect(ok(MINIMAL).name).toBe('kpi_test');
  });

  it('parses source', () => {
    const { source } = ok(MINIMAL).data;
    expect(source.definitionCode).toBe('TIM');
    expect(source.alias).toBe('tims');
  });

  it('upcases source code', () => {
    const w = ok(MINIMAL.replace('TIM', 'tim'));
    expect(w.data.source.definitionCode).toBe('TIM');
  });

  it('has no where clause', () => {
    expect(ok(MINIMAL).data.where).toBeNull();
  });

  it('has no group dims', () => {
    expect(ok(MINIMAL).data.group).toHaveLength(0);
  });

  it('parses count() measure', () => {
    const [m] = ok(MINIMAL).data.measures;
    expect(m.name).toBe('total');
    expect(m.expr.kind).toBe('call');
    if (m.expr.kind === 'call') expect(m.expr.fn).toBe('count');
  });

  it('parses plot type and role', () => {
    const { plot } = ok(MINIMAL);
    expect(plot.type).toBe('kpi');
    expect(plot.roles.value).toBe('total');
  });
});

// ─────────────────────────────────────────────────────────────
// WHERE clause variants
// ─────────────────────────────────────────────────────────────

describe('parser — WHERE clause', () => {
  it('parses path in array', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        where: tims.parent.code in ["EST", "WORK"]
        measure v = count()
      }
      plot { type: kpi  value: v }
    }`);
    const where = w.data.where!;
    expect(where.kind).toBe('in');
    if (where.kind === 'in') {
      expect(where.negated).toBe(false);
      expect(where.values).toHaveLength(2);
    }
  });

  it('parses UNDER operator', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        where: tims.parent.subdivision under "m"
        measure v = count()
      }
      plot { type: kpi  value: v }
    }`);
    const where = w.data.where!;
    expect(where.kind).toBe('under');
    if (where.kind === 'under') {
      expect(where.prefix).toBe('m');
      expect(where.negated).toBe(false);
    }
  });

  it('parses NOT IN', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        where: tims.parent.code not in ["READ"]
        measure v = count()
      }
      plot { type: kpi  value: v }
    }`);
    const where = w.data.where!;
    expect(where.kind).toBe('in');
    if (where.kind === 'in') expect(where.negated).toBe(true);
  });

  it('parses AND / OR logic', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        where: tims.parent.code in ["EST"] and tims.duration > 0
        measure v = count()
      }
      plot { type: kpi  value: v }
    }`);
    expect(w.data.where?.kind).toBe('binary');
    if (w.data.where?.kind === 'binary') expect(w.data.where.op).toBe('and');
  });
});

// ─────────────────────────────────────────────────────────────
// Group dimensions
// ─────────────────────────────────────────────────────────────

describe('parser — group dimensions', () => {
  it('parses period(day)', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        group { x: period(day) }
        measure v = count()
      }
      plot { type: bar  x: x  y: v }
    }`);
    const dim = w.data.group[0] as PeriodDimension;
    expect(dim.kind).toBe('period');
    expect(dim.name).toBe('x');
    expect(dim.periodType).toBe('day');
  });

  it('parses all period types', () => {
    const types = ['hour', 'day', 'week', 'month', 'weekday', 'day_of_month', 'month_of_year'];
    for (const pt of types) {
      const w = ok(`widget "w" {
        data {
          source: TIM as tims
          group { x: period(${pt}) }
          measure v = count()
        }
        plot { type: bar  x: x  y: v }
      }`);
      expect((w.data.group[0] as PeriodDimension).periodType).toBe(pt);
    }
  });

  it('parses attribute dimension', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        group { proj: tims.parent.project }
        measure v = count()
      }
      plot { type: donut  category: proj  value: v }
    }`);
    const dim = w.data.group[0] as AttributeDimension;
    expect(dim.kind).toBe('attribute');
    expect(dim.name).toBe('proj');
    expect(dim.path.segments).toHaveLength(3); // tims, .parent, .project
  });

  it('parses topk with measure_ref by', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        group { proj: topk(tims.parent.project, 5, by=productive) }
        measure productive = count()
      }
      plot { type: donut  category: proj  value: productive }
    }`);
    const dim = w.data.group[0] as TopkDimension;
    expect(dim.kind).toBe('topk');
    expect(dim.k).toBe(5);
    expect(dim.by.kind).toBe('measure_ref');
    if (dim.by.kind === 'measure_ref') expect(dim.by.name).toBe('productive');
  });

  it('parses subdivision index access [0]', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        group { cat: tims.parent.subdivision[0] }
        measure v = count()
      }
      plot { type: donut  category: cat  value: v }
    }`);
    const dim = w.data.group[0] as AttributeDimension;
    const lastSeg = dim.path.segments[dim.path.segments.length - 1];
    expect(lastSeg.kind).toBe('index');
    if (lastSeg.kind === 'index') expect(lastSeg.index).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Measure expressions
// ─────────────────────────────────────────────────────────────

describe('parser — measures', () => {
  it('parses sum(path)', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        measure dur = sum(tims.duration)
      }
      plot { type: kpi  value: dur }
    }`);
    const [m] = w.data.measures;
    expect(m.expr.kind).toBe('call');
    if (m.expr.kind === 'call') expect(m.expr.fn).toBe('sum');
  });

  it('parses time("t")', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        measure prod = sum(tims.time("t"))
      }
      plot { type: kpi  value: prod }
    }`);
    const arg = (w.data.measures[0].expr as any).args[0];
    expect(arg.kind).toBe('time');
    expect(arg.label).toBe('t');
    expect(arg.hierarchical).toBe(false);
  });

  it('parses timeUnder("m")', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        measure deep = sum(tims.timeUnder("m"))
      }
      plot { type: kpi  value: deep }
    }`);
    const arg = (w.data.measures[0].expr as any).args[0];
    expect(arg.kind).toBe('time');
    expect(arg.label).toBe('m');
    expect(arg.hierarchical).toBe(true);
  });

  it('parses derived measure with measure_ref', () => {
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        measure a = count()
        measure b = count()
        measure ratio = a / b
      }
      plot { type: kpi  value: ratio }
    }`);
    const ratio = w.data.measures[2];
    expect(ratio.expr.kind).toBe('binary');
    if (ratio.expr.kind === 'binary') {
      expect(ratio.expr.op).toBe('/');
      expect(ratio.expr.left.kind).toBe('measure_ref');
      expect(ratio.expr.right.kind).toBe('measure_ref');
    }
  });

  it('parses arithmetic precedence correctly', () => {
    // a + b * c → binary(+, a, binary(*, b, c))
    const w = ok(`widget "w" {
      data {
        source: TIM as tims
        measure a = count()
        measure b = count()
        measure c = count()
        measure r = a + b * c
      }
      plot { type: kpi  value: r }
    }`);
    const r = w.data.measures[3].expr;
    expect(r.kind).toBe('binary');
    if (r.kind === 'binary') {
      expect(r.op).toBe('+');
      expect(r.right.kind).toBe('binary');
      if (r.right.kind === 'binary') expect(r.right.op).toBe('*');
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Parse errors
// ─────────────────────────────────────────────────────────────

describe('parser — errors', () => {
  it('rejects missing data section', () => {
    expect(fail(`widget "w" { plot { type: kpi  value: v } }`))
      .toContain('missing a \'data\'');
  });

  it('rejects missing plot section', () => {
    expect(fail(`widget "w" { data { source: TIM as t  measure v = count() } }`))
      .toContain('missing a \'plot\'');
  });

  it('rejects missing source', () => {
    expect(fail(`widget "w" {
      data { measure v = count() }
      plot { type: kpi  value: v }
    }`)).toContain('missing a \'source\'');
  });

  it('rejects missing measures', () => {
    expect(fail(`widget "w" {
      data { source: TIM as tims }
      plot { type: kpi  value: v }
    }`)).toContain('at least one measure');
  });

  it('rejects invalid period type', () => {
    expect(fail(`widget "w" {
      data {
        source: TIM as tims
        group { x: period(fortnight) }
        measure v = count()
      }
      plot { type: bar  x: x  y: v }
    }`)).toContain('fortnight');
  });

  it('rejects missing plot type', () => {
    expect(fail(`widget "w" {
      data { source: TIM as tims  measure v = count() }
      plot { value: v }
    }`)).toContain('missing a \'type\'');
  });
});
