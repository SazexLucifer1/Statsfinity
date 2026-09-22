-- Primer: die eigene Beschreibung eines Decks - was es vorhat, wie es das macht, worauf man beim
-- Spielen achten muss. In der Deck-Ansicht als zweiter Reiter neben der Kartenliste (Vorbild
-- Moxfield). Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent ("if not exists" bzw.
-- "drop constraint if exists" + "add constraint").
--
-- Bewusst eine Spalte an decks, KEINE eigene Tabelle: Es gibt genau einen Primer je Deck, ohne
-- Verlauf und ohne zweiten Schreiber. Eine Tabelle mit deck_id als Primärschlüssel wäre dieselbe
-- Zeile mit einem Join davor, plus ein eigener RLS-Satz, der die Regeln von decks noch einmal
-- nachbauen müsste - und zwei Fassungen derselben Regel laufen auseinander.
--
-- Deshalb braucht es hier auch KEINE neue Policy: Lesen folgt automatisch der Sichtbarkeit des
-- Decks (sql/public-deck-browse-2026-08-26.sql - nicht-private Decks liest jeder, auch ohne
-- Login), Schreiben dem bestehenden Update-Recht des Besitzers. Genau das ist gewollt: Ein Primer
-- unter einem öffentlichen Deck ist öffentlich, ändern darf ihn nur, wer auch den Decknamen
-- ändern darf.
--
-- Fehlt diese Migration noch, schaltet sich der Primer in der App beim ersten 42703/PGRST204 still
-- ab (siehe DeckPrimerService) - der Reiter verschwindet dann, statt unter jedem Deck einen Fehler
-- zu zeigen.

alter table public.decks add column if not exists primer text;

comment on column public.decks.primer is
  'Vom Besitzer geschriebene Deck-Beschreibung als bereinigtes HTML (Teilmenge: p, br, strong, em, u, s, h2, h3, ul, ol, li, blockquote, a). Bereinigt wird im Client vor dem Speichern (src/app/primer-html.ts), angezeigt wird über Angulars [innerHTML], das ein zweites Mal bereinigt. NULL = kein Primer.';

-- Obergrenze auf dem gespeicherten HTML, nicht auf dem sichtbaren Text: Das Markup zählt mit, weil
-- die Zeile am Ende so groß ist, wie sie ist. Der Client begrenzt zusätzlich den reinen Text
-- (PRIMER_MAX_TEXT_LENGTH), damit die Meldung dort vor dem Absenden kommt und nicht erst als
-- Datenbankfehler danach. 40.000 Zeichen sind grob 6.000 Wörter - mehr als jeder Primer braucht,
-- wenig genug, dass niemand die 500-MB-Grenze des Free-Plans damit füllt.
alter table public.decks drop constraint if exists decks_primer_laenge;
alter table public.decks add constraint decks_primer_laenge
  check (primer is null or char_length(primer) <= 40000);
