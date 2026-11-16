-- Antwort auf Feedback (Wunsch des Users, 16.11.2026)
--
-- Wer im Profil ein Feedback als erledigt markiert (nur Developer), kann der Person, die es
-- geschrieben hat, eine kurze Nachricht schicken ("gehört und umgesetzt, danke"). Die Nachricht
-- erscheint im Postfach oben im Profil und zählt im Abzeichen an der Tab-Leiste.
--
-- Bewusst KEINE eigene Tabelle: Zu einem Feedback gibt es genau eine Antwort, sie gehört an die
-- Zeile. Gelesen/ungelesen ist ein Zeitstempel an derselben Zeile.
--
-- Alles läuft über SECURITY-DEFINER-Funktionen, damit keine neue RLS-Policy auf `feedback`
-- nötig ist: Die Person liest nur ihre eigenen beantworteten Einträge, und nur der Developer
-- schreibt eine Antwort.
--
-- Die Feedback-ID wird als text verglichen (`id::text`), damit die Funktionen unabhängig vom
-- Spaltentyp der ID funktionieren.

alter table public.feedback
  add column if not exists reply_text text,
  add column if not exists replied_at timestamptz,
  add column if not exists reply_read_at timestamptz;

-- Erledigt markieren und (optional) antworten. Leere Antwort = nur erledigt, eine frühere
-- Antwort bleibt dann stehen.
create or replace function public.feedback_resolve(p_id text, p_reply text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reply text := nullif(btrim(coalesce(p_reply, '')), '');
begin
  if not public.is_developer(auth.uid()) then
    raise exception 'Nur Developer dürfen Feedback beantworten' using errcode = '42501';
  end if;

  update public.feedback
     set status = 'done',
         reply_text = coalesce(v_reply, reply_text),
         replied_at = case when v_reply is null then replied_at else now() end,
         reply_read_at = case when v_reply is null then reply_read_at else null end
   where id::text = p_id;
end;
$$;

-- Die eigenen beantworteten Feedbacks, neueste Antwort zuerst.
create or replace function public.feedback_my_replies(p_limit int default 20)
returns table (
  id text,
  category text,
  message text,
  reply_text text,
  replied_at timestamptz,
  gelesen boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select f.id::text, f.category::text, f.message, f.reply_text, f.replied_at, f.reply_read_at is not null
    from public.feedback f
   where f.user_id = auth.uid()
     and f.reply_text is not null
   order by f.replied_at desc nulls last
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

create or replace function public.feedback_reply_unread_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
    from public.feedback f
   where f.user_id = auth.uid()
     and f.reply_text is not null
     and f.reply_read_at is null;
$$;

create or replace function public.feedback_mark_replies_read(p_ids text[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.feedback
     set reply_read_at = now()
   where user_id = auth.uid()
     and reply_read_at is null
     and id::text = any(p_ids);
$$;

revoke all on function public.feedback_resolve(text, text) from public, anon;
revoke all on function public.feedback_my_replies(int) from public, anon;
revoke all on function public.feedback_reply_unread_count() from public, anon;
revoke all on function public.feedback_mark_replies_read(text[]) from public, anon;
grant execute on function public.feedback_resolve(text, text) to authenticated;
grant execute on function public.feedback_my_replies(int) to authenticated;
grant execute on function public.feedback_reply_unread_count() to authenticated;
grant execute on function public.feedback_mark_replies_read(text[]) to authenticated;
