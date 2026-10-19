-- Cube-Builder: eigene Cubes mit Kartenliste, Vorbild CubeCobra (Wunsch des Users, 17.10.2026).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent.
--
-- Client: src/app/cube.service.ts, Ansicht src/app/cube-view/, Rechnen in src/app/cube-layout.ts.
--
-- NICHT zu verwechseln mit der älteren Tabelle public.cubes: Die hält je Gruppe nur einen Namen,
-- damit man beim Erfassen einer Partie angeben kann, welcher Cube gespielt wurde. Die Cubes hier
-- gehören einer Person und haben eine Kartenliste.
--
-- KLEIN GEHALTEN wie die Sammlung: eine Zeile je Karte und Cube, keine Kartendaten-Kopie (Typ,
-- Farbe, Manawert kommen aus dem Nacht-Cache scryfall_cards). scryfall_id ist nur der gewählte
-- Druck fürs Bild, null = Standardbild. Ein 540er-Cube kostet so rund 50 kB.
--
-- collection_only: "nur Karten aus meiner Sammlung" - eine Einstellung je Cube, umschaltbar. Sie
-- steuert, was die App beim Hinzufügen anbietet; die Datenbank prüft das bewusst nicht (eine
-- Karte, die man später verkauft, soll nicht aus dem Cube fallen).

create table if not exists public.cube_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  collection_only boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cube_lists_user_idx on public.cube_lists (user_id);

create table if not exists public.cube_list_cards (
  cube_id uuid not null references public.cube_lists (id) on delete cascade,
  card_name text not null,
  scryfall_id uuid,
  quantity smallint not null default 1 check (quantity between 1 and 99),
  added_at timestamptz not null default now(),
  primary key (cube_id, card_name)
);

comment on table public.cube_lists is
  'Eigene Cubes (Cube-Builder, cube-view/). Nicht die Gruppen-Cubes aus public.cubes. Siehe sql/cubes-2026-10-17.sql.';
comment on column public.cube_lists.collection_only is
  'true = beim Hinzufügen nur Karten aus der eigenen Sammlung anbieten. Reine Client-Regel.';
comment on column public.cube_list_cards.scryfall_id is
  'Gewählter Druck fürs Bild; null = Standardbild der Karte.';

alter table public.cube_lists enable row level security;
alter table public.cube_list_cards enable row level security;

-- Lesen wie bei der Sammlung: Besitzer und Freunde. are_friends() ist SECURITY DEFINER
-- (sql/freunde-2026-10-04.sql) und ruft keine Policy dieser Tabellen auf.
drop policy if exists "Cubes readable by owner and friends" on public.cube_lists;
create policy "Cubes readable by owner and friends"
on public.cube_lists
for select
to authenticated
using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));

drop policy if exists "Cubes writable by owner" on public.cube_lists;
create policy "Cubes writable by owner"
on public.cube_lists
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Die Karten folgen ihrem Cube. Die Unterabfrage läuft über die Policy von cube_lists, die
-- ihrerseits nicht auf cube_list_cards schaut - also keine Rekursion (42P17).
drop policy if exists "Cube cards readable with cube" on public.cube_list_cards;
create policy "Cube cards readable with cube"
on public.cube_list_cards
for select
to authenticated
using (exists (select 1 from public.cube_lists c where c.id = cube_id));

drop policy if exists "Cube cards writable by owner" on public.cube_list_cards;
create policy "Cube cards writable by owner"
on public.cube_list_cards
for all
to authenticated
using (exists (select 1 from public.cube_lists c where c.id = cube_id and c.user_id = auth.uid()))
with check (exists (select 1 from public.cube_lists c where c.id = cube_id and c.user_id = auth.uid()));
