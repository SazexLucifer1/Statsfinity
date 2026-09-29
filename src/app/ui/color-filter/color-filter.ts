import { Component, computed, inject, input, model } from '@angular/core';
import { I18nService } from '../../i18n.service';
import { ManaSymbol } from '../mana-symbol/mana-symbol';
import {
  COLORLESS,
  ColorMatchMode,
  ColorSelection,
  FILTER_COLORS,
  colorModeApplies,
  toggleColorSelection,
} from '../../color-filter-match';

/**
 * Farbfilter als Reihe echter Manasymbole - ersetzt sowohl die Auswahllisten mit ausgeschriebenen
 * Farbnamen (Kartensuche, Deckbau, Deck- und Precon-Kartenliste) als auch die Chip-Reihen mit
 * Farbnamen (Commander-Suche, Deck-Suche).
 *
 * Ein natives <option> kann keine Symbole tragen (der Browser zeichnet die Auswahlliste selbst und
 * nimmt nur reinen Text) und konnte immer nur eine Farbe - beides der Grund für Knöpfe.
 *
 * Mehrfachauswahl, weil man sonst nicht nach einer Farbkombination filtern kann: erst zwei
 * angeklickte Farben ergeben "mehrfarbig, und zwar diese". Was die Auswahl bedeutet - und was der
 * Umschalter genau/enthält daran ändert - steht in color-filter-match.ts.
 *
 * .segmented statt einzelner .glass-chips, obwohl mehrere Segmente gleichzeitig aktiv sein können:
 * die sechs Symbole gehören sichtbar zusammen und tragen im Block ihre Überschrift ("Farbe: alle")
 * gleich mit - einzeln stünden sechs Farbtupfer ohne Beschriftung in der Filterzeile.
 */
@Component({
  selector: 'app-color-filter',
  imports: [ManaSymbol],
  host: { class: 'segmented mana-filter' },
  templateUrl: './color-filter.html',
  styleUrl: './color-filter.scss',
})
export class ColorFilter {
  readonly i18n = inject(I18nService);

  readonly value = model.required<ColorSelection>();

  /**
   * "Farblos" als eigene Auswahl anbieten. Aus für die Deck- und Commander-Suche: dort filtert die
   * Auswahl eine Farbidentität, und "keine Farbe" ist dort kein Suchziel, sondern das leere Feld.
   */
  readonly withColorless = input(true);

  /** Umschalter genau/enthält anbieten. Aus für die Deck-Suche: dort ist die Farbidentität selbst das Ziel. */
  readonly withMode = input(true);

  readonly options = computed<string[]>(() =>
    this.withColorless() ? [...FILTER_COLORS, COLORLESS] : [...FILTER_COLORS],
  );

  /** Der Umschalter erscheint erst mit einer Farbauswahl - vorher gäbe es nichts umzuschalten. */
  readonly showMode = computed(() => this.withMode() && colorModeApplies(this.value()));

  isActive(color: string): boolean {
    return this.value().colors.includes(color);
  }

  toggle(color: string): void {
    this.value.set(toggleColorSelection(this.value(), color));
  }

  reset(): void {
    this.value.set({ colors: [], mode: this.value().mode });
  }

  setMode(mode: ColorMatchMode): void {
    this.value.set({ ...this.value(), mode });
  }

  isMode(mode: ColorMatchMode): boolean {
    return this.value().mode === mode;
  }

  label(color: string): string {
    return color === COLORLESS ? this.i18n.t('deckView.colorless') : this.i18n.t(`pip.${color}`);
  }
}
