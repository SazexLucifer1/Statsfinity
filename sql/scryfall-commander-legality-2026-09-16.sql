-- Ist diese Karte im Commander ueberhaupt spielbar? Eine Spalte in scryfall_cards, gefuellt vom
-- bestehenden Nachtlauf (scripts/sync-scryfall-bulk.js). Im Supabase-SQL-Editor ausfuehren.
-- Idempotent.
--
-- Scryfall liefert zu jeder Karte ein legalities-Objekt mit einem Eintrag je Format; fuer den
-- Commander sind die moeglichen Werte "legal", "not_legal" und "banned". Bisher wurde davon nichts
-- uebernommen - die Tabelle haelt bewusst nur, was die App braucht, und die Frage kam nie auf.
--
-- Jetzt kommt sie auf: Der Archidekt-Deckvorrat enthaelt Decks mit Karten, die im Commander nicht
-- spielbar sind (Silberrand-Scherzkarten, gebannte Karten). Ohne diese Spalte laesst sich das gar
-- nicht feststellen, und die Bracket-Eichung rechnet mit Decks, die an keinem Tisch existieren
-- koennen.
--
-- Als boolean und nicht als Text: Fuer die Frage "darf dieses Deck in den Vergleich" ist der
-- Unterschied zwischen "not_legal" und "banned" ohne Belang, und eine Spalte mit drei moeglichen
-- Texten laedt dazu ein, den dritten irgendwann zu vergessen.
--
-- NACH DIESER MIGRATION den Scryfall-Abgleich MIT --force anstossen (Haken "force" beim manuellen
-- Auslösen). Ohne das laedt er die Bulk-Datei gar nicht erst, solange sich bei Scryfall nichts
-- geaendert hat, und die Spalte bleibt auf null - was das Legalitaets-Skript als "unbekannt"
-- liest und damit gar nichts pruefen kann.

alter table public.scryfall_cards
  add column if not exists commander_legal boolean;

comment on column public.scryfall_cards.commander_legal is
  'true = im Commander spielbar. false deckt "not_legal" und "banned" gleichermassen ab - fuer die Frage "darf dieses Deck in den Vergleich" ist der Unterschied ohne Belang. null = noch nicht abgeglichen.';

-- Das Legalitaets-Skript fragt "welche dieser Kartennamen sind nicht legal" - der bestehende
-- Index auf front_name_normalized traegt das mit, ein eigener waere Ballast.
