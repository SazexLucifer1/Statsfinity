import { Injectable, effect, inject, signal } from '@angular/core';
import { ProfileService } from './profile.service';

import { auth } from './i18n/auth';
import { common } from './i18n/common';
import { deck } from './i18n/deck';
import { deckView } from './i18n/deck-view';
import { feedback } from './i18n/feedback';
import { group } from './i18n/group';
import { ingame } from './i18n/ingame';
import { match } from './i18n/match';
import { profile } from './i18n/profile';
import { search } from './i18n/search';
import { stats } from './i18n/stats';
import { tournament } from './i18n/tournament';
import { tutorial } from './i18n/tutorial';

export type Lang = 'de' | 'en';

/**
 * Die Übersetzungstabellen liegen nach Bereichen getrennt in ./i18n/ - eine Textänderung muss
 * dadurch nur die betroffene Datei öffnen, nicht alle Texte der App. Namensschema der Keys:
 * "bereich.beschreibung"; der Bereich entscheidet, in welcher Datei der Key steht.
 */
const TRANSLATIONS: Record<Lang, Record<string, string>> = {
  de: {
    ...auth.de,
    ...common.de,
    ...deck.de,
    ...deckView.de,
    ...feedback.de,
    ...group.de,
    ...ingame.de,
    ...match.de,
    ...profile.de,
    ...search.de,
    ...stats.de,
    ...tournament.de,
    ...tutorial.de,
  },
  en: {
    ...auth.en,
    ...common.en,
    ...deck.en,
    ...deckView.en,
    ...feedback.en,
    ...group.en,
    ...ingame.en,
    ...match.en,
    ...profile.en,
    ...search.en,
    ...stats.en,
    ...tournament.en,
    ...tutorial.en,
  },
};
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly profileService = inject(ProfileService);

  /** localStorage-Key, damit die Sprachwahl auch VOR dem Login (Login-/Passwort-Reset-Screen, kein
   * Profil vorhanden) über Reloads hinweg erhalten bleibt - der Account-Wert (profiles.language)
   * übernimmt danach die Führung, sobald ein Profil geladen ist (siehe effect() unten). */
  private static readonly STORAGE_KEY = 'mtg-lang';

  readonly lang = signal<Lang>(I18nService.readStoredLang());

  private static readStoredLang(): Lang {
    const stored = localStorage.getItem(I18nService.STORAGE_KEY);
    return stored === 'en' ? 'en' : 'de';
  }

  constructor() {
    effect(() => {
      const profileLang = this.profileService.profile()?.language;
      if (profileLang) {
        this.lang.set(profileLang);
      }
    });
  }

  async setLang(lang: Lang): Promise<void> {
    this.lang.set(lang);
    localStorage.setItem(I18nService.STORAGE_KEY, lang);
    await this.profileService.updateLanguage(lang);
  }

  toggleLang(): void {
    this.setLang(this.lang() === 'de' ? 'en' : 'de');
  }

  /** Übersetzt einen Key in die aktuell aktive Sprache, ersetzt optional {{platzhalter}} durch vars. */
  t(key: string, vars?: Record<string, string | number>): string {
    return this.tIn(this.lang(), key, vars);
  }

  /**
   * Übersetzt einen Key in eine BESTIMMTE Sprache, unabhängig von der eingestellten.
   *
   * Gibt es für Inhalte, die die App verlassen und woanders gelesen werden: Das Steckbrief-Bild
   * ist immer englisch, egal in welcher Sprache die App gerade läuft - es landet in Beiträgen auf
   * Reddit und Discord, und dort liest es niemand auf Deutsch. Für alles, was in der App selbst
   * steht, ist weiterhin t() richtig.
   */
  tIn(lang: Lang, key: string, vars?: Record<string, string | number>): string {
    const text = TRANSLATIONS[lang][key] ?? key;
    if (!vars) return text;
    return Object.entries(vars).reduce(
      (result, [name, value]) => result.replaceAll(`{{${name}}}`, String(value)),
      text,
    );
  }

  /**
   * Prüft den in einem "Tippe LÖSCHEN zum Bestätigen"-Dialog eingegebenen Text gegen das
   * sprachabhängige Bestätigungswort (stats.deleteConfirmWord) - gemeinsam genutzt vom
   * Hard-Reset (Stats-Tab), Gruppe-löschen (Gruppen-Tab) und Account-löschen (Profil-Tab).
   */
  isDeleteConfirmed(input: string): boolean {
    return input.trim().toUpperCase() === this.t('stats.deleteConfirmWord');
  }
}
