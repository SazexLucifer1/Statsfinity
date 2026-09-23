-- Test- und Claude-Konten löschen, samt ihrer reinen Testgruppen.
-- Im Supabase-SQL-Editor als Ganzes ausführen. Läuft in EINER Transaktion: Schlägt eine
-- Sicherheitsprüfung an oder scheitert ein Schritt, wird nichts gelöscht.
--
-- Weg sollen: alle Konten, deren Profilname oder E-Mail mit "claude" beginnt, und drei
-- eigene Testkonten des Users. Vorher angesehen mit sql/konten-uebersicht-2026-09-23.sql
-- (23.09.2026: 33 Konten, 5 Gruppen ohne ein einziges bleibendes Mitglied).
--
-- Warum nicht einfach im Dashboard löschen: decks.user_id ist ON DELETE CASCADE, sieben
-- andere Verweise auf auth.users (Gruppen, Mitgliedschaften, Turniere, Live-Spiele, ...)
-- sind NO ACTION und blockieren, und players.user_id hat gar keinen Fremdschlüssel -
-- es bliebe stillschweigend auf ein Konto zeigen, das es nicht mehr gibt.
--
-- Das Skript lässt sich später erneut ausführen, um neu angelegte Claude-Konten zu entfernen.

begin;

create temp table weg on commit drop as
select u.id
from auth.users u
left join public.profiles p on p.id = u.id
where p.display_name ilike 'claude%'
   or u.email ilike 'claude%@example.com'
   or u.email in ('fabianhofsfake@googlemail.com', 'fabianhofsfakefake@googlemail.com', '90ealter@web.de');

-- Gruppen, in denen NUR zu löschende Konten stecken (Mitglieder oder verknüpfte Spieler).
create temp table weg_gruppen on commit drop as
select g.id
from public.groups g
where (g.id in (select group_id from public.group_members where user_id in (select id from weg))
       or g.id in (select group_id from public.players where user_id in (select id from weg)))
  and not exists (select 1 from public.group_members gm
                   where gm.group_id = g.id and gm.user_id not in (select id from weg))
  and not exists (select 1 from public.players pl
                   where pl.group_id = g.id and pl.user_id is not null
                     and pl.user_id not in (select id from weg));

create temp table weg_spieler on commit drop as
select id from public.players where group_id in (select id from weg_gruppen);

-- Sicherheitsprüfungen: echte Daten dürfen nicht mitgerissen werden.
do $$
begin
  if exists (select 1 from auth.users u join weg w on w.id = u.id
              where u.email in ('fabianhofs@googlemail.com')) then
    raise exception 'Abbruch: das Hauptkonto steht auf der Löschliste';
  end if;
  if exists (select 1 from public.group_members
              where user_id in (select id from weg) and group_id not in (select id from weg_gruppen)) then
    raise exception 'Abbruch: ein zu löschendes Konto ist Mitglied einer Gruppe mit echten Spielern';
  end if;
  if exists (select 1 from public.match_players mp
               join public.matches m on m.id = mp.match_id
              where m.group_id not in (select id from weg_gruppen)
                and (mp.deck_id in (select id from public.decks where user_id in (select id from weg))
                     or mp.player_id in (select id from public.players where user_id in (select id from weg)))) then
    raise exception 'Abbruch: ein Deck oder Spieler eines zu löschenden Kontos steckt in einer echten Partie';
  end if;
  if exists (select 1 from public.tournaments
              where created_by in (select id from weg) and group_id not in (select id from weg_gruppen)) then
    raise exception 'Abbruch: ein zu löschendes Konto hat ein Turnier in einer echten Gruppe angelegt';
  end if;
end $$;

-- 1) Die reinen Testgruppen mit allem, was daran hängt.
delete from public.tournaments where group_id in (select id from weg_gruppen);
delete from public.live_game_sessions
 where group_id in (select id from weg_gruppen) or created_by in (select id from weg);
delete from public.matches where group_id in (select id from weg_gruppen);  -- match_players per CASCADE
delete from public.decks
 where user_id in (select id from weg) or player_id in (select id from weg_spieler);
delete from public.cubes where group_id in (select id from weg_gruppen);
delete from public.player_backgrounds
 where group_id in (select id from weg_gruppen) or player_id in (select id from weg_spieler);
delete from public.group_invites
 where group_id in (select id from weg_gruppen) or created_by in (select id from weg);
delete from public.players where id in (select id from weg_spieler);
delete from public.groups where id in (select id from weg_gruppen);

-- 2) Restliche Verweise auf die Konten lösen, die das Löschen sonst blockieren.
delete from public.group_members where user_id in (select id from weg);
update public.groups set created_by = null where created_by in (select id from weg);
update public.group_member_permissions set granted_by = null where granted_by in (select id from weg);
update public.group_roles set created_by = null where created_by in (select id from weg);
update public.players set user_id = null where user_id in (select id from weg);

-- 3) Die Konten selbst. Profile, Kommentare, Likes, Feedback usw. gehen per CASCADE mit.
delete from auth.users where id in (select id from weg);

commit;

-- Kontrolle: muss 0 Zeilen liefern.
select u.email from auth.users u left join public.profiles p on p.id = u.id
 where p.display_name ilike 'claude%' or u.email ilike 'claude%@example.com';
