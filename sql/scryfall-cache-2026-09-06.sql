-- Grundlage für den eigenen Kartendatenbestand: statt dass JEDER Nutzer bei JEDEM Deck-Öffnen
-- live bei Scryfall nachfragt, füllt ein nächtlicher Abgleich (scripts/sync-scryfall-bulk.js,
-- ausgelöst von .github/workflows/scryfall-sync.yml) diese Tabellen einmal pro Tag. Im
-- Supabase-Dashboard unter "SQL Editor" ausführen. Komplett idempotent (alle
-- "create table if not exists"/"create index if not exists"/"drop policy if exists" +
-- "create policy"-Paare sind gefahrlos mehrfach ausführbar).
--
-- Warum das nötig ist: Die Analyse-Kacheln der Deck-Ansicht (EFFECT_TAG_CATEGORIES in
-- deck-viewer.service.ts) lösen über ScryfallService.classifyCards() rund 100 aufeinander
-- folgende Suchanfragen pro Deck aus - 12 Kategorien, je in Chunks von ~15 Kartennamen, mit
-- 300 ms Zwangspause dazwischen. Das dauert etwa eine Minute, passiert bei jedem neuen Nutzer und
-- auf jedem neuen Gerät erneut (der bisherige Cache liegt im localStorage) und kratzt an Scryfalls
-- Rate-Limit - siehe die Kommentare an ScryfallService.fetchWithRetry() und classifyCards().
-- Scryfall selbst verweist für solche Mengen ausdrücklich auf seine Bulk-Daten.
--
-- Diese Tabellen enthalten AUSSCHLIESSLICH öffentliche Kartendaten von Scryfall, keinerlei
-- Nutzerdaten. Sie sind deshalb bewusst für jeden lesbar (auch ohne Login, passend zum Such-Tab,
-- der laut search-tab.ts account-frei nutzbar sein soll) - aber für niemanden schreibbar. Der
-- Nachtlauf schreibt mit dem Service-Role-Key, der RLS ohnehin umgeht.

-- =====================================================================================
-- 1. Kartendaten (eine Zeile je Oracle-ID, ~33.000 Stück)
--
--    Bewusst NUR die Felder, die ScryfallService.toCard() tatsächlich in ein ScryfallCard-Objekt
--    übernimmt - ein vollständiges Scryfall-Kartenobjekt ist rund 4,8 kB groß, die hier genutzte
--    Teilmenge rund 1 kB. Bei ~33.000 Karten ist das der Unterschied zwischen ~160 MB und ~50 MB,
--    und der Supabase-Free-Tarif hat insgesamt 500 MB.
--
--    Marken/Embleme (layout token/double_faced_token/emblem/art_series) überspringt das
--    Sync-Skript bewusst: ihre Namen kollidieren mit echten Karten ("Wizard", "Zombie", ...), und
--    die App lädt sie ohnehin nie über den Namen, sondern über Druck-IDs aus all_parts
--    (ScryfallService.findCardsByIds()) - dafür ist diese Oracle-ID-Tabelle nicht die Quelle.
-- =====================================================================================
create table if not exists public.scryfall_cards (
  oracle_id uuid primary key,
  name text not null,
  front_name_normalized text not null,
  type_line text,
  cmc real,
  mana_cost text,
  color_identity text[] not null default '{}',
  produced_mana text[],
  game_changer boolean not null default false,
  oracle_text text,
  keywords text[] not null default '{}',
  image_url text,
  back_image_url text,
  back_type_line text,
  all_parts jsonb,
  synced_at timestamptz not null default now()
);

comment on table public.scryfall_cards is
  'Kartendaten aus Scryfalls oracle_cards-Bulk-Datei, täglich abgeglichen von scripts/sync-scryfall-bulk.js. Nur öffentliche Kartendaten, keine Nutzerdaten.';
comment on column public.scryfall_cards.front_name_normalized is
  'Kartenname VOR " // ", durch normalizeCardName() (array-utils.ts) geschickt - exakt der Schlüssel, unter dem die App Karten nachschlägt (siehe ScryfallService.findCardsBulk()).';
comment on column public.scryfall_cards.all_parts is
  'Scryfalls related_cards - die App liest daraus nur die Marken (component "token") für den Marken-Scan.';

-- Der Nachschlage-Weg der App ist IMMER der normalisierte Vorderseiten-Name, nie die Oracle-ID.
create index if not exists scryfall_cards_front_name_idx
  on public.scryfall_cards (front_name_normalized);

-- =====================================================================================
-- 2. Effekt-Kategorien (Removal, Konter, Boardwipes, ... - ~23.000 Zeilen über 12 Kategorien)
--
--    WICHTIG, warum hier Namen und keine Tags stehen: Scryfalls otag:-Suche ist HIERARCHISCH -
--    eine Karte mit einem Unter-Tag matcht auch das Eltern-Tag ("otag:board-wipe -otag:removal"
--    liefert null Treffer). Zusätzlich sind nicht alle 12 Kategorien reine Tag-Abfragen: es gibt
--    auch "o:create o:token" (Oracle-Text), "keyword:proliferate" und "-t:land". Beides in SQL
--    nachzubauen wären zwei stille Fehlerquellen, die die Kachel-Zahlen nach unten ziehen, ohne
--    dass es jemandem auffällt.
--
--    Deshalb legt das Sync-Skript hier das ERGEBNIS von Scryfalls eigener Suche ab: es schickt
--    die 12 Query-Strings aus EFFECT_TAG_CATEGORIES wörtlich an Scryfall und speichert, welche
--    Karten getroffen wurden. Gleiche Abfrage, gleiche Semantik, garantiert gleiche Zahlen -
--    nur eben 139 Anfragen pro Nacht von EINEM Server statt ~100 pro Deck-Öffnung pro Nutzer.
-- =====================================================================================
create table if not exists public.scryfall_card_effects (
  category text not null,
  front_name_normalized text not null,
  primary key (category, front_name_normalized)
);

comment on table public.scryfall_card_effects is
  'Welche Karte in welche Effekt-Kategorie fällt - Ergebnis der 12 Abfragen aus EFFECT_TAG_CATEGORIES (deck-viewer.service.ts), nächtlich abgeglichen. category entspricht dem dortigen key ("removal", "counterspell", ...).';

-- Die App fragt immer "welche Kategorien haben DIESE Kartennamen?", nie "welche Karten hat diese
-- Kategorie?" - der Primärschlüssel beginnt aber mit category und hilft dafür nicht.
create index if not exists scryfall_card_effects_name_idx
  on public.scryfall_card_effects (front_name_normalized);

-- =====================================================================================
-- 3. Zustand des Nachtlaufs
--
--    Zwei Zwecke: Erstens ist im Dashboard mit einem Blick sichtbar, ob und wann der Abgleich
--    zuletzt lief. Zweitens vergleicht das Sync-Skript source_updated_at mit dem updated_at aus
--    Scryfalls /bulk-data-Antwort und lädt die 24-MB-Datei gar nicht erst herunter, wenn sich
--    nichts geändert hat - genau das erwartet Scryfall von Bulk-Nutzern.
-- =====================================================================================
create table if not exists public.scryfall_sync_state (
  id text primary key,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  row_count integer not null default 0
);

comment on table public.scryfall_sync_state is
  'Letzter Stand des Scryfall-Abgleichs je Datenart. id ist "cards" oder "effects".';
comment on column public.scryfall_sync_state.source_updated_at is
  'updated_at des Scryfall-Bulk-Eintrags, gegen den zuletzt abgeglichen wurde - nur für "cards" gesetzt, "effects" kommt aus der Suche und hat keine solche Angabe.';

-- =====================================================================================
-- 4. RLS: für jeden lesbar, für niemanden schreibbar
--
--    Ohne "enable row level security" wäre die Tabelle über den öffentlichen Anon-Key auch
--    BESCHREIBBAR - deshalb ist RLS hier zwingend, obwohl die Daten selbst öffentlich sind. Es
--    gibt bewusst nur eine select-Policy: fehlt für insert/update/delete jede Policy, verweigert
--    RLS sie grundsätzlich. Der Nachtlauf ist davon nicht betroffen, er nutzt den
--    Service-Role-Key (umgeht RLS).
-- =====================================================================================
alter table public.scryfall_cards enable row level security;
alter table public.scryfall_card_effects enable row level security;
alter table public.scryfall_sync_state enable row level security;

drop policy if exists "Scryfall cards are readable by anyone" on public.scryfall_cards;
create policy "Scryfall cards are readable by anyone"
on public.scryfall_cards
for select
to public
using (true);

drop policy if exists "Scryfall card effects are readable by anyone" on public.scryfall_card_effects;
create policy "Scryfall card effects are readable by anyone"
on public.scryfall_card_effects
for select
to public
using (true);

drop policy if exists "Scryfall sync state is readable by anyone" on public.scryfall_sync_state;
create policy "Scryfall sync state is readable by anyone"
on public.scryfall_sync_state
for select
to public
using (true);
