-- Rauswürfe: wer welchen Spieler aus einer Commander-Partie geworfen hat ("Last Hit").
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Wunsch der Spielrunde: Nicht nur wer gewinnt, sondern wer wen rauswirft. Der Tracker fragt beim
-- Totenkopf eines Spielers, wer ihn rausgeworfen hat; wer beim Speichern noch lebt (bzw. nicht
-- markiert ist), gilt als vom Sieger rausgeworfen. Ausgewertet im Statistik-Tab
-- (match-insights.ts, eliminationStats()).
--
--   * match_players.eliminated_by - player_name des Spielers, der diesen rausgeworfen hat, im
--                                   Zuschnitt von player_name und winner_name (Text, wie die
--                                   Spielernamen in der Historie). Der eigene Name = niemand /
--                                   selbst rausgeflogen. null = unbekannt, überlebt oder Sieger.
--
-- Bewusst ein Name und keine player_id: Freundesspiele haben keine player_id, und die Historie
-- arbeitet überall mit player_name. Damit ein umbenannter oder zusammengeführter Spieler nicht als
-- alter Name stehen bleibt, zieht der Trigger unten eliminated_by in derselben Partie mit, sobald
-- sich player_name ändert (MtgService.renamePlayer/mergePlayers schreiben nur player_name).
--
-- Keine neue RLS-Policy: Lesen und Schreiben folgen den bestehenden Regeln von match_players.
-- Fehlt die Migration, speichert und lädt die App wie bisher ohne Rauswürfe (42703/PGRST204,
-- siehe rauswurfVerfuegbar in mtg.service.ts).

alter table public.match_players
  add column if not exists eliminated_by text;

comment on column public.match_players.eliminated_by is
  'Wer diesen Spieler rausgeworfen hat (player_name in derselben Partie); eigener Name = niemand/selbst; null = unbekannt.';

create or replace function public.match_players_rauswurf_umbenennen()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.player_name is not null and new.player_name is distinct from old.player_name then
    update public.match_players
       set eliminated_by = new.player_name
     where match_id = new.match_id
       and eliminated_by = old.player_name;
  end if;
  return new;
end;
$$;

drop trigger if exists match_players_rauswurf_umbenennen on public.match_players;
create trigger match_players_rauswurf_umbenennen
  after update of player_name on public.match_players
  for each row execute function public.match_players_rauswurf_umbenennen();
