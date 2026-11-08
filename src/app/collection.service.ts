import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { ScryfallService } from './scryfall.service';
import {
  CardCondition,
  CollectionEntry,
  CollectionPrint,
  DeckUsage,
  collectionKey,
  printImageUrl,
} from './collection-coverage';

/**
 * Kartensammlung (Profil -> Reiter "Sammlung", Scanner, Abgleich in der Deck-Ansicht).
 * Tabelle und Begründung der schlanken Form: sql/sammlung-2026-10-17.sql.
 *
 * Kartendaten (Bild, gedruckter Name, Setname) kommen NICHT aus der Datenbank, sondern bei Bedarf
 * von Scryfall - das Bild lässt sich ohnehin aus der Druck-ID bauen. Fehlt die Migration, schaltet
 * sich alles beim ersten 42P01/PGRST205 still ab (`available`).
 */

/** Was Scryfall je Druck zusätzlich weiß (siehe printInfo()). */
export interface PrintInfo {
  illustrationId: string | null;
  rarity: string | null;
  setName: string | null;
  eur: number | null;
  eurFoil: number | null;
  /** Scryfalls Legalitäten der Karte je Format-Schlüssel ("commander" -> "legal"). */
  legalities: Record<string, string>;
  /** true = Preis des englischen Drucks (Scryfall führt für andere Sprachen keine Preise). */
  priceFromEnglish: boolean;
  /**
   * Cardmarket aus der täglichen Preisdatei (sql/cardmarket-preise-zustand-2026-11-08.sql):
   * Durchschnitt der letzten 7 Tage und günstigstes Angebot, je normal und Foil. Ein
   * Cardmarket-Produkt umfasst alle Sprachen - kein „≈“ nötig. Fehlt ohne Migration/Nachtlauf.
   */
  cmAvg7?: number | null;
  cmAvg7Foil?: number | null;
  cmLow?: number | null;
  cmLowFoil?: number | null;
  /** Weitere Werte für die wählbare Preisbasis (sql/sammlung-preisbasis-2026-11-08.sql). */
  cmAvg1?: number | null;
  cmAvg1Foil?: number | null;
  cmAvg30?: number | null;
  cmAvg30Foil?: number | null;
  cmTrend?: number | null;
  cmTrendFoil?: number | null;
}

/**
 * Welcher Cardmarket-Wert als Preis einer Near-Mint-Karte gilt (Einstellung je Konto, Wunsch des
 * Users 08.11.2026). Alle gelten für alle Sprachen gemeinsam - Preise je Sprache kennt weder
 * Cardmarkets Preisdatei noch Scryfall.
 */
export type PriceBasis = 'avg7' | 'trend' | 'avg30' | 'avg1';
export const PRICE_BASES: readonly PriceBasis[] = ['avg7', 'trend', 'avg30', 'avg1'];

/**
 * Preis eines Exemplars (Wunsch des Users, 08.11.2026):
 *  - Near Mint = der gewählte Cardmarket-Wert (`basis`, Standard Durchschnitt der letzten 7 Tage).
 *    Fehlt er (z. B. kein Verkauf in 7 Tagen, bei ~17 % der Produkte), gilt der Trendpreis -
 *    Cardmarkets eigener bzw. Scryfalls Preis, der derselbe Wert ist.
 *  - Played = Cardmarkets günstigstes Angebot (low, über alle Zustände).
 *  - `mode` 'low' bewertet jede Karte mit dem günstigsten Angebot (Mindestwert der Sammlung).
 * Foil nimmt den Foil-Wert, ohne ihn den normalen. Ohne Cardmarket-Spalten bleibt Scryfalls Preis.
 */
export function entryPrice(
  info: PrintInfo | null | undefined,
  foil: boolean,
  condition: CardCondition = 'nm',
  mode: 'normal' | 'low' = 'normal',
  basis: PriceBasis = 'avg7',
): { price: number | null; fromEnglish: boolean } {
  if (!info) return { price: null, fromEnglish: false };
  const pick = (normal?: number | null, foilValue?: number | null) =>
    (foil ? (foilValue ?? normal) : (normal ?? foilValue)) ?? null;
  const low = pick(info.cmLow, info.cmLowFoil);
  const chosen = {
    avg7: () => pick(info.cmAvg7, info.cmAvg7Foil),
    trend: () => pick(info.cmTrend, info.cmTrendFoil),
    avg30: () => pick(info.cmAvg30, info.cmAvg30Foil),
    avg1: () => pick(info.cmAvg1, info.cmAvg1Foil),
  }[basis]();
  const cmTrend = pick(info.cmTrend, info.cmTrendFoil);
  const trend = pick(info.eur, info.eurFoil);
  if (condition === 'pl' || mode === 'low') {
    if (low !== null) return { price: low, fromEnglish: false };
  }
  if (chosen !== null) return { price: chosen, fromEnglish: false };
  if (cmTrend !== null) return { price: cmTrend, fromEnglish: false };
  if (trend !== null) return { price: trend, fromEnglish: info.priceFromEnglish };
  return { price: low, fromEnglish: false };
}

/**
 * Reihenfolge der Bits in scryfall_prints.legal_mask (sql/druck-cache-alle-drucke-2026-11-06.sql).
 * GLEICH HALTEN mit LEGALITY_FORMATS in scripts/sync-scryfall-bulk.js.
 */
const LEGALITY_FORMATS = [
  'standard',
  'future',
  'historic',
  'timeless',
  'gladiator',
  'pioneer',
  'explorer',
  'modern',
  'legacy',
  'pauper',
  'vintage',
  'penny',
  'commander',
  'oathbreaker',
  'standardbrawl',
  'brawl',
  'alchemy',
  'paupercommander',
  'duel',
  'oldschool',
  'premodern',
  'predh',
];

/** "legal" für jedes gesetzte Bit, sonst "not_legal" (restricted zählt beim Schreiben als legal). */
function legalitiesFromMask(mask: number): Record<string, string> {
  return Object.fromEntries(
    LEGALITY_FORMATS.map((format, bit) => [format, mask & (1 << bit) ? 'legal' : 'not_legal']),
  );
}

/** Cardmarket-Spalten je Migration, die neueste zuerst. */
const CM_COLUMN_GROUPS = [
  'cm_avg1, cm_avg1_foil, cm_avg30, cm_avg30_foil, cm_trend, cm_trend_foil',
  'cm_avg7, cm_avg7_foil, cm_low, cm_low_foil',
];

const SELECT =
  'scryfall_id, foil, card_name, lang, set_code, collector_number, illustration_id, quantity, added_at';
/** Mit Zustand (sql/cardmarket-preise-zustand-2026-11-08.sql); ohne Migration SELECT allein. */
const SELECT_CONDITION = `${SELECT}, condition`;
const API = 'https://api.scryfall.com';

export function toCollectionPrint(c: any): CollectionPrint {
  const face = c.card_faces?.[0];
  return {
    scryfallId: c.id,
    cardName: c.name,
    printedName: c.printed_name ?? face?.printed_name ?? null,
    lang: c.lang ?? 'en',
    setCode: c.set ?? '',
    setName: c.set_name ?? '',
    collectorNumber: c.collector_number ?? '',
    illustrationId: c.illustration_id ?? face?.illustration_id ?? null,
    imageUrl: c.image_uris?.normal ?? face?.image_uris?.normal ?? printImageUrl(c.id),
    finishes: c.finishes ?? ['nonfoil'],
  };
}

function fromRow(row: any): CollectionEntry {
  return {
    scryfallId: row.scryfall_id,
    foil: !!row.foil,
    cardName: row.card_name,
    lang: row.lang,
    setCode: row.set_code ?? '',
    collectorNumber: row.collector_number ?? '',
    illustrationId: row.illustration_id ?? null,
    quantity: row.quantity,
    addedAt: row.added_at,
    condition: row.condition === 'pl' ? 'pl' : 'nm',
  };
}

const BASIS_KEY = 'collectionPriceBasis';

function isPriceBasis(value: unknown): value is PriceBasis {
  return PRICE_BASES.includes(value as PriceBasis);
}

function readStoredBasis(): PriceBasis {
  try {
    const value = localStorage.getItem(BASIS_KEY);
    return isPriceBasis(value) ? value : 'avg7';
  } catch {
    return 'avg7';
  }
}

function storeBasis(basis: PriceBasis): void {
  try {
    localStorage.setItem(BASIS_KEY, basis);
  } catch {
    // privater Modus - gilt dann nur für diese Sitzung
  }
}

function conditionOf(print: CollectionPrint | CollectionEntry): CardCondition {
  return 'condition' in print && print.condition === 'pl' ? 'pl' : 'nm';
}

function isMissingMigration(error: { code?: string } | null): boolean {
  return !!error && ['42P01', 'PGRST205', 'PGRST202', '42883'].includes(error.code ?? '');
}

@Injectable({ providedIn: 'root' })
export class CollectionService {
  private readonly auth = inject(AuthService);
  private readonly scryfall = inject(ScryfallService);

  readonly available = signal(true);
  /** Eigene Sammlung; null = noch nicht geladen. */
  readonly entries = signal<CollectionEntry[] | null>(null);
  readonly loading = signal(false);
  /** Karten der eigenen Decks; null = noch nicht geladen. */
  readonly deckUsage = signal<DeckUsage[] | null>(null);

  private loadedFor: string | null = null;

  /**
   * Offene Vollbild-Ansicht der Sammlung (collection-view/): null = zu, `userId` null = die eigene.
   * Wie die Deck-Ansicht eine eigene Seite statt eines Reiters im Profil (Wunsch des Users,
   * 18.10.2026: die Sammlung braucht mehr Platz).
   */
  readonly view = signal<{ userId: string | null; name: string | null } | null>(null);

  openView(userId: string | null = null, name: string | null = null): void {
    this.view.set({ userId, name });
  }

  closeView(): void {
    this.view.set(null);
  }

  /** Besitz je Kartenname (normalisierte Vorderseite). */
  readonly ownedByName = computed(() => {
    const map = new Map<string, CollectionEntry[]>();
    for (const e of this.entries() ?? []) {
      const key = collectionKey(e.cardName);
      const list = map.get(key);
      if (list) list.push(e);
      else map.set(key, [e]);
    }
    return map;
  });

  readonly totalCards = computed(() =>
    (this.entries() ?? []).reduce((sum, e) => sum + e.quantity, 0),
  );

  constructor() {
    // Bei Kontowechsel die fremde Sammlung sofort vergessen.
    effect(() => {
      const uid = this.auth.currentUser()?.id ?? null;
      if (uid !== this.loadedFor) {
        this.entries.set(null);
        this.deckUsage.set(null);
        this.loadedFor = null;
        this.view.set(null);
      }
    });
  }

  /** Lädt die eigene Sammlung einmal je Konto. */
  async ensureLoaded(): Promise<void> {
    const uid = this.auth.currentUser()?.id;
    if (!uid || !this.available() || this.loadedFor === uid || this.loading()) return;
    this.loading.set(true);
    void this.loadPriceBasis(uid);
    const rows = await this.fetchAll(uid);
    this.loading.set(false);
    if (rows) {
      this.loadedFor = uid;
      this.entries.set(rows);
    }
  }

  /** Sammlung eines Freundes (RLS lässt nur Freunde durch, sonst kommt eine leere Liste). */
  async loadFor(userId: string): Promise<CollectionEntry[]> {
    if (!this.available()) return [];
    return (await this.fetchAll(userId)) ?? [];
  }

  private async fetchAll(userId: string): Promise<CollectionEntry[] | null> {
    const all: CollectionEntry[] = [];
    // In Seiten zu 1000 - so viele liefert PostgREST höchstens auf einmal.
    for (let from = 0; ; from += 1000) {
      const page = () =>
        supabase
          .from('collection_cards')
          .select(this.conditionAvailable() ? SELECT_CONDITION : SELECT)
          .eq('user_id', userId)
          .order('added_at', { ascending: false })
          .range(from, from + 999);
      let { data, error } = await page();
      // Spalte condition fehlt: Migration noch nicht gelaufen - ohne Zustand weiter.
      if (error?.code === '42703' && this.conditionAvailable()) {
        this.conditionAvailable.set(false);
        ({ data, error } = await page());
      }
      if (error) {
        if (isMissingMigration(error)) this.available.set(false);
        else console.error('Konnte Sammlung nicht laden:', error);
        return null;
      }
      const entries = (data ?? []).map(fromRow);
      for (const e of entries) this.rememberPrintKey(e);
      all.push(...entries);
      if (!data || data.length < 1000) return all;
    }
  }

  /**
   * Die Sprache gehört zum Schlüssel einer Zeile, nicht nur die Druck-ID: Scryfall kennt viele
   * Drucke nicht in jeder Sprache, in der es sie gibt (Wunsch des Users, 05.11.2026). Eine deutsche
   * Karte, die Scryfall nur englisch führt, steht dann mit der englischen Druck-ID und `lang` "de"
   * da - neben einer englischen desselben Drucks (sql/sammlung-sprache-frei-2026-11-05.sql).
   * `lang` weggelassen = die Sprache des Drucks.
   */
  quantityOf(
    scryfallId: string,
    foil: boolean,
    lang?: string,
    condition: CardCondition = 'nm',
  ): number {
    return (
      this.entries()?.find((e) => this.sameRow(e, scryfallId, foil, lang, condition))?.quantity ?? 0
    );
  }

  /**
   * false, solange die Spalte `condition` fehlt (sql/cardmarket-preise-zustand-2026-11-08.sql):
   * dann gibt es keinen Zustand, alles gilt als Near Mint, und das Bearbeiten-Blatt zeigt keine
   * Auswahl.
   */
  readonly conditionAvailable = signal(true);

  /**
   * Preisbasis der Sammlung (Einstellung im Kopf der Sammlung). Gespeichert in
   * profiles.collection_price_basis und zusätzlich im localStorage, damit sie sofort gilt und ohne
   * Migration wenigstens auf dem Gerät bleibt.
   */
  readonly priceBasis = signal<PriceBasis>(readStoredBasis());
  private basisColumnAvailable = true;

  private async loadPriceBasis(uid: string): Promise<void> {
    if (!this.basisColumnAvailable) return;
    const { data, error } = await supabase
      .from('profiles')
      .select('collection_price_basis')
      .eq('id', uid)
      .maybeSingle();
    if (error) {
      if (error.code === '42703') this.basisColumnAvailable = false;
      return;
    }
    const basis = (data as { collection_price_basis?: string } | null)?.collection_price_basis;
    if (isPriceBasis(basis)) {
      this.priceBasis.set(basis);
      storeBasis(basis);
    }
  }

  async setPriceBasis(basis: PriceBasis): Promise<void> {
    this.priceBasis.set(basis);
    storeBasis(basis);
    const uid = this.auth.currentUser()?.id;
    if (!uid || !this.basisColumnAvailable) return;
    const { error } = await supabase
      .from('profiles')
      .update({ collection_price_basis: basis })
      .eq('id', uid);
    if (error) {
      if (['42703', 'PGRST204'].includes(error.code ?? '')) this.basisColumnAvailable = false;
      else console.error('Konnte Preisbasis nicht speichern:', error);
    }
  }

  /**
   * false, solange die Migration fehlt (Primärschlüssel noch ohne Sprache): Dann gilt wie früher
   * eine Zeile je Druck und Foil, und eine andere Sprache überschreibt die vorhandene Zeile.
   */
  private langInKey = true;

  private sameRow(
    e: CollectionEntry,
    scryfallId: string,
    foil: boolean,
    lang?: string,
    condition: CardCondition = 'nm',
  ): boolean {
    return (
      e.scryfallId === scryfallId &&
      e.foil === foil &&
      (!this.langInKey || lang === undefined || e.lang === lang) &&
      (!this.conditionAvailable() || (e.condition ?? 'nm') === condition)
    );
  }

  /**
   * Ändert die Anzahl eines Drucks um `delta`; bei 0 verschwindet die Zeile. Ohne `condition` gilt
   * der Zustand des Eintrags bzw. Near Mint - so trägt der Scanner immer NM ein (Wunsch des Users,
   * 08.11.2026: Vorder- und Rückseite sieht er nicht).
   */
  async add(
    print: CollectionPrint | CollectionEntry,
    foil: boolean,
    delta = 1,
    condition: CardCondition = conditionOf(print),
  ): Promise<boolean> {
    await this.ensureLoaded();
    const uid = this.auth.currentUser()?.id;
    if (!uid || !this.available()) return false;
    const current = this.quantityOf(print.scryfallId, foil, print.lang, condition);
    return this.setQuantity(print, foil, Math.min(999, current + delta), condition);
  }

  async setQuantity(
    print: CollectionPrint | CollectionEntry,
    foil: boolean,
    quantity: number,
    condition: CardCondition = conditionOf(print),
  ): Promise<boolean> {
    const uid = this.auth.currentUser()?.id;
    if (!uid) return false;
    const before = this.entries() ?? [];
    const existing = before.find((e) =>
      this.sameRow(e, print.scryfallId, foil, print.lang, condition),
    );

    if (quantity <= 0) {
      this.entries.set(before.filter((e) => e !== existing));
      let query = supabase
        .from('collection_cards')
        .delete()
        .eq('user_id', uid)
        .eq('scryfall_id', print.scryfallId)
        .eq('foil', foil);
      if (this.langInKey) query = query.eq('lang', existing?.lang ?? print.lang);
      if (this.conditionAvailable()) query = query.eq('condition', condition);
      const { error } = await query;
      if (error) {
        console.error('Konnte Karte nicht aus der Sammlung nehmen:', error);
        this.entries.set(before);
        return false;
      }
      return true;
    }

    const entry: CollectionEntry = existing
      ? { ...existing, quantity }
      : {
          scryfallId: print.scryfallId,
          foil,
          cardName: print.cardName,
          lang: print.lang,
          setCode: print.setCode,
          collectorNumber: print.collectorNumber,
          illustrationId: print.illustrationId,
          quantity,
          addedAt: new Date().toISOString(),
          condition,
        };
    this.rememberPrintKey(entry);
    // Sofort anzeigen, beim Fehler zurückrollen - beim Scannen soll nichts auf die Datenbank warten.
    this.entries.set(
      existing ? before.map((e) => (e === existing ? entry : e)) : [entry, ...before],
    );
    const row: Record<string, unknown> = {
      user_id: uid,
      scryfall_id: entry.scryfallId,
      foil,
      card_name: entry.cardName,
      lang: entry.lang,
      set_code: entry.setCode,
      collector_number: entry.collectorNumber,
      illustration_id: entry.illustrationId,
      quantity,
    };
    const save = () =>
      supabase.from('collection_cards').upsert(
        this.conditionAvailable() ? { ...row, condition } : row,
        this.langInKey
          ? {
              onConflict: this.conditionAvailable()
                ? 'user_id,scryfall_id,foil,lang,condition'
                : 'user_id,scryfall_id,foil,lang',
            }
          : undefined,
      );
    let { error } = await save();
    // Zustand fehlt in Tabelle oder Schlüssel: Migration noch nicht gelaufen - ohne Zustand weiter.
    if (this.conditionAvailable() && ['42703', 'PGRST204', '42P10'].includes(error?.code ?? '')) {
      this.conditionAvailable.set(false);
      ({ error } = await save());
    }
    // 42P10: kein passender Schlüssel - die Migration mit der Sprache im Schlüssel fehlt noch.
    if (error?.code === '42P10' && this.langInKey) {
      console.warn(
        'Sprache noch nicht im Schlüssel der Sammlung - sql/sammlung-sprache-frei-2026-11-05.sql ausführen.',
      );
      this.langInKey = false;
      ({ error } = await supabase.from('collection_cards').upsert(row));
    }
    if (error) {
      if (isMissingMigration(error)) this.available.set(false);
      console.error('Konnte Sammlung nicht speichern:', error);
      this.entries.set(before);
      return false;
    }
    return true;
  }

  /**
   * Exemplare eines Eintrags auf einen anderen Druck, eine andere Sprache oder Foil umstellen
   * (Bearbeiten-Blatt der Sammlung, Wunsch des Users 06.11.2026: beim Scannen oder Eintragen
   * falsch erkannt). Erst das Ziel hochzählen, dann die Quelle herunter - scheitert das Ziel,
   * bleibt alles, wie es war.
   */
  async moveCopies(
    entry: CollectionEntry,
    target: CollectionPrint,
    foil: boolean,
    count: number,
    condition: CardCondition = conditionOf(entry),
  ): Promise<boolean> {
    const n = Math.min(count, entry.quantity);
    if (n <= 0) return false;
    const sameId = target.scryfallId === entry.scryfallId && foil === entry.foil;
    const sameCondition = !this.conditionAvailable() || condition === conditionOf(entry);
    if (sameId && target.lang === entry.lang && sameCondition) return true;
    // Ohne Sprache im Schlüssel wären Quelle und Ziel dieselbe Zeile.
    if (sameId && sameCondition && !this.langInKey) return false;
    const ok = await this.add(target, foil, n, condition);
    if (!ok) return false;
    return this.setQuantity(entry, entry.foil, entry.quantity - n);
  }

  /** Karten aller eigenen Decks (für "brauchst du in mehreren Decks"). */
  async ensureDeckUsage(force = false): Promise<void> {
    if (!this.auth.currentUser() || !this.available()) return;
    if (this.deckUsage() && !force) return;
    const { data, error } = await supabase.rpc('collection_deck_usage');
    if (error) {
      if (isMissingMigration(error)) this.available.set(false);
      else console.error('Konnte Deck-Nutzung nicht laden:', error);
      return;
    }
    this.deckUsage.set(
      ((data as unknown[][] | null) ?? []).map((r) => ({
        deckId: r[0] as string,
        deckName: r[1] as string,
        cardName: r[2] as string,
        quantity: r[3] as number,
        imageUrl: (r[4] as string | null) ?? null,
      })),
    );
  }

  // --- Scryfall --------------------------------------------------------------------------

  /** Namensvorschläge beim Hinzufügen; ohne englischen Treffer auch über gedruckte Namen. */
  async suggestNames(query: string): Promise<string[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const res = await this.scryfall.fetchWithRetry(
      `${API}/cards/autocomplete?q=${encodeURIComponent(q)}`,
      1,
    );
    const names: string[] = res?.ok ? ((await res.json()).data ?? []) : [];
    if (names.length > 0) return names.slice(0, 12);
    const safe = q.replace(/"/g, '');
    const search = await this.scryfall.fetchWithRetry(
      `${API}/cards/search?q=${encodeURIComponent(`lang:any name:"${safe}"`)}&unique=cards&include_multilingual=true`,
      1,
    );
    if (!search?.ok) return [];
    const data = await search.json();
    return [...new Set(((data.data as any[]) ?? []).map((c) => c.name as string))].slice(0, 12);
  }

  /** Alle Papier-Drucke einer Karte in allen Sprachen, neueste zuerst (höchstens 4 Seiten). */
  async printsOf(cardName: string): Promise<CollectionPrint[]> {
    const safe = cardName.replace(/"/g, '');
    let url: string | null =
      `${API}/cards/search?q=${encodeURIComponent(`!"${safe}" -is:digital include:extras`)}` +
      `&unique=prints&include_multilingual=true&order=released&dir=desc`;
    const prints: CollectionPrint[] = [];
    for (let page = 0; url && page < 4; page++) {
      const res = await this.scryfall.fetchWithRetry(url, 1);
      if (!res?.ok) break;
      const data = await res.json();
      prints.push(...((data.data as any[]) ?? []).map(toCollectionPrint));
      url = data.has_more ? data.next_page : null;
    }
    return prints;
  }

  /**
   * Angaben je Druck (Seltenheit, Setname, Preis normal und Foil, illustration_id, Legalitäten) -
   * zuerst aus scryfall_prints, die der Nachtlauf mit ALLEN Drucken aus Scryfalls default_cards
   * füllt (sql/druck-cache-alle-drucke-2026-11-06.sql): erst über die Druck-ID, dann über Set und
   * Nummer (fremdsprachige Drucke stehen dort nicht, bekommen aber die Angaben samt Preis des
   * englischen Drucks). Nur was dort fehlt (Sets, die erst heute erschienen sind), live gebündelt
   * zu je 75 über /cards/collection. Alles im Sitzungs-Cache.
   */
  private readonly printInfoCache = new Map<string, PrintInfo | null>();
  /** false, sobald die Tabelle fehlt (Migration noch nicht gelaufen) - dann nur Scryfall. */
  private printInfoTableAvailable = true;
  /** Wie viele Gruppen aus CM_COLUMN_GROUPS es gibt (von hinten gezählt); 0 = nur Scryfalls Preis. */
  private cardmarketColumns = CM_COLUMN_GROUPS.length;
  /** "set/nummer" je Druck-ID aus den geladenen Sammlungen - für den Weg über den englischen Druck. */
  private readonly printKeys = new Map<string, string>();

  private rememberPrintKey(e: CollectionEntry): void {
    if (e.setCode && e.collectorNumber)
      this.printKeys.set(e.scryfallId, `${e.setCode}/${e.collectorNumber}`.toLowerCase());
  }

  async printInfo(
    ids: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, PrintInfo | null>> {
    await this.printInfoFromTable([...new Set(ids)].filter((id) => !this.printInfoCache.has(id)));
    const open = [...new Set(ids)].filter((id) => !this.printInfoCache.has(id));
    // Drucke in anderen Sprachen haben bei Scryfall keinen Preis (die Preise kommen von
    // Cardmarket und hängen am englischen Druck) - für die wird danach der englische Druck
    // desselben Sets mit derselben Nummer nachgeschlagen.
    const withoutPrice: { id: string; set: string; number: string }[] = [];
    for (let i = 0; i < open.length; i += 75) {
      onProgress?.(i, open.length);
      const chunk = open.slice(i, i + 75);
      const res = await this.scryfall.fetchWithRetry(`${API}/cards/collection`, 1, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: chunk.map((id) => ({ id })) }),
      });
      if (!res?.ok) continue;
      const data = await res.json();
      for (const c of (data.data as any[]) ?? []) {
        const eur = parseFloat(c.prices?.eur);
        const eurFoil = parseFloat(c.prices?.eur_foil);
        this.printInfoCache.set(c.id, {
          illustrationId: c.illustration_id ?? c.card_faces?.[0]?.illustration_id ?? null,
          rarity: c.rarity ?? null,
          setName: c.set_name ?? null,
          eur: Number.isNaN(eur) ? null : eur,
          eurFoil: Number.isNaN(eurFoil) ? null : eurFoil,
          legalities: c.legalities ?? {},
          priceFromEnglish: false,
        });
        if (c.lang !== 'en' && Number.isNaN(eur) && Number.isNaN(eurFoil)) {
          withoutPrice.push({ id: c.id, set: c.set, number: c.collector_number });
        }
      }
      for (const id of chunk) if (!this.printInfoCache.has(id)) this.printInfoCache.set(id, null);
    }
    await this.englishPrices(withoutPrice);
    onProgress?.(open.length, open.length);
    return new Map(ids.map((id) => [id, this.printInfoCache.get(id) ?? null]));
  }

  private async printInfoFromTable(ids: string[]): Promise<void> {
    if (!this.printInfoTableAvailable || ids.length === 0) return;
    const base =
      'scryfall_id, print_key, rarity, set_name, illustration_id, eur, eur_foil, legal_mask';
    // Cardmarket-Spalten nur, solange es sie gibt - je fehlender Migration eine Gruppe weniger
    // (sql/sammlung-preisbasis-2026-11-08.sql, sql/cardmarket-preise-zustand-2026-11-08.sql).
    const columns = (): string =>
      [base, ...CM_COLUMN_GROUPS.slice(CM_COLUMN_GROUPS.length - this.cardmarketColumns)].join(
        ', ',
      );
    const num = (v: unknown) => (v == null ? null : Number(v));
    const toInfo = (row: any, fromEnglish: boolean): PrintInfo => ({
      illustrationId: row.illustration_id ?? null,
      rarity: row.rarity ?? null,
      setName: row.set_name ?? null,
      eur: row.eur == null ? null : Number(row.eur),
      eurFoil: row.eur_foil == null ? null : Number(row.eur_foil),
      legalities: legalitiesFromMask(row.legal_mask ?? 0),
      priceFromEnglish: fromEnglish && (row.eur != null || row.eur_foil != null),
      cmAvg7: num(row.cm_avg7),
      cmAvg7Foil: num(row.cm_avg7_foil),
      cmLow: num(row.cm_low),
      cmLowFoil: num(row.cm_low_foil),
      cmAvg1: num(row.cm_avg1),
      cmAvg1Foil: num(row.cm_avg1_foil),
      cmAvg30: num(row.cm_avg30),
      cmAvg30Foil: num(row.cm_avg30_foil),
      cmTrend: num(row.cm_trend),
      cmTrendFoil: num(row.cm_trend_foil),
    });
    // 1. Über die Druck-ID.
    for (let i = 0; i < ids.length; i += 200) {
      const query = () =>
        supabase
          .from('scryfall_prints')
          .select(columns())
          .in('scryfall_id', ids.slice(i, i + 200));
      let { data, error } = await query();
      while (error?.code === '42703' && this.cardmarketColumns > 0) {
        this.cardmarketColumns--;
        ({ data, error } = await query());
      }
      if (error) {
        if (['42P01', 'PGRST205'].includes(error.code ?? '')) this.printInfoTableAvailable = false;
        return;
      }
      for (const row of (data ?? []) as any[])
        this.printInfoCache.set(row.scryfall_id, toInfo(row, false));
    }
    // 2. Fremdsprachige Drucke über Set und Nummer des englischen.
    const byKey = new Map<string, string[]>();
    for (const id of ids) {
      const key = this.printKeys.get(id);
      if (!key || this.printInfoCache.has(id)) continue;
      byKey.set(key, [...(byKey.get(key) ?? []), id]);
    }
    const keys = [...byKey.keys()];
    for (let i = 0; i < keys.length; i += 200) {
      const { data, error } = await supabase
        .from('scryfall_prints')
        .select(columns())
        .in('print_key', keys.slice(i, i + 200));
      if (error) return;
      for (const row of (data ?? []) as any[])
        for (const id of byKey.get(row.print_key) ?? [])
          this.printInfoCache.set(id, toInfo(row, row.scryfall_id !== id));
    }
  }

  /** Preise der englischen Drucke für fremdsprachige (gleiches Set, gleiche Nummer). */
  private async englishPrices(
    prints: { id: string; set: string; number: string }[],
  ): Promise<void> {
    for (let i = 0; i < prints.length; i += 75) {
      const chunk = prints.slice(i, i + 75);
      // Set + Nummer ohne Sprache liefert bei Scryfall den englischen Druck.
      const res = await this.scryfall.fetchWithRetry(`${API}/cards/collection`, 1, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifiers: chunk.map((p) => ({ set: p.set, collector_number: p.number })),
        }),
      });
      if (!res?.ok) continue;
      const data = await res.json();
      const byKey = new Map<string, any>(
        ((data.data as any[]) ?? []).map((c) => [`${c.set}/${c.collector_number}`, c]),
      );
      for (const p of chunk) {
        const english = byKey.get(`${p.set}/${p.number}`);
        const info = this.printInfoCache.get(p.id);
        if (!english || !info) continue;
        const eur = parseFloat(english.prices?.eur);
        const eurFoil = parseFloat(english.prices?.eur_foil);
        if (Number.isNaN(eur) && Number.isNaN(eurFoil)) continue;
        this.printInfoCache.set(p.id, {
          ...info,
          eur: Number.isNaN(eur) ? null : eur,
          eurFoil: Number.isNaN(eurFoil) ? null : eurFoil,
          priceFromEnglish: true,
        });
      }
    }
  }

  /** illustration_id je Scryfall-ID (für die strenge Artwork-Prüfung). */
  async illustrationsOf(ids: string[]): Promise<Map<string, string | null>> {
    const info = await this.printInfo(ids);
    return new Map(ids.map((id) => [id, info.get(id)?.illustrationId ?? null]));
  }
}
