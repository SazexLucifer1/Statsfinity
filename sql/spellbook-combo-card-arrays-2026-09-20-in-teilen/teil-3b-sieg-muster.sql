-- Teil 3b: die drei Sieg-Muster aus sql/sieg-definition-breit-2026-09-17.sql (vor Teil 4).
-- Nur noetig, wenn jene Migration nie gelaufen ist - Teil 4 bricht sonst mit 42883 ab.

create or replace function public.spellbook_winning_combo_muster()
returns text language sql immutable security invoker set search_path = public
as $$
  select 'win the game|(opponent|player)[^,]{0,40}loses? the game|(near-)?infinite[^,]{0,30}(damage|mill|turns|combat phases|storm count|loss of life|poison)|cast all spells in your library'::text;
$$;

create or replace function public.spellbook_sofort_sieg_muster()
returns text language sql immutable security invoker set search_path = public
as $$
  select 'win the game|infinite damage|infinite turns|infinite mill|infinite loss of life|opponent loses the game|opponents lose the game'::text;
$$;

create or replace function public.spellbook_sieg_ausnahme()
returns text language sql immutable security invoker set search_path = public
as $$
  select 'damage to [^,]{0,25}creatures|damage to you|mill for you|self-mill'::text;
$$;

grant execute on function public.spellbook_winning_combo_muster() to anon, authenticated, service_role;
grant execute on function public.spellbook_sofort_sieg_muster() to anon, authenticated, service_role;
grant execute on function public.spellbook_sieg_ausnahme() to anon, authenticated, service_role;
