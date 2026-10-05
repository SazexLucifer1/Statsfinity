-- Freunde und Freundesspiele (Partien ohne Gruppe).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Entscheidung des Users (04.10.2026): Variante (b) - Freundesspiele sind echte Partien OHNE
-- Gruppe (matches.group_id = null), nicht eine versteckte persönliche Gruppe je Nutzer.
--
-- Was diese Datei anlegt:
--   1. friendships           - Anfrage (pending) und Freundschaft (accepted), eine Zeile je Paar.
--   2. are_friends(a, b)     - SECURITY DEFINER, für Policies und Funktionen.
--   3. matches.created_by    - wer eine gruppenlose Partie angelegt hat (darf sie ändern/löschen).
--      match_players.user_id - Account eines Teilnehmers einer gruppenlosen Partie; dort gibt es
--                              keine players-Zeile, die ist an eine Gruppe gebunden.
--   4. Policies für gruppenlose Partien. Die bestehenden Gruppen-Policies (is_group_member)
--      bleiben unangetastet - Policies sind ODER-verknüpft, für group_id = null greift nur die neue.
--      Die Prüfungen laufen über SECURITY-DEFINER-Hilfsfunktionen: Eine Policy auf matches, die
--      match_players liest, deren Policy wieder matches liest, endet in 42P17 (unendliche
--      Rekursion, siehe sql/fix-tournament-rls-recursion-2026-09-03.sql).
--   5. Funktionen: Profilsuche, Neuigkeiten von Freunden, Bilanz gegen einen Account,
--      Gesamtbilanz der Freunde.
--
-- Datenschutz: Die Profilsuche gibt nur Name und Bild heraus (dasselbe wie public_profile()),
-- und nur an eingeloggte Nutzer ab 2 Zeichen. Die Neuigkeiten zeigen Partien und öffentliche
-- Decks von Freunden - Partien sind seit sql/oeffentliche-matches-2026-09-23.sql ohnehin
-- öffentlich, private Decks bleiben draußen.

-- 1. Freundschaften -------------------------------------------------------------------------

create table if not exists public.friendships (
  requester uuid not null references auth.users (id) on delete cascade,
  addressee uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (requester, addressee),
  check (requester <> addressee)
);

-- Ein Paar nur einmal, egal wer gefragt hat.
create unique index if not exists friendships_pair_idx
  on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_addressee_idx on public.friendships (addressee);

alter table public.friendships enable row level security;

drop policy if exists "friendships: beteiligte lesen" on public.friendships;
create policy "friendships: beteiligte lesen" on public.friendships
  for select using (auth.uid() in (requester, addressee));

drop policy if exists "friendships: anfrage stellen" on public.friendships;
create policy "friendships: anfrage stellen" on public.friendships
  for insert with check (requester = auth.uid() and status = 'pending');

-- Annehmen darf nur, wer gefragt wurde - und nur auf accepted setzen.
drop policy if exists "friendships: annehmen" on public.friendships;
create policy "friendships: annehmen" on public.friendships
  for update using (addressee = auth.uid()) with check (addressee = auth.uid() and status = 'accepted');

-- Ablehnen, zurückziehen, entfreunden: beide Seiten.
drop policy if exists "friendships: beenden" on public.friendships;
create policy "friendships: beenden" on public.friendships
  for delete using (auth.uid() in (requester, addressee));

create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
     where f.status = 'accepted'
       and least(f.requester, f.addressee) = least(a, b)
       and greatest(f.requester, f.addressee) = greatest(a, b)
  );
$$;

grant execute on function public.are_friends(uuid, uuid) to authenticated;

-- 2. Gruppenlose Partien ---------------------------------------------------------------------

alter table public.matches alter column group_id drop not null;

alter table public.matches
  add column if not exists created_by uuid references auth.users (id) on delete set null;

comment on column public.matches.created_by is
  'Wer eine Freundesspiel-Partie (group_id = null) angelegt hat. Bei Gruppenpartien ungenutzt.';

alter table public.match_players
  add column if not exists user_id uuid references auth.users (id) on delete set null;

comment on column public.match_players.user_id is
  'Account eines Teilnehmers einer Freundesspiel-Partie (dort gibt es keine players-Zeile).';

create index if not exists match_players_user_id_idx on public.match_players (user_id) where user_id is not null;
create index if not exists matches_friend_game_idx on public.matches (created_by) where group_id is null;

-- Hilfsfunktionen (umgehen RLS, damit sich die Policies nicht gegenseitig aufrufen)

create or replace function public.can_see_friend_match(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.matches m
     where m.id = p_match_id
       and m.group_id is null
       and (
         m.created_by = auth.uid()
         or exists (select 1 from public.match_players mp where mp.match_id = m.id and mp.user_id = auth.uid())
       )
  );
$$;

create or replace function public.owns_friend_match(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.matches m
     where m.id = p_match_id and m.group_id is null and m.created_by = auth.uid()
  );
$$;

grant execute on function public.can_see_friend_match(uuid) to authenticated;
grant execute on function public.owns_friend_match(uuid) to authenticated;

drop policy if exists "freundesspiele: lesen" on public.matches;
create policy "freundesspiele: lesen" on public.matches
  for select using (group_id is null and public.can_see_friend_match(id));

drop policy if exists "freundesspiele: anlegen" on public.matches;
create policy "freundesspiele: anlegen" on public.matches
  for insert with check (group_id is null and created_by = auth.uid());

drop policy if exists "freundesspiele: ändern" on public.matches;
create policy "freundesspiele: ändern" on public.matches
  for update using (group_id is null and created_by = auth.uid())
  with check (group_id is null and created_by = auth.uid());

drop policy if exists "freundesspiele: löschen" on public.matches;
create policy "freundesspiele: löschen" on public.matches
  for delete using (group_id is null and created_by = auth.uid());

drop policy if exists "freundesspiele: teilnehmer lesen" on public.match_players;
create policy "freundesspiele: teilnehmer lesen" on public.match_players
  for select using (public.can_see_friend_match(match_id));

-- Mitspieler dürfen nur man selbst, Freunde oder Gäste ohne Account sein.
drop policy if exists "freundesspiele: teilnehmer anlegen" on public.match_players;
create policy "freundesspiele: teilnehmer anlegen" on public.match_players
  for insert with check (
    public.owns_friend_match(match_id)
    and player_id is null
    and (user_id is null or user_id = auth.uid() or public.are_friends(auth.uid(), user_id))
  );

drop policy if exists "freundesspiele: teilnehmer ändern" on public.match_players;
create policy "freundesspiele: teilnehmer ändern" on public.match_players
  for update using (public.owns_friend_match(match_id)) with check (public.owns_friend_match(match_id));

drop policy if exists "freundesspiele: teilnehmer löschen" on public.match_players;
create policy "freundesspiele: teilnehmer löschen" on public.match_players
  for delete using (public.owns_friend_match(match_id));

-- 3. Funktionen ------------------------------------------------------------------------------

-- Profilsuche zum Hinzufügen. Nur eingeloggt, ab 2 Zeichen, höchstens 15 Treffer.
create or replace function public.search_profiles(p_query text)
returns table (id uuid, display_name text, avatar_url text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.display_name::text, p.avatar_url::text
    from public.profiles p
   where auth.uid() is not null
     and length(btrim(coalesce(p_query, ''))) >= 2
     and p.id <> auth.uid()
     and p.display_name ilike '%' || replace(replace(btrim(p_query), '%', ''), '_', '') || '%'
   order by (lower(p.display_name) = lower(btrim(p_query))) desc, length(p.display_name), p.display_name
   limit 15;
$$;

grant execute on function public.search_profiles(text) to authenticated;

-- Freundesliste samt Anfragen, mit Name und Bild aus profiles (dort für Fremde sonst gesperrt).
create or replace function public.my_friendships()
returns table (other_id uuid, display_name text, avatar_url text, status text, incoming boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select case when f.requester = auth.uid() then f.addressee else f.requester end,
         p.display_name::text,
         p.avatar_url::text,
         f.status,
         f.addressee = auth.uid(),
         f.created_at
    from public.friendships f
    join public.profiles p on p.id = case when f.requester = auth.uid() then f.addressee else f.requester end
   where auth.uid() in (f.requester, f.addressee)
   order by f.status desc, p.display_name;
$$;

grant execute on function public.my_friendships() to authenticated;

-- Alle Accounts, die an einer Partie teilgenommen haben (Gruppe über players, Freundesspiel direkt).
create or replace function public.match_participant_users(p_match_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(mp.user_id, pl.user_id)
    from public.match_players mp
    left join public.players pl on pl.id = mp.player_id
   where mp.match_id = p_match_id
     and coalesce(mp.user_id, pl.user_id) is not null;
$$;

revoke execute on function public.match_participant_users(uuid) from public, anon, authenticated;

-- Neuigkeiten von Freunden: letzte Partien (aus allen Gruppen und Freundesspielen) und neue
-- öffentliche Decks. Eine Zeile je Ereignis, neueste zuerst.
create or replace function public.friend_activity(p_limit integer default 30)
returns table (
  kind text,            -- 'match' | 'deck'
  happened_at timestamptz,
  friend_id uuid,
  friend_name text,
  match_id uuid,
  game_mode text,
  game_format text,
  won boolean,
  player_count integer,
  deck_id uuid,
  deck_name text,
  commander text
)
language sql
stable
security definer
set search_path = public
as $$
  with freunde as (
    select case when f.requester = auth.uid() then f.addressee else f.requester end as id
      from public.friendships f
     where f.status = 'accepted' and auth.uid() in (f.requester, f.addressee)
  ),
  teilnahmen as (
    select m.id as match_id, m.played_at, m.game_mode::text as game_mode, to_jsonb(m)->>'game_format' as game_format,
           m.winner_name, fr.id as friend_id, mp.player_name, mp.team, mp.is_archenemy,
           (select count(*) from public.match_players x where x.match_id = m.id)::integer as player_count
      from public.match_players mp
      left join public.players pl on pl.id = mp.player_id
      join freunde fr on fr.id = coalesce(mp.user_id, pl.user_id)
      join public.matches m on m.id = mp.match_id
     where m.played_at > now() - interval '60 days'
  )
  select * from (
    select 'match'::text, t.played_at, t.friend_id, p.display_name::text, t.match_id, t.game_mode, t.game_format,
           case
             when t.game_mode = 'Two-Headed Giant' then t.team is not null and t.team = t.winner_name
             when t.game_mode = 'Archenemy' and t.winner_name = '__OTHERS__' then not coalesce(t.is_archenemy, false)
             else t.player_name = t.winner_name
           end,
           t.player_count, null::uuid, null::text, null::text
      from teilnahmen t
      join public.profiles p on p.id = t.friend_id
    union all
    select 'deck'::text, d.created_at, d.user_id, p.display_name::text, null::uuid, null::text, d.format::text, null::boolean,
           null::integer, d.id, d.name::text,
           (select min(c.card_name) from public.deck_cards c where c.deck_id = d.id and c.is_commander)
      from public.decks d
      join freunde fr on fr.id = d.user_id
      join public.profiles p on p.id = d.user_id
     where not coalesce(d.is_private, false)
       and d.deleted_at is null
       and d.created_at > now() - interval '60 days'
  ) ereignisse
  order by 2 desc
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;

grant execute on function public.friend_activity(integer) to authenticated;

-- Bilanz zwischen mir und einem anderen Account über ALLE gemeinsamen Partien (alle Gruppen und
-- Freundesspiele). Unentschieden und Partien, die ein Dritter gewonnen hat, zählen als "andere".
create or replace function public.head_to_head(p_other uuid)
returns table (games integer, my_wins integer, their_wins integer)
language sql
stable
security definer
set search_path = public
as $$
  with gemeinsam as (
    select m.id, m.game_mode::text as game_mode, m.winner_name
      from public.matches m
     where auth.uid() is not null
       and auth.uid() in (select public.match_participant_users(m.id))
       and p_other in (select public.match_participant_users(m.id))
  ),
  sieger as (
    select g.id, coalesce(mp.user_id, pl.user_id) as user_id
      from gemeinsam g
      join public.match_players mp on mp.match_id = g.id
      left join public.players pl on pl.id = mp.player_id
     where case
             when g.game_mode = 'Two-Headed Giant' then mp.team is not null and mp.team = g.winner_name
             when g.game_mode = 'Archenemy' and g.winner_name = '__OTHERS__' then not coalesce(mp.is_archenemy, false)
             else mp.player_name = g.winner_name
           end
  )
  select (select count(*) from gemeinsam)::integer,
         (select count(distinct id) from sieger where user_id = auth.uid())::integer,
         (select count(distinct id) from sieger where user_id = p_other)::integer;
$$;

grant execute on function public.head_to_head(uuid) to authenticated;

-- Gesamtbilanz von mir und meinen Freunden über alle Partien - für die Freunde-Rangliste.
create or replace function public.friends_overall_stats()
returns table (user_id uuid, display_name text, avatar_url text, games integer, wins integer)
language sql
stable
security definer
set search_path = public
as $$
  with leute as (
    select auth.uid() as id
     where auth.uid() is not null
    union
    select case when f.requester = auth.uid() then f.addressee else f.requester end
      from public.friendships f
     where f.status = 'accepted' and auth.uid() in (f.requester, f.addressee)
  ),
  teilnahmen as (
    select l.id as user_id, m.id as match_id,
           case
             when m.game_mode = 'Two-Headed Giant' then mp.team is not null and mp.team = m.winner_name
             when m.game_mode = 'Archenemy' and m.winner_name = '__OTHERS__' then not coalesce(mp.is_archenemy, false)
             else mp.player_name = m.winner_name
           end as won
      from public.match_players mp
      left join public.players pl on pl.id = mp.player_id
      join leute l on l.id = coalesce(mp.user_id, pl.user_id)
      join public.matches m on m.id = mp.match_id
     where coalesce((to_jsonb(m)->>'counts_in_general_stats')::boolean, true)
       and m.winner_name not in ('Unbekannt (Import)', 'Archenemy (Import)')
  )
  select l.id, p.display_name::text, p.avatar_url::text,
         count(distinct t.match_id)::integer,
         count(distinct t.match_id) filter (where t.won)::integer
    from leute l
    join public.profiles p on p.id = l.id
    left join teilnahmen t on t.user_id = l.id
   group by l.id, p.display_name, p.avatar_url;
$$;

grant execute on function public.friends_overall_stats() to authenticated;

notify pgrst, 'reload schema';
