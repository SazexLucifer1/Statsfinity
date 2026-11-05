-- Sammlung: Die Sprache gehört zum Schlüssel einer Zeile (Wunsch des Users, 05.11.2026).
-- Client: src/app/collection.service.ts (quantityOf/setQuantity), Scanner: card-scanner/.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent.
--
-- Scryfall kennt viele Drucke nicht in jeder Sprache, in der es sie wirklich gibt. Eine deutsche
-- Karte, die Scryfall nur englisch führt, muss trotzdem als deutsch in der Sammlung stehen - mit
-- der Druck-ID des englischen Drucks (für Bild und Preis) und lang = 'de'. Bisher war der
-- Schlüssel (user_id, scryfall_id, foil): Eine solche Zeile hätte die englische Zeile desselben
-- Drucks überschrieben. lang war schon immer eine eigene Spalte, es kommt nur in den Schlüssel.
--
-- Bestehende Zeilen ändern sich nicht - bei ihnen ist lang ohnehin die Sprache des Drucks.
-- Ohne diese Migration läuft die App weiter wie bisher (eine Zeile je Druck und Foil).

alter table public.collection_cards drop constraint if exists collection_cards_pkey;
alter table public.collection_cards add primary key (user_id, scryfall_id, foil, lang);

comment on column public.collection_cards.lang is
  'Sprache der Karte, wie sie wirklich gedruckt ist. Meist die Sprache des Drucks scryfall_id; weicht ab, wenn Scryfall den Druck in dieser Sprache nicht kennt (dann Bild/Preis vom Druck scryfall_id). Teil des Schlüssels, sql/sammlung-sprache-frei-2026-11-05.sql.';
