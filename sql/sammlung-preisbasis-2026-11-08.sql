-- Sammlung: wählbare Preisbasis (Wunsch des Users, 08.11.2026).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent. Baut auf
-- sql/cardmarket-preise-zustand-2026-11-08.sql auf.
--
-- 1. scryfall_prints bekommt drei weitere Werte aus Cardmarkets Preisdatei (je normal und Foil):
--      cm_avg1   Durchschnitt der Verkäufe des letzten Tages
--      cm_avg30  Durchschnitt der letzten 30 Tage
--      cm_trend  Cardmarkets Trendpreis (derselbe Wert, den Scryfall als "eur" zeigt)
--    Gefüllt vom Scryfall-Nachtlauf, Teil 5 (scripts/sync-scryfall-bulk.js).
--
-- 2. profiles.collection_price_basis: welcher Wert als Preis einer Near-Mint-Karte gilt -
--    'avg7' (Standard), 'trend', 'avg30' oder 'avg1'. Played-Karten und der Mindestwert bleiben
--    beim günstigsten Angebot. Alle Werte gelten für alle Sprachen gemeinsam: Cardmarkets
--    Preisdatei kennt keine Preise je Sprache, Scryfall auch nicht.
--    Keine neue Policy: profiles darf jeder ohnehin nur in der eigenen Zeile ändern.
--
-- Ohne diese Migration gilt Ø 7 Tage, und die Wahl wird nur auf dem Gerät gemerkt.

alter table public.scryfall_prints add column if not exists cm_avg1 numeric(10, 2);
alter table public.scryfall_prints add column if not exists cm_avg1_foil numeric(10, 2);
alter table public.scryfall_prints add column if not exists cm_avg30 numeric(10, 2);
alter table public.scryfall_prints add column if not exists cm_avg30_foil numeric(10, 2);
alter table public.scryfall_prints add column if not exists cm_trend numeric(10, 2);
alter table public.scryfall_prints add column if not exists cm_trend_foil numeric(10, 2);

alter table public.profiles
  add column if not exists collection_price_basis text not null default 'avg7';

alter table public.profiles drop constraint if exists profiles_collection_price_basis_check;
alter table public.profiles
  add constraint profiles_collection_price_basis_check
  check (collection_price_basis in ('avg7', 'trend', 'avg30', 'avg1'));

comment on column public.profiles.collection_price_basis is
  'Preisbasis der Sammlung (Near Mint): avg7 | trend | avg30 | avg1 aus Cardmarkets Preisdatei. sql/sammlung-preisbasis-2026-11-08.sql';

notify pgrst, 'reload schema';
