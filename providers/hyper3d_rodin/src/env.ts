import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export const API_KEY_VAR = 'HYPER3D_API_KEY';

/**
 * Finds the API key. `process.env` wins, so Node's `--env-file=.env` works unchanged; when the variable is
 * absent or empty there, an explicit env file is parsed (never loaded into process.env, never logged).
 * An empty value counts as "not configured".
 */
export function resolveApiKey(opts: { env?: NodeJS.ProcessEnv; envFile?: string } = {}): string | undefined {
  const env = opts.env ?? process.env;
  const fromEnv = env[API_KEY_VAR]?.trim();
  if (fromEnv) return fromEnv;
  if (opts.envFile && existsSync(opts.envFile)) {
    const parsed = parseEnv(readFileSync(opts.envFile, 'utf8'));
    const fromFile = parsed[API_KEY_VAR]?.trim();
    if (fromFile) return fromFile;
  }
  return undefined;
}

/** Removes any occurrence of the key from text that is about to be logged or thrown. */
export const redact = (text: string, key: string | undefined): string => (key ? text.split(key).join('[redacted]') : text);
