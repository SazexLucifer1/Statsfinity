import { Injectable, inject, signal } from '@angular/core';
import type { Worker as OcrWorker } from 'tesseract.js';
import { supabase } from './supabase.client';
import { ScryfallService } from './scryfall.service';
import {
  ART_HASH_FILE,
  ART_MATCH_MAX_DISTANCE,
  ArtHashIndex,
  CARD_ART_BOXES,
  decodeArtHashes,
  grayGrid,
  nearestArt,
  phash,
} from './art-hash';
import { CollectorLine, OcrWord, foilFromWords, parseCollectorLine } from './collector-line';
import { findCardBounds } from './card-bounds';
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

/** Bereich der Sammlerzeile auf der Karte (Anteile), großzügig wegen ungenauem Anlegen. */
const COLLECTOR_BOX = [0.0, 0.875, 0.56, 0.99] as const;

@Injectable({ providedIn: 'root' })
export class CardScanService {
  private readonly scryfall = inject(ScryfallService);

  /** false, solange die Fingerabdruck-Datei fehlt (Nachtlauf noch nicht gelaufen). */
  readonly artIndexAvailable = signal(false);

  private index: ArtHashIndex | null = null;
  private indexPromise: Promise<void> | null = null;
  private worker: OcrWorker | null = null;
  private workerPromise: Promise<OcrWorker | null> | null = null;
  private readonly cardCache = new Map<string, any>();

  /** Lädt Fingerabdrücke und Texterkennung (beim Öffnen des Scanners, parallel zur Kamera). */
  async prepare(): Promise<void> {
    await Promise.all([this.loadIndex(), this.loadWorker()]);
  }

  private loadIndex(): Promise<void> {
    this.indexPromise ??= (async () => {
      try {
        const url = supabase.storage.from('card-art-hashes').getPublicUrl(ART_HASH_FILE)
          .data.publicUrl;
        const res = await fetch(url);
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
        const { createWorker, PSM } = await import('tesseract.js');
        const base = new URL('tesseract/', document.baseURI).href;
        const worker = await createWorker('eng', 1, {
          workerPath: `${base}worker.min.js`,
          corePath: base,
          langPath: base.replace(/\/$/, ''),
          gzip: true,
          // Ein Worker aus einer blob:-Adresse bräuchte eine Ausnahme in der CSP.
          workerBlobURL: false,
        });
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/•*★ ',
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
   * Erkennt die Karte auf `card` (Ausschnitt genau um die Karte, hochkant). `fallbackLang` gilt,
   * wenn keine Sammlerzeile lesbar ist.
   */
  async identify(frame: HTMLCanvasElement, fallbackLang: string): Promise<ScanHit | null> {
    // Zwei Ausschnitte: die im Rahmen gefundene Karte und der Rahmen selbst. Die Kantensuche
    // irrt, wenn sich der Kartenrand kaum vom Untergrund abhebt (dann nimmt sie eine innere
    // Kante und schneidet die Sammlerzeile ab) - mit dem Rahmen als zweitem Versuch kann sie
    // nichts verschlechtern, nur verbessern.
    const card = this.cropToCard(frame);
    const crops = card === frame ? [frame] : [card, frame];

    const queries = crops.flatMap((crop) => {
      const ctx = crop.getContext('2d', { willReadFrequently: true });
      if (!ctx) return [];
      const { data, width, height } = ctx.getImageData(0, 0, crop.width, crop.height);
      return CARD_ART_BOXES.map((box) => phash(grayGrid(data, width, height, 4, box)));
    });
    const art =
      this.index && this.index.count > 0 && queries.length ? nearestArt(this.index, queries) : null;
    const artId = art && art.distance <= ART_MATCH_MAX_DISTANCE ? art.id : null;

    // Die ergiebigere Lesung gewinnt: Set + Nummer zählen doppelt (eindeutiger Druck), die
    // Sprache einfach (reicht zusammen mit dem Artwork für die richtige Fassung).
    const score = (l: CollectorLine) => (l.setCode && l.collectorNumber ? 2 : 0) + (l.lang ? 1 : 0);
    let line = parseCollectorLine('');
    let words: OcrWord[] = [];
    for (const crop of crops) {
      const read = await this.readCollectorLine(crop);
      const parsed = parseCollectorLine(read.text);
      if (score(parsed) > score(line)) {
        line = parsed;
        words = read.words;
      }
      if (score(line) === 3) break;
    }
    const detectedFoil = foilFromWords(words);

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

  /**
   * Schneidet den Rahmen-Ausschnitt auf die Karte zu, die darin liegt (card-bounds.ts). Alle
   * Lagen - Sammlerzeile, Artwork - sind Anteile der KARTE; in der Hand liegt sie fast nie genau
   * im Rahmen. Findet sich keine Karte, bleibt es beim Rahmen.
   */
  private cropToCard(frame: HTMLCanvasElement): HTMLCanvasElement {
    const probe = document.createElement('canvas');
    probe.width = 200;
    probe.height = Math.round((frame.height * 200) / frame.width);
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    if (!pctx) return frame;
    pctx.drawImage(frame, 0, 0, probe.width, probe.height);
    const rgba = pctx.getImageData(0, 0, probe.width, probe.height).data;
    const gray = new Uint8Array(probe.width * probe.height);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    }
    const bounds = findCardBounds(gray, probe.width, probe.height);
    if (!bounds) return frame;
    const sx = bounds[0] * frame.width;
    const sy = bounds[1] * frame.height;
    const sw = (bounds[2] - bounds[0]) * frame.width;
    const sh = (bounds[3] - bounds[1]) * frame.height;
    const out = document.createElement('canvas');
    out.width = Math.round(sw);
    out.height = Math.round(sh);
    out.getContext('2d')?.drawImage(frame, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out;
  }

  /** Texterkennung auf der Sammlerzeile, vergrößert und in Graustufen. */
  private async readCollectorLine(
    card: HTMLCanvasElement,
  ): Promise<{ text: string; words: OcrWord[] }> {
    const none = { text: '', words: [] };
    const worker = await this.loadWorker();
    if (!worker) return none;
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
