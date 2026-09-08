import { Component, computed, input } from '@angular/core';

/**
 * Ein einzelnes Manasymbol aus der Mana-Schriftart: eine Farbe (W/U/B/R/G), ein generischer
 * Manabetrag ('0' bis '20'), ein Hybrid ('U/R', '2/B'), 'X', 'E' (Energie), 'S' (Schnee),
 * 'T' (Tappen) oder farblos ('C').
 *
 * Ersetzt die farbigen Punkte, die vorher an vier Stellen einzeln nachgebaut waren (Farbfilter im
 * Commander-Vorschlag und im öffentlichen Deck-Browser, Farbkombinationen im Profil, Balken-
 * beschriftungen): ein Kreis in Rot bedeutet nur für den etwas, der die Legende kennt, das echte
 * Symbol ist für jeden Magic-Spieler eindeutig - auch für den, der Rot und Grün nicht
 * unterscheiden kann.
 *
 * Die Schrift kommt aus dem Paket mana-font (Andrew Gioia, MIT); die Einbindung steht in
 * src/styles/_mana.scss.
 */
@Component({
  selector: 'app-mana-symbol',
  template: `<i
    [class]="symbolClass()"
    [attr.role]="label() ? 'img' : null"
    [attr.aria-label]="label()"
    [attr.aria-hidden]="label() ? null : 'true'"
  ></i>`,
  styleUrl: './mana-symbol.scss',
})
export class ManaSymbol {
  /**
   * Farbbuchstabe (W/U/B/R/G), Zahl als Text ('0'-'20'), 'X', ein Hybrid mit Schrägstrich
   * ('U/R', '2/B') oder alles andere für farblos.
   */
  readonly symbol = input.required<string>();

  /**
   * Gesetzt = das Symbol wird Screenreadern selbst angesagt, weil es allein steht (z.B. als
   * Beschriftung eines Balkens). Leer = dekorativ, weil der Name als Text daneben steht - sonst
   * hörte man jede Farbe doppelt.
   */
  readonly label = input<string | null>(null);

  /**
   * .ms-cost legt den runden Symbolgrund in der jeweiligen Manafarbe darunter, .ms-shadow den
   * dünnen dunklen Rand, den die Symbole auch auf den Karten haben - ohne den verschwimmt das
   * fast weiße W-Symbol auf hellen Hintergrundbildern.
   */
  readonly symbolClass = computed(() => `ms ms-${manaToken(this.symbol())} ms-cost ms-shadow`);
}

/** Klassenkürzel der Mana-Schriftart. Alles Unbekannte wird farblos, nie eine leere Klasse. */
function manaToken(symbol: string): string {
  const raw = symbol.trim().toUpperCase();
  if (raw.length === 1 && 'WUBRG'.includes(raw)) return raw.toLowerCase();
  if (/^\d{1,2}$/.test(raw)) return raw;
  if (raw === 'X') return 'x';
  // {E} Energie und {S} Schnee tauchen in Combo-Ablaeufen auf, {T} ist das Tap-Symbol - und heisst
  // in der Schrift ms-tap, nicht ms-t.
  if (raw === 'E') return 'e';
  if (raw === 'S') return 's';
  if (raw === 'T') return 'tap';
  // Hybrid schreibt die Schrift ohne Schrägstrich: {U/R} ist ms-ur, {2/B} ist ms-2b. Ohne diesen
  // Fall landeten die Zwitter beim farblosen Rückfall - und ein graues Symbol behauptet dort
  // schlicht etwas Falsches über die Kosten.
  if (/^[WUBRG0-9]+\/[WUBRGP]$/.test(raw)) return raw.replace('/', '').toLowerCase();
  return 'c';
}
