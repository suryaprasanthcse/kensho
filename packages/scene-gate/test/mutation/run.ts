import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CHECKS } from '../../src/check.ts';

/**
 * Mutation check: disable each check in turn (its module is aliased to a no-op) and run the whole scene-gate suite.
 * A check is "killed" when the suite then fails and "survives" when it still passes, which would mean no test needs
 * that check. The unmutated suite must pass first, or a failure would prove nothing.
 */
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const config = resolve(import.meta.dirname, 'vitest.config.ts');
const repoRoot = resolve(import.meta.dirname, '../../../..');

interface Outcome {
  readonly total: number;
  readonly failed: number;
  readonly failing: string[];
}

function runSuite(mutant: string | null): Outcome {
  const dir = mkdtempSync(join(tmpdir(), 'scene-gate-mutation-'));
  const outputFile = join(dir, 'result.json');
  try {
    const env = { ...process.env };
    delete env.SCENE_GATE_MUTANT;
    if (mutant) env.SCENE_GATE_MUTANT = mutant;
    spawnSync(process.execPath, [vitest, 'run', '--config', config, '--root', repoRoot, '--reporter=json', `--outputFile=${outputFile}`], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const result = JSON.parse(readFileSync(outputFile, 'utf8')) as {
      numTotalTests: number;
      numFailedTests: number;
      testResults: { assertionResults: { status: string; fullName: string }[] }[];
    };
    const failing = result.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName));
    return { total: result.numTotalTests, failed: result.numFailedTests, failing };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const baseline = runSuite(null);
if (baseline.failed > 0 || baseline.total === 0) {
  console.error(`baseline suite is not green (${baseline.failed} failed of ${baseline.total}); a mutation run would prove nothing`);
  process.exit(2);
}
console.log(`baseline: ${baseline.total} tests pass\n`);

const survivors: string[] = [];
const rows: { code: string; killed: boolean; failed: number }[] = [];
for (const entry of CHECKS) {
  const outcome = runSuite(entry.file);
  if (outcome.total !== baseline.total) {
    // A suite that cannot load reports no tests at all. That is a broken harness, not a killed mutant.
    console.error(`mutant ${entry.file}: ran ${outcome.total} tests, the baseline ran ${baseline.total}; the suite did not load cleanly`);
    process.exit(2);
  }
  const killed = outcome.failed > 0;
  rows.push({ code: entry.code, killed, failed: outcome.failed });
  if (!killed) survivors.push(entry.code);
  console.log(`${killed ? 'killed  ' : 'SURVIVED'}  ${entry.code.padEnd(20)} ${outcome.failed} of ${outcome.total} tests fail`);
  for (const name of outcome.failing.slice(0, 3)) console.log(`            - ${name}`);
}

console.log(`\n${rows.length - survivors.length} of ${rows.length} checks killed${survivors.length ? `; surviving: ${survivors.join(', ')}` : ''}`);
process.exitCode = survivors.length ? 1 : 0;
