-- Test- und Claude-Konten löschen, samt ihrer reinen Testgruppen.
-- Im Supabase-SQL-Editor als Ganzes ausführen. Ein einziger DO-Block und damit atomar: Schlägt
-- eine Sicherheitsprüfung an oder scheitert ein Schritt, wird nichts gelöscht. Bewusst ohne
-- temporäre Tabellen - der SQL-Editor behält sie zwischen den Anweisungen nicht (42P01).
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

do $$
declare
  weg      uuid[];  -- zu löschende Konten
  gruppen  uuid[];  -- Gruppen, in denen NUR zu löschende Konten stecken
  spieler  uuid[];  -- Spieler dieser Gruppen
  anzahl   int;
begin
  select coalesce(array_agg(u.id), '{}') into weg
    from auth.users u left join public.profiles p on p.id = u.id
   where p.display_name ilike 'claude%'
      or u.email ilike 'claude%@example.com'
      or u.email in ('fabianhofsfake@googlemail.com', 'fabianhofsfakefake@googlemail.com', '90ealter@web.de');

  select coalesce(array_agg(g.id), '{}') into gruppen
    from public.groups g
   where (g.id in (select group_id from public.group_members where user_id = any (weg))
          or g.id in (select group_id from public.players where user_id = any (weg)))
     and not exists (select 1 from public.group_members gm
                      where gm.group_id = g.id and gm.user_id <> all (weg))
     and not exists (select 1 from public.players pl
                      where pl.group_id = g.id and pl.user_id is not null and pl.user_id <> all (weg));

  select coalesce(array_agg(id), '{}') into spieler
    from public.players where group_id = any (gruppen);

  -- Decks eines zu löschenden Kontos, mit denen in einer ECHTEN Partie gespielt wurde, gehen an
  -- den Spieler, der damit gespielt hat - sonst risse das Löschen (decks.user_id ist CASCADE) das
  -- Deck aus der Partie. Nur wenn genau ein echter Spieler damit gespielt hat; sonst bricht die
  -- Prüfung unten ab. Am 23.09.2026 betraf das ein Deck: "Esper Artefakte" (Bene, 31.12.2025).
  -- player_id wird geleert, weil decks.player_id beim Löschen des Spielers CASCADE ist.
  update public.decks d
     set user_id = neu.user_id, player_id = null
    from (select mp.deck_id, min(pl.user_id::text)::uuid as user_id
            from public.match_players mp
            join public.matches m  on m.id = mp.match_id
            join public.players pl on pl.id = mp.player_id
           where m.group_id <> all (gruppen)
             and pl.user_id is not null and pl.user_id <> all (weg)
             and mp.deck_id in (select id from public.decks where user_id = any (weg))
           group by mp.deck_id
          having count(distinct pl.user_id) = 1) neu
   where d.id = neu.deck_id;

  -- Sicherheitsprüfungen: echte Daten dürfen nicht mitgerissen werden.
  if exists (select 1 from auth.users where id = any (weg) and email = 'fabianhofs@googlemail.com') then
    raise exception 'Abbruch: das Hauptkonto steht auf der Löschliste';
  end if;
  if exists (select 1 from public.group_members
              where user_id = any (weg) and group_id <> all (gruppen)) then
    raise exception 'Abbruch: ein zu löschendes Konto ist Mitglied einer Gruppe mit echten Spielern';
  end if;
  if exists (select 1 from public.match_players mp
               join public.matches m on m.id = mp.match_id
              where m.group_id <> all (gruppen)
                and (mp.deck_id in (select id from public.decks where user_id = any (weg))
                     or mp.player_id in (select id from public.players where user_id = any (weg)))) then
    raise exception 'Abbruch: ein Deck oder Spieler eines zu löschenden Kontos steckt in einer echten Partie';
  end if;
  if exists (select 1 from public.tournaments
              where created_by = any (weg) and group_id <> all (gruppen)) then
    raise exception 'Abbruch: ein zu löschendes Konto hat ein Turnier in einer echten Gruppe angelegt';
  end if;

  -- 1) Die reinen Testgruppen mit allem, was daran hängt.
  delete from public.tournaments where group_id = any (gruppen);
  delete from public.live_game_sessions where group_id = any (gruppen) or created_by = any (weg);
  delete from public.matches where group_id = any (gruppen);  -- match_players per CASCADE
  delete from public.decks where user_id = any (weg) or player_id = any (spieler);
  delete from public.cubes where group_id = any (gruppen);
  delete from public.player_backgrounds where group_id = any (gruppen) or player_id = any (spieler);
  delete from public.group_invites where group_id = any (gruppen) or created_by = any (weg);
  delete from public.players where id = any (spieler);
  delete from public.groups where id = any (gruppen);

  -- 2) Restliche Verweise auf die Konten lösen, die das Löschen sonst blockieren.
  delete from public.group_members where user_id = any (weg);
  update public.groups set created_by = null where created_by = any (weg);
  update public.group_member_permissions set granted_by = null where granted_by = any (weg);
  update public.group_roles set created_by = null where created_by = any (weg);
  update public.players set user_id = null where user_id = any (weg);

  -- 3) Die Konten selbst. Profile, Kommentare, Likes, Feedback usw. gehen per CASCADE mit.
  delete from auth.users where id = any (weg);
  get diagnostics anzahl = row_count;
  raise notice 'Gelöscht: % Konten, % Gruppen', anzahl, cardinality(gruppen);
end $$;

-- Kontrolle: muss 0 Zeilen liefern.
select u.email from auth.users u left join public.profiles p on p.id = u.id
 where p.display_name ilike 'claude%' or u.email ilike 'claude%@example.com';
