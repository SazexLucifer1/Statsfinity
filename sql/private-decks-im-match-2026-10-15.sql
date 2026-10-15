-- Private Decks im Match: auswählbar, aber nicht einsehbar - und nach dem ersten Match öffentlich
-- (Wunsch des Users, 15.10.2026).
--
-- Bisher: Ein privates Deck (decks.is_private) liest nur sein Besitzer. Wer das Match auf seinem
-- Handy anlegt und für einen Mitspieler das Deck wählt, bekam dessen private Decks gar nicht erst
-- geliefert - und selbst mit der ID hätte die Auswahl den Commander nicht lesen können
-- (deck_cards folgt derselben Sichtbarkeit).
--
-- Jetzt:
-- 1. match_deck_choices() liefert Mitspielern die privaten Decks eines Spielers - aber nur, was
--    die Auswahl braucht (Name, Format, Bracket, Commander), NIE die Kartenliste. An den
--    Policies von decks/deck_cards ändert sich nichts, die Deck-Ansicht bleibt Fremden verschlossen.
--    Mitspieler heißt: in einer gemeinsamen Gruppe (Konto) bzw. Mitglied der Gruppe des Spielers
--    (Spieler ohne Konto) oder befreundet (Freundesspiele).
-- 2. Ein Trigger macht ein Deck öffentlich, sobald eine Partie damit gespeichert wird. Danach
--    darf der Besitzer es wieder auf privat stellen; erst die nächste Partie macht es wieder
--    sichtbar.
--
-- Gefahrlos mehrfach ausführbar. Fehlt die Funktion, zeigt die App wie bisher nur sichtbare Decks.

-- 1. Auswahl ---------------------------------------------------------------------------------

create or replace function public.match_deck_choices(p_user_id uuid, p_player_id uuid)
returns table (
  id uuid,
  name text,
  format text,
  is_precon boolean,
  precon_release_year integer,
  created_at timestamptz,
  bracket smallint,
  bracket_auto smallint,
  commanders jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.name, d.format, d.is_precon, d.precon_release_year, d.created_at,
         d.bracket::smallint, d.bracket_auto::smallint,
         coalesce(
           (select jsonb_agg(jsonb_build_object('name', c.card_name, 'image_url', c.image_url))
              from public.deck_cards c
             where c.deck_id = d.id and c.is_commander),
           '[]'::jsonb
         )
    from public.decks d
   where d.is_private
     and d.deleted_at is null
     and auth.uid() is not null
     and (
       (p_user_id is not null and d.user_id = p_user_id and (
          p_user_id = auth.uid()
          or public.are_friends(auth.uid(), p_user_id)
          or exists (
            select 1
              from public.group_members a
              join public.group_members b on b.group_id = a.group_id
             where a.user_id = auth.uid() and b.user_id = p_user_id
          )
       ))
       or
       (p_player_id is not null and d.player_id = p_player_id and exists (
          select 1
            from public.players p
            join public.group_members gm on gm.group_id = p.group_id
           where p.id = p_player_id and gm.user_id = auth.uid()
       ))
     )
   order by d.updated_at desc;
$$;

grant execute on function public.match_deck_choices(uuid, uuid) to authenticated;

-- 2. Nach dem Match sichtbar -----------------------------------------------------------------

create or replace function public.deck_nach_match_sichtbar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deck_id is not null then
    update public.decks set is_private = false where id = new.deck_id and is_private;
  end if;
  return new;
end;
$$;

drop trigger if exists deck_nach_match_sichtbar on public.match_players;
create trigger deck_nach_match_sichtbar
  after insert or update of deck_id on public.match_players
  for each row execute function public.deck_nach_match_sichtbar();

-- 3. Optional: Decks, die schon VOR dieser Regel in Partien gespielt wurden und noch privat sind.
--    Bewusst auskommentiert - mancher hat ein gespieltes Deck vielleicht absichtlich versteckt.
--    Erst nachsehen, dann entscheiden:
--
-- select d.id, d.name from public.decks d
--  where d.is_private and d.deleted_at is null
--    and exists (select 1 from public.match_players mp where mp.deck_id = d.id);
--
-- update public.decks d set is_private = false
--  where d.is_private and d.deleted_at is null
--    and exists (select 1 from public.match_players mp where mp.deck_id = d.id);
