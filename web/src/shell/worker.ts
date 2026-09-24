/**
 * Where the decode worker's URL is resolved.
 *
 * In the shell, because that is what it is: a fact about this project's build,
 * not about the viewer. `new URL(..., import.meta.url)` is rewritten by the
 * bundler compiling the file it appears in, so this line is correct exactly
 * here and nowhere else. An application embedding the library writes its own
 * and passes it as `spawnWorker`.
 *
 * Keeping it out of `data/` also keeps the worker, and the blosc and zstd
 * decompressors it carries, out of the library bundle. They are over a
 * megabyte, and a host that builds its own worker cannot use this copy of them.
 */

import type { WorkerLike } from '../data/decode';

export function spawnDecodeWorker(): WorkerLike {
  return new Worker(new URL('../data/decodeWorker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}
