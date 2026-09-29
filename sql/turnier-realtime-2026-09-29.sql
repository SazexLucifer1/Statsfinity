-- Turniere per Realtime statt Polling: die App fragte jede Gruppe alle 2 Sekunden nach einem
-- Turnier ab, auch wenn keins lief. Jetzt meldet Supabase Änderungen an den Turnier-Tabellen
-- direkt, die App lädt nur dann nach (plus ein seltener Sicherheits-Poll).
--
-- Im Supabase-Dashboard unter "SQL Editor" ausführen, komplett idempotent. Ohne dieses Skript
-- funktioniert die App weiter, sieht Änderungen anderer Geräte aber erst beim Sicherheits-Poll.
--
-- Die Rechte ändern sich nicht: Realtime liefert jedem Abonnenten nur Zeilen, die er laut RLS
-- lesen darf.

do $$
declare
  t text;
begin
  foreach t in array array[
    'tournaments',
    'tournament_participants',
    'tournament_rounds',
    'tournament_matches',
    'tournament_match_players'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Prüfen:
-- select tablename from pg_publication_tables
-- where pubname = 'supabase_realtime' and tablename like 'tournament%';
