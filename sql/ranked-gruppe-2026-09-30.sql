-- Ranked je Gruppe: Schalter am Gruppenleiter, Ranked/Frei je Match, Rang-Gruppe im Profil.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Die Elo-Wertung (src/app/elo.ts) wird weiterhin NICHT gespeichert, sondern bei jedem Öffnen aus
-- den Partien der Gruppe gerechnet. Neu ist nur, WELCHE Partien zählen:
--   * groups.ranked_enabled  - der Gruppenleiter schaltet das Rangsystem für seine Gruppe an oder
--                              aus (Standard an). Aus = keine Ränge, keine Ranked/Frei-Auswahl.
--   * matches.is_ranked      - beim Start wählbar: Ranked oder freies Match. Bestehende Partien
--                              zählen als Ranked (Entscheidung des Users, 30.09.2026), Turnierspiele
--                              nie - die werden hier einmalig auf false gesetzt, neue schreibt die
--                              App gleich so.
--   * profiles.rank_group_id - welche Gruppe den Rang im Profil stellt.
--
-- Das Rangsystem ist bewusst NICHT öffentlich: profile_rank_choice() gibt die Rang-Gruppe nur an
-- Mitglieder genau dieser Gruppe heraus, alle anderen bekommen null und sehen keinen Rang.
--
-- Fehlt die Migration, läuft die App weiter wie zuvor: alle Partien gelten als Ranked, der
-- Schalter und die Auswahl verschwinden still (42703/PGRST204, siehe mtg.service.ts und
-- group.service.ts).

-- 1. Schalter je Gruppe
alter table public.groups
  add column if not exists ranked_enabled boolean not null default true;

comment on column public.groups.ranked_enabled is
  'Elo-Rangsystem für diese Gruppe an (Standard) oder aus. Nur der Gruppenleiter schaltet es um.';

-- 2. Ranked oder frei je Match
alter table public.matches
  add column if not exists is_ranked boolean not null default true;

comment on column public.matches.is_ranked is
  'Zählt für die Elo-Wertung der Gruppe (true) oder ist ein freies Match. Turnierspiele immer false.';

update public.matches
   set is_ranked = false
 where tournament_match_id is not null
   and is_ranked;

-- 3. Rang-Gruppe im Profil
alter table public.profiles
  add column if not exists rank_group_id uuid references public.groups (id) on delete set null;

comment on column public.profiles.rank_group_id is
  'Gruppe, deren Elo-Rang im Profil gezeigt wird. null = die gerade aktive Gruppe.';

-- Modus und Format kommen aus sql/elo-rang-modus-2026-09-29.sql - hier noch einmal, damit diese
-- Datei auch dann durchläuft, wenn die ältere noch nicht ausgeführt wurde.
alter table public.profiles
  add column if not exists rank_mode text not null default 'Normal';
alter table public.profiles
  add column if not exists rank_format text default 'Commander';

-- 4. Rang-Auswahl lesen. Rückgabetyp hat sich geändert -> erst löschen.
drop function if exists public.profile_rank_choice(uuid);

create or replace function public.profile_rank_choice(p_user_id uuid)
returns table (rank_mode text, rank_format text, rank_group_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.rank_mode::text,
    p.rank_format::text,
    -- Nur wer selbst in dieser Gruppe ist, erfährt sie - der Rang ist eine Gruppensache.
    case
      when exists (
        select 1 from public.group_members gm
         where gm.group_id = p.rank_group_id
           and gm.user_id = auth.uid()
      ) then p.rank_group_id
    end
  from public.profiles p
  where p.id = p_user_id;
$$;

grant execute on function public.profile_rank_choice(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
