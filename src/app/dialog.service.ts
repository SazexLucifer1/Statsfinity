import { Injectable, signal } from '@angular/core';

/** Ein Knopf im Auswahl-Dialog (mode 'choice') - der key kommt als Ergebnis von choose() zurück. */
export interface DialogChoice {
  key: string;
  label: string;
  /** 'primary' hebt den empfohlenen Weg hervor, 'danger' den, der etwas wegwirft. */
  variant?: 'primary' | 'danger';
}

interface DialogRequest {
  message: string;
  mode: 'confirm' | 'alert' | 'choice';
  /** Nur bei mode 'choice' gefüllt. */
  choices: DialogChoice[];
  resolve: (value: boolean | string | null) => void;
}

/**
 * Ersatz für die nativen Browser-Dialoge confirm()/alert() - die sehen je nach Gerät/Browser
 * komplett anders aus als der Rest der App (Windows-/Handy-Systemdialog statt Glass-Look). Läuft
 * über eine globale Overlay-Komponente (Dialog, in app.html gemountet), die dieses Signal
 * beobachtet - gleiches Muster wie PlacementDialog/TournamentPanel.
 */
@Injectable({ providedIn: 'root' })
export class DialogService {
  readonly request = signal<DialogRequest | null>(null);

  /** Ersatz für confirm() - löst mit true/false auf, je nachdem welcher Button gedrückt wurde. */
  confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.request.set({
        message,
        mode: 'confirm',
        choices: [],
        resolve: resolve as (value: boolean | string | null) => void,
      });
    });
  }

  /** Ersatz für alert() - löst auf, sobald bestätigt wurde. */
  alert(message: string): Promise<void> {
    return new Promise((resolve) => {
      this.request.set({ message, mode: 'alert', choices: [], resolve: () => resolve() });
    });
  }

  /**
   * Wie confirm(), nur mit mehr als einer Antwort: liefert den key des gedrückten Knopfes oder
   * null beim Abbrechen. Gedacht für Fälle, in denen "Ja/Nein" die falsche Frage wäre, weil es
   * einen dritten, meist besseren Weg gibt - z.B. ein Deck als Outdated zu markieren, statt es zu
   * löschen (siehe deck-list.ts).
   */
  choose(message: string, choices: DialogChoice[]): Promise<string | null> {
    return new Promise((resolve) => {
      this.request.set({
        message,
        mode: 'choice',
        choices,
        resolve: (value) => resolve(typeof value === 'string' ? value : null),
      });
    });
  }

  respond(value: boolean | string | null): void {
    const req = this.request();
    if (!req) return;
    this.request.set(null);
    req.resolve(value);
  }
}
