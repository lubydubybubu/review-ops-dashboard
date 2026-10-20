import { describe, expect, it } from 'vitest';
import { applyTemplateOffsets, type TemplateOffsets } from '../../src/lib/domain/templates';

const loan: TemplateOffsets = { shootOffsetDays: 3, writeOffsetDays: 4, publishOffsetDays: 2 };

describe('template date offsets (R1.8)', () => {
  it('write-by = shoot + N, publish = write-by + M', () => {
    expect(applyTemplateOffsets({ shootOn: '2026-10-20' }, loan)).toEqual({
      receivedOn: null,
      shootOn: '2026-10-20',
      writeDueOn: '2026-10-24',
      publishPlannedOn: '2026-10-26',
    });
  });

  it('anchoring on 입고 fills the whole chain across a month boundary', () => {
    expect(applyTemplateOffsets({ receivedOn: '2026-10-25' }, loan)).toEqual({
      receivedOn: '2026-10-25',
      shootOn: '2026-10-28',
      writeDueOn: '2026-11-01',
      publishPlannedOn: '2026-11-03',
    });
  });

  it('crosses year and leap-day boundaries', () => {
    const offsets = { shootOffsetDays: 0, writeOffsetDays: 30, publishOffsetDays: 1 };
    expect(applyTemplateOffsets({ shootOn: '2027-12-31' }, offsets).writeDueOn).toBe('2028-01-30');
    expect(applyTemplateOffsets({ shootOn: '2028-01-30' }, offsets).writeDueOn).toBe('2028-02-29');
  });

  it('never overwrites a date the owner entered', () => {
    const result = applyTemplateOffsets({ shootOn: '2026-10-20', publishPlannedOn: '2026-11-30' }, loan);
    expect(result.writeDueOn).toBe('2026-10-24');
    expect(result.publishPlannedOn).toBe('2026-11-30');
  });

  it('later anchors do not compute earlier dates', () => {
    expect(applyTemplateOffsets({ writeDueOn: '2026-10-24' }, loan)).toEqual({
      receivedOn: null,
      shootOn: null,
      writeDueOn: '2026-10-24',
      publishPlannedOn: '2026-10-26',
    });
  });

  it('a missing offset breaks the chain at that link', () => {
    const partial = { shootOffsetDays: 3, writeOffsetDays: null, publishOffsetDays: 2 };
    expect(applyTemplateOffsets({ receivedOn: '2026-10-01' }, partial)).toEqual({
      receivedOn: '2026-10-01',
      shootOn: '2026-10-04',
      writeDueOn: null,
      publishPlannedOn: null,
    });
  });

  it('no anchor, no dates', () => {
    expect(applyTemplateOffsets({}, loan)).toEqual({
      receivedOn: null,
      shootOn: null,
      writeDueOn: null,
      publishPlannedOn: null,
    });
  });
});
