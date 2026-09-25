import { describe, expect, it } from 'vitest';

import { createAxisControls } from '../src/shell/controls/axes';

// Enough of a <select> for read(): the node test environment has no DOM.
function select(value = ''): HTMLSelectElement {
  return { value, addEventListener() {} } as unknown as HTMLSelectElement;
}

describe('axis controls', () => {
  it('never reads an empty unit from selectors that were not filled', () => {
    const controls = createAxisControls(select(), select(), () => {});
    expect(controls.read()).toEqual({ xUnit: 'pings', yUnit: 'meters' });
  });

  it('reads the chosen units when the selectors hold them', () => {
    const controls = createAxisControls(select('seconds'), select('range_sample'), () => {});
    expect(controls.read()).toEqual({ xUnit: 'seconds', yUnit: 'range_sample' });
  });
});
