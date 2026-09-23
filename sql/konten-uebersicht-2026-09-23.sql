-- Konten-Übersicht zum Aufräumen (NUR LESEN, ändert nichts)
-- Im Supabase-SQL-Editor ausführen. Beide Abfragen einzeln markieren und laufen lassen.

-- 1) Was passiert mit welchen Tabellen, wenn ein Konto gelöscht wird?
--    CASCADE = Zeilen werden mitgelöscht, SET NULL = Verknüpfung wird geleert.
select c.conrelid::regclass as tabelle,
       a.attname            as spalte,
       case c.confdeltype when 'c' then 'CASCADE' when 'n' then 'SET NULL'
                          when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
                          else 'SET DEFAULT' end as beim_loeschen
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
where c.contype = 'f'
  and c.confrelid = 'auth.users'::regclass
order by 3, 1;

-- 2) Alle Konten mit dem, was an ihnen hängt.
--    verdacht = E-Mail sieht nach Claude-/Testkonto aus.
select u.email,
       p.display_name,
       u.created_at::date                     as angelegt,
       u.last_sign_in_at::date                as letzter_login,
       (select count(*) from public.group_members gm where gm.user_id = u.id) as gruppen,
       (select count(*) from public.decks d where d.user_id = u.id)           as decks,
       (select count(*) from public.match_players mp
          join public.players pl on pl.id = mp.player_id
         where pl.user_id = u.id)                                             as partien,
       (u.email ilike '%claude%' or u.email ilike '%@example.%'
        or u.email ilike '%test%' or u.email ilike '%qa%')                    as verdacht,
       u.id
from auth.users u
left join public.profiles p on p.id = u.id
order by verdacht desc, partien desc, u.created_at;

-- 3) In welchen Gruppen stecken die Konten, die weg sollen - und wer spielt dort sonst noch?
--    Liegt eine Gruppe mit echten Mitspielern hier drin, dürfen deren Partien nicht verschwinden.
with weg as (
  select u.id from auth.users u left join public.profiles p on p.id = u.id
  where p.display_name ilike 'claude%'
     or u.email in ('fabianhofsfake@googlemail.com', 'fabianhofsfakefake@googlemail.com', '90ealter@web.de')
)
select g.name as gruppe,
       g.id   as gruppe_id,
       (select string_agg(coalesce(pr.display_name, gm.user_id::text), ', ')
          from public.group_members gm left join public.profiles pr on pr.id = gm.user_id
         where gm.group_id = g.id and gm.user_id not in (select id from weg)) as bleibende_mitglieder,
       (select string_agg(pl.display_name, ', ')
          from public.players pl where pl.group_id = g.id and pl.user_id in (select id from weg)) as spieler_der_weg_konten,
       (select count(*) from public.matches m where m.group_id = g.id) as partien_in_gruppe
from public.groups g
where g.id in (select gm.group_id from public.group_members gm where gm.user_id in (select id from weg))
   or g.id in (select pl.group_id from public.players pl where pl.user_id in (select id from weg));

-- 4) Was hängt an Gruppen, Spielern, Partien und Decks - und darf "created_by" leer sein?
select c.confrelid::regclass as verweist_auf,
       c.conrelid::regclass  as tabelle,
       a.attname             as spalte,
       case c.confdeltype when 'c' then 'CASCADE' when 'n' then 'SET NULL'
                          when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
                          else 'SET DEFAULT' end as beim_loeschen,
       not a.attnotnull      as darf_leer_sein
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
where c.contype = 'f'
  and c.confrelid in ('public.groups'::regclass, 'public.players'::regclass,
                      'public.matches'::regclass, 'auth.users'::regclass)
  and c.connamespace = 'public'::regnamespace
order by 1, 2;
