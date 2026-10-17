import { describe, expect, it } from 'vitest';
import {
  decodeArtHashes,
  encodeArtHashes,
  grayGrid,
  hammingDistance,
  nearestArt,
  phash,
} from './art-hash';

/** Künstliches Bild: Verlauf plus Muster, `seed` macht es zu einem anderen "Artwork". */
function image(width: number, height: number, seed: number): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = 128 + 100 * Math.sin((x * seed) / 37 + y / (11 + seed)) * Math.cos(y / 23 - seed);
      const i = (y * width + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = Math.max(0, Math.min(255, v));
      px[i + 3] = 255;
    }
  }
  return px;
}

describe('art-hash', () => {
  it('gleiches Bild ergibt denselben, anderes Bild einen fernen Fingerabdruck', () => {
    const a = phash(grayGrid(image(400, 300, 3), 400, 300, 4, [0, 0, 1, 1]));
    const b = phash(grayGrid(image(400, 300, 3), 400, 300, 4, [0, 0, 1, 1]));
    expect(hammingDistance(a, b)).toBe(0);
    const c = phash(grayGrid(image(400, 300, 7), 400, 300, 4, [0, 0, 1, 1]));
    expect(hammingDistance(a, c)).toBeGreaterThan(10);
  });

  it('Datei übersteht Hin- und Rückweg und findet den nächsten Eintrag', () => {
    const entries = [3, 5, 7].map((seed, i) => ({
      id: `0000000${i}-1111-2222-3333-444455556666`,
      hash: phash(grayGrid(image(200, 150, seed), 200, 150, 4, [0, 0, 1, 1])),
    }));
    const index = decodeArtHashes(encodeArtHashes(entries));
    expect(index.count).toBe(3);
    const match = nearestArt(index, [entries[1].hash]);
    expect(match?.id).toBe(entries[1].id);
    expect(match?.distance).toBe(0);
  });

  it('erkennt eine fremde Datei nicht als Fingerabdrücke', () => {
    expect(decodeArtHashes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).count).toBe(0);
  });
});
