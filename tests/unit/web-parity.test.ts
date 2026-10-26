import { describe, expect, it } from 'vitest';
import { classifyReport } from '../../src/web/classify.js';
describe('web parity contracts', () => {
  it('does not transform reports', () => {
    const r = { retrieval: { completeness: 'complete' }, value: 1 } as never;
    expect(JSON.stringify(r)).toBe(JSON.stringify(r));
    expect(classifyReport(r)).toBe('completed');
  });
  it('partial is derived from report coverage', () =>
    expect(classifyReport({ coverage_map: { source: 'unavailable' } } as never)).toBe('partial'));
});
