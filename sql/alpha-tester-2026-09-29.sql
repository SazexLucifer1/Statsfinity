-- Alpha-Tester: EDHREC-Funktionen nur für einen geschlossenen Kreis.
--
-- Hintergrund: Die App holt Empfehlungen und Themen-Tags direkt von EDHREC. Solange nicht geklärt
-- ist, ob EDHREC das in einer öffentlich vermarkteten App duldet, sollen nur der Betreiber und
-- seine Freunde diese Funktionen sehen - alle anderen bekommen sie gar nicht erst angeboten.
--
-- Alpha-Tester ist, wer
--   1. Developer ist (profiles.is_developer),
--   2. von Hand freigeschaltet wurde (profiles.is_alpha_tester, neue Spalte), oder
--   3. mit einem Developer in derselben Gruppe ist - AUTOMATISCH, auch für später Beitretende.
--
-- Die App fragt das einmal nach dem Login über public.is_alpha_tester() ab (profile.service.ts).
-- Fehlt dieses Skript noch, gelten dort nur Developer als Alpha-Tester.
--
-- Von Hand freischalten:
--   update public.profiles set is_alpha_tester = true where display_name = '...';

-- =====================================================================================
-- 1. Manueller Tag
-- =====================================================================================
alter table public.profiles
  add column if not exists is_alpha_tester boolean not null default false;

-- Die Update-Policy auf profiles erlaubt jedem, die EIGENE Zeile zu ändern - ohne diesen Trigger
-- könnte sich jeder selbst freischalten. Nur ein Developer darf den Tag setzen oder entfernen;
-- im SQL-Editor (auth.uid() ist dort null) geht es immer.
create or replace function public.profiles_alpha_tester_schuetzen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_alpha_tester is distinct from old.is_alpha_tester
     and auth.uid() is not null
     and not public.is_developer(auth.uid()) then
    new.is_alpha_tester := old.is_alpha_tester;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_alpha_tester_schuetzen on public.profiles;
create trigger profiles_alpha_tester_schuetzen
before update on public.profiles
for each row execute function public.profiles_alpha_tester_schuetzen();

-- =====================================================================================
-- 2. Abfrage für den eingeloggten Nutzer
-- =====================================================================================
-- SECURITY DEFINER, weil der Nutzer die Mitgliedschaften der Developer nicht zwingend lesen darf.
-- Gibt nur ein Ja/Nein für den Aufrufer selbst heraus, keine fremden Daten.
create or replace function public.is_alpha_tester()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select p.is_developer or p.is_alpha_tester from profiles p where p.id = auth.uid()),
    false
  )
  or exists (
    select 1
    from group_members ich
    join group_members andere on andere.group_id = ich.group_id
    join profiles dev on dev.id = andere.user_id
    where ich.user_id = auth.uid()
      and coalesce(dev.is_developer, false)
  );
$$;

revoke execute on function public.is_alpha_tester() from public, anon;
grant execute on function public.is_alpha_tester() to authenticated;
