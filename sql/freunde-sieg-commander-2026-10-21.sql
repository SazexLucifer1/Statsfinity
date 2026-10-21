-- Neuigkeiten der Freunde: bei einem Sieg auch der Commander (Wunsch des Users, 21.10.2026).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent. NACH
-- sql/cubes-oeffentlich-2026-10-21.sql ausführen - diese Datei ersetzt friend_activity() noch einmal
-- und ist sonst unverändert gegenüber dort. Die Spalte commander war bei Partien bisher leer, jetzt
-- steht dort der Commander des Freundes ("A + B" bei Partnern). Rückgabe unverändert.
--
-- Zurück zum alten Stand: die Funktion aus sql/cubes-oeffentlich-2026-10-21.sql erneut ausführen.

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
           case
             when mp.partner_commander_name is not null and mp.partner_commander_name <> ''
               then mp.commander_name || ' + ' || mp.partner_commander_name
             else mp.commander_name
           end as commander_name,
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
           true, s.player_count, null::uuid, null::text, nullif(btrim(s.commander_name), '')
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
