import { Hyper3dError } from './errors.ts';

/** Structural check of a GLB container: magic, version, declared length and a parseable JSON chunk. */
export function checkGlbContainer(bytes: Uint8Array): void {
  if (bytes.length < 20) throw new Hyper3dError('TRUNCATED_DOWNLOAD', `${bytes.length} bytes is shorter than a GLB header`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Hyper3dError('CORRUPT_DOWNLOAD', 'bad GLB magic');
  if (dv.getUint32(4, true) !== 2) throw new Hyper3dError('CORRUPT_DOWNLOAD', 'unsupported GLB version');
  const declared = dv.getUint32(8, true);
  if (declared > bytes.length) throw new Hyper3dError('TRUNCATED_DOWNLOAD', `header declares ${declared} bytes, received ${bytes.length}`);
  if (declared < bytes.length) throw new Hyper3dError('CORRUPT_DOWNLOAD', `header declares ${declared} bytes, received ${bytes.length}`);
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLen > bytes.length) throw new Hyper3dError('CORRUPT_DOWNLOAD', 'bad JSON chunk');
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))) as { asset?: { version?: string } };
    if (json.asset?.version !== '2.0') throw new Error('not glTF 2.0');
  } catch {
    throw new Hyper3dError('CORRUPT_DOWNLOAD', 'the JSON chunk is not a glTF 2.0 document');
  }
}
