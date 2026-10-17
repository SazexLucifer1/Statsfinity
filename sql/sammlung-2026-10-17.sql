-- Sammlung: welche Karten jemand besitzt, je Druck, Sprache und Foil, mit Anzahl.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent.
--
-- Client: src/app/collection.service.ts, Anzeige in src/app/collection-panel/ (Profil),
-- Abgleich mit Decks in src/app/deck-collection/ (Deck-Ansicht), Scanner in src/app/card-scanner/.
--
-- KLEIN GEHALTEN, weil die Datenbank am 500-MB-Limit des Free-Plans hängt:
--   * Eine Zeile je (Besitzer, Druck, Foil) - nicht je Exemplar. 4 Sol Ringe sind eine Zeile mit
--     quantity 4.
--   * KEINE Kartendaten-Kopie: Bild, Regeltext und Typzeile kennt Scryfall. Die Bild-Adresse lässt
--     sich aus der Druck-ID bauen (cards.scryfall.io/normal/front/a/b/<id>.jpg), deshalb steht nur
--     die ID hier. card_name (englisch, wie in deck_cards) steht trotzdem da, weil der Abgleich mit
--     den Decks über den Namen läuft und sonst jede Deck-Ansicht erst die ganze Sammlung bei
--     Scryfall nachschlagen müsste. illustration_id aus demselben Grund für "genau dieses Artwork".
--   * Rund 120 Byte je Zeile - eine Sammlung mit 10.000 verschiedenen Drucken kostet ~1,5 MB.
--
-- Die Druck-ID trägt bei Scryfall Set, Nummer UND Sprache: Die deutsche und die englische Fassung
-- desselben Drucks haben verschiedene IDs. lang/set_code/collector_number stehen nur zum Filtern
-- und Sortieren ohne Scryfall-Anfrage mit drin.

create table if not exists public.collection_cards (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  scryfall_id uuid not null,
  foil boolean not null default false,
  card_name text not null,
  lang text not null default 'en',
  set_code text not null default '',
  collector_number text not null default '',
  illustration_id uuid,
  quantity smallint not null check (quantity between 1 and 999),
  added_at timestamptz not null default now(),
  primary key (user_id, scryfall_id, foil)
);

comment on table public.collection_cards is
  'Kartensammlung je Nutzer: eine Zeile je Druck (Scryfall-ID, enthält Set/Nummer/Sprache) und Foil, mit Anzahl. Keine Kartendaten-Kopie, siehe sql/sammlung-2026-10-17.sql.';
comment on column public.collection_cards.card_name is
  'Englischer Kartenname wie in deck_cards.card_name - Schlüssel für den Abgleich mit Decks.';
comment on column public.collection_cards.illustration_id is
  'Scryfalls illustration_id: gleiches Artwork über Sprachen und Nachdrucke hinweg. Grundlage der strengen Artwork-Prüfung.';

alter table public.collection_cards enable row level security;

-- Lesen: der Besitzer und seine Freunde (Entscheidung des Users, 17.10.2026). are_friends() aus
-- sql/freunde-2026-10-04.sql ist SECURITY DEFINER, ruft also keine Policy dieser Tabelle auf.
drop policy if exists "Collection readable by owner and friends" on public.collection_cards;
create policy "Collection readable by owner and friends"
on public.collection_cards
for select
to authenticated
using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));

drop policy if exists "Collection writable by owner" on public.collection_cards;
create policy "Collection writable by owner"
on public.collection_cards
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- =====================================================================================
-- Deck-Einstellung: "genau das gewählte Artwork" oder "egal welches".
-- Eine Spalte an decks wie beim Primer - keine neue Policy, Schreiben folgt dem Update-Recht.
-- =====================================================================================
alter table public.decks add column if not exists collection_strict_art boolean not null default false;

comment on column public.decks.collection_strict_art is
  'Sammlungs-Abgleich: true = eine Karte zählt nur als vorhanden, wenn das im Deck gewählte Artwork (illustration_id) in der Sammlung liegt; false = jedes Artwork zählt.';

-- =====================================================================================
-- Welche Karten stecken in welchen eigenen Decks? Für "du hast 2, brauchst aber 3 (in 3 Decks)".
-- Als EIN jsonb-Wert statt als Zeilenmenge: PostgREST schneidet Zeilen bei max_rows (1000) ab,
-- und 20 Decks à 100 Karten sind schon 2000 Zeilen. Ohne SECURITY DEFINER - es gelten die
-- Rechte von decks/deck_cards, und es geht ohnehin nur um die eigenen Decks.
-- Maybeboard und Marken zählen nicht (wie bei der Bannliste), Grabsteine auch nicht.
-- =====================================================================================
create or replace function public.collection_deck_usage()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_array(d.id, d.name, c.card_name, c.quantity, c.image_url)), '[]'::jsonb)
    from public.decks d
    join public.deck_cards c on c.deck_id = d.id
   where d.user_id = auth.uid()
     and d.deleted_at is null
     and not coalesce(c.is_maybeboard, false)
     and not coalesce(c.is_token, false);
$$;

grant execute on function public.collection_deck_usage() to authenticated;

-- =====================================================================================
-- Artwork-Fingerabdrücke für den Kartenscanner: KEINE Tabelle, eine Datei im Storage.
-- Rund 55.000 Artworks à 24 Byte (8 Byte Fingerabdruck + 16 Byte Scryfall-ID) = ~1,3 MB. Als
-- Tabelle wären es mit Zeilenkopf und Index gut 6 MB, und der Scanner braucht ohnehin immer ALLE
-- auf einmal im Browser. Geschrieben vom Nachtlauf (scripts/sync-card-art-hashes.mjs) mit dem
-- Service-Role-Key, der RLS umgeht - deshalb nur eine Lese-Policy.
-- =====================================================================================
insert into storage.buckets (id, name, public)
values ('card-art-hashes', 'card-art-hashes', true)
on conflict (id) do update set public = true;

drop policy if exists "Card art hashes are readable by anyone" on storage.objects;
create policy "Card art hashes are readable by anyone"
on storage.objects
for select
to public
using (bucket_id = 'card-art-hashes');
