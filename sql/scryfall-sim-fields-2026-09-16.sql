-- Drei Kartenfelder nachziehen, die der Deck-Simulator braucht und die bisher nirgends liegen.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent ("add column if not exists"),
-- ein zweiter Lauf tut nichts.
--
-- WOZU: Der Goldfish-Simulator (src/app/goldfish-sim.ts) spielt ein Deck ohne Gegner aus und
-- misst, in welchem Zug es gewinnen könnte. Zwei Abbruchbedingungen gibt es dafür - eine
-- gewinnende Combo steht, oder das Board schlägt in einem Zug tödlichen Schaden. Die zweite ist
-- mit dem bisherigen Bestand gar nicht rechenbar: scryfall_cards führt zu jeder Karte Typzeile,
-- Manabetrag und Oracle-Text, aber WEDER Stärke NOCH Widerstandskraft. Ohne sie sieht jedes
-- Kreaturendeck gleich langsam aus, egal ob es auf Zug 5 mit 40 Schaden angreifen könnte oder mit
-- 4 - und genau dieser Unterschied ist einer der gesuchten zwischen den Brackets.
--
-- Warum power/toughness als TEXT und nicht als Zahl: Auf der Karte steht nicht immer eine Zahl.
-- "*" (Tarmogoyf), "1+*" (Nightmare), "*/*" und "?" kommen vor; Scryfall liefert sie wörtlich.
-- Eine numerische Spalte müsste sie auf null werfen und damit stillschweigend behaupten, die
-- Kreatur habe keine Stärke. Der Simulator wertet den Text selbst aus und rechnet eine Karte mit
-- variabler Stärke bewusst konservativ (siehe parsePower() in sim-card-profile.ts).
--
-- back_oracle_text ist die dritte Lücke: Bei modalen Doppelkarten (MDFC) steht auf der Rückseite
-- oft ein Land - "Agadeem's Awakening // Agadeem, the Undercrypt". Ob dieses Land getappt ins
-- Spiel kommt, steht ausschließlich im Rückseitentext. Solche Karten sind in durchgebauten Decks
-- verbreitet und in Precons fast nie; sie zu übersehen hieße, ausgerechnet dort danebenzuliegen,
-- wo der Simulator unterscheiden soll. back_type_line liegt bereits vor, der Text bisher nicht.
--
-- Gefüllt wird das alles vom bestehenden Nachtlauf (scripts/sync-scryfall-bulk.js); dieser Lauf
-- schreibt jede Karte ohnehin per upsert neu, die Spalten sind also nach dem nächsten Durchgang
-- vollständig. Bis dahin stehen sie auf null - der Simulator behandelt null wie "keine Kreatur"
-- bzw. "kein Rückseitentext" und rechnet weiter, statt zu scheitern.

alter table public.scryfall_cards
  add column if not exists power text,
  add column if not exists toughness text,
  add column if not exists back_oracle_text text;

comment on column public.scryfall_cards.power is
  'Stärke wörtlich wie bei Scryfall, inklusive der Sonderformen "*" und "1+*". Nur für Kreaturen gesetzt. Vom Goldfish-Simulator für die Abbruchbedingung "tödlicher Schaden in einem Zug" gebraucht.';
comment on column public.scryfall_cards.toughness is
  'Widerstandskraft wörtlich wie bei Scryfall. Gegenstück zu power; steht mit dabei, weil eine Kreatur ohne beides in keiner Auswertung vollständig ist.';
comment on column public.scryfall_cards.back_oracle_text is
  'Oracle-Text der Rückseite, nur bei echten umdrehbaren Karten (Transform/MDFC) gesetzt - gleiche Bedingung wie back_type_line. Der Simulator liest daraus, ob ein MDFC-Land getappt ins Spiel kommt.';
