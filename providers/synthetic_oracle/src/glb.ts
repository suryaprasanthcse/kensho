import { Document, NodeIO } from '@gltf-transform/core';
import type { Geometry } from './geometry.ts';
import { solidPng } from './png.ts';

export interface TextureSpec {
  width: number;
  height: number;
  rgb: [number, number, number];
}

export interface MaterialSpec {
  color: [number, number, number];
  /** Extra textures beyond the base colour map, to build texture-memory pressure. */
  baseTexture?: TextureSpec;
  extraTextures?: TextureSpec[];
}

export interface PartSpec {
  geometry: Geometry;
  material: number;
}

export interface NodeSpec {
  parts: PartSpec[];
  translation?: [number, number, number];
  scale?: [number, number, number];
}

export interface AssetSpec {
  materials: MaterialSpec[];
  /** Each node holds one mesh whose primitives are its parts. */
  nodes: NodeSpec[];
}

/** Builds a GLB with @gltf-transform/core. Output depends only on the spec. */
export async function buildGlb(spec: AssetSpec): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('scene');
  const textureCache = new Map<string, ReturnType<Document['createTexture']>>();
  const png = (t: TextureSpec, name: string) => {
    const key = `${t.width}x${t.height}:${t.rgb.join(',')}`;
    let tex = textureCache.get(key);
    if (!tex) {
      tex = doc.createTexture(name).setImage(solidPng(t.width, t.height, t.rgb)).setMimeType('image/png');
      textureCache.set(key, tex);
    }
    return tex;
  };
  const materials = spec.materials.map((m, i) => {
    const mat = doc.createMaterial(`mat_${i}`).setBaseColorFactor([m.color[0], m.color[1], m.color[2], 1]);
    if (m.baseTexture) mat.setBaseColorTexture(png(m.baseTexture, `base_${i}`));
    const extra = m.extraTextures ?? [];
    if (extra[0]) mat.setNormalTexture(png(extra[0], `normal_${i}`));
    if (extra[1]) mat.setMetallicRoughnessTexture(png(extra[1], `orm_${i}`));
    if (extra[2]) mat.setEmissiveTexture(png(extra[2], `emissive_${i}`));
    return mat;
  });
  spec.nodes.forEach((n, ni) => {
    const mesh = doc.createMesh(`mesh_${ni}`);
    for (const part of n.parts) {
      const g = part.geometry;
      const prim = doc.createPrimitive();
      prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.pos)).setBuffer(buffer));
      prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(g.uv)).setBuffer(buffer));
      prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(g.idx)).setBuffer(buffer));
      prim.setMaterial(materials[part.material]!);
      mesh.addPrimitive(prim);
    }
    const node = doc.createNode(`node_${ni}`).setMesh(mesh);
    if (n.translation) node.setTranslation(n.translation);
    if (n.scale) node.setScale(n.scale);
    scene.addChild(node);
  });
  return new NodeIO().writeBinary(doc);
}

interface GlbParts {
  json: Record<string, unknown>;
  rest: Uint8Array;
}

/** Splits a GLB into its JSON chunk and the bytes after it. Throws on a malformed container. */
function readGlb(bytes: Uint8Array): GlbParts {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const jsonText = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen));
  return { json: JSON.parse(jsonText) as Record<string, unknown>, rest: bytes.subarray(20 + jsonLen) };
}

/** Rewrites the JSON chunk of a GLB, keeping the binary chunk and repairing lengths. */
export function editGlbJson(bytes: Uint8Array, edit: (json: Record<string, unknown>) => void): Uint8Array {
  const { json, rest } = readGlb(bytes);
  edit(json);
  let text = JSON.stringify(json);
  while (Buffer.byteLength(text) % 4 !== 0) text += ' ';
  const jsonBytes = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(20);
  header.write('glTF', 0, 'latin1');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonBytes.length + rest.length, 8);
  header.writeUInt32LE(jsonBytes.length, 12);
  header.write('JSON', 16, 'latin1');
  return new Uint8Array(Buffer.concat([header, jsonBytes, rest]));
}
