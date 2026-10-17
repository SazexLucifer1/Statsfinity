/**
 * Bild-Fingerabdruck eines Artworks (perceptual hash) für den Kartenscanner.
 *
 * Diese Datei läuft an ZWEI Stellen und darf deshalb nichts importieren und nur "abstreifbares"
 * TypeScript enthalten (keine enums, keine Parameter-Properties): im Browser (card-scan.service.ts)
 * und im Nachtlauf (scripts/sync-card-art-hashes.mjs, `node --experimental-strip-types`). Zwei
 * Fassungen derselben Rechnung würden auseinanderlaufen, und dann erkennt der Scanner nichts mehr,
 * ohne dass es jemand merkt - die Fingerabdrücke wären nur noch "ähnlich", nicht gleich gerechnet.
 *
 * Verfahren (DCT-pHash): Ausschnitt -> 32x32 Graustufen per Flächenmittel (nicht per Browser- oder
 * sharp-Skalierung, die rechnen je nach Engine anders) -> 2D-DCT -> die 8x8 niedrigsten
 * Frequenzen ohne Gleichanteil -> je Koeffizient ein Bit "über dem Median". 64 Bit, verglichen
 * über die Hamming-Distanz. Gemessen an 700 Scryfall-Drucken (Kamera simuliert über das ganze
 * Kartenbild): 98 % richtig, richtige Treffer meist Distanz <= 4, falsche frühestens ab 8.
 */

/** Ausschnitt in Anteilen des Bildes: [links, oben, rechts, unten]. */
export type ArtBox = readonly [number, number, number, number];

/** 64-Bit-Fingerabdruck als zwei vorzeichenlose 32-Bit-Hälften (schneller als BigInt). */
export interface ArtHash {
  hi: number;
  lo: number;
}

/**
 * Rand, der innen weggelassen wird, bevor gerechnet wird. Fängt ab, dass die Karte nie genau im
 * Rahmen liegt und Scryfalls art_crop je Rahmenart etwas anders schneidet.
 */
export const ART_INNER_MARGIN = 0.1;

/**
 * Wo auf einer Karte (Anteile des ganzen Kartenbilds, 63x88) das Artwork liegen kann. Der Scanner
 * rechnet für jede Lage einen Fingerabdruck und nimmt den besten Treffer: normaler Rahmen,
 * Vollbild-Länder (Zendikar & Co.) und randlose Karten.
 */
export const CARD_ART_BOXES: readonly ArtBox[] = [
  [0.08, 0.11, 0.92, 0.555],
  [0.08, 0.12, 0.92, 0.8],
  [0.05, 0.05, 0.95, 0.93],
];

/** Bis zu dieser Distanz gilt ein Treffer als sicher (von 64 Bit). */
export const ART_MATCH_MAX_DISTANCE = 10;

/**
 * Sicherer Treffer? Seit der Scanner viele leicht verschobene Ausschnitte vergleicht
 * (`cardArtQueries`), erreichen auch Bilder OHNE echte Übereinstimmung gegen ~40.000 Artworks
 * gelegentlich Distanz 10 - in 122 Gegenproben immer genau 10 und mit höchstens 2 Bit Vorsprung
 * vor dem nächstbesten Artwork, nie 8 oder weniger. Echte Treffer: meist 4-6, mit Vorsprung 4+;
 * ein unscharfes iPhone-Foto kam auf 8 mit Vorsprung 2. Daher abgestuft.
 */
export function isConfidentArtMatch(match: ArtMatch): boolean {
  const margin = match.runnerUp - match.distance;
  if (match.distance <= 8) return margin >= 2;
  return match.distance <= ART_MATCH_MAX_DISTANCE && margin >= 4;
}

/**
 * Verschiebungen (Anteile der Kartenbreite/-höhe), mit denen jede Artwork-Lage zusätzlich
 * gerechnet wird. Der Fingerabdruck verträgt nur ein, zwei Prozent Versatz; die im Kamerabild
 * gefundene Karte (card-bounds.ts) liegt oft drei Prozent daneben. Gemessen an 150 schief und
 * versetzt gelegten Karten: ohne Verschiebung 58 erkannt, mit diesen 136.
 */
const ART_JITTER = [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03];

const N = 32;
const COS: Float64Array[] = [];
for (let u = 0; u < 8; u++) {
  const row = new Float64Array(N);
  for (let x = 0; x < N; x++) row[x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  COS.push(row);
}

function inner(box: ArtBox, margin: number): ArtBox {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  return [box[0] + w * margin, box[1] + h * margin, box[2] - w * margin, box[3] - h * margin];
}

/**
 * 32x32 Graustufen eines Ausschnitts per Flächenmittel. `pixels` ist RGBA oder RGB
 * (`channels` 4 bzw. 3), zeilenweise.
 */
export function grayGrid(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  box: ArtBox,
): Float64Array {
  const b = inner(box, ART_INNER_MARGIN);
  const x0 = b[0] * width;
  const y0 = b[1] * height;
  const cw = ((b[2] - b[0]) * width) / N;
  const ch = ((b[3] - b[1]) * height) / N;
  const out = new Float64Array(N * N);
  for (let gy = 0; gy < N; gy++) {
    const ya = Math.floor(y0 + gy * ch);
    const yb = Math.max(ya + 1, Math.floor(y0 + (gy + 1) * ch));
    for (let gx = 0; gx < N; gx++) {
      const xa = Math.floor(x0 + gx * cw);
      const xb = Math.max(xa + 1, Math.floor(x0 + (gx + 1) * cw));
      let sum = 0;
      let count = 0;
      for (let y = Math.max(0, ya); y < Math.min(height, yb); y++) {
        let i = (y * width + Math.max(0, xa)) * channels;
        for (let x = Math.max(0, xa); x < Math.min(width, xb); x++, i += channels) {
          sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
          count++;
        }
      }
      out[gy * N + gx] = count ? sum / count : 0;
    }
  }
  return out;
}

/**
 * Alle Fingerabdrücke einer Aufnahme: jede Artwork-Lage aus `CARD_ART_BOXES` innerhalb der Karte
 * `card` (Anteile des Bildes), je verschoben und leicht vergrößert/verkleinert.
 */
export function cardArtQueries(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  card: ArtBox = [0, 0, 1, 1],
): ArtHash[] {
  const w = card[2] - card[0];
  const h = card[3] - card[1];
  const shifted: ArtBox[] = [];
  for (const dx of ART_JITTER) {
    for (const dy of ART_JITTER) {
      shifted.push([card[0] + dx * w, card[1] + dy * h, card[2] + dx * w, card[3] + dy * h]);
    }
  }
  for (const sc of ART_JITTER) {
    if (sc) shifted.push([card[0] - sc * w, card[1] - sc * h, card[2] + sc * w, card[3] + sc * h]);
  }
  return shifted.flatMap((box) => {
    const bw = box[2] - box[0];
    const bh = box[3] - box[1];
    return CARD_ART_BOXES.map((art) =>
      phash(
        grayGrid(pixels, width, height, channels, [
          box[0] + art[0] * bw,
          box[1] + art[1] * bh,
          box[0] + art[2] * bw,
          box[1] + art[3] * bh,
        ]),
      ),
    );
  });
}

/** DCT-pHash aus einem 32x32-Graustufenraster. */
export function phash(gray: Float64Array): ArtHash {
  const rows: Float64Array[] = [];
  for (let u = 0; u < 8; u++) {
    const r = new Float64Array(N);
    for (let y = 0; y < N; y++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += gray[y * N + x] * COS[u][x];
      r[y] = s;
    }
    rows.push(r);
  }
  const coeffs: number[] = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[u][y] * COS[v][y];
      coeffs.push(s);
    }
  }
  const median = coeffs.slice(1).sort((a, b) => a - b)[31];
  let hi = 0;
  let lo = 0;
  // Bit 0 ist der Gleichanteil (Helligkeit) und bleibt immer 0 - sonst kippt der Fingerabdruck
  // schon, wenn das Licht beim Scannen anders ist.
  for (let i = 1; i < 64; i++) {
    if (coeffs[i] <= median) continue;
    if (i < 32) hi |= 1 << (31 - i);
    else lo |= 1 << (63 - i);
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

function popcount(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hammingDistance(a: ArtHash, b: ArtHash): number {
  return popcount((a.hi ^ b.hi) >>> 0) + popcount((a.lo ^ b.lo) >>> 0);
}

// ---------------------------------------------------------------------------------------------
// Dateiformat der Fingerabdruck-Datei im Storage (Bucket card-art-hashes, Datei art-hashes.bin):
// "SAH1", Anzahl (uint32 LE), dann je Eintrag hi, lo (uint32 LE) und die Scryfall-ID des Drucks
// (16 Byte, die UUID ohne Bindestriche). 24 Byte je Artwork.
// ---------------------------------------------------------------------------------------------

export const ART_HASH_FILE = 'art-hashes.bin';
const MAGIC = 0x31484153; // "SAH1" little endian
const ENTRY = 24;

export interface ArtHashIndex {
  count: number;
  hashes: Uint32Array; // hi, lo abwechselnd
  ids: Uint8Array; // 16 Byte je Eintrag
}

export function encodeArtHashes(entries: readonly { id: string; hash: ArtHash }[]): Uint8Array {
  const buf = new Uint8Array(8 + entries.length * ENTRY);
  const view = new DataView(buf.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, entries.length, true);
  entries.forEach((e, i) => {
    const off = 8 + i * ENTRY;
    view.setUint32(off, e.hash.hi, true);
    view.setUint32(off + 4, e.hash.lo, true);
    const hex = e.id.replace(/-/g, '');
    for (let k = 0; k < 16; k++) buf[off + 8 + k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16);
  });
  return buf;
}

export function decodeArtHashes(data: ArrayBuffer | Uint8Array): ArtHashIndex {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || view.getUint32(0, true) !== MAGIC) {
    return { count: 0, hashes: new Uint32Array(0), ids: new Uint8Array(0) };
  }
  const count = Math.min(view.getUint32(4, true), Math.floor((bytes.byteLength - 8) / ENTRY));
  const hashes = new Uint32Array(count * 2);
  const ids = new Uint8Array(count * 16);
  for (let i = 0; i < count; i++) {
    const off = 8 + i * ENTRY;
    hashes[i * 2] = view.getUint32(off, true);
    hashes[i * 2 + 1] = view.getUint32(off + 4, true);
    ids.set(bytes.subarray(off + 8, off + 24), i * 16);
  }
  return { count, hashes, ids };
}

export function artHashId(index: ArtHashIndex, i: number): string {
  let hex = '';
  for (let k = 0; k < 16; k++) hex += index.ids[i * 16 + k].toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ArtMatch {
  id: string;
  distance: number;
  /** Abstand zum nächstbesten ANDEREN Eintrag - klein heißt "verwechselbar". */
  runnerUp: number;
}

/** Bester Eintrag über mehrere Fingerabdrücke derselben Aufnahme (je Artwork-Lage einer). */
export function nearestArt(index: ArtHashIndex, queries: readonly ArtHash[]): ArtMatch | null {
  let best = -1;
  let bestD = 65;
  let second = 65;
  const h = index.hashes;
  for (let i = 0; i < index.count; i++) {
    const hi = h[i * 2];
    const lo = h[i * 2 + 1];
    let d = 65;
    for (const q of queries) {
      const dq = popcount((hi ^ q.hi) >>> 0) + popcount((lo ^ q.lo) >>> 0);
      if (dq < d) d = dq;
    }
    if (d < bestD) {
      second = bestD;
      bestD = d;
      best = i;
    } else if (d < second) {
      second = d;
    }
  }
  if (best < 0) return null;
  return { id: artHashId(index, best), distance: bestD, runnerUp: second };
}
