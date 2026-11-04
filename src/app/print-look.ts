import type { ArtBox } from './art-hash';

/**
 * Welcher Druck einer Karte vor der Kamera liegt, am AUSSEHEN der ganzen Karte statt an der
 * Sammlerzeile (card-scan.service.ts). Gleiches Artwork heißt nicht gleicher Druck: Spore Frog hat
 * dasselbe Bild in PCY (alter Rahmen), MH1, BLC und auf The List. Die Sammlerzeile ist gut 1 mm
 * hoch und bei wenig Licht für die Texterkennung kaum lesbar; Rahmen, Textkasten und Schrift sind
 * dagegen große Strukturen, die auch ein dunkles, verrauschtes Bild noch zeigt. So arbeiten auch
 * die verbreiteten Scanner-Apps: sie vergleichen Bilder, statt Kleingedrucktes zu lesen.
 *
 * Verglichen werden Kantenbilder (Helligkeitsänderungen) auf einem groben Raster - unabhängig von
 * Belichtung und Farbstich. Das Artwork selbst bleibt außen vor (es ist bei allen Kandidaten
 * gleich), ebenso der äußerste Rand (dort trifft die Karte auf den Untergrund). Weil die
 * Kartenlage aus dem Fingerabdruck einige Prozent danebenliegen kann, wird das Foto in vielen
 * leicht verschobenen und skalierten Fenstern gerechnet und das beste genommen.
 *
 * Gemessen (04.11.2026, Skripte nicht im Repo) an 271 Drucken von 45 Karten mit gleichem Artwork
 * in mehreren Drucken, künstlich verschlechtert (schief, unscharf, Rauschen, bis 25 % Helligkeit):
 * die richtige Rahmenart (`lookKey()`) in 267-268 von 271 Fällen, unabhängig von der Helligkeit;
 * die Texterkennung der Ecke fand auf denselben Bildern hell 20 von 70, dunkel 2 von 70. Die
 * Sprache am Textkasten traf 134 von 134. Am echten Foto aus der Fehlermeldung: MH1 0,71-0,74
 * gegen PCY 0,47-0,52; Englisch 0,83-0,87 gegen Deutsch, Französisch, Italienisch, Spanisch
 * höchstens 0,71. Drucke derselben Rahmenart (MH1 gegen BLC) trennt der Vergleich dagegen nicht
 * verlässlich (91 von 187) - das bleibt Sache der Sammlerzeile.
 */

const W = 48;
const H = 67;
/** Feineres Raster für Verschiebungen um halbe Zellen, danach 2x2 zusammengefasst. */
const F = 2;
/** Rand um die Karte in Zellen, um den die Fenster verschoben werden (≈ 8 % der Breite/Höhe). */
const MX = 4;
const MY = 5;
const SCALES = [0.97, 1, 1.03];

/** Ohne Artwork (bei allen Kandidaten gleich) und ohne äußersten Ring (Untergrund). */
export const LOOK_MASK = mask((x, y) => {
  if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return false;
  const inArt = y >= 0.11 * H && y < 0.56 * H && x >= 0.08 * W && x < 0.92 * W;
  return !inArt;
});

/** Nur der Textkasten - dort unterscheiden sich die Sprachen eines Drucks. */
export const TEXT_MASK = mask(
  (x, y) => y >= 0.6 * H && y < 0.93 * H && x >= 0.06 * W && x < 0.94 * W,
);

/** Mindestabstand des besten zum zweitbesten Kandidaten (Messung: Median 0,21, 10 % unter 0,07). */
export const LOOK_MIN_LEAD = 0.05;

function mask(test: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = test(x, y) ? 1 : 0;
  return m;
}

/** Wie ein Druck aussieht, soweit es der Vergleich unterscheidet - aus Scryfalls Kartendaten. */
export function lookKey(card: any): string {
  return [
    card?.frame ?? '',
    card?.border_color ?? '',
    [...(card?.frame_effects ?? [])].sort().join('+'),
    card?.full_art ? 'full' : '',
    card?.textless ? 'textless' : '',
  ].join('|');
}

/** Kantenbild (H x W) des ganzen Scryfall-Scans. */
export function scanEdges(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
): Float64Array {
  const gray = areaGray(pixels, width, height, channels, [0, 0, 1, 1], W * F, H * F);
  return pool(edges(gray, W * F, H * F), W * F, 0, 0);
}

/**
 * Kantenbilder des Fotos in allen verschobenen und skalierten Fenstern um `cardBox` (Anteile).
 * Einmal rechnen, je Maske vorbereiten (`prepareWindows()`), dann gegen beliebig viele Scans
 * vergleichen (`bestCorrelation()`).
 */
export function photoEdgeWindows(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  cardBox: ArtBox,
): Float64Array[] {
  const out: Float64Array[] = [];
  const gw = (W + 2 * MX) * F;
  const gh = (H + 2 * MY) * F;
  const cx = (cardBox[0] + cardBox[2]) / 2;
  const cy = (cardBox[1] + cardBox[3]) / 2;
  for (const s of SCALES) {
    const cw = ((cardBox[2] - cardBox[0]) * s) / W;
    const ch = ((cardBox[3] - cardBox[1]) * s) / H;
    const box: ArtBox = [
      cx - (W / 2 + MX) * cw,
      cy - (H / 2 + MY) * ch,
      cx + (W / 2 + MX) * cw,
      cy + (H / 2 + MY) * ch,
    ];
    const e = edges(areaGray(pixels, width, height, channels, box, gw, gh), gw, gh);
    for (let dy = 0; dy <= 2 * MY * F; dy++) {
      for (let dx = 0; dx <= 2 * MX * F; dx++) out.push(pool(e, gw, dx, dy));
    }
  }
  return out;
}

/** Fenster für den Vergleich unter der Maske `m` vorbereiten (einmal je Foto und Maske). */
export function prepareWindows(windows: readonly Float64Array[], m: Uint8Array): Float64Array[] {
  return windows.map((window) => normalized(window, m));
}

/** Höchste Korrelation eines vorbereiteten Fensters mit dem Scan, unter derselben Maske `m`. */
export function bestCorrelation(
  prepared: readonly Float64Array[],
  scan: Float64Array,
  m: Uint8Array,
): number {
  const ref = normalized(scan, m);
  let best = -1;
  for (const win of prepared) {
    let dot = 0;
    for (let i = 0; i < win.length; i++) dot += win[i] * ref[i];
    if (dot > best) best = dot;
  }
  return best;
}

/**
 * Index des klar besten Werts, null ohne Vorsprung von `LOOK_MIN_LEAD` vor dem zweitbesten
 * (oder mit weniger als zwei Werten - dann gibt es nichts zu entscheiden).
 */
export function clearWinner(scores: readonly number[]): number | null {
  if (scores.length < 2) return null;
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  const second = Math.max(...scores.filter((_, i) => i !== best));
  return scores[best] - second >= LOOK_MIN_LEAD ? best : null;
}

/** Werte unter der Maske, mittelwertfrei und auf Länge 1 gebracht. */
function normalized(grid: Float64Array, m: Uint8Array): Float64Array {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i]) {
      sum += grid[i];
      n++;
    }
  }
  const mean = n ? sum / n : 0;
  const out = new Float64Array(n);
  let len = 0;
  for (let i = 0, j = 0; i < m.length; i++) {
    if (!m[i]) continue;
    out[j] = grid[i] - mean;
    len += out[j] * out[j];
    j++;
  }
  const scale = len > 0 ? 1 / Math.sqrt(len) : 0;
  for (let j = 0; j < out.length; j++) out[j] *= scale;
  return out;
}

/** Graustufen des Ausschnitts `box` (Anteile, darf über den Rand ragen) per Flächenmittel. */
function areaGray(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  box: ArtBox,
  outW: number,
  outH: number,
): Float64Array {
  const out = new Float64Array(outW * outH);
  const x0 = box[0] * width;
  const y0 = box[1] * height;
  const cw = ((box[2] - box[0]) * width) / outW;
  const ch = ((box[3] - box[1]) * height) / outH;
  for (let gy = 0; gy < outH; gy++) {
    const ya = clamp(Math.floor(y0 + gy * ch), height);
    const yb = Math.max(ya + 1, clamp(Math.floor(y0 + (gy + 1) * ch), height + 1));
    for (let gx = 0; gx < outW; gx++) {
      const xa = clamp(Math.floor(x0 + gx * cw), width);
      const xb = Math.max(xa + 1, clamp(Math.floor(x0 + (gx + 1) * cw), width + 1));
      let sum = 0;
      let count = 0;
      for (let y = ya; y < Math.min(height, yb); y++) {
        let i = (y * width + xa) * channels;
        for (let x = xa; x < Math.min(width, xb); x++, i += channels) {
          sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
          count++;
        }
      }
      out[gy * outW + gx] = count ? sum / count : 0;
    }
  }
  return out;
}

function clamp(v: number, max: number): number {
  return Math.max(0, Math.min(max - 1, v));
}

/** Betrag des Helligkeitsgefälles (zentrale Differenzen), Rand = 0. */
function edges(g: Float64Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = Math.hypot(g[i + 1] - g[i - 1], g[i + w] - g[i - w]);
    }
  }
  return out;
}

/** Fenster W*F x H*F ab (dx, dy) aus einem Raster der Breite `gw`, F x F gemittelt. */
function pool(e: Float64Array, gw: number, dx: number, dy: number): Float64Array {
  const out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let fy = 0; fy < F; fy++) {
        const row = (dy + y * F + fy) * gw + dx + x * F;
        for (let fx = 0; fx < F; fx++) sum += e[row + fx];
      }
      out[y * W + x] = sum / (F * F);
    }
  }
  return out;
}
