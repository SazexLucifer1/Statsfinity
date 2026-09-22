-- Artwork-Sprache je Account (Profil -> "Sprache der Kartenbilder").
--
-- Speichert, in welcher Sprache die KARTENBILDER gezeigt werden - unabhängig von der
-- Oberflächensprache in profiles.language. Werte sind Scryfall-Sprachcodes:
-- en, de, fr, it, es, pt, ja, ko, ru, zhs, zht. Standard ist 'en'.
--
-- Solange diese Migration nicht gelaufen ist, funktioniert die App unverändert weiter: Das
-- Profil wird dann ohne die Spalte geladen (der erste 42703 schaltet sie für die Sitzung ab,
-- siehe profile.service.ts) und die Einstellung gilt nur auf dem jeweiligen Gerät
-- (localStorage). Nach dem Ausführen gilt sie geräteübergreifend.
--
-- Im Supabase-SQL-Editor ausführen.

alter table public.profiles
  add column if not exists art_language text not null default 'en';

alter table public.profiles
  drop constraint if exists profiles_art_language_check;

alter table public.profiles
  add constraint profiles_art_language_check
  check (art_language in ('en', 'de', 'fr', 'it', 'es', 'pt', 'ja', 'ko', 'ru', 'zhs', 'zht'));

comment on column public.profiles.art_language is
  'Scryfall-Sprachcode für die Kartenbilder (Artwork), Standard en. Nicht zu verwechseln mit language (Oberflächensprache).';
