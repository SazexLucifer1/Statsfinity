/**
 * Vergleich zweier Deck-Varianten (siehe deck-variant.service.ts): welche Karten stehen in beiden,
 * welche nur in diesem, welche nur im anderen Deck. Maybeboard und Marken zählen nicht - sie
 * liegen nicht im gemischten Stapel.
 *
 * Mengen werden geteilt statt als ganze Karte einsortiert: Hat dieses Deck 2× Island und das andere
 * 4×, stehen 2 unter "in beiden" und 2 unter "nur im anderen". So ergeben die Listen zusammen
 * genau die Kartenzahl jedes Decks, und jede Liste ist eine Druckliste für die Tauschkarten.
 */

export interface VariantCard {
  cardName: string;
  quantity: number;
  imageUrl: string | null;
  typeLine: string | null;
  cmc: number;
  isCommander: boolean;
  isMaybeboard: boolean;
  isToken: boolean;
}

export interface VariantEntry {
  cardName: string;
  quantity: number;
  imageUrl: string | null;
  typeLine: string | null;
  cmc: number;
  isCommander: boolean;
}

export interface VariantComparison {
  common: VariantEntry[];
  onlyThis: VariantEntry[];
  onlyOther: VariantEntry[];
}

const TYPE_ORDER = [
  'Creature',
  'Planeswalker',
  'Battle',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Land',
];

function typeRank(entry: VariantEntry): number {
  if (entry.isCommander) return -1;
  // Bei Doppelkarten zählt die Vorderseite (Pathways sind Länder, Rona eine Kreatur).
  const front = (entry.typeLine ?? '').split('//')[0];
  const rank = TYPE_ORDER.findIndex((t) => front.includes(t));
  return rank === -1 ? TYPE_ORDER.length : rank;
}

function compareEntries(a: VariantEntry, b: VariantEntry): number {
  return typeRank(a) - typeRank(b) || a.cmc - b.cmc || a.cardName.localeCompare(b.cardName);
}

function playable(cards: readonly VariantCard[]): Map<string, VariantEntry> {
  const map = new Map<string, VariantEntry>();
  for (const c of cards) {
    if (c.isMaybeboard || c.isToken) continue;
    const key = c.cardName.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.quantity += c.quantity;
      existing.isCommander ||= c.isCommander;
    } else {
      map.set(key, {
        cardName: c.cardName,
        quantity: c.quantity,
        imageUrl: c.imageUrl,
        typeLine: c.typeLine,
        cmc: c.cmc,
        isCommander: c.isCommander,
      });
    }
  }
  return map;
}

export function compareDeckVariants(
  thisDeck: readonly VariantCard[],
  otherDeck: readonly VariantCard[],
): VariantComparison {
  const mine = playable(thisDeck);
  const other = playable(otherDeck);
  const result: VariantComparison = { common: [], onlyThis: [], onlyOther: [] };

  for (const [key, entry] of mine) {
    const match = other.get(key);
    const shared = Math.min(entry.quantity, match?.quantity ?? 0);
    if (shared > 0) result.common.push({ ...entry, quantity: shared });
    if (entry.quantity > shared)
      result.onlyThis.push({ ...entry, quantity: entry.quantity - shared });
  }
  for (const [key, entry] of other) {
    const shared = Math.min(entry.quantity, mine.get(key)?.quantity ?? 0);
    if (entry.quantity > shared)
      result.onlyOther.push({ ...entry, quantity: entry.quantity - shared });
  }

  result.common.sort(compareEntries);
  result.onlyThis.sort(compareEntries);
  result.onlyOther.sort(compareEntries);
  return result;
}

export function totalQuantity(entries: readonly VariantEntry[]): number {
  return entries.reduce((sum, e) => sum + e.quantity, 0);
}
