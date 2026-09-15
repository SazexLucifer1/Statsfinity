-- Kartenlisten des Archidekt-Deckvorrats platzsparend ablegen: ein Zahlen-Array je Deck statt
-- einer Zeile je Karte. Im Supabase-SQL-Editor ausführen. Idempotent - ein zweiter Lauf tut nichts.
--
-- WARUM: Nach dem ersten 10.000er-Import stand die Datenbank bei 494 von 500 MB des Free-Plans,
-- kurz vor dem Umschalten auf read-only. Nachgemessen an 10.000 Decks (930.000 Karten):
--
--   eine Zeile je Karte, Name als Text (bisher)      160 MB
--     davon allein der Primärschlüssel-Index          72 MB
--   eine Zeile je Karte, Namen als Zahl-Verweis       68 MB
--   ein Zahlen-Array je Deck (dieser Umbau)          9,3 MB   <- inklusive GIN-Index
--
-- Der Unterschied kommt NICHT von den Kartennamen, sondern von der Zeilenzahl: 930.000 Zeilen
-- kosten allein an Zeilenköpfen und Primärschlüssel über 90 MB. Hier sind es 10.000 Zeilen.
-- Hochgerechnet auf 50.000 Decks: rund 46 MB statt 800 MB.
--
-- WAS DAS KOSTET: Die Kartenliste ist keine Tabelle mehr, die man direkt joinen kann. Für die
-- spätere Bracket-Rechnung braucht es ein unnest() über die Arrays, dann den Join auf
-- archidekt_pool_card_names.name_normalized und von dort wie gehabt auf
-- scryfall_cards.front_name_normalized. Die lesbare View unten macht genau das vor.
--
-- REIHENFOLGE: Die Abschnitte bauen aufeinander auf und müssen in einem Durchgang laufen.
-- Abschnitt 1 gibt zuerst Platz frei, weil die neuen Tabellen neben den alten entstehen und dafür
-- Platz da sein muss - bei 6 MB Rest ist das nicht selbstverständlich.

-- =====================================================================================
-- 1. Platz schaffen: der Index auf name_normalized (rund 6 MB) wird für den Umbau nicht
--    gebraucht. Anders als ein delete gibt ein drop index den Platz sofort zurück.
-- =====================================================================================
drop index if exists public.archidekt_deck_pool_cards_name_idx;

-- =====================================================================================
-- 2. Die Kartennamen, einmal statt 930.000-mal.
--
--    name_normalized bleibt der Schlüssel zu scryfall_cards.front_name_normalized - genau wie
--    vorher in der Kartentabelle, nur eben einmal je Karte statt einmal je Karte UND Deck.
--    name ist der Anzeigename inklusive " // " bei doppelseitigen Karten.
-- =====================================================================================
create table if not exists public.archidekt_pool_card_names (
  id integer primary key generated always as identity,
  name_normalized text not null unique,
  name text not null
);

comment on table public.archidekt_pool_card_names is
  'Jeder im Deckvorrat vorkommende Kartenname genau einmal. Ersetzt die 930.000-fache Textwiederholung der früheren Kartentabelle.';
comment on column public.archidekt_pool_card_names.name_normalized is
  'Schlüssel für den Join auf scryfall_cards.front_name_normalized - muss exakt normalizeCardName() aus src/app/array-utils.ts entsprechen.';

-- =====================================================================================
-- 3. Die Kartenliste als Arrays, eine Zeile je Deck.
--
--    card_ids und quantities laufen PARALLEL: quantities[i] gehört zu card_ids[i]. Der check
--    unten hält das fest, weil ein Auseinanderlaufen sonst still falsche Kartenzahlen ergäbe.
--    commander_ids ist eine eigene, kurze Liste statt eines dritten Parallel-Arrays - es sind nie
--    mehr als zwei Einträge (Partner/Hintergrund).
-- =====================================================================================
create table if not exists public.archidekt_deck_pool_cardlists (
  deck_id uuid primary key references public.archidekt_deck_pool (id) on delete cascade,
  card_ids integer[] not null,
  quantities smallint[] not null,
  commander_ids integer[] not null,
  constraint archidekt_deck_pool_cardlists_parallel
    check (array_length(card_ids, 1) = array_length(quantities, 1))
);

comment on table public.archidekt_deck_pool_cardlists is
  'Kartenliste je Deck als Zahlen-Arrays (Verweise auf archidekt_pool_card_names). card_ids und quantities laufen parallel.';

-- Beantwortet "welche Decks spielen Karte X" per card_ids @> array[id].
create index if not exists archidekt_deck_pool_cardlists_karten_idx
  on public.archidekt_deck_pool_cardlists using gin (card_ids);

-- =====================================================================================
-- 4. Bestand übernehmen - nur, wenn die alte Tabelle noch existiert.
--
--    Der Block macht den zweiten Lauf zum No-Op, statt an einer fehlenden Tabelle zu scheitern.
-- =====================================================================================
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'archidekt_deck_pool_cards'
  ) then
    insert into public.archidekt_pool_card_names (name_normalized, name)
    select distinct on (name_normalized) name_normalized, name
    from public.archidekt_deck_pool_cards
    order by name_normalized, name
    on conflict (name_normalized) do nothing;

    insert into public.archidekt_deck_pool_cardlists (deck_id, card_ids, quantities, commander_ids)
    select c.deck_id,
           array_agg(n.id order by c.name_normalized),
           array_agg(c.quantity order by c.name_normalized),
           coalesce(
             array_remove(array_agg(case when c.is_commander then n.id end), null),
             array[]::integer[]
           )
    from public.archidekt_deck_pool_cards c
    join public.archidekt_pool_card_names n on n.name_normalized = c.name_normalized
    group by c.deck_id
    on conflict (deck_id) do nothing;
  end if;
end $$;

-- =====================================================================================
-- 5. Die lesbare Ansicht auf die neuen Tabellen umhängen.
--
--    Muss VOR dem drop der alten Tabelle passieren, sonst hängt die View an etwas, das gleich
--    verschwindet. Zeigt zugleich das Muster, mit dem sich aus den Arrays wieder eine
--    Kartenliste bauen lässt - unnest() der beiden Arrays parallel, dann der Join auf die Namen.
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
    select string_agg(z.menge || ' ' || n.name, E'\n'
                      order by (n.id = any (l.commander_ids)) desc, n.name)
    from public.archidekt_deck_pool_cardlists l
    cross join lateral unnest(l.card_ids, l.quantities) as z(kid, menge)
    join public.archidekt_pool_card_names n on n.id = z.kid
    where l.deck_id = d.id
  ) as decklist,
  d.owner_username,
  d.imported_at
from public.archidekt_deck_pool d;

comment on view public.archidekt_deck_pool_readable is
  'Lesbare Ansicht auf archidekt_deck_pool: Name, Commander, Bracket des Erstellers und Kartenliste als Text. Läuft mit den Rechten des Aufrufers (security_invoker), also nur für Developer sichtbar.';

-- =====================================================================================
-- 6. Sichtbarkeit der neuen Tabellen: wie gehabt ausschließlich Developer.
-- =====================================================================================
alter table public.archidekt_pool_card_names enable row level security;
alter table public.archidekt_deck_pool_cardlists enable row level security;

drop policy if exists "Developers can read the archidekt pool card names" on public.archidekt_pool_card_names;
create policy "Developers can read the archidekt pool card names"
on public.archidekt_pool_card_names
for select
to authenticated
using (is_developer(auth.uid()));

drop policy if exists "Developers can write the archidekt pool card names" on public.archidekt_pool_card_names;
create policy "Developers can write the archidekt pool card names"
on public.archidekt_pool_card_names
for all
to authenticated
using (is_developer(auth.uid()))
with check (is_developer(auth.uid()));

drop policy if exists "Developers can read the archidekt pool cardlists" on public.archidekt_deck_pool_cardlists;
create policy "Developers can read the archidekt pool cardlists"
on public.archidekt_deck_pool_cardlists
for select
to authenticated
using (is_developer(auth.uid()));

drop policy if exists "Developers can write the archidekt pool cardlists" on public.archidekt_deck_pool_cardlists;
create policy "Developers can write the archidekt pool cardlists"
on public.archidekt_deck_pool_cardlists
for all
to authenticated
using (is_developer(auth.uid()))
with check (is_developer(auth.uid()));

-- =====================================================================================
-- 7. Die alte Kartentabelle weg. Das ist der Schritt, der die rund 154 MB zurückgibt.
--
--    Erst hier, nachdem alles Übrige steht: Bis zu diesem Punkt ist der Umbau folgenlos
--    abbrechbar, danach nicht mehr.
-- =====================================================================================
drop table if exists public.archidekt_deck_pool_cards;
