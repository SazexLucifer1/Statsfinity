import { describe, expect, it } from 'vitest';
import {
  CARD_ART_BOXES,
  cardArtQueries,
  decodeArtHashes,
  encodeArtHashes,
  grayGrid,
  hammingDistance,
  artMatchCertainty,
  artSimilarity,
  ART_VERIFY_MIN,
  glareShare,
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

describe('artMatchCertainty', () => {
  const match = (distance: number, runnerUp: number) => ({ id: 'x', distance, runnerUp, query: 0 });

  it('nimmt klare Treffer ohne Nachprüfung', () => {
    expect(artMatchCertainty(match(4, 14))).toBe('sure');
    expect(artMatchCertainty(match(6, 10))).toBe('sure');
    // Fast deckungsgleich, auch ohne Vorsprung (dasselbe Artwork in zwei Drucken):
    expect(artMatchCertainty(match(2, 2))).toBe('sure');
  });

  it('prüft knappe Treffer nach und verwirft alles über 10', () => {
    // Unscharfes iPhone-Foto, aber auch typische Verwechslung bei Spiegelung:
    expect(artMatchCertainty(match(8, 10))).toBe('verify');
    expect(artMatchCertainty(match(6, 6))).toBe('verify');
    expect(artMatchCertainty(match(10, 10))).toBe('verify');
    expect(artMatchCertainty(match(12, 20))).toBeNull();
  });
});

describe('Spiegelung', () => {
  // Weiches Muster mit einem ausgefressenen weißen Fleck in der Mitte.
  const w = 120;
  const h = 90;
  const image = (glare: boolean) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = 60 + 50 * Math.sin(x / 9) + 40 * Math.cos(y / 7);
        const spot = glare && (x - 60) ** 2 + (y - 40) ** 2 < 15 ** 2;
        px[i] = spot ? 255 : v + 30;
        px[i + 1] = spot ? 255 : v;
        px[i + 2] = spot ? 255 : 160 - v / 2;
        px[i + 3] = 255;
      }
    }
    return px;
  };
  const whole = [0, 0, 1, 1] as const;

  it('misst den Anteil gespiegelter Pixel', () => {
    expect(glareShare(image(false), w, h, 4, whole)).toBe(0);
    expect(glareShare(image(true), w, h, 4, whole)).toBeGreaterThan(0.05);
  });

  it('erkennt das Original trotz Fleck als ähnlich, ein anderes Bild nicht', () => {
    const glared = image(true);
    const same = artSimilarity(glared, w, h, 4, whole, image(false), w, h, 4);
    const other = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < other.length; i += 4) {
      const p = i / 4;
      other[i] = other[i + 1] = other[i + 2] = ((p * 7919) % 251) as number;
      other[i + 3] = 255;
    }
    expect(same).toBeGreaterThan(ART_VERIFY_MIN);
    expect(artSimilarity(glared, w, h, 4, whole, other, w, h, 4)).toBeLessThan(ART_VERIFY_MIN);
  });
});
