import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** SHA-256 of the raw public key, hex. */
  keyId: string;
}

export const keyIdOf = (publicKey: KeyObject): string =>
  createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

/** A fresh Ed25519 pair from node:crypto. Nothing is written anywhere. */
export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
}

/**
 * Loads the dev signing key from `dir`, generating it at runtime when absent. Callers pass a gitignored
 * folder: keys are never committed.
 */
export function loadOrCreateDevKeys(dir: string): KeyPair {
  const priv = join(dir, 'gate.key.pem');
  const pub = join(dir, 'gate.pub.pem');
  if (existsSync(priv) && existsSync(pub)) {
    const privateKey = createPrivateKey(readFileSync(priv));
    const publicKey = createPublicKey(readFileSync(pub));
    return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
  }
  mkdirSync(dir, { recursive: true });
  const pair = generateKeyPair();
  writeFileSync(priv, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(pub, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  return pair;
}
