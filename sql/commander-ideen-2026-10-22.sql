-- Commander-Ideen: eine private Merkliste von Commandern (auch Partner-Paaren), aus denen man
-- vielleicht einmal ein Deck baut (Wunsch eines Spielers, 22.10.2026). Eigene Seite
-- (commander-ideas-view/), geöffnet über den Reiter "Ideen" im eigenen Profil; hinzufügen auch aus
-- jeder Kartenvorschau ("Als Commander-Idee merken").
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent.
--
-- Nur der Besitzer sieht und ändert seine Liste (Entscheidung des Users). Eine Zeile je Idee,
-- keine Kartendaten-Kopie - Bild und Typzeile kommen wie überall aus dem Karten-Cache.
-- Zurück zum alten Stand: die Tabelle löschen.

create table if not exists public.commander_ideas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  commander text not null,
  partner text,
  note text not null default '' check (char_length(note) <= 200),
  position integer not null default 0,
  created_at timestamptz not null default now()
);

-- Dieselbe Idee (Commander, ggf. mit demselben Partner) nur einmal je Person.
create unique index if not exists commander_ideas_unique
  on public.commander_ideas (user_id, lower(commander), lower(coalesce(partner, '')));

alter table public.commander_ideas enable row level security;

drop policy if exists "Commander ideas belong to their owner" on public.commander_ideas;
create policy "Commander ideas belong to their owner"
on public.commander_ideas
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

grant select, insert, update, delete on public.commander_ideas to authenticated;

notify pgrst, 'reload schema';
