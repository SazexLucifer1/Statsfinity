-- Sammlung: Ab-Preis als globale Preisbasis und eigener Preis je Karte
-- (Wunsch des Users, 08.11.2026).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent. Baut auf
-- sql/sammlung-preisbasis-2026-11-08.sql auf.
--
-- 1. profiles.collection_price_basis darf zusätzlich 'low' sein: Cardmarkets günstigstes Angebot
--    ("ab"-Preis) für alle Karten - Kacheln, Statistik und Gesamtwert. Ersetzt den früheren
--    Umschalter "Mindestwert".
-- 2. profiles.collection_card_prices: ob Karten mit eigenem Preis (Punkt 3) ihn behalten (true,
--    Standard) oder ob die Einstellung der Sammlung für alle gilt (false).
-- 3. collection_cards.price_basis: eigener Preis einer Karte - 'avg7', 'trend', 'avg30', 'avg1'
--    oder 'low'; null = wie die Sammlung. Nicht im Schlüssel. Keine neue Policy: Schreiben darf
--    ohnehin nur der Besitzer.
--
-- Ohne diese Migration gibt es keinen eigenen Preis je Karte, und "Ab-Preis" sowie der Schalter
-- gelten nur auf dem Gerät.

alter table public.profiles drop constraint if exists profiles_collection_price_basis_check;
alter table public.profiles
  add constraint profiles_collection_price_basis_check
  check (collection_price_basis in ('avg7', 'trend', 'avg30', 'avg1', 'low'));

alter table public.profiles
  add column if not exists collection_card_prices boolean not null default true;

alter table public.collection_cards add column if not exists price_basis text;

alter table public.collection_cards drop constraint if exists collection_cards_price_basis_check;
alter table public.collection_cards
  add constraint collection_cards_price_basis_check
  check (price_basis is null or price_basis in ('avg7', 'trend', 'avg30', 'avg1', 'low'));

comment on column public.collection_cards.price_basis is
  'Eigener Preis dieser Karte (avg7 | trend | avg30 | avg1 | low), null = wie die Sammlung. sql/sammlung-kartenpreise-2026-11-08.sql';

notify pgrst, 'reload schema';
