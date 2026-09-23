-- Einmaliger Daten-Fix (23.09.2026): Precon "Wakanda Forever" (MTGJSON WakandaForever_MSC) für Theo
-- anlegen und Alex' Partie, die fälschlich "King T'Challa // Black Panther, Hope Enduring" trug
-- (derselbe Fehler wie in fix-michi-tchalla-commander-2026-08-30.sql), korrigieren und als von Theo
-- geliehen an dieses Deck hängen. Im Supabase-SQL-Editor als Ganzes ausführen; mehrfach gefahrlos.

do $$
declare
  theo  uuid := '77a50064-ec1f-4421-b79c-0849325976b9';
  alex  uuid;
  deck  uuid;
  n     int;
begin
  select pl.id into alex from public.players pl join public.groups g on g.id = pl.group_id
   where g.name = 'MTG Runde' and pl.display_name = 'Alex' and pl.user_id is null;
  if alex is null then raise exception 'Abbruch: NPC Alex nicht gefunden'; end if;

  -- 1) Precon "Wakanda Forever" für Theo - nur anlegen, wenn er noch kein T'Challa-Deck hat
  select d.id into deck from public.decks d
    join public.deck_cards c on c.deck_id = d.id and c.is_commander
   where d.user_id = theo and c.card_name = 'T''Challa, the Black Panther' limit 1;

  if deck is null then
    insert into public.decks (user_id, name, format, is_precon, precon_release_year, color_identity, commander_types)
    select theo, 'Wakanda Forever', 'Commander', true, 2026, sc.color_identity,
           coalesce(string_to_array(nullif(trim(split_part(sc.type_line, '—', 2)), ''), ' '), '{}')
      from public.scryfall_cards sc where sc.name = 'T''Challa, the Black Panther' limit 1
    returning id into deck;
    if deck is null then raise exception 'Abbruch: T''Challa nicht im Scryfall-Cache'; end if;

    insert into public.deck_cards (deck_id, card_name, quantity, image_url, type_line, cmc, is_commander, is_maybeboard)
    select deck, k.name, k.anzahl, sc.image_url, sc.type_line, coalesce(sc.cmc, 0), k.commander, false
      from (values
      ('T''Challa, the Black Panther', 1, true),
      ('Dora Milaje Elite', 1, false),
      ('Everett K. Ross, Hapless Attaché', 1, false),
      ('Hatut Zeraze Strike Force', 1, false),
      ('King Solomon''s Frogs', 1, false),
      ('Midnight Angel Armor', 1, false),
      ('Queen Mother Ramonda', 1, false),
      ('Royal Talon Fighter Jet', 1, false),
      ('The Spear of Bashenga', 1, false),
      ('Ancestral Communion', 1, false),
      ('Fight for the Throne', 1, false),
      ('M''Baku, Jabari Chieftain', 1, false),
      ('Nakia, Wakandan Operative', 1, false),
      ('W''Kabi, Shield of the Nation', 1, false),
      ('Wakanda Forever!', 1, false),
      ('Zuri, Warrior of Wakanda', 1, false),
      ('Bast, Panther Goddess', 1, false),
      ('Okoye, Mighty and Adored', 1, false),
      ('Shuri, the Black Panther', 1, false),
      ('Storm, Queen of Wakanda', 1, false),
      ('T''Chaka, Venerable King', 1, false),
      ('Heart-Shaped Herb', 1, false),
      ('Kimoyo Beads', 1, false),
      ('N''Yami-Class Mother Ship', 1, false),
      ('Panther Habit', 1, false),
      ('Panther Robot', 1, false),
      ('Shuri''s Fabricator', 1, false),
      ('Vibranium Mining Mech', 1, false),
      ('Vibranium Strike Gauntlets', 1, false),
      ('The Great Mound', 1, false),
      ('Divine Visitation', 1, false),
      ('Loyal Retainers', 1, false),
      ('Martial Coup', 1, false),
      ('Vanquish the Horde', 1, false),
      ('Birds of Paradise', 1, false),
      ('Conduit of Worlds', 1, false),
      ('Greater Good', 1, false),
      ('Nature''s Lore', 1, false),
      ('Overwhelming Stampede', 1, false),
      ('Coveted Jewel', 1, false),
      ('Gilded Lotus', 1, false),
      ('Helm of the Host', 1, false),
      ('Metalwork Colossus', 1, false),
      ('Solemn Simulacrum', 1, false),
      ('Trading Post', 1, false),
      ('Bountiful Promenade', 1, false),
      ('Canopy Vista', 1, false),
      ('Fortified Village', 1, false),
      ('Razorverge Thicket', 1, false),
      ('Scattered Groves', 1, false),
      ('Scavenger Grounds', 1, false),
      ('Sungrass Prairie', 1, false),
      ('Sunpetal Grove', 1, false),
      ('Throne of the High City', 1, false),
      ('Scourglass', 1, false),
      ('Fleecemane Lion', 1, false),
      ('Hammer of Nazahn', 1, false),
      ('Mind''s Eye', 1, false),
      ('Sword of the Animist', 1, false),
      ('Thran Dynamo', 1, false),
      ('Dispatch', 1, false),
      ('Generous Gift', 1, false),
      ('Ingenious Smith', 1, false),
      ('Palace Jailer', 1, false),
      ('Valorous Stance', 1, false),
      ('Beast Within', 1, false),
      ('Harmonize', 1, false),
      ('Loyal Guardian', 1, false),
      ('Arcane Signet', 1, false),
      ('Meteor Golem', 1, false),
      ('Sol Ring', 1, false),
      ('Whispersilk Cloak', 1, false),
      ('Command Tower', 1, false),
      ('Evolving Wilds', 1, false),
      ('Path of Ancestry', 1, false),
      ('Terramorphic Expanse', 1, false),
      ('Plains', 6, false),
      ('Plains', 6, false),
      ('Forest', 6, false),
      ('Forest', 6, false)
      ) as k(name, anzahl, commander)
      left join lateral (select image_url, type_line, cmc from public.scryfall_cards s
                          where lower(s.name) = lower(k.name)
                          order by s.image_url is null limit 1) sc on true;
    get diagnostics n = row_count;
    raise notice 'Wakanda Forever für Theo angelegt: % Kartenzeilen', n;
  end if;

  -- 2) Alex' Partie: falscher Commander-Name korrigieren und an Theos Deck hängen (geliehen)
  update public.match_players
     set commander_name = 'T''Challa, the Black Panther'
   where player_id = alex and commander_name = 'King T''Challa // Black Panther, Hope Enduring';
  update public.match_players
     set partner_commander_name = 'T''Challa, the Black Panther'
   where player_id = alex and partner_commander_name = 'King T''Challa // Black Panther, Hope Enduring';

  update public.match_players set deck_id = deck
   where player_id = alex and commander_name = 'T''Challa, the Black Panther' and deck_id is null;
  get diagnostics n = row_count;
  raise notice 'Alex: % Partien mit Theos Deck verknüpft', n;
end $$;

-- Kontrolle
select pl.display_name as spieler, mp.commander_name, coalesce(d.name, '— ohne Deck —') as deck,
       (select display_name from public.players where user_id = d.user_id limit 1) as deck_von,
       (select count(*) from public.deck_cards c where c.deck_id = d.id) as kartenzeilen,
       (select sum(quantity) from public.deck_cards c where c.deck_id = d.id) as karten
from public.match_players mp
join public.players pl on pl.id = mp.player_id
left join public.decks d on d.id = mp.deck_id
where pl.display_name = 'Alex' and mp.commander_name ilike '%challa%';
