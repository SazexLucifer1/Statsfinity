-- Eigene (selbst erstellte) Commander - Karten, die es bei Scryfall nicht gibt.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent.
--
-- Ein Spieler der Gruppe spielt einen selbst gebauten Commander. Partien speichern den Commander
-- ohnehin nur als Namen (match_players.commander_name), Statistiken rechnen mit diesem Namen.
-- Was fehlte, ist nur: die Auswahl (bisher nur Scryfall-Vorschläge) und Farben/Bild, die die App
-- sonst aus Scryfall nachschlägt. Genau das hält diese Tabelle - eine Zeile je Commander, keine
-- Kopie in Decks oder Partien.
--
-- Lesen darf jeder (auch ohne Login), wie bei Decks und öffentlichen Profilen: sonst stünde im
-- öffentlichen Profil des Kollegen ein Commander ohne Farben und ohne Bild.
-- Anlegen darf jeder Eingeloggte, ändern und löschen nur, wer ihn angelegt hat.

create table if not exists public.custom_commanders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color_identity text[] not null default '{}',
  image_url text,
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint custom_commanders_name_not_blank check (length(btrim(name)) > 0),
  constraint custom_commanders_colors_valid check (color_identity <@ array['W', 'U', 'B', 'R', 'G']::text[])
);

-- Der Name ist der Schlüssel, mit dem Partien und Statistiken rechnen - zweimal derselbe Name mit
-- verschiedenen Farben wäre nicht auseinanderzuhalten.
create unique index if not exists custom_commanders_name_key on public.custom_commanders (lower(btrim(name)));

alter table public.custom_commanders enable row level security;

drop policy if exists "Custom commanders are readable by anyone" on public.custom_commanders;
create policy "Custom commanders are readable by anyone"
on public.custom_commanders for select to anon, authenticated using (true);

drop policy if exists "Users create custom commanders" on public.custom_commanders;
create policy "Users create custom commanders"
on public.custom_commanders for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "Creators update their custom commanders" on public.custom_commanders;
create policy "Creators update their custom commanders"
on public.custom_commanders for update to authenticated
using (created_by = auth.uid()) with check (created_by = auth.uid());

drop policy if exists "Creators delete their custom commanders" on public.custom_commanders;
create policy "Creators delete their custom commanders"
on public.custom_commanders for delete to authenticated using (created_by = auth.uid());

grant select on public.custom_commanders to anon, authenticated;
grant insert, update, delete on public.custom_commanders to authenticated;

-- =====================================================================================
-- Bilder: eigener Bucket, öffentlich lesbar, Schreiben nur in den Ordner der eigenen Benutzer-ID.
-- Wenn der SQL-Editor bei den Policies "must be owner of table objects" meldet, die Policies im
-- Dashboard unter Storage -> custom-commander-images -> Policies mit denselben Bedingungen anlegen.
-- =====================================================================================
insert into storage.buckets (id, name, public)
values ('custom-commander-images', 'custom-commander-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Custom commander images are readable by anyone" on storage.objects;
create policy "Custom commander images are readable by anyone"
on storage.objects for select to public
using (bucket_id = 'custom-commander-images');

drop policy if exists "Users upload their own custom commander images" on storage.objects;
create policy "Users upload their own custom commander images"
on storage.objects for insert to authenticated
with check (bucket_id = 'custom-commander-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users delete their own custom commander images" on storage.objects;
create policy "Users delete their own custom commander images"
on storage.objects for delete to authenticated
using (bucket_id = 'custom-commander-images' and (storage.foldername(name))[1] = auth.uid()::text);
