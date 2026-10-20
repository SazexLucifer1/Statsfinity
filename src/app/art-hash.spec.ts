import { describe, expect, it } from 'vitest';
import {
  CARD_ART_BOXES,
  cardArtQueries,
  decodeArtHashes,
  encodeArtHashes,
  grayGrid,
  hammingDistance,
  isConfidentArtMatch,
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

describe('cardArtQueries', () => {
  it('findet ein Artwork auch, wenn die Karte ein Stück verschoben liegt', () => {
    const w = 300;
    const h = 420;
    const px = image(w, h, 5);
    const art = CARD_ART_BOXES[0];
    const reference = phash(grayGrid(px, w, h, 4, art));
    // Dieselbe Karte, angenommen 2 % weiter rechts:
    const shifted = [art[0] + 0.02, art[1], art[2] + 0.02, art[3]] as const;
    const unshifted = hammingDistance(phash(grayGrid(px, w, h, 4, shifted)), reference);
    const queries = cardArtQueries(px, w, h, 4, [0.02, 0, 1.02, 1]);
    const best = Math.min(...queries.map((q) => hammingDistance(q, reference)));
    expect(best).toBeLessThan(unshifted);
  });
});

describe('isConfidentArtMatch', () => {
  const match = (distance: number, runnerUp: number) => ({ id: 'x', distance, runnerUp, query: 0 });

  it('nimmt klare Treffer und verwirft Zufallstreffer', () => {
    expect(isConfidentArtMatch(match(4, 14))).toBe(true);
    // Unscharfes iPhone-Foto:
    expect(isConfidentArtMatch(match(8, 10))).toBe(true);
    // So sahen alle Zufallstreffer in den Gegenproben aus:
    expect(isConfidentArtMatch(match(10, 12))).toBe(false);
    expect(isConfidentArtMatch(match(10, 10))).toBe(false);
    expect(isConfidentArtMatch(match(12, 20))).toBe(false);
  });

  it('nimmt fast deckungsgleiche Bilder auch ohne Vorsprung (dasselbe Artwork zweimal)', () => {
    expect(isConfidentArtMatch(match(2, 2))).toBe(true);
    expect(isConfidentArtMatch(match(6, 6))).toBe(false);
  });
});
