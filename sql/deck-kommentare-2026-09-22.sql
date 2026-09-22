-- Kommentarfunktion für Decks: andere Leute können unter einem Deck, das sie sich ansehen, etwas
-- hinterlassen - eine Ebene Antworten darunter. Im Supabase-Dashboard unter "SQL Editor"
-- ausführen. Komplett idempotent (alle "if not exists"/"create or replace"/"drop policy if exists"
-- + "create policy"-Paare sind gefahrlos mehrfach ausführbar).
--
-- Sichtbarkeit folgt exakt der des Decks (sql/public-deck-browse-2026-08-26.sql): Kommentare unter
-- einem nicht-privaten Deck darf JEDER lesen, auch ohne Login - passend dazu, dass das Deck selbst
-- öffentlich lesbar ist. Schreiben darf nur, wer eingeloggt ist.
--
-- Gelöschte Decks ("Grabsteine", siehe DeckService.deleteDeck()) haben keine Kartenliste mehr zum
-- Ansehen und tauchen weder in der Deck-Liste noch in der öffentlichen Suche auf - ihre Kommentare
-- sind damit unerreichbar, aber harmlos: sie hängen per Fremdschlüssel an der decks-Zeile und
-- verschwinden erst, wenn die wirklich gelöscht wird.

-- =====================================================================================
-- 1. Tabelle. parent_id ist die Antwort-Verknüpfung; NULL = Kommentar erster Ebene.
--    Bewusst KEINE display_name-Spalte (anders als public.feedback): ein beim Schreiben
--    eingefrorener Name wäre nach der nächsten Profil-Umbenennung falsch, und zwar dauerhaft.
--    Der Name kommt stattdessen beim Lesen aus profiles - siehe die Funktion in §4.
-- =====================================================================================
create table if not exists public.deck_comments (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references public.decks(id) on delete cascade,
  -- Löscht man einen Kommentar erster Ebene, gehen seine Antworten mit - eine Antwort ohne die
  -- Frage darüber stünde sonst zusammenhanglos in der Liste.
  parent_id uuid references public.deck_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint deck_comments_body_laenge check (char_length(btrim(body)) between 1 and 2000)
);

comment on table public.deck_comments is
  'Kommentare unter einem Deck, eine Antwort-Ebene tief (parent_id). Sichtbarkeit folgt decks.is_private, siehe RLS unten.';

-- Die Leseabfrage holt immer alle Kommentare EINES Decks, ältester zuerst.
create index if not exists deck_comments_deck_idx on public.deck_comments (deck_id, created_at);
-- Für das Kaskaden-Löschen der Antworten und den Selbstbezug in der Tiefenprüfung unten.
create index if not exists deck_comments_parent_idx on public.deck_comments (parent_id);

-- =====================================================================================
-- 2. Genau EINE Antwort-Ebene, serverseitig erzwungen. Der Client bietet an einer Antwort kein
--    weiteres Antwortfeld an, aber das ist nur die Oberfläche - ohne diesen Trigger könnte ein
--    direkter API-Aufruf beliebig tief schachteln, und die Anzeige (Kommentar + flache
--    Antwortliste) würde solche Kommentare schlicht nie zeigen.
--    Zweite Prüfung: die Antwort muss am selben Deck hängen wie der Kommentar, auf den sie
--    antwortet - sonst ließe sich ein Kommentar unter ein fremdes Deck einschmuggeln.
-- =====================================================================================
create or replace function public.deck_comments_pruefe_tiefe()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent record;
begin
  if new.parent_id is null then
    return new;
  end if;

  select c.parent_id, c.deck_id into v_parent
  from public.deck_comments c
  where c.id = new.parent_id;

  if not found then
    raise exception 'parent comment not found';
  end if;

  if v_parent.parent_id is not null then
    raise exception 'replies to replies are not allowed';
  end if;

  if v_parent.deck_id <> new.deck_id then
    raise exception 'reply must belong to the same deck';
  end if;

  return new;
end;
$$;

drop trigger if exists deck_comments_tiefe on public.deck_comments;
create trigger deck_comments_tiefe
  before insert or update on public.deck_comments
  for each row execute function public.deck_comments_pruefe_tiefe();

-- =====================================================================================
-- 3. RLS.
--
--    SELECT: wie decks selbst - jedes nicht-private Deck ist öffentlich lesbar, das eigene immer.
--    INSERT: nur eingeloggt, nur in eigenem Namen, nur unter ein Deck, das man auch sehen darf.
--    DELETE: Verfasser, Deck-Besitzer (räumt unter seinem eigenen Deck auf) und Developer
--            (globale Moderation, dasselbe profiles.is_developer wie die Feedback-Inbox).
--    UPDATE: bewusst KEINE Policy - Kommentare lassen sich nicht nachträglich ändern. Ein
--            stillschweigend umgeschriebener Kommentar unter fremdem Deck ist genau das, was man
--            hier nicht will; wer sich vertippt, löscht und schreibt neu.
-- =====================================================================================
alter table public.deck_comments enable row level security;

drop policy if exists "Deck comments are readable like their deck" on public.deck_comments;
create policy "Deck comments are readable like their deck"
on public.deck_comments
for select
to public
using (
  exists (
    select 1 from public.decks d
    where d.id = deck_comments.deck_id
      and (not d.is_private or d.user_id = auth.uid())
  )
);

drop policy if exists "Logged in users can write deck comments" on public.deck_comments;
create policy "Logged in users can write deck comments"
on public.deck_comments
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.decks d
    where d.id = deck_comments.deck_id
      and (not d.is_private or d.user_id = auth.uid())
  )
);

drop policy if exists "Author owner or developer can delete deck comments" on public.deck_comments;
create policy "Author owner or developer can delete deck comments"
on public.deck_comments
for delete
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1 from public.decks d
    where d.id = deck_comments.deck_id and d.user_id = auth.uid()
  )
  or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and coalesce(p.is_developer, false)
  )
);

-- =====================================================================================
-- 4. Leseabfrage als Funktion statt als direkter Tabellenzugriff: ein Kommentar soll mit
--    Anzeigename und Avatar aus profiles erscheinen, und zwar auch für nicht eingeloggte
--    Besucher. Ob public.profiles für "anon" lesbar ist, ist eine Entscheidung der
--    profiles-Policies und soll für diese Funktion hier nicht gelten müssen - deshalb SECURITY
--    DEFINER mit fest gesetztem search_path (gleiche Konvention wie deck_public_stats(),
--    join_group_by_code()).
--
--    Die Sichtbarkeitsschranke steht deshalb IN der Funktion: ist das Deck privat und gehört es
--    nicht dem Aufrufer, kommt gar nichts zurück. Herausgegeben werden nur Anzeigename und Avatar
--    - nie die E-Mail oder sonst etwas aus profiles.
-- =====================================================================================
create or replace function public.deck_comments_for_deck(p_deck_id uuid)
returns table (
  id uuid,
  parent_id uuid,
  user_id uuid,
  body text,
  created_at timestamptz,
  display_name text,
  avatar_url text
)
language sql
stable
security definer
set search_path = public
as $$
  -- Die ::text-Casts sind kein Schmuck: public.profiles wird NICHT von diesem Repo angelegt, seine
  -- Spaltentypen stehen also nirgends hier. Ist display_name/avatar_url dort "character varying"
  -- statt "text", lehnt Postgres das CREATE mit "return type mismatch in function declared to
  -- return record ... returns character varying instead of text" ab - die Funktion entsteht gar
  -- nicht erst, und die App sieht danach nur ein PGRST202, das wie eine vergessene Migration
  -- aussieht. Der Cast ist bei "text" ein No-Op und macht die Funktion von der Deklaration drueben
  -- unabhaengig.
  select
    c.id,
    c.parent_id,
    c.user_id,
    c.body::text,
    c.created_at,
    p.display_name::text,
    p.avatar_url::text
  from public.deck_comments c
  left join public.profiles p on p.id = c.user_id
  where c.deck_id = p_deck_id
    and exists (
      select 1 from public.decks d
      where d.id = p_deck_id
        and (not d.is_private or d.user_id = auth.uid())
    )
  order by c.created_at;
$$;

grant execute on function public.deck_comments_for_deck(uuid) to anon, authenticated;

-- =====================================================================================
-- 5. PostgREST seinen Schema-Cache neu lesen lassen. Ohne das kennt die REST-Schicht eine gerade
--    angelegte Funktion unter Umstaenden minutenlang nicht und antwortet mit PGRST202 - von der
--    App nicht zu unterscheiden von "Migration vergessen", weil sie genau daran ihren
--    Abschalter festmacht (siehe DeckCommentService.istFehlendeMigration()).
-- =====================================================================================
notify pgrst, 'reload schema';
