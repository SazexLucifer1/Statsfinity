-- Grundlage für ein EIGENES Empfehlungssystem: ein eigener Bestand an legalen Commander-Decks
-- ("Deck-Korpus"), aus dem sich die Zahlen selbst rechnen lassen, die die Vorschlagsliste im
-- Bearbeiten-Modus heute live von EDHREC holt. Im Supabase-Dashboard unter "SQL Editor"
-- ausführen. Komplett idempotent (alle "create table if not exists"/"create index if not exists"/
-- "drop policy if exists" + "create policy"-Paare sind gefahrlos mehrfach ausführbar).
--
-- Warum das nötig ist: src/app/edhrec.service.ts fragt für jeden angesehenen Commander EDHRECs
-- eigenes Seiten-JSON ab. Die Erlaubnis von EDHREC deckt das Anzeigen ab, nicht aber, mit ihren
-- Daten ein konkurrierendes Angebot zu bauen. Ein eigenes Empfehlungssystem braucht deshalb
-- eigene Decks - und die knapp zwei Dutzend Nutzer dieser App liefern dafür keine Grundlage.
--
-- Der Aufbau ist zweistufig:
--
--   1. ROHDECKS liegen NICHT hier, sondern als gepackte JSONL-Dateien im Storage-Bucket
--      "deck-corpus" (scripts/import-deck-corpus.js). Grund ist der Platz: Der Free-Tarif hat
--      500 MB Datenbank, davon sind ~50 MB von scryfall_cards belegt; Storage hat sein eigenes
--      1-GB-Kontingent. Eine Deckzeile wiegt gepackt rund 0,4 kB, 300.000 Decks also ~120 MB -
--      in der Datenbank wäre das der halbe Tarif, im Bucket ein Achtel.
--
--   2. Das AGGREGAT (deck_corpus_commanders/_commander_cards/_card_baseline) rechnet
--      scripts/aggregate-deck-corpus.js aus diesen Dateien und legt es hier ab. Nur dieses
--      Aggregat liest die App später - nie die Rohdecks.
--
-- Der Bucket ist bewusst PRIVAT. Die Rohdecks stammen von fremden Seiten; sie werden hier
-- ausgewertet, aber nicht weiterverbreitet. Öffentlich sichtbar sind ausschließlich die selbst
-- gerechneten Aggregatzahlen - das ist derselbe Umgang, den auch die Nutzungsbedingungen der
-- Quellen erwarten.
--
-- Hinweis zum Stand: Die Archidekt-Quelle des Import-Skripts ist fertig, wird aber erst
-- angeworfen, wenn von dort eine Erlaubnis vorliegt (siehe ARCHIDEKT-ANFRAGE.md im
-- Projektwurzelverzeichnis). Bis dahin füllen nur die MTGJSON-Precons und die eigenen
-- öffentlichen Decks den Korpus.

-- =====================================================================================
-- 1. Storage-Bucket für die Rohdecks
--
--    public = false, und es werden bewusst KEINE storage.objects-Policies für anon/authenticated
--    angelegt: Ohne Policy verweigert RLS den Zugriff grundsätzlich, damit kommen nur das
--    Import-/Aggregations-Skript mit dem Service-Role-Key an die Dateien.
-- =====================================================================================
insert into storage.buckets (id, name, public)
values ('deck-corpus', 'deck-corpus', false)
on conflict (id) do nothing;

-- =====================================================================================
-- 2. Lauf-Interna: wo steht der Import, welche Dateien gehören zum Korpus, was ist schon geholt
--
--    Diese drei Tabellen sind KEINE öffentlichen Daten - sie bekommen unten RLS ohne jede Policy
--    und sind damit für den Anon-Key komplett unsichtbar. Im Dashboard sind sie trotzdem lesbar
--    (dort gilt der Service-Role-Key), und genau dafür sind sie gedacht.
-- =====================================================================================

-- Ein Import über hunderttausend Decks passt in keinen einzelnen Actions-Lauf (6-Stunden-Limit).
-- Deshalb merkt sich jede Quelle hier, wie weit sie gekommen ist; der nächste Lauf macht dort
-- weiter, statt von vorn anzufangen.
create table if not exists public.deck_corpus_state (
  id text primary key,
  cursor text,
  chunk_index integer not null default 0,
  deck_count integer not null default 0,
  checked_count integer not null default 0,
  rejects jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);

comment on table public.deck_corpus_state is
  'Fortschritt des Deck-Korpus-Imports je Quelle. id ist "archidekt", "statsfinity" oder "precon".';
comment on column public.deck_corpus_state.cursor is
  'Quellenabhängige Fortsetzmarke - bei Archidekt die zuletzt VOLLSTÄNDIG verarbeitete Listenseite.';
comment on column public.deck_corpus_state.chunk_index is
  'Nummer der nächsten zu schreibenden Datei im Bucket - fortlaufend über alle Läufe hinweg, damit ein neuer Lauf keine Datei des vorigen überschreibt.';
comment on column public.deck_corpus_state.rejects is
  'Verwerfungsgründe des Torwächters mit Anzahl (z.B. {"nicht100Karten": 2100, "falschesFormat": 1800}). Wichtigste Kontrollanzeige: kippt eine einzelne Zahl plötzlich auf fast alles, hat sich die Antwortform der Quelle geändert.';

-- Die Aggregation liest AUSSCHLIESSLICH die hier verzeichneten Dateien, nie ein Verzeichnis-
-- Listing des Buckets. Grund: Ein abgebrochener Lauf kann eine unvollständig hochgeladene Datei
-- hinterlassen. Der Eintrag hier entsteht erst NACH dem erfolgreichen Upload - was nicht
-- verzeichnet ist, zählt nicht mit.
create table if not exists public.deck_corpus_files (
  path text primary key,
  source text not null,
  deck_count integer not null default 0,
  schema_version integer not null default 1,
  written_at timestamptz not null default now()
);

comment on table public.deck_corpus_files is
  'Die Rohdeck-Dateien im Bucket "deck-corpus", je Zeile eine gepackte JSONL-Datei. Verbindliche Inhaltsliste des Korpus für scripts/aggregate-deck-corpus.js.';

-- Verhindert, dass ein fortgesetzter Lauf Decks ein zweites Mal HERUNTERLÄDT. Die Aggregation
-- entdoppelt zwar ohnehin selbst über die Quell-ID, aber jede gesparte Anfrage ist bei 30
-- Anfragen pro Minute zwei Sekunden Laufzeit.
create table if not exists public.deck_corpus_seen (
  source text not null,
  source_deck_id text not null,
  primary key (source, source_deck_id)
);

comment on table public.deck_corpus_seen is
  'Bereits geholte Decks je Quelle - reine Sparmaßnahme gegen doppelte Anfragen, kein Datenbestand. Darf notfalls geleert werden, dann werden Decks erneut geholt (und beim Aggregieren wieder entdoppelt).';

-- =====================================================================================
-- 3. Das Aggregat - die eigentliche Empfehlungsgrundlage
--
--    Was hier steht, ersetzt fachlich das, was EdhrecService.getCommanderRecommendations() heute
--    von fremden Servern holt: "wie viele Decks dieses Commanders spielen Karte X" und "wie
--    ungewöhnlich ist das". Nur eben aus dem eigenen Korpus gerechnet.
-- =====================================================================================

-- commander_key ist der Schlüssel, unter dem alles zusammenläuft: Commander-Namen normalisiert
-- (normalizeCardName aus array-utils.ts), alphabetisch sortiert, mit "|" verbunden. Die Sortierung
-- ist der Punkt - sie sorgt dafür, dass ein Partner-Paar unabhängig von der Reihenfolge im selben
-- Topf landet. Genau daran scheitert der EDHREC-Weg heute regelmäßig: dort muss
-- buildCommanderSlugCandidates() beide Reihenfolgen durchprobieren, weil deren URL-Schema die
-- Reihenfolge festhält.
create table if not exists public.deck_corpus_commanders (
  commander_key text primary key,
  commander_names text[] not null default '{}',
  color_identity text[] not null default '{}',
  deck_count integer not null default 0,
  refreshed_at timestamptz not null default now()
);

comment on table public.deck_corpus_commanders is
  'Je Commander (bzw. Commander-Paar) die Anzahl der Decks im Korpus. Gerechnet von scripts/aggregate-deck-corpus.js.';
comment on column public.deck_corpus_commanders.commander_key is
  'Commander-Namen normalisiert, alphabetisch sortiert, mit "|" verbunden - reihenfolgeunabhängig, damit Partner-Paare zusammenfallen.';

create table if not exists public.deck_corpus_commander_cards (
  commander_key text not null,
  front_name_normalized text not null,
  deck_count integer not null default 0,
  share real not null default 0,
  synergy real not null default 0,
  refreshed_at timestamptz not null default now(),
  primary key (commander_key, front_name_normalized)
);

comment on table public.deck_corpus_commander_cards is
  'Kern der Empfehlungen: wie oft eine Karte in den Decks eines Commanders vorkommt. Ersetzt fachlich die cardviews aus EDHRECs Commander-Seiten.';
comment on column public.deck_corpus_commander_cards.share is
  'deck_count geteilt durch die Deckzahl des Commanders - "X % seiner Decks spielen diese Karte".';
comment on column public.deck_corpus_commander_cards.synergy is
  'share minus deck_corpus_card_baseline.share - wie viel HÄUFIGER die Karte bei diesem Commander vorkommt als bei allen Decks, die sie überhaupt spielen dürften. Negative Werte bedeuten "seltener als üblich".';

-- Die App fragt immer "die Top-Karten dieses Commanders", nie "welche Commander spielen Karte X" -
-- der Primärschlüssel beginnt zwar richtig, sortiert aber nach dem Namen, nicht nach Häufigkeit.
create index if not exists deck_corpus_commander_cards_top_idx
  on public.deck_corpus_commander_cards (commander_key, deck_count desc);

-- Die Bezugsgröße der Synergie. Eigene Tabelle statt einer Zahl im Skript, damit sich jede
-- Synergie-Angabe im Dashboard nachrechnen lässt - sonst wäre die auffälligste Zahl der ganzen
-- Vorschlagsliste eine Blackbox.
create table if not exists public.deck_corpus_card_baseline (
  front_name_normalized text primary key,
  playable_decks integer not null default 0,
  deck_count integer not null default 0,
  share real not null default 0,
  refreshed_at timestamptz not null default now()
);

comment on table public.deck_corpus_card_baseline is
  'Je Karte: in wie vielen Korpus-Decks sie farblich überhaupt spielbar WÄRE (playable_decks) und in wie vielen sie tatsächlich steckt (deck_count). share ist der Quotient und die Bezugsgröße für die Synergie.';

-- =====================================================================================
-- 4. RLS
--
--    Aggregat: für jeden lesbar (auch ohne Login - die Vorschlagsliste soll später genauso
--    account-frei funktionieren wie der Such-Tab), für niemanden schreibbar. Wie bei
--    scryfall_cards ist "enable row level security" hier ZWINGEND, obwohl die Daten öffentlich
--    sind: ohne RLS wäre die Tabelle über den eingecheckten Anon-Key auch BESCHREIBBAR. Es gibt
--    bewusst nur eine select-Policy - fehlt für insert/update/delete jede Policy, verweigert RLS
--    sie grundsätzlich.
--
--    Lauf-Interna: RLS an, gar keine Policy - für den Anon-Key vollständig unsichtbar. Die
--    Skripte nutzen den Service-Role-Key, der RLS ohnehin umgeht.
-- =====================================================================================
alter table public.deck_corpus_state enable row level security;
alter table public.deck_corpus_files enable row level security;
alter table public.deck_corpus_seen enable row level security;
alter table public.deck_corpus_commanders enable row level security;
alter table public.deck_corpus_commander_cards enable row level security;
alter table public.deck_corpus_card_baseline enable row level security;

drop policy if exists "Deck corpus commanders are readable by anyone" on public.deck_corpus_commanders;
create policy "Deck corpus commanders are readable by anyone"
on public.deck_corpus_commanders
for select
to public
using (true);

drop policy if exists "Deck corpus commander cards are readable by anyone" on public.deck_corpus_commander_cards;
create policy "Deck corpus commander cards are readable by anyone"
on public.deck_corpus_commander_cards
for select
to public
using (true);

drop policy if exists "Deck corpus card baseline is readable by anyone" on public.deck_corpus_card_baseline;
create policy "Deck corpus card baseline is readable by anyone"
on public.deck_corpus_card_baseline
for select
to public
using (true);
