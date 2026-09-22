// NEU
import { Component, effect, inject, signal } from '@angular/core';
import { PublicCardSearch } from '../public-card-search/public-card-search';
import { CommanderRecommendations } from '../commander-recommendations/commander-recommendations';
import { PreconBrowser } from '../precon-browser/precon-browser';
import { PublicDeckBrowser } from '../public-deck-browser/public-deck-browser';
import { I18nService } from '../i18n.service';
import { NavigationService } from '../navigation.service';

/**
 * "Suche"-Tab zwischen Match und Stats - ohne Account nutzbar (Fan-Content-Policy). Umschalter
 * zwischen Kartensuche (mit Filtern), Commander-Empfehlungen (EDHREC), Precon-Browser (MTGJSON) und
 * öffentlichem Deck-Browser (andere Nutzer, nicht-private Decks - siehe public-deck.service.ts und
 * sql/public-deck-browse-2026-08-26.sql).
 */
@Component({
  selector: 'app-search-tab',
  imports: [PublicCardSearch, CommanderRecommendations, PreconBrowser, PublicDeckBrowser],
  templateUrl: './search-tab.html',
  styleUrl: './search-tab.scss',
})
export class SearchTab {
  readonly i18n = inject(I18nService);
  private readonly navigation = inject(NavigationService);
  readonly subView = signal<'cards' | 'commander' | 'precons' | 'decks'>('cards');

  constructor() {
    // Ein aufgerufener Deck-Link (QR-Code eines Steckbriefs) landet in diesem Tab - aber der
    // Deck-Browser, der ihn auswertet, hängt am Unter-Reiter "Decks". Ohne diesen Sprung stünde
    // man auf der Kartensuche und das gescannte Deck öffnete sich nie.
    effect(() => {
      if (this.navigation.pendingPublicDeckId()) this.subView.set('decks');
    });
  }
}
