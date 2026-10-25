-- Teil 1 von 5: neue Tabellen anlegen (aus sql/spellbook-combo-card-arrays-2026-09-20.sql)

drop index if exists public.spellbook_combo_cards_name_idx;

create table if not exists public.spellbook_card_names (
  id integer primary key generated always as identity,
  name_normalized text not null unique
);

create table if not exists public.spellbook_combo_cardlists (
  combo_id text primary key references public.spellbook_combos (id) on delete cascade,
  card_ids integer[] not null,
  commander_ids integer[] not null default '{}',
  synced_at timestamptz not null default now(),
  constraint spellbook_combo_cardlists_karten_check
    check (cardinality(card_ids) between 2 and 5),
  constraint spellbook_combo_cardlists_commander_check
    check (commander_ids <@ card_ids)
);

create index if not exists spellbook_combo_cardlists_karten_idx
  on public.spellbook_combo_cardlists using gin (card_ids);

create index if not exists spellbook_combo_cardlists_synced_at_idx
  on public.spellbook_combo_cardlists (synced_at);

alter table public.spellbook_card_names enable row level security;
alter table public.spellbook_combo_cardlists enable row level security;

drop policy if exists "Spellbook card names are readable by anyone" on public.spellbook_card_names;
create policy "Spellbook card names are readable by anyone"
on public.spellbook_card_names
for select
to anon, authenticated
using (true);

drop policy if exists "Spellbook combo cardlists are readable by anyone" on public.spellbook_combo_cardlists;
create policy "Spellbook combo cardlists are readable by anyone"
on public.spellbook_combo_cardlists
for select
to anon, authenticated
using (true);
