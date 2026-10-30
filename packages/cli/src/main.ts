import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { EXIT_CODES, exitCodeFor } from '@kensho/diagnostics';
import { DEFAULT_TIMEOUT_MS, runAssetGate, type AssetClass, type Body, type Tier } from '@kensho/gates-asset';

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `usage:
  kensho asset-gate <file.glb> --tier mobile|desktop [--class hero|prop|background] [--body dynamic|static]
                    [--box-um x,y,z] [--timeout-ms n]
  kensho smoke <bundle-dir> --tier mobile|desktop [--timeout-ms n]

exit codes: 0 PASS, 1 FAIL, 2 ABSTAIN, 3 usage`;

class UsageError extends Error {}

const oneOf = <T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback?: T): T => {
  const v = value ?? fallback;
  if (v === undefined) throw new UsageError(`--${name} is required (${allowed.join('|')})`);
  if (!allowed.includes(v as T)) throw new UsageError(`--${name} must be one of ${allowed.join('|')}, got "${v}"`);
  return v as T;
};

const positiveInt = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`--${name} must be a positive integer, got "${value}"`);
  return Number(value);
};

function parseBox(value: string | undefined): [number, number, number] | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(',');
  if (parts.length !== 3 || !parts.every((p) => /^[1-9]\d*$/.test(p))) {
    throw new UsageError(`--box-um must be three positive integers in micrometres, like 1600000,750000,900000; got "${value}"`);
  }
  return parts.map(Number) as [number, number, number];
}

/** Runs the command line and returns the exit code. Output goes through `io` so tests can capture it. */
export async function main(argv: string[], io: Io, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === 'asset-gate') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          tier: { type: 'string' },
          class: { type: 'string' },
          body: { type: 'string' },
          'box-um': { type: 'string' },
          'timeout-ms': { type: 'string' },
        },
      });
      if (positionals.length !== 1) throw new UsageError('asset-gate takes exactly one <file.glb>');
      const tier = oneOf<Tier>('tier', values.tier, ['mobile', 'desktop']);
      const assetClass = oneOf<AssetClass>('class', values.class, ['hero', 'prop', 'background'], 'prop');
      const body = oneOf<Body>('body', values.body, ['dynamic', 'static'], 'dynamic');
      const boxUm = parseBox(values['box-um']);
      const timeoutMs = positiveInt('timeout-ms', values['timeout-ms'], DEFAULT_TIMEOUT_MS);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(positionals[0]!));
      } catch (e) {
        throw new UsageError(`cannot read ${positionals[0]}: ${(e as Error).message}`);
      }
      const report = await runAssetGate(bytes, { tier, assetClass, body, ...(boxUm ? { boxUm } : {}) }, { timeoutMs });
      io.stdout(JSON.stringify(report, null, 2) + '\n');
      return exitCodeFor(report.verdict);
    }
    if (command === 'smoke') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { tier: { type: 'string' }, 'timeout-ms': { type: 'string' } },
      });
      if (positionals.length !== 1) throw new UsageError('smoke takes exactly one <bundle-dir>');
      const tier = oneOf<Tier>('tier', values.tier, ['mobile', 'desktop']);
      const timeoutMs = positiveInt('timeout-ms', values['timeout-ms'], 60_000);
      // test-only: KENSHO_TEST_HOOKS makes a probe fire on purpose; the hooks are recorded in the report
      const hooks = (env.KENSHO_TEST_HOOKS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
      const { runSmoke, SMOKE_HOOKS } = await import('@kensho/harness-render');
      for (const h of hooks) {
        if (!(SMOKE_HOOKS as readonly string[]).includes(h)) throw new UsageError(`unknown test hook "${h}"`);
      }
      const report = await runSmoke(positionals[0]!, { tier, timeoutMs, hooks, ...(env.KENSHO_KEY_DIR ? { keyDir: env.KENSHO_KEY_DIR } : {}) });
      io.stdout(JSON.stringify(report, null, 2) + '\n');
      return exitCodeFor(report.verdict);
    }
    throw new UsageError(command ? `unknown command "${command}"` : 'no command given');
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || (e as { code?: string }).code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      io.stderr(`kensho: ${(e as Error).message}\n${USAGE}\n`);
      return EXIT_CODES.USAGE;
    }
    // fail closed: a crash in the tool is not a pass
    io.stderr(`kensho: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return EXIT_CODES.ABSTAIN;
  }
}
