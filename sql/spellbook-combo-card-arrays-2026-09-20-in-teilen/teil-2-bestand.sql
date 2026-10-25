-- Teil 2 von 5: vorhandene Combos in die neue Form uebertragen

do $$
begin
  if to_regclass('public.spellbook_combo_cards') is null then
    raise notice 'spellbook_combo_cards gibt es nicht mehr - Bestand wurde bereits umgestellt.';
    return;
  end if;

  insert into public.spellbook_card_names (name_normalized)
  select distinct cc.name_normalized
  from public.spellbook_combo_cards cc
  on conflict (name_normalized) do nothing;

  insert into public.spellbook_combo_cardlists (combo_id, card_ids, commander_ids, synced_at)
  select
    cc.combo_id,
    array_agg(distinct n.id),
    coalesce(
      (array_agg(n.id order by n.id) filter (where cc.must_be_commander)),
      '{}'::integer[]
    ),
    max(cc.synced_at)
  from public.spellbook_combo_cards cc
  join public.spellbook_card_names n on n.name_normalized = cc.name_normalized
  group by cc.combo_id
  having count(*) between 2 and 5
  on conflict (combo_id) do nothing;

  raise notice 'Umgestellt: % Combos, % Kartennamen.',
    (select count(*) from public.spellbook_combo_cardlists),
    (select count(*) from public.spellbook_card_names);
end
$$;
