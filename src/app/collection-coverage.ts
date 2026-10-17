import { normalizeCardName } from './array-utils';

/**
 * Abgleich eines Decks mit der Sammlung (deck-collection/): Welche Karten fehlen, und welche
 * reichen zwar für dieses Deck, aber nicht für alle eigenen Decks zusammen ("2 besessen, in 3
 * Decks gebraucht"). Reine Funktion, damit sie ohne Datenbank prüfbar ist.
 */

export interface CollectionEntry {
  scryfallId: string;
  foil: boolean;
  cardName: string;
  lang: string;
  setCode: string;
  collectorNumber: string;
  illustrationId: string | null;
  quantity: number;
  addedAt: string;
}

/** Ein Druck, wie Scryfall ihn liefert - Grundlage zum Hinzufügen. */
export interface CollectionPrint {
  scryfallId: string;
  cardName: string;
  printedName: string | null;
  lang: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  illustrationId: string | null;
  imageUrl: string;
  /** Scryfalls finishes: "nonfoil", "foil", "etched". */
  finishes: string[];
}

/** Eine Karte in einem eigenen Deck (aus collection_deck_usage()). */
export interface DeckUsage {
  deckId: string;
  deckName: string;
  cardName: string;
  quantity: number;
  imageUrl: string | null;
}

/** Schlüssel des Abgleichs mit Decks - wie überall in der App die normalisierte Vorderseite. */
export function collectionKey(cardName: string): string {
  return normalizeCardName(cardName.split(' // ')[0].trim());
}

/** Bildadresse eines Drucks direkt aus der Scryfall-ID - ohne Anfrage. */
export function printImageUrl(scryfallId: string, size: 'small' | 'normal' = 'normal'): string {
  return `https://cards.scryfall.io/${size}/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`;
}

/** Scryfall-ID aus einer Bildadresse (deck_cards.image_url); eigene Uploads haben keine. */
export function printIdFromImageUrl(url: string | null | undefined): string | null {
  const m =
    /cards\.scryfall\.io\/[a-z_]+\/(?:front|back)\/[0-9a-f]\/[0-9a-f]\/([0-9a-f-]{36})\./.exec(
      url ?? '',
    );
  return m ? m[1] : null;
}

export interface CoverageDeckCard {
  cardName: string;
  quantity: number;
  imageUrl: string | null;
  isMaybeboard: boolean;
  isToken: boolean;
}

export interface CardCoverage {
  cardName: string;
  /** In diesem Deck gebraucht. */
  needed: number;
  /** Davon in der Sammlung (bei strenger Prüfung nur mit dem gewählten Artwork). */
  owned: number;
  missing: number;
  /** Besitz über alle Artworks - zeigt "hast du, aber in anderem Artwork". */
  ownedAnyArt: number;
  /** Gebraucht über alle eigenen Decks (dieses eingeschlossen). */
  neededAllDecks: number;
  /** Die anderen eigenen Decks mit dieser Karte. */
  otherDecks: { deckId: string; deckName: string; quantity: number }[];
}

export interface DeckCoverage {
  cards: CardCoverage[];
  neededTotal: number;
  ownedTotal: number;
  missing: CardCoverage[];
  /** Für dieses Deck vorhanden, aber zu wenige für alle Decks. */
  shared: CardCoverage[];
}

export function deckCoverage(options: {
  deckId: string;
  cards: readonly CoverageDeckCard[];
  ownedByName: ReadonlyMap<string, readonly CollectionEntry[]>;
  usage: readonly DeckUsage[];
  strictArt: boolean;
  /** illustration_id je Scryfall-Druck-ID der Deck-Bilder; fehlt eine, gilt die Karte als "egal". */
  illustrations: ReadonlyMap<string, string | null>;
}): DeckCoverage {
  const needed = new Map<string, { cardName: string; quantity: number; imageUrl: string | null }>();
  for (const card of options.cards) {
    if (card.isMaybeboard || card.isToken) continue;
    const key = collectionKey(card.cardName);
    const prev = needed.get(key);
    if (prev) prev.quantity += card.quantity;
    else
      needed.set(key, {
        cardName: card.cardName,
        quantity: card.quantity,
        imageUrl: card.imageUrl,
      });
  }

  const usageByName = new Map<string, DeckUsage[]>();
  for (const u of options.usage) {
    if (u.deckId === options.deckId) continue;
    const key = collectionKey(u.cardName);
    const list = usageByName.get(key);
    if (list) list.push(u);
    else usageByName.set(key, [u]);
  }

  const cards: CardCoverage[] = [];
  for (const [key, need] of needed) {
    const entries = options.ownedByName.get(key) ?? [];
    const ownedAnyArt = entries.reduce((sum, e) => sum + e.quantity, 0);
    let owned = ownedAnyArt;
    if (options.strictArt) {
      const printId = printIdFromImageUrl(need.imageUrl);
      const illustration = printId ? options.illustrations.get(printId) : null;
      if (illustration) {
        owned = entries
          .filter((e) => e.illustrationId === illustration)
          .reduce((sum, e) => sum + e.quantity, 0);
      }
    }
    const others = usageByName.get(key) ?? [];
    const otherDecks = new Map<string, { deckId: string; deckName: string; quantity: number }>();
    for (const u of others) {
      const prev = otherDecks.get(u.deckId);
      if (prev) prev.quantity += u.quantity;
      else
        otherDecks.set(u.deckId, { deckId: u.deckId, deckName: u.deckName, quantity: u.quantity });
    }
    const neededAllDecks = need.quantity + others.reduce((sum, u) => sum + u.quantity, 0);
    cards.push({
      cardName: need.cardName,
      needed: need.quantity,
      owned: Math.min(owned, need.quantity),
      missing: Math.max(0, need.quantity - owned),
      ownedAnyArt,
      neededAllDecks,
      otherDecks: [...otherDecks.values()].sort((a, b) => a.deckName.localeCompare(b.deckName)),
    });
  }
  cards.sort((a, b) => a.cardName.localeCompare(b.cardName));

  return {
    cards,
    neededTotal: cards.reduce((sum, c) => sum + c.needed, 0),
    ownedTotal: cards.reduce((sum, c) => sum + c.owned, 0),
    missing: cards.filter((c) => c.missing > 0),
    shared: cards.filter((c) => c.missing === 0 && c.ownedAnyArt < c.neededAllDecks),
  };
}
