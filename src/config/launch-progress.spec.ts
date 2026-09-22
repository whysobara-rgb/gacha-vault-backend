import { readFileSync } from 'fs';
import { resolve } from 'path';
const { summarize } = require('../../tools/release/progress.cjs');
const ledger = readFileSync(resolve(__dirname, '../../docs/LAUNCH_100.ko.md'), 'utf8');

describe('100-step evidence accounting', () => {
  it('counts reviewed checkpoints rather than the number of test cases', () => {
    const r = summarize(ledger);
    expect(r.accepted + r.remaining).toBe(100);
    expect(r.groups.reduce((s: number, g: any) => s + g.accepted, 0)).toBe(r.accepted);
    expect(r.notLaborPercentage).toBe(true);
    expect(r.commercialSuccessGuaranteed).toBe(false);
  });
  it('does not approve launch while any checkpoint is outstanding', () => {
    const r = summarize(ledger);
    expect(r.remaining).toBeGreaterThan(0);
    expect(r.checklistComplete).toBe(false);
  });
  it('rejects missing checkpoints and duplicate identifiers', () => {
    expect(() => summarize(ledger.split('\n').filter(l => !/^\| 100 \|/.test(l)).join('\n'))).toThrow('EXACTLY_100');
    expect(() => summarize(ledger.replace('| 100 |', '| 99 |'))).toThrow('EXACTLY_100');
  });
  it('does not allow developer tests to stand in for live database backup evidence', () => {
    const changed = ledger.replace(/(\| 53 \|[^\n]+\| LIVE \|) BLOCKED \| - \|/, '$1 DONE | E2 |');
    expect(changed).not.toBe(ledger);
    expect(() => summarize(changed)).toThrow('EVIDENCE_SCOPE_MISMATCH');
  });
  it('rejects unknown evidence for completed items', () => {
    expect(() => summarize(ledger.replace('| DONE | E1,E2 |', '| DONE | E999 |'))).toThrow('UNKNOWN_EVIDENCE');
  });
});
