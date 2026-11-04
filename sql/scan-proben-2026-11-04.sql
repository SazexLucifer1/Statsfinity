-- Scan-Proben: echte Kamerabilder des Kartenscanners samt Ergebnis und späterer Korrektur, damit
-- sich Änderungen am Scanner gegen echte Fälle nachmessen lassen statt gegen einzelne Screenshots
-- (Wunsch des Users, 04.11.2026). Client: src/app/scan-sample.service.ts.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent.
--
-- Wer speichert: nur Developer, und nur mit eingeschaltetem Schalter im Scanner.
--
-- Wer liest: jeder, der die Adresse kennt. Der Bucket ist öffentlich, hat aber KEINE Lese-Policy
-- auf storage.objects - die Bilder lassen sich über ihre Adresse laden, aber nicht auflisten.
-- Das Verzeichnis (Tabelle scan_samples) ist dagegen lesbar, sonst fände eine spätere Session die
-- Bilder nicht: Es enthält nur Pfad, Erkennungsergebnis, Zwischenwerte und Korrektur, keine Bilder.
-- Gespeichert wird nur der Ausschnitt um den Scanner-Rahmen, nicht das ganze Kamerabild.
--
-- HINWEIS: Wenn der SQL-Editor bei den Policies "must be owner of table objects" meldet, die zwei
-- Storage-Policies im Dashboard unter Storage -> scan-samples -> Policies anlegen.

-- =====================================================================================
-- 1. Bucket (öffentlich lesbar über die Adresse, nicht auflistbar)
-- =====================================================================================
insert into storage.buckets (id, name, public)
values ('scan-samples', 'scan-samples', true)
on conflict (id) do update set public = true;

drop policy if exists "Developers upload scan samples" on storage.objects;
create policy "Developers upload scan samples"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'scan-samples'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.is_developer(auth.uid())
);

drop policy if exists "Developers delete their scan samples" on storage.objects;
create policy "Developers delete their scan samples"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'scan-samples'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.is_developer(auth.uid())
);

-- =====================================================================================
-- 2. Verzeichnis: eine Zeile je Scan
-- =====================================================================================
create table if not exists public.scan_samples (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- Kamerabild um den Rahmen (JPEG) und die Ecke in voller Auflösung, Pfade im Bucket
  image_path text not null,
  corner_path text,
  -- Rahmen in Anteilen des Bildes, wie ihn identify() bekommt
  guide jsonb,
  -- Erkannter Druck (null = nichts erkannt)
  result jsonb,
  -- Zwischenwerte (ScanDiagnostics in card-scan.service.ts)
  diagnostics jsonb,
  -- Spätere Korrektur in der Trefferliste: Sprache, Foil, gelöscht
  correction jsonb
);

create index if not exists scan_samples_created_at on public.scan_samples (created_at desc);

alter table public.scan_samples enable row level security;

drop policy if exists "Scan samples are readable by anyone" on public.scan_samples;
create policy "Scan samples are readable by anyone"
on public.scan_samples
for select
to anon, authenticated
using (true);

drop policy if exists "Developers add their scan samples" on public.scan_samples;
create policy "Developers add their scan samples"
on public.scan_samples
for insert
to authenticated
with check (user_id = auth.uid() and public.is_developer(auth.uid()));

drop policy if exists "Developers correct their scan samples" on public.scan_samples;
create policy "Developers correct their scan samples"
on public.scan_samples
for update
to authenticated
using (user_id = auth.uid() and public.is_developer(auth.uid()))
with check (user_id = auth.uid() and public.is_developer(auth.uid()));

drop policy if exists "Developers delete their scan samples" on public.scan_samples;
create policy "Developers delete their scan samples"
on public.scan_samples
for delete
to authenticated
using (user_id = auth.uid() and public.is_developer(auth.uid()));
