import { Component, effect, inject, signal } from '@angular/core';
import { CardPreviewService } from '../card-preview.service';
import { CardImage } from '../card-image/card-image';
import { AuthService } from '../auth.service';
import { CardDataService } from '../card-data.service';
import { CommanderIdeasService } from '../commander-ideas.service';
import { canBeCommander } from '../deck.service';
import { I18nService } from '../i18n.service';
import { Icon } from '../ui/icon/icon';

@Component({
  selector: 'app-card-preview-dialog',
  imports: [CardImage, Icon],
  templateUrl: './card-preview-dialog.html',
  styleUrl: './card-preview-dialog.scss',
})
export class CardPreviewDialog {
  readonly preview = inject(CardPreviewService);
  readonly ideas = inject(CommanderIdeasService);
  readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthService);
  private readonly cardData = inject(CardDataService);

  /**
   * Englischer Name der Karte, wenn sie Commander sein darf - dann gibt es unter der Vorschau
   * "Als Commander-Idee merken" (commander-ideas.service.ts). Jede Vorschau bekommt den Kartennamen
   * als alt, damit wirkt der Knopf in jeder Kartensuche und Liste.
   */
  readonly commanderName = signal<string | null>(null);

  constructor() {
    effect(() => {
      const open = !!this.preview.imageUrl();
      const name = this.preview.alt().trim();
      this.commanderName.set(null);
      if (!open || !name || !this.auth.currentUser() || !this.ideas.available()) return;
      void this.ideas.ensureLoaded();
      void this.cardData.findCard(name).then((card) => {
        if (this.preview.alt().trim() === name && canBeCommander(card)) {
          this.commanderName.set(card!.name);
        }
      });
    });
  }

  saved(name: string): boolean {
    return this.ideas.savedNames().has(name.toLowerCase());
  }

  async remember(event: Event, name: string): Promise<void> {
    event.stopPropagation();
    await this.ideas.add(name);
  }
}
