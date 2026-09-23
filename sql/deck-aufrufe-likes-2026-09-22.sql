-- Aufrufe und Likes für Decks: unter jedem Deck steht, wie oft andere Leute es angesehen haben
-- und wie vielen es gefällt. Im Supabase-Dashboard unter "SQL Editor" ausführen. Komplett
-- idempotent (alle "if not exists"/"create or replace"/"drop policy if exists" + "create
-- policy"-Paare sind gefahrlos mehrfach ausführbar).
--
-- Bewusst KEINE neuen Spalten an public.decks: ein Aufruf ist kein Update des Decks. Liefe der
-- Zähler über decks, müsste jede Leseansicht ein Update-Recht auf fremde Decks bekommen, und ein
-- updated_at-Trigger (oder ein künftiger) würde meistgesehene Decks an die Spitze der nach Datum
-- sortierten Listen schieben.

-- =====================================================================================
-- 1. Aufrufe: EIN Zähler je Deck, keine Zeile je Aufruf. Eine Zeile je Aufruf würde mit jedem
--    Öffnen wachsen, auf dem 500-MB-Free-Plan also genau in die falsche Richtung (siehe
--    sql/datenbankgroesse-pruefen-2026-09-20.sql) - und niemand fragt je, WER wann geschaut hat.
--    Direkter Zugriff auf die Tabelle ist für niemanden freigegeben; gezählt wird nur über
--    deck_register_view(), gelesen nur über deck_social_stats().
-- =====================================================================================
create table if not exists public.deck_view_counts (
  deck_id uuid primary key references public.decks(id) on delete cascade,
  views bigint not null default 0
);

comment on table public.deck_view_counts is
  'Wie oft andere Leute ein Deck geöffnet haben (der Besitzer zählt nicht). Geschrieben nur über deck_register_view().';

alter table public.deck_view_counts enable row level security;
-- Absichtlich keine Policy: ohne Policy sieht und schreibt über die REST-Schicht niemand etwas,
-- die beiden SECURITY-DEFINER-Funktionen unten sind der einzige Weg hinein und heraus.

-- =====================================================================================
-- 2. Likes: eine Zeile je (Deck, Nutzer) - der Primärschlüssel macht ein doppeltes Like
--    unmöglich, ohne dass der Client aufpassen muss.
-- =====================================================================================
create table if not exists public.deck_likes (
  deck_id uuid not null references public.decks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (deck_id, user_id)
);

comment on table public.deck_likes is
  'Likes unter einem Deck, höchstens eines je Nutzer. Das eigene Deck lässt sich nicht liken. Sichtbarkeit folgt decks.is_private.';

-- Für "welche Decks hat dieser Nutzer geliket" (liked_by_me in deck_social_stats) und das
-- Kaskaden-Löschen beim Löschen eines Accounts.
create index if not exists deck_likes_user_idx on public.deck_likes (user_id);

alter table public.deck_likes enable row level security;

-- SELECT wie das Deck selbst: nicht-private Decks für alle, das eigene immer.
drop policy if exists "Deck likes are readable like their deck" on public.deck_likes;
create policy "Deck likes are readable like their deck"
on public.deck_likes
for select
to public
using (
  exists (
    select 1 from public.decks d
    where d.id = deck_likes.deck_id
      and (not d.is_private or d.user_id = auth.uid())
  )
);

-- INSERT: nur eingeloggt, nur im eigenen Namen, nur ein Deck, das man sehen darf - und nicht das
-- eigene. Ein Like vom Besitzer selbst sagt nichts darüber, ob das Deck anderen gefällt.
-- Gelöschte Decks ("Grabsteine") sind ausgeschlossen, dort gibt es nichts mehr anzusehen.
drop policy if exists "Logged in users can like visible decks" on public.deck_likes;
create policy "Logged in users can like visible decks"
on public.deck_likes
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.decks d
    where d.id = deck_likes.deck_id
      and not d.is_private
      and d.deleted_at is null
      and d.user_id is distinct from auth.uid()
  )
);

-- DELETE: nur das eigene Like zurücknehmen.
drop policy if exists "Users can remove their own deck like" on public.deck_likes;
create policy "Users can remove their own deck like"
on public.deck_likes
for delete
to authenticated
using (user_id = auth.uid());

-- UPDATE: bewusst keine Policy - an einem Like gibt es nichts zu ändern.

-- =====================================================================================
-- 3. Einen Aufruf zählen. SECURITY DEFINER, weil auch nicht eingeloggte Besucher zählen sollen
--    und die Tabelle für niemanden direkt beschreibbar ist.
--    Nicht gezählt wird: der Besitzer selbst, private Decks (die sieht außer dem Besitzer ohnehin
--    niemand) und Grabsteine. Doppelte Zählung beim erneuten Öffnen desselben Decks verhindert
--    der Client je Sitzung (DeckSocialService) - eine echte Sperre gegen jemanden, der den
--    Zähler absichtlich hochtreiben will, ist das nicht, und das soll es für eine Zahl ohne
--    Folgen auch nicht sein.
-- =====================================================================================
create or replace function public.deck_register_view(p_deck_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.decks d
    where d.id = p_deck_id
      and not d.is_private
      and d.deleted_at is null
      and d.user_id is distinct from auth.uid()
  ) then
    return;
  end if;

  insert into public.deck_view_counts as v (deck_id, views)
  values (p_deck_id, 1)
  on conflict (deck_id) do update set views = v.views + 1;
end;
$$;

grant execute on function public.deck_register_view(uuid) to anon, authenticated;

-- =====================================================================================
-- 4. Aufrufe, Likes, "habe ich geliket" und der Name des Besitzers für mehrere Decks auf
--    einmal - die Deckliste im Profil und die Kacheln im öffentlichen Stöbern fragen so mit EINER
--    Anfrage für alle Decks der Seite, statt einmal je Zeile.
--    Die Sichtbarkeitsschranke steht in der Funktion: zu privaten fremden Decks kommt nichts
--    zurück. Decks ohne Aufrufe und Likes erscheinen mit 0/0 (left join), damit der Client nicht
--    zwischen "keine Zeile" und "null" unterscheiden muss.
--    Der Besitzername kommt beim LESEN aus profiles (Deck eines Accounts, ersatzweise dessen
--    Spielername aus players) bzw. players (Deck eines Spielers ohne eigenen Login) - gleiche Begründung wie bei deck_comments_for_deck():
--    public.profiles muss dafür nicht für "anon" offen sein, herausgegeben wird nur der
--    Anzeigename. Die ::text-Casts machen die Funktion vom Spaltentyp drüben unabhängig.
--
--    Das "drop function" davor ist nötig, weil eine erste Fassung dieser Funktion ohne die
--    Spalte owner_name existiert haben kann: "create or replace" darf den Rückgabetyp nicht
--    ändern und bricht sonst mit "cannot change return type of existing function" ab.
-- =====================================================================================
drop function if exists public.deck_social_stats(uuid[]);

create function public.deck_social_stats(p_deck_ids uuid[])
returns table (
  deck_id uuid,
  views bigint,
  likes bigint,
  liked_by_me boolean,
  owner_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    d.id,
    coalesce(v.views, 0),
    (select count(*) from public.deck_likes l where l.deck_id = d.id),
    exists (select 1 from public.deck_likes l where l.deck_id = d.id and l.user_id = auth.uid()),
    -- Reihenfolge: Profilname des Accounts, sonst der Spieler ohne Login, dem das Deck gehört,
    -- sonst der Name, unter dem der Account in einer Gruppe spielt (viele Accounts haben im
    -- Profil keinen Namen, nur als Spieler - gleiche Rückfallkette wie in DeckService).
    coalesce(
      nullif(btrim(p.display_name::text), ''),
      nullif(btrim(pl.display_name::text), ''),
      (
        select nullif(btrim(pu.display_name::text), '')
        from public.players pu
        where pu.user_id = d.user_id and nullif(btrim(pu.display_name::text), '') is not null
        limit 1
      )
    )
  from public.decks d
  left join public.deck_view_counts v on v.deck_id = d.id
  left join public.profiles p on p.id = d.user_id
  left join public.players pl on pl.id = d.player_id
  where d.id = any(p_deck_ids)
    and (not d.is_private or d.user_id = auth.uid());
$$;

grant execute on function public.deck_social_stats(uuid[]) to anon, authenticated;

-- =====================================================================================
-- 5. PostgREST seinen Schema-Cache neu lesen lassen - sonst antwortet die REST-Schicht noch
--    minutenlang mit PGRST202, und die App hält das für eine fehlende Migration (siehe
--    DeckSocialService.istFehlendeMigration()).
-- =====================================================================================
notify pgrst, 'reload schema';
