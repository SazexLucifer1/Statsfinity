-- Jahresquiz (Wunsch des Users, 28.11.2026): ein Live-Quiz zu den Statistiken des Jahres, z. B.
-- vor dem Jahresabschluss-Draft. Der Quizmaster (created_by) steuert auf seinem Gerät, die
-- Gruppenmitglieder antworten am eigenen Handy, Spieler ohne Handy trägt der Quizmaster ein.
--
-- Im Supabase-Dashboard unter "SQL Editor" ausführen, komplett idempotent. Ohne dieses Skript
-- zeigt die Quiz-Seite nur einen Hinweis.
--
-- Vier Tabellen:
--   year_quizzes           Fragen OHNE Lösung, Ablauf (status, current_index), aufgedeckte Lösungen
--   year_quiz_solutions    die Lösungen - nur der Quizmaster liest sie, sonst stünden sie im Handy
--   year_quiz_participants Teilnehmer je Quiz (mit Konto: user_id, ohne Handy: nur Name)
--   year_quiz_answers      eine Zeile je Teilnehmer und Frage
--
-- Rechte: Lesen jedes Gruppenmitglied, steuern und alles korrigieren nur der Quizmaster.
-- Teilnehmer schreiben nur die eigene Antwort und nur zur gerade offenen Frage.

create table if not exists public.year_quizzes (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  -- [{ "text": "...", "options": ["...", ...] }] - bewusst ohne richtige Antwort
  questions jsonb not null default '[]'::jsonb,
  status text not null default 'lobby'
    check (status in ('lobby', 'question', 'reveal', 'review', 'finished')),
  current_index integer not null default 0,
  -- aufgedeckte Lösungen, Index = Frage, null = noch nicht aufgedeckt
  revealed jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists year_quizzes_group_idx on public.year_quizzes (group_id, created_at desc);

create table if not exists public.year_quiz_solutions (
  quiz_id uuid primary key references public.year_quizzes(id) on delete cascade,
  -- [2, 0, 3, ...] - Index der richtigen Antwort je Frage
  solutions jsonb not null default '[]'::jsonb
);

create table if not exists public.year_quiz_participants (
  quiz_id uuid not null references public.year_quizzes(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  user_id uuid references auth.users(id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (quiz_id, name)
);

create unique index if not exists year_quiz_participants_user_idx
  on public.year_quiz_participants (quiz_id, user_id) where user_id is not null;

create table if not exists public.year_quiz_answers (
  quiz_id uuid not null,
  participant text not null,
  question_index integer not null check (question_index >= 0),
  choice integer not null check (choice >= 0),
  answered_at timestamptz not null default now(),
  primary key (quiz_id, participant, question_index),
  foreign key (quiz_id, participant)
    references public.year_quiz_participants (quiz_id, name) on delete cascade on update cascade
);

alter table public.year_quizzes enable row level security;
alter table public.year_quiz_solutions enable row level security;
alter table public.year_quiz_participants enable row level security;
alter table public.year_quiz_answers enable row level security;

-- Hilfsfunktionen (SECURITY DEFINER, damit die Policies der Kind-Tabellen nicht die Policy von
-- year_quizzes aufrufen - vgl. sql/fix-tournament-rls-recursion-2026-09-03.sql).
create or replace function public.year_quiz_member(p_quiz uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from year_quizzes q where q.id = p_quiz and is_group_member(q.group_id)
  );
$$;

create or replace function public.year_quiz_host(p_quiz uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from year_quizzes q where q.id = p_quiz and q.created_by = auth.uid());
$$;

create or replace function public.year_quiz_open_question(p_quiz uuid, p_index integer)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from year_quizzes q
    where q.id = p_quiz and q.status = 'question' and q.current_index = p_index
  );
$$;

-- year_quizzes
drop policy if exists year_quizzes_select on public.year_quizzes;
create policy year_quizzes_select on public.year_quizzes
  for select using (is_group_member(group_id));
drop policy if exists year_quizzes_insert on public.year_quizzes;
create policy year_quizzes_insert on public.year_quizzes
  for insert with check (created_by = auth.uid() and is_group_member(group_id));
drop policy if exists year_quizzes_update on public.year_quizzes;
create policy year_quizzes_update on public.year_quizzes
  for update using (created_by = auth.uid()) with check (created_by = auth.uid());
drop policy if exists year_quizzes_delete on public.year_quizzes;
create policy year_quizzes_delete on public.year_quizzes
  for delete using (created_by = auth.uid());

-- year_quiz_solutions: nur der Quizmaster
drop policy if exists year_quiz_solutions_all on public.year_quiz_solutions;
create policy year_quiz_solutions_all on public.year_quiz_solutions
  for all using (year_quiz_host(quiz_id)) with check (year_quiz_host(quiz_id));

-- year_quiz_participants
drop policy if exists year_quiz_participants_select on public.year_quiz_participants;
create policy year_quiz_participants_select on public.year_quiz_participants
  for select using (year_quiz_member(quiz_id));
drop policy if exists year_quiz_participants_insert on public.year_quiz_participants;
create policy year_quiz_participants_insert on public.year_quiz_participants
  for insert with check (
    year_quiz_host(quiz_id)
    or (user_id = auth.uid() and year_quiz_member(quiz_id))
  );
drop policy if exists year_quiz_participants_update on public.year_quiz_participants;
create policy year_quiz_participants_update on public.year_quiz_participants
  for update using (year_quiz_host(quiz_id)) with check (year_quiz_host(quiz_id));
drop policy if exists year_quiz_participants_delete on public.year_quiz_participants;
create policy year_quiz_participants_delete on public.year_quiz_participants
  for delete using (year_quiz_host(quiz_id) or user_id = auth.uid());

-- year_quiz_answers
drop policy if exists year_quiz_answers_select on public.year_quiz_answers;
create policy year_quiz_answers_select on public.year_quiz_answers
  for select using (year_quiz_member(quiz_id));

drop policy if exists year_quiz_answers_insert on public.year_quiz_answers;
create policy year_quiz_answers_insert on public.year_quiz_answers
  for insert with check (
    year_quiz_host(quiz_id)
    or (
      year_quiz_open_question(quiz_id, question_index)
      and exists (
        select 1 from year_quiz_participants p
        where p.quiz_id = year_quiz_answers.quiz_id
          and p.name = year_quiz_answers.participant
          and p.user_id = auth.uid()
      )
    )
  );

drop policy if exists year_quiz_answers_update on public.year_quiz_answers;
create policy year_quiz_answers_update on public.year_quiz_answers
  for update using (
    year_quiz_host(quiz_id)
    or (
      year_quiz_open_question(quiz_id, question_index)
      and exists (
        select 1 from year_quiz_participants p
        where p.quiz_id = year_quiz_answers.quiz_id
          and p.name = year_quiz_answers.participant
          and p.user_id = auth.uid()
      )
    )
  ) with check (
    year_quiz_host(quiz_id)
    or year_quiz_open_question(quiz_id, question_index)
  );

drop policy if exists year_quiz_answers_delete on public.year_quiz_answers;
create policy year_quiz_answers_delete on public.year_quiz_answers
  for delete using (year_quiz_host(quiz_id));

-- Realtime: Ablauf, Teilnehmer und Antworten sofort auf allen Geräten.
do $$
declare
  t text;
begin
  foreach t in array array['year_quizzes', 'year_quiz_participants', 'year_quiz_answers'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
