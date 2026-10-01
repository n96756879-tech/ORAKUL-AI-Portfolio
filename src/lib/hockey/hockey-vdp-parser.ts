import type {
  HockeyVDP,
  HockeyMatchIdentity,
  HockeyTeamData,
  HockeyRecentForm,
  HockeyFormMatch,
  HockeyGoaltending,
  HockeySpecialTeams,
  HockeyShotData,
  HockeyScoringData,
  GoalsByPeriod,
  HockeyH2HMatch,
  HockeyAvailability,
  HockeyInjuredPlayer,
  HockeyPlayerRole,
  HockeyStandingsData,
  HockeyTournamentContext,
  HockeyRegulationResult,
  HockeyOTResult,
  HockeySOResult,
  HockeyOutcomeType,
  HockeyMatchResult,
  MetricValue,
  TemporalMetric,
  TemporalType,
  DataStatus,
  GoalieAvailabilityStatus,
} from './types';
import type { AnalysisSource } from '../../types/analysis';

// -----------------------------------------------------------------------------
// Helper Parsers & Value Wrappers
// -----------------------------------------------------------------------------

function parseNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  const normalized = s.replace(/[\u2013\u2014\u2212]/g, '-').trim();

  // If string is pure missing marker, don't parse numbers out of it
  const upper = normalized.toUpperCase();
  if (
    upper.includes('NOT_FOUND') ||
    upper.includes('НЕ НАЙДЕНО') ||
    upper.includes('NOT APPLICABLE') ||
    upper.includes('НЕПРИМЕНИМО') ||
    upper.includes('UNKNOWN') ||
    upper.includes('НЕИЗВЕСТНО')
  ) {
    return null;
  }

  // Handle formats like .875, 0.875, 21.32%, +3, -1, 21
  const match = normalized.match(/([+-]?\d*(?:\.\d+)?|\.\d+)/);
  if (!match || !match[1] || match[1] === '+' || match[1] === '-') return null;
  const num = parseFloat(match[1]);
  return isNaN(num) ? null : num;
}

function parseMetricValue<T>(
  raw: string | null | undefined,
  parser: (s: string) => T | null,
  defaultConfidence: 'CONFIRMED' | 'PARTIALLY_CONFIRMED' | 'UNCONFIRMED' = 'CONFIRMED'
): MetricValue<T> {
  if (!raw) {
    return { status: 'NOT_FOUND', value: null, confidence: 'UNCONFIRMED' };
  }
  const clean = raw.trim();
  const upper = clean.toUpperCase();

  if (
    upper.includes('NOT_FOUND') ||
    upper.includes('НЕ НАЙДЕНО') ||
    upper.includes('NOT FOUND')
  ) {
    return { status: 'NOT_FOUND', value: null, confidence: 'UNCONFIRMED' };
  }
  if (
    upper.includes('NOT_APPLICABLE') ||
    upper.includes('НЕПРИМЕНИМО') ||
    upper.includes('N/A')
  ) {
    return { status: 'NOT_APPLICABLE', value: null, confidence: 'UNCONFIRMED' };
  }
  if (
    upper.includes('UNKNOWN') ||
    upper.includes('НЕИЗВЕСТНО')
  ) {
    return { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' };
  }

  const confidence: 'CONFIRMED' | 'PARTIALLY_CONFIRMED' | 'UNCONFIRMED' = upper.includes('PARTIALLY_CONFIRMED')
    ? 'PARTIALLY_CONFIRMED'
    : upper.includes('UNCONFIRMED')
    ? 'UNCONFIRMED'
    : upper.includes('CONFIRMED')
    ? 'CONFIRMED'
    : defaultConfidence;

  const parsed = parser(clean);
  if (parsed !== null) {
    return { status: 'FOUND', value: parsed, confidence };
  }

  return { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' };
}

function parseTemporalMetric<T>(
  raw: string | null | undefined,
  parser: (s: string) => T | null,
  defaultTemporalType: TemporalType = 'season_to_date'
): TemporalMetric<T> {
  const base = parseMetricValue(raw, parser);
  if (!raw || base.status !== 'FOUND') {
    return {
      ...base,
      sampleSize: null,
      season: null,
      temporalType: defaultTemporalType,
    };
  }

  const upper = raw.toUpperCase();

  // Extract sampleSize
  let sampleSize: number | null = null;
  const sampleMatch = raw.match(/(\d+)\s*(?:matches|games|appearances|матчей|игр)/i);
  if (sampleMatch) {
    sampleSize = parseInt(sampleMatch[1], 10);
  } else if (
    upper.includes('OPENER') ||
    upper.includes('ONE GAME') ||
    upper.includes('ONE CURRENT-SEASON') ||
    upper.includes('ПЕРВОМ МАТЧЕ')
  ) {
    sampleSize = 1;
  }

  // Extract season
  let season: string | null = null;
  const seasonMatch = raw.match(/20\d\d(?:\/\d\d)?/);
  if (seasonMatch) {
    season = seasonMatch[0];
  }

  // Determine temporalType
  let temporalType: TemporalType = defaultTemporalType;
  if (
    upper.includes('OPENER') ||
    upper.includes('CURRENT-SEASON') ||
    upper.includes('CURRENT_MATCH') ||
    upper.includes('ПЕРВОМ МАТЧЕ') ||
    upper.includes('ONE GAME')
  ) {
    temporalType = 'current_match';
  } else if (
    upper.includes('RECENT') ||
    upper.includes('LAST 5') ||
    upper.includes('RECENT_FORM')
  ) {
    temporalType = 'recent_form';
  } else if (
    upper.includes('2025/26') ||
    upper.includes('PREVIOUS') ||
    upper.includes('ПРОШЛЫЙ СЕЗОН')
  ) {
    temporalType = 'previous_season';
  } else if (upper.includes('H2H')) {
    temporalType = 'historical_h2h';
  }

  return {
    ...base,
    sampleSize,
    season,
    temporalType,
  };
}

// -----------------------------------------------------------------------------
// Markdown Document Structure Parsing Helpers
// -----------------------------------------------------------------------------

interface VDPSection {
  title: string;
  kind:
    | 'MATCH'
    | 'TEAM1_FORM'
    | 'TEAM2_FORM'
    | 'GOALTENDING'
    | 'SPECIAL_TEAMS'
    | 'SHOTS'
    | 'SCORING'
    | 'H2H'
    | 'AVAILABILITY'
    | 'CONTEXT'
    | 'NOT_FOUND'
    | 'OTHER';
  content: string;
}

function splitVDPSections(markdown: string): VDPSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: VDPSection[] = [];

  let currentTitle = 'HEADER';
  let currentLines: string[] = [];

  const flush = () => {
    if (currentLines.length > 0) {
      const content = currentLines.join('\n').trim();
      const kind = classifySectionKind(currentTitle, content);
      sections.push({ title: currentTitle, kind, content });
      currentLines = [];
    }
  };

  for (const line of lines) {
    // Top-level / Major sections start with # or ## (or numbered e.g. ## 1. MATCH)
    const headerMatch = line.match(/^#{1,2}\s+(.+)$/);
    if (headerMatch) {
      flush();
      currentTitle = headerMatch[1].trim();
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

function classifySectionKind(title: string, content: string): VDPSection['kind'] {
  const upper = title.toUpperCase();

  if (
    upper.includes('НЕ НАЙДЕНО') ||
    upper.includes('НЕПРИМЕНИМО') ||
    upper.includes('NOT FOUND')
  ) {
    return 'NOT_FOUND';
  }
  if (upper.includes('GOALTENDING') || upper.includes('ВРАТАРИ')) {
    return 'GOALTENDING';
  }
  if (upper.includes('SPECIAL TEAMS') || upper.includes('СПЕЦБРИГАДЫ')) {
    return 'SPECIAL_TEAMS';
  }
  if (
    upper.includes('SHOT/DEFENSIVE') ||
    upper.includes('DEFENSIVE DATA') ||
    upper.includes('SHOTS') ||
    upper.includes('БРОСКИ')
  ) {
    return 'SHOTS';
  }
  if (upper.includes('SCORING') || upper.includes('ГОЛЫ') || upper.includes('ШТРАФЫ')) {
    return 'SCORING';
  }
  if (
    upper.includes('H2H') ||
    upper.includes('HEAD TO HEAD') ||
    upper.includes('ОЧНЫЕ')
  ) {
    return 'H2H';
  }
  if (
    upper.includes('AVAILABILITY') ||
    upper.includes('INJURIES') ||
    upper.includes('SQUADS') ||
    upper.includes('ТРАВМЫ') ||
    upper.includes('СОСТАВЫ')
  ) {
    return 'AVAILABILITY';
  }
  if (
    upper.includes('TOURNAMENT CONTEXT') ||
    upper.includes('MOTIVATION') ||
    upper.includes('STANDINGS') ||
    upper.includes('КОНТЕКСТ')
  ) {
    return 'CONTEXT';
  }
  if (upper.includes('TEAM 1') || upper.includes('TEAM 1 FORM')) {
    return 'TEAM1_FORM';
  }
  if (upper.includes('TEAM 2') || upper.includes('TEAM 2 FORM')) {
    return 'TEAM2_FORM';
  }
  if (
    (upper.includes('MATCH') || upper.includes('1. MATCH')) &&
    !upper.includes('RECENT') &&
    !upper.includes('FORM') &&
    !upper.includes('H2H')
  ) {
    return 'MATCH';
  }

  return 'OTHER';
}

function cleanMarkdownValue(str: string): string {
  let clean = str.replace(/^\*\*/, '').replace(/\*\*$/, '').trim();
  clean = clean.replace(/\[\[[\d,\s]+\]\]/g, '').trim();
  clean = clean.replace(/^\*?\s*\*\*/, '').replace(/\*\*\s*\*?$/, '').trim();
  return clean;
}

function findFieldValueInBlock(blockText: string, fieldKeywords: string[]): string | null {
  const lines = blockText.split(/\r?\n/);
  for (const line of lines) {
    for (const kw of fieldKeywords) {
      const escapedKw = kw.replace(/[-[\]{}()*+?.:\\^$|]/g, '\\$&');
      const regex = new RegExp(`^(?:[*\\-]\\s*)?(?:\\*\\*)?${escapedKw}(?:\\([^)]+\\))?(?:\\*\\*)?\\s*:\\s*(.+)$`, 'i');
      const match = line.match(regex);
      if (match) {
        return cleanMarkdownValue(match[1]);
      }
    }
  }
  return null;
}

function splitSubBlocks(sectionContent: string, levelPattern: RegExp = /^#{3,4}\s+(.+)$/): { title: string; content: string }[] {
  const lines = sectionContent.split(/\r?\n/);
  const blocks: { title: string; content: string }[] = [];

  let currentTitle = 'GENERAL';
  let currentLines: string[] = [];

  const flush = () => {
    if (currentLines.length > 0) {
      blocks.push({ title: currentTitle, content: currentLines.join('\n').trim() });
      currentLines = [];
    }
  };

  for (const line of lines) {
    const match = line.match(levelPattern);
    if (match) {
      flush();
      currentTitle = match[1].trim();
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return blocks;
}

// -----------------------------------------------------------------------------
// Sub-Parsers
// -----------------------------------------------------------------------------

function parseMatchSection(
  matchSection: VDPSection | undefined,
  fullText: string
): HockeyMatchIdentity {
  const content = matchSection ? matchSection.content : fullText;

  let team1Name = 'Team 1';
  let team2Name = 'Team 2';

  // Try to find FACT line
  const factLine = findFieldValueInBlock(content, ['FACT']);
  if (factLine) {
    const versusMatch = factLine.match(/(.+?)\s+(?:победил|проиграл|сыграл|—|-|vs)\s+(.+?)(?:со счётом|\d+[:\u2013\-]\d+|$)/i);
    if (versusMatch) {
      team1Name = versusMatch[1].trim();
      team2Name = versusMatch[2].trim();
    }
  }

  // Try to parse TEAM 1 / TEAM 2 section titles if available
  const t1TitleMatch = fullText.match(/##\s+TEAM 1\s*(?:RECENT FORM|FORM)?\s*(?:[—\-]\s*(.+))?$/im);
  if (t1TitleMatch && t1TitleMatch[1]) {
    team1Name = t1TitleMatch[1].trim();
  }
  const t2TitleMatch = fullText.match(/##\s+TEAM 2\s*(?:RECENT FORM|FORM)?\s*(?:[—\-]\s*(.+))?$/im);
  if (t2TitleMatch && t2TitleMatch[1]) {
    team2Name = t2TitleMatch[1].trim();
  }

  const dateRaw = findFieldValueInBlock(content, ['DATE']) || '';
  const date = dateRaw.split(',')[0].trim();

  const leagueRaw =
    findFieldValueInBlock(content, ['LEAGUE', 'TOURNAMENT']) || 'UNKNOWN';

  const venueRaw = findFieldValueInBlock(content, ['VENUE']) || 'UNKNOWN';

  let homeTeam = team1Name;
  let awayTeam = team2Name;

  const homeAwayRaw = findFieldValueInBlock(content, ['HOME/AWAY', 'HOME_AWAY']);
  if (homeAwayRaw) {
    const parts = homeAwayRaw.split(';');
    for (const part of parts) {
      if (/home|хозяева/i.test(part)) {
        const teamMatch = part.match(/^(?:[*\\-\s]*)(.+?)\s*[—\-]\s*(?:home|хозяева)/i);
        if (teamMatch) homeTeam = teamMatch[1].trim();
      }
      if (/away|гости/i.test(part)) {
        const teamMatch = part.match(/^(?:[*\\-\s]*)(.+?)\s*[—\-]\s*(?:away|гости)/i);
        if (teamMatch) awayTeam = teamMatch[1].trim();
      }
    }
  }

  return {
    team1Name,
    team2Name,
    date,
    league: leagueRaw,
    venue: venueRaw,
    homeTeam,
    awayTeam,
  };
}

function parseRecentFormSection(
  formSection: VDPSection | undefined,
  teamName: string
): HockeyRecentForm {
  if (!formSection) {
    return {
      matches: [],
      gamesPlayed: 0,
      winsRegulation: 0,
      winsOT: 0,
      winsSO: 0,
      lossesOT: 0,
      lossesSO: 0,
      lossesRegulation: 0,
      goalsForTotal: 0,
      goalsAgainstTotal: 0,
    };
  }

  const subBlocks = splitSubBlocks(formSection.content);
  const matches: HockeyFormMatch[] = [];

  let summaryBlockText = '';

  for (const block of subBlocks) {
    const titleUpper = block.title.toUpperCase();
    if (titleUpper.includes('FORM SUMMARY')) {
      summaryBlockText = block.content;
      continue;
    }

    if (titleUpper.includes('MATCH')) {
      const factLine = findFieldValueInBlock(block.content, ['FACT']);
      if (factLine && (factLine.includes('отсутствуют') || factLine.includes('отсутствует'))) {
        continue;
      }

      const date = findFieldValueInBlock(block.content, ['DATE']);
      const opponent = findFieldValueInBlock(block.content, ['OPPONENT']);

      const haRaw = (findFieldValueInBlock(block.content, ['HOME/AWAY', 'HOME_AWAY']) || '').toUpperCase();
      const venue: 'HOME' | 'AWAY' | 'NEUTRAL' | 'UNKNOWN' = haRaw.includes('HOME')
        ? 'HOME'
        : haRaw.includes('AWAY')
        ? 'AWAY'
        : haRaw.includes('NEUTRAL')
        ? 'NEUTRAL'
        : 'UNKNOWN';

      const gfRaw = findFieldValueInBlock(block.content, ['GOALS FOR', 'GOALS_FOR']);
      const gaRaw = findFieldValueInBlock(block.content, ['GOALS AGAINST', 'GOALS_AGAINST']);
      let goalsFor = parseNumber(gfRaw);
      let goalsAgainst = parseNumber(gaRaw);

      const scoreRaw = findFieldValueInBlock(block.content, ['SCORE']);
      if (scoreRaw && (goalsFor === null || goalsAgainst === null)) {
        const scores = scoreRaw.match(/(\d+)[:\u2013\-]\s*(\d+)/);
        if (scores) {
          const teamFirst = scoreRaw.toLowerCase().startsWith(teamName.toLowerCase());
          if (teamFirst) {
            goalsFor = parseInt(scores[1], 10);
            goalsAgainst = parseInt(scores[2], 10);
          } else {
            goalsAgainst = parseInt(scores[1], 10);
            goalsFor = parseInt(scores[2], 10);
          }
        }
      }

      const regResRaw = (findFieldValueInBlock(block.content, ['REGULATION RESULT', 'RESULT']) || '').toUpperCase();
      const otResRaw = (findFieldValueInBlock(block.content, ['OT RESULT', 'OVERTIME RESULT']) || '').toUpperCase();
      const soResRaw = (findFieldValueInBlock(block.content, ['SO RESULT', 'SHOOTOUT RESULT']) || '').toUpperCase();

      let outcomeType: HockeyOutcomeType | 'UNKNOWN' = 'UNKNOWN';
      if (otResRaw.includes('WIN') || otResRaw.includes('LOSS') || (scoreRaw && /OT|ОТ/i.test(scoreRaw))) {
        outcomeType = 'OVERTIME';
      } else if (soResRaw.includes('WIN') || soResRaw.includes('LOSS') || (scoreRaw && /SO|Б/i.test(scoreRaw))) {
        outcomeType = 'SHOOTOUT';
      } else if (regResRaw.includes('W') || regResRaw.includes('L') || regResRaw.includes('WIN') || regResRaw.includes('LOSS')) {
        outcomeType = 'REGULATION';
      }

      let regulationResult: HockeyRegulationResult = 'UNKNOWN';
      if (regResRaw.startsWith('W') || regResRaw.includes('WIN')) regulationResult = 'WIN';
      else if (regResRaw.startsWith('L') || regResRaw.includes('LOSS')) regulationResult = 'LOSS';
      else if (regResRaw.startsWith('T') || regResRaw.includes('TIE')) regulationResult = 'TIE';
      else if (outcomeType === 'OVERTIME' || outcomeType === 'SHOOTOUT') regulationResult = 'TIE';

      let overtimeResult: HockeyOTResult = 'UNKNOWN';
      if (outcomeType === 'REGULATION') {
        overtimeResult = 'NOT_APPLICABLE';
      } else if (otResRaw.includes('WIN') || otResRaw === 'W') {
        overtimeResult = 'WIN';
      } else if (otResRaw.includes('LOSS') || otResRaw === 'L') {
        overtimeResult = 'LOSS';
      } else if (otResRaw.includes('NOT APPLICABLE') || otResRaw.includes('NOT_APPLICABLE')) {
        overtimeResult = 'NOT_APPLICABLE';
      }

      let shootoutResult: HockeySOResult = 'UNKNOWN';
      if (outcomeType === 'REGULATION' || outcomeType === 'OVERTIME') {
        shootoutResult = 'NOT_APPLICABLE';
      } else if (soResRaw.includes('WIN') || soResRaw === 'W') {
        shootoutResult = 'WIN';
      } else if (soResRaw.includes('LOSS') || soResRaw === 'L') {
        shootoutResult = 'LOSS';
      } else if (soResRaw.includes('NOT APPLICABLE') || soResRaw.includes('NOT_APPLICABLE')) {
        shootoutResult = 'NOT_APPLICABLE';
      }

      const oppStrRaw = findFieldValueInBlock(block.content, ['OPPONENT STRENGTH', 'OPPONENT_STRENGTH']);
      const opponentStrength = parseMetricValue<'STRONG' | 'MEDIUM' | 'WEAK'>(
        oppStrRaw,
        (s) => {
          const u = s.toUpperCase();
          if (u.includes('STRONG')) return 'STRONG';
          if (u.includes('MEDIUM')) return 'MEDIUM';
          if (u.includes('WEAK')) return 'WEAK';
          return null;
        }
      );

      matches.push({
        date: date || null,
        opponent: opponent || null,
        venue,
        goalsFor,
        goalsAgainst,
        regulationResult,
        overtimeResult,
        shootoutResult,
        outcomeType,
        opponentStrength,
      });
    }
  }

  // Summary aggregation
  let gamesPlayed = matches.length;
  let winsRegulation = 0;
  let winsOT = 0;
  let winsSO = 0;
  let lossesRegulation = 0;
  let lossesOT = 0;
  let lossesSO = 0;
  let goalsForTotal = 0;
  let goalsAgainstTotal = 0;

  if (summaryBlockText) {
    const gp = parseNumber(findFieldValueInBlock(summaryBlockText, ['GAMES', 'GAMES PLAYED']));
    if (gp !== null) gamesPlayed = gp;
    const wr = parseNumber(findFieldValueInBlock(summaryBlockText, ['WINS', 'REGULATION WINS']));
    if (wr !== null) winsRegulation = wr;
    const lr = parseNumber(findFieldValueInBlock(summaryBlockText, ['LOSSES', 'REGULATION LOSSES']));
    if (lr !== null) lossesRegulation = lr;
    const lot = parseNumber(findFieldValueInBlock(summaryBlockText, ['OT LOSSES', 'OT_LOSSES']));
    if (lot !== null) lossesOT = lot;
    const lso = parseNumber(findFieldValueInBlock(summaryBlockText, ['SO LOSSES', 'SO_LOSSES']));
    if (lso !== null) lossesSO = lso;
    const gf = parseNumber(findFieldValueInBlock(summaryBlockText, ['GOALS FOR', 'GOALS_FOR', 'GOALSFOR']));
    if (gf !== null) goalsForTotal = gf;
    const ga = parseNumber(findFieldValueInBlock(summaryBlockText, ['GOALS AGAINST', 'GOALS_AGAINST', 'GOALSAGAINST']));
    if (ga !== null) goalsAgainstTotal = ga;
  } else {
    for (const m of matches) {
      if (m.goalsFor !== null) goalsForTotal += m.goalsFor;
      if (m.goalsAgainst !== null) goalsAgainstTotal += m.goalsAgainst;
      if (m.outcomeType === 'REGULATION') {
        if (m.regulationResult === 'WIN') winsRegulation++;
        if (m.regulationResult === 'LOSS') lossesRegulation++;
      } else if (m.outcomeType === 'OVERTIME') {
        if (m.overtimeResult === 'WIN') winsOT++;
        if (m.overtimeResult === 'LOSS') lossesOT++;
      } else if (m.outcomeType === 'SHOOTOUT') {
        if (m.shootoutResult === 'WIN') winsSO++;
        if (m.shootoutResult === 'LOSS') lossesSO++;
      }
    }
  }

  return {
    matches,
    gamesPlayed,
    winsRegulation,
    winsOT,
    winsSO,
    lossesOT,
    lossesSO,
    lossesRegulation,
    goalsForTotal,
    goalsAgainstTotal,
  };
}

function parseGoaltendingSection(
  goaltendingSection: VDPSection | undefined,
  teamName: string,
  teamIndex: 1 | 2
): HockeyGoaltending {
  const defaultEmpty: HockeyGoaltending = {
    starterName: parseMetricValue(null, (s) => s),
    backupName: parseMetricValue(null, (s) => s),
    starterStatus: parseMetricValue<GoalieAvailabilityStatus>(null, () => null),
    svPct: parseTemporalMetric(null, parseNumber),
    gaa: parseTemporalMetric(null, parseNumber),
    saves: parseMetricValue(null, parseNumber),
    shotsAgainst: parseMetricValue(null, parseNumber),
  };

  if (!goaltendingSection) return defaultEmpty;

  const subBlocks = splitSubBlocks(goaltendingSection.content);
  let teamBlock = subBlocks.find(
    (b) =>
      b.title.toUpperCase().includes(`TEAM ${teamIndex}`) ||
      b.title.toLowerCase().includes(teamName.toLowerCase())
  );

  if (!teamBlock && subBlocks.length >= teamIndex) {
    teamBlock = subBlocks[teamIndex - 1];
  }

  const content = teamBlock ? teamBlock.content : goaltendingSection.content;

  const starterRaw = findFieldValueInBlock(content, ['STARTING GOALIE', 'STARTER', 'GOALIE']);
  let starterNameStr: string | null = null;
  let starterStatusVal: GoalieAvailabilityStatus = 'UNKNOWN';

  if (starterRaw) {
    starterNameStr = starterRaw.split(/[\u2013\-]|—/)[0].trim();
    const upper = starterRaw.toUpperCase();
    if (upper.includes('CONFIRMED')) starterStatusVal = 'CONFIRMED';
    else if (upper.includes('EXPECTED')) starterStatusVal = 'EXPECTED';
    else if (upper.includes('INJURED')) starterStatusVal = 'INJURED';
    else if (upper.includes('RESTING')) starterStatusVal = 'RESTING';
    else if (upper.includes('UNCONFIRMED')) starterStatusVal = 'UNCONFIRMED';
  }

  const starterName = parseMetricValue(starterNameStr, (s) => s);
  const starterStatus = parseMetricValue<GoalieAvailabilityStatus>(
    starterRaw,
    () => starterStatusVal
  );

  const backupRaw = findFieldValueInBlock(content, ['BACKUP', 'BACKUP GOALIE']);
  const backupName = parseMetricValue(backupRaw, (s) => s.split('.')[0].trim());

  const svRaw = findFieldValueInBlock(content, ['SAVE PERCENTAGE (SEASON)', 'SAVE PERCENTAGE (RECENT)', 'SAVE PERCENTAGE', 'SV%']);
  const svPct = parseTemporalMetric(svRaw, parseNumber, 'current_match');

  const gaaRaw = findFieldValueInBlock(content, ['GAA (SEASON)', 'GAA (RECENT)', 'GAA']);
  const gaa = parseTemporalMetric(gaaRaw, parseNumber, 'current_match');

  const savesRaw = findFieldValueInBlock(content, ['SAVES', 'RECENT FORM']);
  const saves = parseMetricValue(savesRaw, parseNumber);

  const saRaw = findFieldValueInBlock(content, ['SHOTS AGAINST', 'SHOTS']);
  const shotsAgainst = parseMetricValue(saRaw, parseNumber);

  return {
    starterName,
    backupName,
    starterStatus,
    svPct,
    gaa,
    saves,
    shotsAgainst,
  };
}

function parseSpecialTeamsSection(
  stSection: VDPSection | undefined,
  teamName: string,
  teamIndex: 1 | 2
): HockeySpecialTeams {
  const defaultEmpty: HockeySpecialTeams = {
    ppPct: parseTemporalMetric(null, parseNumber),
    pkPct: parseTemporalMetric(null, parseNumber),
    powerPlayGoals: parseMetricValue(null, parseNumber),
    shortHandedGoals: parseMetricValue(null, parseNumber),
    penalties: parseMetricValue(null, parseNumber),
    penaltyMinutes: parseMetricValue(null, parseNumber),
  };

  if (!stSection) return defaultEmpty;

  const subBlocks = splitSubBlocks(stSection.content);
  let teamBlock = subBlocks.find(
    (b) =>
      b.title.toUpperCase().includes(`TEAM ${teamIndex}`) ||
      b.title.toLowerCase().includes(teamName.toLowerCase())
  );

  if (!teamBlock && subBlocks.length >= teamIndex) {
    teamBlock = subBlocks[teamIndex - 1];
  }

  const content = teamBlock ? teamBlock.content : stSection.content;

  const ppRaw = findFieldValueInBlock(content, ['POWER PLAY % (SEASON)', 'POWER PLAY % (RECENT)', 'POWER PLAY %', 'PP%']);
  const ppPct = parseTemporalMetric(ppRaw, parseNumber, 'current_match');

  const pkRaw = findFieldValueInBlock(content, ['PENALTY KILL % (SEASON)', 'PENALTY KILL % (RECENT)', 'PENALTY KILL %', 'PK%']);
  const pkPct = parseTemporalMetric(pkRaw, parseNumber, 'current_match');

  const ppgRaw = findFieldValueInBlock(content, ['POWER-PLAY GOALS', 'POWER PLAY GOALS', 'PPG']);
  const powerPlayGoals = parseMetricValue(ppgRaw, parseNumber);

  const shgRaw = findFieldValueInBlock(content, ['SHORT-HANDED GOALS', 'SHG']);
  const shortHandedGoals = parseMetricValue(shgRaw, parseNumber);

  const penRaw = findFieldValueInBlock(content, ['PENALTIES PER GAME', 'PENALTIES']);
  const penalties = parseMetricValue(penRaw, parseNumber);

  const pimRaw = findFieldValueInBlock(content, ['PENALTY MINUTES', 'PIM']);
  const penaltyMinutes = parseMetricValue(pimRaw, parseNumber);

  return {
    ppPct,
    pkPct,
    powerPlayGoals,
    shortHandedGoals,
    penalties,
    penaltyMinutes,
  };
}

function parseShotsSection(
  shotsSection: VDPSection | undefined,
  teamName: string,
  teamIndex: 1 | 2
): HockeyShotData {
  const defaultEmpty: HockeyShotData = {
    sog: parseMetricValue(null, parseNumber),
    shotsAgainst: parseMetricValue(null, parseNumber),
    shotDifferential: parseMetricValue(null, parseNumber),
    faceoffPct: parseMetricValue(null, parseNumber),
    hits: parseMetricValue(null, parseNumber),
    blockedShots: parseMetricValue(null, parseNumber),
    takeaways: parseMetricValue(null, parseNumber),
    giveaways: parseMetricValue(null, parseNumber),
  };

  if (!shotsSection) return defaultEmpty;

  const subBlocks = splitSubBlocks(shotsSection.content);
  let teamBlock = subBlocks.find(
    (b) =>
      b.title.toUpperCase().includes(`TEAM ${teamIndex}`) ||
      b.title.toLowerCase().includes(teamName.toLowerCase())
  );

  if (!teamBlock && subBlocks.length >= teamIndex) {
    teamBlock = subBlocks[teamIndex - 1];
  }

  const content = teamBlock ? teamBlock.content : shotsSection.content;

  const sogRaw = findFieldValueInBlock(content, ['SHOTS ON GOAL (SEASON)', 'SHOTS ON GOAL (RECENT)', 'SHOTS ON GOAL', 'SOG']);
  const sog = parseMetricValue(sogRaw, parseNumber);

  const saRaw = findFieldValueInBlock(content, ['SHOTS AGAINST']);
  const shotsAgainst = parseMetricValue(saRaw, parseNumber);

  const diffRaw = findFieldValueInBlock(content, ['SHOT DIFFERENTIAL']);
  const shotDifferential = parseMetricValue(diffRaw, parseNumber);

  const foRaw = findFieldValueInBlock(content, ['FACEOFF %', 'FACEOFFS']);
  const faceoffPct = parseMetricValue(foRaw, parseNumber);

  const hitsRaw = findFieldValueInBlock(content, ['HITS']);
  const hits = parseMetricValue(hitsRaw, parseNumber);

  const blocksRaw = findFieldValueInBlock(content, ['BLOCKED SHOTS', 'BLOCKS']);
  const blockedShots = parseMetricValue(blocksRaw, parseNumber);

  const takRaw = findFieldValueInBlock(content, ['TAKEAWAYS']);
  const takeaways = parseMetricValue(takRaw, parseNumber);

  const givRaw = findFieldValueInBlock(content, ['GIVEAWAYS']);
  const giveaways = parseMetricValue(givRaw, parseNumber);

  return {
    sog,
    shotsAgainst,
    shotDifferential,
    faceoffPct,
    hits,
    blockedShots,
    takeaways,
    giveaways,
  };
}

function parseScoringSection(
  scoringSection: VDPSection | undefined,
  teamName: string,
  teamIndex: 1 | 2
): HockeyScoringData {
  const defaultEmpty: HockeyScoringData = {
    goalsByPeriod: parseMetricValue<GoalsByPeriod>(null, () => null),
    evenStrengthGoals: parseMetricValue(null, parseNumber),
    powerPlayGoals: parseMetricValue(null, parseNumber),
    shortHandedGoals: parseMetricValue(null, parseNumber),
    emptyNetGoals: parseMetricValue(null, parseNumber),
  };

  if (!scoringSection) return defaultEmpty;

  const subBlocks = splitSubBlocks(scoringSection.content);
  let teamBlock = subBlocks.find(
    (b) =>
      b.title.toUpperCase().includes(`TEAM ${teamIndex}`) ||
      b.title.toLowerCase().includes(teamName.toLowerCase())
  );

  if (!teamBlock && subBlocks.length >= teamIndex) {
    teamBlock = subBlocks[teamIndex - 1];
  }

  const content = teamBlock ? teamBlock.content : scoringSection.content;

  const gbpRaw = findFieldValueInBlock(content, ['GOALS BY PERIOD (1ST/2ND/3RD/OT)', 'GOALS BY PERIOD']);
  const goalsByPeriod = parseMetricValue<GoalsByPeriod>(gbpRaw, (s) => {
    const parts = s.split('/').map((p) => parseNumber(p));
    if (parts.length >= 3 && parts[0] !== null && parts[1] !== null && parts[2] !== null) {
      return {
        period1: parts[0],
        period2: parts[1],
        period3: parts[2],
        overtime: parts[3] !== undefined ? parts[3] : null,
      };
    }
    return null;
  });

  const evgRaw = findFieldValueInBlock(content, ['EVEN-STRENGTH GOALS', 'EVEN STRENGTH GOALS']);
  const evenStrengthGoals = parseMetricValue(evgRaw, parseNumber);

  const ppgRaw = findFieldValueInBlock(content, ['POWER-PLAY GOALS', 'POWER PLAY GOALS']);
  const powerPlayGoals = parseMetricValue(ppgRaw, parseNumber);

  const shgRaw = findFieldValueInBlock(content, ['SHORT-HANDED GOALS']);
  const shortHandedGoals = parseMetricValue(shgRaw, parseNumber);

  const engRaw = findFieldValueInBlock(content, ['EMPTY-NET GOALS']);
  const emptyNetGoals = parseMetricValue(engRaw, parseNumber);

  return {
    goalsByPeriod,
    evenStrengthGoals,
    powerPlayGoals,
    shortHandedGoals,
    emptyNetGoals,
  };
}

function parseH2HSection(
  h2hSection: VDPSection | undefined,
  team1Name: string,
  team2Name: string
): HockeyH2HMatch[] {
  if (!h2hSection) return [];

  const subBlocks = splitSubBlocks(h2hSection.content);
  const h2hMatches: HockeyH2HMatch[] = [];

  for (const block of subBlocks) {
    if (block.title.toUpperCase().includes('SUMMARY')) continue;

    const date = findFieldValueInBlock(block.content, ['DATE']);
    const scoreRaw = findFieldValueInBlock(block.content, ['SCORE']);
    const winner = findFieldValueInBlock(block.content, ['WINNER']);
    const typeRaw = (findFieldValueInBlock(block.content, ['REGULATION/OT/SO', 'TYPE']) || '').toUpperCase();
    const venue = findFieldValueInBlock(block.content, ['VENUE']);
    const goalieInfo = findFieldValueInBlock(block.content, ['GOALIE INFO', 'GOALIE']);

    let homeTeam = team1Name;
    let awayTeam = team2Name;
    let homeScore: number | null = null;
    let awayScore: number | null = null;

    if (scoreRaw) {
      const parts = scoreRaw.match(/(.+?)\s+(\d+)[\u2013\-]\s*(\d+)\s+(.+)/);
      if (parts) {
        const tA = parts[1].trim();
        const sA = parseInt(parts[2], 10);
        const sB = parseInt(parts[3], 10);
        const tB = parts[4].trim();

        if (venue && venue.toLowerCase().includes(tA.toLowerCase()) && venue.toLowerCase().includes('away')) {
          awayTeam = tA;
          awayScore = sA;
          homeTeam = tB;
          homeScore = sB;
        } else {
          homeTeam = tA;
          homeScore = sA;
          awayTeam = tB;
          awayScore = sB;
        }
      }
    }

    let outcomeType: HockeyOutcomeType = 'REGULATION';
    if (typeRaw.includes('SHOOTOUT') || typeRaw.includes('SO')) outcomeType = 'SHOOTOUT';
    else if (typeRaw.includes('OVERTIME') || typeRaw.includes('OT')) outcomeType = 'OVERTIME';

    let regulation: HockeyRegulationResult = 'UNKNOWN';
    let overtime: HockeyOTResult = 'UNKNOWN';
    let shootout: HockeySOResult = 'UNKNOWN';

    const winningTeam = winner || (homeScore !== null && awayScore !== null ? (homeScore > awayScore ? homeTeam : awayTeam) : 'UNKNOWN');

    if (outcomeType === 'REGULATION') {
      overtime = 'NOT_APPLICABLE';
      shootout = 'NOT_APPLICABLE';
      if (homeScore !== null && awayScore !== null) {
        regulation = homeScore > awayScore ? 'WIN' : 'LOSS';
      }
    } else if (outcomeType === 'OVERTIME') {
      regulation = 'TIE';
      shootout = 'NOT_APPLICABLE';
      overtime = winner && winner.toLowerCase().includes(homeTeam.toLowerCase()) ? 'WIN' : 'LOSS';
    } else if (outcomeType === 'SHOOTOUT') {
      regulation = 'TIE';
      overtime = 'NOT_APPLICABLE';
      shootout = winner && winner.toLowerCase().includes(homeTeam.toLowerCase()) ? 'WIN' : 'LOSS';
    }

    const result: HockeyMatchResult = {
      regulation,
      overtime,
      shootout,
      winningTeam,
      outcomeType,
    };

    let starterGoalies: HockeyH2HMatch['starterGoalies'] = undefined;
    if (goalieInfo) {
      starterGoalies = {};
      const gParts = goalieInfo.split(';');
      for (const gp of gParts) {
        if (gp.toLowerCase().includes(homeTeam.toLowerCase())) {
          starterGoalies.homeGoalie = gp.trim();
        } else if (gp.toLowerCase().includes(awayTeam.toLowerCase())) {
          starterGoalies.awayGoalie = gp.trim();
        }
      }
    }

    h2hMatches.push({
      date: date || null,
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      winner: winner || null,
      result,
      venue: venue || null,
      starterGoalies,
    });
  }

  return h2hMatches;
}

function parseAvailabilitySection(
  availSection: VDPSection | undefined,
  teamName: string,
  teamIndex: 1 | 2
): HockeyAvailability {
  const confirmedOut: HockeyInjuredPlayer[] = [];
  const dayToDay: HockeyInjuredPlayer[] = [];
  const unconfirmed: HockeyInjuredPlayer[] = [];

  if (!availSection) return { confirmedOut, dayToDay, unconfirmed };

  const subBlocks = splitSubBlocks(availSection.content);
  let targetContent = availSection.content;

  if (subBlocks.length > 1) {
    const teamTokens = teamName.split(/\s+/).filter((t) => t.length > 2);
    const matchingBlock = subBlocks.find((b) => {
      const titleUpper = b.title.toUpperCase();
      if (titleUpper.includes(`TEAM ${teamIndex}`)) return true;
      return teamTokens.some((token) => b.title.toLowerCase().includes(token.toLowerCase()));
    });

    if (matchingBlock) {
      targetContent = matchingBlock.content;
    } else {
      targetContent = '';
    }
  }

  if (!targetContent.trim()) {
    return { confirmedOut, dayToDay, unconfirmed };
  }

  const lines = targetContent.split(/\r?\n/);
  let currentBlock: { player?: string; status?: string; reason?: string } = {};

  const flush = () => {
    if (currentBlock.player) {
      const playerName = currentBlock.player;
      const statusRaw = (currentBlock.status || '').toUpperCase();
      const reason = currentBlock.reason || 'NOT_FOUND';

      let role: HockeyPlayerRole = 'UNKNOWN';
      const textForRole = `${playerName} ${statusRaw} ${reason}`.toUpperCase();
      if (textForRole.includes('GOALIE') || textForRole.includes('ВРАТАРЬ')) role = 'GOALIE';
      else if (textForRole.includes('DEFENSE') || textForRole.includes('DEFENCEMAN') || textForRole.includes('ЗАЩИТНИК')) role = 'DEFENSE';
      else if (textForRole.includes('FORWARD') || textForRole.includes('WINGER') || textForRole.includes('CENTER') || textForRole.includes('НАПАДАЮЩИЙ')) role = 'FORWARD';

      const playerObj: HockeyInjuredPlayer = {
        playerName,
        role,
        reason,
        statusDetails: currentBlock.status,
      };

      if (statusRaw.includes('DAY-TO-DAY')) {
        dayToDay.push(playerObj);
      } else if (statusRaw.includes('OUT') && !statusRaw.includes('UNCONFIRMED')) {
        confirmedOut.push(playerObj);
      } else {
        unconfirmed.push(playerObj);
      }

      currentBlock = {};
    }
  };

  for (const line of lines) {
    const playerMatch = line.match(/^(?:[*\\-]\s*)?(?:\*\*)?PLAYER(?:\*\*)?\s*:\s*(.+)$/i);
    if (playerMatch) {
      flush();
      currentBlock.player = cleanMarkdownValue(playerMatch[1]);
      continue;
    }
    const statusMatch = line.match(/^(?:[*\\-]\s*)?(?:\*\*)?STATUS(?:\/REASON)?(?:\*\*)?\s*:\s*(.+)$/i);
    if (statusMatch) {
      currentBlock.status = cleanMarkdownValue(statusMatch[1]);
      continue;
    }
    const reasonMatch = line.match(/^(?:[*\\-]\s*)?(?:\*\*)?REASON(?:\*\*)?\s*:\s*(.+)$/i);
    if (reasonMatch) {
      currentBlock.reason = cleanMarkdownValue(reasonMatch[1]);
      continue;
    }
  }
  flush();

  return { confirmedOut, dayToDay, unconfirmed };
}

function parseStandingsAndContext(contextSection: VDPSection | undefined): {
  standings: HockeyStandingsData;
  context: HockeyTournamentContext;
} {
  const standings: HockeyStandingsData = {
    rank: parseMetricValue(null, parseNumber),
    points: parseMetricValue(null, parseNumber),
    divisionRank: parseMetricValue(null, parseNumber),
    conferenceRank: parseMetricValue(null, parseNumber),
  };

  const context: HockeyTournamentContext = {
    stage: 'Regular Season',
    notes: contextSection ? contextSection.content.slice(0, 500) : null,
  };

  if (!contextSection) return { standings, context };

  const ptsRaw = findFieldValueInBlock(contextSection.content, ['POINTS']);
  if (ptsRaw) {
    standings.points = parseMetricValue(ptsRaw, parseNumber);
  }

  return { standings, context };
}

function parseNotFoundSection(notFoundSection: VDPSection | undefined): string[] {
  if (!notFoundSection) return [];
  const lines = notFoundSection.content.split(/\r?\n/);
  return lines
    .map((l) => l.replace(/^[*\\-]\s*/, '').trim())
    .filter((l) => l.length > 0);
}

function parseSources(markdown: string): AnalysisSource[] {
  const sources: AnalysisSource[] = [];
  const lines = markdown.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const urlMatch = line.match(/^(?:[*\\-]\s*)?(?:\*\*)?URL(?:\*\*)?\s*:\s*(.+)$/i);
    if (urlMatch) {
      const urlStr = cleanMarkdownValue(urlMatch[1]);
      let title = 'NHL.com';
      if (i > 0) {
        const prevLine = lines[i - 1];
        const srcMatch = prevLine.match(/^(?:[*\\-]\s*)?(?:\*\*)?SOURCE(?:\*\*)?\s*:\s*(.+)$/i);
        if (srcMatch) title = cleanMarkdownValue(srcMatch[1]);
      }
      const urls = urlStr.split(';').map((u) => u.trim());
      for (const u of urls) {
        if (u.startsWith('http')) {
          sources.push({ title, url: u });
        }
      }
    }
  }

  // Deduplicate sources by URL
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

// -----------------------------------------------------------------------------
// Public Main API
// -----------------------------------------------------------------------------

/**
 * Pure transformation function: Markdown VDP -> HockeyVDP Data Contract
 * Does NOT guess missing values, apply weights, or run probability engine rules.
 */
export function parseHockeyVDP(input: string): HockeyVDP {
  const sections = splitVDPSections(input);

  const matchSection = sections.find((s) => s.kind === 'MATCH');
  const team1FormSection = sections.find((s) => s.kind === 'TEAM1_FORM');
  const team2FormSection = sections.find((s) => s.kind === 'TEAM2_FORM');
  const goaltendingSection = sections.find((s) => s.kind === 'GOALTENDING');
  const specialTeamsSection = sections.find((s) => s.kind === 'SPECIAL_TEAMS');
  const shotsSection = sections.find((s) => s.kind === 'SHOTS');
  const scoringSection = sections.find((s) => s.kind === 'SCORING');
  const h2hSection = sections.find((s) => s.kind === 'H2H');
  const availabilitySection = sections.find((s) => s.kind === 'AVAILABILITY');
  const contextSection = sections.find((s) => s.kind === 'CONTEXT');
  const notFoundSection = sections.find((s) => s.kind === 'NOT_FOUND');

  const match = parseMatchSection(matchSection, input);

  const team1Form = parseRecentFormSection(team1FormSection, match.team1Name);
  const team2Form = parseRecentFormSection(team2FormSection, match.team2Name);

  const team1Goaltending = parseGoaltendingSection(goaltendingSection, match.team1Name, 1);
  const team2Goaltending = parseGoaltendingSection(goaltendingSection, match.team2Name, 2);

  const team1SpecialTeams = parseSpecialTeamsSection(specialTeamsSection, match.team1Name, 1);
  const team2SpecialTeams = parseSpecialTeamsSection(specialTeamsSection, match.team2Name, 2);

  const team1Shots = parseShotsSection(shotsSection, match.team1Name, 1);
  const team2Shots = parseShotsSection(shotsSection, match.team2Name, 2);

  const team1Scoring = parseScoringSection(scoringSection, match.team1Name, 1);
  const team2Scoring = parseScoringSection(scoringSection, match.team2Name, 2);

  const team1Availability = parseAvailabilitySection(availabilitySection, match.team1Name, 1);
  const team2Availability = parseAvailabilitySection(availabilitySection, match.team2Name, 2);

  const h2h = parseH2HSection(h2hSection, match.team1Name, match.team2Name);

  const { standings, context } = parseStandingsAndContext(contextSection);
  const notFound = parseNotFoundSection(notFoundSection);
  const sources = parseSources(input);

  const team1: HockeyTeamData = {
    teamName: match.team1Name,
    recentForm: team1Form,
    goaltending: team1Goaltending,
    specialTeams: team1SpecialTeams,
    shots: team1Shots,
    scoring: team1Scoring,
    availability: team1Availability,
  };

  const team2: HockeyTeamData = {
    teamName: match.team2Name,
    recentForm: team2Form,
    goaltending: team2Goaltending,
    specialTeams: team2SpecialTeams,
    shots: team2Shots,
    scoring: team2Scoring,
    availability: team2Availability,
  };

  return {
    match,
    team1,
    team2,
    h2h,
    standings,
    context,
    sources,
    notFound,
  };
}
