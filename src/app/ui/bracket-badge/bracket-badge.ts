import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../i18n.service';

/**
 * Abzeichen für die Commander-Bracket-Stufe eines Decks, z.B. „B3 · Upgraded".
 *
 * Steht an drei Stellen: prominent in der Deck-Detailansicht, klein an der Deck-Kachel und in der
 * Deck-Auswahl des Match-Tabs. Genau deshalb liegt es hier und nicht in einer der drei Ansichten -
 * ein Bracket soll überall gleich aussehen, sonst liest man dieselbe Zahl dreimal anders.
 *
 * Geschätzt gegen selbst festgelegt wird sichtbar unterschieden (gestrichelter gegen durchgezogener
 * Rand), nicht nur im Titel: In der Deck-Liste ist der Titel auf dem iPhone gar nicht erreichbar,
 * es gibt dort kein Hovern.
 */
@Component({
  selector: 'app-bracket-badge',
  templateUrl: './bracket-badge.html',
  styleUrl: './bracket-badge.scss',
})
export class BracketBadge {
  readonly i18n = inject(I18nService);

  /** Stufe 1-5, oder null - dann zeigt der Baustein gar nichts. */
  readonly bracket = input<number | null>(null);
  /** Woher der Wert stammt. 'manual' = vom Nutzer gesetzt, 'auto' = berechnet. */
  readonly source = input<'manual' | 'auto'>('auto');
  /** Nur die Stufe ohne Namen - für Deck-Kacheln und Listen, wo der Platz knapp ist. */
  readonly compact = input(false);

  readonly name = computed(() => this.i18n.t(`deck.bracket.name${this.bracket()}`));

  readonly title = computed(() =>
    this.i18n.t(
      this.source() === 'manual' ? 'deck.bracket.badgeManual' : 'deck.bracket.badgeAuto',
      {
        level: String(this.bracket() ?? ''),
        name: this.name(),
      },
    ),
  );
}
