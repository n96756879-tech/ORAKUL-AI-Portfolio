// Извлечение fixture metadata из cleaned text (STEP 10, расширен в STEP 12).
// Строго null-safe: поле либо реально присутствует в тексте, либо null.
// Ничего не выдумываем: нет даты в тексте → date = null (не из URL, не текущая).
// STEP 12: аддитивный fallback «Team A vs Team B» + competition из pipe-формата
// «Team1-Team2 | Match info | COMPETITION | UEFA.com». Существующая логика не заменяется.

import type { Fixture } from './types';

const VENUE_HINTS = ['stadium', 'arena', 'stadion', 'стадион'];
const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// UI/навигационные подписи, которые НЕ должны превращаться в команды (STEP 12).
const UI_LABEL_HINTS = [
  'updates', 'timeline', 'line-ups', 'lineups', 'lineup', 'stats', 'statistics',
  'squad', 'squads', 'group', 'standings', 'table', 'fixtures', 'results',
  'news', 'video', 'videos', 'highlights', 'live', 'match info', 'menu',
  'skip to', 'login', 'sign in', 'register', 'cookie', 'privacy', 'not found',
];

function isUiLike(value: string): boolean {
  const lower = value.toLowerCase();
  return UI_LABEL_HINTS.some((hint) => lower === hint || lower.includes(hint));
}

// Нормализация имени команды: HTML → лишние разделители по краям → пробелы.
function sanitizeTeamName(raw: string): string {
  const noHtml = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&(apos|#39);/gi, "'");
  return noHtml
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Парс «Team A vs Team B» из одной строки (vs/VS/Vs/vs., —, –; регистр неважен).
// Возвращает null для UI/навигационных строк и неоднозначных конструкций.
function parseVersusLine(line: string): { team1: string; team2: string } | null {
  if (isUiLike(line)) return null;
  const m = line.match(/^(.{1,60}?)\s+(?:vs\.?|—|–)\s+(.{1,60})$/i);
  if (!m) return null;
  const team1 = sanitizeTeamName(m[1]);
  const team2 = sanitizeTeamName(m[2]);
  if (!team1 || !team2) return null;
  if (team1.length < 2 || team2.length < 2) return null;
  if (!/\p{L}/u.test(team1) || !/\p{L}/u.test(team2)) return null;
  // Неоднозначность «A vs B vs C» → не выдумываем.
  if (/\s+(?:vs\.?|—|–)\s+/i.test(team2)) return null;
  return { team1, team2 };
}

// Competition из pipe-формата «Team1-Team2 | Match info | COMPETITION | UEFA.com».
function extractPipeCompetition(lines: string[]): string | null {
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!line.includes('|') || !lower.includes('uefa.com')) continue;
    const segments = line.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
    if (segments.length >= 3 && segments[segments.length - 1].toLowerCase() === 'uefa.com') {
      const candidate = sanitizeTeamName(segments[segments.length - 2]);
      if (candidate && candidate.length >= 3 && !isUiLike(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

export function extractFixtureFromText(
  text: string,
  context: { team1?: string; team2?: string; sourceUrl?: string | null } = {}
): Fixture {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter((l) => l.length > 0);
  const lowerLines = lines.map((l) => l.toLowerCase());
  const haystack = lowerLines.join('\n');

  // Competition: 1) pipe-формат title (STEP 12); 2) прежняя логика — первая строка
  // с явным маркером турнира.
  const competitionPatterns: RegExp[] = [
    /uefa nations league/i,
    /uefa [a-z ]+ (league|championship|qualifiers)/i,
    /fifa world cup/i,
    /world cup/i,
    /euro[a-z]* ?\d{0,4}/i,
    /nations league/i,
    /friendly/i,
  ];
  let competition: string | null = extractPipeCompetition(lines);
  if (!competition) {
    outer: for (const pattern of competitionPatterns) {
      for (const line of lines) {
        if (pattern.test(line)) {
          competition = line;
          break outer;
        }
      }
    }
  }

  // Venue: первая строка-«локация» (Stadium/Arena/Stadion/…).
  let venue: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (VENUE_HINTS.some((hint) => lowerLines[i].includes(hint))) {
      venue = lines[i];
      break;
    }
  }

  // Город — следующая строка после venue (паттерн «Stadium …» → «City …»).
  let city: string | null = null;
  if (venue) {
    const idx = lowerLines.findIndex((l) => l === venue.toLowerCase());
    if (idx >= 0 && idx + 1 < lines.length) {
      const next = lines[idx + 1];
      if (next.length <= 60 && !/[0-9]/.test(next) && !VENUE_HINTS.some((h) => next.toLowerCase().includes(h))) {
        city = next;
      }
    }
  }

  // Teams: точное совпадение строки с запрошенным именем (case-insensitive).
  let team1: string | null = null;
  if (context.team1) {
    const wanted = context.team1.toLowerCase();
    const found = lines.find((l) => l.toLowerCase() === wanted);
    team1 = found ?? null;
  }
  let team2: string | null = null;
  if (context.team2) {
    const wanted = context.team2.toLowerCase();
    const found = lines.find((l) => l.toLowerCase() === wanted);
    team2 = found ?? null;
  }

  // STEP 12 fallback: «Team A vs Team B» в одной строке. Только если точная
  // логика не нашла команды. Case-insensitive; UI-подписи отфильтрованы.
  if (!team1 && !team2) {
    for (const line of lines) {
      const versus = parseVersusLine(line);
      if (versus) {
        // Приоритет паре, соответствующей запрошенному матчу, если контекст есть.
        if (
          context.team1 && context.team2 &&
          versus.team1.toLowerCase() === context.team1.toLowerCase() &&
          versus.team2.toLowerCase() === context.team2.toLowerCase()
        ) {
          team1 = versus.team1;
          team2 = versus.team2;
          break;
        }
        if (!team1 && !team2 && !isUiLike(versus.team1) && !isUiLike(versus.team2)) {
          team1 = versus.team1;
          team2 = versus.team2;
        }
      }
    }
  }

  // Date: только явные форматы в тексте. Нет — null (не выдумываем).
  let date: string | null = null;
  const datePatterns: RegExp[] = [
    /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i,
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i,
    /\b(\d{4}-\d{2}-\d{2})\b/,
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
  ];
  for (const pattern of datePatterns) {
    const m = haystack.match(pattern);
    if (!m) continue;
    if (m[1] && /^\d{4}-\d{2}-\d{2}$/.test(m[1])) {
      date = m[1];
      break;
    }
    const monthWord = m[2] && MONTHS[m[2].toLowerCase()] !== undefined ? m[2] : m[1];
    if (monthWord && MONTHS[monthWord.toLowerCase()] !== undefined) {
      const dayStr = monthWord === m[2] ? m[1] : m[2];
      const yearStr = m[3];
      const day = parseInt(dayStr, 10);
      const month = MONTHS[monthWord.toLowerCase()];
      const year = parseInt(yearStr, 10);
      if (!Number.isNaN(day) && !Number.isNaN(year)) {
        date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        break;
      }
    }
    if (m.length === 4 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(m[0])) {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      const year = parseInt(m[3], 10);
      if (month >= 0 && month <= 11) {
        date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        break;
      }
    }
  }

  return {
    sport: 'football',
    team1,
    team2,
    date,
    competition,
    venue,
    city,
    sourceUrl: context.sourceUrl ?? null,
    sourceId: 'keydealer-web-fetch',
    confidence: null,
  };
}
