-- Artwork je Exemplar für den PDF-Druck: Wer 30 Standardländer, neun Nazgûl oder sieben Seven
-- Dwarves druckt, will nicht dreißigmal dasselbe Bild. Im PDF-Dialog lässt sich deshalb für jedes
-- Exemplar einer mehrfach vorhandenen Karte ein eigenes Artwork wählen, und diese Auswahl steht
-- hier. Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent.
--
-- Form: { "forest": ["https://cards.scryfall.io/...", null, "https://..."], ... }
-- Schlüssel ist der kleingeschriebene Kartenname, je Exemplar ein Eintrag; null = das normale
-- Artwork des Decks (deck_cards.image_url).
--
-- Bewusst eine Spalte an decks und NICHT an deck_cards: Die Kartenliste wird beim Import und beim
-- Speichern einer geänderten Liste gelöscht und neu geschrieben (DeckService.saveDeck()), eine
-- Spalte dort müsste jeder dieser Wege ausdrücklich mitretten. Und wie beim Primer braucht es
-- KEINE neue Policy: Lesen folgt der Sichtbarkeit des Decks, Schreiben dem Update-Recht.
--
-- Fehlt diese Migration, funktioniert die Auswahl im Dialog trotzdem - sie wird dann nur nicht
-- gespeichert (die App schaltet das Speichern beim ersten 42703/PGRST204 still ab).

alter table public.decks add column if not exists copy_artworks jsonb;

comment on column public.decks.copy_artworks is
  'Artwork je Exemplar für den PDF-Druck: {kartenname_klein: [bild_url | null, ...]}, ein Eintrag je Exemplar, null = normales Artwork. Geschrieben von DeckPdfService. NULL = keine Auswahl.';

-- Obergrenze gegen Ausreißer: 100 Karten mal eine Scryfall-Adresse (~90 Zeichen) sind ~10 kB.
alter table public.decks drop constraint if exists decks_copy_artworks_groesse;
alter table public.decks add constraint decks_copy_artworks_groesse
  check (copy_artworks is null or pg_column_size(copy_artworks) <= 65536);
