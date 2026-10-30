import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/**
 * A solid-colour PNG of the given size. One-bit palette pixels keep the raw data small even at 16K,
 * and a constant image deflates to a few kilobytes: small file, enormous GPU footprint.
 */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 3; // colour type: palette
  const rowBytes = 1 + Math.ceil(width / 8);
  const raw = Buffer.alloc(rowBytes * height); // filter 0, all pixels palette index 0
  const idat = deflateSync(raw, { level: 9 });
  return new Uint8Array(
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('PLTE', Buffer.from([rgb[0], rgb[1], rgb[2], 255, 255, 255])),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
