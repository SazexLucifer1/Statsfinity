/**
 * Manakosten lesen und bezahlen - nach den Manasymbolen, die Scryfall liefert, und den Regeln,
 * die Wizards dazu schreibt.
 *
 * Warum es diese Datei gibt: Die Goldfish-Simulation rechnete Mana zuvor als reine Zahl. Gemessen
 * an 1.406 Karten aus 60 cEDH-Decks haben aber 1.019 von 1.192 Zaubersprüchen farbige Kosten - die
 * Simulation hat also bei 85 % aller Karten die eigentliche Frage gar nicht gestellt ("habe ich die
 * RICHTIGE Farbe?") und nur gezählt. Dazu kamen 21 Karten mit Hybrid- oder Phyrexia-Kosten und 22
 * mit {X}, für die es überhaupt keine Behandlung gab.
 *
 * Die Regelbelege stehen an jeder Stelle, an der eine Entscheidung fällt, mit Nummer; die Absätze
 * im Wortlaut in docs/mtg-regeln.md. Wo die Simulation vereinfacht, steht das als Kommentar
 * daneben und nicht in einer Fußnote - eine Vereinfachung, die man erst im Bericht findet, hat im
 * Code niemandem geholfen.
 *
 * Reine Rechenfunktionen, keine Abhängigkeit auf Angular oder Netzwerk - wie deck-metrics.ts, und
 * aus demselben Grund: dieselbe Datei läuft in der App und in scripts/analyze-deck-corpus.js.
 */

import { SCRYFALL_MANA_SYMBOLS } from './mana-symbols.generated';

/**
 * Die sechs Manatypen. Fünf Farben plus farblos.
 *
 * CR 107.4a: "There are five primary colored mana symbols: {W} is white, {U} blue, {B} black,
 * {R} red, and {G} green."
 * CR 107.4c: "The colorless mana symbol {C} is used to represent one colorless mana, and also to
 * represent a cost that can be paid only with one colorless mana."
 */
export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

const FARBEN: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

/** Ein Eintrag aus Scryfalls /symbology, so wie mana-symbols.generated.ts ihn ablegt. */
export interface ScryfallManaSymbol {
  /** Das Symbol mit geschweiften Klammern, z. B. "{W/U}". */
  symbol: string;
  /** Scryfalls mana_value - was das Symbol zum Manawert beiträgt. */
  manaValue: number;
  /** Scryfalls colors - die Farben des Symbols, ohne Farblos. */
  colors: string[];
  hybrid: boolean;
  phyrexian: boolean;
  /** Scryfalls Klartext ("one white or blue mana") - macht den Code beim Lesen überprüfbar. */
  english: string;
}

/**
 * Eine einzelne Forderung aus einer Manakosten-Angabe, auf die Frage heruntergebrochen, die beim
 * Bezahlen zählt: Womit lässt sich dieses eine Symbol begleichen?
 *
 * CR 601.2b nennt genau diese drei Wahlmöglichkeiten, die hier abgebildet sind: "If the spell has
 * a variable cost that will be paid as it's being cast (such as an {X} in its mana cost […]), the
 * player announces the value of that variable. […] If a cost that will be paid as the spell is
 * being cast includes hybrid mana symbols, the player announces the nonhybrid equivalent cost they
 * intend to pay. If a cost that will be paid as the spell is being cast includes Phyrexian mana
 * symbols, the player announces whether they intend to pay 2 life or a corresponding colored mana
 * cost for each of those symbols."
 */
export interface ManaRequirement {
  symbol: string;
  /** Manatypen, mit denen sich das Symbol mit EINEM Mana bezahlen lässt. Leer = nur die Ausweichzahlung. */
  colors: ManaColor[];
  /** Ausweichzahlung in generischem Mana ({2/W} → 2), 0 wenn es keine gibt. */
  genericAlternative: number;
  /** Ausweichzahlung in Lebenspunkten ({W/P} → 2), 0 wenn es keine gibt. */
  lifeAlternative: number;
}

/** Eine gelesene Manakosten-Angabe. */
export interface ManaCost {
  /**
   * Generisches Mana aus den Zahlsymbolen. {X} steuert 0 bei.
   *
   * CR 107.4b: "Numerical symbols (such as {1}) and variable symbols (such as {X}) represent
   * generic mana in costs. Generic mana in costs can be paid with any type of mana."
   */
  generic: number;
  /** Alle Symbole, die an einen Manatyp gebunden sind, in der Reihenfolge der Kosten. */
  requirements: ManaRequirement[];
  /** Symbole, die die Scryfall-Tabelle nicht kennt - sichtbar, statt still verschluckt. */
  unknown: string[];
}

/** Ein einzelnes Mana im Manavorrat: die Typen, als die es gewählt werden darf. */
export type ManaUnit = readonly ManaColor[];

/**
 * Eine Manaquelle: wie viel sie auf einmal erzeugt und in welchen Typen.
 *
 * CR 106.4: "When an effect instructs a player to add mana, that mana goes into a player's mana
 * pool. From there, it can be used to pay costs immediately, or it can stay in the player's mana
 * pool as unspent mana. Each player's mana pool empties at the end of each step and phase […]"
 */
export interface ManaSource {
  amount: number;
  colors: readonly ManaColor[];
}

// =====================================================================================
// Manakosten lesen
// =====================================================================================

const SYMBOL_RE = /\{[^}]+\}/g;

/**
 * Nachschlagetabelle über alle 75 Manasymbole.
 *
 * Zusätzlich unter dem sortierten Innenteil abgelegt: Scryfall schreibt Hybridsymbole in genau
 * einer Reihenfolge ({W/U}, nie {U/W}), aber Kartendaten aus anderen Quellen halten sich nicht
 * immer daran. Ohne den zweiten Schlüssel fiele so ein Symbol als "unbekannt" heraus und die Karte
 * gälte stillschweigend als billiger, als sie ist.
 */
const NACH_SYMBOL = new Map<string, ScryfallManaSymbol>();
for (const eintrag of SCRYFALL_MANA_SYMBOLS) {
  NACH_SYMBOL.set(eintrag.symbol, eintrag);
  const sortiert = `{${eintrag.symbol.slice(1, -1).split('/').sort().join('/')}}`;
  if (!NACH_SYMBOL.has(sortiert)) NACH_SYMBOL.set(sortiert, eintrag);
}

export function manaSymbol(symbol: string): ScryfallManaSymbol | null {
  const gross = symbol.toUpperCase();
  return (
    NACH_SYMBOL.get(gross) ??
    NACH_SYMBOL.get(`{${gross.slice(1, -1).split('/').sort().join('/')}}`) ??
    null
  );
}

const IST_ZAHL_RE = /^\{\d+\}$/;
const IST_VARIABLE_RE = /^\{[XYZ]\}$/;

/**
 * Ein Symbol in die Frage übersetzen, die beim Bezahlen zählt.
 *
 * Die Fallunterscheidung folgt CR 107.4c/e/f. Auseinanderhalten lassen sich die drei Hybridformen
 * an Scryfalls eigenen Feldern: {W/U} hat zwei Farben, {C/W} hat eine Farbe und Manawert 1 (die
 * andere Hälfte ist farbloses Mana), {2/W} hat eine Farbe und Manawert 2 (die andere Hälfte sind
 * zwei generische Mana).
 */
function forderung(eintrag: ScryfallManaSymbol): ManaRequirement | null {
  const farben = eintrag.colors.filter((f): f is ManaColor =>
    (FARBEN as readonly string[]).includes(f),
  );

  // CR 107.4f: "A Phyrexian mana symbol represents a cost that can be paid either with one mana of
  // its color or by paying 2 life. […] A hybrid Phyrexian mana symbol represents a cost that can be
  // paid with one mana of either of its component colors or by paying 2 life."
  if (eintrag.phyrexian) {
    return {
      symbol: eintrag.symbol,
      colors: farben.length > 0 ? farben : ['C'],
      genericAlternative: 0,
      lifeAlternative: 2,
    };
  }

  // CR 107.4e: "A hybrid symbol such as {W/U} can be paid with either white or blue mana, and a
  // monocolored hybrid symbol such as {2/B} can be paid with either one black mana or two mana of
  // any type."
  if (eintrag.hybrid) {
    if (farben.length >= 2) {
      return { symbol: eintrag.symbol, colors: farben, genericAlternative: 0, lifeAlternative: 0 };
    }
    return {
      symbol: eintrag.symbol,
      colors: eintrag.manaValue >= 2 ? farben : [...farben, 'C'],
      genericAlternative: eintrag.manaValue >= 2 ? eintrag.manaValue : 0,
      lifeAlternative: 0,
    };
  }

  // CR 107.4a: farbiges Mana in Kosten "can be paid only with the appropriate color of mana".
  if (farben.length === 1) {
    return { symbol: eintrag.symbol, colors: farben, genericAlternative: 0, lifeAlternative: 0 };
  }

  if (eintrag.symbol === '{C}') {
    return { symbol: '{C}', colors: ['C'], genericAlternative: 0, lifeAlternative: 0 };
  }

  return null;
}

/**
 * Eine Manakosten-Angabe wie "{1}{G/W}{G/W}" lesen.
 *
 * CR 202.1: "A card's mana cost is indicated by mana symbols near the top of the card."
 *
 * Zwei bewusste Vereinfachungen, beide nach oben abgerundet zugunsten des Decks:
 *
 *   {X}  zählt 0. CR 202.3e: "When calculating the mana value of an object with an {X} in its mana
 *        cost, X is treated as 0 while the object is not on the stack, and X is treated as the
 *        number chosen for it while the object is on the stack." Beim Wirken wählt der Spieler den
 *        Wert (CR 107.3, CR 601.2b) - die Simulation wählt 0, weil jeder andere Wert eine Annahme
 *        darüber wäre, wofür die Karte gerade gebraucht wird.
 *   {S}  zählt als ein generisches Mana. CR 107.4h verlangt "one mana of any type produced by a
 *        snow source"; welche Quelle Schnee ist, führt die Simulation nicht mit. Sie überschätzt
 *        damit Decks mit Schneekosten - im Korpus sind das einzelne Karten.
 */
export function parseManaCost(manaCost: string | null | undefined): ManaCost {
  const kosten: ManaCost = { generic: 0, requirements: [], unknown: [] };
  if (!manaCost) return kosten;

  for (const roh of manaCost.toUpperCase().match(SYMBOL_RE) ?? []) {
    if (IST_VARIABLE_RE.test(roh)) continue; // {X}: gewählter Wert 0, siehe oben
    if (IST_ZAHL_RE.test(roh)) {
      kosten.generic += Number(roh.slice(1, -1));
      continue;
    }

    const eintrag = manaSymbol(roh);
    if (!eintrag) {
      kosten.unknown.push(roh);
      continue;
    }
    if (eintrag.symbol === '{S}') {
      kosten.generic += 1;
      continue;
    }

    const f = forderung(eintrag);
    if (f) kosten.requirements.push(f);
    else kosten.generic += eintrag.manaValue;
  }

  return kosten;
}

/**
 * Manawert einer gelesenen Kostenangabe.
 *
 * CR 202.3: "The mana value of an object is a number equal to the total amount of mana in its mana
 * cost, regardless of color."
 * CR 202.3f: "When calculating the mana value of an object with a hybrid mana symbol in its mana
 * cost, use the largest component of each hybrid symbol."
 */
export function manaValue(kosten: ManaCost): number {
  return (
    kosten.generic +
    kosten.requirements.reduce((summe, f) => summe + Math.max(1, f.genericAlternative), 0)
  );
}

// =====================================================================================
// Manakosten bezahlen
// =====================================================================================

export interface Zahlung {
  /** Der Manavorrat nach der Zahlung. */
  pool: ManaUnit[];
  /** Wie viele Lebenspunkte für Phyrexia-Symbole geflossen sind. */
  lifePaid: number;
}

/** Aus Manaquellen einen Vorrat einzelner Mana machen - bezahlt wird Symbol für Symbol. */
export function poolAus(quellen: readonly ManaSource[]): ManaUnit[] {
  const pool: ManaUnit[] = [];
  for (const quelle of quellen) {
    for (let i = 0; i < quelle.amount; i++) pool.push(quelle.colors);
  }
  return pool;
}

/**
 * Maximale Zuordnung zwischen Forderungen und einzelnen Mana (Ungarischer Weg / Kuhn).
 *
 * Warum überhaupt eine Zuordnung und keine Schleife: Ein Mana kann oft mehrere Forderungen
 * bedienen (eine Kreatur mit "Add one mana of any color" jede farbige), und jede Forderung mehrere
 * Mana akzeptieren. Wer stur von vorn zuteilt, verbaut sich die Farbe, die das nächste Symbol
 * gebraucht hätte, und erklärt eine bezahlbare Karte für unbezahlbar. Die Zuordnung ist klein -
 * höchstens eine Handvoll Symbole gegen ein paar Dutzend Mana - und exakt.
 */
function zuordnen(forderungen: ManaRequirement[], pool: ManaUnit[]): number[] {
  const zuMana: number[] = new Array(forderungen.length).fill(-1);
  const zuForderung: number[] = new Array(pool.length).fill(-1);

  const suche = (f: number, besucht: boolean[]): boolean => {
    for (let m = 0; m < pool.length; m++) {
      if (besucht[m] || !forderungen[f].colors.some((farbe) => pool[m].includes(farbe))) continue;
      besucht[m] = true;
      if (zuForderung[m] === -1 || suche(zuForderung[m], besucht)) {
        zuForderung[m] = f;
        zuMana[f] = m;
        return true;
      }
    }
    return false;
  };

  for (let f = 0; f < forderungen.length; f++) suche(f, new Array(pool.length).fill(false));
  return zuMana;
}

/** Wie viele Ausweichzahlungen höchstens durchprobiert werden - 2^8 Fälle sind sofort gerechnet. */
const MAX_AUSWEICHSYMBOLE = 8;

/**
 * Lässt sich diese Kostenangabe aus dem Vorrat bezahlen? Wenn ja: was bleibt übrig?
 *
 * Der Ablauf entspricht CR 601.2f/g - erst steht der Gesamtbetrag fest, dann wird bezahlt:
 * "The player determines the total cost of the spell. […] If the total cost includes a mana
 * payment, the player then has a chance to activate mana abilities […]".
 *
 * Die Ausweichzahlungen aus CR 601.2b ({2/W} als zwei generische Mana, Phyrexia als 2 Leben)
 * werden durchprobiert statt geraten: Eine reine Zuordnung würde ein {W/P} mit dem einen weißen
 * Mana begleichen, das das {1} daneben gebraucht hätte, obwohl 2 Leben die Sache lösen. Bei
 * höchstens acht solcher Symbole je Karte sind das 256 Fälle - im Korpus kommt kein einziges über
 * drei.
 *
 * CR 118.3: "A player can't pay a cost without having the necessary resources to pay it fully. For
 * example, a player with only 1 life can't pay a cost of 2 life […]" - deshalb ist `life` eine
 * Obergrenze und keine Formsache.
 */
export function payManaCost(kosten: ManaCost, pool: ManaUnit[], life: number): Zahlung | null {
  const ausweich = kosten.requirements.filter(
    (f) => f.genericAlternative > 0 || f.lifeAlternative > 0,
  );
  const varianten = ausweich.length <= MAX_AUSWEICHSYMBOLE ? 1 << ausweich.length : 1;

  let beste: Zahlung | null = null;

  for (let maske = 0; maske < varianten; maske++) {
    let generisch = kosten.generic;
    let leben = 0;
    const perMana: ManaRequirement[] = [];
    let moeglich = true;
    let naechstesAusweich = 0;

    for (const f of kosten.requirements) {
      const hatAusweich = f.genericAlternative > 0 || f.lifeAlternative > 0;
      const nutztAusweich = hatAusweich && (maske & (1 << naechstesAusweich++)) !== 0;
      if (!hatAusweich || !nutztAusweich) {
        if (f.colors.length === 0) moeglich = false;
        else perMana.push(f);
        continue;
      }
      generisch += f.genericAlternative;
      leben += f.lifeAlternative;
    }
    if (!moeglich || leben > life) continue;

    const zuMana = zuordnen(perMana, pool);
    if (zuMana.some((m) => m === -1)) continue;

    const belegt = new Set(zuMana);
    // Generisches Mana zuerst mit den unbeweglichsten Mana bezahlen - was viele Farben kann,
    // wird für die nächste farbige Forderung im selben Zug noch gebraucht.
    const rest = pool
      .map((einheit, index) => ({ einheit, index }))
      .filter(({ index }) => !belegt.has(index))
      .sort((a, b) => a.einheit.length - b.einheit.length);
    if (rest.length < generisch) continue;

    const uebrig = rest.slice(generisch).map((r) => r.einheit);
    if (!beste || leben < beste.lifePaid) beste = { pool: uebrig, lifePaid: leben };
    if (leben === 0) return beste; // billiger geht es nicht
  }

  return beste;
}

/** Kurzform für "kann ich mir das leisten?", ohne den Rest-Vorrat zu brauchen. */
export function canPayManaCost(kosten: ManaCost, pool: ManaUnit[], life: number): boolean {
  return payManaCost(kosten, pool, life) !== null;
}
