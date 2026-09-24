-- Teil 5 von 5: alte Tabelle loeschen - aber nur, wenn die neue gefuellt ist

do $$
declare
  anzahl bigint;
begin
  select count(*) into anzahl from public.spellbook_combo_cardlists;
  if anzahl < 1000 then
    raise exception 'Nur % Combos in der neuen Tabelle - alte Tabelle bleibt stehen. Teil 2 nochmal ausfuehren.', anzahl;
  end if;
  drop table if exists public.spellbook_combo_cards;
  raise notice 'Fertig: % Combos umgestellt, alte Tabelle geloescht.', anzahl;
end
$$;

analyze public.spellbook_card_names;
analyze public.spellbook_combo_cardlists;
