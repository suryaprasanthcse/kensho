import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHECKS, checkScene, evaluateRaw, evaluateValue, type Evaluation } from '../src/check.ts';
import { canonicalJson } from '../src/canonical.ts';
import { diag, sortDiagnostics, type Diagnostic } from '../src/diagnostic.ts';
import { hashDiagnostics, sha256Hex, verdictOf, verdictRecord } from '../src/verdict.ts';
import { E, EXAMPLE_SCENE, cleanScene, edited } from './fixtures.ts';

describe('canonical JSON', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
  });

  it('is the same for any key insertion order', () => {
    expect(canonicalJson({ a: 1, b: 2, c: { x: 1, y: 2 } })).toBe(canonicalJson({ c: { y: 2, x: 1 }, b: 2, a: 1 }));
  });

  it('refuses floating point numbers, which could hash differently on another platform', () => {
    expect(() => canonicalJson({ a: 0.5 })).toThrow(TypeError);
  });

  it('property: key order never changes the output', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 6 }), fc.integer()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(obj));
      }),
    );
  });
});

describe('diagnostic order', () => {
  const d = (code: string, pointer: string, message = 'm'): Diagnostic => diag(code, pointer, message);

  it('sorts by pointer, then by code', () => {
    const sorted = sortDiagnostics([d('Z', '/b'), d('B', '/a'), d('A', '/b'), d('A', '/a')]);
    expect(sorted.map((x) => `${x.pointer} ${x.code}`)).toEqual(['/a A', '/a B', '/b A', '/b Z']);
  });

  it('breaks ties by message, so equal pointers and codes still sort the same way every time', () => {
    const one = sortDiagnostics([d('A', '/a', 'second'), d('A', '/a', 'first')]);
    const two = sortDiagnostics([d('A', '/a', 'first'), d('A', '/a', 'second')]);
    expect(one).toEqual(two);
    expect(one.map((x) => x.message)).toEqual(['first', 'second']);
  });

  it('property: the order never depends on the input order', () => {
    const arb = fc.array(
      fc.record({ code: fc.constantFrom('A', 'B', 'C'), pointer: fc.constantFrom('', '/a', '/a/0', '/b'), message: fc.constantFrom('x', 'y') }),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(arb, fc.integer({ min: 0, max: 1000 }), (items, seed) => {
        const list = items.map((i) => d(i.code, i.pointer, i.message));
        const turn = list.length ? seed % list.length : 0;
        const shuffled = [...list.slice(turn), ...list.slice(0, turn)].reverse();
        expect(sortDiagnostics(shuffled)).toEqual(sortDiagnostics(list));
      }),
    );
  });

  it('rejects an invalid pointer and fractional evidence', () => {
    expect(() => diag('X', 'no-slash', 'm')).toThrow(TypeError);
    expect(() => diag('X', '/ok', 'm', { v: 1.5 })).toThrow(TypeError);
  });
});

describe('the verdict and its hash', () => {
  it('hashes identically on two runs of the same input', () => {
    const text = JSON.stringify(EXAMPLE_SCENE);
    const first = verdictRecord(evaluateRaw(text));
    const second = verdictRecord(evaluateRaw(text));
    expect(first.hash).toBe(second.hash);
    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes identically for every check fixture on two runs', () => {
    const scenes = [cleanScene(), edited((s) => void (s.entities[E.coin2]!.id = 'coin_1')), edited((s) => void (s.spawn.pos_mm = [19800, 0, 0]))];
    for (const scene of scenes) {
      const a = hashDiagnostics(checkScene(structuredClone(scene), { unreachableHeight: true }));
      const b = hashDiagnostics(checkScene(structuredClone(scene), { unreachableHeight: true }));
      expect(a).toBe(b);
    }
  });

  it('does not depend on the key order of the input JSON', () => {
    const a = evaluateRaw(JSON.stringify(EXAMPLE_SCENE));
    const reordered = Object.fromEntries(Object.entries(EXAMPLE_SCENE).reverse());
    const b = evaluateRaw(JSON.stringify(reordered));
    expect(verdictRecord(b).hash).toBe(verdictRecord(a).hash);
  });

  it('does not depend on the order in which the checks run', () => {
    const scene = edited((s) => {
      s.entities[E.coin2]!.id = 'coin_1';
      s.objectives[0] = { id: 'o1', type: 'collect', tag: 'coin', count: 5 };
    });
    const forward = CHECKS.flatMap((c) => c.run(scene));
    const backward = [...CHECKS].reverse().flatMap((c) => c.run(scene));
    expect(hashDiagnostics(sortDiagnostics(backward))).toBe(hashDiagnostics(sortDiagnostics(forward)));
  });

  it('changes when a diagnostic changes', () => {
    const base = verdictRecord(evaluateValue(EXAMPLE_SCENE)).hash;
    const other = verdictRecord(evaluateValue({ ...EXAMPLE_SCENE, objectives: [{ id: 'o1', type: 'collect', tag: 'coin', count: 11 }] })).hash;
    expect(other).not.toBe(base);
  });

  it('is the SHA-256 of the canonical JSON of the diagnostics', () => {
    const e = evaluateValue(EXAMPLE_SCENE);
    expect(hashDiagnostics(e.diagnostics)).toBe(sha256Hex(canonicalJson(e.diagnostics)));
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashDiagnostics([])).toBe(sha256Hex('[]'));
  });

  it('gives pass, fail and schema_invalid', () => {
    expect(verdictOf(evaluateValue(cleanScene()))).toBe('pass');
    expect(verdictOf(evaluateValue(EXAMPLE_SCENE))).toBe('fail');
    expect(verdictOf(evaluateRaw('nope'))).toBe('schema_invalid');
  });

  it('passes a scene whose only findings are warnings', () => {
    const warned: Evaluation = { kind: 'checked', scene: cleanScene(), diagnostics: [diag('DUPLICATE_ID', '/entities/0/id', 'm', {}, 'warning')] };
    expect(verdictOf(warned)).toBe('pass');
    expect(verdictRecord(warned).codes).toEqual([]);
  });

  it('lists distinct error codes sorted', () => {
    expect(verdictRecord(evaluateValue(EXAMPLE_SCENE)).codes).toEqual(['OBJECTIVE_COUNT', 'UNRESOLVED_REF']);
  });
});
