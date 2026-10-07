/**
 * Run at most once per frame.
 *
 * A dragged slider and a held spinner arrow both fire far faster than a frame.
 * Acting on every event queues work the next event has already made stale, and
 * on a control that reopens a store that is what makes a drag stutter instead
 * of following the pointer.
 *
 * Each scheduler holds its own pending frame, so two controls dragged at once
 * do not swallow each other.
 */

export function perFrame(run: () => void): () => void {
  let pending = 0;
  return () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      run();
    });
  };
}
