import type { SpellbookCardFlags } from './card-data.service';

/**
 * Messbare Kennzahlen eines Decks - Tempo, Redundanz, Interaktion.
 *
 * Warum das neben bracket.ts steht: Die Bracket-Einstufung beantwortet "verletzt dieses Deck ein
 * Kriterium?". Diese Datei beantwortet die drei Fragen, die ein Tisch vor dem Spiel wirklich
 * stellt - wie schnell kann das Deck gewinnen, wie viele Wege hat es dorthin, und wie gut kann es
 * andere daran hindern. Der Tuning-Grad in bracket.ts nähert das bisher über Manakurve und
 * Manabasis an; das ist eine Hilfskonstruktion, keine Messung.
 *
 * Reine Rechenfunktionen ohne Angular- und ohne Netzwerkbezug - alle Eingaben kommen als Parameter
 * herein, gleiche Aufteilung wie bracket.ts und combo-finder.ts. Dadurch laufen dieselben
 * Funktionen sowohl in der App als auch im Auswertungsskript scripts/analyze-deck-corpus.js
 * (Node lädt die Datei über sein Typ-Stripping direkt) - es gibt also genau EINE Implementierung
 * je Kennzahl, die auch genau einmal getestet wird.
 *
 * Was diese Datei ausdrücklich NICHT tut: irgendetwas einstufen. Sie misst und gibt Zahlen zurück.
 * Welche Zahl welche Bracket-Stufe bedeutet, wird an echten Decks ermittelt (siehe
 * docs/deck-metriken-2026-09.md) und erst danach entschieden.
 */

/** Eine Deck-Karte, so weit die Kennzahlen sie brauchen. */
export interface MetricCard {
  /** Anzeigename. */
  name: string;
  /** Normalisierter Vorderseiten-Name - Schlüssel für Markierungen, Combos und Effekt-Kategorien. */
  key: string;
  quantity: number;
  cmc: number;
  /** Manakosten in Kartenschreibweise ("{1}{G}{G}") - Grundlage der Farbprüfung in mana.ts. */
  manaCost: string;
  typeLine: string;
  oracleText: string;
  /** Farbkürzel, die diese Karte erzeugen kann (Scryfall produced_mana). */
  producedMana: string[];
  gameChanger: boolean;
  isCommander: boolean;
}

/**
 * Eine Combo, unabhängig von ihrer Kartenzahl.
 *
 * Bewusst allgemeiner als SpellbookTwoCardCombo in card-data.service.ts: Für die Bracket-Kriterien
 * zählen laut Regelwerk nur Zwei-Karten-Combos, für die Frage "wie viele Wege zum Sieg hat das
 * Deck" aber jede - eine Drei-Karten-Combo ist ein Weg zum Sieg, auch wenn sie kein Kriterium
 * verletzt.
 */
export interface MetricCombo {
  id: string;
  /** Alle beteiligten Karten als normalisierte Namen. */
  cards: string[];
  /** Teilmenge von cards, die nur als Commander zählt. */
  mustBeCommander: string[];
  /** Zusätzlich nötiges Mana, um die Combo abzuschließen. */
  manaValueNeeded: number;
  /** Was die Combo erzeugt, in Spellbooks Benennung ("Infinite mana", "Win the game", ...). */
  produces: string[];
}

export interface MetricInput {
  cards: MetricCard[];
  combos: MetricCombo[];
  /** Kuratierte Markierungen von Commander Spellbook, Schlüssel wie MetricCard.key. */
  flags: Map<string, SpellbookCardFlags>;
  /**
   * Effekt-Kategorien je Karte ("removal", "counterspell", "protection", ...) - dieselben Keys wie
   * EFFECT_TAG_CATEGORIES in deck-viewer.service.ts bzw. scryfall_card_effects.category.
   */
  effects: Map<string, Set<string>>;
}

// =====================================================================================
// Bausteine, die mehrere Kennzahlen brauchen
// =====================================================================================

const LAND_RE = /Land/;

/**
 * Ein Land kommt bedingungslos getappt, wenn sein Regeltext "enters tapped" sagt und die Karte
 * keinen Ausweg anbietet - wortgleich zu DeckViewerService.untappedLandPercent(), damit dieselbe
 * Manabasis in Deck-Ansicht und Auswertung nicht zwei verschiedene Zahlen bekommt. Die Ausnahmen
 * trennen die Premium-Länder ab, die formal denselben Satz tragen (Schock-, Check-, Slow-,
 * Fastlands).
 */
const ENTERS_TAPPED_RE = /enters (?:the battlefield )?tapped/i;
const TAPPED_AUSNAHME_RE = /unless|you may pay/i;

/**
 * Eine "Add"-Klausel im Regeltext, in beiden Schreibweisen, die Magic dafür kennt:
 *
 *   Symbole  - "Add {C}{C}" sind zwei, "Add {G}" ist eins. Ein Symbol wie {W/U} zählt als eins,
 *              weil es genau ein Mana erzeugt.
 *   Wörter   - "Add one mana of any color", "Add two mana of any one color". Ohne diesen zweiten
 *              Fall fielen ausgerechnet die Moxe und alle Karten mit freier Farbwahl durchs
 *              Raster und ein Mox Diamond gälte als Karte, die gar kein Mana erzeugt.
 *
 * "Add X mana" bleibt bewusst draußen: Wie viel X ist, steht nicht im Text, und eine geratene
 * Zahl wäre schlechter als keine.
 */
const ADD_SYMBOLE_RE = /add\s+((?:\{[^}]+\}\s*)+)/gi;
const ADD_WORT_RE = /add\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+mana/gi;

const ZAHLWORT: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export function isLand(card: MetricCard): boolean {
  return LAND_RE.test(card.typeLine);
}

export function isUntappedLand(card: MetricCard): boolean {
  return !(ENTERS_TAPPED_RE.test(card.oracleText) && !TAPPED_AUSNAHME_RE.test(card.oracleText));
}

/** Wie viel Mana erzeugt die ergiebigste "Add"-Klausel dieser Karte? 0 = keine. */
export function manaProduced(card: MetricCard): number {
  let max = 0;
  for (const treffer of card.oracleText.matchAll(ADD_SYMBOLE_RE)) {
    const symbole = treffer[1].match(/\{[^}]+\}/g)?.length ?? 0;
    if (symbole > max) max = symbole;
  }
  for (const treffer of card.oracleText.matchAll(ADD_WORT_RE)) {
    const anzahl = ZAHLWORT[treffer[1].toLowerCase()] ?? 0;
    if (anzahl > max) max = anzahl;
  }
  return max;
}

/** Summe der Mengen - Karten stehen als eine Zeile mit quantity im Deck, nicht als n Zeilen. */
function menge(cards: MetricCard[]): number {
  return cards.reduce((summe, c) => summe + c.quantity, 0);
}

/** Karten, die mindestens eine der genannten Effekt-Kategorien tragen. */
export function cardsWithEffect(input: MetricInput, ...kategorien: string[]): MetricCard[] {
  return input.cards.filter((c) => {
    const eigene = input.effects.get(c.key);
    return eigene ? kategorien.some((k) => eigene.has(k)) : false;
  });
}

// =====================================================================================
// A - Wie schnell kann das Deck gewinnen?
// =====================================================================================

/**
 * Fast Mana: Karten, die mehr Mana erzeugen, als sie kosten.
 *
 * Genau diese Regel und keine Liste: Sol Ring (kostet 1, erzeugt 2), Mana Crypt und die Moxe
 * (kosten 0, erzeugen 1-2) und Rituale wie Dark Ritual fallen darunter, ein Arcane Signet (kostet
 * 2, erzeugt 1) nicht. Das ist der Unterschied zwischen "Manabeschleunigung" und "Rampe": Fast
 * Mana bringt das Deck im selben Zug voran, in dem es gespielt wird.
 *
 * Länder sind ausgenommen - ein Land kostet nichts und würde die Zahl sonst fluten.
 */
export function fastManaCount(cards: MetricCard[]): number {
  return menge(cards.filter((c) => !isLand(c) && manaProduced(c) > c.cmc));
}

/**
 * Wie viel Mana steht in Zug `turn` im Mittel zur Verfügung?
 *
 * Der ERWARTUNGSWERT, nicht die Obergrenze - und das ist der entscheidende Unterschied. Eine
 * Obergrenze ("alles Fast Mana des Decks liegt auf der Hand") lieferte für cEDH-Decks Werte wie 27
 * Mana in Zug 3 und war damit unbrauchbar; gespielt werden kann nur, was man bis dahin gesehen
 * hat. Gerechnet wird deshalb über den Anteil des Decks, den man in Zug `turn` überhaupt kennt:
 * sieben Karten Starthand plus eine je Zug ab dem zweiten (auf dem Spiel, siehe goldfish-sim.ts).
 *
 * Das Ergebnis ist bewusst eine Kommazahl - "2,4 Mana in Zug 2" heißt nicht, dass jemand 2,4 Mana
 * hat, sondern dass ein solches Deck im Schnitt dort steht. Wie oft es wirklich reicht, beantwortet
 * die Simulation.
 */
export function manaByTurn(cards: MetricCard[], turn: number): number {
  const gesamt = menge(cards);
  if (gesamt === 0) return 0;

  const gesehen = Math.min(gesamt, 7 + Math.max(0, turn - 1));
  const anteil = gesehen / gesamt;

  const laender = cards.filter(isLand);
  const landAnzahl = menge(laender);
  const landdrops = Math.min(turn, landAnzahl * anteil);

  // Ein getapptes Land bringt im Zug seines Spielens nichts - bei einer Manabasis, die zu 30 %
  // getappt kommt, fehlt im Schnitt 0,3 Mana.
  const ungetapptAnteil = landAnzahl === 0 ? 1 : menge(laender.filter(isUntappedLand)) / landAnzahl;
  const ausLaendern = Math.max(0, landdrops - (1 - ungetapptAnteil));

  const netto = cards
    .filter((c) => !isLand(c) && manaProduced(c) > c.cmc)
    .reduce((summe, c) => summe + (manaProduced(c) - c.cmc) * c.quantity, 0);

  return Math.round((ausLaendern + netto * anteil) * 10) / 10;
}

/**
 * Welche Combos stecken VOLLSTÄNDIG im Deck? Gegenstück zu presentCombos() in bracket.ts, aber
 * für Combos jeder Kartenzahl.
 */
export function completeCombos(input: MetricInput): MetricCombo[] {
  const vorhanden = new Map(input.cards.map((c) => [c.key, c]));
  return input.combos.filter((combo) => {
    for (const teil of combo.cards) {
      const karte = vorhanden.get(teil);
      if (!karte) return false;
      if (combo.mustBeCommander.includes(teil) && !karte.isCommander) return false;
    }
    return true;
  });
}

/**
 * Erzeugt diese Combo einen Sieg?
 *
 * "Infinite mana" allein gewinnt nicht - es braucht noch etwas, das das Mana in einen Sieg
 * übersetzt. Deshalb zählen nur Ergebnisse, die das Spiel tatsächlich beenden oder so viel
 * erzeugen, dass der Tisch es nicht überlebt.
 */
const SIEG_RE =
  /win the game|infinite (?:damage|mill|life loss|turns|combat|token)|each opponent loses/i;

export function isWinCombo(combo: MetricCombo): boolean {
  return combo.produces.some((p) => SIEG_RE.test(p));
}

/** Gesamtes Mana, das eine Combo kostet: alle Teile plus das zusätzlich nötige Mana. */
export function comboMana(combo: MetricCombo, cards: Map<string, MetricCard>): number {
  const teile = combo.cards.reduce((summe, k) => summe + (cards.get(k)?.cmc ?? 0), 0);
  return teile + combo.manaValueNeeded;
}

// =====================================================================================
// Das Gesamtbild
// =====================================================================================

export interface DeckMetrics {
  totalCards: number;

  // A - Tempo
  fastManaCount: number;
  landCount: number;
  untappedLandPercent: number | null;
  averageCmc: number | null;
  cheapCardRatio: number;
  manaByTurn3: number;
  cheapestWinComboMana: number | null;
  /** Erster Zug, in dem das Mana für die günstigste gewinnende Combo überhaupt dastehen kann. */
  earliestWinTurn: number | null;

  // B - Redundanz
  completeComboCount: number;
  winComboCount: number;
  distinctWinLines: number;
  tutorCount: number;
  drawCount: number;

  // C - Interaktion
  //
  // Schutzeffekte fehlen hier bewusst: Die Kategorie "protection" ist in scryfall_card_effects
  // nicht befuellt (nachgemessen: 0 Zeilen), eine Kennzahl daraus waere konstant null. Sie kommt
  // dazu, sobald der Nachtlauf sie mitfuehrt.
  freeInteractionCount: number;
  counterspellCount: number;
  removalCount: number;
  boardwipeCount: number;
  rampCount: number;
  interactionDensity: number;

  // D - Kontrollgrößen
  gameChangerCount: number;
  /** Wie viele Farben die Manabasis erzeugen kann - nicht die Farbidentitaet des Decks. */
  colorCount: number;
}

/**
 * Freie Interaktion - der schärfste Marker, den cEDH überhaupt hat.
 *
 * Ein Deck, das seine Combo durchdrücken will, muss die Combo der anderen stoppen können, OHNE
 * dafür seinen eigenen Zug zu opfern. Genau das leisten Karten, die sich ohne Manakosten spielen
 * lassen (Force of Will, Fierce Guardianship, die Pacts) - im Format gibt es davon knapp 70, und
 * sie tauchen praktisch nur in durchgebauten Decks auf. Dazu kommen Konter für ein Mana.
 */
const FREI_RE = /without paying (?:its|their) mana cost/i;

export function freeInteractionCards(input: MetricInput): MetricCard[] {
  const konter = new Set(cardsWithEffect(input, 'counterspell').map((c) => c.key));
  return input.cards.filter((c) => FREI_RE.test(c.oracleText) || (konter.has(c.key) && c.cmc <= 1));
}

export function computeDeckMetrics(input: MetricInput): DeckMetrics {
  const alle = input.cards;
  const gesamt = menge(alle);
  const laender = alle.filter(isLand);
  const landAnzahl = menge(laender);
  const nichtLand = alle.filter((c) => !isLand(c));
  const nichtLandMenge = menge(nichtLand);

  const nachSchluessel = new Map(alle.map((c) => [c.key, c]));
  const vollstaendig = completeCombos(input);
  const siegCombos = vollstaendig.filter(isWinCombo);
  const siegManaWerte = siegCombos.map((c) => comboMana(c, nachSchluessel));
  const guenstigsteSieg = siegManaWerte.length > 0 ? Math.min(...siegManaWerte) : null;

  const frei = menge(freeInteractionCards(input));
  const konter = menge(cardsWithEffect(input, 'counterspell'));
  const entfernung = menge(cardsWithEffect(input, 'removal'));

  return {
    totalCards: gesamt,

    fastManaCount: fastManaCount(alle),
    landCount: landAnzahl,
    untappedLandPercent:
      landAnzahl === 0
        ? null
        : Math.round((menge(laender.filter(isUntappedLand)) / landAnzahl) * 100),
    averageCmc:
      nichtLandMenge === 0
        ? null
        : Math.round(
            (nichtLand.reduce((s, c) => s + c.cmc * c.quantity, 0) / nichtLandMenge) * 100,
          ) / 100,
    cheapCardRatio: gesamt === 0 ? 0 : menge(nichtLand.filter((c) => c.cmc <= 1)) / gesamt,
    manaByTurn3: manaByTurn(alle, 3),
    cheapestWinComboMana: guenstigsteSieg,
    earliestWinTurn: guenstigsteSieg === null ? null : ersterZugMitMana(alle, guenstigsteSieg),

    completeComboCount: vollstaendig.length,
    winComboCount: siegCombos.length,
    distinctWinLines: new Set(siegCombos.flatMap((c) => c.produces)).size,
    tutorCount: menge(alle.filter((c) => input.flags.get(c.key)?.tutor === true)),
    drawCount: menge(cardsWithEffect(input, 'draw')),

    freeInteractionCount: frei,
    counterspellCount: konter,
    removalCount: entfernung,
    boardwipeCount: menge(cardsWithEffect(input, 'boardwipe')),
    rampCount: menge(cardsWithEffect(input, 'ramp')),
    interactionDensity: gesamt === 0 ? 0 : (konter + entfernung + frei) / gesamt,

    gameChangerCount: menge(alle.filter((c) => c.gameChanger)),
    colorCount: new Set(alle.flatMap((c) => c.producedMana).filter((f) => f !== 'C')).size,
  };
}

/** Erster Zug (1-10), in dem manaByTurn() den geforderten Betrag erreicht. null = nie. */
function ersterZugMitMana(cards: MetricCard[], benoetigt: number): number | null {
  for (let zug = 1; zug <= 10; zug++) {
    if (manaByTurn(cards, zug) >= benoetigt) return zug;
  }
  return null;
}
