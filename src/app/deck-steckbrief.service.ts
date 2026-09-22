import { Injectable, computed, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { STECKBRIEF_MAX_LAENGE } from './steckbrief-canvas';

/**
 * Die zwei selbst geschriebenen Sätze des Steckbriefs - "worum geht es dem Deck?" und "wie gewinnt
 * es?" (decks.steckbrief_kurz/steckbrief_sieg, siehe sql/deck-steckbrief-2026-09-22.sql).
 *
 * Alles andere auf dem Steckbrief rechnet die App aus dem ohnehin geladenen Deck aus; gespeichert
 * wird nur, was kein Programm aus einer Kartenliste ablesen kann. Deshalb ist dieser Service so
 * klein - er hält zwei Textfelder, mehr nicht.
 *
 * Der Zustand hängt aus demselben Grund am Service wie beim Primer: Derselbe Steckbrief wird an
 * zwei voneinander unabhängigen Stellen gezeigt (deck-detail-view über DeckViewerService und
 * public-deck-browser mit eigenem, lokalem Zustand). Deshalb merkt sich der Service, zu WELCHEM
 * Deck die geladenen Texte gehören - sonst überschreibt bei schnellem Deck-Wechsel eine
 * überholende Antwort die Anzeige.
 */
@Injectable({ providedIn: 'root' })
export class DeckSteckbriefService {
  /** "Worum geht es dem Deck?" - null = nicht ausgefüllt. */
  readonly kurz = signal<string | null>(null);
  /** "Wie gewinnt das Deck?" - null = nicht ausgefüllt. */
  readonly sieg = signal<string | null>(null);

  readonly loading = signal(false);
  readonly saving = signal(false);
  /** Gesetzt, wenn Laden oder Speichern fehlgeschlagen ist - i18n-Key, kein fertiger Text. */
  readonly errorKey = signal<string | null>(null);

  readonly hatText = computed(() => this.kurz() !== null || this.sieg() !== null);

  /**
   * Steht die Migration noch aus, kennt Postgres die Spalten nicht (42703 beim Lesen, PGRST204
   * beim Schreiben über den Schema-Cache von PostgREST). Dann verschwinden nur die zwei Textfelder
   * still - der Reiter selbst bleibt, weil der Rest des Steckbriefs aus dem Deck gerechnet wird.
   * Gleiche Mechanik wie bei den Bracket-Spalten in DeckService und beim Primer.
   */
  readonly verfuegbar = signal(true);

  /** Deck, zu dem die geladenen Texte gehören - gegen überholende Antworten bei schnellem Wechsel. */
  private loadedDeckId: string | null = null;

  async load(deckId: string): Promise<void> {
    this.loadedDeckId = deckId;
    this.kurz.set(null);
    this.sieg.set(null);
    this.errorKey.set(null);
    if (!this.verfuegbar()) return;

    this.loading.set(true);
    const { data, error } = await supabase
      .from('decks')
      .select('steckbrief_kurz, steckbrief_sieg')
      .eq('id', deckId)
      .maybeSingle();
    // Inzwischen wurde ein anderes Deck geöffnet - diese Antwort gehört nicht mehr zur Anzeige.
    if (this.loadedDeckId !== deckId) return;
    this.loading.set(false);

    if (error) {
      if (this.spalteFehlt(error)) return;
      console.error('Konnte Steckbrief nicht laden:', error);
      this.errorKey.set('deckSteckbrief.loadFailed');
      return;
    }

    const zeile = data as {
      steckbrief_kurz?: string | null;
      steckbrief_sieg?: string | null;
    } | null;
    this.kurz.set(this.normalisiere(zeile?.steckbrief_kurz ?? null));
    this.sieg.set(this.normalisiere(zeile?.steckbrief_sieg ?? null));
  }

  /**
   * Speichert beide Felder in einem Zug - sie stehen in derselben Zeile und werden im selben
   * Formular bearbeitet; zwei Updates wären zwei Gelegenheiten, dass nur eines ankommt.
   *
   * updated_at bleibt bewusst unangetastet, aus demselben Grund wie beim Primer: Die Deck-Listen
   * sortieren danach, und ein Steckbrief sagt etwas ÜBER das Deck, ohne das Deck selbst zu ändern.
   */
  async save(deckId: string, kurz: string, sieg: string): Promise<boolean> {
    if (!this.verfuegbar()) return false;

    const werte = {
      steckbrief_kurz: this.normalisiere(kurz),
      steckbrief_sieg: this.normalisiere(sieg),
    };
    if (
      (werte.steckbrief_kurz?.length ?? 0) > STECKBRIEF_MAX_LAENGE ||
      (werte.steckbrief_sieg?.length ?? 0) > STECKBRIEF_MAX_LAENGE
    ) {
      this.errorKey.set('deckSteckbrief.tooLong');
      return false;
    }

    this.saving.set(true);
    this.errorKey.set(null);
    const { error } = await supabase.from('decks').update(werte).eq('id', deckId);
    this.saving.set(false);

    if (error) {
      if (this.spalteFehlt(error)) return false;
      console.error('Konnte Steckbrief nicht speichern:', error);
      this.errorKey.set('deckSteckbrief.saveFailed');
      return false;
    }

    if (this.loadedDeckId === deckId) {
      this.kurz.set(werte.steckbrief_kurz);
      this.sieg.set(werte.steckbrief_sieg);
    }
    return true;
  }

  /** Beim Schließen der Deck-Ansicht aufräumen, damit der nächste Aufruf nicht kurz den alten Text zeigt. */
  zuruecksetzen(): void {
    this.loadedDeckId = null;
    this.kurz.set(null);
    this.sieg.set(null);
    this.errorKey.set(null);
    this.loading.set(false);
  }

  /** Leer getippt heißt "nicht ausgefüllt", nicht "leerer Text" - sonst steht im Bild eine leere Überschrift. */
  private normalisiere(wert: string | null): string | null {
    const text = (wert ?? '').replace(/\s+/g, ' ').trim();
    return text.length ? text : null;
  }

  /**
   * true = die Spalten fehlen noch, die Textfelder sind für diese Sitzung abgeschaltet. 42703
   * meldet Postgres beim Lesen, PGRST204 meldet PostgREST beim Schreiben (die Spalte fehlt in
   * seinem Schema-Cache). Die Meldung wird mitgeprüft, damit nicht irgendeine andere fehlende
   * Migration ausgerechnet den Steckbrief abschaltet.
   */
  private spalteFehlt(error: { code?: string; message?: string }): boolean {
    const code = error.code ?? '';
    if (code !== '42703' && code !== 'PGRST204') return false;
    if (!(error.message ?? '').includes('steckbrief')) return false;
    console.warn(
      'Spalten decks.steckbrief_kurz/steckbrief_sieg fehlen noch - sql/deck-steckbrief-2026-09-22.sql im Supabase-SQL-Editor ausführen. Bis dahin zeigt der Steckbrief nur die berechneten Angaben.',
    );
    this.verfuegbar.set(false);
    this.kurz.set(null);
    this.sieg.set(null);
    return true;
  }
}
