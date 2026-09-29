-- Elo-Rang im Profil: welcher Spielmodus und welches Format Abzeichen und Profilrahmen bestimmen.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent - auch wer die erste Fassung
-- (nur rank_mode) schon ausgeführt hat, führt diese Datei einfach noch einmal komplett aus.
--
-- Die Elo selbst wird NICHT gespeichert (siehe src/app/elo.ts) - sie entsteht bei jedem Öffnen
-- neu aus dem Match-Verlauf, je Modus UND Format getrennt. Gespeichert wird nur, welche
-- Kombination im Profil angezeigt werden soll (Werte wie GameMode/DeckFormat in
-- src/app/models.ts, Standard 'Normal' + 'Commander'). Am Account statt nur im Browser, weil auch
-- andere Besucher des Profils den Rahmen in genau diesem Rang sehen sollen.
--
-- Fehlt diese Migration, zeigt die App für alle Commander, und die eigene Auswahl gilt nur auf
-- dem jeweiligen Gerät (siehe ProfileService.loadRankChoice()).

alter table public.profiles
  add column if not exists rank_mode text not null default 'Normal';

alter table public.profiles
  drop constraint if exists profiles_rank_mode_check;

alter table public.profiles
  add constraint profiles_rank_mode_check
  check (rank_mode in ('Normal', 'Two-Headed Giant', 'Archenemy', 'Cube', 'Draft', 'Spezialevent'));

comment on column public.profiles.rank_mode is
  'Spielmodus, dessen Elo-Rang im Profil gezeigt wird (Abzeichen + Rahmenfarbe). Standard Normal.';

-- Format ohne Check-Constraint: die Formatliste (DECK_FORMATS) wächst mit der App, und ein
-- unbekannter Wert richtet keinen Schaden an - die App fällt dann auf Commander zurück.
-- null = Modus ohne Format (Spezialevent).
alter table public.profiles
  add column if not exists rank_format text default 'Commander';

comment on column public.profiles.rank_format is
  'Format (DeckFormat), dessen Elo-Rang im Profil gezeigt wird. Standard Commander, null = ohne Format.';

-- Die erste Fassung gab nur den Modus zurück. Rückgabetyp geändert -> erst löschen.
drop function if exists public.profile_rank_mode(uuid);

-- Lesen auch für Besucher ohne Login: profiles ist für anon gesperrt und soll es bleiben, deshalb
-- wie public_profile() eine SECURITY-DEFINER-Funktion, die genau diese zwei Felder herausgibt.
create or replace function public.profile_rank_choice(p_user_id uuid)
returns table (rank_mode text, rank_format text)
language sql
stable
security definer
set search_path = public
as $$
  select p.rank_mode::text, p.rank_format::text from public.profiles p where p.id = p_user_id;
$$;

grant execute on function public.profile_rank_choice(uuid) to anon, authenticated;

-- Geschrieben wird mit einem normalen update auf die eigene Zeile (bestehende Policy).

notify pgrst, 'reload schema';
