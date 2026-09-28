import type { BracketLevel } from './bracket';

/**
 * Einstufung eines Decks aus der Forge-Simulation (echte 4er-Pods, Bot gegen Bot).
 *
 * Das Deck spielt je Stufe 100 Partien gegen drei Test-Decks dieser Stufe (sim/testdecks, Stufen 2 bis 5).
 * Hier wird aus den Winrates eine Stufe. Reine Rechenfunktion wie bracket.ts - kein Netz, kein Angular -,
 * damit sie im Browser und im Simulations-Skript dieselbe ist und sich in forge-einstufung.spec.ts
 * festnageln lässt.
 *
 * DIE REGEL: Im 4er-Pod ist der faire Anteil 25 %. Ein Deck "hält mit" in einer Stufe, wenn es gegen
 * deren Test-Decks mindestens SCHWELLE gewinnt. Die Stufe ist die höchste, in der es mithält.
 *
 * Warum 20 % und nicht 25 %: Auch ein Deck, das exakt so stark ist wie die Test-Decks, liegt in
 * 100 Partien mal bei 20, mal bei 30 % - Zufall. Mit 25 % als Grenze fiele ein genau passendes Deck
 * in der Hälfte der Läufe eine Stufe zu tief. 20 % heißt "nicht klar unterlegen".
 *
 * Nicht zusammenhängend "halten" (mithalten gegen 3, nicht gegen 2) kommt vor, wenn ein Deck gegen
 * einen bestimmten Stil schlecht aussieht. Es zählt trotzdem die höchste Stufe: Wer Bracket-3-Decks
 * schlägt, gehört nicht an einen Bracket-2-Tisch.
 *
 * BRACKET 1 HAT KEINE TEST-DECKS (Entscheidung des Users, 28.09.2026): Bracket-1-Decks sind Themen-Decks,
 * die gar nicht auf Sieg gebaut sind - daran lässt sich nichts messen. Bracket 1 ist deshalb, was schon
 * gegen die B2-Test-Decks nicht mithält. Das ist genau der Fall "hält nirgends mit" unten.
 *
 * Die Kartenregeln (Game Changer, Tutoren, Combos - bracket.ts) setzen eine UNTERGRENZE: Ein Deck
 * mit vier Game Changern ist Bracket 4, auch wenn der Bot es schlecht spielt. Umgekehrt hebt die
 * Simulation ein regelkonformes Deck an, wenn es spielt wie eine höhere Stufe - genau die Lücke, die
 * das Zählen von Karten nicht schließt. Die Untergrenze zählt aber erst ab REGEL_MINIMUM_AB: Die
 * Automatik in bracket.ts vergibt nie weniger als 2 (AUTO_BRACKET_MIN) - eine 2 heißt dort nur "nichts
 * Verbotenes gefunden". Als Untergrenze genommen, käme kein Deck je auf Bracket 1.
 */

export const FAIRER_ANTEIL = 0.25;
export const SCHWELLE = 0.2;
/** Ab dieser Stufe ist das Urteil der Kartenregeln eine echte Untergrenze (siehe oben). */
export const REGEL_MINIMUM_AB = 3;

/** Ergebnis gegen die Test-Decks EINER Stufe. Remis zählen als Partie ohne Sieg. */
export interface StufenErgebnis {
  stufe: BracketLevel;
  spiele: number;
  siege: number;
  remis: number;
}

export interface StufenAuswertung extends StufenErgebnis {
  winrate: number;
  /** 95-%-Wilson-Intervall der Winrate - wie weit die echte Rate plausibel danebenliegen kann. */
  unten: number;
  oben: number;
  haeltMit: boolean;
}

export interface ForgeEinstufung {
  /** Endgültige Stufe: Simulation, mindestens aber die Kartenregeln. */
  stufe: BracketLevel;
  /** Stufe allein aus der Simulation. */
  simStufe: BracketLevel;
  /** Untergrenze aus den Kartenregeln, null wenn nicht übergeben. */
  regelMinimum: BracketLevel | null;
  /**
   * sicher - die Winrate an der Grenze liegt klar auf ihrer Seite (Intervall schneidet SCHWELLE nicht)
   * knapp  - ein zweiter Lauf könnte eine Stufe daneben landen
   */
  sicherheit: 'sicher' | 'knapp';
  stufen: StufenAuswertung[];
}

/** Wilson-Intervall (z = 1,96): hält auch bei 0 oder 100 % Siegen, anders als die Normalnäherung. */
export function wilson(siege: number, spiele: number, z = 1.96): { unten: number; oben: number } {
  if (spiele === 0) return { unten: 0, oben: 1 };
  const p = siege / spiele;
  const n = spiele;
  const mitte = p + (z * z) / (2 * n);
  const breite = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const nenner = 1 + (z * z) / n;
  return {
    unten: Math.max(0, (mitte - breite) / nenner),
    oben: Math.min(1, (mitte + breite) / nenner),
  };
}

export function einstufen(
  ergebnisse: readonly StufenErgebnis[],
  regelMinimum: BracketLevel | null = null,
  schwelle = SCHWELLE,
): ForgeEinstufung {
  const stufen: StufenAuswertung[] = [...ergebnisse]
    .filter((e) => e.spiele > 0)
    .sort((a, b) => a.stufe - b.stufe)
    .map((e) => {
      const winrate = e.siege / e.spiele;
      return { ...e, winrate, ...wilson(e.siege, e.spiele), haeltMit: winrate >= schwelle };
    });

  // Hält es nirgends mit - auch nicht gegen B2 -, ist es Bracket 1.
  const haelt = stufen.filter((s) => s.haeltMit);
  const simStufe: BracketLevel = haelt.length ? haelt[haelt.length - 1].stufe : 1;

  // Sicher ist die Stufe, wenn sie an beiden Rändern klar ist: in der eigenen Stufe klar über der
  // Schwelle (oder es ist Stufe 1) und in der nächsthöheren klar darunter (oder es gibt keine).
  const hier = stufen.find((s) => s.stufe === simStufe);
  const darueber = stufen.find((s) => s.stufe === simStufe + 1);
  const untenKlar = simStufe === 1 || (hier != null && hier.unten >= schwelle);
  const obenKlar = darueber == null || darueber.oben < schwelle;

  const untergrenze =
    regelMinimum != null && regelMinimum >= REGEL_MINIMUM_AB ? regelMinimum : null;
  const stufe = (
    untergrenze != null && untergrenze > simStufe ? untergrenze : simStufe
  ) as BracketLevel;
  return {
    stufe,
    simStufe,
    regelMinimum,
    sicherheit: untenKlar && obenKlar ? 'sicher' : 'knapp',
    stufen,
  };
}
