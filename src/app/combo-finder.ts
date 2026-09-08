import type { ComboSuggestionRow } from './card-data.service';

/**
 * Der Combo-Finder: WELCHE KARTE FEHLT NOCH?
 *
 * Gegenstück zu presentCombos() in bracket.ts. Dort geht es um die Combos, die im Deck schon
 * vollständig drinstecken; hier um die, denen genau EINE Karte fehlt - also um konkrete
 * Kaufvorschläge ("nimm Karte X dazu, dann hast du mit Y und Z eine Combo").
 *
 * Die Kartenzahl der Combo spielt dabei keine Rolle: "eine liegt im Deck, die zweite fehlt" ist
 * derselbe Vorschlag wie "drei liegen im Deck, die vierte fehlt".
 *
 * Welche Combos das sind, beantwortet die Datenbankfunktion spellbook_combos_missing_one (siehe
 * sql/spellbook-combos-2026-09-07.sql) - eine Gruppierung über 350.000 Kartenzeilen gehört nicht
 * in den Browser. Hier bleibt, was danach kommt: nach der fehlenden Karte bündeln, nach Nutzen
 * sortieren und auf die Farben des Decks eingrenzen.
 *
 * Reine Rechenfunktionen ohne Angular- und Netzwerkbezug, damit sich jede Regel in
 * combo-finder.spec.ts einzeln festnageln lässt - gleiche Aufteilung wie bei bracket.ts.
 */

/** Eine vorgeschlagene Karte und alles, was sie im Deck freischalten würde. */
export interface ComboSuggestion {
  /** Normalisierter Vorderseiten-Name der fehlenden Karte. */
  key: string;
  /**
   * Wie viele Combos diese Karte insgesamt freischaltet. Kann größer sein als combos.length: die
   * Suche gibt je Karte nur die beliebtesten Combos zurück, weil eine einzelne Karte in
   * dreistellig vielen stecken kann.
   */
  comboCount: number;
  /** Die zurückgelieferten Combos, beliebteste zuerst. Nie leer. */
  combos: ComboSuggestionRow[];
}

/**
 * Bündelt die Suchtreffer nach der fehlenden Karte und sortiert nach Nutzen.
 *
 * Sortiert wird hier ein zweites Mal, obwohl die Datenbank das schon tut: Die Reihenfolge einer
 * SQL-Antwort ist nichts, worauf sich eine Oberfläche verlassen sollte, und die Regel gehört
 * ohnehin an eine Stelle, an der sie prüfbar ist. Erst die Karte, die die meisten Combos auf
 * einmal freischaltet, bei Gleichstand die mit der beliebtesten Combo, zuletzt alphabetisch,
 * damit die Reihenfolge bei gleichen Werten stabil bleibt.
 */
export function groupSuggestions(rows: ComboSuggestionRow[]): ComboSuggestion[] {
  const nachSchluessel = new Map<string, ComboSuggestion>();

  for (const row of rows) {
    const vorhanden = nachSchluessel.get(row.missing);
    if (vorhanden) {
      vorhanden.combos.push(row);
      // Die Zahl steht in jeder Zeile derselben Karte gleich - die größte zu nehmen kostet nichts
      // und ist gegen eine unvollständige Antwort robust.
      vorhanden.comboCount = Math.max(vorhanden.comboCount, row.comboCount);
    } else {
      nachSchluessel.set(row.missing, {
        key: row.missing,
        comboCount: row.comboCount,
        combos: [row],
      });
    }
  }

  for (const vorschlag of nachSchluessel.values()) {
    vorschlag.combos.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  }

  return [...nachSchluessel.values()].sort(
    (x, y) =>
      y.comboCount - x.comboCount ||
      hoechstePopularitaet(y) - hoechstePopularitaet(x) ||
      x.key.localeCompare(y.key),
  );
}

function hoechstePopularitaet(vorschlag: ComboSuggestion): number {
  return vorschlag.combos.reduce((max, c) => Math.max(max, c.popularity ?? 0), 0);
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

/**
 * Der Ablauf als einzelne Schritte. Commander Spellbook liefert ihn als einen Text mit einem
 * Zeilenumbruch je Schritt; aufgeteilt ist er als nummerierte Liste zu lesen, und die
 * Beschreibungen verweisen selbst auf Schrittnummern ("Repeat from step 4").
 *
 * Jeder Schritt kommt schon zerlegt zurück, weil auch mitten im Fließtext Manasymbole stehen
 * ("Activate Patron of the Moon by paying {1}") - als rohe geschweifte Klammern gelesen ist das
 * die Rohform der Quelle, nicht das, was auf einer Karte steht.
 */
export function comboSteps(description: string): ManaPart[][] {
  return description
    .split('\n')
    .filter((step) => step.trim())
    .map((step) => splitManaSymbols(step.trim()));
}

/** Ein Stück einer Manakosten-Angabe: entweder ein Symbol oder erklärender Text drumherum. */
export interface ManaPart {
  kind: 'symbol' | 'text';
  /** Beim Symbol der Inhalt der geschweiften Klammern ('U', '3', 'U/R'), sonst der Text. */
  value: string;
}

/**
 * Welche Inhalte geschweifter Klammern die Mana-Schrift als Symbol darstellen kann: Farben,
 * generische Beträge, farblos, X, Energie, Schnee, Tappen und die Hybride (auch die phyrexianischen
 * wie {B/P}).
 *
 * Bewusst eine Positivliste statt "alles in Klammern ist ein Symbol": Der Baustein fällt bei
 * Unbekanntem auf das farblose Symbol zurück, und ein graues Manasymbol für etwas, das gar keins
 * ist, behauptet schlicht etwas Falsches. Was hier nicht steht, bleibt als Text in seinen Klammern
 * stehen - lesbar und nie irreführend.
 */
const MANA_TOKEN = /^(?:[WUBRGCXEST]|\d{1,2}|[WUBRG0-9]+\/[WUBRGP])$/i;

/**
 * Zerlegt einen Text in Manasymbole und alles dazwischen, ohne etwas zu verändern.
 *
 * Grundlage sowohl für die Manaangabe einer Combo als auch für ihren Ablauf. Anders als
 * parseManaCost() bleibt hier jedes Leerzeichen stehen: im Fließtext ist der Abstand Teil des
 * Satzes ("by paying {1}, putting ..." darf nicht zu "by paying{1}, putting" werden).
 */
export function splitManaSymbols(text: string): ManaPart[] {
  const teile: ManaPart[] = [];
  const merkeText = (wert: string) => {
    if (!wert) return;
    // Aufeinanderfolgende Textstücke zusammenziehen, damit ein unbekanntes Token wie {T} nicht
    // den Satz um sich herum in drei Fetzen zerlegt.
    const letztes = teile[teile.length - 1];
    if (letztes?.kind === 'text') letztes.value += wert;
    else teile.push({ kind: 'text', value: wert });
  };

  let rest = text;
  while (rest.length > 0) {
    const treffer = rest.match(/\{([^}]*)\}/);
    if (!treffer) break;
    merkeText(rest.slice(0, treffer.index));
    if (MANA_TOKEN.test(treffer[1])) teile.push({ kind: 'symbol', value: treffer[1] });
    else merkeText(treffer[0]);
    rest = rest.slice((treffer.index ?? 0) + treffer[0].length);
  }
  merkeText(rest);

  return teile;
}

/**
 * Zerlegt Commander Spellbooks Manaangabe in Symbole und Text.
 *
 * Die Quelle liefert das zusätzlich nötige Mana als Kartenschreibweise ("{1}{R}{R}") - als
 * nackter Text gelesen ist das unschön, mit den Symbolen der Mana-Schrift ist es genau das, was
 * auch auf der Karte steht (siehe src/app/ui/mana-symbol/).
 *
 * Der Text zwischen den Klammern wird bewusst behalten statt weggeworfen: rund jede zehnte Angabe
 * hat einen Zusatz, der die Kosten erst richtig beschreibt ("{2}{G} at most", "{4}{W}{W} plus
 * enough mana to pay for command tax"). Ihn zu schlucken machte aus einer Bedingung eine
 * Behauptung.
 */
export function parseManaCost(cost: string): ManaPart[] {
  // Getrimmt, weil die Kostenzeile die Teile mit eigenem Abstand nebeneinandersetzt - ein
  // führendes Leerzeichen aus "{2}{G} at most" stünde dort doppelt.
  return splitManaSymbols(cost)
    .map((teil) => (teil.kind === 'text' ? { ...teil, value: teil.value.trim() } : teil))
    .filter((teil) => teil.kind === 'symbol' || teil.value.length > 0);
}
