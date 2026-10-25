-- Einmaliger Daten-Fix (keine Schema-/Policy-Änderung): Am 24.10.2026 hat Theodor zwei Partien mit
-- Kratos gespielt. Das Deck gehört Rocky, Theodor hatte es nur ausgeliehen. Gespeichert wurde aber
-- nicht Rockys Deck (entweder gar kein Deck oder ein falsches), deshalb zählen die zwei Partien
-- nicht für Rockys Kratos-Deck.
--
-- Ein Leihdeck ist in der App genau das: match_players.player_id = der Spieler (Theodor),
-- match_players.deck_id = das Deck des Besitzers (Rocky). Die Partien bleiben also Theodors Partien
-- (Sieg/Niederlage, Elo, Platzierung) - nur das Deck zeigt danach auf Rockys Kratos. Im Profil
-- erscheint Kratos bei Theodor dann als „geliehen“, in Rockys Deck-Ansicht zählen die Partien mit.
--
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Erst die beiden SELECTs laufen lassen und
-- prüfen - dann den DO-Block. Der bricht von selbst ab, wenn nicht genau EIN Kratos-Deck von Rocky
-- und genau ZWEI Partien von Theodor gefunden werden, und ändert dann nichts. Gefahrlos mehrfach
-- ausführbar (beim zweiten Lauf zeigen die Zeilen schon auf Rockys Deck und werden übersprungen).

-- 1a. Vorschau: Rockys Kratos-Deck(s). Muss genau eine Zeile sein.
select d.id as deck_id, d.name, d.version, d.deleted_at, p.display_name as besitzer, p.group_id
from decks d
join players p on p.id = d.player_id or (d.player_id is null and p.user_id = d.user_id)
where p.display_name ilike 'rocky'
  and d.deleted_at is null
  and (
    d.name ilike '%kratos%'
    or exists (
      select 1 from deck_cards dc
      where dc.deck_id = d.id and dc.is_commander and dc.card_name ilike '%kratos%'
    )
  );

-- 1b. Vorschau: Theodors Kratos-Partien von heute. Sollten genau zwei Zeilen sein.
select
  mp.id as match_player_id,
  m.played_at,
  m.winner_name,
  mp.player_name,
  mp.commander_name,
  mp.deck_id as deck_id_bisher,
  d.name as deck_bisher
from match_players mp
join matches m on m.id = mp.match_id
join players p on p.id = mp.player_id
left join decks d on d.id = mp.deck_id
where p.display_name ilike 'theodor'
  and mp.commander_name ilike '%kratos%'
  and (m.played_at at time zone 'Europe/Berlin')::date = date '2026-10-24';

-- 2. Korrektur, sobald beide Vorschauen wie erwartet aussehen.
do $$
declare
  rocky_deck record;
  deck_anzahl integer;
  partien integer;
  geaendert integer;
begin
  select count(distinct d.id) into deck_anzahl
  from decks d
  join players p on p.id = d.player_id or (d.player_id is null and p.user_id = d.user_id)
  where p.display_name ilike 'rocky'
    and d.deleted_at is null
    and (
      d.name ilike '%kratos%'
      or exists (
        select 1 from deck_cards dc
        where dc.deck_id = d.id and dc.is_commander and dc.card_name ilike '%kratos%'
      )
    );
  if deck_anzahl <> 1 then
    raise exception 'Erwartet genau ein Kratos-Deck von Rocky, gefunden: %', deck_anzahl;
  end if;

  select distinct d.id, d.version into rocky_deck
  from decks d
  join players p on p.id = d.player_id or (d.player_id is null and p.user_id = d.user_id)
  where p.display_name ilike 'rocky'
    and d.deleted_at is null
    and (
      d.name ilike '%kratos%'
      or exists (
        select 1 from deck_cards dc
        where dc.deck_id = d.id and dc.is_commander and dc.card_name ilike '%kratos%'
      )
    );

  select count(*) into partien
  from match_players mp
  join matches m on m.id = mp.match_id
  join players p on p.id = mp.player_id
  where p.display_name ilike 'theodor'
    and mp.commander_name ilike '%kratos%'
    and (m.played_at at time zone 'Europe/Berlin')::date = date '2026-10-24';
  if partien <> 2 then
    raise exception 'Erwartet zwei Kratos-Partien von Theodor am 24.10.2026, gefunden: %', partien;
  end if;

  -- deck_version setzt der Trigger nur beim Einfügen, deshalb hier von Hand mit.
  update match_players mp
  set deck_id = rocky_deck.id,
      deck_version = rocky_deck.version
  from matches m, players p
  where m.id = mp.match_id
    and p.id = mp.player_id
    and p.display_name ilike 'theodor'
    and mp.commander_name ilike '%kratos%'
    and (m.played_at at time zone 'Europe/Berlin')::date = date '2026-10-24'
    and mp.deck_id is distinct from rocky_deck.id;
  get diagnostics geaendert = row_count;

  raise notice 'Auf Rockys Kratos-Deck umgehängt: % Partie(n)', geaendert;
end;
$$;
