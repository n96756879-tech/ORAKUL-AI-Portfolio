// STEP 19: offline H2H extractor (Data Layer).
// Извлекает историю личных встреч (head-to-head) из cleaned text (Web Fetch)
// и нормализует её в существующий тип H2HSnapshot.
// Без HTTP, без resolver, без Probability Engine: подготовительный слой,
// который резолвер вызывает на том же fetched text (один Web Fetch).
// Строго null-safe: нет данных в тексте → [], ничего не выдумываем.

import type { H2HSnapshot } from './types';

// Максимум встреч в одном извлечении (MVP).
const MAX_H2H = 10;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Суффиксы, отбрасываемые при сопоставлении имён («England FC» → «england»).
const TEAM_SUFFIX_TOKENS = new Set(['fc', 'sc', 'cf', 'afc', 'national', 'team']);

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&(apos|#39);/gi, "'");
}

function normalizeLine(line: string): string {
  return stripHtml(line).replace(/\s+/g, ' ').trim();
}

function sanitizeTeamName(raw: string): string {
  return stripHtml(raw)
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Минимальная нормализация имени: нижний регистр, только буквы/цифры,
// без суффиксов FC/SC/national team (сопоставление «England» == «England FC»).
function normalizeTeamKey(value: string): string {
  return stripHtml(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !TEAM_SUFFIX_TOKENS.has(t))
    .join(' ');
}

function sameTeam(a: string, b: string): boolean {
  const ka = normalizeTeamKey(a);
  const kb = normalizeTeamKey(b);
  if (!ka || !kb) return false;
  return ka === kb;
}

// «20 Sep 2026», «20 September 2026», «2026-09-20» → ISO | null.
export function parseH2HDate(raw: string | null): string | null {
  if (!raw) return null;
  const value = stripHtml(raw).trim();
  if (!value) return null;

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    const mi = Number(m);
    const di = Number(d);
    if (mi >= 1 && mi <= 12 && di >= 1 && di <= 31) return `${y}-${m}-${d}`;
    return null;
  }

  const human = value.match(/^(\d{1,2})\s+([A-Za-zА-Яа-яЁё]+)\.?\s+(\d{4})$/);
  if (human) {
    const day = Number(human[1]);
    const monthName = human[2].slice(0, 3).toLowerCase();
    const year = human[3];
    const month = MONTHS[monthName];
    if (month !== undefined && day >= 1 && day <= 31) {
      return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }
  return null;
}

// Счёт: «2-1», «2 - 1», «2–1», «2:1» → {home, away} | null. Голов ≤ 20.
function parseScoreInLine(line: string): { index: number; length: number; home: number; away: number } | null {
  const re = /\b(\d{1,2})\s*(?:-|–|—|:|to)\s*(\d{1,2})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > 0 && /[\d-]$/.test(line.slice(0, m.index))) continue;
    const home = Number(m[1]);
    const away = Number(m[2]);
    if (home <= 20 && away <= 20) {
      return { index: m.index, length: m[0].length, home, away };
    }
  }
  return null;
}

// Winner нормализуется к запрошенной паре: победа teamA → teamA (как в fixture),
// победа teamB → teamB, ничья → "DRAW". Пенальти не угадываем: основной счёт
// равный → DRAW (ровно та семантика, что ожидает h2hScore в Engine).
function winnerFromScore(
  home: number,
  away: number,
  homeName: string,
  awayName: string,
  teamA: string,
  teamB: string
): string {
  if (home === away) return 'DRAW';
  const winnerName = home > away ? homeName : awayName;
  if (sameTeam(winnerName, teamA)) return sanitizeTeamName(teamA);
  if (sameTeam(winnerName, teamB)) return sanitizeTeamName(teamB);
  return 'DRAW';
}

export type H2HExtractionResult = {
  matches: H2HSnapshot[];
  droppedNoisy: number;
};

// Главная точка входа: pair-aware извлечение H2H из произвольного текста.
// teamA/teamB — имена пары (из fixture / ParsedVDP); порядок НЕ важен:
// winner всегда нормализуется к этой паре (teamA | teamB | DRAW).
// Строго без угадываний: строка без валидного счёта и узнаваемой пары → пропуск.
export function extractH2HFromText(
  text: string,
  teamA: string,
  teamB: string
): H2HSnapshot[] {
  if (!text || !teamA || !teamB) return [];
  const lines = text.split(/\r?\n/);
  const out: H2HSnapshot[] = [];

  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    if (!line) continue;

    const score = parseScoreInLine(line);
    if (!score) continue;

    // Дата в начале строки: «20 Sep 2026 — England 2-1 Spain» / «2026-09-20: …».
    const datePrefix = line.slice(0, score.index).match(
      /^(?:(\d{4}-\d{2}-\d{2})|(\d{1,2}\s+[A-Za-zА-Яа-яЁё]+\.?\s+\d{4}))\s*[—–—\-:,.]\s*/
    );
    const dateRaw = datePrefix ? (datePrefix[1] ?? datePrefix[2]) : null;

    const before = (datePrefix ? line.slice(datePrefix[0].length, score.index) : line.slice(0, score.index)).trim();
    const after = line.slice(score.index + score.length).trim();

    const homeName = sanitizeTeamName(before);
    const awayName = sanitizeTeamName(after);

    if (!homeName || !awayName) continue;

    const homeMatchesPair =
      sameTeam(homeName, teamA) || sameTeam(homeName, teamB);
    const awayMatchesPair =
      sameTeam(awayName, teamA) || sameTeam(awayName, teamB);

    if (!homeMatchesPair || !awayMatchesPair || sameTeam(homeName, awayName)) continue;

    out.push({
      date: parseH2HDate(dateRaw),
      competition: null,
      score: `${score.home}-${score.away}`,
      winner: winnerFromScore(score.home, score.away, homeName, awayName, teamA, teamB),
    });
    if (out.length >= MAX_H2H) break;
  }

  return out.slice(0, MAX_H2H);
}
