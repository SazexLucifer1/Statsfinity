import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../i18n.service';
import { sampleSize } from '../../match-insights';

/**
 * Kleiner Hinweis neben einer Quote, wie viele Partien dahinterstehen: 1-4 "Sehr wenig Daten",
 * 5-9 "Erste Tendenz", ab 10 "Mehr Daten". Nur Orientierung, keine statistische Bewertung - damit
 * 100 % aus einer Partie nicht so überzeugend aussehen wie 65 % aus hundert. Bei 0 Partien leer.
 * Bewusst nur leiser Text in der Schrift der Umgebung, keine Pille.
 */
@Component({
  selector: 'app-sample-hint',
  templateUrl: './sample-hint.html',
  styleUrl: './sample-hint.scss',
})
export class SampleHint {
  readonly i18n = inject(I18nService);
  readonly games = input.required<number>();

  readonly level = computed(() => sampleSize(this.games()));
}
