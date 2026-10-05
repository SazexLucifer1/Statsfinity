import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { I18nService } from '../i18n.service';
import { DeckManualRecordService, ManualRecord } from '../deck-manual-record.service';
import { Icon } from '../ui/icon/icon';

/**
 * Nachgetragene Bilanz eines Decks in der Deck-Ansicht: alte Siege/Niederlagen/Unentschieden aus
 * der Zeit vor der App. Getrennt von den erfassten Partien ausgewiesen, dazu die Summe beider.
 * Für Fremde nur sichtbar, wenn es eine gibt; der Besitzer kann sie eintragen.
 */
@Component({
  selector: 'app-deck-manual-record',
  imports: [Icon],
  templateUrl: './deck-manual-record.html',
  styleUrl: './deck-manual-record.scss',
})
export class DeckManualRecord {
  readonly i18n = inject(I18nService);
  readonly service = inject(DeckManualRecordService);

  readonly deckId = input.required<string>();
  readonly canEdit = input(false);
  /** Erfasste Partien und Siege des Decks (aus der Deck-Ansicht), für die Gesamtbilanz. */
  readonly trackedGames = input(0);
  readonly trackedWins = input(0);

  readonly fields: readonly (keyof ManualRecord)[] = ['wins', 'losses', 'draws'];
  readonly record = signal<ManualRecord | null>(null);
  readonly editing = signal(false);
  readonly draft = signal<ManualRecord>({ wins: 0, losses: 0, draws: 0 });
  readonly saving = signal(false);

  readonly total = computed(() => {
    const r = this.record();
    if (!r) return null;
    const games = this.trackedGames() + r.wins + r.losses + r.draws;
    const wins = this.trackedWins() + r.wins;
    return { games, wins, winRate: games ? Math.round((wins / games) * 100) : 0 };
  });

  constructor() {
    effect(() => {
      const id = this.deckId();
      this.record.set(null);
      this.editing.set(false);
      this.service.load(id).then((r) => {
        if (this.deckId() === id) this.record.set(r);
      });
    });
  }

  startEdit(): void {
    this.draft.set(this.record() ?? { wins: 0, losses: 0, draws: 0 });
    this.editing.set(true);
  }

  setDraft(field: keyof ManualRecord, value: string): void {
    const n = Math.max(0, Math.min(9999, Number.parseInt(value, 10) || 0));
    this.draft.update((d) => ({ ...d, [field]: n }));
  }

  async save(): Promise<void> {
    this.saving.set(true);
    const draft = this.draft();
    const ok = await this.service.save(this.deckId(), draft);
    this.saving.set(false);
    if (!ok) return;
    this.record.set(draft.wins + draft.losses + draft.draws > 0 ? draft : null);
    this.editing.set(false);
  }
}
