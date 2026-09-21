import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ScryfallService } from '../scryfall.service';
import { I18nService } from '../i18n.service';
import { Icon } from '../ui/icon/icon';

/**
 * Such-/Auswahl-UI für eine Lieblingscommander-Liste (max. 3) - rein präsentational, die
 * Persistierung entscheidet der Aufrufer über onAdd/onRemove. Wird sowohl für den eigenen Account
 * (profiles.favorite_commanders, siehe profile-tab.ts) als auch für ein NPC-Profil
 * (players.favorite_commanders, siehe group-tab.ts) verwendet - vorher war dieselbe Such-/Chip-
 * Logik nur im Profil-Tab fest verdrahtet.
 */
@Component({
  selector: 'app-favorite-commander-editor',
  imports: [FormsModule, Icon],
  templateUrl: './favorite-commander-editor.html',
})
export class FavoriteCommanderEditor {
  private readonly scryfall = inject(ScryfallService);
  readonly i18n = inject(I18nService);

  readonly favorites = input<string[]>([]);
  readonly maxCount = input(3);
  readonly busy = input(false);
  readonly onAdd = input<(name: string) => void>(() => {});
  readonly onRemove = input<(name: string) => void>(() => {});

  readonly query = signal('');
  readonly suggestions = signal<string[]>([]);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  onSearchInput(value: string): void {
    this.query.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(async () => {
      this.suggestions.set(await this.scryfall.autocomplete(value));
    }, 250);
  }

  add(name: string): void {
    this.onAdd()(name);
    this.query.set('');
    this.suggestions.set([]);
  }

  remove(name: string): void {
    this.onRemove()(name);
  }
}
