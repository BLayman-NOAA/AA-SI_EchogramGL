import { describe, expect, it } from 'vitest';

import { travel } from '../src/app/interaction';
import { Viewport } from '../src/app/viewport';

const panel = { width: 1600, height: 800 };

function make(overrides = {}) {
  return new Viewport({ x: [0, 1000], y: [0, 500], panel, ...overrides });
}

describe('wheel travel', () => {
  it('reads a line and a page as more than a pixel', () => {
    expect(travel({ deltaY: 100, deltaMode: 0 })).toBe(100);
    expect(travel({ deltaY: 3, deltaMode: 1 })).toBeGreaterThan(3);
    expect(travel({ deltaY: 1, deltaMode: 2 })).toBeGreaterThan(
      travel({ deltaY: 1, deltaMode: 1 }),
    );
  });
});

describe('zoomAt', () => {
  it('keeps the point under the pointer under it, on both axes', () => {
    const view = make();
    const at = (range: [number, number], fraction: number) =>
      range[0] + (range[1] - range[0]) * fraction;
    const before = [at(view.x, 0.25), at(view.y, 0.75)];

    view.zoomAt(0.5, 0.25, 0.75);
    expect(at(view.x, 0.25)).toBeCloseTo(before[0], 9);
    expect(at(view.y, 0.75)).toBeCloseTo(before[1], 9);
  });

  it('holds the exaggeration through a zoom under a free policy', () => {
    const view = make();
    const shape = view.exaggeration;
    view.zoomAt(0.4, 0.2, 0.8);
    expect(view.exaggeration).toBeCloseTo(shape, 9);
  });

  it('moves both scales together under a lock and leaves the factor alone', () => {
    const view = make();
    view.setMode('locked', 4);
    const spans = [view.x[1] - view.x[0], view.y[1] - view.y[0]];

    view.zoomAt(0.5, 0.5, 0.5);
    expect(view.x[1] - view.x[0]).toBeCloseTo(spans[0] * 0.5, 9);
    expect(view.y[1] - view.y[0]).toBeCloseTo(spans[1] * 0.5, 9);
    expect(view.exaggeration).toBeCloseTo(4, 9);
  });

  it('keeps the pointer fixed under a lock, where the vertical is derived', () => {
    const view = make();
    view.setMode('locked', 2);
    const at = (range: [number, number], fraction: number) =>
      range[0] + (range[1] - range[0]) * fraction;
    const before = [at(view.x, 0.1), at(view.y, 0.9)];

    view.zoomAt(0.25, 0.1, 0.9);
    expect(at(view.x, 0.1)).toBeCloseTo(before[0], 9);
    expect(at(view.y, 0.9)).toBeCloseTo(before[1], 9);
  });
});

describe('clampInto', () => {
  it('lets a pan run off an edge but not past the data', () => {
    const view = make();
    view.panBy(100000, 0);
    view.clampInto([0, 1000], [0, 500]);
    expect(view.x[0]).toBeLessThan(1000);
    expect(view.x[1]).toBeGreaterThan(1000);
  });

  it('changes nothing while the view is over the data', () => {
    const view = make();
    const before = { x: view.x, y: view.y };
    view.clampInto([0, 1000], [0, 500]);
    expect(view.x).toEqual(before.x);
    expect(view.y).toEqual(before.y);
  });

  it('is a translation, so a lock survives it', () => {
    const view = make();
    view.setMode('locked', 4);
    const spans = [view.x[1] - view.x[0], view.y[1] - view.y[0]];

    view.panBy(-100000, -100000);
    view.clampInto([0, 1000], [0, 500]);
    expect(view.x[1] - view.x[0]).toBeCloseTo(spans[0], 9);
    expect(view.y[1] - view.y[0]).toBeCloseTo(spans[1], 9);
    expect(view.exaggeration).toBeCloseTo(4, 9);
  });

  it('leaves a quarter of the view over the data at the far edge', () => {
    const view = new Viewport({ x: [0, 400], y: [0, 500], panel });
    view.panBy(100000, 0);
    view.clampInto([0, 1000], [0, 500]);
    expect(view.x[0]).toBeCloseTo(900, 9);
  });
});
