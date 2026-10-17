import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { I18nService } from '../i18n.service';
import { CollectionService } from '../collection.service';
import { CollectionEntry } from '../collection-coverage';
import { Icon } from '../ui/icon/icon';

/**
 * Sammlung im Profil: nur noch eine Übersicht mit "Sammlung öffnen" - die Sammlung selbst ist eine
 * eigene Seite (collection-view/, Wunsch des Users, 18.10.2026). Eigene oder die eines Freundes
 * (nur lesen - RLS liefert sie nur Freunden, sql/sammlung-2026-10-17.sql; bei allen anderen bleibt
 * die Liste leer und die Karte verschwindet).
 */
@Component({
  selector: 'app-collection-panel',
  imports: [Icon],
  templateUrl: './collection-panel.html',
  styleUrl: './collection-panel.scss',
})
export class CollectionPanel {
  readonly i18n = inject(I18nService);
  readonly collection = inject(CollectionService);

  /** null = eigene Sammlung. */
  readonly userId = input<string | null>(null);
  /** Anzeigename beim Freund - für die Überschrift der geöffneten Ansicht. */
  readonly name = input<string | null>(null);

  private readonly friendEntries = signal<CollectionEntry[] | null>(null);
  readonly entries = computed(
    () => (this.userId() ? this.friendEntries() : this.collection.entries()) ?? [],
  );
  readonly editable = computed(() => !this.userId());
  readonly totalCards = computed(() => this.entries().reduce((sum, e) => sum + e.quantity, 0));
  readonly distinctCards = computed(() => new Set(this.entries().map((e) => e.cardName)).size);
  readonly languageCount = computed(() => new Set(this.entries().map((e) => e.lang)).size);

  constructor() {
    effect(() => {
      const uid = this.userId();
      if (!uid) {
        void this.collection.ensureLoaded();
        return;
      }
      this.friendEntries.set(null);
      void this.collection.loadFor(uid).then((rows) => {
        if (this.userId() === uid) this.friendEntries.set(rows);
      });
    });
  }

  open(): void {
    this.collection.openView(this.userId(), this.name());
  }
}
