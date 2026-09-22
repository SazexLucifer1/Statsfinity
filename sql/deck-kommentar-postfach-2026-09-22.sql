-- Postfach für Deck-Kommentare: wer einen Kommentar auf eines seiner Decks bekommt oder eine
-- Antwort auf einen eigenen Kommentar, sieht das an einem Zähler, statt es zufällig zu entdecken.
-- Setzt sql/deck-kommentare-2026-09-22.sql voraus. Im Supabase-Dashboard unter "SQL Editor"
-- ausführen, komplett idempotent.
--
-- Bewusst KEINE eigene Benachrichtigungstabelle, die ein Trigger bei jedem Kommentar füllt: die
-- Nachrichten stehen bereits vollständig in deck_comments, eine zweite Kopie könnte davon nur
-- abweichen. Gespeichert wird deshalb allein, was schon GELESEN wurde (deck_comment_reads) - eine
-- Zeile je Klick statt eine je Kommentar, und beim Löschen eines Kommentars räumt der
-- Fremdschlüssel sie gleich mit weg.

-- =====================================================================================
-- 1. Was gelesen wurde. Nur gelesene Nachrichten stehen hier - "ungelesen" ist die Abwesenheit
--    einer Zeile, nicht ein Flag. Der Schlüssel ist ein uuid-Paar (32 Byte), nicht die
--    Text-Kombination, an der sich archidekt_deck_pool_cards und spellbook_combo_cards schon
--    einmal verhoben haben.
-- =====================================================================================
create table if not exists public.deck_comment_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  comment_id uuid not null references public.deck_comments(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, comment_id)
);

comment on table public.deck_comment_reads is
  'Welche Deck-Kommentare ein Nutzer im Postfach schon gelesen hat. Ungelesen = keine Zeile.';

alter table public.deck_comment_reads enable row level security;

drop policy if exists "Users read their own read markers" on public.deck_comment_reads;
create policy "Users read their own read markers"
on public.deck_comment_reads
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users set their own read markers" on public.deck_comment_reads;
create policy "Users set their own read markers"
on public.deck_comment_reads
for insert
to authenticated
with check (user_id = auth.uid());

-- Damit sich eine Nachricht auch wieder auf ungelesen setzen lässt (die App bietet es derzeit
-- nicht an, aber eine Policy nachzureichen ist teurer als sie gleich mitzunehmen).
drop policy if exists "Users clear their own read markers" on public.deck_comment_reads;
create policy "Users clear their own read markers"
on public.deck_comment_reads
for delete
to authenticated
using (user_id = auth.uid());

-- =====================================================================================
-- 2. Das Postfach. SECURITY DEFINER aus demselben Grund wie deck_comments_for_deck(): Anzeigename
--    und Avatar des Schreibers kommen aus profiles, das für den Leser selbst nicht offen ist.
--    Die Schranke steht dafür IN der Abfrage - geliefert wird ausschliesslich, was an auth.uid()
--    gerichtet ist.
--
--    Zwei Anlässe, eine Zeile je Kommentar:
--      'deck'  - jemand hat mein Deck kommentiert
--      'reply' - jemand hat auf meinen Kommentar geantwortet
--    Eine Antwort auf meinen Kommentar unter meinem eigenen Deck trifft beide Bedingungen und
--    erscheint trotzdem genau einmal, als 'reply' (das CASE entscheidet, nicht ein union).
--
--    Eigene Kommentare nie (c.user_id <> auth.uid()), und nichts zu geloeschten Decks: an einem
--    Grabstein haengt keine Kartenliste mehr, der Sprung ins Deck liefe ins Leere.
-- =====================================================================================
create or replace function public.deck_comment_inbox(p_limit integer default 50)
returns table (
  comment_id uuid,
  deck_id uuid,
  deck_name text,
  art text,
  author_id uuid,
  display_name text,
  avatar_url text,
  body text,
  created_at timestamptz,
  gelesen boolean
)
language sql
stable
security definer
set search_path = public
as $$
  -- ::text wie in deck_comments_for_deck(): die Spaltentypen von profiles/decks legt dieses Repo
  -- nicht fest, und ein "character varying" drueben liesse das CREATE mit "return type mismatch"
  -- scheitern.
  select
    c.id,
    c.deck_id,
    d.name::text,
    (case when eltern.user_id = auth.uid() then 'reply' else 'deck' end)::text,
    c.user_id,
    p.display_name::text,
    p.avatar_url::text,
    c.body::text,
    c.created_at,
    (r.comment_id is not null)
  from public.deck_comments c
  join public.decks d on d.id = c.deck_id
  left join public.deck_comments eltern on eltern.id = c.parent_id
  left join public.profiles p on p.id = c.user_id
  left join public.deck_comment_reads r on r.comment_id = c.id and r.user_id = auth.uid()
  where auth.uid() is not null
    and c.user_id <> auth.uid()
    and (d.user_id = auth.uid() or eltern.user_id = auth.uid())
    and d.deleted_at is null
  order by c.created_at desc
  limit greatest(coalesce(p_limit, 50), 0);
$$;

grant execute on function public.deck_comment_inbox(integer) to authenticated;

-- =====================================================================================
-- 3. Der Zähler für das Abzeichen an der Tab-Leiste. Er ruft bewusst die Funktion oben auf, statt
--    ihre where-Bedingung ein zweites Mal hinzuschreiben: zwei Fassungen derselben Regel laufen
--    auseinander, sobald jemand nur eine davon anfasst - dieselbe Falle, in die dieses Projekt bei
--    den Sieg-Mustern schon einmal getappt ist (siehe SIEG_MUSTER in goldfish-sim.ts).
--    Das hohe Limit ist kein Schätzwert, sondern heisst "alles": der Zähler darf nicht bei 50
--    stehenbleiben, nur weil die Liste dort abschneidet.
-- =====================================================================================
create or replace function public.deck_comment_unread_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from public.deck_comment_inbox(1000000) i where not i.gelesen;
$$;

grant execute on function public.deck_comment_unread_count() to authenticated;

-- =====================================================================================
-- 4. PostgREST seinen Schema-Cache neu lesen lassen - ohne das antwortet die REST-Schicht auf eine
--    frisch angelegte Funktion unter Umständen minutenlang mit PGRST202.
-- =====================================================================================
notify pgrst, 'reload schema';
