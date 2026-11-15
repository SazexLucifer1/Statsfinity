-- Scan-Proben älterer Scanner-Fassungen löschen können (Wunsch des Users, 15.11.2026).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent.
--
-- Der Knopf "Alte Proben löschen" im Scanner (scan-sample.service.ts, deleteOld()) löscht erst
-- die Bilder über die Storage-API, dann die Zeilen in scan_samples. Supabase löscht über die
-- Storage-API nur, was man auch LESEN darf - der Bucket hat bewusst keine Lese-Policy (Bilder
-- über die Adresse ladbar, aber nicht auflistbar). Diese Policy gibt Developern das Lese-Recht
-- nur für den eigenen Ordner; für alle anderen bleibt der Bucket unauflistbar.
--
-- Betrifft ausschließlich die Proben (Kamerabilder zum Verbessern des Scanners) - die Sammlung
-- (collection_cards) wird davon nicht berührt.
--
-- HINWEIS: Meldet der SQL-Editor "must be owner of table objects", die Policy im Dashboard unter
-- Storage -> scan-samples -> Policies anlegen (SELECT, authenticated, Ausdruck wie unten).

drop policy if exists "Developers read their scan samples" on storage.objects;
create policy "Developers read their scan samples"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'scan-samples'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.is_developer(auth.uid())
);
