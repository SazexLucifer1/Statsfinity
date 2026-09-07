import { Component, computed, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CardImage } from '../card-image/card-image';
import { CardPreviewService } from '../card-preview.service';
import { I18nService } from '../i18n.service';
import { BorrowedDeckInfo, CommanderGameStats } from '../deck.service';
import { Meter } from '../ui/meter/meter';
import { Pager } from '../ui/pager/pager';

export type CommanderStatSortMode = 'alpha' | 'winRate' | 'games';

const PAGE_SIZE = 10;

/**
 * Suchbare, sortierbare, paginierte Commander-Rangliste (Name, Bild, Siege/Spiele/Winrate) - im
 * Profil-Tab zweimal gebraucht (eigenes Profil + ein gerade angesehenes fremdes Profil), vorher
 * mit komplett dupliziertem Signal/Computed-Code je einmal pro Variante. Bild-Lookup bleibt
 * bewusst Sache des Aufrufers (commanderImage/commanderBackImage als Inputs) statt hier selbst
 * Scryfall zu laden, damit ProfileTab die Bilder für beide Listen weiterhin in einem gemeinsamen
 * Cache/Request bündeln kann.
 */
@Component({
  selector: 'app-commander-stat-list',
  imports: [FormsModule, DecimalPipe, CardImage, Meter, Pager],
  templateUrl: './commander-stat-list.html',
  styleUrl: './commander-stat-list.scss',
})
export class CommanderStatList {
  readonly cardPreview = inject(CardPreviewService);
  readonly i18n = inject(I18nService);

  readonly stats = input<CommanderGameStats[]>([]);
  readonly searchPlaceholderKey = input('profile.searchCommanderPlaceholder');
  readonly emptyLabelKey = input('profile.noCommanderFound');
  readonly commanderImage = input<(name: string) => string | null>(() => null);
  readonly commanderBackImage = input<(name: string) => string | null>(() => null);

  /**
   * Klick auf das geliehene Deck eines Eintrags. Nur Einträge mit borrowedDeck zeigen den Knopf
   * überhaupt an, deshalb braucht es keinen zusätzlichen Schalter am Aufrufer.
   */
  readonly borrowedDeckClick = output<BorrowedDeckInfo>();

  readonly searchQuery = signal('');
  readonly sortMode = signal<CommanderStatSortMode>('alpha');
  readonly page = signal(0);

  readonly filteredSorted = computed<CommanderGameStats[]>(() => {
    const query = this.searchQuery().trim().toLowerCase();
    let list = this.stats();
    if (query) {
      list = list.filter((c) => c.commander.toLowerCase().includes(query));
    }

    const mode = this.sortMode();
    list = [...list];
    if (mode === 'alpha') {
      list.sort((a, b) => a.commander.localeCompare(b.commander));
    } else if (mode === 'winRate') {
      list.sort((a, b) => b.winRate - a.winRate || b.games - a.games);
    } else {
      list.sort((a, b) => b.games - a.games || b.winRate - a.winRate);
    }
    return list;
  });

  readonly paged = computed<CommanderGameStats[]>(() => {
    // Auf die letzte vorhandene Seite begrenzen: app-pager zeigt zwar nie eine Seite hinter dem
    // Ende an, die Liste kann aber durch Suche oder gefilterte Daten schrumpfen, während page()
    // noch auf einer hohen Zahl steht - ohne die Klammer wäre die Liste dann leer.
    const list = this.filteredSorted();
    const lastPage = Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1);
    const start = Math.min(this.page(), lastPage) * PAGE_SIZE;
    return list.slice(start, start + PAGE_SIZE);
  });


  setSearchQuery(value: string): void {
    this.searchQuery.set(value);
    this.page.set(0);
  }

  setSortMode(mode: CommanderStatSortMode): void {
    this.sortMode.set(mode);
    this.page.set(0);
  }



  /** Setzt Suche/Sortierung/Seite zurück - für den Aufrufer, wenn `stats` auf eine andere Liste
   * wechselt (z.B. Wechsel des angesehenen Profils), damit z.B. nicht die Suche vom vorherigen
   * Profil hängen bleibt. */
  reset(): void {
    this.searchQuery.set('');
    this.sortMode.set('alpha');
    this.page.set(0);
  }
}
