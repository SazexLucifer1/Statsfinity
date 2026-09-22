import { Injectable, effect, inject, signal } from '@angular/core';
import { ProfileService } from './profile.service';
import { ArtLang, istArtLang } from './art-languages';

/**
 * In welcher Sprache die KARTENBILDER gezeigt werden - unabhängig von der Oberflächensprache
 * (i18n.service.ts). Standard ist Englisch, und das ist bewusst so:
 *
 * - Der nächtliche Scryfall-Abgleich füllt `scryfall_cards` aus der englischen Bulk-Datei. Nur in
 *   der englischen Einstellung kommen die Bilder also ohne eine einzige zusätzliche Anfrage aus
 *   der eigenen Datenbank. Jede andere Sprache heißt: pro Kartenliste ein paar Scryfall-Anfragen
 *   mehr (gebündelt, siehe ScryfallService.druckeInSprache()).
 * - Nicht jede Karte ist in jeder Sprache gedruckt worden. Was fehlt, bleibt englisch - deshalb
 *   der Hinweis neben der Auswahl im Profil.
 *
 * Gespeichert wird wie die Oberflächensprache doppelt: im localStorage (gilt sofort, auch ohne
 * Login) und am Account (profiles.art_language, gilt geräteübergreifend). Der Account-Wert
 * übernimmt, sobald ein Profil geladen ist.
 */
@Injectable({ providedIn: 'root' })
export class ArtLanguageService {
  private readonly profileService = inject(ProfileService);

  private static readonly STORAGE_KEY = 'mtg-art-lang';

  readonly lang = signal<ArtLang>(ArtLanguageService.readStoredLang());

  private static readStoredLang(): ArtLang {
    const stored = localStorage.getItem(ArtLanguageService.STORAGE_KEY);
    return istArtLang(stored) ? stored : 'en';
  }

  constructor() {
    effect(() => {
      const ausProfil = this.profileService.profile()?.artLanguage;
      if (ausProfil) this.lang.set(ausProfil);
    });
  }

  async setLang(lang: ArtLang): Promise<void> {
    this.lang.set(lang);
    localStorage.setItem(ArtLanguageService.STORAGE_KEY, lang);
    await this.profileService.updateArtLanguage(lang);
  }
}
