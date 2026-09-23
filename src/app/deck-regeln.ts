import { DeckFormat } from './models';

/**
 * Bauregeln je Format, neben der Bannliste (BanlistService): wie viele Karten ein Deck haben muss
 * und wie oft dieselbe Karte darin liegen darf. Gezählt wird das Hauptdeck, also ohne Maybeboard
 * und Marken; der Commander zählt mit (100 heißt 99 + Commander).
 *
 * Die Zahlen stehen NUR hier. Die SQL-Funktion deck_rule_facts() (sql/deck-regeln-2026-09-23.sql)
 * liefert bloß die Fakten (Kartenzahl, mehrfach vorhandene Karten samt Ausnahme), geurteilt wird
 * im Client - sonst stünden die Grenzen zweimal und liefen auseinander.
 */
export interface FormatRegel {
  min: number;
  /** null = keine Obergrenze. */
  max: number | null;
  /** Höchstzahl gleichnamiger Karten (1 = Singleton). */
  maxKopien: number;
}

export const FORMAT_REGELN: Record<DeckFormat, FormatRegel> = {
  Standard: { min: 60, max: null, maxKopien: 4 },
  Pioneer: { min: 60, max: null, maxKopien: 4 },
  Modern: { min: 60, max: null, maxKopien: 4 },
  Legacy: { min: 60, max: null, maxKopien: 4 },
  Vintage: { min: 60, max: null, maxKopien: 4 },
  Pauper: { min: 60, max: null, maxKopien: 4 },
  Explorer: { min: 60, max: null, maxKopien: 4 },
  Timeless: { min: 60, max: null, maxKopien: 4 },
  Alchemy: { min: 60, max: null, maxKopien: 4 },
  Commander: { min: 100, max: 100, maxKopien: 1 },
  'Pauper Commander': { min: 100, max: 100, maxKopien: 1 },
  Brawl: { min: 60, max: 60, maxKopien: 1 },
  'Historic Brawl': { min: 100, max: 100, maxKopien: 1 },
};

/**
 * Eigene Kopien-Grenze einer Karte, unabhängig vom Format: null = beliebig viele (Standardländer,
 * „A deck can have any number of cards named …" wie Relentless Rats), eine Zahl für „up to seven/
 * nine" (Seven Dwarves, Nazgûl), undefined = es gilt die Grenze des Formats.
 *
 * Dieselbe Erkennung steht in deck_rule_facts() - wer eine ändert, ändert beide.
 */
export function eigeneKopienGrenze(
  typeLine: string | null | undefined,
  oracleText: string | null | undefined,
): number | null | undefined {
  if ((typeLine ?? '').startsWith('Basic')) return null;
  const text = (oracleText ?? '').toLowerCase();
  if (text.includes('a deck can have any number of cards named')) return null;
  if (text.includes('a deck can have up to seven cards named')) return 7;
  if (text.includes('a deck can have up to nine cards named')) return 9;
  return undefined;
}

/** Regel eines Formats; undefined für Decks ohne oder mit unbekanntem Format - die prüft niemand. */
export function regelFuer(format: string | null | undefined): FormatRegel | undefined {
  return format ? FORMAT_REGELN[format as DeckFormat] : undefined;
}

export type KartenzahlFehler = { art: 'min' | 'max' | 'genau'; soll: number; ist: number };

/** Verstoß gegen die Kartenzahl des Formats, oder null. */
export function kartenzahlFehler(format: string | null, anzahl: number): KartenzahlFehler | null {
  const regel = regelFuer(format);
  if (!regel) return null;
  if (regel.max !== null && regel.min === regel.max) {
    return anzahl === regel.min ? null : { art: 'genau', soll: regel.min, ist: anzahl };
  }
  if (anzahl < regel.min) return { art: 'min', soll: regel.min, ist: anzahl };
  if (regel.max !== null && anzahl > regel.max) return { art: 'max', soll: regel.max, ist: anzahl };
  return null;
}

/** Ob eine Karte mit dieser Menge die Kopien-Grenze des Formats überschreitet. */
export function zuVieleKopien(
  format: string | null,
  menge: number,
  grenze: number | null | undefined,
): boolean {
  const regel = regelFuer(format);
  if (!regel || grenze === null) return false;
  return menge > (grenze ?? regel.maxKopien);
}
