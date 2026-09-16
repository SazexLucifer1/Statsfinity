-- "Wie viele spielbeendende Combos stecken vollstaendig in diesem Deck?" - als Datenbankfunktion.
-- Im Supabase-SQL-Editor ausfuehren. Idempotent.
--
-- WOZU: Der Stapellauf ueber 48.638 fremde Decks hat gezeigt, dass genau diese Zahl zusammen mit
-- der Tutorenzahl die Bracket-Stufen am schaerfsten trennt (siehe Urteil F in src/app/bracket.ts).
-- Damit die App dieselbe Rechnung fuer ein einzelnes Deck anstellen kann, braucht sie dieselbe
-- Frage - und die laesst sich mit PostgREST-Filtern nicht stellen: Gesucht sind Combos, deren
-- KARTENLISTE VOLLSTAENDIG in der Deckliste enthalten ist.
--
-- Als Funktion und nicht als Abfrage aus dem Browser, aus einem zweiten Grund: Die Deckliste hat
-- rund hundert Kartennamen. Als Filter in der Adresszeile waeren das mehrere Kilobyte URL; als
-- Funktionsaufruf gehen sie im Rumpf der Anfrage mit.
--
-- security invoker + stable: Die Funktion liest nur spellbook_winning_combos, und die ist ohnehin
-- fuer jeden lesbar (oeffentliche Kartendaten von Commander Spellbook). Sie verschafft also keinen
-- Zugriff, den der Aufrufer nicht sowieso haette.
--
-- SETZT VORAUS, dass sql/spellbook-winning-combos-matview-2026-09-16.sql gelaufen ist.

create or replace function public.winning_combos_in_deck(
  deck_names text[],
  commander_names text[] default '{}'::text[]
)
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::integer
  from public.spellbook_winning_combos c
  -- "<@" heisst "ist enthalten in": JEDE Karte der Combo muss im Deck liegen. Andersherum
  -- ("@>") waere die Frage "enthaelt die Combo alle Deckkarten" - also Unsinn.
  where c.card_names <@ deck_names
    -- Rund vierzig Combos verlangen eine bestimmte Karte in der Kommandozone. Ein leeres Array
    -- ist in jedem Array enthalten, Combos ohne diese Bedingung fallen also nie durch.
    and c.commander_required <@ commander_names;
$$;

comment on function public.winning_combos_in_deck(text[], text[]) is
  'Zahl der Combos aus spellbook_winning_combos, die vollstaendig in dieser Deckliste stecken. Grundlage von Urteil F in src/app/bracket.ts.';

grant execute on function public.winning_combos_in_deck(text[], text[]) to anon, authenticated;
