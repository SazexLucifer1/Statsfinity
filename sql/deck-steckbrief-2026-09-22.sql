-- Steckbrief: die Kurzvorstellung eines Decks als Bild zum Teilen (Vorbild deckpassport.com).
-- Dritter Reiter neben Deckliste und Primer. Im Supabase-Dashboard unter "SQL Editor" ausführen;
-- idempotent ("if not exists" bzw. "drop constraint if exists" + "add constraint").
--
-- Fast alles auf dem Steckbrief rechnet die App aus dem ohnehin geladenen Deck aus (Commander,
-- Farben, Bracket, Kartenzahl, Ø Manawert, Länder, Kreaturen, Bilanz) - gespeichert werden nur die
-- zwei Sätze, die kein Programm aus einer Kartenliste ablesen kann: worum es dem Deck geht und
-- woran es gewinnt.
--
-- Zwei Spalten an decks, KEINE eigene Tabelle und KEINE neue Policy - aus denselben Gründen wie
-- beim Primer (siehe sql/deck-primer-2026-09-22.sql): Es gibt genau einen Steckbrief je Deck,
-- Lesen folgt der Sichtbarkeit des Decks, Schreiben dem bestehenden Update-Recht des Besitzers.
-- Eine eigene Tabelle müsste beide Regeln ein zweites Mal nachbauen, und zwei Fassungen derselben
-- Regel laufen auseinander.
--
-- Auch NICHT in die primer-Spalte mit hineingeschrieben: Der Primer ist Fließtext mit Markup und
-- wird gelesen; diese zwei Felder sind reiner Text fester Länge und werden in ein Bild gezeichnet.
-- Zusammengelegt müsste der Zeichner den Primer parsen und raten, welcher Absatz was ist.
--
-- Fehlt diese Migration noch, schaltet sich in der App nur das Schreiben/Anzeigen dieser zwei
-- Sätze beim ersten 42703/PGRST204 still ab (siehe DeckSteckbriefService) - der Reiter selbst
-- bleibt, weil der Rest des Steckbriefs aus dem Deck gerechnet wird.

alter table public.decks add column if not exists steckbrief_kurz text;
alter table public.decks add column if not exists steckbrief_sieg text;

comment on column public.decks.steckbrief_kurz is
  'Steckbrief, Feld 1: "Worum geht es dem Deck?" - reiner Text, höchstens 220 Zeichen, NULL = nicht ausgefüllt. Wird in das Steckbrief-Bild gezeichnet (src/app/steckbrief-canvas.ts).';
comment on column public.decks.steckbrief_sieg is
  'Steckbrief, Feld 2: "Wie gewinnt das Deck?" - reiner Text, höchstens 220 Zeichen, NULL = nicht ausgefüllt.';

-- 220 Zeichen sind rund fünf Zeilen im Bild. Die Grenze steht hier UND im Client
-- (STECKBRIEF_MAX_LAENGE): Der Client meldet sie vor dem Absenden, die Datenbank hält sie auch
-- gegen einen direkten API-Aufruf - im Bild ist länger schlicht nicht mehr darstellbar.
alter table public.decks drop constraint if exists decks_steckbrief_kurz_laenge;
alter table public.decks add constraint decks_steckbrief_kurz_laenge
  check (steckbrief_kurz is null or char_length(steckbrief_kurz) <= 220);

alter table public.decks drop constraint if exists decks_steckbrief_sieg_laenge;
alter table public.decks add constraint decks_steckbrief_sieg_laenge
  check (steckbrief_sieg is null or char_length(steckbrief_sieg) <= 220);
