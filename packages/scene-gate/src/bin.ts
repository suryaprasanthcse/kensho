import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkTapes, loadPrompts } from './harness.ts';

const USAGE = `usage: scene-gate check-tapes <tapes-dir> [--unreachable-height] [--prompts <prompts.json> --system <system.md>]

Re-checks recorded tapes offline and prints a JSON report. Exit codes: 0 report written, 1 some tape was unusable, 2 usage.`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'unreachable-height': { type: 'boolean', default: false },
      prompts: { type: 'string' },
      system: { type: 'string' },
    },
  });
  const [command, dir] = positionals;
  if (command !== 'check-tapes' || !dir || positionals.length !== 2 || Boolean(values.prompts) !== Boolean(values.system)) {
    console.error(USAGE);
    return 2;
  }
  const report = checkTapes(dir, {
    unreachableHeight: values['unreachable-height'],
    ...(values.prompts && values.system ? { expect: { prompts: loadPrompts(values.prompts), system: readFileSync(values.system, 'utf8') } } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
  return report.summary.errors ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
