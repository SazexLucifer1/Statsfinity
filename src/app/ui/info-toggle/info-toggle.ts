import { Component, input, signal } from '@angular/core';

/**
 * Überschrift mit ⓘ-Knopf, der eine Erklärung aufklappt (Wunsch des Users, 05.10.2026):
 * Erklärtexte - was zählt, woher die Zahl kommt, wer Frank Karsten ist - stehen hinter dem ⓘ
 * statt dauerhaft als Textblock auf der Karte. Sichtbar bleibt nur, was man zum Ablesen braucht.
 *
 * Benutzung:
 *   <app-info-toggle [label]="'Was zählt hier?'">
 *     <h4 info-title>Farbquellen</h4>
 *     <p>Erklärtext …</p>
 *   </app-info-toggle>
 */
@Component({
  selector: 'app-info-toggle',
  templateUrl: './info-toggle.html',
  styleUrl: './info-toggle.scss',
})
export class InfoToggle {
  /** Für Screenreader: was der Knopf erklärt. */
  readonly label = input.required<string>();
  readonly open = signal(false);
}
