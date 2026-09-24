import { describe, expect, it } from 'vitest';

import {
  HYSTERESIS,
  chooseLevel,
  levelFor,
  resolveSlot,
  sourcePings,
  wantedFactor,
} from '../src/geometry/levels';

/** The survey store: five levels halving the ping axis each time. */
const factors = [1, 2, 4, 8, 16];

describe('reading the view in level zero pings', () => {
  it('gives the same answer whatever level is loaded', () => {
    // A coarse level has wider cells and fewer of them, and the factor takes
    // the level back out, so the choice cannot depend on the current choice.
    const fine = sourcePings(1000, 6.17, 1);
    const coarse = sourcePings(1000, 6.17 * 8, 8);
    expect(coarse).toBeCloseTo(fine, 9);
  });

  it('refuses to answer for an empty span or spacing', () => {
    expect(sourcePings(0, 5, 1)).toBe(0);
    expect(sourcePings(100, 0, 1)).toBe(0);
  });
});

describe('target level', () => {
  it('makes a drawn ping as wide as it was asked for', () => {
    // A pixel to a ping: 16,000 pings across 1600 pixels merges ten into each.
    expect(wantedFactor(16000, 1600, 1)).toBe(10);
    expect(wantedFactor(1600, 1600, 1)).toBe(1);
    // Twice as wide a cell is twice the merge, which is the default.
    expect(wantedFactor(16000, 1600)).toBe(20);
    expect(wantedFactor(1600, 1600, 8)).toBe(8);
  });

  it('takes the coarsest level at or below the wanted factor', () => {
    expect(levelFor(1, factors)).toBe(0);
    expect(levelFor(1.9, factors)).toBe(0);
    expect(levelFor(2, factors)).toBe(1);
    expect(levelFor(10, factors)).toBe(3);
    expect(levelFor(4000, factors)).toBe(4);
  });

  it('stays at level zero below a factor of one, rather than going finer', () => {
    expect(levelFor(0.01, factors)).toBe(0);
  });

  it('opens a whole leg at the coarsest level', () => {
    // 300,000 pings across 1600 pixels wants a factor of 375, past the top of
    // this pyramid, so the coarsest is what draws.
    const wanted = wantedFactor(sourcePings(300000, 1, 1), 1600);
    expect(levelFor(wanted, factors)).toBe(4);
  });
});

describe('hysteresis', () => {
  it('holds a level until the wanted factor clears the boundary', () => {
    // Sitting on the boundary, which is where a viewport rests after a zoom.
    expect(chooseLevel(0, 2, factors)).toBe(0);
    expect(chooseLevel(0, 2 * HYSTERESIS, factors)).toBe(1);
  });

  it('holds it going the other way too', () => {
    expect(chooseLevel(1, 1.9, factors)).toBe(1);
    expect(chooseLevel(1, 2 / HYSTERESIS - 0.01, factors)).toBe(0);
  });

  it('does not move at all where the level is already right', () => {
    expect(chooseLevel(2, 5, factors)).toBe(2);
  });

  it('does not block a jump of several levels', () => {
    // What the pixels per ping control asks for: one change takes the wanted
    // factor from 8 to 64. Measured against the destination's own factor, 71 is
    // inside its band and the view would stay four levels too fine.
    const deep = [1, 2, 4, 8, 16, 32, 64, 128];
    expect(chooseLevel(3, 71, deep)).toBe(6);
    expect(chooseLevel(6, 8.9, deep)).toBe(3);
  });

  it('keeps a band around the boundary either way', () => {
    // The point of hysteresis: a viewport resting on a boundary must not flap
    // between two levels as the last pixel of a drag moves it.
    const deep = [1, 2, 4, 8, 16, 32, 64, 128];
    expect(chooseLevel(5, 64 * 0.99, deep)).toBe(5);
    expect(chooseLevel(5, 64 * HYSTERESIS, deep)).toBe(6);
    expect(chooseLevel(6, 64 / 1.1, deep)).toBe(6);
    expect(chooseLevel(6, 64 / HYSTERESIS - 0.01, deep)).toBe(5);
  });
});

describe('resolveSlot', () => {
  const tilePings = 2048;
  // Level 0 holds 40,000 pings, so each level holds half of the last.
  const pingsAt = (level: number) => Math.ceil(40000 / factors[level]);

  function context(held: Set<string>) {
    return {
      factors,
      tilePings,
      pingsAt,
      resident: (level: number, row: number, column: number) =>
        held.has(`${level}:${row}:${column}`),
      // The last level is the one the view pins for the whole survey, and the
      // substitution cap does not apply to it.
      exempt: factors.length - 1,
    };
  }

  it('draws the slot itself where the target tile is resident', () => {
    const draw = resolveSlot({ row: 3, column: 0 }, 0, context(new Set(['0:3:0'])));
    expect(draw).toEqual({
      level: 0,
      row: 3,
      column: 0,
      firstInstance: 0,
      instances: 2048,
    });
  });

  it('falls back to a coarser level as an instance range inside one tile', () => {
    // Level 2 is four times coarser, so one of its tiles covers four level 0
    // slots and slot 3 is the last quarter of tile 0.
    const draw = resolveSlot({ row: 3, column: 0 }, 0, context(new Set(['2:0:0'])));
    expect(draw).toEqual({
      level: 2,
      row: 0,
      column: 0,
      firstInstance: 1536,
      instances: 512,
    });
  });

  it('takes the finest level that is resident, not the first that exists', () => {
    const held = new Set(['1:1:0', '3:0:0', '4:0:0']);
    expect(resolveSlot({ row: 3, column: 0 }, 0, context(held))?.level).toBe(1);
  });

  it('falls back monotonically and never names a level that is not resident', () => {
    // Only the coarsest holds this column, which is what pinning it is for.
    const held = new Set(['4:0:1']);
    const draw = resolveSlot({ row: 7, column: 1 }, 0, context(held));
    expect(draw?.level).toBe(4);
    expect(draw?.row).toBe(0);
    expect(draw?.firstInstance).toBe((7 % 16) * (2048 / 16));
    expect(draw?.instances).toBe(128);
  });

  it('gives nothing when no level covering the slot is resident', () => {
    expect(resolveSlot({ row: 3, column: 0 }, 0, context(new Set()))).toBeUndefined();
  });

  it('will not stand a slot on a level more than the cap coarser', () => {
    // Level 3 against a level 0 target is eight to one along the ping axis. It
    // is not low resolution any more, it is a different picture, and drawing
    // it says the data looks like something it does not.
    const held = new Set(['3:0:0']);
    expect(resolveSlot({ row: 3, column: 0 }, 0, context(held))).toBeUndefined();
    expect(
      resolveSlot({ row: 3, column: 0 }, 0, { ...context(held), cap: 3 })?.level,
    ).toBe(3);
  });

  it('exempts the pinned coarsest, whose alternative is an empty panel', () => {
    const held = new Set(['4:0:0']);
    expect(resolveSlot({ row: 3, column: 0 }, 0, context(held))?.level).toBe(4);
  });

  it('clamps the instance range to the pings a short last tile holds', () => {
    // Level 0 holds 40,000 pings, so tile 19 starts at 38,912 and holds 1,088.
    const draw = resolveSlot({ row: 19, column: 0 }, 0, context(new Set(['0:19:0'])));
    expect(draw?.instances).toBe(40000 - 19 * 2048);
  });

  it('skips a level whose range would fall inside a coarse ping', () => {
    // A factor that does not divide the tile cannot give a whole instance
    // range, so the slot passes over it rather than rounding.
    const odd = [1, 3];
    const draw = resolveSlot({ row: 1, column: 0 }, 0, {
      factors: odd,
      tilePings,
      pingsAt: () => 40000,
      resident: (level: number) => level === 1,
    });
    expect(draw).toBeUndefined();
  });
});
