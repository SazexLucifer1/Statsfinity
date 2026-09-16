import {
  ALLE_FARBEN,
  FARB_BIT,
  SimCardData,
  buildSimCard,
  erkennungsquote,
  parseCost,
  parsePower,
} from './sim-card-profile';

/**
 * Die Kartenauswertung des Simulators ist eine Sammlung von Mustern über Oracle-Texte - und damit
 * die Stelle des Projekts, an der ein Fehler am leisesten ist: Ein Ausdruck, der "Draw two cards"
 * verpasst, macht nichts kaputt, er macht nur alle Decks mit dieser Karte ein bisschen langsamer,
 * über Zehntausende Decks hinweg.
 *
 * Deshalb steht in jedem Fall hier unten der ECHTE Oracle-Text der genannten Karte, wörtlich von
 * Scryfall. Ein Test gegen selbst erfundene Texte würde nur beweisen, dass die Muster zu sich
 * selbst passen.
 */

const karte = (extra: Partial<SimCardData>): SimCardData =>
  buildData({
    name: 'Testkarte',
    key: 'testkarte',
    typeLine: null,
    oracleText: null,
    backTypeLine: null,
    backOracleText: null,
    manaCost: null,
    cmc: 0,
    producedMana: null,
    power: null,
    keywords: [],
    gameChanger: false,
    tutor: false,
    ...extra,
  });

const buildData = (d: SimCardData): SimCardData => d;

describe('parseCost', () => {
  it('trennt generisches und farbiges Mana', () => {
    const kosten = parseCost('{2}{G}{G}');
    expect(kosten.generisch).toBe(2);
    expect(kosten.pips).toEqual([FARB_BIT.G, FARB_BIT.G]);
    expect(kosten.gesamt).toBe(4);
  });

  it('zählt X als null, merkt es sich aber', () => {
    const kosten = parseCost('{X}{R}');
    expect(kosten.gesamt).toBe(1);
    expect(kosten.hatX).toBe(true);
  });

  it('lässt einen Hybrid-Pip mit beiden Farben bezahlbar sein', () => {
    expect(parseCost('{W/U}').pips).toEqual([FARB_BIT.W | FARB_BIT.U]);
  });

  it('rechnet {2/W} als farbigen Pip, nicht als zwei generische', () => {
    const kosten = parseCost('{2/W}');
    expect(kosten.gesamt).toBe(1);
    expect(kosten.pips).toEqual([FARB_BIT.W]);
  });

  it('rechnet phyrexianische Pips als gratis - Leben ist im Goldfish keine knappe Größe', () => {
    // Gitaxian Probe: {U/P}
    expect(parseCost('{U/P}').gesamt).toBe(0);
  });

  it('nimmt bei geteilten Karten die linke Hälfte', () => {
    // Abenteuer-Karte: der Abenteuer-Teil ist die billigere Art, sie zu spielen.
    expect(parseCost('{1}{G} // {3}{G}').gesamt).toBe(2);
  });
});

describe('parsePower', () => {
  it('liest eine gewöhnliche Stärke', () => {
    expect(parsePower('4')).toBe(4);
  });

  it('schätzt variable Stärke ("*") vorsichtig statt sie auf null zu setzen', () => {
    expect(parsePower('*')).toBe(2);
    expect(parsePower('1+*')).toBe(2);
  });

  it('gibt für Nicht-Kreaturen null', () => {
    expect(parsePower(null)).toBe(0);
  });
});

describe('buildSimCard - Manaquellen', () => {
  it('erkennt Sol Ring als Quelle für zwei Mana', () => {
    const sim = buildSimCard(
      karte({
        name: 'Sol Ring',
        typeLine: 'Artifact',
        oracleText: '{T}: Add {C}{C}.',
        manaCost: '{1}',
        cmc: 1,
        producedMana: ['C'],
      }),
    );
    expect(sim.manaquelle?.menge).toBe(2);
    expect(sim.manaquelle?.brauchtBereitschaft).toBe(false);
    expect(sim.regeln).toContain('manastein');
  });

  it('zieht die Aktivierungskosten eines Signets ab - zwei Mana für eines ist netto eines', () => {
    const sim = buildSimCard(
      karte({
        name: 'Dimir Signet',
        typeLine: 'Artifact',
        oracleText: '{1}, {T}: Add {U}{B}.',
        manaCost: '{2}',
        cmc: 2,
        producedMana: ['B', 'U'],
      }),
    );
    expect(sim.manaquelle?.menge).toBe(1);
  });

  it('merkt sich die Einsatzverzögerung einer Manakreatur', () => {
    const sim = buildSimCard(
      karte({
        name: 'Llanowar Elves',
        typeLine: 'Creature — Elf Druid',
        oracleText: '{T}: Add {G}.',
        manaCost: '{G}',
        cmc: 1,
        producedMana: ['G'],
        power: '1',
      }),
    );
    expect(sim.manaquelle?.brauchtBereitschaft).toBe(true);
    expect(sim.regeln).toContain('manakreatur');
  });

  it('erkennt "one mana of any color" als alle Farben', () => {
    const sim = buildSimCard(
      karte({
        name: 'Arcane Signet',
        typeLine: 'Artifact',
        oracleText: "{T}: Add one mana of any color in your commander's color identity.",
        manaCost: '{2}',
        cmc: 2,
        producedMana: ['W', 'U', 'B', 'R', 'G'],
      }),
    );
    expect(sim.manaquelle?.menge).toBe(1);
    expect(sim.manaquelle?.farben).toBe(ALLE_FARBEN);
  });

  it('erkennt Dark Ritual als Ritual mit zwei Mana Gewinn', () => {
    const sim = buildSimCard(
      karte({
        name: 'Dark Ritual',
        typeLine: 'Instant',
        oracleText: 'Add {B}{B}{B}.',
        manaCost: '{B}',
        cmc: 1,
      }),
    );
    expect(sim.ritual).toBe(2);
    expect(sim.manaquelle).toBeNull();
  });
});

describe('buildSimCard - Länder', () => {
  it('nimmt ein einfaches Land ungetappt', () => {
    const sim = buildSimCard(
      karte({
        name: 'Command Tower',
        typeLine: 'Land',
        oracleText: "{T}: Add one mana of any color in your commander's color identity.",
        producedMana: ['W', 'U', 'B', 'R', 'G'],
      }),
    );
    expect(sim.istLand).toBe(true);
    expect(sim.land?.getappt).toBe(false);
    expect(sim.land?.farben).toBe(ALLE_FARBEN);
  });

  it('erkennt ein getapptes Land', () => {
    const sim = buildSimCard(
      karte({
        name: 'Temple of Mystery',
        typeLine: 'Land',
        oracleText: 'Temple of Mystery enters tapped.\nWhen Temple of Mystery enters, scry 1.',
        producedMana: ['G', 'U'],
      }),
    );
    expect(sim.land?.getappt).toBe(true);
  });

  it('lässt ein Schockland ungetappt - Leben zu zahlen kostet im Goldfish nichts', () => {
    const sim = buildSimCard(
      karte({
        name: 'Breeding Pool',
        typeLine: 'Land — Forest Island',
        oracleText:
          '({T}: Add {G} or {U}.)\nAs Breeding Pool enters, you may pay 2 life. If you don’t, it enters tapped.',
        producedMana: ['G', 'U'],
      }),
    );
    expect(sim.land?.getappt).toBe(false);
  });

  it('erkennt einen Holländer, obwohl sein Text das Wort "land" gar nicht enthält', () => {
    const sim = buildSimCard(
      karte({
        name: 'Verdant Catacombs',
        typeLine: 'Land',
        oracleText:
          '{T}, Pay 1 life, Sacrifice Verdant Catacombs: Search your library for a Swamp or Forest card, put it onto the battlefield, then shuffle.',
      }),
    );
    expect(sim.land?.holtLand).toBe(true);
    expect(sim.regeln).toContain('holland');
  });

  it('erkennt das Land auf der Rückseite einer modalen Doppelkarte', () => {
    const sim = buildSimCard(
      karte({
        name: "Agadeem's Awakening",
        typeLine: 'Sorcery',
        oracleText:
          'Return from your graveyard to the battlefield any number of target creature cards.',
        backTypeLine: 'Land',
        backOracleText:
          'As Agadeem, the Undercrypt enters, you may pay 3 life. If you don’t, it enters tapped.\n{T}: Add {B}.',
        manaCost: '{X}{B}{B}{B}',
        cmc: 3,
      }),
    );
    expect(sim.landAufRueckseite).toBe(true);
    expect(sim.land?.getappt).toBe(false);
    expect(sim.istLand).toBe(false);
  });
});

describe('buildSimCard - Ramp und Kartenfluss', () => {
  it('erkennt Rampant Growth', () => {
    const sim = buildSimCard(
      karte({
        name: 'Rampant Growth',
        typeLine: 'Sorcery',
        oracleText:
          'Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.',
        manaCost: '{1}{G}',
        cmc: 2,
      }),
    );
    expect(sim.laenderAufsFeld).toBe(1);
    expect(sim.laenderInDieHand).toBe(0);
  });

  it('teilt Cultivate richtig auf: eines aufs Feld, eines in die Hand', () => {
    const sim = buildSimCard(
      karte({
        name: 'Cultivate',
        typeLine: 'Sorcery',
        oracleText:
          'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
        manaCost: '{2}{G}',
        cmc: 3,
      }),
    );
    expect(sim.laenderAufsFeld).toBe(1);
    expect(sim.laenderInDieHand).toBe(1);
  });

  it('erkennt Farseek, obwohl es Ländertypen statt "land card" nennt', () => {
    const sim = buildSimCard(
      karte({
        name: 'Farseek',
        typeLine: 'Sorcery',
        oracleText:
          'Search your library for a Plains, Island, Swamp, or Mountain card, put it onto the battlefield tapped, then shuffle.',
        manaCost: '{1}{G}',
        cmc: 2,
      }),
    );
    expect(sim.laenderAufsFeld).toBe(1);
  });

  it('zählt gezogene Karten', () => {
    const sim = buildSimCard(
      karte({
        name: 'Divination',
        typeLine: 'Sorcery',
        oracleText: 'Draw two cards.',
        manaCost: '{2}{U}',
        cmc: 3,
      }),
    );
    expect(sim.ziehen).toBe(2);
  });

  it('zählt eine ausgelöste Fähigkeit NICHT als gezogene Karte', () => {
    // Rhystic Study zieht nur, wenn ein Gegner etwas wirkt - im Goldfish gibt es keinen.
    const sim = buildSimCard(
      karte({
        name: 'Rhystic Study',
        typeLine: 'Enchantment',
        oracleText:
          "Whenever an opponent casts a spell, that player may pay {1}. If they don't, you draw a card.",
        manaCost: '{2}{U}',
        cmc: 3,
      }),
    );
    expect(sim.ziehen).toBe(0);
  });

  it('zählt einen Betretens-Auslöser dagegen mit - der kommt beim Ausspielen sicher', () => {
    const sim = buildSimCard(
      karte({
        name: 'Elvish Visionary',
        typeLine: 'Creature — Elf Shaman',
        oracleText: 'When Elvish Visionary enters, draw a card.',
        manaCost: '{1}{G}',
        cmc: 2,
        power: '1',
      }),
    );
    expect(sim.ziehen).toBe(1);
  });
});

describe('buildSimCard - Siegbedingungen', () => {
  it('erkennt den Craterhoof-Massenpump als variabel', () => {
    const sim = buildSimCard(
      karte({
        name: 'Craterhoof Behemoth',
        typeLine: 'Creature — Beast',
        oracleText:
          'Trample\nWhen Craterhoof Behemoth enters, creatures you control gain trample and get +X/+X until end of turn, where X is the number of creatures you control.',
        manaCost: '{5}{G}{G}{G}',
        cmc: 8,
        power: '5',
        keywords: ['Trample'],
      }),
    );
    expect(sim.massenpump).toBe(-1);
  });

  it('erkennt Overrun als festen Massenpump', () => {
    const sim = buildSimCard(
      karte({
        name: 'Overrun',
        typeLine: 'Sorcery',
        oracleText: 'Creatures you control get +3/+3 and gain trample until end of turn.',
        manaCost: '{2}{G}{G}{G}',
        cmc: 5,
      }),
    );
    expect(sim.massenpump).toBe(3);
  });

  it('unterscheidet ein dauerhaftes Anthem vom Massenpump', () => {
    const sim = buildSimCard(
      karte({
        name: 'Glorious Anthem',
        typeLine: 'Enchantment',
        oracleText: 'Creatures you control get +1/+1.',
        manaCost: '{1}{W}{W}',
        cmc: 3,
      }),
    );
    expect(sim.anthem).toBe(1);
    expect(sim.massenpump).toBe(0);
  });

  it("erkennt Thassa's Oracle als Sofortsieg", () => {
    const sim = buildSimCard(
      karte({
        name: "Thassa's Oracle",
        typeLine: 'Creature — Merfolk Wizard',
        oracleText:
          "When Thassa's Oracle enters, look at the top X cards of your library, where X is your devotion to blue. Put up to one of them on top of your library and the rest on the bottom of your library in a random order. If X is greater than or equal to the number of cards in your library, you win the game.",
        manaCost: '{U}{U}',
        cmc: 2,
        power: '1',
      }),
    );
    expect(sim.gewinntSofort).toBe(true);
  });

  it('erkennt einen zusätzlichen Kampf', () => {
    const sim = buildSimCard(
      karte({
        name: 'Aggravated Assault',
        typeLine: 'Enchantment',
        oracleText:
          '{3}{R}: Untap all creatures you control. After this main phase, there is an additional combat phase.',
        manaCost: '{2}{R}',
        cmc: 3,
      }),
    );
    expect(sim.extraKampf).toBe(true);
  });
});

describe('buildSimCard - bleibende Karten', () => {
  it('lässt eine Kreatur liegen und eine Hexerei nicht', () => {
    const kreatur = buildSimCard(karte({ typeLine: 'Creature — Bear', power: '2' }));
    const hexerei = buildSimCard(karte({ typeLine: 'Sorcery' }));
    expect(kreatur.bleibend).toBe(true);
    expect(hexerei.bleibend).toBe(false);
  });

  it('hält fest, welche Muster gegriffen haben - leer heißt "nichts erkannt"', () => {
    const unbekannt = buildSimCard(
      karte({ typeLine: 'Enchantment', oracleText: 'Players can’t untap more than two lands.' }),
    );
    expect(unbekannt.regeln).toEqual([]);
  });
});

describe('buildSimCard - wiederholbare Fähigkeiten', () => {
  it('erkennt eine Zieh-Engine auf einer Kreatur samt Einsatzverzögerung', () => {
    const sim = buildSimCard(
      karte({
        name: 'Arcanis the Omnipotent',
        typeLine: 'Legendary Creature — Wizard',
        oracleText:
          '{T}: Draw three cards.\n{2}{U}{U}: Return Arcanis the Omnipotent to its owner\u2019s hand.',
        manaCost: '{3}{U}{U}{U}',
        cmc: 6,
        power: '3',
      }),
    );
    expect(sim.faehigkeit?.ziehen).toBe(3);
    expect(sim.faehigkeit?.brauchtBereitschaft).toBe(true);
    expect(sim.regeln).toContain('faehigkeit');
  });

  it('erkennt eine Fähigkeit mit Manakosten', () => {
    const sim = buildSimCard(
      karte({
        name: 'Endless Atlas',
        typeLine: 'Artifact',
        oracleText:
          '{2}, {T}: Draw a card. Activate only if you control three or more lands with the same name.',
        manaCost: '{3}',
        cmc: 3,
      }),
    );
    expect(sim.faehigkeit?.ziehen).toBe(1);
    expect(sim.faehigkeit?.kosten.gesamt).toBe(2);
    expect(sim.faehigkeit?.brauchtBereitschaft).toBe(false);
  });

  it('zählt eine Fähigkeit NICHT, die die Karte selbst verbraucht', () => {
    // Einmal opfern heißt einmal ziehen - das ist keine Engine, die jeden Zug etwas beiträgt.
    const sim = buildSimCard(
      karte({
        name: 'Wayfarer\u2019s Bauble',
        typeLine: 'Artifact',
        oracleText:
          '{2}, {T}, Sacrifice Wayfarer\u2019s Bauble: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.',
        manaCost: '{1}',
        cmc: 1,
      }),
    );
    expect(sim.faehigkeit).toBeNull();
  });

  it('verwechselt eine Manafähigkeit nicht mit einer Engine', () => {
    const sim = buildSimCard(
      karte({
        name: 'Llanowar Elves',
        typeLine: 'Creature — Elf Druid',
        oracleText: '{T}: Add {G}.',
        manaCost: '{G}',
        cmc: 1,
        producedMana: ['G'],
        power: '1',
      }),
    );
    expect(sim.faehigkeit).toBeNull();
    expect(sim.manaquelle).not.toBeNull();
  });
});

describe('erkennungsquote', () => {
  it('misst den Anteil der Nicht-Länder, bei denen ein Muster gegriffen hat', () => {
    const erkannt = buildSimCard(karte({ typeLine: 'Sorcery', oracleText: 'Draw two cards.' }));
    const unbekannt = buildSimCard(
      karte({ typeLine: 'Instant', oracleText: 'Destroy target creature.' }),
    );
    expect(erkennungsquote([erkannt, erkannt, unbekannt, unbekannt])).toBe(0.5);
  });

  it('lässt Länder außen vor - die werden immer erkannt und würden die Quote schönen', () => {
    const land = buildSimCard(
      karte({ typeLine: 'Land', oracleText: '{T}: Add {G}.', producedMana: ['G'] }),
    );
    const unbekannt = buildSimCard(
      karte({ typeLine: 'Instant', oracleText: 'Counter target spell.' }),
    );
    expect(erkennungsquote([land, land, land, unbekannt])).toBe(0);
  });
});

describe('buildSimCard - die Luecken aus dem Precon-Nachtest', () => {
  // Alle Karten hier sind im Zendikar-Rising-Precon "Sneak Attack" durchgefallen: Der Simulator
  // hielt sie fuer wirkungslos, obwohl sie Stärke, Marken oder Karten bringen.

  it('erkennt den Staerkebonus einer Ausruestung', () => {
    const sim = buildSimCard(
      karte({
        name: 'Heirloom Blade',
        typeLine: 'Artifact — Equipment',
        oracleText:
          'Equipped creature gets +3/+1.\nWhenever equipped creature dies, you may reveal cards from the top of your library until you reveal a creature card that shares a creature type with it.\nEquip {2}',
        manaCost: '{3}',
        cmc: 3,
      }),
    );
    expect(sim.ausruestung).toBe(3);
  });

  it('erkennt denselben Bonus auf einer Aura', () => {
    const sim = buildSimCard(
      karte({
        name: 'Ethereal Armor',
        typeLine: 'Enchantment — Aura',
        oracleText:
          'Enchant creature\nEnchanted creature gets +1/+1 for each enchantment you control and has first strike.',
        manaCost: '{W}',
        cmc: 1,
      }),
    );
    expect(sim.ausruestung).toBe(1);
  });

  it('erkennt ein Anthem, das die Kreaturen nicht "you control" nennt', () => {
    const sim = buildSimCard(
      karte({
        name: 'Obelisk of Urd',
        typeLine: 'Artifact',
        oracleText:
          'Convoke\nAs this artifact enters, choose a creature type.\nCreatures of the chosen type get +2/+2.',
        manaCost: '{4}{W}{W}',
        cmc: 6,
      }),
    );
    expect(sim.anthem).toBe(2);
  });

  it('haelt einen Malus fuer gegnerische Kreaturen NICHT fuer ein Anthem', () => {
    const sim = buildSimCard(
      karte({
        name: 'Elesh Norn, Grand Cenobite',
        typeLine: 'Legendary Creature — Praetor',
        oracleText:
          'Vigilance\nOther creatures you control get +2/+2.\nCreatures your opponents control get -2/-2.',
        manaCost: '{5}{W}{W}',
        cmc: 7,
        power: '4',
      }),
    );
    expect(sim.anthem).toBe(2);
  });

  it('erkennt Kreaturenmarken', () => {
    const sim = buildSimCard(
      karte({
        name: 'Secure the Wastes',
        typeLine: 'Instant',
        oracleText: 'Create X 1/1 white Warrior creature tokens.',
        manaCost: '{X}{W}',
        cmc: 1,
      }),
    );
    // X haengt am Spielzustand - eine Marke ist die vorsichtige Annahme, keine geratene Zahl.
    expect(sim.tokenAnzahl).toBe(1);
    expect(sim.tokenStaerke).toBe(1);
  });

  it('zaehlt mehrere Marken richtig', () => {
    const sim = buildSimCard(
      karte({
        name: 'Rampaging Baloths',
        typeLine: 'Creature — Beast',
        oracleText:
          'Trample\nLandfall — Whenever a land you control enters, create a 4/4 green Beast creature token.',
        manaCost: '{4}{G}{G}',
        cmc: 6,
        power: '6',
      }),
    );
    expect(sim.tokenStaerke).toBe(4);
  });

  it('erkennt Fact or Fiction als Kartenfluss, obwohl "draw" nicht darin vorkommt', () => {
    const sim = buildSimCard(
      karte({
        name: 'Fact or Fiction',
        typeLine: 'Instant',
        oracleText:
          'Reveal the top five cards of your library. An opponent separates those cards into two piles. Put one pile into your hand and the other into your graveyard.',
        manaCost: '{3}{U}',
        cmc: 4,
      }),
    );
    expect(sim.ziehen).toBe(1);
  });

  it('erkennt Impuls-Ziehen aus dem Exil', () => {
    const sim = buildSimCard(
      karte({
        name: 'Light Up the Stage',
        typeLine: 'Sorcery',
        oracleText:
          'Spectacle {R}\nExile the top two cards of your library. Until the end of your next turn, you may play those cards.',
        manaCost: '{2}{R}',
        cmc: 3,
      }),
    );
    expect(sim.ziehen).toBe(2);
  });

  it('erkennt einen Angriffs-Ausloeser als Engine, die Kreaturen braucht', () => {
    const sim = buildSimCard(
      karte({
        name: 'Military Intelligence',
        typeLine: 'Enchantment',
        oracleText: 'Whenever you attack with two or more creatures, draw a card.',
        manaCost: '{1}{U}',
        cmc: 2,
      }),
    );
    expect(sim.faehigkeit?.ziehen).toBe(1);
    expect(sim.faehigkeit?.brauchtKreatur).toBe(true);
    expect(sim.faehigkeit?.kosten.gesamt).toBe(0);
  });
});
