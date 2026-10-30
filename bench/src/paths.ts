import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GENERATED = join(ROOT, '.generated');
export const ASSET_DIR = join(GENERATED, 'assets');
export const BUNDLE_DIR = join(GENERATED, 'bundles');
export const KEY_DIR = join(ROOT, '.dev-keys');
export const LABELS_PATH = join(ROOT, 'corpus', 'assets', 'labels.json');
export const OUT_DIR = join(ROOT, 'bench', 'out');
