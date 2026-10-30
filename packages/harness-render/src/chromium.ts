import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

/**
 * Makes sure the pinned Playwright's Chromium is present, installing it into the user-level Playwright
 * cache when it is not. Returns true when an install had to run.
 */
export function ensureChromium(): boolean {
  if (existsSync(chromium.executablePath())) return false;
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  if (r.status !== 0 || !existsSync(chromium.executablePath())) throw new Error('could not install Chromium');
  return true;
}
