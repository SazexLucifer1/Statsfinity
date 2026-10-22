-- Mehr Kartendaten aus dem eigenen Backend statt live bei Scryfall (Wunsch des Users, 22.10.2026:
-- "so viel wie möglich über unser eigenes Backend"): Namensvorschläge beim Tippen und Deck-Preise.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent. Setzt
-- sql/scryfall-cache-2026-09-06.sql voraus.
--
-- 1. scryfall_commander_names: welche Karten Commander sein dürfen (Scryfalls "is:commander",
--    Regel 903.3 samt "can be your commander") bzw. Backgrounds sind. Gefüllt von Teil 4 des
--    nächtlichen Scryfall-Abgleichs (scripts/sync-scryfall-bulk.js) - bewusst Scryfalls eigene
--    Liste statt einer nachgebauten Regel, die beim nächsten Regelwechsel still danebenläge.
--    Eine Zeile je Name, ~3.500 Zeilen.
-- 2. card_name_suggestions(): Teilwort-Suche über scryfall_cards, Treffer am Wortanfang zuerst.
--    Rund 30.000 Zeilen - ohne eigenen Index schnell genug, ein Trigramm-Index wäre Ballast.
-- 3. scryfall_card_prices: der günstigste EUR-Preis (Cardmarket über Scryfall) je Karte über alle
--    nicht-digitalen Drucke - dasselbe, was ScryfallService.cheapestPrices() live erfragt, für den
--    Gesamtpreis eines Decks. Gefüllt von Teil 5 des Nachtlaufs aus Scryfalls default_cards
--    (Preise ändern sich täglich, die Datei auch). Eine Zeile je Karte, auch ohne Preis (eur null),
--    damit "kein Preis" nicht jedes Mal erneut bei Scryfall nachgefragt wird. ~32.000 Zeilen,
--    rund 4 MB samt Index. Nur für den GESAMTPREIS eines Decks (dort zählt die billigste Variante).
-- 4. scryfall_print_info: der echte Preis JE DRUCK (normal und Foil) samt Seltenheit, Setname,
--    Artwork und Legalitäten - das, was CollectionService.printInfo() für die Sammlung bisher
--    live bei Scryfall holt. Nur für Drucke, die in irgendeiner Sammlung liegen (alle ~110.000
--    Drucke wären rund 20 MB); was erst heute dazukam, holt die App bis zur nächsten Nacht live.
--    Fremdsprachige Drucke haben bei Scryfall keinen Preis - sie bekommen wie bisher den des
--    englischen Drucks mit gleichem Set und gleicher Nummer (price_from_english, Anzeige "≈").
--
-- Bis der Nachtlauf die Tabellen gefüllt hat, fragt die App wie bisher Scryfall. Zurück zum alten
-- Stand: Funktion und die drei Tabellen löschen.

create table if not exists public.scryfall_commander_names (
  name_normalized text primary key,
  kind text not null check (kind in ('commander', 'background')),
  synced_at timestamptz not null default now()
);

comment on table public.scryfall_commander_names is
  'Karten, die Commander (Scryfalls is:commander) oder Background sein dürfen. Schlüssel wie scryfall_cards.front_name_normalized. Gefüllt vom nächtlichen Scryfall-Abgleich, Teil 4.';

alter table public.scryfall_commander_names enable row level security;

drop policy if exists "Commander names are readable by anyone" on public.scryfall_commander_names;
create policy "Commander names are readable by anyone"
on public.scryfall_commander_names
for select
to public
using (true);

grant select on public.scryfall_commander_names to anon, authenticated;

create or replace function public.card_name_suggestions(
  p_query text,
  p_kind text default 'any',
  p_limit integer default 12
)
returns table (name text)
language sql
stable
set search_path = public
as $$
  with q as (select lower(btrim(coalesce(p_query, ''))) as t)
  select c.name
    from public.scryfall_cards c, q
   where length(q.t) >= 2
     and (strpos(lower(c.name), q.t) > 0 or strpos(c.front_name_normalized, q.t) > 0)
     and (
       p_kind = 'any'
       or exists (
         select 1
           from public.scryfall_commander_names k
          where k.name_normalized = c.front_name_normalized
            and (p_kind = 'commanderOrBackground' or k.kind = 'commander')
       )
     )
   order by (lower(c.name) like q.t || '%') desc, length(c.name), c.name
   limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

grant execute on function public.card_name_suggestions(text, text, integer) to anon, authenticated;

create table if not exists public.scryfall_card_prices (
  name_normalized text primary key,
  eur numeric(10, 2),
  synced_at timestamptz not null default now()
);

comment on table public.scryfall_card_prices is
  'Günstigster EUR-Preis je Karte über alle nicht-digitalen Drucke (null = kein Preis bekannt). Schlüssel wie scryfall_cards.front_name_normalized. Gefüllt vom nächtlichen Scryfall-Abgleich, Teil 5.';

-- Für das Aufräumen am Ende des Nachtlaufs (Zeilen, die die neue Datei nicht mehr kennt).
create index if not exists scryfall_card_prices_synced_at on public.scryfall_card_prices (synced_at);

alter table public.scryfall_card_prices enable row level security;

drop policy if exists "Card prices are readable by anyone" on public.scryfall_card_prices;
create policy "Card prices are readable by anyone"
on public.scryfall_card_prices
for select
to public
using (true);

grant select on public.scryfall_card_prices to anon, authenticated;

create table if not exists public.scryfall_print_info (
  scryfall_id uuid primary key,
  rarity text,
  set_name text,
  illustration_id uuid,
  eur numeric(10, 2),
  eur_foil numeric(10, 2),
  legalities jsonb not null default '{}',
  price_from_english boolean not null default false,
  synced_at timestamptz not null default now()
);

comment on table public.scryfall_print_info is
  'Preis (normal/Foil), Seltenheit, Setname, Artwork und Legalitäten je Druck - nur für Drucke aus collection_cards. Gefüllt vom nächtlichen Scryfall-Abgleich, Teil 5.';

create index if not exists scryfall_print_info_synced_at on public.scryfall_print_info (synced_at);

alter table public.scryfall_print_info enable row level security;

drop policy if exists "Print info is readable by anyone" on public.scryfall_print_info;
create policy "Print info is readable by anyone"
on public.scryfall_print_info
for select
to public
using (true);

grant select on public.scryfall_print_info to anon, authenticated;

notify pgrst, 'reload schema';
