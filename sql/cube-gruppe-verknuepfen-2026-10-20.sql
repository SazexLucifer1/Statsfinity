-- Cubes beim Match-Start: die Cubes aller Gruppenmitglieder aus dem Cube-Builder zur Auswahl,
-- und ältere Gruppen-Cubes lassen sich mit einem davon verknüpfen (Wunsch des Users, 20.10.2026).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent. Setzt sql/cubes-2026-10-17.sql
-- und sql/cube-format-2026-10-19.sql voraus.
--
-- Zwei Arten von Cubes gibt es seit dem Cube-Builder:
--   public.cubes       je Gruppe nur ein Name, matches.cube_id zeigt hierher (seit jeher)
--   public.cube_lists  je Person, mit Kartenliste (Cube-Builder, cube-view/)
-- Partien zeigen weiter auf public.cubes - so bleibt jede bisherige Partie, Statistik und Abfrage
-- unverändert. Neu ist nur der Verweis cubes.cube_list_id: Ein Gruppen-Cube MIT Verweis IST der
-- Cube aus dem Builder (Name kommt beim Lesen von dort). Wer beim Match-Start einen Builder-Cube
-- wählt, bekommt dafür einmal je Gruppe eine solche Zeile angelegt (Client: MtgService.cubeForList()).
-- Ein alter Gruppen-Cube, der verknüpft wird, behält seine Partien - sie zählen damit für den Cube
-- aus dem Builder.

alter table public.cubes
  add column if not exists cube_list_id uuid references public.cube_lists (id) on delete set null;

create unique index if not exists cubes_group_list_idx
  on public.cubes (group_id, cube_list_id)
  where cube_list_id is not null;

comment on column public.cubes.cube_list_id is
  'Verknüpfter Cube aus dem Cube-Builder (public.cube_lists); NULL = nur ein Name. Siehe sql/cube-gruppe-verknuepfen-2026-10-20.sql.';

-- Die Cubes aller Mitglieder einer Gruppe, für Mitglieder dieser Gruppe. SECURITY DEFINER, weil
-- cube_lists sonst nur Besitzer und Freunde lesen dürfen - Gruppenmitglieder sind nicht
-- zwangsläufig befreundet. Herausgegeben werden nur Name, Format, Besitzername und Kartenzahl,
-- keine Kartenliste.
create or replace function public.group_cube_lists(p_group_id uuid)
returns table (
  id uuid,
  name text,
  format text,
  owner_id uuid,
  owner_name text,
  card_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    cl.id,
    cl.name,
    cl.format,
    cl.user_id,
    nullif(btrim(p.display_name::text), ''),
    coalesce((select sum(c.quantity)::integer from public.cube_list_cards c where c.cube_id = cl.id), 0)
  from public.cube_lists cl
  left join public.profiles p on p.id = cl.user_id
  where exists (
      select 1 from public.group_members me
      where me.group_id = p_group_id and me.user_id = auth.uid()
    )
    and exists (
      select 1 from public.group_members owner
      where owner.group_id = p_group_id and owner.user_id = cl.user_id
    )
  order by cl.name;
$$;

revoke all on function public.group_cube_lists(uuid) from public, anon;
grant execute on function public.group_cube_lists(uuid) to authenticated;
