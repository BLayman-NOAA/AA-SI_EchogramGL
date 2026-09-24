/**
 * Render bundle recording and invalidation.
 *
 * A tiled level is one draw per tile, and at a leg scale that is hundreds of
 * draws for a picture that does not change between frames. A render bundle
 * records those calls once and replays them, so panning costs one uniform write
 * and a replay rather than rebuilding the command stream every frame.
 *
 * What a bundle captures is the calls, not the contents of what they point at.
 * Writing new numbers into a bound buffer needs no re-recording, which is why
 * a limits change or a pan is free and only a change to the set of tiles, or to
 * a bind group inside it, costs anything.
 */

export interface BundleSource {
  createRenderBundleEncoder(
    descriptor: GPURenderBundleEncoderDescriptor,
  ): GPURenderBundleEncoder;
}

export class BundleCache {
  private current?: { key: string; bundle: GPURenderBundle };
  private count = 0;

  constructor(
    private device: BundleSource,
    private descriptor: GPURenderBundleEncoderDescriptor,
  ) {}

  /** How many times a bundle has actually been recorded. */
  get recordings(): number {
    return this.count;
  }

  /**
   * The bundle for `key`, recording it if the key has changed.
   *
   * The key has to name everything the recorded calls depend on, which is the
   * tiles drawn and the identity of each one's bind group, not just how many
   * there are.
   */
  bundle(
    key: string,
    record: (encoder: GPURenderBundleEncoder) => void,
  ): GPURenderBundle {
    if (this.current?.key === key) return this.current.bundle;
    const encoder = this.device.createRenderBundleEncoder(this.descriptor);
    record(encoder);
    const bundle = encoder.finish();
    this.current = { key, bundle };
    this.count += 1;
    return bundle;
  }

  invalidate() {
    this.current = undefined;
  }
}
