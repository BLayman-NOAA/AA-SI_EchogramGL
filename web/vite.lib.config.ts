import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The library build, for an application embedding the viewer.
 *
 * Separate from vite.config.ts, which builds the development pages into the
 * Python package. The two produce different things from the same source: that
 * one produces a site, this one produces a module another project imports.
 *
 * ESM only. Every consumer of this is a bundler compiling for a browser that
 * supports WebGPU, and none of them need CommonJS.
 *
 * `zarrita` stays external so the host resolves one copy of it. Bundling it
 * here would put a second zarr runtime in any application that already reads
 * zarr, which is most of the ones likely to want this.
 *
 * The decode worker is not an entry. `new URL(..., import.meta.url)` resolves
 * against the build that compiles it, so a worker emitted here would be looked
 * for at a path that only exists in this project's own output. It is built on
 * its own by vite.worker.config.ts and published as
 * `aa-si-echogram-gl/decode-worker`, which a host spawns by its own URL for it
 * and passes as `spawnWorker`; a host that does not gets main thread decoding,
 * which is slower and correct.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'aa-si-echogram-gl.js',
    },
    rollupOptions: {
      external: ['zarrita'],
    },
  },
});
