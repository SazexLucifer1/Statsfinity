-- Teil 4 von 5: Liste der gewinnenden Combos neu bauen

do $ausraeumen$
declare
  art "char";
begin
  select relkind into art from pg_class where oid = to_regclass('public.spellbook_winning_combos');
  if art = 'm' then
    execute 'drop materialized view public.spellbook_winning_combos';
  elsif art = 'v' then
    execute 'drop view public.spellbook_winning_combos';
  end if;
end
$ausraeumen$;

create materialized view public.spellbook_winning_combos as
with gewinner as materialized (
  select
    c.id,
    c.card_count,
    coalesce(c.mana_value_needed, 0) as mana_value_needed,
    c.produces,
    exists (
      select 1 from unnest(c.produces) as p
      where p ~* public.spellbook_sofort_sieg_muster()
        and p !~* public.spellbook_sieg_ausnahme()
    ) as beendet_sofort
  from public.spellbook_combos c
  where exists (
    select 1 from unnest(c.produces) as p
    where p ~* public.spellbook_winning_combo_muster()
      and p !~* public.spellbook_sieg_ausnahme()
  )
)
select
  g.id as combo_id,
  g.card_count,
  g.mana_value_needed,
  g.produces,
  g.beendet_sofort,
  array(
    select n.name_normalized
    from unnest(cl.card_ids) as u(id)
    join public.spellbook_card_names n on n.id = u.id
    order by n.name_normalized
  ) as card_names,
  array(
    select n.name_normalized
    from unnest(cl.commander_ids) as u(id)
    join public.spellbook_card_names n on n.id = u.id
    order by n.name_normalized
  ) as commander_required
from gewinner g
join public.spellbook_combo_cardlists cl on cl.combo_id = g.id;

create unique index if not exists spellbook_winning_combos_id_idx
  on public.spellbook_winning_combos (combo_id);

create index if not exists spellbook_winning_combos_cards_idx
  on public.spellbook_winning_combos using gin (card_names);

create index if not exists spellbook_winning_combos_sofort_idx
  on public.spellbook_winning_combos (beendet_sofort)
  where beendet_sofort;

grant select on public.spellbook_winning_combos to anon, authenticated;
