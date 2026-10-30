import { createHash } from 'node:crypto';
import { canonicalBytes } from './canonical.ts';

/** Domain prefixes. Every hashed record type has its own, so hashes cannot be confused across types. */
export const DOMAINS = {
  ir: 'kensho-ir-v1',
  bundle: 'kensho-bundle-v1',
  verdict: 'kensho-verdict-v1',
} as const;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The exact preimage `domain ‖ 0x00 ‖ bytes`. */
export function domainPreimage(domain: string, bytes: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(domain, 'utf8'), Buffer.from([0]), bytes]);
}

/** SHA-256 over `domain ‖ 0x00 ‖ bytes`. */
export function sha256Domain(domain: string, bytes: Uint8Array): string {
  return sha256Hex(domainPreimage(domain, bytes));
}

/** Hash of a JSON record: SHA-256 over `domain ‖ 0x00 ‖ canonical bytes`. Throws on any float. */
export function hashRecord(domain: string, record: unknown): string {
  return sha256Domain(domain, canonicalBytes(record));
}
