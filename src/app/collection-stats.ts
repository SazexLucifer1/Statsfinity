import { CollectionItem, RARITIES } from './collection-filter';
import { TYPE_ORDER, cmcBucket, typeSection } from './deck-analyse';
import { collectionKey } from './collection-coverage';

/**
 * Statistik über die Sammlung (Reiter „Statistik“ in collection-view/, Wunsch des Users,
 * 06.11.2026). Reine Funktionen über die gerade gefilterten Einträge - so lässt sich z. B. auch nur
 * die Statistik der Rares ansehen. Gezählt wird immer in Exemplaren, nicht in Zeilen.
 */

export interface CountBucket {
  key: string;
  copies: number;
  value: number;
}

export interface CardRank {
  item: CollectionItem;
  /** Je nach Liste: Preis je Exemplar oder Exemplare in Decks. */
  amount: number;
}

export interface CollectionStats {
  copies: number;
  distinct: number;
  value: number;
  /** Ø Preis je Exemplar über Exemplare mit bekanntem Preis; null = keiner bekannt. */
  avgPrice: number | null;
  medianPrice: number | null;
  /** Ø Manawert ohne Länder, je Exemplar gewichtet. */
  avgCmc: number | null;
  foilCopies: number;
  sets: number;
  languages: number;
  /** Exemplare ohne bekannten Preis - damit klar ist, worüber der Schnitt geht. */
  unpricedCopies: number;
  usage: {
    /** Verschiedene Karten, von denen mindestens ein Exemplar in einem Deck steckt. */
    distinctPlayed: number;
    /** Exemplare in Decks, höchstens so viele wie man besitzt. */
    copiesPlayed: number;
    valuePlayed: number;
  };
  colors: CountBucket[];
  curve: CountBucket[];
  types: CountBucket[];
  rarities: CountBucket[];
  priceTiers: CountBucket[];
  setList: CountBucket[];
  langs: CountBucket[];
  mostValuable: CardRank[];
  mostValuableFree: CardRank[];
  mostPlayed: CardRank[];
}

/** Obergrenzen der Preisstufen in EUR; die letzte Stufe ist offen. */
export const PRICE_TIERS = [0.5, 2, 10, 50] as const;
const COLOR_KEYS = ['W', 'U', 'B', 'R', 'G', 'M', 'C'] as const;
const TOP = 10;

export function collectionStats(items: readonly CollectionItem[]): CollectionStats {
  let copies = 0;
  let value = 0;
  let foilCopies = 0;
  let cmcSum = 0;
  let cmcCopies = 0;
  let unpricedCopies = 0;
  const prices: { price: number; qty: number }[] = [];
  const add = (map: Map<string, CountBucket>, key: string, qty: number, v: number) => {
    const b = map.get(key) ?? { key, copies: 0, value: 0 };
    b.copies += qty;
    b.value += v;
    map.set(key, b);
  };
  const colors = new Map<string, CountBucket>();
  const curve = new Map<string, CountBucket>();
  const types = new Map<string, CountBucket>();
  const rarities = new Map<string, CountBucket>();
  const tiers = new Map<string, CountBucket>();
  const sets = new Map<string, CountBucket>();
  const langs = new Map<string, CountBucket>();
  /** Je Kartenname: besessen, in Decks, Wert - für den Anteil, der gespielt wird. */
  const byName = new Map<
    string,
    { owned: number; inDecks: number; value: number; item: CollectionItem }
  >();

  for (const item of items) {
    const qty = item.entry.quantity;
    const v = (item.price ?? 0) * qty;
    copies += qty;
    value += v;
    if (item.entry.foil) foilCopies += qty;
    if (item.price === null) unpricedCopies += qty;
    else prices.push({ price: item.price, qty });

    const section = typeSection(item.typeLine);
    if (item.cmc !== null && item.typeLine && section !== 'Land') {
      cmcSum += item.cmc * qty;
      cmcCopies += qty;
      const b = cmcBucket(item.cmc);
      add(curve, String(b), qty, v);
    }
    if (item.typeLine) add(types, section, qty, v);
    const ci = item.colorIdentity;
    if (item.typeLine) add(colors, ci.length === 0 ? 'C' : ci.length > 1 ? 'M' : ci[0], qty, v);
    add(rarities, item.rarity ?? '', qty, v);
    if (item.price !== null) add(tiers, String(priceTier(item.price)), qty, v);
    add(sets, item.entry.setCode, qty, v);
    add(langs, item.entry.lang, qty, v);

    const key = collectionKey(item.entry.cardName);
    const n = byName.get(key) ?? { owned: 0, inDecks: item.inDecks, value: 0, item };
    n.owned += qty;
    n.value += v;
    byName.set(key, n);
  }

  let distinctPlayed = 0;
  let copiesPlayed = 0;
  let valuePlayed = 0;
  for (const n of byName.values()) {
    if (n.inDecks <= 0) continue;
    distinctPlayed++;
    const used = Math.min(n.owned, n.inDecks);
    copiesPlayed += used;
    valuePlayed += n.owned ? (n.value / n.owned) * used : 0;
  }

  const ordered = (map: Map<string, CountBucket>, keys: readonly string[]) =>
    keys.map((k) => map.get(k)).filter((b): b is CountBucket => !!b);
  const byCopies = (map: Map<string, CountBucket>) =>
    [...map.values()].sort((a, b) => b.copies - a.copies || a.key.localeCompare(b.key));

  const priced = items.filter((i) => i.price !== null);
  const names = [...byName.values()];

  return {
    copies,
    distinct: byName.size,
    value,
    avgPrice: prices.length ? weightedMean(prices) : null,
    medianPrice: weightedMedian(prices),
    avgCmc: cmcCopies ? cmcSum / cmcCopies : null,
    foilCopies,
    sets: sets.size,
    languages: langs.size,
    unpricedCopies,
    usage: { distinctPlayed, copiesPlayed, valuePlayed },
    colors: ordered(colors, COLOR_KEYS),
    // Alle Stufen 0-7+, auch leere: eine Kurve mit Lücken liest sich falsch.
    curve: [0, 1, 2, 3, 4, 5, 6, 7].map(
      (c) => curve.get(String(c)) ?? { key: String(c), copies: 0, value: 0 },
    ),
    types: ordered(types, [...TYPE_ORDER.map((t) => t.label), 'Sonstiges']),
    rarities: ordered(rarities, [...RARITIES, '']),
    priceTiers: ordered(
      tiers,
      [...PRICE_TIERS, Infinity].map((_, i) => String(i)),
    ),
    setList: byCopies(sets),
    langs: byCopies(langs),
    mostValuable: uniqueByName([...priced].sort((a, b) => (b.price ?? 0) - (a.price ?? 0))).map(
      (item) => ({ item, amount: item.price ?? 0 }),
    ),
    mostValuableFree: uniqueByName(
      priced.filter((i) => i.inDecks === 0).sort((a, b) => (b.price ?? 0) - (a.price ?? 0)),
    ).map((item) => ({ item, amount: item.price ?? 0 })),
    mostPlayed: names
      .filter((n) => n.inDecks > 0)
      .sort(
        (a, b) =>
          b.inDecks - a.inDecks || a.item.entry.cardName.localeCompare(b.item.entry.cardName),
      )
      .slice(0, TOP)
      .map((n) => ({ item: n.item, amount: n.inDecks })),
  };
}

/** Index der Preisstufe: 0 = unter 0,50 €, … , 4 = ab 50 €. */
export function priceTier(price: number): number {
  const i = PRICE_TIERS.findIndex((limit) => price < limit);
  return i < 0 ? PRICE_TIERS.length : i;
}

/** Je Karte nur der teuerste Druck - sonst stünde eine Karte mit vier Drucken viermal in der Liste. */
function uniqueByName(sorted: readonly CollectionItem[]): CollectionItem[] {
  const seen = new Set<string>();
  const out: CollectionItem[] = [];
  for (const item of sorted) {
    const key = collectionKey(item.entry.cardName);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= TOP) break;
  }
  return out;
}

function weightedMean(values: readonly { price: number; qty: number }[]): number {
  const n = values.reduce((s, v) => s + v.qty, 0);
  return values.reduce((s, v) => s + v.price * v.qty, 0) / n;
}

function weightedMedian(values: readonly { price: number; qty: number }[]): number | null {
  const n = values.reduce((s, v) => s + v.qty, 0);
  if (!n) return null;
  const sorted = [...values].sort((a, b) => a.price - b.price);
  let seen = 0;
  for (const v of sorted) {
    seen += v.qty;
    if (seen * 2 >= n) return v.price;
  }
  return sorted[sorted.length - 1].price;
}
