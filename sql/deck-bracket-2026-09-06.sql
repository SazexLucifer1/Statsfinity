-- Bracket-Stufe je Deck (offizielle Commander-Brackets 1-5).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent (alle "add column if not exists"
-- und "drop constraint if exists" + "add constraint"-Paare sind gefahrlos mehrfach ausführbar).
--
-- Gepflegt von src/app/bracket.ts (Berechnung) und DeckService.setDeckBracket() /
-- saveDeckAutoBracket() (Persistenz). Angezeigt in der Deck-Detailansicht, der Deck-Liste und der
-- Deck-Auswahl im Match-Tab.
--
-- Warum ZWEI Spalten:
--   bracket       - die selbst festgelegte Stufe. null = "automatisch".
--   bracket_auto  - das zuletzt berechnete Ergebnis der Automatik.
-- Ohne die zweite Spalte müssten Deck-Liste und Match-Picker für JEDES Deck die komplette
-- Kartenliste nachladen, nur um ein Abzeichen zu zeichnen. So wird gerechnet, wenn ein Deck
-- ohnehin geöffnet wird, und das Ergebnis steht danach überall sofort bereit. Angezeigt wird
-- immer bracket, und nur wenn das null ist, bracket_auto.
--
-- Keine neue RLS-Policy nötig: die Spalten werden über dieselben bestehenden Policies auf
-- public.decks gelesen und geschrieben wie name, format oder is_outdated.

alter table public.decks add column if not exists bracket smallint;
alter table public.decks add column if not exists bracket_auto smallint;
alter table public.decks add column if not exists bracket_auto_at timestamptz;

-- Es gibt genau fünf Brackets. Ein Tippfehler im Code soll hier auflaufen und nicht als "Bracket
-- 7" in der Oberfläche landen.
alter table public.decks drop constraint if exists decks_bracket_range;
alter table public.decks add constraint decks_bracket_range
  check (bracket is null or bracket between 1 and 5);

alter table public.decks drop constraint if exists decks_bracket_auto_range;
alter table public.decks add constraint decks_bracket_auto_range
  check (bracket_auto is null or bracket_auto between 1 and 5);

comment on column public.decks.bracket is
  'Selbst festgelegte Bracket-Stufe 1-5. null = automatisch bestimmen (dann gilt bracket_auto). Gesetzt ueber DeckService.setDeckBracket().';
comment on column public.decks.bracket_auto is
  'Zuletzt von src/app/bracket.ts berechnete Stufe. Bewusst nur 2, 3 oder 4: Bracket 1 (Exhibition) und 5 (cEDH) sind Absichtserklaerungen und aus einer Kartenliste nicht ableitbar - die setzt man selbst.';
comment on column public.decks.bracket_auto_at is
  'Wann bracket_auto zuletzt berechnet wurde - macht im Dashboard sichtbar, ob ein Deck seit der letzten Kartenaenderung neu bewertet wurde.';
