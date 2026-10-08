import { Component, computed, inject, model, signal } from '@angular/core';
import { I18nService } from '../../i18n.service';
import { PrintSearch as PrintSearchValue, printSearchActive } from '../../scryfall.service';

type Feld = keyof PrintSearchValue;

/**
 * Suche nach Künstler, Artwork, Flavortext und Lore - in der Kartensuche und im Deck-Editor
 * dieselben vier Felder. Zugeklappt eine Zeile, damit die ohnehin lange Filterleiste auf dem
 * Handy nicht um vier Eingabefelder wächst; ist eines ausgefüllt, bleibt sie offen.
 */
@Component({
  selector: 'app-print-search',
  templateUrl: './print-search.html',
  styleUrl: './print-search.scss',
})
export class PrintSearch {
  readonly i18n = inject(I18nService);

  readonly value = model.required<PrintSearchValue>();

  private readonly aufgeklappt = signal(false);
  readonly aktiv = computed(() => printSearchActive(this.value()));
  readonly offen = computed(() => this.aufgeklappt() || this.aktiv());

  readonly felder: readonly { key: Feld; placeholder: string }[] = [
    { key: 'artist', placeholder: 'publicSearch.artistPlaceholder' },
    { key: 'artTag', placeholder: 'publicSearch.artTagPlaceholder' },
    { key: 'flavor', placeholder: 'publicSearch.flavorPlaceholder' },
    { key: 'lore', placeholder: 'publicSearch.lorePlaceholder' },
  ];

  toggle(): void {
    this.aufgeklappt.set(!this.offen());
  }

  set(key: Feld, text: string): void {
    this.value.set({ ...this.value(), [key]: text });
  }
}
