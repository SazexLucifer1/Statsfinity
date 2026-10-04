import { YearReview } from './match-insights';

/**
 * Zeichnet den Jahresrückblick eines Spielers als quadratisches Bild zum Teilen (1080×1080).
 *
 * Wie beim Steckbrief (steckbrief-canvas.ts) IST das Bild die Ansicht: Der Dialog zeigt genau
 * dieses Canvas, und der Download speichert dieselben Pixel. Und wie dort ist das Bild immer
 * englisch - es verlässt die App. Die Texte kommen deshalb als fertige Beschriftungen herein
 * (I18nService.tIn('en', …) im Dialog), hier steht keine einzige Übersetzung.
 */

export const YEAR_REVIEW_SIZE = 1080;

const RAND = 64;
const SCHRIFT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif";

export interface YearReviewLabels {
  title: string;
  games: string;
  wins: string;
  winRate: string;
  bestStreak: string;
  /** Zeilen unten: Beschriftung -> Wert; leere Werte werden ausgelassen. */
  rows: { label: string; value: string | null }[];
  footer: string;
}

export function drawYearReview(
  canvas: HTMLCanvasElement,
  review: YearReview,
  labels: YearReviewLabels,
): void {
  canvas.width = YEAR_REVIEW_SIZE;
  canvas.height = YEAR_REVIEW_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Hintergrund: derselbe Violett-Verlauf wie die App, damit das Bild als Statsfinity erkennbar ist.
  const bg = ctx.createLinearGradient(0, 0, YEAR_REVIEW_SIZE, YEAR_REVIEW_SIZE);
  bg.addColorStop(0, '#1d1238');
  bg.addColorStop(1, '#0b0a1a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, YEAR_REVIEW_SIZE, YEAR_REVIEW_SIZE);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = `600 30px ${SCHRIFT}`;
  ctx.fillText(labels.title.toUpperCase(), RAND, RAND + 30);

  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${fitFont(ctx, review.player, 96, YEAR_REVIEW_SIZE - 2 * RAND, 800)}px ${SCHRIFT}`;
  ctx.fillText(review.player, RAND, RAND + 150);

  // Vier Kacheln mit den Kernzahlen
  const tiles: [string, string][] = [
    [String(review.games), labels.games],
    [String(review.wins), labels.wins],
    [`${Math.round(review.winRate)}%`, labels.winRate],
    [String(review.bestStreak), labels.bestStreak],
  ];
  const gap = 20;
  const tileW = (YEAR_REVIEW_SIZE - 2 * RAND - 3 * gap) / 4;
  const tileTop = RAND + 210;
  const tileH = 170;
  tiles.forEach(([value, label], i) => {
    const x = RAND + i * (tileW + gap);
    roundRect(ctx, x, tileTop, tileW, tileH, 20);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();
    ctx.fillStyle = i === 2 ? '#ffd166' : '#ffffff';
    ctx.font = `800 64px ${SCHRIFT}`;
    centerText(ctx, value, x + tileW / 2, tileTop + 90);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `500 ${fitFont(ctx, label, 24, tileW - 20, 500)}px ${SCHRIFT}`;
    centerText(ctx, label, x + tileW / 2, tileTop + 138);
  });

  // Zeilen: Beschriftung links, Wert rechts
  let y = tileTop + tileH + 80;
  const rows = labels.rows
    .filter((r): r is { label: string; value: string } => !!r.value)
    .slice(0, 7);
  for (const row of rows) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `500 28px ${SCHRIFT}`;
    ctx.fillText(row.label, RAND, y);
    ctx.fillStyle = '#ffffff';
    const maxW = YEAR_REVIEW_SIZE - 2 * RAND - ctx.measureText(row.label).width - 40;
    ctx.font = `700 ${fitFont(ctx, row.value, 34, maxW, 700)}px ${SCHRIFT}`;
    const w = ctx.measureText(row.value).width;
    ctx.fillText(row.value, YEAR_REVIEW_SIZE - RAND - w, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(RAND, y + 24);
    ctx.lineTo(YEAR_REVIEW_SIZE - RAND, y + 24);
    ctx.stroke();
    y += 76;
  }

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `600 24px ${SCHRIFT}`;
  ctx.fillText(labels.footer, RAND, YEAR_REVIEW_SIZE - RAND + 8);
}

/** Größte Schriftgröße ≤ max, bei der text in maxWidth passt (mindestens 16 px). */
function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  max: number,
  maxWidth: number,
  weight: number,
): number {
  let size = max;
  while (size > 16) {
    ctx.font = `${weight} ${size}px ${SCHRIFT}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

function centerText(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number): void {
  ctx.fillText(text, cx - ctx.measureText(text).width / 2, y);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function yearReviewBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}
