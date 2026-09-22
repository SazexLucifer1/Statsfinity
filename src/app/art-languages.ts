/**
 * Sprachcodes, wie Scryfall sie in `lang` führt - NICHT die App-Sprachen aus i18n.service.ts.
 * "zhs"/"zht" sind vereinfachtes bzw. traditionelles Chinesisch, so heißen sie bei Scryfall.
 *
 * Bewusst eine eigene Datei statt in art-language.service.ts: profile.service.ts braucht Typ und
 * Prüffunktion, der Service wiederum braucht das Profil - über die Service-Datei wäre das ein
 * Import-Kreis.
 */
export type ArtLang = 'en' | 'de' | 'fr' | 'it' | 'es' | 'pt' | 'ja' | 'ko' | 'ru' | 'zhs' | 'zht';

/** Auswahlliste für das Profil - Beschriftung bewusst in der jeweiligen Sprache selbst. */
export const ART_LANGUAGES: { code: ArtLang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'ru', label: 'Русский' },
  { code: 'zhs', label: '简体中文' },
  { code: 'zht', label: '繁體中文' },
];

export function istArtLang(wert: unknown): wert is ArtLang {
  return typeof wert === 'string' && ART_LANGUAGES.some((l) => l.code === wert);
}
