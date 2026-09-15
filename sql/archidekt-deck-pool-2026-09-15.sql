-- Eigene Deck-Datenbank für Auswertungen: von Archidekt importierte Commander-Decks samt der
-- Bracket-Stufe, die ihr Ersteller selbst angegeben hat. Gefüllt von
-- scripts/import-archidekt-decks.js (manuell ausgelöst über
-- .github/workflows/archidekt-import.yml). Im Supabase-Dashboard unter "SQL Editor" ausführen.
-- Komplett idempotent (alle "create table if not exists"/"create index if not exists"/
-- "drop policy if exists" + "create policy"-Paare sind gefahrlos mehrfach ausführbar).
--
-- Wozu das gut ist: Um die eigene Bracket-Einstufung (src/app/bracket.ts) gegen die Realität zu
-- prüfen, braucht es Decks, bei denen jemand anders die Stufe festgelegt hat. Archidekt hat
-- genau das - ein Feld edhBracket, das der Deck-Besitzer selbst setzt - und lässt sich danach
-- filtern. Ein Vorrat solcher Decks pro Stufe ist die Referenz, gegen die sich die eigene
-- Rechnung später messen lässt ("wir sagen 3, der Ersteller sagt 4 - wer liegt daneben?").
--
-- WARUM DAS EINE EIGENE TABELLE IST UND NICHT decks:
-- Das sind FREMDE Decks, die niemandem in dieser App gehören. Sie dürfen nirgends auftauchen, wo
-- Decks von Spielern erscheinen - nicht in der Deck-Liste, nicht in der Deck-Auswahl im
-- Match-Tab, nicht im öffentlichen Deck-Browser, nicht in Statistiken. Deshalb stehen sie
-- bewusst in einer getrennten Tabelle ohne jede Verbindung zu decks/deck_cards und ohne
-- owner-Spalte: Es gibt gar keinen Weg, auf dem public-deck-browse-2026-08-26.sql oder
-- deck-public-stats-function-2026-08-30.sql hier hineinsehen könnten. Eine zusätzliche Spalte in
-- decks wäre der falsche Weg gewesen - jede bestehende Abfrage hätte sie ab sofort
-- mitberücksichtigen (und damit ausschließen) müssen.
--
-- SICHTBARKEIT: nur für Developer (profiles.is_developer über die Helper-Funktion
-- public.is_developer(), siehe sql/roles-permissions-2026-09-01.sql). Kein anderer Spieler sieht
-- diese Zeilen, auch nicht lesend. Das Import-Skript schreibt mit dem Service-Role-Key, der RLS
-- ohnehin umgeht - die Policies hier sind ausschließlich dafür da, dass der Developer den Vorrat
-- in der App bzw. im Dashboard ansehen und aufräumen kann.
--
-- Die Daten selbst sind öffentliche Decklisten von Archidekt. Bewusst NICHT mit importiert werden
-- Nutzerdaten (Kommentare, Besitzer-Profile) - nur der Anzeigename des Besitzers, damit ein Deck
-- bei Bedarf wiederzufinden ist.

-- =====================================================================================
-- 1. Die Decks.
--
--    Eine Zeile je importiertes Deck. Der Commander steht als Textliste direkt hier drin
--    (commander_names) und NICHT nur als Zeile in der Kartentabelle: Die Frage "was ist der
--    Commander dieses Decks" muss ohne Join beantwortbar sein, sonst ist die Tabelle im
--    Supabase-Table-Editor nicht lesbar - und die Lesbarkeit ist bei einem Vorrat, den man von
--    Hand stichprobenartig prüft, keine Nebensache. Partner/Hintergrund erlauben zwei Einträge,
--    darum ein Array.
--
--    ZWEI SPERREN GEGEN DOPPELTE DECKS, beide als unique constraint - nicht als Prüfung im
--    Skript, denn nur die Datenbank kann das zuverlässig garantieren:
--
--      archidekt_id  - dasselbe Archidekt-Deck kommt nie zweimal herein.
--      cards_hash    - dieselbe KARTENLISTE kommt nie zweimal herein, auch wenn sie unter einer
--                      anderen Archidekt-ID und einem anderen Namen hochgeladen wurde. Das ist
--                      der Fall, der die späteren Auswertungen verfälschen würde: Eine populäre
--                      Netdeck-Liste liegt auf Archidekt hundertfach kopiert herum, und hundert
--                      identische Listen im Vorrat wären hundertfaches Gewicht für eine einzige
--                      Deckidee. Der Hash deckt Karten + Mengen + Commander ab, nicht den Namen
--                      und nicht die Reihenfolge (Details: scripts/import-archidekt-decks.js).
-- =====================================================================================
create table if not exists public.archidekt_deck_pool (
  id uuid primary key default gen_random_uuid(),
  archidekt_id bigint not null unique,
  name text not null,
  commander_names text[] not null,
  creator_bracket smallint not null check (creator_bracket between 1 and 5),
  card_count smallint not null,
  cards_hash text not null unique,
  owner_username text,
  view_count integer,
  archidekt_updated_at timestamptz,
  imported_at timestamptz not null default now()
);

comment on table public.archidekt_deck_pool is
  'Von Archidekt importierte fremde Commander-Decks als Referenzvorrat für die Bracket-Auswertung. Nur für Developer sichtbar, bewusst getrennt von decks - das sind keine Decks von Spielern dieser App und sie dürfen nirgends als solche erscheinen.';
comment on column public.archidekt_deck_pool.creator_bracket is
  'Bracket 1-5, wie der Ersteller es auf Archidekt SELBST angegeben hat (Feld edhBracket). Das ist der Vergleichswert, kein berechneter - entspricht dem manual-Fall in src/app/bracket.ts, nicht bracketAuto.';
comment on column public.archidekt_deck_pool.commander_names is
  'Commander als Textliste, damit die Tabelle ohne Join lesbar ist. Zwei Einträge bei Partner/Hintergrund.';
comment on column public.archidekt_deck_pool.cards_hash is
  'sha256 über die sortierte Kartenliste (Menge + normalisierter Name + Commander-Kennzeichen). Zweite Duplikatsperre: verhindert dieselbe Liste unter anderer Archidekt-ID.';
comment on column public.archidekt_deck_pool.card_count is
  'Summe der Mengen, Commander eingerechnet. Das Skript nimmt nur 100 oder 101 (101 = Partner/Hintergrund) auf.';

create index if not exists archidekt_deck_pool_bracket_idx
  on public.archidekt_deck_pool (creator_bracket);

-- =====================================================================================
-- 2. Die Karten der Decks.
--
--    Eine Zeile je Karte. name_normalized ist der Schlüssel, mit dem sich das Deck auf
--    scryfall_cards.front_name_normalized joinen lässt - ohne den ist die Bracket-Berechnung
--    später nicht rechenbar, denn alles, was src/app/bracket.ts braucht (Game Changer, Tutoren,
--    Mass Land Denial, Combos), hängt an diesem Schlüssel. Die Normalisierung muss deshalb exakt
--    normalizeCardName() aus src/app/array-utils.ts entsprechen; das Skript erklärt, wie.
--
--    Der Primärschlüssel (deck_id, name_normalized) erzwingt eine Zeile je Karte und Deck. Das
--    Skript fasst Mengen vorher zusammen, weil Archidekt dieselbe Karte in zwei Kategorien als
--    zwei Einträge führen kann.
-- =====================================================================================
create table if not exists public.archidekt_deck_pool_cards (
  deck_id uuid not null references public.archidekt_deck_pool (id) on delete cascade,
  name_normalized text not null,
  name text not null,
  quantity smallint not null check (quantity > 0),
  is_commander boolean not null default false,
  primary key (deck_id, name_normalized)
);

comment on table public.archidekt_deck_pool_cards is
  'Kartenlisten der Decks aus archidekt_deck_pool. Über name_normalized auf scryfall_cards.front_name_normalized joinbar.';
comment on column public.archidekt_deck_pool_cards.name_normalized is
  'Schlüssel für den Join auf scryfall_cards.front_name_normalized - muss exakt normalizeCardName() aus src/app/array-utils.ts entsprechen (Kleinschreibung, Apostroph-Varianten vereinheitlicht, Name VOR " // ").';
comment on column public.archidekt_deck_pool_cards.name is
  'Kartenname wie auf Archidekt, inklusive " // " bei doppelseitigen Karten - für die Lesbarkeit von Hand.';

create index if not exists archidekt_deck_pool_cards_name_idx
  on public.archidekt_deck_pool_cards (name_normalized);

-- =====================================================================================
-- 3. Eine lesbare Ansicht.
--
--    Damit im Supabase-Table-Editor auf einen Blick sichtbar ist, was im Vorrat liegt: Deckname,
--    Commander, Bracket des Erstellers und die Kartenliste als ein Textfeld. Genau die vier
--    Angaben, um die es bei diesem Vorrat geht, ohne dass man zwei Tabellen nebeneinander
--    aufmachen muss. Für Auswertungen sind die Tabellen darunter gedacht, nicht diese Ansicht.
--
--    security_invoker sorgt dafür, dass die Ansicht mit den Rechten des Aufrufers läuft und die
--    RLS-Policies unten also auch hier greifen - ohne das wäre sie ein Loch in der Sichtbarkeit.
-- =====================================================================================
create or replace view public.archidekt_deck_pool_readable
with (security_invoker = true) as
select
  d.archidekt_id,
  d.name,
  array_to_string(d.commander_names, ' + ') as commander,
  d.creator_bracket,
  d.card_count,
  'https://archidekt.com/decks/' || d.archidekt_id as archidekt_url,
  (
    select string_agg(c.quantity || ' ' || c.name, E'\n' order by c.is_commander desc, c.name)
    from public.archidekt_deck_pool_cards c
    where c.deck_id = d.id
  ) as decklist,
  d.owner_username,
  d.imported_at
from public.archidekt_deck_pool d;

comment on view public.archidekt_deck_pool_readable is
  'Lesbare Ansicht auf archidekt_deck_pool: Name, Commander, Bracket des Erstellers und Kartenliste als Text. Läuft mit den Rechten des Aufrufers (security_invoker), also nur für Developer sichtbar.';

-- =====================================================================================
-- 4. Sichtbarkeit: ausschließlich Developer.
--
--    Alle vier Rechte einzeln, weil der Developer den Vorrat auch aufräumen können muss (ein
--    falsch eingestuftes oder kaputtes Deck löschen). Kein "to public"-select wie bei den
--    Scryfall-/Spellbook-Tabellen: Das sind keine Kartendaten, die jeder braucht, sondern ein
--    Arbeitsvorrat, der andere Spieler nichts angeht.
-- =====================================================================================
alter table public.archidekt_deck_pool enable row level security;
alter table public.archidekt_deck_pool_cards enable row level security;

drop policy if exists "Developers can read the archidekt deck pool" on public.archidekt_deck_pool;
create policy "Developers can read the archidekt deck pool"
on public.archidekt_deck_pool
for select
to authenticated
using (is_developer(auth.uid()));

drop policy if exists "Developers can write the archidekt deck pool" on public.archidekt_deck_pool;
create policy "Developers can write the archidekt deck pool"
on public.archidekt_deck_pool
for all
to authenticated
using (is_developer(auth.uid()))
with check (is_developer(auth.uid()));

drop policy if exists "Developers can read the archidekt deck pool cards" on public.archidekt_deck_pool_cards;
create policy "Developers can read the archidekt deck pool cards"
on public.archidekt_deck_pool_cards
for select
to authenticated
using (is_developer(auth.uid()));

drop policy if exists "Developers can write the archidekt deck pool cards" on public.archidekt_deck_pool_cards;
create policy "Developers can write the archidekt deck pool cards"
on public.archidekt_deck_pool_cards
for all
to authenticated
using (is_developer(auth.uid()))
with check (is_developer(auth.uid()));
