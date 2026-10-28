// Детерминированная верификация соответствия запрошенного пользователем матча
// командам, извлечённым из VERIFIED DATA PACK.
// Это НЕ независимое подтверждение существования матча (такого источника нет):
// guard гарантирует лишь, что расчёт ведётся для тех же команд, что запросил
// пользователь, и что VDP реально содержит идентифицированные команды.

export type MatchVerificationResult =
  | { ok: true }
  | { ok: false; reason: 'input_unparsable' | 'vdp_teams_missing' | 'teams_mismatch' };

const TEAM_SUFFIX_TOKENS = new Set([
  'fc', 'sc', 'cf', 'afc', 'club', 'team', 'national', 'фк', 'ск', 'ac',
]);

const CROSS_LANG_ALIAS_GROUPS: Array<string[]> = [
  ['venezia', 'венеция'],
  ['inter', 'inter milan', 'internazionale', 'internazionale milano', 'fc internazionale milano', 'интер'],
  ['milan', 'ac milan', 'милан'],
  ['juventus', 'ювентус'],
  ['roma', 'рома'],
  ['napoli', 'наполи'],
  ['lazio', 'лацио'],
  ['fiorentina', 'фиорентина'],
  ['atalanta', 'аталанта'],
  ['torino', 'торино'],
  ['bologna', 'болонья'],
  ['genoa', 'дженоа'],
  ['sampdoria', 'сампдория'],
  ['verona', 'верона'],
  ['cagliari', 'кальяри'],
  ['udinese', 'удинезе'],
  ['sassuolo', 'сассуоло'],
  ['empoli', 'эмполи'],
  ['lecce', 'лечче'],
  ['monza', 'монца'],
  ['como', 'комо'],
  ['parma', 'парма'],
  ['barcelona', 'барселона'],
  ['real madrid', 'реал мадрид'],
  ['atletico madrid', 'атлетико мадрид'],
  ['sevilla', 'севилья'],
  ['valencia', 'валенсия'],
  ['real sociedad', 'реал сосьедад'],
  ['villarreal', 'вильярреал'],
  ['athletic bilbao', 'атлетик бильбао'],
  ['betis', 'бетис'],
  ['celta vigo', 'сельта виго'],
  ['granada', 'гранада'],
  ['mallorca', 'мальорка'],
  ['girona', 'жирона'],
  ['alaves', 'алавес'],
  ['rayo vallecano', 'райо вальекано'],
  ['las palmas', 'лас пальмас'],
  ['bayern', 'bayern munich', 'bayern munchen', 'бавария', 'бавария мюнхен'],
  ['borussia dortmund', 'боруссия дортмунд'],
  ['magdeburg', '1 magdeburg', '1 fc magdeburg', 'магдебург'],
  ['rb leipzig', 'рб лейпциг'],
  ['bayer leverkusen', 'байер леверкузен'],
  ['eintracht frankfurt', 'айнтрахт франкфурт'],
  ['wolfsburg', 'вольфсбург'],
  ['stuttgart', 'штутгарт'],
  ['freiburg', 'фрайбург'],
  ['union berlin', 'унион берлин'],
  ['hertha berlin', 'герта берлин'],
  ['mainz', 'майц'],
  ['augsburg', 'аугсбург'],
  ['koln', 'кёльн'],
  ['bochum', 'бохум'],
  ['heidenheim', 'хайденхайм'],
  ['darmstadt', 'дармштадт'],
  ['paris saint germain', 'пари сен жермен'],
  ['marseille', 'марсель'],
  ['lyon', 'лион'],
  ['monaco', 'монако'],
  ['lille', 'лиль'],
  ['nice', 'ницца'],
  ['rennes', 'ренн'],
  ['lens', 'ланс'],
  ['montpellier', 'монпелье'],
  ['strasbourg', 'страсбур'],
  ['toulouse', 'тулуза'],
  ['nantes', 'нант'],
  ['reims', 'реймс'],
  ['brest', 'брест'],
  ['le havre', 'ле гавр'],
  ['metz', 'мец'],
  ['lorient', 'лорьян'],
  ['clermont', 'клермон'],
  ['manchester united', 'манчестер юнайтед'],
  ['manchester city', 'манчестер сити'],
  ['liverpool', 'ливерпуль'],
  ['arsenal', 'арсенал'],
  ['chelsea', 'челси'],
  ['tottenham', 'тоттенхэм'],
  ['newcastle', 'ньюкасл'],
  ['aston villa', 'астон вилла'],
  ['west ham', 'вест хэм'],
  ['brighton', 'брайтон'],
  ['crystal palace', 'кристал пэлас'],
  ['wolverhampton', 'вулверхэмптон'],
  ['fulham', 'фулхэм'],
  ['bournemouth', 'борнмут'],
  ['nottingham forest', 'ноттингем форест'],
  ['everton', 'эвертон'],
  ['brentford', 'брентфорд'],
  ['sheffield united', 'шеффилд юнайтед'],
  ['burnley', 'бернли'],
  ['luton town', 'лутон таун'],
  ['ajax', 'аякс'],
  ['psv', 'псв'],
  ['feyenoord', 'фейеноорд'],
  ['benfica', 'бенфика'],
  ['porto', 'порту'],
  ['sporting lisbon', 'спортинг лиссабон'],
  ['galatasaray', 'галатасарай'],
  ['fenerbahce', 'фенербахче'],
  ['besiktas', 'бешикташ'],
  ['trabzonspor', 'трабзонспор'],
  ['olympiacos', 'олимпиакос'],
  ['panathinaikos', 'панатинаикос'],
  ['paok', 'паок'],
  ['aeck', 'aek athens', 'аек'],
  ['celtic', 'селтик'],
  ['rangers', 'рейнджерс'],
  ['anderlecht', 'андерлехт'],
  ['club brugge', 'брюгге'],
  ['gent', 'гент'],
  ['standard liege', 'стандарт льеж'],
  ['shakhtar donetsk', 'шахтёр донецк'],
  ['dynamo kyiv', 'динамо киев'],
  ['zenit', 'зенит'],
  ['cska moscow', 'цска москва'],
  ['spartak moscow', 'спартак москва'],
  ['lokomotiv moscow', 'локомотив москва'],
  ['dynamo moscow', 'динамо москва'],
  ['krasnodar', 'краснодар'],
  ['rostov', 'ростов'],
  ['rubin kazan', 'рубин казань'],
];

// Ключи карты — имена, нормализованные той же функцией, которая применяется
// при сравнении. Иначе RAW-вариант группы (например 'ac milan' или
// 'bayern munich' при немецком 'Bayern München') становится мёртвым ключом:
// он никогда не совпадает с нормализованным значением из VDP.
function buildCanonicalMap(): Map<string, string> {
  const map = new Map<string, string>();
  const ambiguousKeys = new Set<string>();
  for (const group of CROSS_LANG_ALIAS_GROUPS) {
    const keys = [
      ...new Set(
        group
          .map((variant) => normalizeTeamForVerification(variant))
          .filter((key) => key.length > 0),
      ),
    ].sort();
    if (keys.length === 0) continue;
    const canonical = keys[0];
    for (const key of keys) {
      if (ambiguousKeys.has(key)) continue;
      const existing = map.get(key);
      if (existing !== undefined && existing !== canonical) {
        // Ключ встречается в разных группах: разрешение неоднозначно.
        // Вместо выбора последней группы ключ исключается — обе стороны
        // остаются при своих значениях и совпадут только при точном
        // равенстве нормализованных имён.
        ambiguousKeys.add(key);
        map.delete(key);
        continue;
      }
      map.set(key, canonical);
    }
  }
  return map;
}

const CANONICAL_MAP = buildCanonicalMap();

function resolveAlias(name: string): string {
  return CANONICAL_MAP.get(name) ?? name;
}

export function normalizeTeamForVerification(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLocaleLowerCase()
    .replace(/[üÜ]/g, 'u')
    .replace(/[«»"'.]/g, ' ')
    .replace(/[^a-z0-9а-яё]+/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !TEAM_SUFFIX_TOKENS.has(t))
    .join(' ')
    .trim();
}

// Разбивает пользовательский ввод «Team A - Team B» / «Team A vs Team B»
// на две команды. Возвращает null, если пары нет.
export function extractTeamsFromMatchInput(match: string): [string, string] | null {
  if (!match || typeof match !== 'string') return null;
  const cleaned = match.trim();
  const parts = cleaned.split(/\s+(?:vs\.?|versus|x)\s+|\s*(?:—|–|-|vs\.?)\s*/i);
  const filtered = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  if (filtered.length < 2) return null;
  return [filtered[0], filtered[1]];
}

// Сравнивает команды из пользовательского ввода с командами из VDP.
// Порядок team1/team2 в VDP должен соответствовать порядку во вводе.
export function verifyMatchTeams(
  input: string,
  vdpTeam1Name: string | null | undefined,
  vdpTeam2Name: string | null | undefined,
): MatchVerificationResult {
  const inputTeams = extractTeamsFromMatchInput(input);
  if (!inputTeams) return { ok: false, reason: 'input_unparsable' };

  const vdp1 = normalizeTeamForVerification(vdpTeam1Name);
  const vdp2 = normalizeTeamForVerification(vdpTeam2Name);
  if (!vdp1 || !vdp2) return { ok: false, reason: 'vdp_teams_missing' };

  const in1 = resolveAlias(normalizeTeamForVerification(inputTeams[0]));
  const in2 = resolveAlias(normalizeTeamForVerification(inputTeams[1]));
  if (!in1 || !in2) return { ok: false, reason: 'input_unparsable' };

  const vdp1Resolved = resolveAlias(vdp1);
  const vdp2Resolved = resolveAlias(vdp2);

  if (in1 === vdp1Resolved && in2 === vdp2Resolved) return { ok: true };
  return { ok: false, reason: 'teams_mismatch' };
}

export const MATCH_UNVERIFIED_ERROR =
  'Матч не подтверждён: команды из исследования не соответствуют запрошенному матчу. Вероятности не рассчитаны.';
