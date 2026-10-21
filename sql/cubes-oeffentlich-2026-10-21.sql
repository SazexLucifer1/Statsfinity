-- Cubes öffentlich wie Decks, mit Schalter "Privat" je Cube (Entscheidung des Users, 21.10.2026).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent. Setzt sql/cubes-2026-10-17.sql,
-- sql/cube-format-2026-10-19.sql und sql/freunde-neuigkeiten-2026-10-21.sql voraus.
--
-- Bisher lasen nur Besitzer und Freunde einen Cube. Jetzt wie bei Decks: Jeder - auch ohne Login -
-- sieht alle Cubes, die nicht privat sind; private sieht nur der Besitzer. BESTEHENDE CUBES WERDEN
-- DAMIT ÖFFENTLICH (Spalte startet mit false). Schreiben bleibt beim Besitzer (Policy unverändert).
--
-- Zurück zum alten Stand: die beiden Lese-Policies aus sql/cubes-2026-10-17.sql erneut ausführen
-- (die Spalte is_private darf stehen bleiben).

alter table public.cube_lists
  add column if not exists is_private boolean not null default false;

comment on column public.cube_lists.is_private is
  'true = nur der Besitzer sieht den Cube; sonst öffentlich wie ein Deck. Siehe sql/cubes-oeffentlich-2026-10-21.sql.';

drop policy if exists "Cubes readable by owner and friends" on public.cube_lists;
drop policy if exists "Cubes readable unless private" on public.cube_lists;
create policy "Cubes readable unless private"
on public.cube_lists
for select
to anon, authenticated
using (not is_private or user_id = auth.uid());

-- Karten folgen der Sichtbarkeit ihres Cubes (die Unterabfrage läuft selbst unter RLS).
drop policy if exists "Cube cards readable with cube" on public.cube_list_cards;
create policy "Cube cards readable with cube"
on public.cube_list_cards
for select
to anon, authenticated
using (exists (select 1 from public.cube_lists c where c.id = cube_id));

grant select on public.cube_lists, public.cube_list_cards to anon;

-- Öffentliche Cubes zum Stöbern (Suche-Tab) und für ein fremdes Profil (p_user_id), mit
-- Besitzername. SECURITY DEFINER wegen des Namens: profiles ist für anon gesperrt (gleiche Lösung
-- wie deck_social_stats). Private Cubes gibt sie nie heraus, auch nicht dem Besitzer - der sieht
-- seine eigenen ohnehin in der Cube-Seite.
create or replace function public.public_cubes(
  p_user_id uuid default null,
  p_query text default null,
  p_limit integer default 30,
  p_offset integer default 0
)
returns table (
  id uuid,
  name text,
  description text,
  format text,
  owner_id uuid,
  owner_name text,
  card_count integer,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select cl.id, cl.name, cl.description, cl.format::text, cl.user_id,
         nullif(btrim(p.display_name::text), ''),
         coalesce((select sum(c.quantity)::integer from public.cube_list_cards c where c.cube_id = cl.id), 0),
         cl.updated_at
    from public.cube_lists cl
    left join public.profiles p on p.id = cl.user_id
   where not cl.is_private
     and (p_user_id is null or cl.user_id = p_user_id)
     and (coalesce(btrim(p_query), '') = '' or cl.name ilike '%' || btrim(p_query) || '%')
   order by cl.updated_at desc
   limit greatest(1, least(coalesce(p_limit, 30), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

grant execute on function public.public_cubes(uuid, text, integer, integer) to anon, authenticated;

-- Neuigkeiten der Freunde: private Cubes nicht melden. Sonst unverändert gegenüber
-- sql/freunde-neuigkeiten-2026-10-21.sql.
create or replace function public.friend_activity(p_limit integer default 30)
returns table (
  kind text,
  happened_at timestamptz,
  friend_id uuid,
  friend_name text,
  match_id uuid,
  game_mode text,
  game_format text,
  won boolean,
  player_count integer,
  deck_id uuid,
  deck_name text,
  commander text
)
language sql
stable
security definer
set search_path = public
as $$
  with freunde as (
    select case when f.requester = auth.uid() then f.addressee else f.requester end as id
      from public.friendships f
     where f.status = 'accepted' and auth.uid() in (f.requester, f.addressee)
  ),
  teilnahmen as (
    select m.id as match_id, m.played_at, m.game_mode::text as game_mode, to_jsonb(m)->>'game_format' as game_format,
           m.winner_name, fr.id as friend_id, mp.player_name, mp.team, mp.is_archenemy,
           (select count(*) from public.match_players x where x.match_id = m.id)::integer as player_count
      from public.match_players mp
      left join public.players pl on pl.id = mp.player_id
      join freunde fr on fr.id = coalesce(mp.user_id, pl.user_id)
      join public.matches m on m.id = mp.match_id
     where m.played_at > now() - interval '60 days'
  ),
  siege as (
    select t.*
      from teilnahmen t
     where case
             when t.game_mode = 'Two-Headed Giant' then t.team is not null and t.team = t.winner_name
             when t.game_mode = 'Archenemy' and t.winner_name = '__OTHERS__' then not coalesce(t.is_archenemy, false)
             else t.player_name = t.winner_name
           end
  )
  select * from (
    select 'match'::text, s.played_at, s.friend_id, p.display_name::text, s.match_id, s.game_mode, s.game_format,
           true, s.player_count, null::uuid, null::text, null::text
      from siege s
      join public.profiles p on p.id = s.friend_id
    union all
    select 'deck'::text, d.created_at, d.user_id, p.display_name::text, null::uuid, null::text, d.format::text, null::boolean,
           null::integer, d.id, d.name::text,
           (select min(c.card_name) from public.deck_cards c where c.deck_id = d.id and c.is_commander)
      from public.decks d
      join freunde fr on fr.id = d.user_id
      join public.profiles p on p.id = d.user_id
     where not coalesce(d.is_private, false)
       and d.deleted_at is null
       and d.created_at > now() - interval '60 days'
    union all
    select 'cube'::text, cl.created_at, cl.user_id, p.display_name::text, null::uuid, null::text, null::text, null::boolean,
           coalesce((select sum(c.quantity)::integer from public.cube_list_cards c where c.cube_id = cl.id), 0),
           cl.id, cl.name::text, null::text
      from public.cube_lists cl
      join freunde fr on fr.id = cl.user_id
      join public.profiles p on p.id = cl.user_id
     where not cl.is_private
       and cl.created_at > now() - interval '60 days'
  ) ereignisse
  order by 2 desc
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;

grant execute on function public.friend_activity(integer) to authenticated;

notify pgrst, 'reload schema';
