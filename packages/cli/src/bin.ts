import { main } from './main.ts';

const code = await main(process.argv.slice(2), {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
});
// let stdout drain before exiting
process.exitCode = code;
