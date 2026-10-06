-- Partie-Ergebnis (Siegart, Zug, Notiz) und Deck-Versionen für die Performance-Auswertung.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Alles optional und am Tisch in Sekunden erfasst: Der Sieger-Dialog des Trackers bietet Siegart,
-- Zug und Notiz an, niemand muss sie ausfüllen. Ausgewertet wird nur, was eingetragen wurde -
-- eine Partie ohne Zug zählt im Zug-Schnitt gar nicht, nicht als Zug 0 (match-insights.ts).
--
--   * matches.win_condition - wie die Partie gewonnen wurde: combat, combo, commander_damage,
--                             mill, other. null = unbekannt (nicht eingetragen, ältere Partie,
--                             Unentschieden). Wird nie geraten.
--   * matches.win_turn      - in welchem Zug die Partie endete (1-99). null = unbekannt.
--   * matches.note          - freie Notiz, höchstens 500 Zeichen.
--
--   * decks.version              - laufende Versionsnummer des Decks, Start 1. Erhöht nur der
--                                  Besitzer beim Speichern einer geänderten Kartenliste, wenn er
--                                  die Frage "als neue Version zählen?" bejaht.
--   * match_players.deck_version - die Version des Decks, als die Partie gespeichert wurde. Setzt
--                                  der Trigger unten selbst, der Client schickt sie nicht mit.
--                                  null = Partie von vor dieser Migration (bzw. ohne Deck) - die
--                                  App zeigt sie als "ältere Partien ohne Version", statt sie
--                                  stillschweigend Version 1 zuzuschlagen.
--
-- Keine neue RLS-Policy: Lesen und Schreiben folgen den bestehenden Regeln von matches,
-- match_players und decks. Fehlt die Migration, speichert und lädt die App wie bisher ohne diese
-- Angaben (42703/PGRST204, siehe performanceVerfuegbar in mtg.service.ts).

alter table public.matches
  add column if not exists win_condition text,
  add column if not exists win_turn smallint,
  add column if not exists note text;

alter table public.matches drop constraint if exists matches_win_condition_check;
alter table public.matches
  add constraint matches_win_condition_check
  check (win_condition is null or win_condition in ('combat', 'combo', 'commander_damage', 'mill', 'other'));

alter table public.matches drop constraint if exists matches_win_turn_check;
alter table public.matches
  add constraint matches_win_turn_check check (win_turn is null or win_turn between 1 and 99);

alter table public.matches drop constraint if exists matches_note_length_check;
alter table public.matches
  add constraint matches_note_length_check check (note is null or char_length(note) <= 500);

comment on column public.matches.win_condition is
  'Siegart (combat, combo, commander_damage, mill, other); null = unbekannt.';
comment on column public.matches.win_turn is 'Zug, in dem die Partie endete; null = unbekannt.';
comment on column public.matches.note is 'Freie Notiz zur Partie (optional, max. 500 Zeichen).';

alter table public.decks
  add column if not exists version integer not null default 1;

alter table public.decks drop constraint if exists decks_version_check;
alter table public.decks add constraint decks_version_check check (version >= 1);

comment on column public.decks.version is
  'Laufende Deck-Version (Start 1), vom Besitzer beim Speichern einer Änderung erhöht.';

alter table public.match_players
  add column if not exists deck_version integer;

comment on column public.match_players.deck_version is
  'Version des Decks beim Speichern der Partie (Trigger); null = vor der Versionierung bzw. ohne Deck.';

-- Die Version kommt aus der Datenbank, nicht vom Client: Wer ein fremdes Deck leiht, sieht dessen
-- decks-Zeile womöglich gar nicht (privates Deck) - deshalb SECURITY DEFINER, und deshalb liest
-- die Funktion nichts außer der einen Zahl.
create or replace function public.match_players_deck_version_setzen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deck_id is not null and new.deck_version is null then
    select d.version into new.deck_version from public.decks d where d.id = new.deck_id;
  end if;
  return new;
end;
$$;

drop trigger if exists match_players_deck_version_setzen on public.match_players;
create trigger match_players_deck_version_setzen
  before insert on public.match_players
  for each row execute function public.match_players_deck_version_setzen();
