import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The import rule from architecture section 2, checked by breaking it.
 *
 * A rule nobody has seen fail is a rule that might not be wired up. This writes
 * a module that imports the shell from below it, runs the real configuration
 * over it, and expects the failure by name. Without the deliberate offence the
 * check passes for two different reasons and only one of them is the rule
 * working.
 *
 * Slower than the other tests, because it starts a process.
 */

const root = join(import.meta.dirname, '..');

function cruise(target: string): { code: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(root, 'node_modules/dependency-cruiser/bin/dependency-cruise.mjs'),
        '--config',
        join(root, '.dependency-cruiser.cjs'),
        target,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout}${failure.stderr}` };
  }
}

describe('the layer rule', () => {
  it('passes over the source as it stands', () => {
    expect(cruise('src').code).toBe(0);
  });

  it('fails when something below the shell imports the shell', () => {
    // app/ may not reach into shell/. That is what keeps the view embeddable in
    // a host application that brings its own chrome, which is the whole reason
    // the rule exists rather than being a matter of taste.
    const offence = join(root, 'src/app/__ruleCheck.ts');
    writeFileSync(
      offence,
      "import { CHANNEL_NAME } from '../shell/channel';\nexport const name = CHANNEL_NAME;\n",
      'utf8',
    );
    try {
      const found = cruise('src');
      expect(found.code).not.toBe(0);
      expect(found.output).toContain('no-shell-below-shell');
    } finally {
      rmSync(offence, { force: true });
    }
  });

  it('fails on a circular import', () => {
    const directory = mkdtempSync(join(tmpdir(), 'layer-rule-'));
    try {
      writeFileSync(join(directory, 'a.ts'), "import './b';\nexport const a = 1;\n", 'utf8');
      writeFileSync(join(directory, 'b.ts'), "import './a';\nexport const b = 1;\n", 'utf8');
      const found = cruise(directory);
      expect(found.code).not.toBe(0);
      expect(found.output).toContain('no-circular');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
