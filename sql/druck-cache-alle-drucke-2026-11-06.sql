-- Preis, Seltenheit, Setname und Artwork für ALLE Drucke statt nur für die, die schon in einer
-- Sammlung liegen (Wunsch des Users, 06.11.2026: beim Öffnen der Sammlung lud die App nach dem
-- Scannen hunderte Drucke live bei Scryfall nach - "Preise und Seltenheiten werden geladen …
-- xx/380" -, weil scryfall_print_info nur Drucke kannte, die zur Zeit des letzten Nachtlaufs in
-- einer Sammlung lagen).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent. Ersetzt die Tabelle
-- scryfall_print_info aus sql/karten-cache-ausbau-2026-10-22.sql.
--
-- scryfall_prints: eine Zeile je Druck aus Scryfalls default_cards (alle Papier-Drucke, englisch
-- oder - wenn es keinen englischen gibt - in der einzigen Sprache), ~110.000 Zeilen. Gefüllt von
-- Teil 5 des Nachtlaufs (scripts/sync-scryfall-bulk.js), der die Datei für die Deck-Preise ohnehin
-- schon herunterlädt.
--
-- Bewusst schlank, damit es bei grob 20 MB bleibt:
--   * keine Legalitäten als jsonb (das wären allein ~45 MB), sondern `legal_mask`: ein Bit je
--     Format, gesetzt bei "legal" oder "restricted". Die Reihenfolge der Formate steht in
--     LEGALITY_FORMATS - zweimal, im Nachtlauf und in collection.service.ts, beide gleich halten.
--   * kein Index auf synced_at: das nächtliche Aufräumen liest 110.000 Zeilen in Millisekunden.
--
-- `print_key` ist "set/nummer" (z.B. "mh1/123"). Darüber findet die App fremdsprachige Drucke:
-- default_cards enthält sie nicht, ihr Preis kommt ohnehin vom englischen Druck desselben Sets
-- mit derselben Nummer (Cardmarket-Preise hängen am englischen Druck, Anzeige "≈").
--
-- Bis der Nachtlauf die Tabelle gefüllt hat, fragt die App wie bisher Scryfall. Zurück zum alten
-- Stand: sql/karten-cache-ausbau-2026-10-22.sql erneut ausführen und diese Tabelle löschen.

create table if not exists public.scryfall_prints (
  scryfall_id uuid primary key,
  print_key text not null,
  rarity text,
  set_name text,
  illustration_id uuid,
  eur numeric(10, 2),
  eur_foil numeric(10, 2),
  legal_mask integer not null default 0,
  synced_at timestamptz not null default now()
);

comment on table public.scryfall_prints is
  'Preis (normal/Foil), Seltenheit, Setname, Artwork und Legalitäten (Bitmaske) je Druck aus Scryfalls default_cards. print_key = "set/nummer". Gefüllt vom nächtlichen Scryfall-Abgleich, Teil 5.';

-- Kein unique: ändert Scryfall die ID eines Drucks, stünden alte und neue Zeile bis zum Aufräumen
-- am Ende desselben Laufs kurz nebeneinander - ein unique-Index ließe den Lauf dabei scheitern.
create index if not exists scryfall_prints_print_key on public.scryfall_prints (print_key);

alter table public.scryfall_prints enable row level security;

drop policy if exists "Prints are readable by anyone" on public.scryfall_prints;
create policy "Prints are readable by anyone"
on public.scryfall_prints
for select
to public
using (true);

grant select on public.scryfall_prints to anon, authenticated;

-- Die alte Tabelle (nur Sammlungsdrucke) wird nicht mehr gelesen oder geschrieben.
drop table if exists public.scryfall_print_info;

notify pgrst, 'reload schema';
