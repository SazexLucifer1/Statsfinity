-- Ranked-Saisons: Neustart der Wertung und dauerhafte Saison-Abzeichen.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Entscheidungen des Users (06.10.2026):
--   - Der Gruppenleiter kann die Wertung seiner Gruppe zurücksetzen (Neustart ohne Abzeichen).
--   - Er kann eine Saison beenden: Jeder mit fertigem Rang bekommt je Wertung (Modus + Format)
--     ein dauerhaftes Abzeichen mit Endrang und LP, danach startet die Wertung neu.
--   - Die Abzeichen sieht jeder im Profil, auch ohne Login.
--
-- Die Elo wird weiterhin NICHT gespeichert, sondern aus den Partien gerechnet (elo.ts). Ein
-- Neustart löscht deshalb keine Partien: groups.ranked_since sagt nur, ab wann sie zählen.
-- Gespeichert wird allein, was nach einem Neustart nicht mehr aus den Partien folgt - das
-- Endergebnis einer beendeten Saison.

-- 1. Ab wann die Wertung einer Gruppe zählt -----------------------------------------------------

alter table public.groups
  add column if not exists ranked_since timestamptz;

comment on column public.groups.ranked_since is
  'Start der laufenden Ranked-Saison: nur Partien ab diesem Zeitpunkt zählen für die Elo. null = alle. Setzt nur der Gruppenleiter (bestehende Update-Policy auf groups).';

-- 2. Saison-Abzeichen ----------------------------------------------------------------------------

create table if not exists public.ranked_badges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Bleibt stehen, wenn die Gruppe gelöscht wird: Das Abzeichen gehört dem Spieler.
  group_id uuid references public.groups (id) on delete set null,
  group_name text not null,
  mode text not null,
  format text,
  lp integer not null,
  season_started_at timestamptz,
  season_ended_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

create index if not exists ranked_badges_user_idx on public.ranked_badges (user_id, season_ended_at desc);

comment on table public.ranked_badges is
  'Endrang je Spieler, Wertung (Modus + Format) und beendeter Saison. Öffentlich lesbar, anlegen und löschen nur der Gruppenleiter der Gruppe.';

alter table public.ranked_badges enable row level security;

drop policy if exists "ranked_badges: alle lesen" on public.ranked_badges;
create policy "ranked_badges: alle lesen" on public.ranked_badges
  for select using (true);

drop policy if exists "ranked_badges: gruppenleiter anlegen" on public.ranked_badges;
create policy "ranked_badges: gruppenleiter anlegen" on public.ranked_badges
  for insert with check (
    exists (
      select 1 from public.group_members gm
       where gm.group_id = ranked_badges.group_id
         and gm.user_id = auth.uid()
         and gm.role = 'owner'
    )
  );

drop policy if exists "ranked_badges: gruppenleiter löschen" on public.ranked_badges;
create policy "ranked_badges: gruppenleiter löschen" on public.ranked_badges
  for delete using (
    exists (
      select 1 from public.group_members gm
       where gm.group_id = ranked_badges.group_id
         and gm.user_id = auth.uid()
         and gm.role = 'owner'
    )
  );

grant select on public.ranked_badges to anon, authenticated;
grant insert, delete on public.ranked_badges to authenticated;

notify pgrst, 'reload schema';
