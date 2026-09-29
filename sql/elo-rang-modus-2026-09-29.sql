-- Elo-Rang im Profil: welcher Spielmodus Abzeichen und Profilrahmen bestimmt.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Die Elo selbst wird NICHT gespeichert (siehe src/app/elo.ts) - sie entsteht bei jedem Öffnen
-- neu aus dem Match-Verlauf. Gespeichert wird nur, welcher Modus im Profil angezeigt werden soll
-- (Werte wie GameMode in src/app/models.ts, Standard 'Normal' = Commander). Am Account statt nur
-- im Browser, weil auch andere Besucher des Profils den Rahmen in genau diesem Modus sehen sollen.
--
-- Fehlt diese Migration, zeigt die App für alle den Standardmodus, und die eigene Auswahl gilt
-- nur auf dem jeweiligen Gerät (siehe ProfileService.loadRankMode()).

alter table public.profiles
  add column if not exists rank_mode text not null default 'Normal';

alter table public.profiles
  drop constraint if exists profiles_rank_mode_check;

alter table public.profiles
  add constraint profiles_rank_mode_check
  check (rank_mode in ('Normal', 'Two-Headed Giant', 'Archenemy', 'Cube', 'Draft', 'Spezialevent'));

comment on column public.profiles.rank_mode is
  'Spielmodus, dessen Elo-Rang im Profil gezeigt wird (Abzeichen + Rahmenfarbe). Standard Normal.';

-- Lesen auch für Besucher ohne Login: profiles ist für anon gesperrt und soll es bleiben, deshalb
-- wie public_profile() eine SECURITY-DEFINER-Funktion, die genau dieses eine Feld herausgibt.
create or replace function public.profile_rank_mode(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.rank_mode::text from public.profiles p where p.id = p_user_id;
$$;

grant execute on function public.profile_rank_mode(uuid) to anon, authenticated;

-- Geschrieben wird mit einem normalen update auf die eigene Zeile (bestehende Policy).

notify pgrst, 'reload schema';
