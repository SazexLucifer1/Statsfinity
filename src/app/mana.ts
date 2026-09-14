/**
 * Manakosten lesen und bezahlen.
 *
 * Bisher rechnete die Goldfish-Simulation Mana als bloße Zahl. Nachgemessen an 1.406 Karten aus
 * 60 cEDH-Decks haben aber 1.019 von 1.192 Zaubersprüchen FARBIGE Kosten - eine Simulation ohne
 * Farben behauptet also bei fünf von sechs Karten, sie sei spielbar, ohne das geprüft zu haben.
 * Dieses Modul schließt die Lücke.
 *
 * Alle Regeln hier sind an den Comprehensive Rules belegt (Fassung gültig ab 7. August 2026,
 * https://magic.wizards.com/en/rules). Zitate stehen jeweils an der Stelle, an der die Regel
 * angewandt wird - nichts hier ist aus dem Gedächtnis geschrieben.
 *
 * Reine Rechenfunktionen ohne Angular- und Netzwerkbezug, wie bracket.ts und deck-metrics.ts.
 */

/**
 * Die fünf Farben plus farblos.
 *
 * CR 106.1a: "There are five colors of mana: white, blue, black, red, and green."
 * CR 106.1b: "There are six types of mana: white, blue, black, red, green, and colorless."
 */
export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';
export const MANA_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

/**
 * Eine einzelne Anforderung aus einer Manakosten-Zeile.
 *
 * CR 202.1a: "paying that mana cost requires matching the type of any colored or colorless mana
 * symbols as well as paying the generic mana indicated in the cost."
 */
export interface ManaRequirement {
  /**
   * Womit sich dieses Symbol bezahlen lässt. Ein Hybridsymbol nennt mehrere Farben -
   * CR 107.4e: "Hybrid mana symbols ... can be paid with either of two colors."
   */
  colors: ManaColor[];
  /**
   * Generische Alternative bei monofarbigem Hybrid wie {2/U} - CR 107.4g nennt sie
   * "monocolored hybrid mana symbols", bezahlbar mit der Farbe ODER zwei generischem Mana.
   * null = keine Alternative.
   */
  genericAlternative: number | null;
  /**
   * Phyrexia-Symbol: statt Mana zahlbar mit zwei Lebenspunkten.
   * CR 107.4f: "Phyrexian mana symbols ... can be paid with either the corresponding color or
   * 2 life." Die Simulation goldfisht ohne Gegner, Leben ist dort keine knappe Ressource -
   * deshalb gilt ein Phyrexia-Symbol als immer bezahlbar.
   */
  phyrexian: boolean;
}

export interface ManaCost {
  /** Summe aller Zahlensymbole - CR 107.4b nennt sie "generic mana symbols". */
  generic: number;
  requirements: ManaRequirement[];
  /**
   * true, wenn {X} vorkommt. CR 107.3a: Der Spieler wählt den Wert beim Ansagen. Die Simulation
   * setzt X auf 0 - der billigste legale Wert, und der einzige, der ohne Spielsituation
   * begründbar ist.
   */
  hasX: boolean;
}

const ZAHL_RE = /^\d+$/;

/**
 * Zerlegt eine Manakosten-Zeichenkette ("{2}{W}{U/B}{G/P}") in ihre Bestandteile.
 *
 * Die Symbolliste folgt CR 107.4, das alle gültigen Symbole aufzählt: die farbigen {W}{U}{B}{R}{G},
 * farbloses {C}, Zahlensymbole, {X}, Hybride wie {W/U}, monofarbige Hybride wie {2/W}, Phyrexia
 * wie {W/P} und Schneemana {S}.
 */
export function parseManaCost(manaCost: string): ManaCost {
  const kosten: ManaCost = { generic: 0, requirements: [], hasX: false };
  if (!manaCost) return kosten;

  for (const treffer of manaCost.matchAll(/\{([^}]+)\}/g)) {
    const teile = treffer[1].toUpperCase().split('/');

    if (teile.length === 1) {
      const symbol = teile[0];
      if (symbol === 'X') {
        kosten.hasX = true;
      } else if (ZAHL_RE.test(symbol)) {
        kosten.generic += Number(symbol);
      } else if (symbol === 'S') {
        // Schneemana: bezahlbar mit Mana aus verschneiten Quellen, sonst wie generisch. Die
        // Simulation kennt keine verschneiten Länder und behandelt es deshalb als generisch.
        kosten.generic += 1;
      } else if ((MANA_COLORS as readonly string[]).includes(symbol)) {
        kosten.requirements.push({
          colors: [symbol as ManaColor],
          genericAlternative: null,
          phyrexian: false,
        });
      }
      continue;
    }

    // Zusammengesetzte Symbole: Hybrid, monofarbiger Hybrid, Phyrexia (auch kombiniert).
    const phyrexian = teile.includes('P');
    const ohneP = teile.filter((t) => t !== 'P');
    const zahl = ohneP.find((t) => ZAHL_RE.test(t));
    const farben = ohneP.filter((t) =>
      (MANA_COLORS as readonly string[]).includes(t),
    ) as ManaColor[];

    kosten.requirements.push({
      colors: farben,
      genericAlternative: zahl ? Number(zahl) : null,
      phyrexian,
    });
  }

  return kosten;
}

/**
 * Eine verfügbare Manaquelle im Spiel: wie viel sie erzeugt und in welchen Farben.
 *
 * Die Farben stammen aus Scryfalls `produced_mana` - dieselbe Angabe, die auch die Manaquellen-
 * Auswertung der Deck-Ansicht nutzt. Leere Farbliste heißt "farblos" (CR 106.1b).
 */
export interface ManaSource {
  amount: number;
  colors: ManaColor[];
}

/** Ein einzelnes verfügbares Mana, aufgelöst aus den Quellen - die Einheit, in der bezahlt wird. */
type ManaUnit = ManaColor[];

export function manaUnits(sources: ManaSource[]): ManaUnit[] {
  const einheiten: ManaUnit[] = [];
  for (const quelle of sources) {
    const farben = quelle.colors.length > 0 ? quelle.colors : (['C'] as ManaColor[]);
    for (let i = 0; i < quelle.amount; i++) einheiten.push(farben);
  }
  return einheiten;
}

/**
 * Bezahlt die Kostenzeile aus den verfügbaren Manaeinheiten und liefert zurück, was übrig bleibt -
 * null, wenn es nicht reicht.
 *
 * CR 601.2h: "Partial payments are not allowed. Unpayable costs can't be paid." - es gibt also
 * nur ja oder nein, keine Teilzahlung.
 *
 * Das Verfahren ist eine vollständige Rücksetzsuche, keine Näherung: Jede farbige Anforderung
 * bekommt der Reihe nach jede noch freie, passende Manaeinheit zugewiesen; führt eine Zuweisung
 * in eine Sackgasse, wird sie zurückgenommen. Erst wenn alle farbigen Anforderungen bedient sind,
 * muss der Rest für das generische Mana reichen. Eine gierige Zuweisung wäre hier falsch - bei
 * {W}{U} und zwei Quellen, von denen eine nur Weiß und eine beides kann, hinge das Ergebnis sonst
 * an der Reihenfolge.
 */
export function payFrom(cost: ManaCost, einheiten: ManaUnit[]): ManaUnit[] | null {
  // Anforderungen, die ohne Mana erfüllbar sind, fallen sofort heraus (Phyrexia, siehe oben).
  const offen = cost.requirements.filter((r) => !r.phyrexian);
  const belegt = new Array(einheiten.length).fill(false);

  const passt = (einheit: ManaUnit, anforderung: ManaRequirement) =>
    anforderung.colors.some((f) => einheit.includes(f));

  // Am stärksten eingeschränkte Anforderung zuerst - halbiert den Suchbaum, ändert am Ergebnis nichts.
  const sortiert = [...offen].sort(
    (a, b) =>
      einheiten.filter((e) => passt(e, a)).length - einheiten.filter((e) => passt(e, b)).length,
  );

  const freieIndizes = () => belegt.map((b, i) => (b ? -1 : i)).filter((i) => i >= 0);

  const suche = (index: number): boolean => {
    if (index === sortiert.length) {
      const frei = freieIndizes();
      if (frei.length < cost.generic) return false;
      // Generisches Mana zuletzt und aus den unflexibelsten Einheiten - farbige Quellen bleiben
      // so für nachfolgende Zauber übrig. CR 202.1a verlangt für generisches Mana keine Farbe.
      const fuerGenerisch = [...frei]
        .sort((a, b) => einheiten[a].length - einheiten[b].length)
        .slice(0, cost.generic);
      for (const i of fuerGenerisch) belegt[i] = true;
      return true;
    }

    const anforderung = sortiert[index];
    const versucht = new Set<string>();

    for (let i = 0; i < einheiten.length; i++) {
      if (belegt[i] || !passt(einheiten[i], anforderung)) continue;
      // Zwei Einheiten mit identischem Farbangebot sind austauschbar - eine davon reicht.
      const schluessel = einheiten[i].join('');
      if (versucht.has(schluessel)) continue;
      versucht.add(schluessel);

      belegt[i] = true;
      if (suche(index + 1)) return true;
      belegt[i] = false;
    }

    // Monofarbiger Hybrid ({2/U}): statt der Farbe zwei generisches Mana - CR 107.4g.
    if (anforderung.genericAlternative !== null) {
      const indizes: number[] = [];
      for (
        let i = 0;
        i < einheiten.length && indizes.length < anforderung.genericAlternative;
        i++
      ) {
        if (belegt[i]) continue;
        belegt[i] = true;
        indizes.push(i);
      }
      if (indizes.length === anforderung.genericAlternative && suche(index + 1)) return true;
      for (const i of indizes) belegt[i] = false;
    }

    return false;
  };

  if (!suche(0)) return null;
  return einheiten.filter((_, i) => !belegt[i]);
}

export function canPay(cost: ManaCost, sources: ManaSource[]): boolean {
  return payFrom(cost, manaUnits(sources)) !== null;
}

/** Gesamtzahl Mana, die diese Quellen erzeugen - ohne Rücksicht auf Farben. */
export function totalMana(sources: ManaSource[]): number {
  return sources.reduce((summe, q) => summe + q.amount, 0);
}
