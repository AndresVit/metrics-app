import { describe, it, expect } from 'vitest';
import { formatMinutes, formatMinuteAsTime } from '../formatDuration';

describe('formatMinutes', () => {
  it("zero → \"0'\"", () => expect(formatMinutes(0)).toBe("0'"));
  it("negative → \"0'\"", () => expect(formatMinutes(-5)).toBe("0'"));
  it("sub-minute rounds up", () => expect(formatMinutes(0.6)).toBe("1'"));
  it("45 → \"45'\"", () => expect(formatMinutes(45)).toBe("45'"));
  it("59 → \"59'\"", () => expect(formatMinutes(59)).toBe("59'"));
  it('60 → "1h"', () => expect(formatMinutes(60)).toBe('1h'));
  it('80 → "1h20"', () => expect(formatMinutes(80)).toBe('1h20'));
  it('90 → "1h30"', () => expect(formatMinutes(90)).toBe('1h30'));
  it('120 → "2h"', () => expect(formatMinutes(120)).toBe('2h'));
  it('125 → "2h5"', () => expect(formatMinutes(125)).toBe('2h5'));
  it('decimal rounds correctly: 80.4 → "1h20"', () => expect(formatMinutes(80.4)).toBe('1h20'));
  it('decimal rounds correctly: 80.6 → "1h21"', () => expect(formatMinutes(80.6)).toBe('1h21'));
});

describe('formatMinuteAsTime', () => {
  it('0 → "00:00"', () => expect(formatMinuteAsTime(0)).toBe('00:00'));
  it('300 → "05:00"', () => expect(formatMinuteAsTime(300)).toBe('05:00'));
  it('780 → "13:00"', () => expect(formatMinuteAsTime(780)).toBe('13:00'));
  it('1439 → "23:59"', () => expect(formatMinuteAsTime(1439)).toBe('23:59'));
  it('1440 normalises to "00:00"', () => expect(formatMinuteAsTime(1440)).toBe('00:00'));
  it('1500 normalises to "01:00"', () => expect(formatMinuteAsTime(1500)).toBe('01:00'));
  it('1680 normalises to "04:00"', () => expect(formatMinuteAsTime(1680)).toBe('04:00'));
});
