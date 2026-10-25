-- Deck-Varianten: mehrere Fassungen desselben Decks (z. B. Bracket 4 und Bracket 2/3 mit demselben
-- Commander, physisch ein Deck mit markierten Tauschkarten) lassen sich verknüpfen. Die Deck-Ansicht
-- zeigt dann, welche Karten in beiden gleich sind und welche nur in einer Variante stehen.
--
-- Eine Spalte an decks, keine eigene Tabelle: Decks mit demselben variant_group sind Varianten
-- voneinander, null = keine Variante. Wie beim Primer KEINE neue Policy - Lesen folgt der
-- Sichtbarkeit des Decks (eine private Variante bleibt für andere unsichtbar), Schreiben dem
-- bestehenden Update-Recht. Statistiken hängen weiter am einzelnen Deck und bleiben getrennt.
--
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Gefahrlos mehrfach ausführbar.

alter table public.decks
  add column if not exists variant_group uuid;

comment on column public.decks.variant_group is
  'Decks mit demselben Wert sind Varianten voneinander (z. B. Bracket-4- und Bracket-2-Fassung). null = keine Variante.';

create index if not exists decks_variant_group_idx
  on public.decks (variant_group)
  where variant_group is not null;
