import { Component, inject, model } from '@angular/core';
import { I18nService } from '../../i18n.service';
import { RARITIES } from '../../collection-filter';

/**
 * Seltenheit als Chip-Reihe mit Mehrfachauswahl (keine Auswahl = alle) - in jeder Kartensuche
 * (Suche-Tab, Deck-Editor, Cube „Hinzufügen") und in der Sammlung, Wunsch des Users 22.10.2026.
 * Bei Scryfall wird daraus `(r:common or r:rare)` (ScryfallService.searchParts()); dort zählt eine
 * Karte, wenn es sie in dieser Seltenheit gibt, in der Sammlung zählt der eigene Druck.
 */
@Component({
  selector: 'app-rarity-filter',
  host: {
    class: 'chip-row',
    role: 'group',
    '[attr.aria-label]': "i18n.t('collection.rarityLabel')",
  },
  templateUrl: './rarity-filter.html',
  styleUrl: './rarity-filter.scss',
})
export class RarityFilter {
  readonly i18n = inject(I18nService);

  readonly value = model.required<ReadonlySet<string>>();

  readonly rarities = RARITIES;

  toggle(code: string): void {
    const next = new Set(this.value());
    if (next.has(code)) next.delete(code);
    else next.add(code);
    this.value.set(next);
  }
}
