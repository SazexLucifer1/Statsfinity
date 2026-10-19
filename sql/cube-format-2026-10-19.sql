-- Cube-Builder: Format je Cube (Wunsch des Users, 19.10.2026). Im Supabase-Dashboard unter
-- "SQL Editor" ausführen; idempotent. Setzt sql/cubes-2026-10-17.sql voraus.
--
-- format = der Wert aus DECK_FORMATS (z. B. 'Commander', 'Pauper'), NULL = freier Modus ohne
-- Einschränkung. Die Kartenauswahl im Cube schlägt dann nur Karten vor, die in diesem Format legal
-- sind. Reine Client-Regel wie collection_only: Eine Karte, die später gebannt wird, fällt nicht
-- aus dem Cube.
alter table public.cube_lists add column if not exists format text;

comment on column public.cube_lists.format is
  'Format des Cubes wie decks.format (DECK_FORMATS); NULL = freier Modus. Steuert nur die Kartenvorschläge.';
