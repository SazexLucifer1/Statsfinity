-- Legalitaet der Decks im Archidekt-Vorrat: eine Spalte am Deck, gefuellt von
-- scripts/check-deck-legality.js (Workflow .github/workflows/deck-legality.yml).
-- Im Supabase-SQL-Editor ausfuehren. Idempotent.
--
-- WARUM: Der Vorrat ist die Referenz, gegen die die Bracket-Einstufung geeicht wird. Ein Deck mit
-- Karten, die im Commander gar nicht spielbar sind, gehoert da nicht hinein - es beschreibt kein
-- Deck, das jemand an einem Tisch spielen koennte. Aufgefallen ist das an einer einzigen Karte:
-- Gleemax, eine Silberrand-Scherzkarte mit Manabetrag 1.000.000, hat den durchschnittlichen
-- Manabetrag von Bracket 1 im ersten grossen Lauf von rund 3 auf 8,16 gehoben.
--
-- MARKIEREN STATT LOESCHEN, und zwar aus einem handfesten Grund: Der Import zieht Decks nach ihrer
-- Archidekt-ID. Ein geloeschtes Deck waere beim naechsten Importlauf schlicht wieder da, und die
-- Arbeit faenge von vorn an. Eine Markierung am Deck ueberlebt jeden weiteren Import (der
-- Import legt nur NEUE Zeilen an, bestehende laesst er unberuehrt).
--
-- DREI ZUSTAENDE, und der dritte ist wichtig:
--   true   geprueft, alle Karten im Commander legal
--   false  geprueft, mindestens eine Karte ist es nicht
--   null   NOCH NICHT GEPRUEFT
-- Die Auswertung schliesst deshalb nur "false" aus, nicht "nicht true". Ein frisch importiertes
-- Deck ist ungeprueft, nicht illegal - es stillschweigend aus jeder Auswertung zu nehmen, waere
-- der unauffaelligere und damit schlimmere Fehler.

alter table public.archidekt_deck_pool
  add column if not exists legal boolean,
  add column if not exists illegale_karten text[],
  add column if not exists legal_geprueft_at timestamptz;

comment on column public.archidekt_deck_pool.legal is
  'true = alle Karten im Commander legal, false = mindestens eine nicht, null = noch nicht geprueft. Ausgewertet wird nur "nicht false" - ungeprueft heisst nicht illegal.';
comment on column public.archidekt_deck_pool.illegale_karten is
  'Die beanstandeten Karten in Anzeigeschreibweise, hoechstens zehn. Damit laesst sich von Hand nachsehen, WARUM ein Deck aussortiert wurde, statt der Markierung glauben zu muessen.';
comment on column public.archidekt_deck_pool.legal_geprueft_at is
  'Wann zuletzt geprueft. Zeigt zugleich, welche Decks seit dem letzten Import noch offen sind.';

-- Die Developer-Ansicht fragt "wie viele Decks dieser Stufe sind legal" - also immer beides
-- zusammen. Als gemeinsamer Index beantwortet Postgres das ohne die Zeilen selbst anzufassen.
create index if not exists archidekt_deck_pool_legal_idx
  on public.archidekt_deck_pool (creator_bracket, legal);
