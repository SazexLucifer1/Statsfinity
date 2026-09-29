import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { I18nService } from '../i18n.service';
import { BenchmarkStand, BracketBenchmarkService } from '../bracket-benchmark.service';
import {
  ARCHIDEKT_AUC,
  auswerten,
  BenchmarkErgebnis,
  MERKMALE,
  MIN_DECKS_JE_STUFE,
} from '../bracket-benchmark';

/**
 * Developer-Liste im Profil: Wie gut trennen einzelne Merkmale die Bracket-Stufen an den eigenen
 * Decks (selbst gesetztes Bracket), verglichen mit dem Archidekt-Benchmark
 * (docs/bracket-benchmark-archidekt-2026-09.md)? Live gerechnet beim Öffnen, dazu gespeicherte
 * Stände, um die Entwicklung mit wachsender Deckzahl zu sehen.
 *
 * Nur im Developer-Bereich des Profils eingehängt; die Datenbankfunktion prüft das zusätzlich.
 */
@Component({
  selector: 'app-bracket-benchmark-panel',
  imports: [DatePipe, DecimalPipe],
  templateUrl: './bracket-benchmark-panel.html',
  styleUrl: './bracket-benchmark-panel.scss',
})
export class BracketBenchmarkPanel implements OnInit {
  readonly i18n = inject(I18nService);
  readonly service = inject(BracketBenchmarkService);

  readonly merkmale = MERKMALE;
  readonly stufen = [1, 2, 3, 4, 5] as const;
  readonly archidekt = ARCHIDEKT_AUC;
  readonly minDecks = MIN_DECKS_JE_STUFE;

  readonly ergebnis = signal<BenchmarkErgebnis | null>(null);
  readonly staende = signal<BenchmarkStand[]>([]);
  readonly laedt = signal(false);
  readonly speichert = signal(false);
  readonly fehler = signal<string | null>(null);

  readonly gesamt = computed(() => {
    const e = this.ergebnis();
    return e ? Object.values(e.anzahl).reduce((a, b) => a + b, 0) : 0;
  });

  ngOnInit(): void {
    void this.laden();
  }

  async laden(): Promise<void> {
    this.laedt.set(true);
    this.fehler.set(null);
    try {
      const [decks, staende] = await Promise.all([this.service.decks(), this.service.staende()]);
      this.ergebnis.set(auswerten(decks));
      this.staende.set(staende);
    } catch (e) {
      console.error('Bracket-Benchmark konnte nicht geladen werden:', e);
      this.fehler.set((e as { message?: string }).message ?? String(e));
    } finally {
      this.laedt.set(false);
    }
  }

  async speichern(): Promise<void> {
    const e = this.ergebnis();
    if (!e || this.speichert()) return;
    this.speichert.set(true);
    try {
      await this.service.speichern(e);
      this.staende.set(await this.service.staende());
    } catch (err) {
      console.error('Benchmark-Stand konnte nicht gespeichert werden:', err);
      this.fehler.set((err as { message?: string }).message ?? String(err));
    } finally {
      this.speichert.set(false);
    }
  }

  async loeschen(stand: BenchmarkStand): Promise<void> {
    await this.service.loeschen(stand.id);
    this.staende.update((liste) => liste.filter((s) => s.id !== stand.id));
  }

  summe(stand: BenchmarkStand): number {
    return Object.values(stand.ergebnis.anzahl).reduce((a, b) => a + b, 0);
  }
}
