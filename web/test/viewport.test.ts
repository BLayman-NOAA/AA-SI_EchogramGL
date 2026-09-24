import { describe, expect, it } from 'vitest';

import { Viewport, fitAll } from '../src/app/viewport';

const panel = { width: 1600, height: 800 };

function make(overrides = {}) {
  return new Viewport({ x: [0, 1000], y: [0, 500], panel, ...overrides });
}

describe('aspect policy', () => {
  it('gives equal metres per pixel on both axes at true scale', () => {
    const view = make();
    view.lockTrueScale();
    expect(view.xPerPixel).toBeCloseTo(view.yPerPixel, 9);
  });

  it('holds true scale through a zoom', () => {
    const view = make();
    view.lockTrueScale();
    view.zoomX(0.25);
    expect(view.xPerPixel).toBeCloseTo(view.yPerPixel, 9);
    expect(view.x[1] - view.x[0]).toBeCloseTo(250, 9);
  });

  it('leaves the vertical alone under a free policy', () => {
    const view = make();
    const before = view.y;
    view.zoomX(0.5);
    expect(view.y).toEqual(before);
  });

  it('holds the column at the panel height through a zoom, when set that way', () => {
    // Fit to depth is the free policy with the vertical pinned to the data.
    const view = make();
    const column = view.y;
    for (const scale of [0.5, 0.25, 4]) {
      view.zoomX(scale);
      expect(view.y).toEqual(column);
      expect(view.columnPixels(column)).toBeCloseTo(panel.height, 6);
    }
  });

  it('preserves the horizontal range when the policy changes', () => {
    // FR-74: the user is looking at a stretch of survey, not at a depth range.
    const view = make();
    const before = view.x;
    view.setMode('locked', 4);
    expect(view.x).toEqual(before);
    view.setMode('free');
    expect(view.x).toEqual(before);
  });

  it('collapses the column when switching to true scale on a long window', () => {
    const view = make({ x: [0, 8000] });
    const tall = view.y[1] - view.y[0];
    view.lockTrueScale();
    expect(view.y[1] - view.y[0]).toBeCloseTo(4000, 6);
    expect(view.y[1] - view.y[0]).toBeGreaterThan(tall);
  });

  it('holds the column and changes how much track fits, on a factor change', () => {
    // The control is for shaping the picture around the water column, so
    // dragging it squashes the horizontal rather than zooming the vertical.
    const view = make();
    view.setMode('locked', 1);
    const column = view.y;
    const before = view.x[1] - view.x[0];

    view.setExaggeration(2);
    expect(view.y[0]).toBeCloseTo(column[0], 6);
    expect(view.y[1]).toBeCloseTo(column[1], 6);
    expect(view.x[1] - view.x[0]).toBeCloseTo(before * 2, 6);
  });

  it('holds the horizontal on a policy change, which is the other way round', () => {
    const view = make();
    const before = view.x;
    view.setMode('locked', 4);
    expect(view.x).toEqual(before);
  });

  it('puts the column in the panel at true scale, once the factor is dragged', () => {
    // 500 m of water on a panel twice as wide as tall is 1000 m of track.
    const view = make({ x: [0, 8000] });
    view.setY([0, 500]);
    view.setMode('locked', view.exaggeration);
    view.setExaggeration(1);
    expect(view.x[1] - view.x[0]).toBeCloseTo(1000, 6);
    expect(view.xPerPixel).toBeCloseTo(view.yPerPixel, 9);
  });

  it('reports the exaggeration a free viewport currently happens to have', () => {
    const view = make();
    expect(view.exaggeration).toBeCloseTo(1, 9);
  });

  it('lets the named axis win, so setting the vertical moves the horizontal', () => {
    const view = make();
    view.setMode('locked', 1);
    view.setY([0, 100]);
    expect(view.y).toEqual([0, 100]);
    expect(view.xPerPixel).toBeCloseTo(view.yPerPixel, 9);
  });

  it('refuses an exaggeration that is not a positive number', () => {
    const view = make();
    expect(() => view.setExaggeration(0)).toThrow(/positive/);
    expect(() => view.setExaggeration(Number.NaN)).toThrow(/positive/);
  });

  it('keeps the lock when the panel is resized', () => {
    const view = make();
    view.lockTrueScale();
    view.setPanel({ width: 800, height: 800 });
    expect(view.xPerPixel).toBeCloseTo(view.yPerPixel, 9);
  });

  it('pans without changing either span', () => {
    const view = make();
    const spans = [view.x[1] - view.x[0], view.y[1] - view.y[0]];
    view.panBy(100, 50);
    expect(view.x[1] - view.x[0]).toBeCloseTo(spans[0], 9);
    expect(view.y[1] - view.y[0]).toBeCloseTo(spans[1], 9);
    expect(view.x[0]).toBeCloseTo(62.5, 9);
  });
});

describe('fitAll', () => {
  it('fills the canvas whatever shape the data is, so nothing opens a sliver', () => {
    // 40 km of track over 100 m of water. FR-73 without a clamp: the panel is
    // given rather than derived, so fitting the extent fills it.
    const view = fitAll([0, 40000], [0, 100], panel);
    expect(view.columnPixels([0, 100])).toBeCloseTo(panel.height, 6);
    expect(view.x).toEqual([0, 40000]);
  });

  it('reports the exaggeration the fit happens to have', () => {
    const view = fitAll([0, 40000], [0, 100], panel);
    // 25 m per pixel across, 0.125 m per pixel down.
    expect(view.exaggeration).toBeCloseTo(200, 6);
    expect(view.mode).toBe('free');
  });

  it('starts a lock from the shape already on screen', () => {
    const view = fitAll([0, 40000], [0, 100], panel);
    const before = view.y;
    view.setMode('locked', view.exaggeration);
    expect(view.y[0]).toBeCloseTo(before[0], 6);
    expect(view.y[1]).toBeCloseTo(before[1], 6);
  });
});

describe('what a factor change holds', () => {
  it('holds the vertical by default, which is what a drag wants', () => {
    const view = make();
    view.setMode('locked', 1);
    const column = view.y;
    view.setExaggeration(2);
    expect(view.y[0]).toBeCloseTo(column[0], 6);
    expect(view.y[1]).toBeCloseTo(column[1], 6);
  });

  it('holds the horizontal when asked, which is what a preset wants', () => {
    // True scale from an already locked view has to behave the same as true
    // scale from a free one, and a policy change holds x per FR-74.
    const view = make();
    view.setMode('locked', 4);
    const span = view.x;
    view.setExaggeration(1, 'x');
    expect(view.x).toEqual(span);
    expect(view.xPerPixel).toBeCloseTo(view.yPerPixel, 9);
  });

  it('stores the factor but moves nothing while the policy is free', () => {
    const view = make();
    const before = { x: view.x, y: view.y };
    view.setExaggeration(9);
    expect(view.x).toEqual(before.x);
    expect(view.y).toEqual(before.y);
  });
});

describe('reframe', () => {
  it('adopts the factor the new ranges imply, leaving the picture alone', () => {
    // The case that made a unit change move the depth axis: relabelling the
    // horizontal must not hold a factor whose meaning came from the old label.
    const view = new Viewport({ x: [0, 1211], y: [0, 500], panel, mode: 'locked' });
    const shape = view.exaggeration;
    view.reframe([0, 7466], [0, 500]);

    expect(view.y).toEqual([0, 500]);
    expect(view.x).toEqual([0, 7466]);
    expect(view.exaggeration).not.toBeCloseTo(shape, 3);
    expect(view.exaggeration).toBeCloseTo((800 / 500) / (1600 / 7466), 9);
  });

  it('fits both extents while locked, which deriving cannot', () => {
    const view = new Viewport({ x: [0, 1211], y: [0, 500], panel, mode: 'locked' });
    view.reframe([0, 7466], [0, 500]);
    expect(view.x).toEqual([0, 7466]);
    expect(view.y).toEqual([0, 500]);
    expect(view.mode).toBe('locked');
  });

  it('leaves the factor alone while free, since nothing is holding it', () => {
    const view = make();
    view.reframe([0, 4000], [0, 250]);
    expect(view.x).toEqual([0, 4000]);
    expect(view.y).toEqual([0, 250]);
    expect(view.mode).toBe('free');
  });
});

describe('what a derived axis holds still', () => {
  it('keeps the top of the column when the horizontal is set under a lock', () => {
    // Typing a shorter x range under a lock has to shorten the column, but the
    // surface is where a reader measures from, so it is the top that stays.
    const view = new Viewport({ x: [0, 1000], y: [100, 600], panel, mode: 'locked' });
    view.setMode('locked', 1);
    view.setX([0, 500]);

    expect(view.y[0]).toBeCloseTo(100, 9);
    expect(view.y[1]).toBeCloseTo(350, 9);
  });

  it('keeps the middle when the vertical is set under a lock', () => {
    // Holding an edge instead walks the picture sideways, and leaves the middle
    // of the view out past the end of the data for the next zoom to centre on.
    const view = make({ x: [200, 1200] });
    view.setMode('locked', 1);
    view.setY([0, 250]);

    expect(view.x[0]).toBeCloseTo(450, 9);
    expect(view.x[1]).toBeCloseTo(950, 9);
  });

  it('does not drift sideways over a widen and a narrow', () => {
    // Typing a deeper bound widens the track span, and dragging the factor back
    // down narrows it again. Both hold the middle, so the picture returns.
    const view = make();
    view.setMode('locked', 1);
    const middle = (view.x[0] + view.x[1]) / 2;

    view.setY([0, 2000]);
    expect((view.x[0] + view.x[1]) / 2).toBeCloseTo(middle, 9);

    view.setExaggeration(0.25);
    expect((view.x[0] + view.x[1]) / 2).toBeCloseTo(middle, 9);
  });

  it('grows the column downward when locking, not up past the surface', () => {
    const view = make({ x: [0, 8000] });
    view.lockTrueScale();
    expect(view.y[0]).toBeCloseTo(0, 9);
    expect(view.y[1]).toBeCloseTo(4000, 9);
  });

  it('keeps the horizontal centre through a factor drag, which is a gesture', () => {
    const view = make();
    view.setMode('locked', 1);
    view.setExaggeration(2);
    expect((view.x[0] + view.x[1]) / 2).toBeCloseTo(500, 9);
    expect(view.x[1] - view.x[0]).toBeCloseTo(2000, 9);
  });
});
