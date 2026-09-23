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
