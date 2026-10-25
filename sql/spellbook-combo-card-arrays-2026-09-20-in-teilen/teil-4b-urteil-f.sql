-- Teil 4b: Urteil F und die Simulationsspalte aus sql/sieg-definition-breit-2026-09-17.sql (nach Teil 4).
-- Die Ansicht zaehlt jetzt weit; Urteil F muss deshalb auf beendet_sofort filtern.

create or replace function public.winning_combos_in_deck(
  deck_names text[],
  commander_names text[] default '{}'::text[]
)
returns integer language sql stable security invoker set search_path = public
as $$
  select count(*)::integer
  from public.spellbook_winning_combos c
  where c.beendet_sofort
    and c.card_names <@ deck_names
    and c.commander_required <@ commander_names;
$$;

grant execute on function public.winning_combos_in_deck(text[], text[]) to anon, authenticated;

alter table public.deck_sim_results
  add column if not exists sieg_combos smallint not null default 0;
