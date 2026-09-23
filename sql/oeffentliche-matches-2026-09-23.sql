-- Öffentliche Match-Liste eines Profils: alle Partien, an denen ein Account teilgenommen hat, aus
-- ALLEN Gruppen - auch für Besucher ohne Login oder aus einer anderen Gruppe. Im Supabase-
-- Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Anlass: Die Deck-Suche verlinkt unter jedem Deck auf das Profil des Besitzers. Die Match-Liste
-- im Profil (player-match-history) las bisher nur die Matches der Gruppe, in der der BETRACHTER
-- gerade aktiv ist - ohne Login oder aus einer anderen Gruppe stand dort "Noch keine Spiele
-- erfasst", obwohl die Person spielt. matches/match_players sind per RLS nur für Mitglieder der
-- Gruppe lesbar, deshalb eine SECURITY-DEFINER-Funktion.
--
-- BEWUSSTE ENTSCHEIDUNG (User, 23.09.2026): Die Liste ist öffentlich, samt Datum, Modus,
-- Ergebnis, Commandern und den Namen der Mitspieler. Nicht herausgegeben werden: group_id und
-- der Name/die ID PRIVATER Decks (die sind außerhalb ihres Besitzers auch sonst nirgends sichtbar).
--
-- Rückgabe ist ein jsonb-Array im selben Zuschnitt wie die verschachtelte PostgREST-Abfrage in
-- mtg.service.ts (MATCH_HISTORY_SELECT), damit die App dieselbe mapMatchRow() benutzt statt einer
-- zweiten Umrechnung. to_jsonb(m) statt einer Spaltenliste: fehlt eine jüngere Spalte (etwa
-- game_format), entsteht die Funktion trotzdem, und mapMatchRow() setzt dafür ohnehin Vorgaben.
-- Zusätzlich je Match "self_name": der Name, unter dem DIESE Person dort gespielt hat - er kann je
-- Gruppe anders lauten.

create or replace function public.public_player_matches(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(zeile order by zeile->>'played_at' desc), '[]'::jsonb)
  from (
    select
      (to_jsonb(m) - 'group_id')
      || jsonb_build_object(
        'self_name', (
          select mp.player_name
          from public.match_players mp
          join public.players p on p.id = mp.player_id
          where mp.match_id = m.id and p.user_id = p_user_id
          limit 1
        ),
        'cubes', (
          select jsonb_build_object('id', c.id, 'name', c.name, 'is_commander', c.is_commander)
          from public.cubes c
          where c.id::text = to_jsonb(m)->>'cube_id'
        ),
        'match_players', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'player_name', mp.player_name,
              'commander_name', mp.commander_name,
              'partner_commander_name', mp.partner_commander_name,
              'team', mp.team,
              'is_archenemy', mp.is_archenemy,
              'placement', mp.placement,
              -- Private Decks: weder Name noch ID - die Kachel ist dann einfach nicht anklickbar.
              'deck_id', case when d.is_private then null else mp.deck_id end,
              'decks', case
                when d.id is null or d.is_private then null
                else jsonb_build_object(
                  'name', d.name, 'user_id', d.user_id, 'player_id', d.player_id, 'is_precon', d.is_precon
                )
              end,
              'players', jsonb_build_object('display_name', pl.display_name)
            )
          ), '[]'::jsonb)
          from public.match_players mp
          left join public.decks d on d.id = mp.deck_id
          left join public.players pl on pl.id = mp.player_id
          where mp.match_id = m.id
        )
      ) as zeile
    from public.matches m
    where exists (
      select 1
      from public.match_players mp
      join public.players p on p.id = mp.player_id
      where mp.match_id = m.id and p.user_id = p_user_id
    )
  ) t;
$$;

grant execute on function public.public_player_matches(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
