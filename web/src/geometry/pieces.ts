/**
 * Which of many datasets laid side by side in time to load.
 *
 * A step mapped over raw files leaves one dataset per file, possibly
 * thousands, and none of them has coarser levels to stand in for it. So the
 * question a pyramid answers with a level, these answer with a selection:
 * the pieces nearest the centre of the view first, then the ones just beyond
 * either edge, for as long as they fit a budget. A piece in view that does
 * not fit is counted, so the view can say how much it is not showing.
 *
 * Two budgets, because the two costs differ by kind. Texture bytes are what
 * the GPU holds once a piece is drawn. Transfer bytes are what the link has to
 * carry, which for Sv at full resolution is the larger of the two and the one
 * that makes a wide window of Sv slow long before it runs out of memory.
 */

import type { Extent } from './coords';

export interface PieceExtent {
  /** Where the piece sits on the x axis. */
  x: Extent;
  /** Texture bytes the piece takes for the channels being drawn. */
  texture: number;
  /** Bytes fetched to draw it, compressed. */
  transfer: number;
}

export interface PieceBudget {
  texture: number;
  transfer: number;
  /** Most pieces held open at once, whatever they cost. */
  count: number;
}

export interface PieceChoice {
  /** Indices into the pieces, nearest the centre first. */
  chosen: number[];
  /** Pieces in view left out because the budget ran out. */
  deferred: number;
}

/** View widths beyond each edge worth loading ahead. */
export const DEFAULT_REACH = 1;

function centre(extent: Extent): number {
  return (extent[0] + extent[1]) / 2;
}

function overlaps(a: Extent, b: Extent): boolean {
  return a[1] >= b[0] && a[0] <= b[1];
}

/**
 * Choose the pieces to hold for a view.
 *
 * Every piece in view is ranked ahead of every piece beyond it, then both by
 * distance from the centre, so a narrow budget fills the middle of the screen
 * first and the edges last. The first piece in view is always chosen: a view
 * that loads nothing at all is never the right answer.
 */
export function choosePieces(
  pieces: PieceExtent[],
  view: Extent,
  budget: PieceBudget,
  reach = DEFAULT_REACH,
): PieceChoice {
  const width = view[1] - view[0];
  const around: Extent = [view[0] - reach * width, view[1] + reach * width];
  const middle = centre(view);
  const distance = (index: number) => Math.abs(centre(pieces[index].x) - middle);

  const visible: number[] = [];
  const nearby: number[] = [];
  pieces.forEach((piece, index) => {
    if (overlaps(piece.x, view)) visible.push(index);
    else if (overlaps(piece.x, around)) nearby.push(index);
  });
  visible.sort((a, b) => distance(a) - distance(b));
  nearby.sort((a, b) => distance(a) - distance(b));

  const chosen: number[] = [];
  let texture = 0;
  let transfer = 0;
  let deferred = 0;
  const fits = (index: number) =>
    chosen.length < budget.count &&
    texture + pieces[index].texture <= budget.texture &&
    transfer + pieces[index].transfer <= budget.transfer;
  const take = (index: number) => {
    chosen.push(index);
    texture += pieces[index].texture;
    transfer += pieces[index].transfer;
  };

  for (const index of visible) {
    if (!chosen.length || fits(index)) take(index);
    else deferred += 1;
  }
  for (const index of nearby) {
    if (!fits(index)) break;
    take(index);
  }
  return { chosen, deferred };
}

/**
 * Where to open a view on these pieces.
 *
 * Centred on the middle of them all, as wide as the pieces nearest that
 * middle that fit the budget, and never narrower than one piece. Opening on
 * the whole would ask for every piece and draw almost none of them.
 */
export function openingExtent(pieces: PieceExtent[], budget: PieceBudget): Extent {
  const whole: Extent = [
    Math.min(...pieces.map((piece) => piece.x[0])),
    Math.max(...pieces.map((piece) => piece.x[1])),
  ];
  const middle = centre(whole);
  const ranked = pieces
    .map((piece, index) => ({ index, distance: Math.abs(centre(piece.x) - middle) }))
    .sort((a, b) => a.distance - b.distance);

  let texture = 0;
  let transfer = 0;
  const chosen: PieceExtent[] = [];
  for (const { index } of ranked) {
    const piece = pieces[index];
    const over =
      chosen.length >= budget.count ||
      texture + piece.texture > budget.texture ||
      transfer + piece.transfer > budget.transfer;
    if (chosen.length && over) break;
    chosen.push(piece);
    texture += piece.texture;
    transfer += piece.transfer;
  }
  return [
    Math.min(...chosen.map((piece) => piece.x[0])),
    Math.max(...chosen.map((piece) => piece.x[1])),
  ];
}
