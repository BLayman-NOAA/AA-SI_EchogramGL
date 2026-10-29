import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The decode worker as a built file, published beside the library.
 *
 * A host cannot build the worker from source, since the package exports only
 * its entry points, so this builds it here into one self contained module:
 * `zarrita` and its codecs are bundled rather than external, because a worker
 * cannot share the host's copy, and dynamic imports are inlined, because a host
 * that copies the file as an asset copies that file alone.
 *
 * Runs after the library build, into the same `dist`, which it leaves as it is.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/data/decodeWorker.ts'),
      formats: ['es'],
      fileName: () => 'decode-worker.js',
    },
    rolldownOptions: {
      output: { codeSplitting: false },
    },
  },
});
