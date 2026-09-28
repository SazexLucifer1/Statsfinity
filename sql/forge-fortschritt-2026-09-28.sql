-- Fortschritt eines laufenden Forge-Auftrags: wie viele der Partien je Stufe schon gespielt sind.
-- Setzt sql/forge-einstufung-2026-09-28.sql voraus. Von Hand im Supabase-SQL-Editor ausführen.
--
-- Wozu: Ein Lauf dauert Stunden, und bisher stand in der App nur "läuft". Den Zählerstand gab es nur
-- im Log der vier GitHub-Runner, je Stufe ein eigener Job. Jetzt meldet jeder Runner nach jeder Partie
-- seinen Stand in die Auftragszeile, das Panel in der Deck-Ansicht zeigt ihn beim Aktualisieren.
--
-- Form: {"2": {"gespielt": 37, "geplant": 100, "siege": 9}, "3": {...}}
--
-- Warum eine Funktion statt eines PATCH auf die Spalte: Vier Runner schreiben gleichzeitig in dieselbe
-- Zeile. Ein PATCH ersetzt die ganze Spalte, und die Stufe, die zuletzt schreibt, löscht die Stände
-- der anderen. "fortschritt || {stufe: ...}" ändert nur den eigenen Schlüssel.
--
-- Keine neue Policy: Lesen läuft über "Developer lesen Forge-Aufträge", geschrieben wird nur mit dem
-- Service-Role-Key aus dem Workflow.

alter table public.forge_einstufung_auftraege
  add column if not exists fortschritt jsonb not null default '{}'::jsonb;

create or replace function public.forge_auftrag_fortschritt(
  p_id uuid,
  p_stufe int,
  p_gespielt int,
  p_geplant int,
  p_siege int
) returns jsonb
language sql
as $$
  update public.forge_einstufung_auftraege
  set fortschritt = fortschritt || jsonb_build_object(
    p_stufe::text,
    jsonb_build_object('gespielt', p_gespielt, 'geplant', p_geplant, 'siege', p_siege)
  )
  where id = p_id
  returning fortschritt;
$$;

revoke execute on function public.forge_auftrag_fortschritt(uuid, int, int, int, int) from public, anon, authenticated;
grant execute on function public.forge_auftrag_fortschritt(uuid, int, int, int, int) to service_role;
