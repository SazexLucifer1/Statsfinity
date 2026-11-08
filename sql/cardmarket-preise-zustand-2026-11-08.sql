-- Sammlung: Preise aus Cardmarkets täglicher Preisdatei und Zustand je Karte
-- (Wunsch des Users, 08.11.2026).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent.
--
-- 1. scryfall_prints bekommt vier Cardmarket-Werte je Druck. Der Nachtlauf (Teil 5 von
--    scripts/sync-scryfall-bulk.js) lädt dafür Cardmarkets öffentliche Preisdatei
--    (price_guide_1.json, ~27 MB, ein Eintrag je Cardmarket-Produkt) und ordnet sie über Scryfalls
--    cardmarket_id dem Druck zu:
--      cm_avg7 / cm_avg7_foil  Durchschnitt der Verkäufe der letzten 7 Tage - der Standardpreis
--                              einer Sammlungskarte
--      cm_low  / cm_low_foil   günstigstes Angebot (über alle Zustände und Sprachen) - der Preis
--                              einer Karte im Zustand "Played"
--    Ein Cardmarket-Produkt umfasst alle Sprachen eines Drucks; fremdsprachige Karten bekommen
--    deshalb dieselben Werte wie der englische Druck (über print_key).
--    Bis der Nachtlauf gelaufen ist, sind die Spalten leer und die App nimmt wie bisher Scryfalls
--    Preis (Cardmarket-Trend).
--
-- 2. collection_cards bekommt den Zustand: 'nm' (Near Mint, Standard) oder 'pl' (Played). Er
--    gehört zum Schlüssel einer Zeile - 3 Exemplare NM und 1 Played desselben Drucks sind zwei
--    Zeilen. Der Scanner trägt immer NM ein; geändert wird nur von Hand im Bearbeiten-Blatt der
--    Sammlung (collection-card-editor/). Bestehende Zeilen werden NM.
--
-- Ohne diese Migration läuft die App weiter wie bisher (Scryfall-Preis, kein Zustand).

alter table public.scryfall_prints add column if not exists cm_avg7 numeric(10, 2);
alter table public.scryfall_prints add column if not exists cm_avg7_foil numeric(10, 2);
alter table public.scryfall_prints add column if not exists cm_low numeric(10, 2);
alter table public.scryfall_prints add column if not exists cm_low_foil numeric(10, 2);

comment on column public.scryfall_prints.cm_avg7 is
  'Cardmarket: Durchschnittspreis der letzten 7 Tage (avg7), aus price_guide_1.json über cardmarket_id. sql/cardmarket-preise-zustand-2026-11-08.sql';
comment on column public.scryfall_prints.cm_low is
  'Cardmarket: günstigstes Angebot über alle Zustände (low) - Preis für Karten im Zustand Played.';

alter table public.collection_cards
  add column if not exists condition text not null default 'nm';

alter table public.collection_cards drop constraint if exists collection_cards_condition_check;
alter table public.collection_cards
  add constraint collection_cards_condition_check check (condition in ('nm', 'pl'));

alter table public.collection_cards drop constraint if exists collection_cards_pkey;
alter table public.collection_cards add primary key (user_id, scryfall_id, foil, lang, condition);

comment on column public.collection_cards.condition is
  'Zustand: nm = Near Mint (Standard, Scanner), pl = Played (Preis = Cardmarket low). Teil des Schlüssels, sql/cardmarket-preise-zustand-2026-11-08.sql.';

notify pgrst, 'reload schema';
