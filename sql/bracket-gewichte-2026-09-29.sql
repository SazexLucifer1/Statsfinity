-- Gewichte des Tuning-Grads aus den eigenen Decks lernen (bracket.ts, BracketBenchmark.weights).
-- Setzt sql/bracket-benchmark-2026-09-29.sql voraus. Im Supabase-Dashboard unter "SQL Editor"
-- ausführen, komplett idempotent.
--
-- Gewicht je Messgröße = Trennschärfe |AUC - 0,5| zwischen Bracket 2 und Bracket 4 (dieselbe
-- Methode wie docs/bracket-benchmark-2026-09.md). Erst wenn beide Stufen je 100 Decks haben;
-- bis dahin bleiben die Spalten leer und die App nimmt die Startwerte aus bracket.ts.

alter table public.bracket_benchmark
  add column if not exists weight_tutors real,
  add column if not exists weight_avg_cmc real,
  add column if not exists weight_untapped_lands real,
  add column if not exists weight_game_changers real;

comment on column public.bracket_benchmark.weight_tutors is
  'Gewicht im Tuning-Grad (|AUC - 0,5|, Bracket 2 gegen 4). Nur in der Zeile von Bracket 4 gesetzt.';

-- AUC einer Spalte: Anteil der Paare (Bracket-4-Deck, Bracket-2-Deck), in denen das Bracket-4-Deck
-- den größeren Wert hat, Gleichstand halb. Decks ohne Wert zählen nicht.
create or replace function public.bracket_benchmark_auc(spalte text)
returns real
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ergebnis real;
begin
  if spalte not in ('tutor_density', 'avg_cmc', 'untapped_land_percent', 'game_changers') then
    raise exception 'Unbekannte Spalte: %', spalte;
  end if;
  execute format(
    'select (count(*) filter (where h.%1$I > n.%1$I) + 0.5 * count(*) filter (where h.%1$I = n.%1$I))::real
            / nullif(count(*), 0)
     from public.bracket_benchmark_decks h
     join public.bracket_benchmark_decks n on n.bracket = 2
     where h.bracket = 4 and h.%1$I is not null and n.%1$I is not null',
    spalte
  ) into ergebnis;
  return ergebnis;
end;
$$;

create or replace function public.bracket_benchmark_gewichte()
returns table (merkmal text, gewicht real)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  mindest_decks constant integer := 100;
  -- Ein Merkmal, das gar nicht trennt, bekommt trotzdem ein kleines Gewicht statt 0.
  mindest_gewicht constant real := 0.02;
begin
  if (select count(*) from public.bracket_benchmark_decks where bracket = 2) < mindest_decks
     or (select count(*) from public.bracket_benchmark_decks where bracket = 4) < mindest_decks then
    return;
  end if;

  update public.bracket_benchmark
  set weight_tutors = greatest(mindest_gewicht, abs(public.bracket_benchmark_auc('tutor_density') - 0.5)),
      weight_avg_cmc = greatest(mindest_gewicht, abs(public.bracket_benchmark_auc('avg_cmc') - 0.5)),
      weight_untapped_lands = greatest(mindest_gewicht, abs(public.bracket_benchmark_auc('untapped_land_percent') - 0.5)),
      weight_game_changers = greatest(mindest_gewicht, abs(public.bracket_benchmark_auc('game_changers') - 0.5)),
      values_updated_at = now()
  where bracket = 4;

  return query
    select 'tutors', b.weight_tutors from public.bracket_benchmark b where b.bracket = 4
    union all select 'averageCmc', b.weight_avg_cmc from public.bracket_benchmark b where b.bracket = 4
    union all select 'untappedLands', b.weight_untapped_lands from public.bracket_benchmark b where b.bracket = 4
    union all select 'gameChangers', b.weight_game_changers from public.bracket_benchmark b where b.bracket = 4;
end;
$$;

comment on function public.bracket_benchmark_gewichte() is
  'Lernt die Gewichte des Tuning-Grads (Trennschärfe B2 gegen B4) aus bracket_benchmark_decks, ab je 100 Decks. Aufgerufen nach bracket_benchmark_aktualisieren() im Spellbook-Nachtlauf.';

-- Nur der Nachtlauf darf das auslösen (liest als security definer die Messwerte privater Decks).
revoke all on function public.bracket_benchmark_auc(text) from public, anon, authenticated;
revoke all on function public.bracket_benchmark_gewichte() from public, anon, authenticated;
grant execute on function public.bracket_benchmark_auc(text) to service_role;
grant execute on function public.bracket_benchmark_gewichte() to service_role;

notify pgrst, 'reload schema';
