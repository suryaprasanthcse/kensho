/** JSON values that may appear in a hashed record. Numbers must be safe integers. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class CanonicalError extends Error {
  readonly code: 'FLOAT' | 'NEGATIVE_ZERO' | 'UNSAFE_INTEGER' | 'UNSUPPORTED' | 'CYCLE';
  readonly path: string;
  constructor(code: CanonicalError['code'], path: string, detail: string) {
    super(`canonical JSON: ${code} at ${path === '' ? '(root)' : path}: ${detail}`);
    this.name = 'CanonicalError';
    this.code = code;
    this.path = path;
  }
}

const escapePointerToken = (t: string) => t.replace(/~/g, '~0').replace(/\//g, '~1');

function encode(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number': {
      if (Object.is(value, -0)) throw new CanonicalError('NEGATIVE_ZERO', path, '-0');
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new CanonicalError('FLOAT', path, `${value} is not an integer; quantise to um, ppm or bytes`);
      }
      if (!Number.isSafeInteger(value)) throw new CanonicalError('UNSAFE_INTEGER', path, `${value}`);
      return String(value);
    }
    case 'object': {
      if (stack.has(value)) throw new CanonicalError('CYCLE', path, 'cyclic structure');
      stack.add(value);
      try {
        if (Array.isArray(value)) {
          const parts = value.map((v, i) => encode(v, `${path}/${i}`, stack));
          return `[${parts.join(',')}]`;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          throw new CanonicalError('UNSUPPORTED', path, 'only plain objects are allowed');
        }
        const keys = Object.keys(value).sort();
        const parts: string[] = [];
        for (const k of keys) {
          const v = (value as Record<string, unknown>)[k];
          if (v === undefined) throw new CanonicalError('UNSUPPORTED', `${path}/${escapePointerToken(k)}`, 'undefined');
          parts.push(`${JSON.stringify(k)}:${encode(v, `${path}/${escapePointerToken(k)}`, stack)}`);
        }
        return `{${parts.join(',')}}`;
      } finally {
        stack.delete(value);
      }
    }
    default:
      throw new CanonicalError('UNSUPPORTED', path, typeof value);
  }
}

/** Canonical JSON: sorted keys, no whitespace, integers only. A float anywhere throws. */
export function canonicalize(value: unknown): string {
  return encode(value, '', new Set());
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
