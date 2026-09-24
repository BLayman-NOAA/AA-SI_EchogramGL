/**
 * The import rule from Software_Architecture.md section 2: nothing below the
 * shell may import the shell. It is what keeps the view embeddable in a host
 * application that supplies its own chrome.
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
      from: { path: '^src/(index\\.ts|(app|compute|data|device|geometry|render)/)' },
      to: { path: '^src/shell/' },
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
