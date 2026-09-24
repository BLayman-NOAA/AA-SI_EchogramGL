import { defineConfig } from 'vitest/config';

// The store is served by `aa-echogram serve` and proxied here, so the browser
// sees one origin and CORS never enters development.
const storeOrigin = process.env.ECHOGRAM_STORE_ORIGIN ?? 'http://127.0.0.1:8000';

export default defineConfig({
  build: {
    outDir: '../src/aa_si_echogram_gl/static',
    emptyOutDir: true,
    // Two pages. view.html is the panel a split opens, and it is a separate
    // entry rather than a route inside index.html so that a plain static file
    // server needs no routing rules to serve it.
    rollupOptions: {
      input: {
        main: './index.html',
        view: './view.html',
      },
    },
  },
  server: {
    proxy: {
      '/store': { target: storeOrigin },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // wgsl_reflect ships a CommonJS main under "type": "module", so node
    // cannot load it. Inlining routes it through vite, which takes the module
    // build instead.
    server: { deps: { inline: ['wgsl_reflect'] } },
  },
});
