-- Teil 3 von 5: Suchfunktion des Combo-Finders

drop function if exists public.spellbook_combos_missing_one(text[], text[], integer, integer);

create function public.spellbook_combos_missing_one(
  deck_names text[],
  commander_names text[] default '{}'::text[],
  max_cards integer default 150,
  max_combos_per_card integer default 6
)
returns table (
  combo_id text,
  missing_name text,
  present_names text[],
  card_count smallint,
  produces text[],
  description text,
  mana_needed text,
  mana_value_needed smallint,
  popularity integer,
  combo_count integer,
  total_cards integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with deck_auswahl as (
    select coalesce(array_agg(n.id), '{}'::integer[]) as ids
    from public.spellbook_card_names n
    where n.name_normalized = any(deck_names)
  ),
  commander_auswahl as (
    select coalesce(array_agg(n.id), '{}'::integer[]) as ids
    from public.spellbook_card_names n
    where n.name_normalized = any(commander_names)
  ),
  kandidaten as (
    select cl.combo_id, cl.card_ids, cl.commander_ids, d.ids as deck, c.ids as cmd
    from public.spellbook_combo_cardlists cl
    cross join deck_auswahl d
    cross join commander_auswahl c
    where cl.card_ids && d.ids
  ),
  bewertet as (
    select
      k.combo_id,
      array(select x from unnest(k.card_ids) as x where not (x = any(k.deck)))  as fehlende,
      array(select x from unnest(k.card_ids) as x where x = any(k.deck))        as vorhandene,
      not exists (
        select 1 from unnest(k.commander_ids) as c where not (c = any(k.cmd))
      ) as commander_ok
    from kandidaten k
  ),
  treffer as (
    select
      b.combo_id,
      b.fehlende[1] as fehlt_id,
      b.vorhandene,
      c.card_count,
      c.produces,
      c.description,
      c.mana_needed,
      c.mana_value_needed,
      c.popularity
    from bewertet b
    join public.spellbook_combos c on c.id = b.combo_id
    where cardinality(b.fehlende) = 1
      and b.commander_ok
  ),
  benannt as (
    select
      t.combo_id,
      fn.name_normalized as fehlt,
      array(
        select vn.name_normalized
        from unnest(t.vorhandene) as v(id)
        join public.spellbook_card_names vn on vn.id = v.id
        order by vn.name_normalized
      ) as vorhanden,
      t.card_count,
      t.produces,
      t.description,
      t.mana_needed,
      t.mana_value_needed,
      t.popularity
    from treffer t
    join public.spellbook_card_names fn on fn.id = t.fehlt_id
  ),
  rang_alle as (
    select
      b.fehlt,
      count(*)::integer as combo_anzahl,
      max(coalesce(b.popularity, 0)) as beste_beliebtheit
    from benannt b
    group by b.fehlt
  ),
  rang as (
    select *
    from rang_alle
    order by combo_anzahl desc, beste_beliebtheit desc, fehlt
    limit greatest(max_cards, 1)
  ),
  gekuerzt as (
    select
      b.*,
      r.combo_anzahl,
      r.beste_beliebtheit,
      row_number() over (
        partition by b.fehlt
        order by b.popularity desc nulls last, b.card_count, b.combo_id
      ) as platz
    from benannt b
    join rang r on r.fehlt = b.fehlt
  )
  select
    g.combo_id,
    g.fehlt,
    g.vorhanden,
    g.card_count,
    g.produces,
    g.description,
    g.mana_needed,
    g.mana_value_needed,
    g.popularity,
    g.combo_anzahl,
    (select count(*)::integer from rang_alle)
  from gekuerzt g
  where g.platz <= greatest(max_combos_per_card, 1)
  order by g.combo_anzahl desc, g.beste_beliebtheit desc, g.fehlt, g.platz;
$$;
