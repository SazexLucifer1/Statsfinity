/**
 * Findet die Karte im Kamerabild rund um den Scanner-Rahmen (card-scan.service.ts). Der Rahmen
 * ist nur eine Anlegehilfe: In der Hand liegt die Karte fast nie genau darin - mal kleiner, mal
 * verschoben, mal ragt sie ein Stück heraus (Wunsch des Users, 18.10.2026: "allgemein im Rahmen"
 * soll reichen). Sammlerzeile und Artwork-Lagen sind aber Anteile der KARTE.
 *
 * Zwei Verfahren, beide ohne Bildverarbeitungs-Paket auf einem kleinen Graustufenbild, und beide
 * Ergebnisse gehen an den Artwork-Vergleich, der den eindeutigen Treffer nimmt. Keins allein war
 * gut genug: Das erste fand die Karte auf einem echten iPhone-Foto (Holztisch, unscharf), auf
 * dem das zweite in Holzmaserung und Kartentext danebengriff; das zweite erkannte bei 150 schief
 * und versetzt gelegten Karten deutlich mehr. Ein drittes (Raster über alle Lagen und Größen)
 * war in beiden Tests schlechter und ist wieder raus.
 *
 * 1. Äußerste Kante: Helligkeitssprünge je Spalte (über das mittlere Drittel der Höhe) und je
 *    Zeile; auf jeder Seite der äußerste kräftige Sprung.
 * 2. Rechteck aus Spitzen: Die kräftigsten Spalten und Zeilen sind Kandidaten für die vier
 *    Kanten; bewertet wird jede Kombination im Kartenformat danach, wie kräftig der Sprung
 *    ENTLANG ihrer vier Seiten ist, und unter den gut belegten gewinnt das größte - der innere
 *    Rand einer Karte (schwarzer Rand -> Bild) hat fast dasselbe Format und oft den kräftigeren
 *    Sprung als die Kante Tisch -> Karte.
 */

/** Ausschnitt in Anteilen des Bildes: [links, oben, rechts, unten]. */
export type Bounds = readonly [number, number, number, number];

const CARD_RATIO = 63 / 88;
/** Kleinste Karte in Anteilen der Bildbreite bzw. -höhe. */
const MIN_SIZE = 0.3;

/** Wahrscheinlichste Lage der Karte, `gray` zeilenweise, Werte 0-255. */
export function findCardBounds(
  gray: ArrayLike<number>,
  width: number,
  height: number,
): Bounds | null {
  return findCardCandidates(gray, width, height)[0] ?? null;
}

/** Bis zu zwei Annahmen, wo die Karte liegt (je eine je Verfahren, doppelte entfallen). */
export function findCardCandidates(
  gray: ArrayLike<number>,
  width: number,
  height: number,
): Bounds[] {
  const out: Bounds[] = [];
  for (const b of [outermostRect(gray, width, height), strongestRect(gray, width, height)]) {
    if (b && out.every((o) => overlap(o, b) < 0.9)) out.push(b);
  }
  return out;
}

// --- 1. Äußerste Kante -------------------------------------------------------------------------

function outermostRect(gray: ArrayLike<number>, width: number, height: number): Bounds | null {
  const cols = edgeProfile(gray, width, height, 'x');
  const rows = edgeProfile(gray, width, height, 'y');
  const left = outermostEdge(cols, 0, Math.floor(width * 0.45), 'start');
  const right = outermostEdge(cols, Math.ceil(width * 0.55), width - 1, 'end');
  const top = outermostEdge(rows, 0, Math.floor(height * 0.45), 'start');
  const bottom = outermostEdge(rows, Math.ceil(height * 0.55), height - 1, 'end');
  if (left === null || right === null || top === null || bottom === null) return null;

  const w = right - left;
  const h = bottom - top;
  if (w < width * MIN_SIZE || h < height * MIN_SIZE) return null;
  if (Math.abs(w / h - CARD_RATIO) / CARD_RATIO > 0.12) return null;
  return [left / width, top / height, right / width, bottom / height];
}

function edgeProfile(
  gray: ArrayLike<number>,
  width: number,
  height: number,
  axis: 'x' | 'y',
): Float64Array {
  const len = axis === 'x' ? width : height;
  const out = new Float64Array(len);
  // Nur das mittlere Drittel der anderen Richtung: Dort kreuzt die Kartenkante sicher, Ecken und
  // Hintergrundkanten außerhalb der Karte zählen weniger.
  const from = Math.floor((axis === 'x' ? height : width) / 3);
  const to = Math.ceil(((axis === 'x' ? height : width) * 2) / 3);
  for (let i = 1; i < len - 1; i++) {
    let sum = 0;
    for (let j = from; j < to; j++) {
      const a = axis === 'x' ? gray[j * width + i - 1] : gray[(i - 1) * width + j];
      const b = axis === 'x' ? gray[j * width + i + 1] : gray[(i + 1) * width + j];
      sum += Math.abs(b - a);
    }
    out[i] = sum / (to - from);
  }
  return out;
}

/** Äußerster Sprung im Bereich, der mindestens halb so stark ist wie der stärkste dort. */
function outermostEdge(
  profile: Float64Array,
  from: number,
  to: number,
  side: 'start' | 'end',
): number | null {
  let max = 0;
  for (let i = from; i <= to; i++) max = Math.max(max, profile[i]);
  if (max < 12) return null; // kein deutlicher Sprung: Karte hebt sich nicht vom Grund ab
  const threshold = max * 0.5;
  if (side === 'start') {
    for (let i = from; i <= to; i++) if (profile[i] >= threshold) return i;
  } else {
    for (let i = to; i >= from; i--) if (profile[i] >= threshold) return i;
  }
  return null;
}

// --- 2. Rechteck aus Spitzen -------------------------------------------------------------------

function strongestRect(gray: ArrayLike<number>, width: number, height: number): Bounds | null {
  // Sprungstärke als Präfixsummen entlang der Kante, die sie stützt: senkrechte Kanten (Sprung in
  // x) spaltenweise von oben nach unten, waagerechte zeilenweise.
  const colSum = new Float32Array(width * (height + 1));
  const rowSum = new Float32Array(height * (width + 1));
  for (let x = 1; x < width - 1; x++) {
    let s = 0;
    for (let y = 0; y < height; y++) {
      s += Math.abs(gray[y * width + x + 1] - gray[y * width + x - 1]);
      colSum[x * (height + 1) + y + 1] = s;
    }
  }
  for (let y = 1; y < height - 1; y++) {
    let s = 0;
    for (let x = 0; x < width; x++) {
      s += Math.abs(gray[(y + 1) * width + x] - gray[(y - 1) * width + x]);
      rowSum[y * (width + 1) + x + 1] = s;
    }
  }
  const xs = peaks(
    Array.from({ length: width }, (_, x) => colSum[x * (height + 1) + height]),
    10,
  );
  const ys = peaks(
    Array.from({ length: height }, (_, y) => rowSum[y * (width + 1) + width]),
    10,
  );

  // Mittlere Sprungstärke entlang einer Seite; ±1 px, weil eine leicht schräge Karte ihre Kante
  // nicht in genau einer Spalte hat.
  const vSide = (x: number, t: number, b: number) => {
    let best = 0;
    for (let dx = -1; dx <= 1; dx++) {
      const c = Math.min(width - 1, Math.max(0, x + dx));
      best = Math.max(best, colSum[c * (height + 1) + b] - colSum[c * (height + 1) + t]);
    }
    return best / Math.max(1, b - t);
  };
  const hSide = (y: number, l: number, r: number) => {
    let best = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const row = Math.min(height - 1, Math.max(0, y + dy));
      best = Math.max(best, rowSum[row * (width + 1) + r] - rowSum[row * (width + 1) + l]);
    }
    return best / Math.max(1, r - l);
  };

  const minSize = MIN_SIZE * Math.min(width, height);
  const found: { bounds: Bounds; score: number; area: number }[] = [];
  for (const l of xs) {
    for (const r of xs) {
      if (r - l < minSize) continue;
      for (const t of ys) {
        for (const b of ys) {
          if (b - t < minSize) continue;
          if (Math.abs((r - l) / (b - t) - CARD_RATIO) / CARD_RATIO > 0.1) continue;
          // Die schwächste Seite zählt mit: ein Rechteck ohne Kante an einer Seite ist keine Karte.
          const sides = [vSide(l, t, b), vSide(r, t, b), hSide(t, l, r), hSide(b, l, r)];
          const weakest = Math.min(...sides);
          if (weakest < 8) continue;
          found.push({
            bounds: [l / width, t / height, r / width, b / height],
            score: (sides[0] + sides[1] + sides[2] + sides[3]) / 4 + weakest,
            area: (r - l) * (b - t),
          });
        }
      }
    }
  }
  if (found.length === 0) return null;
  const top = Math.max(...found.map((f) => f.score));
  return found.filter((f) => f.score >= top * 0.5).reduce((a, b) => (b.area > a.area ? b : a))
    .bounds;
}

/** Die `count` kräftigsten örtlichen Spitzen eines Profils (mindestens 3 px auseinander). */
function peaks(profile: number[], count: number): number[] {
  const order = profile
    .map((value, index) => ({ value, index }))
    .filter(({ index }) => index > 0 && index < profile.length - 1)
    .sort((a, b) => b.value - a.value);
  const chosen: number[] = [];
  for (const { index } of order) {
    if (chosen.every((c) => Math.abs(c - index) >= 3)) chosen.push(index);
    if (chosen.length === count) break;
  }
  return chosen.sort((a, b) => a - b);
}

/** Schnittfläche durch Vereinigungsfläche zweier Rechtecke. */
function overlap(a: Bounds, b: Bounds): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}
