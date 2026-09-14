# Die Regelstellen, nach denen die Simulation spielt

Diese Datei ist der Beleg für `src/app/goldfish-sim.ts` und `src/app/mana-symbols.ts`. Jede Regel,
nach der die Simulation spielt, steht dort im Code mit ihrer Nummer — und hier im Wortlaut, damit
niemand sie aus dem Gedächtnis nachprüfen muss.

## Quelle

|            |                                                                          |
| ---------- | ------------------------------------------------------------------------ |
| Dokument   | Magic: The Gathering Comprehensive Rules                                 |
| Fassung    | gültig ab 7. August 2026                                                 |
| Datei      | `MagicCompRules 20260819.txt`                                            |
| Direktlink | <https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt> |
| Einstieg   | <https://magic.wizards.com/en/rules>                                     |
| Abgerufen  | 2026-09-14                                                               |

Die Regeldatei selbst (955 kB, © Wizards of the Coast) liegt bewusst **nicht** im Repository —
dies ist ein öffentliches Repo, und die Regeln sind bei Wizards in der jeweils gültigen Fassung
abrufbar. Wörtlich zitiert sind unten nur die Absätze, auf die sich der Code stützt; sie stehen
unverändert und auf Englisch da, weil eine Übersetzung schon eine Auslegung wäre.

Eine neue Regelfassung erscheint zu jedem Set. Wer sie nachzieht, prüft: Sind die unten zitierten
Absätze noch wortgleich, und heißen sie noch so? Ändert sich etwas, ändert sich auch der Code, der
sie zitiert.

## Zweite Quelle: die Manasymbole

Welches Symbol welche Farbe hat, wie viel Manawert es beisteuert und ob es hybrid oder Phyrexianisch
ist, kommt maschinenlesbar von Scryfall und nicht aus dem Gedächtnis:
<https://api.scryfall.com/symbology> — 75 Einträge mit `represents_mana: true`, übernommen von
`scripts/generate-mana-symbols.js` nach `src/app/mana-symbols.generated.ts`. CR 107.4 unten ist die
Gegenprobe: Es müssen dieselben Symbole sein.

---

## Commander: Format, Deck, Startwerte

**903.1**

> In the Commander variant, a variant created and popularized by fans, each deck is led by a legendary creature designated as that deck’s commander. The Commander variant uses all the normal rules for a Magic game, with the following additions.

**903.2**

> A Commander game may be a two-player game or a multiplayer game. The default multiplayer setup is the Free-for-All variant with the attack multiple players option and without the limited range of influence option. See rule 806, “Free-for-All Variant.”

**903.3**

> Each deck has a legendary card designated as its commander. That card must be either (a) a creature card, (b) a Vehicle card, or (c) a Spacecraft card with one or more power/toughness boxes. This designation is not a characteristic of the object represented by the card; rather, it is an attribute of the card itself. The card retains this designation even when it changes zones.

**903.5a**

> Each deck must contain exactly 100 cards, including its commander. In other words, the minimum deck size and the maximum deck size are both 100.

**903.5b**

> Other than basic lands, each card in a Commander deck must have a different English name. For the purposes of deck construction, cards with interchangeable names have the same English name (see rule 201.3).

**903.7**

> Once the starting player has been determined, each player sets their life total to 40 and draws a hand of seven cards.

**903.8**

> A player may cast a commander they own from the command zone. A commander cast from the command zone costs an additional {2} for each previous time the player casting it has cast it from the command zone that game. This additional cost is informally known as the “commander tax.”

**119.1c**

> In a Commander game, each player’s starting life total is 40. See rule 903, “Commander.”

## Spielbeginn, Starthand, Mulligan

**103.3**

> After the starting player has been determined and any additional steps performed, each player shuffles their deck so that the cards are in a random order. Each player may then shuffle or cut their opponents’ decks. The players’ decks become their libraries.

**103.5**

> Each player draws a number of cards equal to their starting hand size, which is normally seven. (Some effects can modify a player’s starting hand size.) A player who is dissatisfied with their initial hand may take a mulligan. First, the starting player declares whether they will take a mulligan. Then each other player in turn order does the same. Once each player has made a declaration, all players who decided to take mulligans do so at the same time. To take a mulligan, a player shuffles the cards in their hand back into their library, draws a new hand of cards equal to their starting hand size, then puts a number of those cards equal to the number of times that player has taken a mulligan on the bottom of their library in any order. Once a player chooses not to take a mulligan, the remaining cards become that player’s opening hand, and that player may not take any further mulligans. This process is then repeated until no player takes a mulligan. A player can take mulligans until their opening hand would be zero cards, after which they may not take further mulligans.

**103.8**

> The starting player takes their first turn.

**103.8a**

> In a two-player game, the player who plays first skips the draw step (see rule 504, “Draw Step”) of their first turn.

**103.8c**

> In all other multiplayer games, no player skips the draw step of their first turn.

## Zugablauf

**500.1**

> A turn consists of five phases, in this order: beginning, precombat main, combat, postcombat main, and ending. Each of these phases takes place every turn, even if nothing happens during the phase. The beginning, combat, and ending phases are further broken down into steps, which proceed in order.

**502.3**

> Third, the active player determines which permanents they control will untap. Then they untap them all simultaneously. This turn-based action doesn’t use the stack. Normally, all of a player’s permanents untap, but effects can keep one or more of a player’s permanents from untapping.

**502.4**

> No player receives priority during the untap step, so no spells can be cast or resolve and no abilities can be activated or resolve. Any ability that triggers during this step will be held until the next time a player would receive priority, which is usually during the upkeep step. (See rule 503, “Upkeep Step.”)

**503.1**

> The upkeep step has no turn-based actions. Once it begins, the active player gets priority. (See rule 117, “Timing and Priority.”)

**504.1**

> First, the active player draws a card. This turn-based action doesn’t use the stack.

**505.6**

> Fourth, the active player gets priority. (See rule 117, “Timing and Priority.”)

**512.1**

> The ending phase consists of two steps: end and cleanup.

**513.1**

> The end step has no turn-based actions. Once it begins, the active player gets priority. (See rule 117, “Timing and Priority.”)

**121.1**

> A player draws a card by putting the top card of their library into their hand. This is done as a turn-based action during each player’s draw step. It may also be done as part of a cost or effect of a spell or ability.

## Länder

**305.1**

> A player who has priority may play a land card from their hand during a main phase of their turn when the stack is empty. Playing a land is a special action; it doesn’t use the stack (see rule 116). Rather, the player simply puts the land onto the battlefield. Since the land doesn’t go on the stack, it is never a spell, and players can’t respond to it with instants or activated abilities.

**305.2**

> A player can normally play one land during their turn; however, continuous effects may increase this number.

**305.2a**

> To determine whether a player can play a land, compare the number of lands the player can play this turn with the number of lands they have already played this turn (including lands played as special actions and lands played during the resolution of spells and abilities). If the number of lands the player can play is greater, the play is legal.

**116.2a**

> Playing a land is a special action. To play a land, a player puts that land onto the battlefield from the zone it was in (usually that player’s hand). By default, a player can take this action only once during each of their turns. A player can take this action any time they have priority and the stack is empty during a main phase of their turn. See rule 305, “Lands.”

## Mana, Manasymbole, Manakosten

**106.1**

> Mana is the primary resource in the game. Players spend mana to pay costs, usually when casting spells and activating abilities.

**106.2**

> Mana is represented by mana symbols (see rule 107.4). Mana symbols also represent mana costs (see rule 202).

**106.4**

> When an effect instructs a player to add mana, that mana goes into a player’s mana pool. From there, it can be used to pay costs immediately, or it can stay in the player’s mana pool as unspent mana. Each player’s mana pool empties at the end of each step and phase, and the player is said to lose this mana. Cards with abilities that produce mana or refer to unspent mana have received errata in the Oracle™ card reference to no longer explicitly refer to the mana pool.

**106.12**

> To “tap [a permanent] for mana” is to activate a mana ability of that permanent that includes the {T} symbol in its activation cost. See rule 605, “Mana Abilities.”

**107.3**

> Many objects use the letter X as a placeholder for a number that needs to be determined. Some objects have abilities that define the value of X; the rest let their controller choose the value of X.

**107.4**

> The mana symbols are {W}, {U}, {B}, {R}, {G}, and {C}; the numerical symbols {0}, {1}, {2}, {3}, {4}, and so on; the variable symbol {X}; the hybrid symbols {W/U}, {W/B}, {U/B}, {U/R}, {B/R}, {B/G}, {R/G}, {R/W}, {G/W}, and {G/U}; the monocolored hybrid symbols {2/W}, {2/U}, {2/B}, {2/R}, {2/G}, {C/W}, {C/U}, {C/B}, {C/R}, and {C/G}; the Phyrexian mana symbols {W/P}, {U/P}, {B/P}, {R/P}, and {G/P}; the hybrid Phyrexian symbols {W/U/P}, {W/B/P}, {U/B/P}, {U/R/P}, {B/R/P}, {B/G/P}, {R/G/P}, {R/W/P}, {G/W/P}, and {G/U/P}; and the snow mana symbol {S}.

**107.4a**

> There are five primary colored mana symbols: {W} is white, {U} blue, {B} black, {R} red, and {G} green. These symbols are used to represent colored mana, and also to represent colored mana in costs. Colored mana in costs can be paid only with the appropriate color of mana. See rule 202, “Mana Cost and Color.”

**107.4b**

> Numerical symbols (such as {1}) and variable symbols (such as {X}) represent generic mana in costs. Generic mana in costs can be paid with any type of mana. For more information about {X}, see rule 107.3.

**107.4c**

> The colorless mana symbol {C} is used to represent one colorless mana, and also to represent a cost that can be paid only with one colorless mana.

**107.4e**

> A hybrid mana symbol is also a colored mana symbol, even if one of its components is colorless. Each one represents a cost that can be paid in one of two ways, as represented by the two halves of the symbol. A hybrid symbol such as {W/U} can be paid with either white or blue mana, and a monocolored hybrid symbol such as {2/B} can be paid with either one black mana or two mana of any type. A hybrid mana symbol is all of its component colors.

**107.4f**

> Phyrexian mana symbols are colored mana symbols: {W/P} is white, {U/P} is blue, {B/P} is black, {R/P} is red, and {G/P} is green. A Phyrexian mana symbol represents a cost that can be paid either with one mana of its color or by paying 2 life. There are also ten hybrid Phyrexian mana symbols. A hybrid Phyrexian mana symbol represents a cost that can be paid with one mana of either of its component colors or by paying 2 life. A hybrid Phyrexian mana symbol is both of its component colors.

**107.4h**

> When used in a cost, the snow mana symbol {S} represents a cost that can be paid with one mana of any type produced by a snow source (see rule 106.3). Effects that reduce the amount of generic mana you pay don’t affect {S} costs. The {S} symbol can also be used to refer to mana of any type produced by a snow source spent to pay a cost. Snow is neither a color nor a type of mana.

**202.1**

> A card’s mana cost is indicated by mana symbols near the top of the card. (See rule 107.4.) On most cards, these symbols are printed in the upper right corner. Some cards from the Future Sight set have alternate frames in which the mana symbols appear to the left of the illustration.

**202.3**

> The mana value of an object is a number equal to the total amount of mana in its mana cost, regardless of color.

**202.3e**

> When calculating the mana value of an object with an {X} in its mana cost, X is treated as 0 while the object is not on the stack, and X is treated as the number chosen for it while the object is on the stack.

**202.3f**

> When calculating the mana value of an object with a hybrid mana symbol in its mana cost, use the largest component of each hybrid symbol.

## Zaubersprüche wirken und bezahlen

**601.2**

> To cast a spell is to take it from where it is (usually the hand), put it on the stack, and pay its costs, so that it will eventually resolve and have its effect. Casting a spell includes proposal of the spell (rules 601.2a–d) and determination and payment of costs (rules 601.2f–h). To cast a spell, a player follows the steps listed below, in order. A player must be legally allowed to cast the spell to begin this process (see rule 601.3). If a player is unable to comply with the requirements of a step listed below while performing that step, the casting of the spell is illegal; the game returns to the moment before the casting of that spell was proposed (see rule 733, “Handling Illegal Actions”).

**601.2b**

> If the spell is modal, the player announces the mode choice (see rule 700.2). If the player wishes to splice any cards onto the spell (see rule 702.47), they reveal those cards in their hand. If the spell has alternative or additional costs that will be paid as it’s being cast such as buyback or kicker costs (see rules 118.8 and 118.9), the player announces their intentions to pay any or all of those costs (see rule 601.2f). A player can’t apply two alternative methods of casting or two alternative costs to a single spell. If the spell has a variable cost that will be paid as it’s being cast (such as an {X} in its mana cost; see rule 107.3), the player announces the value of that variable. If the value of that variable is defined in the text of the spell by a choice that player would make later in the announcement or resolution of the spell, that player makes that choice at this time instead of that later time. If a cost that will be paid as the spell is being cast includes hybrid mana symbols, the player announces the nonhybrid equivalent cost they intend to pay. If a cost that will be paid as the spell is being cast includes Phyrexian mana symbols, the player announces whether they intend to pay 2 life or a corresponding colored mana cost for each of those symbols. Previously made choices (such as choosing to cast a spell with flashback from a graveyard or choosing to cast a creature with morph face down) may restrict the player’s options when making these choices.

**601.2f**

> The player determines the total cost of the spell. Usually this is just the mana cost. Some spells have additional or alternative costs. Some effects may increase or reduce the cost to pay, or may provide other alternative costs. Costs may include paying mana, tapping permanents, sacrificing permanents, discarding cards, and so on. The total cost is the mana cost or alternative cost (as determined in rule 601.2b), plus all additional costs and cost increases, and minus all cost reductions. If multiple cost reductions apply, the player may apply them in any order. If the mana component of the total cost is reduced to nothing by cost reduction effects, it is considered to be {0}. It can’t be reduced to less than {0}. Once the total cost is determined, any effects that directly affect the total cost are applied. Then the resulting total cost becomes “locked in.” If effects would change the total cost after this time, they have no effect.

**601.2g**

> If the total cost includes a mana payment, the player then has a chance to activate mana abilities (see rule 605, “Mana Abilities”). Mana abilities must be activated before costs are paid.

**118.3**

> A player can’t pay a cost without having the necessary resources to pay it fully. For example, a player with only 1 life can’t pay a cost of 2 life, and a permanent that’s already tapped can’t be tapped to pay a cost. See rule 202, “Mana Cost and Color,” and rule 602, “Activating Activated Abilities.”

**118.3b**

> Paying life is done by subtracting the indicated amount of life from a player’s life total. (Players can always pay 0 life.)

## Manafähigkeiten und Einsatzverzögerung

**605.1a**

> An activated ability is a mana ability if it meets all of the following criteria: it doesn’t require a target (see rule 115.6), it could add mana to a player’s mana pool when it resolves, it’s not a loyalty ability (see rule 606, “Loyalty Abilities”), and its cost and effect don’t move any card to or from a library. Do not take into account replacement effects that may apply, other than self-replacement effects, when evaluating these criteria.

**605.3a**

> A player may activate an activated mana ability whenever they have priority, whenever they are casting a spell or activating an ability that requires a mana payment, or whenever a rule or effect asks for a mana payment, even if it’s in the middle of casting or resolving a spell or activating or resolving an ability.

**302.1**

> A player who has priority may cast a creature card from their hand during a main phase of their turn when the stack is empty. Casting a creature as a spell uses the stack. (See rule 601, “Casting Spells.”)

**302.6**

> A creature’s activated ability with the tap symbol or the untap symbol in its activation cost can’t be activated unless the creature has been under its controller’s control continuously since their most recent turn began. A creature can’t attack unless it has been under its controller’s control continuously since their most recent turn began. This rule is informally called the “summoning sickness” rule.

**701.26a**

> To tap a permanent, turn it sideways from an upright position. Only untapped permanents can be tapped.

**701.26b**

> To untap a permanent, rotate it back to the upright position from a sideways position. Only tapped permanents can be untapped.
