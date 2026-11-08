import type { CollectionEntry } from './collection-coverage';
import { TYPE_ORDER, cmcBucket, typeSection } from './deck-analyse';
import { ColorSelection, matchesColorSelection } from './color-filter-match';
import { sortColors } from './color-combo-names';
import { EffectSelection, matchesEffectSelection } from './card-effect-filters';

/**
 * Filtern, Sortieren und Gruppieren der Sammlung (collection-view/). Reine Funktionen, damit sie
 * ohne Datenbank prüfbar sind.
 *
 * Die Filter folgen der Kartensuche der Deck-Ansicht (Suche, Manawert, Farbe, Typ, Fähigkeit,
 * Effekt) und dem, was Sammlungs-Apps zusätzlich anbieten (Set, Seltenheit, Foil, Sprache, in
 * Decks benutzt) - Wunsch des Users, 18.10.2026.
 */

/** Ein Sammlungs-Eintrag samt nachgeschlagener Kartendaten. Fehlendes ist null/leer. */
export interface CollectionItem {
  entry: CollectionEntry;
  /** Aus dem Nacht-Cache (scryfall_cards), je Kartenname. */
  typeLine: string | null;
  cmc: number | null;
  colorIdentity: readonly string[];
  keywords: readonly string[];
  /** Regeltext aus dem Nacht-Cache (englisch), null = unbekannt. */
  oracleText?: string | null;
  /** Effekt-Kategorien (Schlüssel wie in CARD_EFFECT_FILTERS bzw. tutor/extraturn/mld). */
  effects: ReadonlySet<string>;
  /** Je Druck von Scryfall: "common", "uncommon", "rare", "mythic", ... */
  rarity: string | null;
  setName: string | null;
  /** Preis eines Exemplars in EUR (Foil-Preis bei Foil), null = unbekannt. */
  price: number | null;
  /**
   * Mindestpreis eines Exemplars: Cardmarkets günstigstes Angebot (über alle Zustände). Für den
   * umschaltbaren Mindestwert der ganzen Sammlung; fehlt er, zählt `price`.
   */
  lowPrice?: number | null;
  /** true = Preis des englischen Drucks (für fremdsprachige Drucke kennt Scryfall keinen). */
  priceFromEnglish?: boolean;
  /** Nur nach mergePrints(): so viele verschiedene Drucke (Set, Sprache, Foil) stecken darin. */
  printCount?: number;
  /** Exemplare in eigenen Decks (alle Decks zusammen). */
  inDecks: number;
}

export interface CollectionFilters {
  search: string;
  langs: ReadonlySet<string>;
  sets: ReadonlySet<string>;
  rarities: ReadonlySet<string>;
  foil: 'all' | 'foil' | 'nonfoil';
  cmc: 'all' | number;
  colors: ColorSelection;
  /** Typ-Abschnitt wie in der Deck-Ansicht ("Kreatur", "Land", ...) oder 'all'. */
  type: string;
  effect: EffectSelection;
  keyword: string;
  usage: 'all' | 'used' | 'free';
  /** Untertyp wie im Deck-Editor ("Elf", "Equipment"), Teil der Typzeile; leer = egal. */
  creatureType?: string;
  /** Nur legendäre Karten. */
  legendary?: boolean;
  /** Wörter, die im Regeltext stehen müssen (englisch, wie Scryfall). */
  rulesText?: string;
  /**
   * Treffer der Druck-Suche (Künstler, Artwork, Flavortext, Lore) von Scryfall: Druck-IDs und
   * illustration_ids. null = Druck-Suche nicht aktiv.
   */
  printMatch?: { ids: ReadonlySet<string>; illustrations: ReadonlySet<string> } | null;
}

export const RARITIES = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'] as const;
/** Reihenfolge der Abschnitte beim Gruppieren nach Seltenheit: wertvollste zuerst. */
const RARITY_ORDER: readonly string[] = [
  'mythic',
  'rare',
  'uncommon',
  'common',
  'special',
  'bonus',
];

export function filterCollection(
  items: readonly CollectionItem[],
  f: CollectionFilters,
): CollectionItem[] {
  const q = f.search.trim().toLowerCase();
  return items.filter((item) => {
    const e = item.entry;
    if (
      q &&
      !e.cardName.toLowerCase().includes(q) &&
      !(item.setName ?? '').toLowerCase().includes(q)
    ) {
      return false;
    }
    if (f.langs.size && !f.langs.has(e.lang)) return false;
    if (f.sets.size && !f.sets.has(e.setCode)) return false;
    if (f.rarities.size && !f.rarities.has(item.rarity ?? '')) return false;
    if (f.foil === 'foil' && !e.foil) return false;
    if (f.foil === 'nonfoil' && e.foil) return false;
    if (f.cmc !== 'all' && (item.cmc === null || cmcBucket(item.cmc) !== f.cmc)) return false;
    if (f.colors.colors.length && !matchesColorSelection(item.colorIdentity, f.colors))
      return false;
    if (f.type !== 'all' && typeSection(item.typeLine) !== f.type) return false;
    if (!matchesEffectSelection(f.effect, (k) => item.effects.has(k))) return false;
    if (f.keyword !== 'all' && !item.keywords.some((k) => k.toLowerCase() === f.keyword))
      return false;
    if (f.usage === 'used' && item.inDecks === 0) return false;
    if (f.usage === 'free' && item.inDecks > 0) return false;
    if (f.legendary && !/\bLegendary\b/.test(item.typeLine ?? '')) return false;
    const sub = (f.creatureType ?? '').trim().toLowerCase();
    if (sub && !(item.typeLine ?? '').toLowerCase().includes(sub)) return false;
    if (!rulesTextMatches(item.oracleText, f.rulesText)) return false;
    if (
      f.printMatch &&
      !f.printMatch.ids.has(e.scryfallId) &&
      !(e.illustrationId && f.printMatch.illustrations.has(e.illustrationId))
    )
      return false;
    return true;
  });
}

/** Jedes Wort muss im Regeltext vorkommen (Reihenfolge egal), wie Scryfalls o:-Glieder. */
function rulesTextMatches(oracle: string | null | undefined, query: string | undefined): boolean {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = (oracle ?? '').toLowerCase();
  return words.every((w) => text.includes(w));
}

export function activeFilterCount(f: CollectionFilters): number {
  return [
    f.langs.size > 0,
    f.sets.size > 0,
    f.rarities.size > 0,
    f.foil !== 'all',
    f.cmc !== 'all',
    f.colors.colors.length > 0,
    f.type !== 'all',
    f.effect.keys.size > 0,
    f.keyword !== 'all',
    f.usage !== 'all',
    !!f.creatureType?.trim(),
    !!f.legendary,
    !!f.rulesText?.trim(),
    !!f.printMatch,
  ].filter(Boolean).length;
}

export type CollectionSort = 'added' | 'name' | 'set' | 'cmc' | 'price';

export function sortCollection(
  items: readonly CollectionItem[],
  mode: CollectionSort,
): CollectionItem[] {
  const byName = (a: CollectionItem, b: CollectionItem) =>
    a.entry.cardName.localeCompare(b.entry.cardName);
  const number = (i: CollectionItem) => parseInt(i.entry.collectorNumber, 10) || 0;
  const compare: Record<CollectionSort, (a: CollectionItem, b: CollectionItem) => number> = {
    added: (a, b) => b.entry.addedAt.localeCompare(a.entry.addedAt),
    name: byName,
    set: (a, b) =>
      a.entry.setCode.localeCompare(b.entry.setCode) || number(a) - number(b) || byName(a, b),
    cmc: (a, b) => (a.cmc ?? 99) - (b.cmc ?? 99) || byName(a, b),
    // Teuerste zuerst, unbekannte Preise ans Ende.
    price: (a, b) => (b.price ?? -1) - (a.price ?? -1) || byName(a, b),
  };
  return [...items].sort(compare[mode]);
}

/**
 * "Drucke zusammenfassen" (wie bei ManaBox): ein Eintrag je Kartenname, Anzahl und Wert
 * zusammengezählt. Der zuerst einsortierte Druck steht für das Bild.
 */
export function mergePrints(items: readonly CollectionItem[]): CollectionItem[] {
  const byName = new Map<string, CollectionItem>();
  for (const item of items) {
    const key = item.entry.cardName.toLowerCase();
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, { ...item, entry: { ...item.entry }, printCount: 1 });
      continue;
    }
    prev.printCount = (prev.printCount ?? 1) + 1;
    prev.priceFromEnglish = prev.priceFromEnglish || item.priceFromEnglish;
    const total = prev.entry.quantity + item.entry.quantity;
    const value = itemValue(prev) + itemValue(item);
    const lowValue = itemValue(prev, 'low') + itemValue(item, 'low');
    prev.entry.quantity = total;
    // Durchschnittspreis je Exemplar, damit Anzahl × Preis den Gesamtwert ergibt.
    prev.price = prev.price === null && item.price === null ? null : value / total;
    prev.lowPrice = lowValue / total;
  }
  return [...byName.values()];
}

/** Wert eines Eintrags; 'low' = mit dem günstigsten Angebot (Mindestwert), ohne ihn der Preis. */
export function itemValue(item: CollectionItem, mode: 'normal' | 'low' = 'normal'): number {
  const price = mode === 'low' ? (item.lowPrice ?? item.price) : item.price;
  return (price ?? 0) * item.entry.quantity;
}

export function collectionValue(
  items: readonly CollectionItem[],
  mode: 'normal' | 'low' = 'normal',
): number {
  return items.reduce((sum, item) => sum + itemValue(item, mode), 0);
}

export type CollectionGroup = 'none' | 'set' | 'color' | 'type' | 'rarity';

export interface CollectionSection {
  key: string;
  items: CollectionItem[];
  cards: number;
}

/** Abschnitte in sinnvoller Reihenfolge; die Beschriftung macht die Ansicht (i18n, Setnamen). */
export function groupCollection(
  items: readonly CollectionItem[],
  mode: CollectionGroup,
): CollectionSection[] {
  if (mode === 'none') {
    return [{ key: '', items: [...items], cards: items.reduce((s, i) => s + i.entry.quantity, 0) }];
  }
  const keyOf = (i: CollectionItem): string => {
    switch (mode) {
      case 'set':
        return i.entry.setCode;
      case 'color':
        return i.colorIdentity.length ? sortColors(i.colorIdentity).join('') : 'C';
      case 'type':
        return typeSection(i.typeLine);
      case 'rarity':
        return i.rarity ?? '';
    }
  };
  const sections = new Map<string, CollectionSection>();
  for (const item of items) {
    const key = keyOf(item);
    const section = sections.get(key) ?? { key, items: [], cards: 0 };
    section.items.push(item);
    section.cards += item.entry.quantity;
    sections.set(key, section);
  }
  const rank = (key: string): number => {
    if (mode === 'rarity') {
      const i = RARITY_ORDER.indexOf(key);
      return i < 0 ? 99 : i;
    }
    // Farblos zuletzt, sonst nach Zahl der Farben.
    if (mode === 'color') return key === 'C' ? 99 : key.length;
    if (mode === 'type') {
      const i = TYPE_ORDER.findIndex((t) => t.label === key);
      return i < 0 ? 99 : i;
    }
    return 0;
  };
  return [...sections.values()].sort(
    (a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key),
  );
}
