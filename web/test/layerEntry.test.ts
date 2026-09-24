import { describe, expect, it } from 'vitest';

import type { Layer } from '../src/app/layers';
import { sameShape } from '../src/render/drawLayer';

/**
 * The cached bind groups are the thing under test here, not the drawing.
 *
 * Group 0 of a layer names two geometry buffers: its own channel's at binding 4
 * and the channel it differences against at binding 5. A layer that keeps its
 * groups across a change to either is a layer drawing one channel's samples at
 * another channel's depths, which is a wrong picture rather than a missing one.
 * This asserts the comparison that decides it.
 */
function entry(layer: Partial<Layer>, shared: Record<string, unknown> = {}) {
  const groups = shared.groups ?? new Map();
  return {
    layer: {
      id: 'layer-0',
      channel: 0,
      visible: true,
      color: { colormap: 'viridis' },
      ...layer,
    },
    pipeline: shared.pipeline ?? 'pipeline',
    sampler: shared.sampler ?? 'sampler',
    table: shared.table ?? 'table',
    groups,
    tileGroups: new Map(),
  } as unknown as Parameters<typeof sameShape>[0][number];
}

describe('reusing what a layer built', () => {
  it('reuses it when nothing the groups name has moved', () => {
    const shared = { groups: new Map() };
    expect(sameShape([entry({}, shared)], [entry({}, shared)])).toBe(true);
  });

  it('does not reuse it across a change of channel', () => {
    // The bug this exists for. Switching a layer from 18 kHz to 70 kHz keeps
    // the pipeline, the sampler and the colour table, so every other check
    // passes and the group built for 18 kHz would have been kept: the 70 kHz
    // samples would be laid out on an 0.188 m grid instead of 0.179, three and
    // a half metres out at the bottom of a 391 sample column.
    const shared = { groups: new Map() };
    expect(sameShape([entry({ channel: 0 }, shared)], [entry({ channel: 1 }, shared)])).toBe(
      false,
    );
  });

  it('does not reuse it across a change of what is differenced against', () => {
    const shared = { groups: new Map() };
    expect(
      sameShape([entry({ against: 1 }, shared)], [entry({ against: 4 }, shared)]),
    ).toBe(false);
  });

  it('does not reuse it when the groups themselves were rebuilt', () => {
    expect(sameShape([entry({})], [entry({})])).toBe(false);
  });

  it('notices a layer appearing, disappearing or being hidden', () => {
    const shared = { groups: new Map() };
    expect(sameShape([entry({}, shared)], [])).toBe(false);
    expect(
      sameShape([entry({ visible: true }, shared)], [entry({ visible: false }, shared)]),
    ).toBe(false);
    expect(
      sameShape([entry({ id: 'a' }, shared)], [entry({ id: 'b' }, shared)]),
    ).toBe(false);
  });
});
