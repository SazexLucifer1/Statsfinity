import { Injectable, inject, signal } from '@angular/core';
import type { Worker as OcrWorker } from 'tesseract.js';
import { supabase } from './supabase.client';
import { ScryfallService } from './scryfall.service';
import {
  ART_HASH_FILE,
  TOKEN_ART_BOXES,
  TOKEN_ART_HASH_FILE,
  ArtBox,
  ArtHashIndex,
  ArtMatch,
  cardArtBoxes,
  cardArtQueries,
  cardArtQueriesWithoutGlare,
  CARD_ART_BOXES,
  ART_VERIFY_MIN,
  artMatchCertainty,
  artQueryBox,
  artSimilarity,
  decodeArtHashes,
  glareShare,
  nearestArt,
} from './art-hash';
import {
  CollectorLine,
  OcrWord,
  foilFromWords,
  languageFromText,
  parseCollectorLine,
} from './collector-line';
import { findCardCandidates } from './card-bounds';
import { CollectionPrint } from './collection-coverage';
import { toCollectionPrint } from './collection.service';

/**
 * Erkennt eine Karte aus einem Kamerabild (card-scanner/), ohne KI-Dienst, alles im Browser:
 *
 * 1. **Sammlerzeile** unten links (Set, Nummer, Sprache, • oder ★) per Texterkennung (Tesseract,
 *    lokal, Dateien unter /tesseract/). Daraus ist der Druck bei Scryfall eindeutig, samt Sprache.
 * 2. **Artwork-Fingerabdruck** (art-hash.ts) gegen alle ~55.000 Artworks aus dem Nachtlauf
 *    (scripts/sync-card-art-hashes.mjs). Für alte Karten ohne Sammlerzeile - und als Gegenprobe:
 *    Passt das Artwork des per Text gefundenen Drucks nicht zum Bild, war der Text verlesen.
 *
 * Die Sprache steht nur in der Sammlerzeile. Ohne sie (Karten vor ~2015) gilt die im Scanner
 * eingestellte Sprache.
 */

export interface ScanHit {
  print: CollectionPrint;
  foil: boolean;
  /** Woran erkannt - nur zur Anzeige. */
  via: 'text' | 'art';
}

const API = 'https://api.scryfall.com';

const COLLECTOR_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/•*★ ';

/** Ab diesem Anteil gespiegelter Pixel im Rahmen wird zusätzlich ohne die Flecken gerechnet. */
const GLARE_MIN = 0.002;
/** Ab diesem Anteil zeigt der Scanner den Hinweis, die Karte zu kippen. */
const GLARE_HINT = 0.01;

/** Bereich der Sammlerzeile auf der Karte (Anteile), großzügig wegen ungenauem Anlegen. */
const COLLECTOR_BOX = [0.0, 0.875, 0.56, 0.99] as const;

@Injectable({ providedIn: 'root' })
export class CardScanService {
  private readonly scryfall = inject(ScryfallService);

  /** false, solange die Fingerabdruck-Datei fehlt (Nachtlauf noch nicht gelaufen). */
  readonly artIndexAvailable = signal(false);

  private index: ArtHashIndex | null = null;
  /** Marken in eigener Datei (siehe TOKEN_ART_BOXES); null = (noch) nicht vorhanden. */
  private tokenIndex: ArtHashIndex | null = null;
  private indexPromise: Promise<void> | null = null;
  private worker: OcrWorker | null = null;
  private workerPromise: Promise<OcrWorker | null> | null = null;
  private readonly cardCache = new Map<string, any>();
  private readonly artCache = new Map<string, ImageData>();

  /** Spiegelt die Karte im Rahmen gerade deutlich (Foil, Hülle, Lampe)? Für den Hinweis im Scanner. */
  readonly glare = signal(false);

  /** Lädt Fingerabdrücke und Texterkennung (beim Öffnen des Scanners, parallel zur Kamera). */
  async prepare(): Promise<void> {
    await Promise.all([this.loadIndex(), this.loadWorker()]);
  }

  private loadIndex(): Promise<void> {
    this.indexPromise ??= (async () => {
      try {
        const urlOf = (file: string) =>
          supabase.storage.from('card-art-hashes').getPublicUrl(file).data.publicUrl;
        // Die Marken-Datei ist klein und optional - fehlt sie, werden eben keine Marken erkannt.
        void fetch(urlOf(TOKEN_ART_HASH_FILE))
          .then(async (r) => (r.ok ? decodeArtHashes(await r.arrayBuffer()) : null))
          .then((index) => (this.tokenIndex = index))
          .catch(() => undefined);
        const res = await fetch(urlOf(ART_HASH_FILE));
        if (!res.ok) return;
        this.index = decodeArtHashes(await res.arrayBuffer());
        this.artIndexAvailable.set(this.index.count > 0);
      } catch (e) {
        console.warn('Artwork-Fingerabdrücke nicht geladen:', e);
      } finally {
        // Bei Fehlschlag beim nächsten Öffnen erneut versuchen.
        if (!this.index) this.indexPromise = null;
      }
    })();
    return this.indexPromise;
  }

  private loadWorker(): Promise<OcrWorker | null> {
    this.workerPromise ??= (async () => {
      try {
        const { createWorker } = await import('tesseract.js');
        const base = new URL('tesseract/', document.baseURI).href;
        const worker = await createWorker('eng', 1, {
          workerPath: `${base}worker.min.js`,
          corePath: base,
          langPath: base.replace(/\/$/, ''),
          gzip: true,
          // Ein Worker aus einer blob:-Adresse bräuchte eine Ausnahme in der CSP.
          workerBlobURL: false,
        });
        this.worker = worker;
        return worker;
      } catch (e) {
        console.warn('Texterkennung nicht geladen:', e);
        this.workerPromise = null;
        return null;
      }
    })();
    return this.workerPromise;
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.workerPromise = null;
    await worker?.terminate();
  }

  /**
   * Erkennt die Karte auf `frame` - einem Ausschnitt um den Scanner-Rahmen herum, etwas größer als
   * dieser. `guide` ist der Rahmen selbst in Anteilen von `frame`. `fallbackLang` gilt, wenn keine
   * Sammlerzeile lesbar ist.
   */
  async identify(
    frame: HTMLCanvasElement,
    guide: ArtBox,
    fallbackLang: string,
  ): Promise<ScanHit | null> {
    // Zwei Annahmen, wo die Karte liegt: wo die Kantensuche sie findet (card-bounds.ts) und genau
    // im Rahmen. Die Kantensuche irrt, wenn sich der Kartenrand kaum vom Untergrund abhebt - mit
    // dem Rahmen als zweiter Annahme kann sie nichts verschlechtern, nur verbessern.
    const found = this.findCard(frame);
    const boxes: ArtBox[] = [...found, guide];

    const art = await this.matchArt(frame, boxes, guide);
    const artId = art?.match.id ?? null;

    // Die ergiebigere Lesung gewinnt: Set + Nummer zählen doppelt (eindeutiger Druck), die
    // Sprache einfach (reicht zusammen mit dem Artwork für die richtige Fassung).
    const score = (l: CollectorLine) => (l.setCode && l.collectorNumber ? 2 : 0) + (l.lang ? 1 : 0);
    let line = parseCollectorLine('');
    let words: OcrWord[] = [];
    // Texterkennung kostet je Versuch spürbar Zeit: nur die wahrscheinlichste Lage und der Rahmen.
    for (const box of found.length ? [found[0], guide] : [guide]) {
      const read = await this.readCollectorLine(crop(frame, box));
      const parsed = parseCollectorLine(read.text);
      if (score(parsed) > score(line)) {
        line = parsed;
        words = read.words;
      }
      if (score(line) === 3) break;
    }
    const detectedFoil = foilFromWords(words);

    // Die Sammlerzeile ist gut 1 mm hoch und auf dem iPhone fast nie lesbar - dann die Sprache aus
    // Name, Typzeile und Regeltext der per Artwork erkannten Karte (languageFromText()).
    if (!line.lang && art) {
      line = { ...line, lang: await this.languageFromCard(frame, art.cardBox, art.match.id) };
    }

    let print: CollectionPrint | null = null;
    let via: ScanHit['via'] = 'text';
    if (line.setCode && line.collectorNumber) {
      const byText = await this.cardBy(
        `${API}/cards/${line.setCode}/${line.collectorNumber}${line.lang ? `/${line.lang}` : ''}`,
      );
      if (byText) {
        const textPrint = toCollectionPrint(byText);
        const artCard = artId ? await this.cardBy(`${API}/cards/${artId}`) : null;
        const artIll = artCard ? toCollectionPrint(artCard).illustrationId : null;
        // Gegenprobe: Ein sicherer Artwork-Treffer mit anderem Bild heißt, der Text war verlesen.
        if (!artIll || artIll === textPrint.illustrationId) print = textPrint;
      }
    }
    if (!print && artId) {
      print = await this.printForArt(artId, line.lang ?? fallbackLang);
      via = 'art';
    }
    if (!print) return null;

    const canNonfoil = print.finishes.includes('nonfoil');
    const canFoil = print.finishes.some((f) => f !== 'nonfoil');
    const foil = !canNonfoil ? true : !canFoil ? false : (detectedFoil ?? false);
    return { print, foil, via };
  }

  /** Mögliche Lagen der Karte in `frame` (Anteile), Kantensuche auf einem verkleinerten Graubild. */
  private findCard(frame: HTMLCanvasElement): ArtBox[] {
    const probe = scaled(frame, 300);
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    const rgba = ctx.getImageData(0, 0, probe.width, probe.height).data;
    const gray = new Uint8Array(probe.width * probe.height);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    }
    return findCardCandidates(gray, probe.width, probe.height);
  }

  /**
   * Bester Artwork-Treffer über alle Annahmen zur Kartenlage. Gerechnet auf einer Kopie mit
   * höchstens 900 px Breite - die Vorlagen (art_crop) sind ohnehin nur ~600 px breit, und in voller
   * Kameraauflösung kosteten die ~170 Fingerabdrücke je Versuch auf dem Handy spürbar Zeit.
   */
  private async matchArt(
    frame: HTMLCanvasElement,
    boxes: ArtBox[],
    guide: ArtBox,
  ): Promise<{ match: ArtMatch; cardBox: ArtBox } | null> {
    if (!this.index || this.index.count === 0) return null;
    const small = frame.width > 900 ? scaled(frame, 900) : frame;
    const ctx = small.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const { data, width, height } = ctx.getImageData(0, 0, small.width, small.height);
    // Spiegelt die Karte (Foil, Hülle), zusätzlich ohne die ausgefressenen Flecken rechnen.
    const glare = glareShare(data, width, height, 4, guide);
    this.glare.set(glare >= GLARE_HINT);
    const withoutGlare = glare >= GLARE_MIN;
    // Erst die Karten; nur ohne sicheren Treffer die Marken - mit eigenen Lagen gegen ihre eigene,
    // kleine Datei, damit die zusätzliche Lage keine Zufallstreffer unter echten Karten erzeugt.
    const tries: [ArtHashIndex | null, readonly ArtBox[]][] = [
      [this.index, CARD_ART_BOXES],
      [this.tokenIndex, TOKEN_ART_BOXES],
    ];
    for (const [index, artBoxes] of tries) {
      if (!index || index.count === 0) continue;
      const queries = boxes.flatMap((box) => cardArtQueries(data, width, height, 4, box, artBoxes));
      const plain = queries.length;
      if (withoutGlare) {
        queries.push(
          ...boxes.flatMap((box) =>
            cardArtQueriesWithoutGlare(data, width, height, 4, box, artBoxes),
          ),
        );
      }
      const match = nearestArt(index, queries);
      const certainty = match && artMatchCertainty(match);
      if (!match || !certainty) continue;
      // Fingerabdruck i gehört zu Kartenlage i / artBoxes.length, in beiden Hälften gleich.
      const query = match.query % plain;
      const perBox = plain / boxes.length;
      const card = boxes[Math.floor(query / perBox)];
      if (certainty === 'verify') {
        const ref = await this.artCrop(match.id);
        const box = artQueryBox(card, query % perBox, artBoxes);
        if (
          !ref ||
          artSimilarity(data, width, height, 4, box, ref.data, ref.width, ref.height, 4) <
            ART_VERIFY_MIN
        ) {
          continue;
        }
      }
      // Die Lage, deren Fingerabdruck am besten passte, ist die genaueste Angabe, wo die Karte liegt.
      const cardBox = boxes.flatMap((box) => cardArtBoxes(box))[
        Math.floor(query / artBoxes.length)
      ];
      return { match, cardBox };
    }
    return null;
  }

  /** Scryfalls Artwork-Ausschnitt eines Drucks als Pixel, klein gerechnet (für die Nachprüfung). */
  private async artCrop(id: string): Promise<ImageData | null> {
    if (this.artCache.has(id)) return this.artCache.get(id)!;
    const card = await this.cardBy(`${API}/cards/${id}`);
    const url: string | undefined =
      card?.image_uris?.art_crop ?? card?.card_faces?.[0]?.image_uris?.art_crop;
    if (!url) return null;
    const pixels = await new Promise<ImageData | null>((resolve) => {
      const img = new Image();
      // Scryfall erlaubt das; ohne crossOrigin wäre das Canvas danach nicht mehr auslesbar.
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = Math.max(1, Math.round((img.naturalHeight * 256) / img.naturalWidth));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(ctx?.getImageData(0, 0, canvas.width, canvas.height) ?? null);
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    if (pixels) this.artCache.set(id, pixels);
    return pixels;
  }

  /**
   * Sprache der Karte aus ihrem lesbaren Text, unter den Sprachen, in denen es genau dieses
   * Artwork gibt. null, wenn es nur eine gibt (dann ist die Frage entschieden) oder keine klar
   * vorn liegt.
   */
  private async languageFromCard(
    frame: HTMLCanvasElement,
    cardBox: ArtBox,
    artId: string,
  ): Promise<string | null> {
    const candidates = await this.languagesOf(artId);
    if (candidates.length < 2) return candidates[0]?.lang ?? null;
    const worker = await this.loadWorker();
    if (!worker) return null;
    const { PSM } = await import('tesseract.js');
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      tessedit_char_whitelist: '',
    });
    const card = crop(frame, cardBox);
    let text = '';
    // Name oben, Typzeile und Regeltext unten - das Artwork dazwischen liefert nur Rauschen.
    for (const [t, b] of [
      [0, 0.16],
      [0.5, 0.92],
    ]) {
      const band = document.createElement('canvas');
      band.width = 900;
      band.height = Math.round(((b - t) * card.height * 900) / card.width);
      const ctx = band.getContext('2d');
      if (!ctx) continue;
      ctx.filter = 'grayscale(1) contrast(1.3)';
      ctx.drawImage(
        card,
        0,
        t * card.height,
        card.width,
        (b - t) * card.height,
        0,
        0,
        band.width,
        band.height,
      );
      text += (await worker.recognize(band)).data.text + '\n';
    }
    return languageFromText(text, candidates);
  }

  /** Sprachen (mit gedrucktem Namen), in denen es das Artwork dieses Drucks gibt. */
  private async languagesOf(artId: string): Promise<{ lang: string; name: string }[]> {
    const base = await this.cardBy(`${API}/cards/${artId}`);
    if (!base?.oracle_id) return [];
    const illustration = toCollectionPrint(base).illustrationId;
    const q = encodeURIComponent(`oracleid:${base.oracle_id} -is:digital include:extras`);
    const list = await this.cardBy(
      `${API}/cards/search?q=${q}&unique=prints&include_multilingual=true`,
    );
    const seen = new Map<string, string>();
    for (const c of (list?.data as any[]) ?? []) {
      const print = toCollectionPrint(c);
      if (print.illustrationId === illustration && !seen.has(print.lang)) {
        seen.set(print.lang, print.printedName ?? print.cardName);
      }
    }
    return [...seen].map(([lang, name]) => ({ lang, name }));
  }

  /** Texterkennung auf der Sammlerzeile, vergrößert und in Graustufen. */
  private async readCollectorLine(
    card: HTMLCanvasElement,
  ): Promise<{ text: string; words: OcrWord[] }> {
    const none = { text: '', words: [] };
    const worker = await this.loadWorker();
    if (!worker) return none;
    // Jedes Mal setzen: languageFromCard() liest dazwischen Fließtext mit anderen Einstellungen.
    const { PSM } = await import('tesseract.js');
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      tessedit_char_whitelist: COLLECTOR_CHARS,
    });
    const [l, t, r, b] = COLLECTOR_BOX;
    const sx = l * card.width;
    const sy = t * card.height;
    const sw = (r - l) * card.width;
    const sh = (b - t) * card.height;
    const crop = document.createElement('canvas');
    crop.width = 900;
    crop.height = Math.round((sh * 900) / sw);
    const ctx = crop.getContext('2d');
    if (!ctx) return none;
    ctx.filter = 'grayscale(1) contrast(1.4)';
    ctx.drawImage(card, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
    const { data } = await worker.recognize(crop, {}, { blocks: true, text: true });
    const words: OcrWord[] = [];
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          for (const word of line.words) words.push({ text: word.text, bbox: word.bbox });
        }
      }
    }
    return { text: data.text ?? '', words };
  }

  /** Der Druck mit diesem Artwork in der gewünschten Sprache - sonst der aus dem Fingerabdruck. */
  private async printForArt(artId: string, lang: string): Promise<CollectionPrint | null> {
    const base = await this.cardBy(`${API}/cards/${artId}`);
    if (!base) return null;
    const basePrint = toCollectionPrint(base);
    if (basePrint.lang === lang || !base.oracle_id) return basePrint;
    const q = encodeURIComponent(
      `oracleid:${base.oracle_id} lang:${lang} -is:digital include:extras`,
    );
    const res = await this.scryfall.fetchWithRetry(
      `${API}/cards/search?q=${q}&unique=prints&order=released`,
      1,
    );
    if (res?.ok) {
      const prints = (((await res.json()).data as any[]) ?? []).map(toCollectionPrint);
      const same =
        prints.find(
          (p) => p.illustrationId === basePrint.illustrationId && p.setCode === basePrint.setCode,
        ) ?? prints.find((p) => p.illustrationId === basePrint.illustrationId);
      if (same) return same;
    }
    return basePrint;
  }

  private async cardBy(url: string): Promise<any | null> {
    if (this.cardCache.has(url)) return this.cardCache.get(url);
    const res = await this.scryfall.fetchWithRetry(url, 1);
    if (!res) return null; // Netzfehler: nicht merken, beim nächsten Scan erneut fragen
    const card = res.ok ? await res.json() : null;
    this.cardCache.set(url, card);
    return card;
  }
}

/** Ausschnitt `box` (Anteile) von `source` als eigenes Canvas. */
function crop(source: HTMLCanvasElement, box: ArtBox): HTMLCanvasElement {
  const sx = Math.max(0, box[0] * source.width);
  const sy = Math.max(0, box[1] * source.height);
  const sw = Math.min(source.width - sx, (box[2] - box[0]) * source.width);
  const sh = Math.min(source.height - sy, (box[3] - box[1]) * source.height);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sw));
  out.height = Math.max(1, Math.round(sh));
  out.getContext('2d')?.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

/** Verkleinerte Kopie mit `width` Pixeln Breite. */
function scaled(source: HTMLCanvasElement, width: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = Math.round((source.height * width) / source.width);
  out.getContext('2d')?.drawImage(source, 0, 0, out.width, out.height);
  return out;
}
