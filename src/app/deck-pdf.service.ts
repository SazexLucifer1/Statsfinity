import { Injectable, computed, inject, signal } from '@angular/core';
import { I18nService } from './i18n.service';
import { kartenBildAlsDataUrl } from './card-image-datauri';

export interface PdfSourceCard {
  cardName: string;
  quantity: number;
  imageUrl: string | null;
  backImageUrl: string | null;
}

export interface PdfCardEntry {
  cardName: string;
  quantity: number;
  imageUrl: string | null;
  backImageUrl: string | null;
  selected: boolean;
}

// Echte Kartengröße (63,5x88,9mm / 2,5"x3,5") statt gerundet, damit sich das PDF 1:1 zum Ausschneiden eignet.
const CARD_WIDTH_MM = 63.5;
const CARD_HEIGHT_MM = 88.9;
const COLUMNS = 3;
const ROWS = 3;
const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
// Echte, sichtbare Lücke zwischen den Karten statt lückenlos aneinanderliegend - die Lücke selbst
// (weißes Papier) ist die Schnittlinie. Lückenlos aneinanderliegend hätte bedeutet, dass eine
// eingezeichnete Linie unter den (immer rechteckigen) Kartenbildern verschwindet und höchstens in
// den abgerundeten Kartenecken benachbarter Karten ein winziges weißes Dreieck durchscheint -
// optisch wie ein Darstellungsfehler statt einer absichtlichen Schnittmarkierung.
const CARD_GAP_MM = 0.5;
const GRID_WIDTH_MM = COLUMNS * CARD_WIDTH_MM + (COLUMNS - 1) * CARD_GAP_MM;
const GRID_HEIGHT_MM = ROWS * CARD_HEIGHT_MM + (ROWS - 1) * CARD_GAP_MM;
const MARGIN_X_MM = (PAGE_WIDTH_MM - GRID_WIDTH_MM) / 2;
const MARGIN_Y_MM = (PAGE_HEIGHT_MM - GRID_HEIGHT_MM) / 2;

/**
 * Erzeugt ein druckfertiges PDF (echte Kartengröße, Schnittlinien, 3x3 pro A4-Seite) aus einer
 * Deck-Kartenliste - hält den Auswahl-Dialog-Zustand global, damit er als eigene, root-level
 * gerenderte Komponente existieren kann (analog DeckImportService).
 */
@Injectable({ providedIn: 'root' })
export class DeckPdfService {
  readonly i18n = inject(I18nService);

  readonly showDialog = signal(false);
  readonly deckName = signal('');
  readonly entries = signal<PdfCardEntry[]>([]);
  readonly copiesMode = signal<'one' | 'all'>('one');
  /**
   * Die verwendete "normal"-Bildvariante von Scryfall ist ein normales, undurchsichtiges JPG ohne
   * Alphakanal - die abgerundete Kartenecke ist darin schon als heller Fleck FEST einkopiert statt
   * transparent. Deshalb hilft eine Hintergrundfarbe beim Zusammensetzen nichts (wird komplett vom
   * Bild überzeichnet) - stattdessen wird nach dem Einfügen des Bildes gezielt eine Eckform genau
   * über die vier Kartenecken gemalt, eingefärbt mit der tatsächlich vom jeweiligen Kartenbild
   * abgetasteten Rahmenfarbe (siehe recompressForPrint) statt einer festen Farbe - funktioniert so
   * unabhängig vom Rahmen (schwarz, weiß, randlos, ...).
   */
  readonly fillCorners = signal(false);
  readonly busy = signal(false);
  readonly progress = signal<{ done: number; total: number } | null>(null);
  readonly errorMessage = signal('');

  readonly selectedCount = computed(() => this.entries().filter((e) => e.selected).length);

  /** Reihenfolge kommt unverändert vom Aufrufer (Deck-Gruppierung wie beim Deckbauen) - hier bewusst NICHT alphabetisch sortieren. */
  open(deckName: string, cards: PdfSourceCard[]): void {
    this.deckName.set(deckName);
    this.entries.set(
      cards.map((c) => ({
        cardName: c.cardName,
        quantity: c.quantity,
        imageUrl: c.imageUrl,
        backImageUrl: c.backImageUrl,
        selected: true,
      }))
    );
    this.copiesMode.set('one');
    this.fillCorners.set(false);
    this.busy.set(false);
    this.progress.set(null);
    this.errorMessage.set('');
    this.showDialog.set(true);
  }

  close(): void {
    this.showDialog.set(false);
  }

  toggleCard(cardName: string): void {
    this.entries.update((list) =>
      list.map((e) => (e.cardName === cardName ? { ...e, selected: !e.selected } : e))
    );
  }

  setAllSelected(selected: boolean): void {
    this.entries.update((list) => list.map((e) => ({ ...e, selected })));
  }

  setCopiesMode(mode: 'one' | 'all'): void {
    this.copiesMode.set(mode);
  }

  setFillCorners(value: boolean): void {
    this.fillCorners.set(value);
  }

  /**
   * Zeichnet ein geladenes Bild sofort auf ein Offscreen-Canvas in exakt der im PDF benötigten
   * Pixelgröße (300 DPI bei Kartengröße - entspricht ungefähr Scryfalls nativer "png"-Auflösung,
   * also kein wahrnehmbarer Qualitätsverlust) und kodiert es als komprimiertes JPEG neu. Grund:
   * Scryfalls "png"-Druckvariante ist unkomprimiert mit Alphakanal und dadurch um ein Vielfaches
   * größer als nötig - bei größeren Decks mit Vorder+Rückseiten hat das den Speicher mobiler
   * Browser-Tabs gesprengt und die App zum Abstürzen/Neuladen gebracht. Ein data:-URL als Bildquelle
   * gilt für <canvas> immer als same-origin, es gibt also kein CORS-Problem.
   */
  private async recompressForPrint(dataUrl: string, fillCorners: boolean): Promise<string> {
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('image load failed'));
        el.src = dataUrl;
      });
      const targetW = Math.round((CARD_WIDTH_MM / 25.4) * 300);
      const targetH = Math.round((CARD_HEIGHT_MM / 25.4) * 300);
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return dataUrl;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, targetW, targetH);
      ctx.drawImage(img, 0, 0, targetW, targetH);
      if (fillCorners) {
        // Radius der echten Kartenecke (~3,5mm) in Pixel bei der Zielauflösung - bewusst etwas
        // großzügig, damit auch ein leicht abweichender Radius im Quellbild sauber überdeckt wird;
        // die minimale Überlappung fällt auf den Kartenrahmen und ist unsichtbar.
        const r = Math.round((3.5 / 25.4) * 300);
        // Statt einer festen Farbe (frühere Version: immer schwarz, sah bei weiß- oder anders
        // gerahmten sowie randlosen Karten sichtbar falsch aus) wird je Ecke die tatsächliche
        // Rahmenfarbe direkt aus dem eben gezeichneten Kartenbild abgetastet - je zwei Messpunkte
        // knapp innerhalb der geraden Kante (kurz hinter der Rundung, siehe edgeOffset/nearEdge),
        // gemittelt. Funktioniert dadurch für jede Rahmenfarbe; bei randlosen Karten trifft die
        // Abtastung den Kartenrand-Farbverlauf statt eines echten Rahmens - näherungsweise passend.
        const edgeOffset = 5;
        const nearEdge = 2;
        // Alpha-Karten (LEA) haben eine deutlich rundere Ecke als alle späteren Drucke - im
        // Scryfall-Bild gut 1,5-mal so groß wie r. Mit festem r blieb dort zwischen Füllung und
        // echter Rundung ein weißer Streifen stehen. Deshalb wird zusätzlich innerhalb eines
        // größeren Zwickels (Radius R) der Eckhintergrund selbst verfolgt: ausgehend vom äußersten
        // Eckpixel alles, was diesem Hintergrund ähnlicher ist als dem Rahmen (Flutfüllung, also
        // nur zusammenhängend). Bei normalen Karten endet die Flut an der eigenen Rundung, bei
        // randlosen Karten hält sie der Zwickel von R davon ab, ins Artwork zu laufen. Die
        // Messpunkte liegen hinter R, damit sie auch bei Alpha auf der geraden Kante landen.
        const R = Math.round(r * 1.6);
        const sample = (x: number, y: number): [number, number, number] => {
          const d = ctx.getImageData(Math.max(0, Math.min(targetW - 1, x)), Math.max(0, Math.min(targetH - 1, y)), 1, 1).data;
          return [d[0], d[1], d[2]];
        };
        const corners: Array<{
          x0: number;
          y0: number;
          cx: number;
          cy: number;
          seedX: number;
          seedY: number;
          sampleA: [number, number];
          sampleB: [number, number];
        }> = [
          {
            x0: 0,
            y0: 0,
            cx: r,
            cy: r,
            seedX: 0,
            seedY: 0,
            sampleA: [R + edgeOffset, nearEdge],
            sampleB: [nearEdge, R + edgeOffset],
          },
          {
            x0: targetW - r,
            y0: 0,
            cx: targetW - r,
            cy: r,
            seedX: targetW - 1,
            seedY: 0,
            sampleA: [targetW - R - edgeOffset, nearEdge],
            sampleB: [targetW - nearEdge, R + edgeOffset],
          },
          {
            x0: 0,
            y0: targetH - r,
            cx: r,
            cy: targetH - r,
            seedX: 0,
            seedY: targetH - 1,
            sampleA: [R + edgeOffset, targetH - nearEdge],
            sampleB: [nearEdge, targetH - R - edgeOffset],
          },
          {
            x0: targetW - r,
            y0: targetH - r,
            cx: targetW - r,
            cy: targetH - r,
            seedX: targetW - 1,
            seedY: targetH - 1,
            sampleA: [targetW - R - edgeOffset, targetH - nearEdge],
            sampleB: [targetW - nearEdge, targetH - R - edgeOffset],
          },
        ];
        // Flutfüllung im RxR-Eckfeld um seedX/seedY: färbt alle zusammenhängenden Pixel außerhalb
        // des R-Viertelkreises, die näher an der Eckfarbe liegen als an der Rahmenfarbe, plus zwei
        // Pixel Saum (sonst bleibt der kantengeglättete Übergang als heller Schimmer stehen).
        const floodCorner = (
          seedX: number,
          seedY: number,
          fill: [number, number, number],
        ): void => {
          const bx = seedX === 0 ? 0 : targetW - R;
          const by = seedY === 0 ? 0 : targetH - R;
          // Mittelpunkt des R-Viertelkreises in Feldkoordinaten (die innere Ecke des Feldes).
          const mx = seedX === 0 ? R : 0;
          const my = seedY === 0 ? R : 0;
          const data = ctx.getImageData(bx, by, R, R);
          const px = data.data;
          const s = ((seedY - by) * R + (seedX - bx)) * 4;
          const bg = [px[s], px[s + 1], px[s + 2]];
          const dist = (i: number, c: ArrayLike<number>): number =>
            (px[i] - c[0]) ** 2 + (px[i + 1] - c[1]) ** 2 + (px[i + 2] - c[2]) ** 2;
          const inZwickel = (x: number, y: number): boolean =>
            (x + 0.5 - mx) ** 2 + (y + 0.5 - my) ** 2 > R * R;
          const mask = new Uint8Array(R * R);
          const stack = [(seedY - by) * R + (seedX - bx)];
          mask[stack[0]] = 1;
          while (stack.length) {
            const p = stack.pop()!;
            const x = p % R;
            const y = (p - x) / R;
            for (const [nx, ny] of [
              [x + 1, y],
              [x - 1, y],
              [x, y + 1],
              [x, y - 1],
            ]) {
              if (nx < 0 || ny < 0 || nx >= R || ny >= R) continue;
              const q = ny * R + nx;
              if (mask[q] || !inZwickel(nx, ny)) continue;
              if (dist(q * 4, bg) >= dist(q * 4, fill)) continue;
              mask[q] = 1;
              stack.push(q);
            }
          }
          for (let pass = 0; pass < 2; pass++) {
            const prev = mask.slice();
            for (let y = 0; y < R; y++) {
              for (let x = 0; x < R; x++) {
                const q = y * R + x;
                if (prev[q] || !inZwickel(x, y)) continue;
                if (
                  (x > 0 && prev[q - 1]) ||
                  (x < R - 1 && prev[q + 1]) ||
                  (y > 0 && prev[q - R]) ||
                  (y < R - 1 && prev[q + R])
                ) {
                  mask[q] = 1;
                }
              }
            }
          }
          for (let q = 0; q < R * R; q++) {
            if (!mask[q]) continue;
            px[q * 4] = fill[0];
            px[q * 4 + 1] = fill[1];
            px[q * 4 + 2] = fill[2];
          }
          ctx.putImageData(data, bx, by);
        };
        for (const c of corners) {
          const [ra, ga, ba] = sample(c.sampleA[0], c.sampleA[1]);
          const [rb, gb, bb] = sample(c.sampleB[0], c.sampleB[1]);
          const fill: [number, number, number] = [
            Math.round((ra + rb) / 2),
            Math.round((ga + gb) / 2),
            Math.round((ba + bb) / 2),
          ];
          floodCorner(c.seedX, c.seedY, fill);
          ctx.save();
          // Nur den "Zwickel" außerhalb der Kartenrundung füllen (Eckquadrat MINUS Rundungs-
          // Viertelkreis), nicht das ganze Eckquadrat - sonst würde die bereits gezeichnete
          // Kartenrundung selbst überdeckt. Umgesetzt per Clip mit "evenodd": Rechteck- und
          // Kreispfad überlappen sich innerhalb der Rundung, wodurch dort ein Loch entsteht und
          // nur der Zwickel zum Füllen übrig bleibt (frühere Version hat die Rundung stattdessen
          // mit destination-out komplett transparent "ausgestanzt" - beim JPEG-Export ohne
          // Alphakanal wurde daraus ein sichtbarer schwarzer Kreis).
          ctx.beginPath();
          ctx.rect(c.x0, c.y0, r, r);
          ctx.moveTo(c.cx + r, c.cy);
          ctx.arc(c.cx, c.cy, r, 0, Math.PI * 2);
          ctx.clip('evenodd');
          ctx.fillStyle = `rgb(${fill[0]}, ${fill[1]}, ${fill[2]})`;
          ctx.fillRect(c.x0, c.y0, r, r);
          ctx.restore();
        }
      }
      return canvas.toDataURL('image/jpeg', 0.9);
    } catch {
      // Im Zweifel lieber das Original verwenden als das Bild ganz zu verlieren.
      return dataUrl;
    }
  }

  async generatePdf(): Promise<void> {
    const selected = this.entries().filter((e) => e.selected && e.imageUrl);
    if (selected.length === 0) {
      this.errorMessage.set(this.i18n.t('pdfDialog.msg.noCardsSelected'));
      return;
    }

    this.busy.set(true);
    this.errorMessage.set('');

    // jsPDF erst hier per dynamischem Import nachladen statt fest im Hauptbundle - die Bibliothek
    // ist recht groß und wurde sonst von JEDEM Nutzer beim App-Start mitgeladen, obwohl kaum jemand
    // regelmäßig ein PDF exportiert (hat außerdem den Angular-Bundle-Budget-Grenzwert gesprengt und
    // den Produktions-Build fehlschlagen lassen).
    const { jsPDF } = await import('jspdf');

    // Jedes Bild nur einmal laden, auch wenn "jede Kopie einzeln" mehrfach dieselbe Karte braucht.
    // Rückseiten-URLs (doppelseitige Karten) zählen dabei genauso mit wie die Vorderseiten.
    const uniqueUrls = [
      ...new Set(
        selected.flatMap((e) => [e.imageUrl, e.backImageUrl].filter((u): u is string => !!u)),
      ),
    ];
    const imagesByUrl = new Map<string, string | null>();
    this.progress.set({ done: 0, total: uniqueUrls.length });

    const fillCorners = this.fillCorners();
    for (const url of uniqueUrls) {
      const raw = await kartenBildAlsDataUrl(url);
      imagesByUrl.set(url, raw ? await this.recompressForPrint(raw, fillCorners) : null);
      this.progress.update((p) => (p ? { ...p, done: p.done + 1 } : p));
    }

    const copiesMode = this.copiesMode();
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    let slot = 0;

    // x/y-Position der col-ten/row-ten Schnittlinie: an den äußeren Rasterkanten (col=0/COLUMNS
    // bzw. row=0/ROWS) direkt an der Kartenkante, dazwischen in der Mitte der jeweiligen
    // CARD_GAP_MM-Lücke zwischen zwei Karten.
    const verticalLineX = (col: number): number => {
      if (col === 0) return MARGIN_X_MM;
      if (col === COLUMNS) return MARGIN_X_MM + GRID_WIDTH_MM;
      return MARGIN_X_MM + col * CARD_WIDTH_MM + (col - 0.5) * CARD_GAP_MM;
    };
    const horizontalLineY = (row: number): number => {
      if (row === 0) return MARGIN_Y_MM;
      if (row === ROWS) return MARGIN_Y_MM + GRID_HEIGHT_MM;
      return MARGIN_Y_MM + row * CARD_HEIGHT_MM + (row - 0.5) * CARD_GAP_MM;
    };

    // Schnittmarken NUR im Rand außerhalb des Kartenrasters (nicht durchgehend über die ganze
    // Seite) - im Raster selbst ist die CARD_GAP_MM-Lücke zwischen den Karten (weißes Papier)
    // schon selbst die Schnittlinie, eine zusätzlich eingezeichnete Linie dort wäre bei aktiviertem
    // fillCorners (schwarz gefüllte Kartenecken) kaum noch zu erkennen ("schwarz auf schwarz").
    // Die Randmarken helfen beim geraden Weiterschneiden über die letzte Kartenreihe/-spalte
    // hinaus bis zum Papierrand.
    const drawCropMarks = (): void => {
      pdf.setDrawColor(0);
      pdf.setLineWidth(0.15);
      for (let col = 0; col <= COLUMNS; col++) {
        const x = verticalLineX(col);
        pdf.line(x, 0, x, MARGIN_Y_MM);
        pdf.line(x, PAGE_HEIGHT_MM - MARGIN_Y_MM, x, PAGE_HEIGHT_MM);
      }
      for (let row = 0; row <= ROWS; row++) {
        const y = horizontalLineY(row);
        pdf.line(0, y, MARGIN_X_MM, y);
        pdf.line(PAGE_WIDTH_MM - MARGIN_X_MM, y, PAGE_WIDTH_MM, y);
      }
    };
    drawCropMarks();

    const placeCard = (dataUrl: string): void => {
      if (slot > 0 && slot % (COLUMNS * ROWS) === 0) {
        pdf.addPage();
        drawCropMarks();
      }
      const posInPage = slot % (COLUMNS * ROWS);
      const col = posInPage % COLUMNS;
      const row = Math.floor(posInPage / COLUMNS);
      const x = MARGIN_X_MM + col * (CARD_WIDTH_MM + CARD_GAP_MM);
      const y = MARGIN_Y_MM + row * (CARD_HEIGHT_MM + CARD_GAP_MM);

      // png-Druckvariante hat echte Transparenz (abgerundete Ecken), normale/eigene Bilder sind JPEG -
      // das Format muss zum tatsächlichen Inhalt des Daten-URLs passen, sonst stellt jsPDF es falsch dar.
      const format = dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
      pdf.addImage(dataUrl, format, x, y, CARD_WIDTH_MM, CARD_HEIGHT_MM);

      slot++;
    };

    for (const entry of selected) {
      const dataUrl = imagesByUrl.get(entry.imageUrl!);
      if (!dataUrl) continue;
      const backDataUrl = entry.backImageUrl ? imagesByUrl.get(entry.backImageUrl) : null;

      const copies = copiesMode === 'all' ? entry.quantity : 1;
      for (let i = 0; i < copies; i++) {
        placeCard(dataUrl);
        if (backDataUrl) placeCard(backDataUrl);
      }
    }

    this.busy.set(false);
    this.progress.set(null);

    if (slot === 0) {
      this.errorMessage.set(this.i18n.t('pdfDialog.msg.noImagesLoaded'));
      return;
    }

    const fileName = `${
      this.deckName()
        .replace(/[^\w\-() ]+/g, '')
        .trim() || 'deck'
    }.pdf`;
    pdf.save(fileName);
    this.showDialog.set(false);
  }
}
