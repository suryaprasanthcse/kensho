import { buildAssetModel, buildMeshModel, makeIO, parseGlb, primitiveOfTriangle, rawTriangleCount, triangleIsDegenerate } from './model.ts';

export interface PruneResult {
  /** The repaired file, or the input unchanged when nothing was removed or the fix could not be applied. */
  bytes: Uint8Array;
  removed: number;
  /** Degenerate triangles that could not be removed (strips, fans, or a file that cannot be rewritten). */
  unprunable: number;
  inputTriangles: number;
  outputTriangles: number;
  reason?: string;
}

/**
 * Removes the degenerate triangles the gate counts, by rewriting the index buffers of triangle-list
 * primitives. Vertices stay where they are, so the surface the other checks see does not change. Strips and
 * fans cannot be pruned this way and are reported, never silently converted.
 */
export async function pruneDegenerate(bytes: Uint8Array): Promise<PruneResult> {
  const doc = await parseGlb(bytes);
  const model = buildAssetModel(doc);
  let inputTriangles = 0;
  for (const mesh of model.meshes) for (const p of mesh.listPrimitives()) inputTriangles += rawTriangleCount(p);

  let removed = 0;
  let unprunable = 0;
  for (const [mi, mesh] of model.meshes.entries()) {
    const m = buildMeshModel(mesh, mi);
    const flagged = new Map<number, Set<number>>();
    for (let t = 0; t < m.tris.length / 3; t++) {
      if (!triangleIsDegenerate(m, t)) continue;
      const p = primitiveOfTriangle(m, t);
      const set = flagged.get(p) ?? new Set<number>();
      set.add(m.triOrdinal[t]!);
      flagged.set(p, set);
    }
    const prims = mesh.listPrimitives();
    for (const [pi, ordinals] of flagged) {
      const prim = prims[pi]!;
      if (prim.getMode() !== 4) {
        unprunable += ordinals.size;
        continue;
      }
      const old = prim.getIndices();
      const posAcc = prim.getAttribute('POSITION')!;
      const count = old ? old.getCount() : posAcc.getCount();
      const src = old?.getArray();
      const at = (i: number) => (src ? (src[i] as number) : i);
      const kept: number[] = [];
      for (let t = 0; t * 3 + 2 < count; t++) if (!ordinals.has(t)) kept.push(at(t * 3), at(t * 3 + 1), at(t * 3 + 2));
      const fresh = doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(kept)).setBuffer(posAcc.getBuffer());
      prim.setIndices(fresh);
      if (old && old.listParents().every((p) => p.propertyType === 'Root')) old.dispose();
      removed += ordinals.size;
    }
  }
  const unchanged = (reason: string): PruneResult => ({ bytes, removed: 0, unprunable: Math.max(unprunable, 1), inputTriangles, outputTriangles: inputTriangles, reason });
  if (unprunable > 0) return { ...unchanged('some degenerate triangles are in strips or fans'), unprunable };
  if (removed === 0) return { bytes, removed: 0, unprunable: 0, inputTriangles, outputTriangles: inputTriangles };
  try {
    const out = await (await makeIO()).writeBinary(doc);
    return { bytes: out, removed, unprunable: 0, inputTriangles, outputTriangles: inputTriangles - removed };
  } catch (e) {
    return unchanged(`the file cannot be rewritten: ${(e as Error).message.slice(0, 120)}`);
  }
}
