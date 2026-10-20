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

/**
 * Lagen für Marken (Tokens), gegen eine eigene, kleine Datei (`TOKEN_ART_HASH_FILE`): normaler
 * Rahmen (Monarch & Co.), Vollbild ohne Regeltext und Marken MIT Regeltext - dort reicht das Bild
 * bis knapp über den Textkasten, gemessen an 24 Marken von 2007 bis 2027 (20.10.2026); keine der
 * Kartenlagen kam dort unter Abstand 14. Eigene Datei statt einer vierten Lage für alles: Gegen
 * alle ~40.000 Artworks hätte die zusätzliche Lage 2 von 122 Gegenproben fälschlich "erkannt".
 */
export const TOKEN_ART_BOXES: readonly ArtBox[] = [
  [0.08, 0.11, 0.92, 0.555],
  [0.08, 0.12, 0.92, 0.8],
  [0.07, 0.12, 0.93, 0.66],
];

/** Bis zu dieser Distanz kommt ein Treffer überhaupt in Frage (von 64 Bit). */
export const ART_MATCH_MAX_DISTANCE = 10;

/**
 * Wie sicher ist ein Fingerabdruck-Treffer? `sure` gilt ohne weitere Prüfung, `verify` erst, wenn
 * `artSimilarity()` gegen das Original-Artwork mindestens `ART_VERIFY_MIN` ergibt.
 *
 * Gemessen am 20.10.2026 gegen die ~49.000 Artworks der Live-Datei, je 150 schief gelegte Karten,
 * ein Teil mit künstlichen Glanzflecken (Foil, Hülle) - und dieselben Bilder noch einmal mit aus
 * der Datei entferntem Original, sodass jeder Treffer falsch ist: Die frühere Regel (Abstand ≤ 8
 * mit 2 Bit Vorsprung) nahm dort 11 von 150 Bildern ohne und 27 von 150 mit Spiegelung als
 * falsche Karte an. Ein Glanzfleck ist ein großer heller Fleck - genau das, woraus der
 * Fingerabdruck besteht, und viele Artworks haben einen hellen Bereich an ähnlicher Stelle. Mit
 * der Nachprüfung: 1 von 150, und mehr richtige Treffer als vorher.
 */
export function artMatchCertainty(match: ArtMatch): 'sure' | 'verify' | null {
  // Fast deckungsgleich: dann ist auch ein gleich naher Zweiter dasselbe Bild in einem anderen
  // Druck (bei Marken häufig).
  if (match.distance <= 3) return 'sure';
  if (match.distance <= 6 && match.runnerUp - match.distance >= 4) return 'sure';
  return match.distance <= ART_MATCH_MAX_DISTANCE ? 'verify' : null;
}

/** Mindestwert von `artSimilarity()` für einen Treffer, der nachgeprüft werden muss. */
export const ART_VERIFY_MIN = 0.5;

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
  return weightedGrid(pixels, width, height, channels, box, LUMA);
}

const LUMA = [0.299, 0.587, 0.114] as const;
const ONE_CHANNEL = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;

/** Wie `grayGrid`, aber mit eigener Gewichtung der drei Farben (für `artSimilarity`). */
function weightedGrid(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  box: ArtBox,
  [wr, wg, wb]: readonly [number, number, number],
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
          sum += wr * pixels[i] + wg * pixels[i + 1] + wb * pixels[i + 2];
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
  artBoxes: readonly ArtBox[] = CARD_ART_BOXES,
): ArtHash[] {
  return cardArtBoxes(card).flatMap((box) => {
    const bw = box[2] - box[0];
    const bh = box[3] - box[1];
    return artBoxes.map((art) =>
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

/**
 * Ab dieser Helligkeit (0-255, alle drei Farben) gilt ein Pixel als Spiegelung: Foil-Karten und
 * Hüllen werfen Lampenlicht als weißen, ausgefressenen Fleck zurück, und der überdeckt genau die
 * groben Helligkeitsverläufe, aus denen der Fingerabdruck besteht.
 */
export const GLARE_LEVEL = 230;

/** Anteil gespiegelter Pixel in `box`, ab dem sich die Rechnung ohne Spiegelung lohnt. */
export function glareShare(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  box: ArtBox,
): number {
  const x0 = Math.max(0, Math.floor(box[0] * width));
  const x1 = Math.min(width, Math.ceil(box[2] * width));
  const y0 = Math.max(0, Math.floor(box[1] * height));
  const y1 = Math.min(height, Math.ceil(box[3] * height));
  let glare = 0;
  let all = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * width + x) * channels;
      all++;
      if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) >= GLARE_LEVEL) glare++;
    }
  }
  return all ? glare / all : 0;
}

/**
 * Wie `grayGrid`, aber gespiegelte Pixel zählen nicht. `glare` markiert die Zellen, die
 * überwiegend Spiegelung sind, samt einem Ring Nachbarzellen für den Lichthof; ihr Wert in `grid`
 * ist bedeutungslos, bis `grayGridWithoutGlare` sie auffüllt.
 */
export function glareGrid(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  box: ArtBox,
): { grid: Float64Array; glare: Uint8Array } {
  const b = inner(box, ART_INNER_MARGIN);
  const x0 = b[0] * width;
  const y0 = b[1] * height;
  const cw = ((b[2] - b[0]) * width) / N;
  const ch = ((b[3] - b[1]) * height) / N;
  const grid = new Float64Array(N * N);
  const bad = new Uint8Array(N * N);
  for (let gy = 0; gy < N; gy++) {
    const ya = Math.floor(y0 + gy * ch);
    const yb = Math.max(ya + 1, Math.floor(y0 + (gy + 1) * ch));
    for (let gx = 0; gx < N; gx++) {
      const xa = Math.floor(x0 + gx * cw);
      const xb = Math.max(xa + 1, Math.floor(x0 + (gx + 1) * cw));
      let sum = 0;
      let count = 0;
      let glare = 0;
      for (let y = Math.max(0, ya); y < Math.min(height, yb); y++) {
        let i = (y * width + Math.max(0, xa)) * channels;
        for (let x = Math.max(0, xa); x < Math.min(width, xb); x++, i += channels) {
          if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) >= GLARE_LEVEL) {
            glare++;
            continue;
          }
          sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
          count++;
        }
      }
      const cell = gy * N + gx;
      grid[cell] = count ? sum / count : 0;
      if (glare > count) bad[cell] = 1;
    }
  }
  // Lichthof: der Rand eines Glanzflecks ist aufgehellt, aber nicht ganz weiß.
  const glare = bad.slice();
  for (let i = 0; i < N * N; i++) {
    if (!bad[i]) continue;
    const x = i % N;
    const y = (i - x) / N;
    for (let dy = -GLARE_HALO; dy <= GLARE_HALO; dy++) {
      for (let dx = -GLARE_HALO; dx <= GLARE_HALO; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < N && ny < N) glare[ny * N + nx] = 1;
      }
    }
  }
  return { grid, glare };
}

/** `glareGrid` mit aus der Umgebung aufgefüllten Glanzflecken - für den Fingerabdruck. */
export function grayGridWithoutGlare(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  box: ArtBox,
): Float64Array {
  const { grid, glare } = glareGrid(pixels, width, height, channels, box);
  fillHoles(grid, glare);
  return grid;
}

/**
 * Wie ähnlich sich zwei Raster sind (Korrelation -1..1), ohne die markierten Zellen. Zweite,
 * feinere Prüfung für knappe Fingerabdruck-Treffer: 64 Bit verwechseln bei ~50.000 Artworks
 * gelegentlich zwei Bilder mit ähnlicher grober Helligkeitsverteilung, 1024 Zellen kaum.
 */
export function gridCorrelation(a: Float64Array, b: Float64Array, skip?: Uint8Array): number {
  let n = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) {
    if (skip?.[i]) continue;
    n++;
    sa += a[i];
    sb += b[i];
  }
  if (n < a.length / 4) return 0;
  const ma = sa / n;
  const mb = sb / n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (skip?.[i]) continue;
    const da = a[i] - ma;
    const db = b[i] - mb;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * Der Artwork-Ausschnitt (Anteile des Bildes), aus dem Fingerabdruck `query` von
 * `cardArtQueries(…, card, artBoxes)` stammt.
 */
export function artQueryBox(card: ArtBox, query: number, artBoxes: readonly ArtBox[]): ArtBox {
  const box = cardArtBoxes(card)[Math.floor(query / artBoxes.length)];
  const art = artBoxes[query % artBoxes.length];
  const bw = box[2] - box[0];
  const bh = box[3] - box[1];
  return [box[0] + art[0] * bw, box[1] + art[1] * bh, box[0] + art[2] * bw, box[1] + art[3] * bh];
}

/** Wie viele Zellen um einen Glanzfleck herum mit aufgefüllt werden. */
const GLARE_HALO = 1;

/** Füllt markierte Zellen von außen nach innen mit dem Mittel ihrer bekannten Nachbarn. */
function fillHoles(grid: Float64Array, holes: Uint8Array): void {
  let open = holes.reduce((s, v) => s + v, 0);
  if (open === 0 || open === N * N) return;
  while (open > 0) {
    const next = holes.slice();
    for (let i = 0; i < N * N; i++) {
      if (!holes[i]) continue;
      const x = i % N;
      const y = (i - x) / N;
      let sum = 0;
      let count = 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N || holes[ny * N + nx]) continue;
        sum += grid[ny * N + nx];
        count++;
      }
      if (count) {
        grid[i] = sum / count;
        next[i] = 0;
        open--;
      }
    }
    holes.set(next);
  }
}

/** Wie `cardArtQueries`, aber mit `grayGridWithoutGlare`. */
export function cardArtQueriesWithoutGlare(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  card: ArtBox = [0, 0, 1, 1],
  artBoxes: readonly ArtBox[] = CARD_ART_BOXES,
): ArtHash[] {
  return cardArtBoxes(card).flatMap((box) => {
    const bw = box[2] - box[0];
    const bh = box[3] - box[1];
    return artBoxes.map((art) =>
      phash(
        grayGridWithoutGlare(pixels, width, height, channels, [
          box[0] + art[0] * bw,
          box[1] + art[1] * bh,
          box[0] + art[2] * bw,
          box[1] + art[3] * bh,
        ]),
      ),
    );
  });
}

/**
 * Wie gut passt der Ausschnitt `box` der Aufnahme zum Original-Artwork `ref` (Scryfalls art_crop,
 * ganzes Bild)? Mittel aus drei Korrelationen auf 32x32 Zellen - Helligkeit, Farbe, Kanten -,
 * gespiegelte Zellen der Aufnahme bleiben außen vor. Echte Treffer lagen fast alle über 0,5,
 * Verwechslungen fast alle darunter (siehe `artMatchCertainty`).
 */
export function artSimilarity(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  box: ArtBox,
  ref: ArrayLike<number>,
  refWidth: number,
  refHeight: number,
  refChannels: number,
): number {
  const { grid, glare } = glareGrid(pixels, width, height, channels, box);
  const whole: ArtBox = [0, 0, 1, 1];
  const refGrid = grayGrid(ref, refWidth, refHeight, refChannels, whole);
  let color = 0;
  for (let k = 0; k < 3; k++) {
    color += gridCorrelation(
      weightedGrid(pixels, width, height, channels, box, ONE_CHANNEL[k]),
      weightedGrid(ref, refWidth, refHeight, refChannels, whole, ONE_CHANNEL[k]),
      glare,
    );
  }
  return (
    (gridCorrelation(grid, refGrid, glare) +
      color / 3 +
      gridCorrelation(edges(grid), edges(refGrid), glare)) /
    3
  );
}

/** Helligkeitssprünge nach rechts und unten je Zelle. */
function edges(grid: Float64Array): Float64Array {
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      out[i] = (x < N - 1 ? grid[i + 1] - grid[i] : 0) + (y < N - 1 ? grid[i + N] - grid[i] : 0);
    }
  }
  return out;
}

/**
 * Die verschobenen Kartenlagen, die `cardArtQueries` durchrechnet, in derselben Reihenfolge -
 * Fingerabdruck i gehört zu Lage `Math.floor(i / CARD_ART_BOXES.length)`. Damit lässt sich aus
 * dem besten Treffer ablesen, wo die Karte genau liegt.
 */
export function cardArtBoxes(card: ArtBox): ArtBox[] {
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
  return shifted;
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
/** Dasselbe Format, nur Marken (siehe `TOKEN_ART_BOXES`). */
export const TOKEN_ART_HASH_FILE = 'token-art-hashes.bin';
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
  /** Index des Fingerabdrucks in `queries`, der am besten passte. */
  query: number;
}

/** Bester Eintrag über mehrere Fingerabdrücke derselben Aufnahme (je Artwork-Lage einer). */
export function nearestArt(index: ArtHashIndex, queries: readonly ArtHash[]): ArtMatch | null {
  let best = -1;
  let bestD = 65;
  let bestQ = 0;
  let second = 65;
  const h = index.hashes;
  for (let i = 0; i < index.count; i++) {
    const hi = h[i * 2];
    const lo = h[i * 2 + 1];
    let d = 65;
    let dQ = 0;
    for (let k = 0; k < queries.length; k++) {
      const q = queries[k];
      const dq = popcount((hi ^ q.hi) >>> 0) + popcount((lo ^ q.lo) >>> 0);
      if (dq < d) {
        d = dq;
        dQ = k;
      }
    }
    if (d < bestD) {
      second = bestD;
      bestD = d;
      best = i;
      bestQ = dQ;
    } else if (d < second) {
      second = d;
    }
  }
  if (best < 0) return null;
  return { id: artHashId(index, best), distance: bestD, runnerUp: second, query: bestQ };
}
