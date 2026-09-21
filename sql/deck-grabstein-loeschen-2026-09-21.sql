-- Deck-Löschen, ohne dass Gruppen-Statistiken sich ändern ("Grabstein"). MIT BEGRÜNDUNG, siehe unten.
-- Im Supabase-SQL-Editor ausführen. Ohne dieses Skript läuft die App weiter, das Löschen bleibt
-- dann aber beim alten Verhalten stehen und meldet das auch (siehe DeckService.deleteDeck()).
--
-- =====================================================================================
-- ANLASS
-- =====================================================================================
--
-- match_players.deck_id ist ON DELETE SET NULL (am 21.09.2026 über pg_constraint geprüft:
-- confdeltype = 'n'). Ein gelöschtes Deck riss damit genau die Zuordnung weg, an der die halbe
-- Statistik hängt:
--
--   * deckStats() im Stats-Tab gruppiert über match_players.deck_id - der Deck-Eintrag samt Name
--     verschwand aus der Rangliste "Decks & Commander", die Partien tauchten stattdessen in der
--     Commander-Sammelzeile auf (und ohne eingetragenen Commander in GAR keiner Zeile mehr).
--   * Die Farb- und Combo-Auswertung der Gruppe überspringt Spieler ohne deck_id - diese Partien
--     fielen ersatzlos heraus.
--   * "Ausgeliehen von X", das Deck-Abzeichen im Match-Verlauf und die öffentlichen Ranglisten
--     (die decks per Join anhängen) verloren das Deck ebenfalls.
--
-- Gewollt ist: Wer sein Deck löscht, ändert damit KEINE Zahl in den Statistiken seiner Gruppen.
-- Was sich ändern darf, sind die deckbezogenen Auswertungen im eigenen Profil (meistgespielte
-- Karten, Lieblingsfarben je Deck) - die rechnen über deck_cards, und die Kartenliste ist weg.
--
-- =====================================================================================
-- DER ANSATZ - und warum das den Speicher NICHT vollaufen lässt
-- =====================================================================================
--
-- Der naheliegende Einwand gegen jedes weiche Löschen lautet "dann wird nie wieder Platz frei".
-- Die Messung vom 20.09.2026 (sql/datenbankgroesse-pruefen-2026-09-20.sql) beantwortet das:
--
--   ALLE echten App-Daten (decks, matches, players, Turniere)   ~7 MB von 398 MB   2 %
--
-- Platz kostet nicht die decks-Zeile, sondern die KARTENLISTE: deck_cards hat rund hundert Zeilen
-- je Deck, jede davon mit einer Bild-URL, dazu kommt der Änderungsverlauf. Genau das wird beim
-- Löschen weiterhin hart gelöscht. Stehen bleibt die decks-Zeile selbst - ein paar hundert Bytes,
-- die den Namen, den Besitzer, is_precon und color_identity tragen, also alles, was die
-- Statistiken per Join brauchen.
--
-- Zwei Spalten retten zusätzlich, was sonst nur in deck_cards stand: Name und Bild des Commanders,
-- damit die Rangliste ihr Kartenbild behält.
--
-- Decks OHNE eine einzige Partie werden weiterhin ganz gelöscht (siehe DeckService.deleteDeck()) -
-- es gibt dort nichts zu bewahren, und so entstehen Grabsteine nur da, wo sie Statistik tragen.
--
-- BEWUSST KEIN INDEX auf deleted_at: Die Deck-Listen filtern immer zusätzlich über user_id bzw.
-- player_id, die öffentliche Suche über is_private - dafür reichen die vorhandenen Indizes. Ein
-- eigener Index wäre hier genau der Fehler, der diese Datenbank schon zweimal an die 500-MB-Grenze
-- gebracht hat (siehe archidekt_deck_pool_cards und spellbook_combo_cards).
-- =====================================================================================

-- =====================================================================================
-- 1. Die drei Spalten
-- =====================================================================================
alter table public.decks
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_commander_name text,
  add column if not exists deleted_commander_image_url text;

comment on column public.decks.deleted_at is
  'Gesetzt = der Besitzer hat das Deck gelöscht ("Grabstein"): Kartenliste und Änderungsverlauf sind weg, die Zeile bleibt nur noch stehen, damit die Partien in match_players ihren Deck-Namen, Besitzer und ihre Farbidentität behalten. Solche Decks werden in Deck-Liste, Deck-Auswahl und öffentlicher Suche ausgeblendet, zählen in den Statistiken aber unverändert weiter.';
comment on column public.decks.deleted_commander_name is
  'Beim Löschen aus deck_cards gerettet - ohne diese Spalte hätte die Rangliste nach dem Löschen keinen Commander mehr zum Anzeigen.';
comment on column public.decks.deleted_commander_image_url is
  'Wie deleted_commander_name, für das Kartenbild in der Rangliste.';

-- =====================================================================================
-- 2. Die globale Deck-Rangliste holt das Commander-Bild aus deck_cards - für ein gelöschtes Deck
--    gibt es die Zeile nicht mehr. Einziger Unterschied zur Fassung aus
--    sql/global-stats-format-filter-2026-09-03.sql: das coalesce() auf die gerettete Spalte.
--
--    Die Filter bleiben unangetastet: Ein gelöschtes Deck zählt in den Ranglisten weiter mit -
--    genau darum geht es hier. Nur das Stöbern in Kartenlisten blendet es aus, und das entscheidet
--    die App (public-deck.service.ts), nicht diese Funktion.
-- =====================================================================================
create or replace function public.global_deck_commander_stats(
  p_modes text[] default null,
  p_formats text[] default null
)
returns table (
  bucket text,               -- 'deck' | 'commander'
  deck_id uuid,
  name text,                 -- Deck- oder Commander-Name
  commander_image_url text,
  games bigint,
  wins bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with deck_bucket as (
    select
      d.id as deck_id,
      d.name as deck_name,
      coalesce(
        (
          select dc.image_url from deck_cards dc
          where dc.deck_id = d.id and dc.is_commander and dc.image_url is not null
          limit 1
        ),
        d.deleted_commander_image_url
      ) as commander_image_url,
      count(*) filter (where m.counts_in_general_stats is distinct from false) as games,
      count(*) filter (
        where m.counts_in_general_stats is distinct from false and (
          case
            when m.game_mode = 'Two-Headed Giant' then mp.team is not null and mp.team = m.winner_name
            when m.game_mode = 'Archenemy' then
              case
                when m.winner_name = '__OTHERS__' then not coalesce(mp.is_archenemy, false)
                else p.display_name = m.winner_name
              end
            else p.display_name = m.winner_name
          end
        )
      ) as wins
    from decks d
    join match_players mp on mp.deck_id = d.id
    join matches m on m.id = mp.match_id
    join players p on p.id = mp.player_id
    where not d.is_private and not d.is_precon
      and (p_modes is null or m.game_mode = any(p_modes))
      and (p_formats is null or m.game_format = any(p_formats) or m.game_format is null)
    group by d.id, d.name, d.deleted_commander_image_url
  ),
  commander_bucket as (
    select
      mp.commander_name,
      count(*) filter (where m.counts_in_general_stats is distinct from false) as games,
      count(*) filter (
        where m.counts_in_general_stats is distinct from false and (
          case
            when m.game_mode = 'Two-Headed Giant' then mp.team is not null and mp.team = m.winner_name
            when m.game_mode = 'Archenemy' then
              case
                when m.winner_name = '__OTHERS__' then not coalesce(mp.is_archenemy, false)
                else p.display_name = m.winner_name
              end
            else p.display_name = m.winner_name
          end
        )
      ) as wins
    from match_players mp
    join matches m on m.id = mp.match_id
    join players p on p.id = mp.player_id
    left join decks d on d.id = mp.deck_id
    where mp.commander_name is not null
      and (mp.deck_id is null or (d.is_precon and not d.is_private))
      and (p_modes is null or m.game_mode = any(p_modes))
      and (p_formats is null or m.game_format = any(p_formats) or m.game_format is null)
    group by mp.commander_name
  )
  select 'deck', deck_id, deck_name, commander_image_url, games, wins
  from deck_bucket
  union all
  select
    'commander',
    null,
    commander_name,
    (
      select dc.image_url from deck_cards dc
      join decks d2 on d2.id = dc.deck_id
      where dc.card_name = commander_bucket.commander_name and dc.is_commander
        and dc.image_url is not null and not d2.is_private
      limit 1
    ),
    games,
    wins
  from commander_bucket;
$$;

revoke all on function public.global_deck_commander_stats(text[], text[]) from public;
grant execute on function public.global_deck_commander_stats(text[], text[]) to authenticated, anon;

-- =====================================================================================
-- 3. Gegenprobe nach dem Ausführen: Wie viele Grabsteine gibt es, und tragen sie noch Partien?
--    Direkt nach der Migration ist beides 0 - die Abfrage ist für später gedacht.
-- =====================================================================================
-- select
--   count(*) as grabsteine,
--   count(*) filter (where exists (select 1 from public.match_players mp where mp.deck_id = d.id)) as davon_mit_partien,
--   count(*) filter (where exists (select 1 from public.deck_cards dc where dc.deck_id = d.id)) as davon_mit_restkarten
-- from public.decks d
-- where d.deleted_at is not null;
