import { Component, computed, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ManaSymbol } from '../mana-symbol/mana-symbol';
import { Icon } from '../icon/icon';

/** Anzahl Plätze auf dem Siegertreppchen. */
export const PODIUM_SIZE = 3;

/**
 * Ein Platz auf dem Siegertreppchen. Bewusst nur fertiger Anzeigetext statt der Rohdaten: die vier
 * Ranglisten, die das Treppchen benutzen (Spieler, Decks & Commander, Decks/Commander weltweit),
 * haben je eigene Datentypen mit unterschiedlichen Feldern - ein gemeinsames Interface über die
 * Rohdaten hätte entweder alle Felder optional oder einen Generic mit Mapper-Funktionen gebraucht.
 * So bleibt der Baustein rein visuell.
 */
export interface PodiumEntry {
  /** Stabiler Schlüssel für @for track. */
  key: string;
  /** Spieler-, Deck- oder Commander-Name. */
  name: string;
  /** Kleingedruckte Zeile darunter, z.B. "6 / 11 Siege". */
  detail: string;
  /** Die große Zahl, z.B. "55%". */
  value: string;
  /** Kartenbild bzw. Avatar-URL - fehlt sie, kommt ein Platzhalter. Bei shape 'symbols' ungenutzt. */
  imageUrl?: string | null;
  /** Nur bei shape 'symbols': die Manasymbole der Farbkombination ('C' für farblos). */
  symbols?: readonly string[];
}

/**
 * Die Platznummer über jedem Treppchen-Platz. Waren früher Medaillen-Emojis - die zeichnet jedes
 * Betriebssystem anders und in einer Oberfläche ohne sonstige Emojis stachen sie heraus, ohne mehr
 * zu sagen als die Zahl.
 */
const MEDALS = ['1', '2', '3'];

/**
 * Siegertreppchen für die ersten drei Plätze einer Rangliste - Zweiter links, Erster erhöht in der
 * Mitte, Dritter rechts. Gedacht als Kopf über der normalen Ranglisten-Liste, die dann ab Platz 4
 * weiterläuft (siehe splitPodium() in rank-sort.ts).
 *
 * Bewusst ohne app-card-image/app-player-avatar: die beiden liegen außerhalb von ui/ (kein anderer
 * Baustein hier greift auf App-Komponenten zu), und das Treppchen braucht weder den Umdreh-Knopf
 * für Doppelkarten noch die Avatar-Größenvarianten - die volle Liste darunter zeigt beides ohnehin.
 */
@Component({
  selector: 'app-podium',
  imports: [NgTemplateOutlet, ManaSymbol, Icon],
  templateUrl: './podium.html',
  styleUrl: './podium.scss',
})
export class Podium {
  /** Die ersten drei Einträge der Rangliste, in Platzierungsreihenfolge. Weniger als drei ist ok. */
  readonly entries = input<readonly PodiumEntry[]>([]);
  /**
   * 'card' = Kartenbild im MTG-Format, 'avatar' = runder Spieler-Avatar, 'symbols' = die
   * Manasymbole einer Farbkombination (Profil-Tab, wo es gar kein Bild gibt).
   */
  readonly shape = input<'card' | 'avatar' | 'symbols'>('card');

  /**
   * false = die Plätze sind nur Anzeige, kein Knopf. Für Ranglisten ohne sinnvolle Klickaktion
   * (Farbkombinationen): ein Button, der nichts tut, wäre für Tastatur und Screenreader eine
   * Falle, und der Zeigefinger-Cursor verspricht etwas, das nicht passiert.
   */
  readonly interactive = input(true);

  /** Klick auf einen Platz - der Aufrufer entscheidet, was passiert (Kartenvorschau, Profil, …). */
  readonly entrySelect = output<PodiumEntry>();

  /**
   * Anzeigereihenfolge: bei vollem Treppchen 2-1-3, sonst schlicht der Reihe nach. Mit nur zwei
   * Einträgen sähe 2-1 aus wie eine falsch sortierte Liste; die klassische Anordnung lohnt sich
   * erst, wenn es die erhöhte Mitte auch wirklich gibt.
   */
  readonly places = computed(() => {
    const top = this.entries().slice(0, PODIUM_SIZE);
    const order = top.length === PODIUM_SIZE ? [1, 0, 2] : top.map((_, i) => i);
    return order.map((i) => ({ place: i + 1, medal: MEDALS[i], entry: top[i] }));
  });
}
