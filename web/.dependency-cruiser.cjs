/**
 * The import rule from Software_Architecture.md section 2: nothing below the
 * shell may import the shell. It is what keeps the view embeddable in a host
 * application that supplies its own chrome.
 *
 * The panel sits between the two: it may use the core, the core may not use
 * it, and it may not use the shell, since it is published and the shell is
 * not.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-shell-below-shell',
      severity: 'error',
      // src/index.ts is in the list because it is the published surface. A
      // shell import reachable from it would put the development page inside
      // every application that embeds this, which is the same failure the rule
      // exists to prevent and the one place it would not otherwise look.
      comment: 'Only shell/ may import shell/.',
      from: { path: '^src/(index\\.ts|(app|compute|data|device|geometry|panel|render)/)' },
      to: { path: '^src/shell/' },
    },
    {
      name: 'no-panel-in-core',
      severity: 'error',
      comment: 'The core draws; only the panel and above may build controls on it.',
      from: { path: '^src/(app|compute|data|device|geometry|render)/' },
      to: { path: '^src/panel/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make load order significant.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
