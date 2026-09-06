-- Grundlage für die Bracket-Einstufung von Commander-Decks: die Kriterien der offiziellen
-- Commander-Brackets brauchen drei Angaben, die es bei Scryfall NICHT gibt - welche Karten Mass
-- Land Denial betreiben, welche Extra-Turns geben und welche Tutoren sind - dazu die Liste der
-- Zwei-Karten-Combos. Alles vier pflegt Commander Spellbook, und ein nächtlicher Abgleich
-- (scripts/sync-spellbook-bracket.js, ausgelöst von .github/workflows/spellbook-sync.yml) legt es
-- hier ab. Im Supabase-Dashboard unter "SQL Editor" ausführen. Komplett idempotent (alle
-- "create table if not exists"/"create index if not exists"/"drop policy if exists" +
-- "create policy"-Paare sind gefahrlos mehrfach ausführbar).
--
-- Warum das nötig ist: Bisher fragt die App bei JEDEM Deck-Öffnen live Commander Spellbooks
-- /estimate-bracket an (commander-spellbook.service.ts über functions/api/estimate-bracket.ts).
-- Das ist ein Netzwerkaufruf pro Deck und pro Gerät, er scheitert regelmäßig genug, dass der
-- Service einen eigenen zweiten Versuch eingebaut hat, und für ein Bracket-Abzeichen in der
-- Deck-Liste oder im Match-Tab wäre es ein Aufruf PRO DECK - für acht Decks also acht Anfragen,
-- nur um ein paar Abzeichen zu zeichnen. Gleiche Ausgangslage wie beim Scryfall-Abgleich, gleiche
-- Antwort: einmal pro Nacht von EINEM Server holen (siehe sql/scryfall-cache-2026-09-06.sql).
--
-- Die Datenmenge ist dafür überraschend klein - nachgemessen an Spellbooks API:
--   64 Karten mit massLandDenial, 49 mit extraTurn, 86 mit tutor  ->  ~200 Zeilen
--   3.985 Zwei-Karten-Combos (alle mit Status "OK")
-- Game Changer, Banlist und Manabeträge kommen weiterhin aus scryfall_cards und werden hier
-- bewusst NICHT dupliziert.
--
-- Diese Tabellen enthalten AUSSCHLIESSLICH öffentliche Kartendaten von Commander Spellbook,
-- keinerlei Nutzerdaten. Sie sind deshalb - wie die Scryfall-Tabellen - für jeden lesbar (auch
-- ohne Login) und für niemanden schreibbar. Der Nachtlauf schreibt mit dem Service-Role-Key, der
-- RLS ohnehin umgeht.

-- =====================================================================================
-- 1. Kartenmarkierungen (~200 Zeilen)
--
--    Bewusst NUR Karten, bei denen mindestens eines der drei Flags gesetzt ist. Spellbooks
--    Kartentabelle hat 8.119 Einträge; die restlichen ~7.900 mit lauter "false" abzulegen würde
--    die Tabelle vierzigfach aufblähen, ohne eine einzige Frage zu beantworten - "steht der Name
--    nicht drin" heißt schlicht "kein Flag".
--
--    Wichtig zur Abdeckung: Spellbooks Kartentabelle ist kuratiert und NICHT auf Combo-Teile
--    beschränkt. Nachgeprüft: Armageddon, Jokulhaups, Winter Orb und Ruination stehen alle mit
--    massLandDenial drin, obwohl sie in keiner Zwei-Karten-Combo vorkommen.
-- =====================================================================================
create table if not exists public.spellbook_card_flags (
  name_normalized text primary key,
  mass_land_denial boolean not null default false,
  extra_turn boolean not null default false,
  tutor boolean not null default false,
  synced_at timestamptz not null default now()
);

comment on table public.spellbook_card_flags is
  'Kuratierte Kartenmarkierungen von Commander Spellbook (/cards/), täglich abgeglichen von scripts/sync-spellbook-bracket.js. Nur Karten mit mindestens einem gesetzten Flag - fehlender Name heisst "kein Flag". Nur oeffentliche Kartendaten, keine Nutzerdaten.';
comment on column public.spellbook_card_flags.name_normalized is
  'Kartenname VOR " // ", durch normalizeCardName() (array-utils.ts) geschickt - derselbe Schluessel wie scryfall_cards.front_name_normalized, damit beide Tabellen ueber denselben Namen zusammenfinden.';
comment on column public.spellbook_card_flags.tutor is
  'Ersetzt die Regex-Naeherung in DeckViewerService.tutorCards() - der offizielle Bracket-Wortlaut meint Tutoren ausser fuer Laender, und genau so ist Spellbooks Liste gepflegt.';

-- =====================================================================================
-- 2. Zwei-Karten-Combos (~3.985 Zeilen)
--
--    Nur Varianten mit genau zwei Karten (Spellbook-Suche "cards=2"): das offizielle
--    Bracket-Kriterium redet ausdrücklich von ZWEI-Karten-Combos, und alles Größere ist für die
--    Einstufung ohnehin unerheblich. Damit schrumpfen 108.535 Varianten auf 3.985.
--
--    bracket_tag ist Spellbooks eigene Note FÜR DIESE COMBO (R/S/P/O/C/E/B). Auf Combo-Ebene ist
--    diese Skala richtig und aussagekräftig - sie bewertet, wie schnell und brutal die Combo ist.
--    (Dieselbe Skala aufs ganze DECK angewandt ist dagegen irreführend: /estimate-bracket liefert
--    für 98 Gebirge plus ein Armageddon ein "R". Sie beschreibt dort nur das stärkste gefundene
--    Einzelelement, nicht die Deckstärke.)
-- =====================================================================================
create table if not exists public.spellbook_two_card_combos (
  id text primary key,
  card_a_normalized text not null,
  card_b_normalized text not null,
  a_must_be_commander boolean not null default false,
  b_must_be_commander boolean not null default false,
  mana_value_needed smallint,
  bracket_tag text,
  popularity integer,
  synced_at timestamptz not null default now()
);

comment on table public.spellbook_two_card_combos is
  'Zwei-Karten-Combos von Commander Spellbook (/variants/?q=cards=2, nur Status OK), taeglich abgeglichen von scripts/sync-spellbook-bracket.js.';
comment on column public.spellbook_two_card_combos.bracket_tag is
  'Spellbooks Note FUER DIESE COMBO: R ruthless, S spicy, P powerful, O oddball, C core, E exhibition, B enthaelt gesperrte Karte. Bewertet Tempo und Haerte der Combo - nicht das Deck.';
comment on column public.spellbook_two_card_combos.a_must_be_commander is
  'true = die Combo zaehlt nur, wenn diese Karte der Commander ist (Spellbook: mustBeCommander). 42 der Combos haben das.';
comment on column public.spellbook_two_card_combos.mana_value_needed is
  'Zusaetzlich noetiges Mana, um die Combo abzuschliessen (Spellbook: manaValueNeeded) - zusammen mit den Manabetraegen beider Karten die Naeherung fuer "kommt sie frueh oder spaet online".';

-- Nachgeschlagen wird "welche Combos betreffen diese Kartennamen?" - über beide Spalten getrennt,
-- weil die Reihenfolge in der Quelle beliebig ist.
create index if not exists spellbook_two_card_combos_a_idx
  on public.spellbook_two_card_combos (card_a_normalized);
create index if not exists spellbook_two_card_combos_b_idx
  on public.spellbook_two_card_combos (card_b_normalized);

-- =====================================================================================
-- 3. Zustand des Nachtlaufs
--
--    Bewusst eine EIGENE Tabelle statt einer weiteren Zeile in scryfall_sync_state: dort
--    Spellbook-Zeilen unterzubringen wäre genau die Art irreführender Benennung, die beim
--    nächsten Nachschlagen Zeit kostet ("warum steht Spellbook in der Scryfall-Tabelle?").
--    Aufbau und Zweck sind ansonsten identisch: im Dashboard mit einem Blick sehen, ob und wann
--    der Abgleich zuletzt lief und wie viele Zeilen dabei herauskamen.
-- =====================================================================================
create table if not exists public.spellbook_sync_state (
  id text primary key,
  synced_at timestamptz not null default now(),
  row_count integer not null default 0
);

comment on table public.spellbook_sync_state is
  'Letzter Stand des Commander-Spellbook-Abgleichs je Datenart. id ist "card_flags" oder "two_card_combos".';

-- =====================================================================================
-- 4. RLS: für jeden lesbar, für niemanden schreibbar
--
--    Ohne "enable row level security" wären die Tabellen über den öffentlichen Anon-Key auch
--    BESCHREIBBAR - deshalb ist RLS hier zwingend, obwohl die Daten selbst öffentlich sind. Es
--    gibt bewusst nur eine select-Policy: fehlt für insert/update/delete jede Policy, verweigert
--    RLS sie grundsätzlich. Der Nachtlauf ist davon nicht betroffen, er nutzt den
--    Service-Role-Key (umgeht RLS).
-- =====================================================================================
alter table public.spellbook_card_flags enable row level security;
alter table public.spellbook_two_card_combos enable row level security;
alter table public.spellbook_sync_state enable row level security;

drop policy if exists "Spellbook card flags are readable by anyone" on public.spellbook_card_flags;
create policy "Spellbook card flags are readable by anyone"
on public.spellbook_card_flags
for select
to public
using (true);

drop policy if exists "Spellbook combos are readable by anyone" on public.spellbook_two_card_combos;
create policy "Spellbook combos are readable by anyone"
on public.spellbook_two_card_combos
for select
to public
using (true);

drop policy if exists "Spellbook sync state is readable by anyone" on public.spellbook_sync_state;
create policy "Spellbook sync state is readable by anyone"
on public.spellbook_sync_state
for select
to public
using (true);
