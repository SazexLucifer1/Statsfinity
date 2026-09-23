import { Injectable, computed, inject, signal } from '@angular/core';
import { I18nService } from './i18n.service';
import { kartenBildAlsDataUrl } from './card-image-datauri';
import { ScryfallPrinting, ScryfallService } from './scryfall.service';
import { supabase } from './supabase.client';
import { DeckCopyArtworks } from './models';

export interface PdfSourceCard {
  cardName: string;
  quantity: number;
  imageUrl: string | null;
  backImageUrl: string | null;
  /** Für die Artwork-Suche (getPrintings) - Marken werden über die Oracle-ID gesucht. */
  isToken?: boolean;
  oracleId?: string | null;
}

export interface PdfCardEntry {
  cardName: string;
  quantity: number;
  imageUrl: string | null;
  backImageUrl: string | null;
  selected: boolean;
  isToken: boolean;
  oracleId: string | null;
  /** Ein Eintrag je Exemplar, null = normales Artwork (imageUrl). Siehe DeckCopyArtworks. */
  copyArtworks: (string | null)[];
}

/** Ob sich für diese Karte je Exemplar ein Artwork wählen lässt. Doppelseitige Karten nicht: Zum gewählten Vorderseiten-Druck fehlte die passende Rückseite. */
export function hatExemplarArtworks(entry: PdfCardEntry): boolean {
  return entry.quantity > 1 && !!entry.imageUrl && !entry.backImageUrl;
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
  private readonly scryfall = inject(ScryfallService);

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

  /** Zahl der Bilder, die tatsächlich im PDF landen - mit eigenen Artworks je Exemplar weicht sie von selectedCount() ab. */
  readonly printCount = computed(() =>
    this.entries()
      .filter((e) => e.selected && e.imageUrl)
      .reduce((sum, e) => sum + this.copyImages(e).length * (e.backImageUrl ? 2 : 1), 0),
  );

  // --- Artwork je Exemplar -------------------------------------------------------------------

  /** Karte (Name), deren Exemplare gerade aufgeklappt sind - immer höchstens eine. */
  readonly expandedCard = signal<string | null>(null);
  /** Offene Artwork-Auswahl für genau ein Exemplar. */
  readonly picker = signal<{ cardName: string; copyIndex: number } | null>(null);
  readonly printingsLoading = signal(false);
  /** Drucke je Kartenname (klein) - einmal je Sitzung geladen, auch über mehrere Dialoge hinweg. */
  private readonly printingsCache = new Map<string, ScryfallPrinting[]>();
  readonly printings = signal<ScryfallPrinting[]>([]);

  /** Deck, zu dem die Auswahl gespeichert wird; null = nur für diesen Druck (fremdes Deck). */
  private deckId: string | null = null;
  private dirty = false;
  /** Fehlt sql/deck-exemplar-artworks-2026-09-23.sql, bleibt die Auswahl einfach ungespeichert. */
  private static spalteVerfuegbar = true;

  /**
   * Reihenfolge kommt unverändert vom Aufrufer (Deck-Gruppierung wie beim Deckbauen) - hier bewusst
   * NICHT alphabetisch sortieren. `deckId` lädt die gespeicherte Artwork-Auswahl je Exemplar;
   * `canSave` entscheidet, ob Änderungen daran zurück ins Deck geschrieben werden.
   */
  open(deckName: string, cards: PdfSourceCard[], options?: { deckId?: string; canSave?: boolean }): void {
    this.deckName.set(deckName);
    this.entries.set(
      cards.map((c) => ({
        cardName: c.cardName,
        quantity: c.quantity,
        imageUrl: c.imageUrl,
        backImageUrl: c.backImageUrl,
        selected: true,
        isToken: c.isToken ?? false,
        oracleId: c.oracleId ?? null,
        copyArtworks: Array(c.quantity).fill(null),
      }))
    );
    this.copiesMode.set('one');
    this.fillCorners.set(false);
    this.busy.set(false);
    this.progress.set(null);
    this.errorMessage.set('');
    this.expandedCard.set(null);
    this.picker.set(null);
    this.dirty = false;
    this.deckId = options?.canSave ? (options.deckId ?? null) : null;
    this.showDialog.set(true);
    if (options?.deckId) void this.loadCopyArtworks(options.deckId);
  }

  close(): void {
    this.picker.set(null);
    this.showDialog.set(false);
    void this.saveCopyArtworks();
  }

  private async loadCopyArtworks(deckId: string): Promise<void> {
    if (!DeckPdfService.spalteVerfuegbar) return;
    const { data, error } = await supabase.from('decks').select('copy_artworks').eq('id', deckId).maybeSingle();
    if (error) {
      if (this.spalteFehlt(error)) return;
      console.error('Konnte Artworks je Exemplar nicht laden:', error);
      return;
    }
    const stored = ((data as { copy_artworks?: DeckCopyArtworks | null } | null)?.copy_artworks ?? {}) as DeckCopyArtworks;
    // Der Nutzer hat inzwischen selbst gewählt - dann gewinnt seine Auswahl, nicht die späte Antwort.
    if (this.dirty) return;
    this.entries.update((list) =>
      list.map((e) => {
        const saved = stored[e.cardName.toLowerCase()];
        if (!Array.isArray(saved) || !hatExemplarArtworks(e)) return e;
        // Auf die aktuelle Anzahl zuschneiden bzw. auffüllen: Aus 10 Forests können inzwischen 8 geworden sein.
        const copyArtworks = Array.from({ length: e.quantity }, (_, i) =>
          typeof saved[i] === 'string' ? saved[i] : null,
        );
        return { ...e, copyArtworks };
      }),
    );
  }

  /**
   * Schreibt die Auswahl zurück ins Deck - aber nur die Karten dieses Dialogs: Der Druck einer
   * einzelnen Bearbeitung (printChangeGroup) enthält nur einen Teil des Decks, die übrigen Karten
   * behalten ihre gespeicherte Auswahl.
   */
  private async saveCopyArtworks(): Promise<void> {
    const deckId = this.deckId;
    if (!deckId || !this.dirty || !DeckPdfService.spalteVerfuegbar) return;
    this.dirty = false;
    const { data, error } = await supabase.from('decks').select('copy_artworks').eq('id', deckId).maybeSingle();
    if (error) {
      if (!this.spalteFehlt(error)) console.error('Konnte Artworks je Exemplar nicht laden:', error);
      return;
    }
    const merged: DeckCopyArtworks = { ...((data as { copy_artworks?: DeckCopyArtworks | null } | null)?.copy_artworks ?? {}) };
    for (const e of this.entries()) {
      const key = e.cardName.toLowerCase();
      if (e.copyArtworks.some((u) => u)) merged[key] = e.copyArtworks;
      else delete merged[key];
    }
    // updated_at bleibt unangetastet (wie beim Primer): Ein anderes Druck-Artwork ändert das Deck nicht.
    const { error: saveError } = await supabase
      .from('decks')
      .update({ copy_artworks: Object.keys(merged).length ? merged : null })
      .eq('id', deckId);
    if (saveError && !this.spalteFehlt(saveError)) console.error('Konnte Artworks je Exemplar nicht speichern:', saveError);
  }

  private spalteFehlt(error: { code?: string }): boolean {
    if (error.code !== '42703' && error.code !== 'PGRST204') return false;
    DeckPdfService.spalteVerfuegbar = false;
    return true;
  }

  toggleExpanded(cardName: string): void {
    this.picker.set(null);
    this.expandedCard.update((c) => (c === cardName ? null : cardName));
  }

  /** Bild, das ein Exemplar gerade trägt (eigene Wahl oder das normale Artwork). */
  copyImage(entry: PdfCardEntry, index: number): string | null {
    return entry.copyArtworks[index] ?? entry.imageUrl;
  }

  /**
   * Bilder dieser Karte in Druckreihenfolge. "Jede Kopie einzeln" druckt jedes Exemplar mit seinem
   * Artwork; "Nur 1 Bild" druckt jedes VERSCHIEDENE Artwork einmal - wer drei Nazgûl-Artworks
   * gewählt hat, will sie auch im sparsamen Modus alle sehen.
   */
  private copyImages(entry: PdfCardEntry): string[] {
    if (!entry.imageUrl) return [];
    const all = Array.from({ length: entry.quantity }, (_, i) => this.copyImage(entry, i)!);
    return this.copiesMode() === 'all' ? all : [...new Set(all)];
  }

  private async ensurePrintings(entry: PdfCardEntry): Promise<ScryfallPrinting[]> {
    const key = entry.cardName.toLowerCase();
    const cached = this.printingsCache.get(key);
    if (cached) return cached;
    this.printingsLoading.set(true);
    try {
      const list = await this.scryfall.getPrintings(entry.cardName, { isToken: entry.isToken, oracleId: entry.oracleId });
      if (list.length) this.printingsCache.set(key, list);
      return list;
    } finally {
      this.printingsLoading.set(false);
    }
  }

  async openPicker(entry: PdfCardEntry, copyIndex: number): Promise<void> {
    this.picker.set({ cardName: entry.cardName, copyIndex });
    this.printings.set([]);
    const list = await this.ensurePrintings(entry);
    if (this.picker()?.cardName === entry.cardName) this.printings.set(list);
  }

  closePicker(): void {
    this.picker.set(null);
  }

  /** `imageUrl` null = zurück zum normalen Artwork des Decks. */
  chooseArtwork(imageUrl: string | null): void {
    const p = this.picker();
    if (!p) return;
    this.updateCopies(p.cardName, (entry) =>
      entry.copyArtworks.map((u, i) => (i === p.copyIndex ? (imageUrl === entry.imageUrl ? null : imageUrl) : u)),
    );
    this.picker.set(null);
  }

  /**
   * Verteilt verschiedene Artworks auf alle Exemplare: Das erste behält das Artwork des Decks, die
   * übrigen bekommen der Reihe nach die neuesten anderen Drucke. Gibt es weniger Drucke als
   * Exemplare, beginnt die Reihe von vorn.
   */
  async distributeArtworks(entry: PdfCardEntry): Promise<void> {
    const list = await this.ensurePrintings(entry);
    const others = [...new Set(list.map((p) => p.imageUrl!).filter((u) => u !== entry.imageUrl))];
    if (others.length === 0) return;
    this.updateCopies(entry.cardName, (e) => e.copyArtworks.map((_, i) => (i === 0 ? null : others[(i - 1) % others.length])));
  }

  resetArtworks(entry: PdfCardEntry): void {
    this.updateCopies(entry.cardName, (e) => e.copyArtworks.map(() => null));
  }

  private updateCopies(cardName: string, fn: (entry: PdfCardEntry) => (string | null)[]): void {
    this.dirty = true;
    this.entries.update((list) => list.map((e) => (e.cardName === cardName ? { ...e, copyArtworks: fn(e) } : e)));
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
        selected.flatMap((e) => [...this.copyImages(e), e.backImageUrl].filter((u): u is string => !!u)),
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
      const backDataUrl = entry.backImageUrl ? imagesByUrl.get(entry.backImageUrl) : null;
      for (const url of this.copyImages(entry)) {
        // Ein eigenes Artwork, das nicht lädt, fällt auf das normale zurück statt das Exemplar zu verlieren.
        const dataUrl = imagesByUrl.get(url) ?? imagesByUrl.get(entry.imageUrl!);
        if (!dataUrl) continue;
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
    this.close();
  }
}
