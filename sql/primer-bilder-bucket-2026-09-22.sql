-- Bucket für eigene Bilder im Primer (siehe deck-primer/ und sql/deck-primer-2026-09-22.sql).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent.
--
-- Eigener Bucket statt des vorhandenen "deck-art": Dort liegen Kartenbilder, die ein Deck statt
-- der Scryfall-Edition anzeigt. Ein Primer-Bild ist etwas anderes - und wer später aufräumen will
-- ("welche Bilder hängen noch woran?"), müsste die beiden sonst am Dateinamen auseinanderhalten.
--
-- Öffentlich lesbar, weil der Primer es auch ist: Ein Bild, das nur Eingeloggte sehen, wäre in
-- einem öffentlich stöberbaren Deck ein leerer Rahmen.
--
-- Schreiben darf nur, wer eingeloggt ist, und nur in den Ordner mit der eigenen Benutzer-ID
-- (erster Pfadteil). Genau diesen Pfad baut DeckPrimerService.bildHochladen().
--
-- HINWEIS: Wenn der SQL-Editor bei den Policies "must be owner of table objects" meldet, fehlen
-- dem angemeldeten Rollen-Konto die Rechte auf storage.objects. Dann die drei Policies im
-- Dashboard unter Storage -> primer-images -> Policies mit denselben Bedingungen anlegen.

-- =====================================================================================
-- 1. Bucket
-- =====================================================================================
insert into storage.buckets (id, name, public)
values ('primer-images', 'primer-images', true)
on conflict (id) do update set public = true;

-- =====================================================================================
-- 2. Rechte. Lesen alle (auch ohne Login), schreiben/löschen nur im eigenen Ordner.
-- =====================================================================================
drop policy if exists "Primer images are readable by anyone" on storage.objects;
create policy "Primer images are readable by anyone"
on storage.objects
for select
to public
using (bucket_id = 'primer-images');

drop policy if exists "Users upload their own primer images" on storage.objects;
create policy "Users upload their own primer images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'primer-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users delete their own primer images" on storage.objects;
create policy "Users delete their own primer images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'primer-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);
