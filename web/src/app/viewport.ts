/**
 * Viewport state: two scales and a policy relating them.
 *
 * The viewport carries an x range and a y range in data units, not a single
 * zoom factor, because zooming an echogram is not one operation. Free lets the
 * two move independently. Locked holds a vertical exaggeration and derives one
 * from the other. True scale is the lock at an exaggeration of one, which is
 * only meaningful where x is in metres.
 */

export type AspectMode = 'free' | 'locked';

export interface Panel {
  /** Device pixels. */
  width: number;
  height: number;
}

export type Range = [number, number];

export interface ViewportOptions {
  x: Range;
  y: Range;
  panel: Panel;
  mode?: AspectMode;
  exaggeration?: number;
}

export class Viewport {
  private xRange: Range;
  private yRange: Range;
  private panelSize: Panel;
  private aspectMode: AspectMode;
  private factor: number;

  constructor(options: ViewportOptions) {
    this.xRange = [...options.x];
    this.yRange = [...options.y];
    this.panelSize = { ...options.panel };
    this.aspectMode = options.mode ?? 'free';
    this.factor = options.exaggeration ?? 1;
    if (this.aspectMode === 'locked') this.deriveY();
  }

  get x(): Range {
    return [...this.xRange];
  }

  get y(): Range {
    return [...this.yRange];
  }

  get panel(): Panel {
    return { ...this.panelSize };
  }

  get mode(): AspectMode {
    return this.aspectMode;
  }

  /** Pixels per y unit divided by pixels per x unit. One is true scale. */
  get exaggeration(): number {
    return this.aspectMode === 'locked' ? this.factor : this.currentExaggeration();
  }

  get xPerPixel(): number {
    return span(this.xRange) / this.panelSize.width;
  }

  get yPerPixel(): number {
    return span(this.yRange) / this.panelSize.height;
  }

  /**
   * Set the horizontal range. Under a lock the vertical span follows, from the
   * top of the view down, because the axis the caller named is the one to
   * honour and naming it is not a request to move the other one.
   */
  setX(range: Range) {
    this.xRange = [...range];
    if (this.aspectMode === 'locked') this.deriveY();
  }

  /** Set the vertical range. Under a lock the horizontal span follows. */
  setY(range: Range) {
    this.yRange = [...range];
    if (this.aspectMode === 'locked') this.deriveX();
  }

  /**
   * Set both ranges at once and adopt whatever factor they imply.
   *
   * There are two kinds of change. Reshaping sets one range and derives the
   * other, which is what a bounds entry, the factor and a policy switch do.
   * Re-expressing puts the same picture in different coordinates, which is what
   * a unit change, a level change and fitting the extent do, and there deriving
   * is wrong: it would hold a factor whose meaning came from the coordinates
   * being replaced, and move the picture in the act of relabelling it.
   */
  reframe(x: Range, y: Range) {
    this.xRange = [...x];
    this.yRange = [...y];
    if (this.aspectMode === 'locked') this.factor = this.currentExaggeration();
  }

  setPanel(panel: Panel) {
    this.panelSize = { ...panel };
    if (this.aspectMode === 'locked') this.deriveY();
  }

  /**
   * Change the aspect policy.
   *
   * The horizontal range is held and the column expands or collapses, per
   * FR-74: the user is looking at a stretch of survey, not at a depth range.
   */
  setMode(mode: AspectMode, exaggeration?: number) {
    if (exaggeration !== undefined) this.setFactor(exaggeration);
    this.aspectMode = mode;
    if (mode === 'locked') this.deriveY();
  }

  /**
   * Adjust the factor, holding one axis and deriving the other.
   *
   * Dragging the factor shapes the picture around the water column, so the
   * default holds the vertical and the horizontal squashes or stretches, which
   * is what an exaggeration control is for. A preset such as true scale is
   * closer to a policy change and holds the horizontal instead, per FR-74, so
   * the stretch of survey being studied survives it.
   */
  setExaggeration(exaggeration: number, hold: 'x' | 'y' = 'y') {
    this.setFactor(exaggeration);
    if (this.aspectMode !== 'locked') return;
    if (hold === 'y') this.deriveX();
    else this.deriveY();
  }

  /** Lock at true scale, where a metre of depth draws like a metre of track. */
  lockTrueScale() {
    this.setMode('locked', 1);
  }

  /** Pan by a pixel offset, leaving both spans and the policy alone. */
  panBy(dxPixels: number, dyPixels: number) {
    const dx = dxPixels * this.xPerPixel;
    const dy = dyPixels * this.yPerPixel;
    this.xRange = [this.xRange[0] + dx, this.xRange[1] + dx];
    this.yRange = [this.yRange[0] + dy, this.yRange[1] + dy];
  }

  /**
   * Zoom the horizontal about a fraction of the panel width. Under a lock the
   * vertical follows, which is what makes the lock a property of the viewport
   * rather than something interaction has to remember.
   */
  zoomX(scale: number, anchor = 0.5) {
    this.xRange = scaleAbout(this.xRange, scale, anchor);
    // The point under the pointer should stay under it on both axes, which
    // needs a fraction per axis rather than one shared with the zoom. Until
    // interaction supplies it, a zoom keeps the middle.
    if (this.aspectMode === 'locked') this.deriveY(MIDDLE);
  }

  zoomY(scale: number, anchor = 0.5) {
    this.yRange = scaleAbout(this.yRange, scale, anchor);
    if (this.aspectMode === 'locked') this.deriveX();
  }

  /**
   * Zoom about a point on the panel, given as fractions across and down.
   *
   * Under a lock the vertical is derived rather than scaled, and holding it at
   * the pointer's own fraction is what keeps the point under the pointer under
   * it on both axes.
   */
  zoomAt(scale: number, across = MIDDLE, down = MIDDLE) {
    this.xRange = scaleAbout(this.xRange, scale, across);
    if (this.aspectMode === 'locked') this.deriveY(down);
    else this.yRange = scaleAbout(this.yRange, scale, down);
  }

  /**
   * Nudge the view back until it still shows some of the data.
   *
   * Panning is otherwise unbounded, and an echogram lost off an edge leaves no
   * way back but a fit. This is a translation, so both spans and the
   * exaggeration survive it, which is what makes it safe under a lock.
   */
  clampInto(x: Range, y: Range, keep = KEEP) {
    this.xRange = nudge(this.xRange, x, keep);
    this.yRange = nudge(this.yRange, y, keep);
  }

  /**
   * Column height in pixels if the whole of it were shown at the current
   * scales. Below a readable height a locked true scale view is telling the
   * user to switch, per Software_Architecture.md section 5.8.
   */
  columnPixels(extent: Range): number {
    return span(extent) / this.yPerPixel;
  }

  private currentExaggeration(): number {
    const perX = this.panelSize.width / span(this.xRange);
    const perY = this.panelSize.height / span(this.yRange);
    return perY / perX;
  }

  private setFactor(exaggeration: number) {
    if (!(exaggeration > 0) || !Number.isFinite(exaggeration)) {
      throw new Error(`exaggeration must be a positive number, got ${exaggeration}`);
    }
    this.factor = exaggeration;
  }

  /**
   * Change the vertical span, holding the top of the view.
   *
   * Depth is measured from a datum, so the top of the picture is the reference
   * a reader works from, and a column that has just grown would otherwise be
   * centred into showing water above the surface.
   */
  private deriveY(hold = TOP) {
    const height =
      (this.panelSize.height * span(this.xRange)) /
      (this.factor * this.panelSize.width);
    this.yRange = respan(this.yRange, height, hold);
  }

  /**
   * Change the horizontal span, holding the middle of the view.
   *
   * There is no datum along the track, so nothing makes an edge the natural
   * thing to hold, and holding one slides the picture sideways: widening from
   * the left edge walks the data off to the left and leaves the middle of the
   * view out past the end of it, where the next zoom is then centred.
   */
  private deriveX(hold = MIDDLE) {
    const width =
      (this.factor * this.panelSize.width * span(this.yRange)) /
      this.panelSize.height;
    this.xRange = respan(this.xRange, width, hold);
  }
}

/**
 * A view opens free and fitting the whole extent, which is FR-73 satisfied by
 * construction rather than by a clamp.
 *
 * `calculate_panel_geometry` clamps the panel aspect because it sizes the
 * figure from the data, so a wide shallow survey would produce a sliver of a
 * panel. Here the panel is the canvas and is given, so fitting the extent fills
 * it whatever shape the data is, and the failure the clamp guards against
 * cannot arise. The exaggeration that produces is reported rather than chosen,
 * so switching to a lock starts from the shape already on screen.
 */
export function fitAll(x: Range, y: Range, panel: Panel): Viewport {
  return new Viewport({ x, y, panel, mode: 'free' });
}

function span(range: Range): number {
  const width = Math.abs(range[1] - range[0]);
  return width > 0 ? width : 1;
}

/** Where along a derived range the data stays put, as a fraction of the panel. */
const TOP = 0;
const MIDDLE = 0.5;

/** Least of the view a pan has to leave over the data. */
const KEEP = 0.25;

function nudge(range: Range, bounds: Range, keep: number): Range {
  const width = range[1] - range[0];
  const margin = Math.min(width, bounds[1] - bounds[0]) * Math.min(keep, 0.5);
  const first = Math.min(
    Math.max(range[0], bounds[0] - width + margin),
    bounds[1] - margin,
  );
  return [first, first + width];
}

function respan(range: Range, width: number, hold: number): Range {
  const fixed = range[0] + (range[1] - range[0]) * hold;
  return [fixed - width * hold, fixed + width * (1 - hold)];
}

function scaleAbout(range: Range, scale: number, anchor: number): Range {
  const fixed = range[0] + (range[1] - range[0]) * anchor;
  return [
    fixed + (range[0] - fixed) * scale,
    fixed + (range[1] - fixed) * scale,
  ];
}
