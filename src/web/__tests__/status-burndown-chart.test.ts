import { describe, expect, it } from 'bun:test';

import { niceAxisMaximum, stackedTotal } from '../src/components/status-burndown-chart';

describe('status burndown chart helpers', () => {
  it('sizes the y axis from the displayed stacked total', () => {
    expect(niceAxisMaximum(0)).toBe(1);
    expect(niceAxisMaximum(3)).toBe(3);
    expect(niceAxisMaximum(7)).toBe(8);
    expect(niceAxisMaximum(31)).toBe(40);
    expect(niceAxisMaximum(58)).toBe(60);
  });

  it('totals only displayed statuses', () => {
    const counts = { pending: 3, completed: 5, hidden: 20 };
    expect(stackedTotal(counts, ['pending', 'completed'])).toBe(8);
  });
});
