import type { SpellbookTwoCardCombo } from './card-data.service';
import type { BracketCard } from './bracket';

/**
 * Der Combo-Finder: WELCHE KARTE FEHLT NOCH?
 *
 * Gegenstück zu presentCombos() in bracket.ts. Dort geht es um die Combos, die im Deck schon
 * vollständig drinstecken; hier um die, denen genau EINE Karte fehlt - also um konkrete
 * Kaufvorschläge ("nimm Karte X dazu, dann hast du mit Y eine Combo").
 *
 * Datenquelle ist dieselbe gespiegelte Zwei-Karten-Combo-Tabelle aus dem nächtlichen
 * Commander-Spellbook-Abgleich (sql/spellbook-cache-2026-09-06.sql). Es wird also nichts live
 * abgefragt und nichts geraten.
 *
 * Reine Rechenfunktionen ohne Angular- und Netzwerkbezug, damit sich jede Regel in
 * combo-finder.spec.ts einzeln festnageln lässt - gleiche Aufteilung wie bei bracket.ts.
 */

/** Eine Combo, der genau eine Karte fehlt, samt der Karte, die das Deck dafür schon hat. */
export interface ComboMatch {
  combo: SpellbookTwoCardCombo;
  /** Die Karte aus dem Deck, mit der die Combo zustande käme. */
  partner: BracketCard;
}

/** Eine vorgeschlagene Karte: ihr Schlüssel und alles, was sie im Deck freischalten würde. */
export interface ComboSuggestion {
  /** Normalisierter Vorderseiten-Name der fehlenden Karte - Schlüssel wie BracketCard.key. */
  key: string;
  /** Alle Combos, die genau diese eine Karte vervollständigen würde. Nie leer. */
  matches: ComboMatch[];
}

/**
 * Welche Karten würden im Deck neue Zwei-Karten-Combos ergeben?
 *
 * Eine Combo zählt nur, wenn GENAU EINE ihrer beiden Karten im Deck liegt: liegen beide drin, ist
 * sie längst vorhanden (und steht in der Combo-Liste der Analyse), liegt keine drin, wäre der
 * Vorschlag zwei Karten weit weg und damit kein Vorschlag mehr, sondern eine zweite Deckidee.
 *
 * Zwei Fälle, in denen die mustBeCommander-Bedingung der Quelle einen Vorschlag ausschließt
 * (dieselben 42 Combos, die auch presentCombos() gesondert behandelt):
 *
 * 1. Die FEHLENDE Karte müsste der Commander sein. Sie einfach ins Deck zu legen brächte nichts -
 *    und den Commander zu tauschen ist kein Kartenvorschlag, sondern ein anderes Deck.
 * 2. Die VORHANDENE Karte müsste der Commander sein, ist es aber nicht. Dann liefe die Combo auch
 *    mit der Ergänzung nicht.
 *
 * Sortiert nach Nutzen: erst die Karte, die die meisten Combos auf einmal freischaltet, bei
 * Gleichstand die bei Commander Spellbook beliebtere (popularity), zuletzt alphabetisch, damit die
 * Reihenfolge bei gleichen Werten stabil bleibt.
 */
export function missingComboPartners(
  cards: BracketCard[],
  combos: SpellbookTwoCardCombo[],
): ComboSuggestion[] {
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const nachSchluessel = new Map<string, ComboMatch[]>();

  for (const combo of combos) {
    // Eine Combo aus zweimal derselben Karte ist über die Deckliste nicht abbildbar - dass die
    // Karte fehlt UND vorhanden ist, kann nicht beides stimmen.
    if (combo.cardA === combo.cardB) continue;

    const a = byKey.get(combo.cardA);
    const b = byKey.get(combo.cardB);
    // Beide da (schon vorhanden) oder keine da (zu weit weg) - beides kein Vorschlag.
    if (!!a === !!b) continue;

    const partner = (a ?? b) as BracketCard;
    const fehlt = a ? combo.cardB : combo.cardA;
    const partnerMussCommanderSein = a ? combo.aMustBeCommander : combo.bMustBeCommander;
    const fehlendeMussCommanderSein = a ? combo.bMustBeCommander : combo.aMustBeCommander;

    if (fehlendeMussCommanderSein) continue;
    if (partnerMussCommanderSein && !partner.isCommander) continue;

    const liste = nachSchluessel.get(fehlt) ?? [];
    liste.push({ combo, partner });
    nachSchluessel.set(fehlt, liste);
  }

  return [...nachSchluessel]
    .map(([key, matches]) => ({ key, matches }))
    .sort(
      (x, y) =>
        y.matches.length - x.matches.length ||
        hoechstePopularitaet(y) - hoechstePopularitaet(x) ||
        x.key.localeCompare(y.key),
    );
}

function hoechstePopularitaet(vorschlag: ComboSuggestion): number {
  return vorschlag.matches.reduce((max, m) => Math.max(max, m.combo.popularity ?? 0), 0);
}

/**
 * Darf diese Karte überhaupt ins Deck? Im Commander schon dann nicht, wenn sie eine Farbe
 * mitbringt, die die Farbidentität des Commanders nicht hat - ein Vorschlag, den man gar nicht
 * spielen darf, ist kein Vorschlag.
 *
 * Farblose Karten (leere Farbidentität) passen immer, in jedes Deck. Ist die Farbidentität des
 * Decks unbekannt (kein Commander gesetzt, Kartendetails noch nicht geladen), wird nicht
 * gefiltert - lieber einen Vorschlag zu viel als eine leere Liste ohne erkennbaren Grund.
 */
export function fitsColorIdentity(
  cardIdentity: string[] | undefined,
  deckIdentity: string[] | null,
): boolean {
  if (deckIdentity === null) return true;
  const erlaubt = new Set(deckIdentity);
  return (cardIdentity ?? []).every((farbe) => erlaubt.has(farbe));
}
