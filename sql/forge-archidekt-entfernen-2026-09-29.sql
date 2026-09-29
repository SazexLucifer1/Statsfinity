-- Forge-Simulation und Archidekt-Deckvorrat entfernen. Im Supabase-SQL-Editor ausführen,
-- ERST NACHDEM der zugehörige PR gemergt und ausgeliefert ist.
--
-- WARUM: Die Forge-Bots spielen stärkere Decks nicht besser aus (B1–2 gegen B4–5: AUC 0,515), als
-- Bracket-Maßstab untauglich. Der Archidekt-Vorrat war nur für diese Auswertung da; fremde Daten
-- sollen nicht in einer App liegen, die vermarktet wird. Die Ergebnisse (nur Kennzahlen) stehen in
-- docs/bracket-benchmark-archidekt-2026-09.md.
--
-- WAS BLEIBT und NICHT angefasst werden darf: die materialisierte Ansicht spellbook_winning_combos,
-- die Muster-Funktionen spellbook_*_muster/spellbook_sieg_ausnahme und winning_combos_in_deck() -
-- Urteil F der Bracket-Einstufung (src/app/bracket.ts) braucht sie. Sie hängen an den
-- spellbook_*-Tabellen, nicht an den hier gelöschten.
--
-- Frei werden nach der Messung vom 20.09.2026 etwa 110 MB (Vorrat) plus rund 30 MB (Simulation).
--
-- ---------------------------------------------------------------------------------------------
-- 0. ZUERST NACHSEHEN (nur lesen): Was hängt an den Tabellen, die gleich gelöscht werden?
--    Erwartet: nur die Ansichten deck_sim_by_bracket, deck_sim_feature_strength und
--    archidekt_deck_pool_readable. Steht hier spellbook_winning_combos oder etwas anderes aus der
--    App, NICHT weitermachen.
-- ---------------------------------------------------------------------------------------------
select distinct abhaengig.relname as haengt_daran, basis.relname as an_tabelle
from pg_depend d
join pg_rewrite r on r.oid = d.objid
join pg_class abhaengig on abhaengig.oid = r.ev_class
join pg_class basis on basis.oid = d.refobjid
where basis.relname in (
    'deck_sim_results', 'archidekt_deck_pool', 'archidekt_deck_pool_cards',
    'archidekt_deck_pool_cardlists', 'archidekt_pool_card_names',
    'forge_einstufungen', 'forge_einstufung_auftraege')
  and abhaengig.relname <> basis.relname;

-- ---------------------------------------------------------------------------------------------
-- 1. Ansichten
-- ---------------------------------------------------------------------------------------------
drop view if exists public.deck_sim_feature_strength;
drop view if exists public.deck_sim_by_bracket;
drop view if exists public.archidekt_deck_pool_readable;

-- ---------------------------------------------------------------------------------------------
-- 2. Tabellen (Policies und Indizes fallen mit). VOR den Funktionen: Die generierte Spalte
--    archidekt_deck_pool.search_text hängt an archidekt_pool_search_text() - andersherum bricht
--    das Skript mit 2BP01 ab (so geschehen beim ersten Versuch am 29.09.2026).
-- ---------------------------------------------------------------------------------------------
drop table if exists public.deck_sim_results;
drop table if exists public.archidekt_deck_pool_cardlists;
drop table if exists public.archidekt_pool_card_names;
drop table if exists public.archidekt_deck_pool_cards;
drop table if exists public.archidekt_deck_pool;
drop table if exists public.forge_einstufung_auftraege;
drop table if exists public.forge_einstufungen;

-- ---------------------------------------------------------------------------------------------
-- 3. Funktionen (alle Überladungen, deshalb über den Namen gesucht)
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('deck_sim_auc', 'deck_sim_neueste_fassung', 'archidekt_pool_search_text',
                        'forge_auftrag_fortschritt')
  loop
    execute format('drop function %s', f.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Kontrolle: muss 0 Zeilen liefern - und Urteil F muss weiter antworten (eine Zahl, kein Fehler).
-- ---------------------------------------------------------------------------------------------
select table_name from information_schema.tables
where table_schema = 'public'
  and (table_name like 'archidekt%' or table_name like 'deck_sim%' or table_name like 'forge_%');

-- Namen klein geschrieben, wie CardDataService.lookupKey() sie schickt - sonst kommt 0 zurück.
select public.winning_combos_in_deck(array['thassa''s oracle', 'demonic consultation'], array[]::text[])
  as urteil_f_funktioniert;
