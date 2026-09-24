import { describe, expect, it } from 'vitest';

import { blendFor } from '../src/render/blend';

describe('blend state', () => {
  // The table in Software_Architecture.md section 5.10.
  it('composites over with the painter of the alpha it carries', () => {
    expect(blendFor('over')).toEqual({
      color: {
        srcFactor: 'src-alpha',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
      alpha: {
        srcFactor: 'src-alpha',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
    });
  });

  it('accumulates in add, which is what makes the tricolor echogram', () => {
    expect(blendFor('add')).toEqual({
      color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
    });
  });

  it('keeps the destination in add, so red under blue reads as magenta', () => {
    // The one property the tricolor case rests on: what is already there is
    // not scaled down by the layer arriving on top of it.
    expect(blendFor('add').color.dstFactor).toBe('one');
    expect(blendFor('over').color.dstFactor).toBe('one-minus-src-alpha');
  });
});
