-- Server-seitige Suche für den Archidekt-Deckvorrat (Tabellen: archidekt-deck-pool-2026-09-15.sql).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- WARUM DAS NÖTIG WURDE: Die Developer-Ansicht hat bisher ALLE Decks geladen und im Browser
-- gefiltert. Das war für die ersten fünf Decks richtig und ist ab dem ersten großen Import falsch:
-- Supabase deckelt eine Antwort ohne limit auf 1.000 Zeilen, die App zeigte bei 10.005 Decks also
-- stillschweigend nur die ersten 1.000 - und hätte auch ohne die Deckelung 2 MB übers Handynetz
-- gezogen, nur um daraus eine Handvoll Treffer zu filtern. Suche und Bracket-Filter gehören
-- deshalb in die Abfrage.
--
-- Gesucht wird über Deckname UND Commander. Beides steht in einer vorberechneten, klein
-- geschriebenen Spalte, damit ein "ilike %begriff%" einen Index benutzen kann.

-- =====================================================================================
-- 1. pg_trgm: macht "ilike %mitten im text%" indizierbar.
--
--    Ein normaler B-Tree-Index hilft bei einem führenden % nicht - er kann nur Präfixe. Ein
--    GIN-Index über Trigramme kann es, und genau diese Suchform braucht die Ansicht ("lathril"
--    soll "It came from the woods | Lathril" finden).
-- =====================================================================================
create extension if not exists pg_trgm;

-- =====================================================================================
-- 2. Die Suchspalte.
--
--    Als generated column, damit sie nie aus dem Tritt geraten kann: Sie wird von Postgres bei
--    jedem insert/update mitgeschrieben, das Import-Skript muss nichts davon wissen.
--
--    Der Umweg über eine eigene Funktion ist nötig, weil array_to_string() nicht als immutable
--    gilt und Postgres in einer generated column nur immutable Ausdrücke erlaubt ("generation
--    expression is not immutable"). Die Hülle ist inhaltlich immutable - gleicher Name, gleiche
--    Commander, gleiches Ergebnis - und darf deshalb so markiert werden.
-- =====================================================================================
create or replace function public.archidekt_pool_search_text(p_name text, p_commanders text[])
returns text
language sql
immutable
as $$
  select lower(coalesce(p_name, '') || ' ' || coalesce(array_to_string(p_commanders, ' '), ''))
$$;

comment on function public.archidekt_pool_search_text(text, text[]) is
  'Baut den Suchtext aus Deckname und Commandern. Eigene Funktion, weil array_to_string() nicht als immutable gilt und eine generated column nur immutable Ausdrücke erlaubt.';

alter table public.archidekt_deck_pool
  add column if not exists search_text text
  generated always as (public.archidekt_pool_search_text(name, commander_names)) stored;

comment on column public.archidekt_deck_pool.search_text is
  'Deckname + Commander, klein geschrieben. Wird von Postgres selbst gepflegt. Ziel des ilike-Filters der Developer-Ansicht.';

create index if not exists archidekt_deck_pool_search_idx
  on public.archidekt_deck_pool using gin (search_text gin_trgm_ops);
