import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CanonicalError,
  DOMAINS,
  Ir,
  canonicalize,
  domainPreimage,
  hashRecord,
  irJsonSchema,
  metresToUm,
  notConfiguredProvider,
  sha256Domain,
  sha256Hex,
  type Json,
} from '../src/index.ts';

// A fragment of the IR: relations, not coordinates; integers only.
const FRAGMENT = {
  kensho: 'ir/1',
  world: { bounds_um: [-50000000, 0, -50000000, 50000000, 30000000, 50000000], gravity_um_s2: -9810000 },
  controller: { height_um: 1800000, radius_um: 300000, run_um_s: 6000000, jump_um_s: 5000000 },
  entities: [
    { id: 'table_1', archetype: 'table', box_um: [1600000, 750000, 900000], place: { on: 'floor' } },
    {
      id: 'chest_1',
      archetype: 'chest',
      box_um: [900000, 600000, 550000],
      place: { on: 'table_1' },
      body: 'dynamic',
      asset: { class: 'prop', prompt: 'wooden treasure chest, brass trim' },
    },
    { id: 'spawn', archetype: 'spawn', place: { near: ['table_1', 'medium'] } },
  ],
  objectives: [{ id: 'open_chest', type: 'interact', target: 'chest_1', required: true }],
};

const jsonArb: fc.Arbitrary<Json> = fc.letrec<{ v: Json }>((tie) => ({
  v: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.string({ maxLength: 8 }),
    fc.array(tie('v'), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 6 }), tie('v'), { maxKeys: 4 }),
  ),
})).v;

/** Rebuilds the value with every object's keys in a shuffled order. */
function reorder(v: Json, rnd: () => number): Json {
  if (Array.isArray(v)) return v.map((x) => reorder(x, rnd));
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort(() => rnd() - 0.5);
    const out: { [k: string]: Json } = {};
    for (const k of keys) out[k] = reorder(v[k] as Json, rnd);
    return out;
  }
  return v;
}

describe('canonical JSON', () => {
  it('sorts keys and emits no whitespace', () => {
    expect(canonicalize({ b: 1, a: [2, { d: 'x', c: null }] })).toBe('{"a":[2,{"c":null,"d":"x"}],"b":1}');
  });

  it('throws on a float, at the offending path', () => {
    expect(() => canonicalize({ a: { b: [1, 1.5] } })).toThrowError(CanonicalError);
    try {
      canonicalize({ a: { b: [1, 1.5] } });
    } catch (e) {
      expect((e as CanonicalError).code).toBe('FLOAT');
      expect((e as CanonicalError).path).toBe('/a/b/1');
    }
  });

  it.each([NaN, Infinity, -Infinity, -0, 2 ** 60])('refuses non-integer or unsafe number %s', (n) => {
    expect(() => canonicalize({ n })).toThrowError(CanonicalError);
  });

  it('refuses undefined, cycles and non-plain objects', () => {
    expect(() => canonicalize({ a: undefined })).toThrowError(CanonicalError);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalize(cyc)).toThrowError(CanonicalError);
    expect(() => canonicalize({ d: new Date(0) })).toThrowError(CanonicalError);
  });

  it('property: canon is idempotent through a parse round-trip', () => {
    fc.assert(
      fc.property(jsonArb, (v) => {
        const once = canonicalize(v);
        expect(canonicalize(JSON.parse(once))).toBe(once);
      }),
    );
  });

  it('property: key order never changes the canonical form or the hash', () => {
    fc.assert(
      fc.property(jsonArb, fc.integer(), (v, seed) => {
        let s = seed >>> 0;
        const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
        const shuffled = reorder(v, rnd);
        expect(canonicalize(shuffled)).toBe(canonicalize(v));
        expect(hashRecord(DOMAINS.ir, shuffled)).toBe(hashRecord(DOMAINS.ir, v));
      }),
    );
  });

  it('property: distinct values hash differently (no collisions on small domains)', () => {
    fc.assert(
      fc.property(jsonArb, jsonArb, (a, b) => {
        if (canonicalize(a) !== canonicalize(b)) expect(hashRecord(DOMAINS.ir, a)).not.toBe(hashRecord(DOMAINS.ir, b));
      }),
    );
  });
});

describe('domain-prefixed hashing', () => {
  it('is SHA-256 over domain, a zero byte, then the bytes', () => {
    const bytes = new TextEncoder().encode('abc');
    const pre = domainPreimage('kensho-bundle-v1', bytes);
    expect([...pre.subarray(0, 16)]).toEqual([...Buffer.from('kensho-bundle-v1')]);
    expect(pre[16]).toBe(0);
    expect(sha256Domain('kensho-bundle-v1', bytes)).toBe(sha256Hex(pre));
  });

  it('separates domains', () => {
    const rec = { a: 1 };
    expect(hashRecord(DOMAINS.ir, rec)).not.toBe(hashRecord(DOMAINS.bundle, rec));
  });

  it('matches a known SHA-256 vector for the empty input', () => {
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('quantisation', () => {
  it('maps metres to integer micrometres without negative zero', () => {
    expect(metresToUm(1.8)).toBe(1_800_000);
    expect(Object.is(metresToUm(-0.0000001), 0)).toBe(true);
  });
});

describe('IR schema', () => {
  it('parses the IR fragment and hashes it', () => {
    const parsed = Ir.parse(FRAGMENT);
    expect(parsed.entities).toHaveLength(3);
    expect(hashRecord(DOMAINS.ir, parsed)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a float length, an unknown field and a bad id', () => {
    expect(() => Ir.parse({ ...FRAGMENT, controller: { ...FRAGMENT.controller, height_um: 1.5 } })).toThrow();
    expect(() => Ir.parse({ ...FRAGMENT, extra: 1 })).toThrow();
    expect(() => Ir.parse({ ...FRAGMENT, entities: [{ id: 'Bad Id', archetype: 'x' }] })).toThrow();
  });

  it('exports a JSON Schema', () => {
    const schema = irJsonSchema() as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toContain('entities');
  });
});

describe('provider stubs', () => {
  it('throw NOT_CONFIGURED from every method', async () => {
    const p = notConfiguredProvider('x/0');
    const req = { params: {}, prompt: '', assetClass: 'prop' as const, seed: 0 };
    await expect(p.submit(req)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(p.poll({ providerId: 'x/0', key: 'k' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(p.fetch({ providerId: 'x/0', key: 'k' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});
