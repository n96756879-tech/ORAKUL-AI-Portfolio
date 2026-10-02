export type ParsedMatch = {
  date: string | null;
  competition: string | null;
  opponent: string | null;
  venue: "HOME" | "AWAY" | "NEUTRAL" | "UNKNOWN";
  score: string | null;
  goalsFor: number | null;
  goalsAgainst: number | null;
  result: "W" | "D" | "L" | "UNKNOWN";
  opponentStrength: "STRONG" | "MEDIUM" | "WEAK" | "UNKNOWN";
  source: string | null;
  url: string | null;
  confidence: string | null;
  penaltyShootout: string | null;
};

export type ParsedForm = {
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  resultSequence: Array<"W" | "D" | "L">;
};

export type ParsedTeam = {
  teamName: string | null;
  matches: ParsedMatch[];
  form: ParsedForm;
};

export type ParsedH2H = {
  date: string | null;
  competition: string | null;
  score: string | null;
  winner: string | null;
  source: string | null;
  status: string | null;
};

export type ParsedVDP = {
  team1: ParsedTeam;
  team2: ParsedTeam;
  h2h: ParsedH2H[];
};

function stripMd(s: string): string {
  return s
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
}

function getField(lines: string[], key: string): string | null {
  const re = new RegExp(`^[(*-]*\\s*${key}\\s*:\\s*(.+)$`, "i");
  for (const line of lines) {
    const m = stripMd(line).match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function parseScore(raw: string): { goalsFor: number | null; goalsAgainst: number | null; penaltyShootout: string | null } {
  if (!raw) return { goalsFor: null, goalsAgainst: null, penaltyShootout: null };

  let penaltyShootout: string | null = null;
  let s = raw.trim();

  const penRe = /\(?\d+[-–]\d+\s*(?:on\s+)?(?:pens?|penalties|penalty\s+shootout)[^)]*\)?/i;
  const penMatch = s.match(penRe);
  if (penMatch) {
    penaltyShootout = penMatch[0].trim();
    s = s.replace(penRe, "").trim();
  }

  s = s.replace(/\s*aet\b/i, "").replace(/\s*\(aet\)/i, "").trim();

  const scoreRe = /(\d+)\s*[-–]\s*(\d+)/;
  const sm = s.match(scoreRe);
  if (sm) {
    return { goalsFor: parseInt(sm[1], 10), goalsAgainst: parseInt(sm[2], 10), penaltyShootout };
  }
  return { goalsFor: null, goalsAgainst: null, penaltyShootout };
}

function parseResult(raw: string | null): "W" | "D" | "L" | "UNKNOWN" {
  if (!raw) return "UNKNOWN";
  const r = raw.trim().toUpperCase();
  if (r === "W") return "W";
  if (r === "D") return "D";
  if (r === "L") return "L";
  return "UNKNOWN";
}

function parseVenue(raw: string | null): "HOME" | "AWAY" | "NEUTRAL" | "UNKNOWN" {
  if (!raw) return "UNKNOWN";
  const r = raw.trim().toUpperCase();
  if (r === "HOME" || r === "H") return "HOME";
  if (r === "AWAY" || r === "A") return "AWAY";
  if (r === "NEUTRAL" || r === "N") return "NEUTRAL";
  return "UNKNOWN";
}

function parseOpponentStrength(raw: string | null): "STRONG" | "MEDIUM" | "WEAK" | "UNKNOWN" {
  if (!raw) return "UNKNOWN";
  const r = raw.trim().toUpperCase();
  if (r === "STRONG") return "STRONG";
  if (r === "MEDIUM") return "MEDIUM";
  if (r === "WEAK") return "WEAK";
  return "UNKNOWN";
}

function splitIntoSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let currentKey = "__preamble__";
  let currentLines: string[] = [];
  let teamContext: "NONE" | "TEAM1" | "TEAM2" | "H2H" = "NONE";

  const teamHeaderRe = /^TEAM\s*([12])\s*(?:(?:[-—–]\s*RECENT\s*FORM\s*:\s*.+)|FORM(?:\s*[-—–:]\s*.+)?)$/i;
  const h2hHeaderRe = /^(?:H2H|HEAD[-.]?TO[-.]?HEAD)$/i;
  const sectionRe = /^(?:TEAM\s*[12]\s*(?:(?:[-—–]\s*RECENT\s*FORM\s*:\s*.+)|FORM(?:\s*[-—–:]\s*.+)?)|MATCH(?:\s+VERIFICATION)?\s*$|MATCH\s*[1-5](?:\s*[-—–].*)?|H2H\s*[1-5]|FORM\s*SUMMARY|H2H|VERIFIED\s*DATA\s*PACK|HEAD[-.]?TO[-.]?HEAD)$/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const stripped = stripMd(line).trim();

    const teamHeader = stripped.match(teamHeaderRe);
    if (teamHeader) {
      teamContext = teamHeader[1] === "2" ? "TEAM2" : "TEAM1";
    } else if (h2hHeaderRe.test(stripped)) {
      teamContext = "H2H";
    } else if (/^VERIFIED\s*DATA\s*PACK$/i.test(stripped)) {
      teamContext = "NONE";
    }

    if (sectionRe.test(stripped)) {
      sections.set(currentKey, currentLines);
      let baseKey: string;
      if (teamHeader) {
        baseKey = /RECENT\s*FORM/i.test(stripped)
          ? `TEAM ${teamHeader[1]} - RECENT FORM`
          : `TEAM ${teamHeader[1]} FORM`;
      } else if (/^H2H\s*[1-5]$/i.test(stripped)) {
        baseKey = `MATCH ${stripped.match(/^H2H\s*([1-5])$/i)![1]}`;
      } else if (/^MATCH\s*[1-5]/i.test(stripped)) {
        baseKey = `MATCH ${stripped.match(/^MATCH\s*([1-5])/i)![1]}`;
      } else {
        baseKey = stripped.toUpperCase().replace(/\s+/g, " ").replace(/[—–]/g, "-");
      }
      currentKey = teamContext === "NONE" ? baseKey : `${teamContext}:${baseKey}`;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  sections.set(currentKey, currentLines);
  return sections;
}

function findSectionLines(sections: Map<string, string[]>, keyPattern: RegExp): string[] | null {
  for (const [key, lines] of sections) {
    if (keyPattern.test(key)) return lines;
  }
  return null;
}

function parseMatchBlock(lines: string[]): ParsedMatch {
  const dateRaw = getField(lines, "DATE");
  const competition = getField(lines, "COMPETITION");
  const opponent = getField(lines, "OPPONENT");
  const venueRaw = getField(lines, "HOME/AWAY") || getField(lines, "VENUE");
  const scoreRaw = getField(lines, "SCORE");
  const resultRaw = getField(lines, "RESULT");
  const strengthRaw = getField(lines, "OPPONENT_STRENGTH");
  const source = getField(lines, "SOURCE");
  const url = getField(lines, "URL");
  const confidence = getField(lines, "CONFIDENCE");

  const result = parseResult(resultRaw);
  const venue = parseVenue(venueRaw);
  const opponentStrength = parseOpponentStrength(strengthRaw);

  let goalsFor: number | null = null;
  let goalsAgainst: number | null = null;
  let penaltyShootout: string | null = null;

  if (scoreRaw) {
    const parsed = parseScore(scoreRaw);
    goalsFor = parsed.goalsFor;
    goalsAgainst = parsed.goalsAgainst;
    penaltyShootout = parsed.penaltyShootout;
  }

  return {
    date: dateRaw,
    competition,
    opponent,
    venue,
    score: scoreRaw,
    goalsFor,
    goalsAgainst,
    result,
    opponentStrength,
    source,
    url,
    confidence,
    penaltyShootout,
  };
}

function computeForm(matches: ParsedMatch[]): ParsedForm {
  let wins = 0, draws = 0, losses = 0, gf = 0, ga = 0;
  const seq: Array<"W" | "D" | "L"> = [];

  for (const m of matches) {
    if (m.result === "W") { wins++; seq.push("W"); }
    else if (m.result === "D") { draws++; seq.push("D"); }
    else if (m.result === "L") { losses++; seq.push("L"); }
    if (m.goalsFor !== null) gf += m.goalsFor;
    if (m.goalsAgainst !== null) ga += m.goalsAgainst;
  }

  return {
    wins,
    draws,
    losses,
    goalsFor: gf,
    goalsAgainst: ga,
    goalDifference: gf - ga,
    resultSequence: seq,
  };
}

function extractTeamName(lines: string[]): string | null {
  const factLine = getField(lines, "FACT");
  if (factLine) return factLine;
  for (const line of lines) {
    const s = stripMd(line).trim();
    const teamMatch = s.match(/^\*\s*TEAM\s*[12]\s*:\s*(.+)$/i);
    if (teamMatch) return teamMatch[1].trim();
    if (s.length > 0 && !s.startsWith("*") && !s.startsWith("#")) return s;
  }
  return null;
}

function extractMatches(sections: Map<string, string[]>, teamPrefix: RegExp): ParsedMatch[] {
  const matches: ParsedMatch[] = [];
  for (let i = 1; i <= 5; i++) {
    const matchKey = new RegExp(`^MATCH ${i}$`, "i");
    const matchLines = findSectionLines(sections, matchKey);
    if (matchLines && matchLines.some(l => l.trim().length > 0)) {
      matches.push(parseMatchBlock(matchLines));
    }
  }
  return matches;
}

function parseTeam(sections: Map<string, string[]>, teamFormPattern: RegExp): ParsedTeam {
  const formLines = findSectionLines(sections, teamFormPattern);
  const formKey = [...sections.keys()].find(key => teamFormPattern.test(key.replace(/^TEAM[12]:/, '')));
  const headerName = formKey?.match(/RECENT FORM\s*:\s*(.+)$/i)?.[1]?.trim() || null;
  const teamName = headerName || (formLines ? extractTeamName(formLines) : null);

  const teamSections = new Map<string, string[]>();
  let inTeamScope = false;

  for (const [key, lines] of sections) {
    const keyWithoutPrefix = key.replace(/^TEAM[12]:/, '');
    if (teamFormPattern.test(keyWithoutPrefix)) {
      inTeamScope = true;
      teamSections.set(key, lines);
      continue;
    }
    if (inTeamScope) {
      if (/^TEAM[12]:(TEAM\s*[12]\s*(FORM|- RECENT FORM))$/i.test(key) && !teamFormPattern.test(keyWithoutPrefix)) {
        inTeamScope = false;
        break;
      }
      if (/^TEAM[12]:(FORM SUMMARY$|H2H$|SQUADS?$|INJURIES$|TOURNAMENT CONTEXT$|CONFLICTS)/i.test(key) || /^(FORM SUMMARY$|H2H$|SQUADS?$|INJURIES$|TOURNAMENT CONTEXT$|CONFLICTS)/i.test(key)) {
        inTeamScope = false;
        break;
      }
      teamSections.set(key, lines);
    }
  }

  const matches: ParsedMatch[] = [];
  for (let i = 1; i <= 5; i++) {
    const matchKey = `MATCH ${i}`;
    let ml = teamSections.get(matchKey);
    if (!ml) {
      for (const [key, lines] of teamSections) {
        if (key.endsWith(`:${matchKey}`)) {
          ml = lines;
          break;
        }
      }
    }
    if (ml && ml.some(l => l.trim().length > 0)) {
      matches.push(parseMatchBlock(ml));
    }
  }

  const form = computeForm(matches);

  return { teamName, matches, form };
}

function parseH2HNumbered(lines: string[]): ParsedH2H[] {
  const entries: ParsedH2H[] = [];
  const entryRe = /^\s*\d+\.\s+\*{0,2}(\d{2}\.\d{2}\.\d{4})\s*(?:[—–\-\u0442\u0410\u0424]|\u0442\u0410[\u0424\u0423])\s*(.+?)\*{0,2}\s*$/;
  const winnerRe = /победитель\s*(?:[—–\-]|\u0442\u0410[\u0424\u0423])\s*([^.;]+)/i;
  const tournamentRe = /^[^;]+/;

  for (let i = 0; i < lines.length; i++) {
    const m = stripMd(lines[i]).match(entryRe);
    if (!m) continue;
    const date = m[1];
    const rest = m[2].trim();
    const scoreMatch = rest.match(/(\d+\s*[–-]\s*\d+)/);
    const score = scoreMatch ? scoreMatch[1].replace(/\s/g, '') : null;

    let winner: string | null = null;
    let competition: string | null = null;
    let source: string | null = null;
    let status: string | null = null;

    const next = lines[i + 1] ? stripMd(lines[i + 1]) : '';
    if (next) {
      const wm = next.match(winnerRe);
      if (wm) winner = wm[1].trim().replace(/\.$/, '');
      const tm = next.match(tournamentRe);
      if (tm) {
        const t = tm[0].replace(/^[Тт]урнир\s*:\s*/i, '').replace(/;.*$/, '').trim();
        if (t) competition = t;
      }
    }

    for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
      const sl = stripMd(lines[j]);
      if (/^SOURCE\s*:/i.test(sl)) source = sl.replace(/^SOURCE\s*:\s*/i, '').trim();
      if (/^(?:CONFIDENCE|STATUS)\s*:/i.test(sl)) status = sl.replace(/^(?:CONFIDENCE|STATUS)\s*:\s*/i, '').trim();
    }

    if (isConcreteH2H(date, score)) {
      entries.push({ date, competition, score, winner: normalizeH2HWinner(score, winner), source, status });
    }
  }
  return entries;
}

function normalizeTeamName(name: string): string {
  return name.toLocaleLowerCase().replace(/[üÜ]/g, "u").replace(/[^a-z0-9а-яё]/gi, "");
}

// Суффиксы, отбрасываемые при сопоставлении имён («Barcelona» == «FC Barcelona»).
const TEAM_SUFFIX_TOKENS = new Set(["fc", "sc", "cf", "afc", "national", "team"]);

// Нормализация для сопоставления пары команд в aggregate H2H FACT.
// Отбрасываем распространённые суффиксы (FC/SC/etc.), чтобы «Barcelona» == «FC Barcelona».
function normalizeTeamNameForPair(name: string): string {
  return name
    .toLocaleLowerCase()
    .replace(/[üÜ]/g, "u")
    .replace(/[^a-z0-9а-яё]+/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !TEAM_SUFFIX_TOKENS.has(t))
    .join(" ");
}

function resolvePairTeam(
  raw: string,
  team1: string,
  team2: string,
): { normalized: string; isTeam1: boolean; isTeam2: boolean } {
  const normalized = normalizeTeamNameForPair(raw);
  const t1 = normalizeTeamNameForPair(team1);
  const t2 = normalizeTeamNameForPair(team2);
  return {
    normalized,
    isTeam1: normalized.length > 0 && normalized === t1,
    isTeam2: normalized.length > 0 && normalized === t2,
  };
}

// Aggregate H2H FACT fallback: разбирает строку вида
//   FACT: Barcelona 4–3 Real Madrid; Barcelona 3–2 Real Madrid aet; ...
// внутри распознанной H2H-секции. Каждая под-встреча добавляется только если
// обе команды соответствуют team1/team2 и извлечён score.
// Даты/соревнования из aggregate-заголовка не переносятся в отдельные встречи.
function parseH2HAggregateFacts(lines: string[], team1: string | null, team2: string | null): ParsedH2H[] {
  if (!team1 || !team2) return [];
  const entries: ParsedH2H[] = [];
  const factRe = /^\s*[-*]?\s*FACT\s*:\s*(.+)$/i;

  for (const rawLine of lines) {
    const line = stripMd(rawLine);
    const m = line.match(factRe);
    if (!m) continue;
    const fact = m[1].trim().replace(/[.;]$/, "");
    if (!fact) continue;
    // Разбиваем FACT по ';' на отдельные встречи.
    const parts = fact.split(/\s*;\s*/);
    for (const part of parts) {
      const chunk = part.trim();
      if (!chunk) continue;
      const pair = parseAggregateMeeting(chunk, team1, team2);
      if (pair) entries.push(pair);
    }
  }

  // Дедупликация aggregate-встреч по score+winner (все даты null,
  // поэтому внешняя deduplicateH2H по date|score схлопнула бы разные встречи
  // с одинаковым счётом, например «3-2» в обе стороны).
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.score?.replace(/\s+/g, '').replace(/[–—]/g, '-') || ''}|${entry.winner || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseAggregateMeeting(chunk: string, team1: string, team2: string): ParsedH2H | null {
  // «aet» может стоять в конце всей под-встречи (после имени команды) или сразу после счёта.
  const cleaned = chunk.replace(/\s*(?:aet|AET)\s*$/, "");
  // Находим счёт: «N–M» или «N-M» или «N:M».
  const scoreIdx = cleaned.search(/\d{1,2}\s*[–—\-:]\s*\d{1,2}/);
  if (scoreIdx < 0) return null;

  const before = cleaned.slice(0, scoreIdx).trim();
  const after = cleaned.slice(scoreIdx).replace(/\d{1,2}\s*[–—\-:]\s*\d{1,2}\s*/, "").trim();

  const scoreToken = cleaned.slice(scoreIdx).match(/\d{1,2}\s*[–—\-:]\s*\d{1,2}/)?.[0] ?? "";
  const scoreParts = scoreToken.split(/[–—\-:]/);
  if (scoreParts.length < 2) return null;
  const home = Number(scoreParts[0].trim());
  const away = Number(scoreParts[1].trim());
  if (isNaN(home) || isNaN(away)) return null;

  const left = resolvePairTeam(before, team1, team2);
  const right = resolvePairTeam(after, team1, team2);

  if (!left.normalized || !right.normalized) return null;
  if (left.normalized === right.normalized) return null;
  if (!(left.isTeam1 || left.isTeam2) || !(right.isTeam1 || right.isTeam2)) return null;
  if ((left.isTeam1 && right.isTeam1) || (left.isTeam2 && right.isTeam2)) return null;

  const isLeftTeam1 = left.isTeam1;
  let winner: string;
  if (home === away) {
    winner = "DRAW";
  } else {
    winner = home > away ? (isLeftTeam1 ? team1 : team2) : (isLeftTeam1 ? team2 : team1);
  }

  return {
    date: null,
    competition: null,
    score: `${home}-${away}`,
    winner,
    source: null,
    status: null,
  };
}

function parseH2HPlain(lines: string[], team1: string | null, team2: string | null): ParsedH2H[] {
  if (!team1 || !team2) return [];
  const expected = [normalizeTeamName(team1), normalizeTeamName(team2)];
  const lineRe = /^\s*(.+?)\s+(\d+\s*[-–—]\s*\d+)\s+([^.;]+?)\s*$/u;
  const entries: ParsedH2H[] = [];

  for (const rawLine of lines) {
    const line = stripMd(rawLine).replace(/^\s*\d+\.\s*/, "");
    const dateMatch = line.match(/^(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4})(?:\s*:\s*|\s*[—–-]\s*)/iu);
    const dateOnly = line.match(/^(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/iu);
    const date = dateMatch?.[1] || dateOnly?.[1] || null;
    const content = dateMatch
      ? line.slice(dateMatch[0].length)
      : dateOnly
        ? line.slice(dateOnly[0].length).replace(/^\s*[—–:-]\s*/, "")
        : line;
    const match = content.match(lineRe);
    if (!match) continue;
    const body = match[1].trim();
    const left = body;
    const right = match[3].trim();
    const teams = [normalizeTeamName(left), normalizeTeamName(right)];
    if (!teams.includes(expected[0]) || !teams.includes(expected[1]) || teams[0] === teams[1]) continue;

    const score = match[2].replace(/\s/g, "");
    const scoreParts = score.split(/[—–-]/).map(Number);
    const leftIsTeam1 = teams[0] === expected[0];
    let winner: string | null = null;
    if (scoreParts[0] === scoreParts[1]) winner = "DRAW";
    else winner = scoreParts[0] > scoreParts[1] ? left : right;
    entries.push({
      date,
      competition: null,
      score: leftIsTeam1 ? score : `${scoreParts[1]}-${scoreParts[0]}`,
      winner: leftIsTeam1 ? winner : (winner === "DRAW" ? winner : (winner === left ? team2 : team1)),
      source: null,
      status: null,
    });
  }
  return entries;
}

function parseH2HBullets(lines: string[]): ParsedH2H[] {
  const entries: ParsedH2H[] = [];
  // regexes work after stripMd (which removes ** and leading #); support -/* list markers
  const factRe = /^\s*[-*]?\s*FACT\s*:\s*(.+)$/i;
  const dateRe = /^\s*[-*]?\s*DATE\s*:\s*(.+)$/i;
  const compRe = /^\s*[-*]?\s*(?:TOURNAMENT|COMPETITION)\s*:\s*(.+)$/i;
  const scoreRe = /^\s*[-*]?\s*SCORE\s*:\s*(.+)$/i;
  const winnerRe = /^\s*[-*]?\s*WINNER\s*:\s*(.+)$/i;
  const srcRe = /^\s*[-*]?\s*SOURCE\s*:\s*(.+)$/i;
  const statusRe = /^\s*[-*]?\s*(?:STATUS|CONFIDENCE)\s*:\s*(.+)$/i;

  let i = 0;
  while (i < lines.length) {
    const s = stripMd(lines[i]);
    const fm = s.match(factRe);
    if (!fm) { i++; continue; }
    let date: string | null = null;
    let competition: string | null = null;
    let score: string | null = null;
    let winner: string | null = null;
    let source: string | null = null;
    let status: string | null = null;
    // scan forward for sibling bullet fields (up to ~10 lines)
    for (let j = i + 1; j < lines.length && j <= i + 10; j++) {
      const sj = stripMd(lines[j]);
      if (/^\s*[-*]?\s*FACT\s*:/i.test(sj)) break; // next block
      const dm = sj.match(dateRe); if (dm) { date = dm[1].trim(); continue; }
      const cm = sj.match(compRe); if (cm) { competition = cm[1].trim(); continue; }
      const sm = sj.match(scoreRe); if (sm) { score = sm[1].trim(); continue; }
      const wm = sj.match(winnerRe); if (wm) { winner = wm[1].trim(); continue; }
      const srcm = sj.match(srcRe); if (srcm) { source = srcm[1].trim(); continue; }
      const st = sj.match(statusRe); if (st) { status = st[1].trim(); continue; }
      // stop if we hit a new header or empty gap after a few lines
      if (/^#{1,6}\s/.test(lines[j]) || (/^\s*$/.test(lines[j]) && j > i + 3)) break;
    }
    if (isConcreteH2H(date, score)) {
      entries.push({ date, competition, score, winner: normalizeH2HWinner(score, winner), source, status });
    }
    i++;
  }
  return entries;
}

function isConcreteH2H(date: string | null, score: string | null): boolean {
  return Boolean(
    score && /\d+\s*[–—-]\s*\d+/.test(score) &&
    (!date || /^(?:\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\.?$/.test(date.trim())),
  );
}

function normalizeH2HWinner(score: string | null, winner: string | null): string | null {
  const normalizedWinner = winner?.trim().replace(/[.]$/, '').toUpperCase();
  if (normalizedWinner === 'DRAW' || normalizedWinner === 'NO WINNER') return 'DRAW';

  const scoreMatch = score?.match(/(\d+)\s*[–—-]\s*(\d+)/);
  if (scoreMatch && scoreMatch[1] === scoreMatch[2]) return 'DRAW';
  return winner;
}

function deduplicateH2H(entries: ParsedH2H[]): ParsedH2H[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const score = entry.score?.replace(/\s+/g, '').replace(/[–—]/g, '-') || '';
    const key = `${entry.date?.trim() || ''}|${score}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseH2H(sections: Map<string, string[]>, team1: string | null, team2: string | null): ParsedH2H[] {
  const entries: ParsedH2H[] = [];

  for (let i = 1; i <= 5; i++) {
    const matchKey = `MATCH ${i}`;
    let ml: string[] | undefined;
    for (const [key, lines] of sections) {
      if (key === `H2H:${matchKey}` || key === `HEAD TO HEAD:${matchKey}`) {
        ml = lines;
        break;
      }
    }
    if (ml && ml.some(l => l.trim().length > 0)) {
      const date = getField(ml, "DATE");
      const competition = getField(ml, "TOURNAMENT") || getField(ml, "COMPETITION");
      const score = getField(ml, "SCORE");
      const winner = getField(ml, "WINNER");
      const source = getField(ml, "SOURCE");
      const status = getField(ml, "STATUS");
       if (isConcreteH2H(date, score)) {
        entries.push({ date, competition, score, winner: normalizeH2HWinner(score, winner), source, status });
      }
    }
  }

  if (entries.length > 0) return deduplicateH2H(entries);

  for (const [key, lines] of sections) {
    if (/^H2H:HEAD[-\s]?TO[-\s]?HEAD$/i.test(key)) {
      const numbered = parseH2HNumbered(lines);
      if (numbered.length > 0) return deduplicateH2H(numbered);
    }
  }

  if (entries.length === 0) {
    // support plain "## H2H" / "## HEAD-TO-HEAD" (possibly prefixed as "H2H:H2H" or "H2H:HEAD-TO-HEAD") with bullet or numbered
    for (const [key, lines] of sections) {
      const up = key.toUpperCase();
      const isH2HKey = /^(?:.*:)?H2H$/.test(up) || /^(?:.*:)?HEAD([-. ]?TO[-. ]?HEAD)?$/.test(up) || /HEAD-TO-HEAD/.test(up);
      if (isH2HKey) {
        // try numbered first (for ### 1. style under it)
        const numbered = parseH2HNumbered(lines);
        if (numbered.length > 0) return deduplicateH2H(numbered);
        const plain = parseH2HPlain(lines, team1, team2);
        if (plain.length > 0) return deduplicateH2H(plain);
        const bullets = parseH2HBullets(lines);
        if (bullets.length > 0) return deduplicateH2H(bullets);
        const aggregate = parseH2HAggregateFacts(lines, team1, team2);
        if (aggregate.length > 0) return aggregate;
      }
    }
  }

  return entries;
}

function extractTeamNameFromMatchTitle(report: string): { team1: string | null; team2: string | null } {
  // Match "MATCH VERIFICATION ... * FACT: Team1 vs Team2" style
  const matchRe = /MATCH\s+VERIFICATION[\s\S]*?\*\s*FACT\s*:\s*([^*\n]+)/i;
  let m = report.match(matchRe);
  if (m) {
    const fact = m[1].trim();
    const vs = fact.split(/\s*(?:vs\.?|—|-|–)\s*/i);
    if (vs.length >= 2) {
      return { team1: vs[0].trim(), team2: vs[1].trim() };
    }
  }
  // Match plain "## MATCH\n- **FACT:** Team1 vs Team2" or "FACT: Team1 — Team2" style (used in compact/You.com VDP)
  // tolerant to optional list marker and ** around the label
  const factRe = /(?:^|\n)\s*[-*]?\s*\*?\*?FACT\*?\*?\s*:\s*([^\n]+)/i;
  m = report.match(factRe);
  if (m) {
    let fact = m[1].trim();
    // remove leading ** / * from value if bolded, cut at first comma/semi, strip trailing punct
    fact = fact.replace(/^\*+\s*/, '').replace(/\s*\*+$/, '').replace(/[.;]+$/,'').split(/[;,]/)[0].trim();
    const vs = fact.split(/\s*(?:vs\.?|—|-|–)\s*/i);
    if (vs.length >= 2) {
      return { team1: vs[0].trim(), team2: vs[1].trim() };
    }
  }
  return { team1: null, team2: null };
}

function extractTeamNamesFromPreamble(sections: Map<string, string[]>): { team1: string | null; team2: string | null } {
  const lines = sections.get("__preamble__") || [];
  return { team1: getField(lines, "TEAM 1"), team2: getField(lines, "TEAM 2") };
}

function extractTeamNamesFromFormHeaders(report: string): { team1: string | null; team2: string | null } {
  // support "TEAM 1 — RECENT FORM: NAME", "TEAM 1 FORM — NAME", "TEAM 1 FORM: NAME"
  const t1 = report.match(/^#{1,6}\s*TEAM\s*1\s*(?:[-–—]\s*RECENT\s*FORM\s*:\s*|FORM\s*[-–—:]\s*)(.+)$/im);
  const t2 = report.match(/^#{1,6}\s*TEAM\s*2\s*(?:[-–—]\s*RECENT\s*FORM\s*:\s*|FORM\s*[-–—:]\s*)(.+)$/im);
  return {
    team1: t1 ? t1[1].replace(/\*/g, "").trim() : null,
    team2: t2 ? t2[1].replace(/\*/g, "").trim() : null,
  };
}

export function parseVDP(report: string): ParsedVDP {
  const sections = splitIntoSections(report);

  const team1 = parseTeam(sections, /^TEAM\s*1\s*(FORM|- RECENT FORM)(?:\s*:\s*.+)?$/i);
  const team2 = parseTeam(sections, /^TEAM\s*2\s*(FORM|- RECENT FORM)(?:\s*:\s*.+)?$/i);

  if (!team1.teamName || !team2.teamName) {
    const fromPreamble = extractTeamNamesFromPreamble(sections);
    if (!team1.teamName && fromPreamble.team1) team1.teamName = fromPreamble.team1;
    if (!team2.teamName && fromPreamble.team2) team2.teamName = fromPreamble.team2;
  }

  if (!team1.teamName || !team2.teamName) {
    const fromHeaders = extractTeamNamesFromFormHeaders(report);
    if (!team1.teamName && fromHeaders.team1) team1.teamName = fromHeaders.team1;
    if (!team2.teamName && fromHeaders.team2) team2.teamName = fromHeaders.team2;
  }

  if (!team1.teamName || !team2.teamName) {
    const fromTitle = extractTeamNameFromMatchTitle(report);
    if (!team1.teamName && fromTitle.team1) team1.teamName = fromTitle.team1;
    if (!team2.teamName && fromTitle.team2) team2.teamName = fromTitle.team2;
  }

  const h2h = parseH2H(sections, team1.teamName, team2.teamName);

  return { team1, team2, h2h };
}
