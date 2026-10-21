-- Freunde-Rangliste: Import-Niederlagen zählen für die Bilanz der Person (21.10.2026).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent. Setzt sql/freunde-2026-10-04.sql
-- voraus.
--
-- Der frühere Excel-Import hat jede Partie in Datensätze mit je EINEM Spieler zerlegt: einen für den
-- Sieger, einen je Verlierer mit dem Platzhalter-Sieger 'Unbekannt (Import)' bzw.
-- 'Archenemy (Import)'. Bisher fielen die Verlierer-Datensätze hier heraus - damit stand jede
-- Person mit allen Import-Siegen, aber ohne eine einzige Import-Niederlage da (geprüft am
-- 21.10.2026: Winraten von 60-80 % statt 20-35 %). Ein Verlierer-Datensatz mit genau einem Spieler
-- ist die einzige Spur dieser Niederlage und zählt jetzt; einer mit mehreren Spielern wäre ein
-- echtes Duplikat und bleibt draußen. Dieselbe Regel im Client: countsForPlayers() in
-- src/app/match-utils.ts.
--
-- Zurück zum alten Stand: die Funktion aus sql/freunde-2026-10-04.sql erneut ausführen.

create or replace function public.friends_overall_stats()
returns table (user_id uuid, display_name text, avatar_url text, games integer, wins integer)
language sql
stable
security definer
set search_path = public
as $$
  with leute as (
    select auth.uid() as id
     where auth.uid() is not null
    union
    select case when f.requester = auth.uid() then f.addressee else f.requester end
      from public.friendships f
     where f.status = 'accepted' and auth.uid() in (f.requester, f.addressee)
  ),
  teilnahmen as (
    select l.id as user_id, m.id as match_id,
           case
             when m.game_mode = 'Two-Headed Giant' then mp.team is not null and mp.team = m.winner_name
             when m.game_mode = 'Archenemy' and m.winner_name = '__OTHERS__' then not coalesce(mp.is_archenemy, false)
             else mp.player_name = m.winner_name
           end as won
      from public.match_players mp
      left join public.players pl on pl.id = mp.player_id
      join leute l on l.id = coalesce(mp.user_id, pl.user_id)
      join public.matches m on m.id = mp.match_id
     where coalesce((to_jsonb(m)->>'counts_in_general_stats')::boolean, true)
       and (
         m.winner_name not in ('Unbekannt (Import)', 'Archenemy (Import)')
         or (select count(*) from public.match_players x where x.match_id = m.id) = 1
       )
  )
  select l.id, p.display_name::text, p.avatar_url::text,
         count(distinct t.match_id)::integer,
         count(distinct t.match_id) filter (where t.won)::integer
    from leute l
    join public.profiles p on p.id = l.id
    left join teilnahmen t on t.user_id = l.id
   group by l.id, p.display_name, p.avatar_url;
$$;

grant execute on function public.friends_overall_stats() to authenticated;

notify pgrst, 'reload schema';
