import { NextResponse } from 'next/server';
import { parseHockeyVDP } from '@/lib/hockey/hockey-vdp-parser';
import { verifyMatchTeams, MATCH_UNVERIFIED_ERROR } from '@/lib/match-verification';
import { adaptHockeyVDPToEngineInput } from '@/lib/hockey/hockey-engine-adapter';
import { predictHockeyMatch } from '@/lib/hockey/hockey-engine';
import { parseVDP } from '@/lib/vdp-parser';
import type { ParsedVDP } from '@/lib/vdp-parser';
import { calculateProbabilitiesWithTrace } from '@/lib/probability-engine';
import { persistGoldRecord } from '@/lib/gold-record';
import type { GoldRecord } from '@/lib/gold-record';
import { calculateGoalDistribution } from '@/lib/goal-distribution';
import type { GoalDistributionInput, GoalDistributionResult } from '@/lib/goal-distribution';
import { extractVDP } from '@/lib/vdp-extractor';
import {
  assembleVdp,
  createKeyDealerWebFetcher,
  getSharedDataPackCache,
  matchQueryFromFreeForm,
  mergeEngineInput,
  resolveDataPack,
  buildResearchCacheKey,
  getCachedResearch,
  getOrRunResearch,
} from '@/lib/data';
import type { DataPack, ResearchQueryKey } from '@/lib/data';
import type { AnalysisResult } from '@/types/analysis';
import {
  reserveFreeGeneration,
  consumeFreeGeneration,
  releaseFreeGeneration,
} from '@/lib/supabase/free-limit';
import { createClient } from '@/lib/supabase/server';
import { getCurrentSession } from '@/lib/auth/session';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import {
  reserveCreditSpend,
  consumeCreditSpend,
  releaseCreditSpend,
} from '@/lib/supabase/credits';
import { savePrediction } from '@/lib/supabase/predictions';
import { cookies } from 'next/headers';
import { createHmac, randomUUID } from 'crypto';

// Venue текущего матча в перспективе конкретной команды: team1 = currentVenue как есть,
// team2 = зеркало (HOME ↔ AWAY). NEUTRAL/UNKNOWN остаются без изменений.
function mirrorVenue(
  venue: ParsedVDP['currentVenue'],
): ParsedVDP['currentVenue'] {
  if (venue === 'HOME') return 'AWAY';
  if (venue === 'AWAY') return 'HOME';
  return venue;
}

export function buildGoalDistributionInput(vdp: ParsedVDP): GoalDistributionInput {
  const mapTeam = (
    team: ParsedVDP['team1'],
    currentVenue: ParsedVDP['currentVenue'],
  ) => ({
    matches: team.matches.map((match) => ({
      goalsFor: match.goalsFor ?? undefined,
      goalsAgainst: match.goalsAgainst ?? undefined,
      result: match.result,
      opponentStrength: match.opponentStrength,
      venue: match.venue,
    })),
    currentVenue,
  });

  return {
    team1: mapTeam(vdp.team1, vdp.currentVenue),
    team2: mapTeam(vdp.team2, mirrorVenue(vdp.currentVenue)),
    h2h: vdp.h2h,
  };
}

// Парсер ORAKUL_DAL_SOURCE_URLS: «normalized match key|URL», элементы через «;;».
// Пример: football|belgium|vs|france|;;https://www.uefa.com/... (секреты не содержит).
function parseDalSourceUrls(raw: string | undefined): { matchKey: string; url: string }[] {
  if (!raw) return [];
  return raw
    .split(';;')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const sep = part.indexOf('|http');
      if (sep < 0) return null;
      const matchKey = part.slice(0, sep).trim();
      const url = part.slice(sep + 1).trim();
      if (!matchKey || !/^https?:\/\//i.test(url)) return null;
      return { matchKey, url };
    })
    .filter((v): v is { matchKey: string; url: string } => v !== null);
}

const MAX_RESEARCH_CHARS = 50000;

function truncateResearchReport(report: string, maxChars: number = MAX_RESEARCH_CHARS): string {
  if (!report || report.length <= maxChars) {
    return report;
  }
  return report.slice(0, maxChars) + '\n\n[Research report truncated to 50,000 characters]';
}

interface ResearchSource {
  title?: string;
  url?: string;
  name?: string;
  link?: string;
}

function sanitizeSecrets(text: string): string {
  if (!text) return '';
  return text
    .replace(/ydc_live_[a-zA-Z0-9_-]+/gi, '[REDACTED_YDC_KEY]')
    .replace(/kd_live_[a-zA-Z0-9_-]+/gi, '[REDACTED_KD_KEY]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/X-API-Key:\s+[^\s"']+/gi, 'X-API-Key: [REDACTED]');
}

function normalizeResearchReport(val: any): string {
  if (val === null || val === undefined) {
    return '';
  }

  if (typeof val === 'string') {
    return val;
  }

  if (Array.isArray(val)) {
    return val
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object') {
          const text =
            item.content ||
            item.text ||
            item.output ||
            item.snippet ||
            item.body ||
            item.description ||
            item.markdown;

          if (typeof text === 'string' && text.trim().length > 0) {
            const title = item.title || item.heading || item.section || item.name;
            return title ? `## ${title}\n${text}` : text;
          }
          if (text && typeof text === 'object') {
            return normalizeResearchReport(text);
          }
          try {
            return JSON.stringify(item, null, 2);
          } catch {
            return String(item);
          }
        }
        return String(item);
      })
      .filter(Boolean)
      .join('\n\n');
  }

  if (typeof val === 'object') {
    const content =
      val.content ||
      val.output ||
      val.text ||
      val.response ||
      val.answer ||
      val.data ||
      val.markdown;

    if (content && content !== val) {
      const normalizedContent = normalizeResearchReport(content);
      if (normalizedContent.trim().length > 0) {
        return normalizedContent;
      }
    }
    try {
      return JSON.stringify(val, null, 2);
    } catch {
      return String(val);
    }
  }

  return String(val);
}

function isRecord(value: any): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toTrimmedString(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(toTrimmedString).filter(Boolean).join('; ');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function toProbabilityNumber(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.replace('%', '').trim();
    if (normalized === '') return null;
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function summarizeTeam(value: any): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  const parts = [value.summary, value.balance, value.form]
    .map(toTrimmedString)
    .filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return JSON.stringify(value);
}

function extractLegacyOverview(raw: Record<string, any>): string {
  if (raw.analytical_conclusion !== undefined) {
    return toTrimmedString(raw.analytical_conclusion);
  }
  if (isRecord(raw.prediction)) {
    const parts = [
      raw.prediction.winner ? `Победитель: ${toTrimmedString(raw.prediction.winner)}` : '',
      raw.prediction.score ? `Счёт: ${toTrimmedString(raw.prediction.score)}` : '',
      raw.prediction.confidence ? `Уверенность: ${toTrimmedString(raw.prediction.confidence)}` : '',
      raw.prediction.note ? toTrimmedString(raw.prediction.note) : '',
    ].filter(Boolean);
    if (parts.length > 0) return parts.join('. ');
  }
  return '';
}

function extractLegacyTeamForms(raw: Record<string, any>): { team1: string; team2: string } {
  const result = { team1: '', team2: '' };
  const teamForm = raw.team_form;
  if (typeof teamForm === 'string') {
    result.team1 = teamForm.trim();
    return result;
  }
  if (!isRecord(teamForm)) return result;

  const explicitPairs: Array<[string, string]> = [
    ['team1', 'team2'],
    ['team_a', 'team_b'],
    ['home', 'away'],
  ];
  for (const [firstKey, secondKey] of explicitPairs) {
    if (teamForm[firstKey] !== undefined && teamForm[secondKey] !== undefined) {
      result.team1 = summarizeTeam(teamForm[firstKey]);
      result.team2 = summarizeTeam(teamForm[secondKey]);
      return result;
    }
  }

  const keys = Object.keys(teamForm);
  if (keys.length >= 2) {
    result.team1 = summarizeTeam(teamForm[keys[0]]);
    result.team2 = summarizeTeam(teamForm[keys[1]]);
  } else if (keys.length === 1) {
    result.team1 = summarizeTeam(teamForm[keys[0]]);
  }
  return result;
}

function extractLegacyH2h(raw: Record<string, any>): string {
  if (typeof raw.h2h === 'string') return raw.h2h.trim();
  if (!isRecord(raw.h2h)) return '';

  const parts: string[] = [];
  if (raw.h2h.edge) parts.push(toTrimmedString(raw.h2h.edge));
  if (Array.isArray(raw.h2h.recent_official_and_friendly)) {
    parts.push(raw.h2h.recent_official_and_friendly.map(toTrimmedString).filter(Boolean).join('; '));
  }
  if (Array.isArray(raw.h2h.matches)) {
    parts.push(raw.h2h.matches.map(toTrimmedString).filter(Boolean).join('; '));
  }
  if (parts.length > 0) return parts.join(' ');
  return JSON.stringify(raw.h2h);
}

function extractLegacySquads(raw: Record<string, any>): string {
  const squads = raw.squads_and_availability;
  if (typeof squads === 'string') return squads.trim();
  if (!isRecord(squads)) return '';
  const note = toTrimmedString(squads.official_lineups_note || squads.note);
  if (note) return note;
  return JSON.stringify(squads);
}

function extractLegacyFactors(raw: Record<string, any>): string[] {
  if (isRecord(raw.explanation)) {
    const factors = raw.explanation.factors;
    if (Array.isArray(factors)) {
      return factors.map(toTrimmedString).filter(Boolean);
    }
    if (typeof factors === 'string' && factors.trim()) {
      return [factors.trim()];
    }
  }

  const keyFactors = raw.key_factors;
  if (Array.isArray(keyFactors)) {
    return keyFactors.map(toTrimmedString).filter(Boolean);
  }
  if (isRecord(keyFactors)) {
    const out: string[] = [];
    for (const value of Object.values(keyFactors)) {
      if (Array.isArray(value)) {
        out.push(...value.map(toTrimmedString).filter(Boolean));
      } else if (typeof value === 'string' && value.trim()) {
        out.push(value.trim());
      }
    }
    return out;
  }
  return [];
}

function extractProbabilities(raw: Record<string, any>): { team1: number; draw: number; team2: number } | null {
  if (!isRecord(raw.probabilities)) return null;

  const directTeam1 = toProbabilityNumber(raw.probabilities.team1);
  const directDraw = toProbabilityNumber(raw.probabilities.draw);
  const directTeam2 = toProbabilityNumber(raw.probabilities.team2);
  if (directTeam1 !== null && directDraw !== null && directTeam2 !== null) {
    return { team1: directTeam1, draw: directDraw, team2: directTeam2 };
  }

  if (Array.isArray(raw.probabilities.outcomes)) {
    const values = raw.probabilities.outcomes
      .map((item: any) => (isRecord(item) ? toProbabilityNumber(item.value) : null))
      .filter((n: any): n is number => n !== null);
    if (values.length === 3) {
      return { team1: values[0], draw: values[1], team2: values[2] };
    }
  }

  return null;
}

function buildAnalysisContract(raw: any): Record<string, any> | null {
  if (!isRecord(raw)) return null;

  // Старая схема могла быть обёрнута в orakul_ai_expert_analysis
  if (isRecord(raw.orakul_ai_expert_analysis)) {
    raw = raw.orakul_ai_expert_analysis;
  }

  const status = typeof raw.status === 'string' ? raw.status : 'success';

  let match = '';
  if (typeof raw.match === 'string') {
    match = raw.match.trim();
  } else if (isRecord(raw.match)) {
    match = toTrimmedString(raw.match.title || raw.match.fixture || raw.match.teams);
  }

  const probabilities = extractProbabilities(raw);
  const teamForms = extractLegacyTeamForms(raw);
  const explanation = isRecord(raw.explanation) ? raw.explanation : {};

  return {
    status,
    match,
    probabilities,
    usedSources: Array.isArray(raw.usedSources) ? raw.usedSources : [],
    explanation: {
      overview: toTrimmedString(explanation.overview) || extractLegacyOverview(raw),
      team1Form: toTrimmedString(explanation.team1Form) || teamForms.team1,
      team2Form: toTrimmedString(explanation.team2Form) || teamForms.team2,
      h2h: toTrimmedString(explanation.h2h) || extractLegacyH2h(raw),
      squadAndInjuries: toTrimmedString(explanation.squadAndInjuries) || extractLegacySquads(raw),
      factors: extractLegacyFactors(raw),
    },
  };
}

function validateAnalysisContract(contract: Record<string, any>): string | null {
  if (contract.status !== 'success') {
    return `unexpected status: ${contract.status}`;
  }

  if (typeof contract.match !== 'string' || contract.match.trim().length === 0) {
    return 'match is missing';
  }

  if (!isRecord(contract.probabilities)) {
    return 'probabilities is missing';
  }
  const team1 = toProbabilityNumber(contract.probabilities.team1);
  const draw = toProbabilityNumber(contract.probabilities.draw);
  const team2 = toProbabilityNumber(contract.probabilities.team2);
  if (team1 === null || draw === null || team2 === null) {
    return 'probabilities.team1/draw/team2 must be numeric';
  }
  const sum = team1 + draw + team2;
  if (Math.abs(sum - 100) > 0.01) {
    return `probabilities.team1 + draw + team2 must equal 100 (got ${sum})`;
  }

  if (!Array.isArray(contract.usedSources) || contract.usedSources.length === 0) {
    return 'usedSources must be a non-empty array';
  }

  const explanation = contract.explanation;
  if (!isRecord(explanation)) {
    return 'explanation is missing';
  }
  const requiredTextFields = ['overview', 'team1Form', 'team2Form', 'h2h', 'squadAndInjuries'];
  for (const field of requiredTextFields) {
    if (typeof explanation[field] !== 'string' || explanation[field].trim().length === 0) {
      return `explanation.${field} is missing or empty`;
    }
  }
  if (!Array.isArray(explanation.factors) || explanation.factors.length === 0) {
    return 'explanation.factors must be a non-empty array';
  }

  return null;
}

function normalizeUsedSources(
  rawSources: any,
  researchSources: ResearchSource[],
): Array<{ title: string; url: string }> {
  const result: Array<{ title: string; url: string }> = [];

  if (Array.isArray(rawSources)) {
    for (const item of rawSources) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const urlMatch = trimmed.match(/https?:\/\/[^\s"']+/i);
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          result.push({ title: trimmed, url: trimmed });
        } else if (urlMatch) {
          const url = urlMatch[0];
          const title = trimmed.replace(url, '').trim() || url;
          result.push({ title, url });
        } else {
          result.push({ title: trimmed, url: '' });
        }
      } else if (isRecord(item)) {
        const url = toTrimmedString(item.url || item.link);
        const title = toTrimmedString(item.title || item.name) || url;
        if (title || url) {
          result.push({ title: title || url, url });
        }
      }
    }
  }

  if (result.length === 0) {
    return researchSources
      .map((source) => ({
        title: toTrimmedString(source.title || source.name) || toTrimmedString(source.url || source.link),
        url: toTrimmedString(source.url || source.link),
      }))
      .filter((source) => source.title || source.url);
  }

  return result;
}

function adaptAnalysisContractToResponse(
  contract: Record<string, any>,
  trimmedMatch: string,
  researchSources: ResearchSource[],
  goalDistribution: GoalDistributionResult,
) {
  const matchTitle = trimmedMatch;
  const probabilities = contract.probabilities;
  const explanation = contract.explanation;

  const outcomeValues = [
    toProbabilityNumber(probabilities.team1) ?? 0,
    toProbabilityNumber(probabilities.draw) ?? 0,
    toProbabilityNumber(probabilities.team2) ?? 0,
  ];

  const factors = Array.isArray(explanation.factors)
    ? explanation.factors.map(toTrimmedString).filter(Boolean).join('\n• ')
    : toTrimmedString(explanation.factors);

  return {
    status: 'success',
    match: {
      title: matchTitle,
      meta: 'Анализ на основе исследования открытых источников',
    },
    probabilities: {
      outcomes: [
        { label: 'Победа Команды 1', value: `${Math.round(outcomeValues[0])}%` },
        { label: 'Ничья', value: `${Math.round(outcomeValues[1])}%` },
        { label: 'Победа Команды 2', value: `${Math.round(outcomeValues[2])}%` },
      ],
      totals: [
        { label: 'ТБ 1.5', value: `${Math.round(goalDistribution.markets.totals.over15 * 100)}%` },
        { label: 'ТМ 1.5', value: `${Math.round(goalDistribution.markets.totals.under15 * 100)}%` },
        { label: 'ТБ 2.5', value: `${Math.round(goalDistribution.markets.totals.over25 * 100)}%` },
        { label: 'ТМ 2.5', value: `${Math.round(goalDistribution.markets.totals.under25 * 100)}%` },
        { label: 'ТБ 3.5', value: `${Math.round(goalDistribution.markets.totals.over35 * 100)}%` },
        { label: 'ТМ 3.5', value: `${Math.round(goalDistribution.markets.totals.under35 * 100)}%` },
      ],
      btts: [
        { label: 'Да', value: `${Math.round(goalDistribution.markets.btts.yes * 100)}%` },
        { label: 'Нет', value: `${Math.round(goalDistribution.markets.btts.no * 100)}%` },
      ],
    },
    explanation: {
      overview: toTrimmedString(explanation.overview),
      team1Form: toTrimmedString(explanation.team1Form),
      team2Form: toTrimmedString(explanation.team2Form),
      h2h: toTrimmedString(explanation.h2h),
      squadAndInjuries: toTrimmedString(explanation.squadAndInjuries),
      factors,
    },
    usedSources: normalizeUsedSources(contract.usedSources, researchSources),
  };
}

function buildHockeyResearchQuery(trimmedMatch: string): string {
  return `Проведи глубокое независимое спортивно-статистическое исследование хоккейного матча "${trimmedMatch}".

Ты создаёшь внутренний проверенный пакет данных (VERIFIED DATA PACK) для математического движка ORAKUL Hockey Engine. Отдавай приоритет официальным первичным источникам (КХЛ, НХЛ, официальные сайты клубов).

В ответе ОБЯЗАТЕЛЬНО должна содержаться буквально строка:
# VERIFIED DATA PACK

Категорически запрещено заменять VERIFIED DATA PACK обычной текстовой или аналитической статьёй. Отчёт ДОЛЖЕН содержать строго следующие структурированные секции:

## 1. MATCH IDENTIFICATION
FACT: [Команда 1] vs [Команда 2]
DATE: [Дата матча]
LEAGUE: [Лига/Турнир]
VENUE: [Арена/Город]
HOME_AWAY: [Команда 1] — HOME; [Команда 2] — AWAY (или наоборот)

## 2. TEAM 1 RECENT FORM — [Название Команды 1]
### FORM SUMMARY
GAMES PLAYED: [Число сыгранных матчей, обычно 5]
REGULATION WINS: [Победы в основное время]
REGULATION LOSSES: [Поражения в основное время]
OT LOSSES: [Поражения в овертайме]
SO LOSSES: [Поражения по буллитам]
GOALS FOR: [Заброшено шайб всего]
GOALS AGAINST: [Пропущено шайб всего]

- MATCH 1: [Дата] | [Соперник] | [Счёт, напр. 4:1] | [W или L] | GF: [Голы] | GA: [Пропущено] | [REGULATION/OVERTIME/SHOOTOUT]
- MATCH 2: [Дата] | [Соперник] | [Счёт] | [W или L] | GF: [Голы] | GA: [Пропущено] | [REGULATION/OVERTIME/SHOOTOUT]
- MATCH 3: [Дата] | [Соперник] | [Счёт] | [W или L] | GF: [Голы] | GA: [Пропущено] | [REGULATION/OVERTIME/SHOOTOUT]
- MATCH 4: [Дата] | [Соперник] | [Счёт] | [W или L] | GF: [Голы] | GA: [Пропущено] | [REGULATION/OVERTIME/SHOOTOUT]
- MATCH 5: [Дата] | [Соперник] | [Счёт] | [W или L] | GF: [Голы] | GA: [Пропущено] | [REGULATION/OVERTIME/SHOOTOUT]

## 3. TEAM 2 RECENT FORM — [Название Команды 2]
### FORM SUMMARY
GAMES PLAYED: [Число сыгранных матчей, обычно 5]
REGULATION WINS: [Победы в основное время]
REGULATION LOSSES: [Поражения в основное время]
OT LOSSES: [Поражения в овертайме]
SO LOSSES: [Поражения по буллитам]
GOALS FOR: [Заброшено шайб всего]
GOALS AGAINST: [Пропущено шайб всего]

- MATCH 1: [Дата] | [Соперник] | [Счёт] | [W или L] | GF: [Голы] | GA: [Пропущено] | [REGULATION/OVERTIME/SHOOTOUT]
- MATCH 2: [Дата] | [Соперник] | [Счёт] | [W или L] | GF: [Голы] | GA: [Пропущено] | [REGULATION/OVERTIME/SHOOTOUT]
- MATCH 3: [Дата] | [Соперник] | [Счёт] | [W или L] | GF: [Голы] | GA: [Пропущено] | [REGULATION/OVERTIME/SHOOTOUT]
- MATCH 4: [Дата] | [Соперник] | [Счёт] | [W или L] | GF: [Голы] | GA: [Пропущено] | [REGULATION/OVERTIME/SHOOTOUT]
- MATCH 5: [Дата] | [Соперник] | [Счёт] | [W или L] | GF: [Голы] | GA: [Пропущено] | [REGULATION/OVERTIME/SHOOTOUT]

## 4. GOALTENDING
### TEAM 1
STARTER: [Имя вратаря] | STATUS: [CONFIRMED/PARTIALLY_CONFIRMED/UNCONFIRMED]
SV_PCT: [Процент отраженных бросков, напр. 0.925]
GAA: [Коэффициент надежности, напр. 2.15]
BACKUP: [Имя запасного вратаря]

### TEAM 2
STARTER: [Имя вратаря] | STATUS: [CONFIRMED/PARTIALLY_CONFIRMED/UNCONFIRMED]
SV_PCT: [Процент отраженных бросков, напр. 0.910]
GAA: [Коэффициент надежности, напр. 2.50]
BACKUP: [Имя запасного вратаря]

## 5. SPECIAL TEAMS
### TEAM 1
PP_PCT: [Процент реализации большинства, напр. 22.5%]
PK_PCT: [Процент нейтрализации меньшинства, напр. 82.0%]

### TEAM 2
PP_PCT: [Процент реализации большинства, напр. 18.0%]
PK_PCT: [Процент нейтрализации меньшинства, напр. 79.5%]

## 6. SHOTS AND DEFENSE
### TEAM 1
SHOTS_FOR_PER_GAME: [Средние броски в створ, напр. 30.5]
SHOTS_AGAINST_PER_GAME: [Средние броски соперника, напр. 28.0]

### TEAM 2
SHOTS_FOR_PER_GAME: [Средние броски в створ, напр. 27.0]
SHOTS_AGAINST_PER_GAME: [Средние броски соперника, напр. 32.0]

## 7. H2H
- MATCH 1: [Дата] | [Команда 1 — Команда 2] | [Счёт]
- MATCH 2: [Дата] | [Команда 1 — Команда 2] | [Счёт]
- MATCH 3: [Дата] | [Команда 1 — Команда 2] | [Счёт]

## 8. AVAILABILITY AND INJURIES
### TEAM 1
- PLAYER: [Имя] | STATUS: [OUT/QUESTIONABLE] | REASON: [Травма]

### TEAM 2
- PLAYER: [Имя] | STATUS: [OUT/QUESTIONABLE] | REASON: [Травма]

ПРАВИЛА ЗАПОЛНЕНИЯ:
1. Если данное не найдено, пиши NOT_FOUND или UNKNOWN. Не придумывай факты и счет.
2. Не превращай отсутствующие данные в 0.
3. Соблюдай точность названий полей. Строка "# VERIFIED DATA PACK" обязательна в самом начале отчёта.`;
}

async function handleHockeyAnalysis(
  trimmedMatch: string,
  ydcApiKey: string,
  keydealerApiKey: string,
  freeGenReservationId: string | null = null,
  creditSpendReservationId: string | null = null,
  creditSpendIdemKey: string | null = null
) {
  const researchQuery = buildHockeyResearchQuery(trimmedMatch);
  const researchCacheKey = buildResearchCacheKey(researchQuery as any);
  
  const cachedResearch = getCachedResearch(researchCacheKey);
  let researchMarkdown = cachedResearch?.report ?? '';
  let researchSources: ResearchSource[] = cachedResearch?.sources ?? [];

  if (!cachedResearch) {
    const researchResult = await getOrRunResearch(researchCacheKey, async () => {
      let taskId: string | null = null;
      const initRes = await fetch('https://api.you.com/v1/research', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-API-Key': ydcApiKey,
        },
        body: JSON.stringify({
          input: researchQuery,
          research_effort: 'deep',
          background: true,
        }),
      });

      if (!initRes.ok) {
        const rawErrText = await initRes.text();
        if (freeGenReservationId) {
          await releaseFreeGeneration(freeGenReservationId);
          freeGenReservationId = null;
        }
        throw new Error(`You.com Research failed: HTTP ${initRes.status} — ${sanitizeSecrets(rawErrText)}`);
      }

      const initData = await initRes.json();
      taskId = initData.task_id || initData.taskId || initData.id || null;
      if (!taskId) {
        if (freeGenReservationId) {
          await releaseFreeGeneration(freeGenReservationId);
          freeGenReservationId = null;
        }
        throw new Error('You.com Research init failed: task_id was missing');
      }

      const pollingIntervalMs = 5_000;
      const maxTimeoutMs = 180_000;
      const startTime = Date.now();
      let isCompleted = false;
      let lastPollData: any = null;
      let pollCount = 0;

      while (Date.now() - startTime < maxTimeoutMs) {
        pollCount++;
        const elapsed = Date.now() - startTime;
        const pollRes = await fetch(`https://api.you.com/v1/research/${taskId}`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-API-Key': ydcApiKey,
          },
        });

        const pollOk = pollRes.ok;
        const pollHttp = pollRes.status;
        let pollStatus: string | null = null;
        let pollState: string | null = null;
        let pollData: any = null;

        if (pollOk) {
          try {
            pollData = await pollRes.json();
          } catch {
            pollData = null;
          }
          lastPollData = pollData;
          pollStatus = String(pollData?.status || '').toLowerCase() || null;
          pollState = pollData?.state != null ? String(pollData.state) : null;

          console.log(`[HOCKEY POLL #${pollCount}] elapsed=${elapsed}ms http=${pollHttp} ok=${pollOk} status=${pollStatus} state=${pollState}`);

          if (pollStatus === 'completed') {
            isCompleted = true;
            break;
          }
      if (pollStatus === 'failed' || pollStatus === 'error' || pollStatus === 'cancelled') {
        console.log(`[HOCKEY POLL #${pollCount}] terminal status=${pollStatus}`);
        if (freeGenReservationId) {
          await releaseFreeGeneration(freeGenReservationId);
          freeGenReservationId = null;
        }
        if (creditSpendReservationId) {
          await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
          creditSpendReservationId = null;
        }
        throw new Error(`You.com Research task ${taskId} failed with status: ${pollStatus}`);
      }
        } else {
          console.log(`[HOCKEY POLL #${pollCount}] elapsed=${elapsed}ms http=${pollHttp} ok=${pollOk}`);
        }
        await new Promise((r) => setTimeout(r, pollingIntervalMs));
      }

      if (!isCompleted) {
        const lastStatus = lastPollData?.status ? String(lastPollData.status).toLowerCase() : null;
        const lastState = lastPollData?.state != null ? String(lastPollData.state) : null;
        console.log(`[HOCKEY POLL TIMEOUT] polls=${pollCount} elapsed=${Date.now() - startTime}ms lastStatus=${lastStatus} lastState=${lastState}`);
        if (freeGenReservationId) {
          await releaseFreeGeneration(freeGenReservationId);
          freeGenReservationId = null;
        }
        if (creditSpendReservationId) {
          await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
          creditSpendReservationId = null;
        }
        throw new Error(`You.com Research polling timed out for task ${taskId}`);
      }

      const finalStatus = lastPollData?.status ? String(lastPollData.status).toLowerCase() : null;
      const finalState = lastPollData?.state != null ? String(lastPollData.state) : null;
      const hasResult = !!(lastPollData?.result || lastPollData?.output || lastPollData?.content);
      console.log(`[HOCKEY POLL DONE] status=${finalStatus} state=${finalState} hasResult=${hasResult} resultKeys=${lastPollData?.result ? Object.keys(lastPollData.result).join(',') : 'none'}`);

      const rawReport = lastPollData?.result?.output?.content || lastPollData?.result?.content || lastPollData?.output || '';
      const normReport = normalizeResearchReport(rawReport);

      const rawSources = lastPollData?.result?.sources || lastPollData?.sources || [];
      const sources: ResearchSource[] = Array.isArray(rawSources)
        ? rawSources.map((s: any) => ({
            name: s.title || s.name || s.url || 'Источник You.com Research',
            url: s.url || s.link || '',
          })).filter((s: ResearchSource) => s.url)
        : [];

      return { report: normReport, sources };
    });

    researchMarkdown = researchResult.report;
    researchSources = researchResult.sources;
  }

    const rawVdpText = extractVDP(researchMarkdown);
    if (!rawVdpText || rawVdpText.trim().length === 0) {
      console.error('[ORAKUL HOCKEY] VERIFIED DATA PACK not found in research report. Aborting analysis.');
      if (freeGenReservationId) {
        await releaseFreeGeneration(freeGenReservationId);
      }
      if (creditSpendReservationId) {
        await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
        creditSpendReservationId = null;
      }
      return NextResponse.json(
        { error: 'VERIFIED DATA PACK не найден в отчёте исследования. Анализ невозможен.' },
        { status: 422 }
      );
    }

  const parsedHockeyVdp = parseHockeyVDP(rawVdpText);

  // Guard: жёстко блокируется только VDP без идентифицированных команд.
  // Расхождение названий (кириллица/латиница, суффиксы, формат) — диагностика,
  // а не отказ: иначе анализ ломается на корректных матчах.
  const hockeyVerification = verifyMatchTeams(
    trimmedMatch,
    parsedHockeyVdp.match.team1Name,
    parsedHockeyVdp.match.team2Name,
  );
  if (!hockeyVerification.ok && hockeyVerification.reason !== 'teams_mismatch') {
    console.error(`[ORAKUL HOCKEY] Match verification failed (${hockeyVerification.reason}). Aborting before probability calculation.`);
    if (freeGenReservationId) {
      await releaseFreeGeneration(freeGenReservationId);
      freeGenReservationId = null;
    }
    if (creditSpendReservationId) {
      await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
      creditSpendReservationId = null;
    }
    return NextResponse.json({ error: MATCH_UNVERIFIED_ERROR }, { status: 422 });
  }

  const engineInput = adaptHockeyVDPToEngineInput(parsedHockeyVdp);
  const predictionResult = predictHockeyMatch(engineInput);

  // Authoritative Hockey probabilities from Hockey Engine
  const regProbs = {
    team1: predictionResult.core.pHomeRegulationWin,
    draw: predictionResult.core.pRegulationTie,
    team2: predictionResult.core.pAwayRegulationWin,
  };
  const finalProbs = {
    team1: predictionResult.core.pHomeFinalWin,
    team2: predictionResult.core.pAwayFinalWin,
  };

  // Construct Hockey LLM prompt focusing on hockey metrics
  const hockeySystemPrompt = `Ты — профессиональный спортивно-аналитический и статистический ассистент ORAKUL AI для ХОККЕЯ.
Твоя задача — изучить отчёт исследований You.com и сгенерировать глубокий, строгий текстовый разбор хоккейного матча.

ПРАВИЛА:
1. Выдавай ТОЛЬКО валидный JSON без внешнего текста или markdown-блоков (или с тиками \`\`\`json).
2. Числовые вероятности вычисляются авторитарным математическим движком ORAKUL Hockey Engine и будут установлены автоматически.
3. Твоя задача — качественная текстовая аналитика на основе VERIFIED DATA PACK.

JSON SCHEMA:
{
  "match": "${trimmedMatch}",
  "explanation": {
    "overview": "Краткое введение и контекст матча...",
    "team1Form": "Анализ формы первой команды (броски, спецбригады, вратарь)...",
    "team2Form": "Анализ формы второй команды (броски, спецбригады, вратарь)...",
    "h2h": "История личных встреч...",
    "squadAndInjuries": "Вратари, составы, ключевые травмированные...",
    "factors": ["Фактор 1", "Фактор 2", "Фактор 3", "Фактор 4"]
  },
  "usedSources": [
    { "name": "Источник", "url": "https://..." }
  ]
}`;

  const truncatedReport = truncateResearchReport(researchMarkdown);
  const userPrompt = `МАТЧ: ${trimmedMatch}

ДАННЫЕ ИССЛЕДОВАНИЯ YOU.COM:
${truncatedReport}`;

  let contract: Record<string, any> | null = null;
  for (let llmAttempt = 0; llmAttempt < 2; llmAttempt++) {
    try {
      const chatRes = await fetch('https://api.keydealer.net/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keydealerApiKey}`,
        },
        body: JSON.stringify({
          model: 'anthropic/claude-3.5-sonnet',
          messages: [
            { role: 'system', content: hockeySystemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
        }),
      });

      if (!chatRes.ok) {
        throw new Error(`KeyDealer API HTTP error: ${chatRes.status}`);
      }

      const chatData = await chatRes.json();
      const rawContent = chatData?.choices?.[0]?.message?.content || '';
      const cleanedJson = String(rawContent)
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();

      const parsed = JSON.parse(cleanedJson);
      contract = buildAnalysisContract(parsed);
      if (contract) break;
    } catch (parseError: any) {
      console.error('JSON parse error from Hockey LLM:', parseError);
    }
  }

  // Fallback text if LLM failed. Probabilities remain engine-computed and are
  // only reachable here when the match-verification guard already passed.
  if (!contract) {
    contract = {
      match: trimmedMatch,
      explanation: {
        overview: `Анализ хоккейного матча ${trimmedMatch} сформирован ORAKUL Hockey Engine.`,
        team1Form: 'Статистика первой команды учтена движком.',
        team2Form: 'Статистика второй команды учтена движком.',
        h2h: 'Данные личных встреч обработаны.',
        squadAndInjuries: 'Информация по вратарям и составам учтена.',
        factors: ['Форма в последних матчах', 'Статистика спецбригад PP/PK', 'Надёжность вратарей'],
      },
      usedSources: [],
    };
  }

  if (freeGenReservationId) {
    await releaseFreeGeneration(freeGenReservationId);
    freeGenReservationId = null;
  }
  if (creditSpendReservationId) {
    // success path for authed: consume the reserved spend
    await consumeCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
    creditSpendReservationId = null;
  }

  // Format outcomes for UI compatibility:
  // Primary outcomes show 2-way Final OT/SO probabilities as key market, plus 3-way Regulation in labels/details if needed.
  // We provide outcomes representing Final Winner (incl. OT/SO) and Regulation 1X2 in clear label format.
  const outcomeValues = [
    { label: `Победа 1 (с ОТ/Б)`, value: `${Math.round(finalProbs.team1 * 100)}%` },
    { label: `Победа 2 (с ОТ/Б)`, value: `${Math.round(finalProbs.team2 * 100)}%` },
    { label: `Основное время: П1 ${Math.round(regProbs.team1 * 100)}% | X ${Math.round(regProbs.draw * 100)}% | П2 ${Math.round(regProbs.team2 * 100)}%`, value: '1X2' }
  ];

  const explanation = contract.explanation || {};
  const rawFactors = extractLegacyFactors(explanation);
  const factors = rawFactors.length >= 3 ? rawFactors.slice(0, 5) : [
    'Форма в последних матчах',
    'Эффективность спецбригад (PP/PK)',
    'Стабильность вратарской линии'
  ];

  const responseBody: AnalysisResult = {
    status: 'success',
    match: {
      title: trimmedMatch,
      meta: 'Анализ на основе исследования открытых источников',
    },
    probabilities: {
      outcomes: outcomeValues,
    },
    explanation: {
      overview: toTrimmedString(explanation.overview),
      team1Form: toTrimmedString(explanation.team1Form),
      team2Form: toTrimmedString(explanation.team2Form),
      h2h: toTrimmedString(explanation.h2h),
      squadAndInjuries: toTrimmedString(explanation.squadAndInjuries),
      factors: Array.isArray(factors) ? factors.join('\n') : toTrimmedString(factors),
    },
    usedSources: normalizeUsedSources(contract.usedSources, researchSources),
  };

  return NextResponse.json(responseBody);
}

const ANON_SESSION_SECRET = process.env.ANON_SESSION_SECRET;

function signAnonSid(sid: string): string {
  if (!ANON_SESSION_SECRET) {
    throw new Error('ANON_SESSION_SECRET is not configured');
  }
  const sig = createHmac('sha256', ANON_SESSION_SECRET).update(sid).digest('hex').slice(0, 16);
  return `${sid}.${sig}`;
}

export function verifyAnonSid(token: string): string | null {
  if (!ANON_SESSION_SECRET) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const sid = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', ANON_SESSION_SECRET).update(sid).digest('hex').slice(0, 16);
  if (sig !== expected) return null;
  return sid;
}

async function getOrCreateAnonSessionId(): Promise<string> {
  if (!ANON_SESSION_SECRET) {
    throw new Error('ANON_SESSION_SECRET is not configured');
  }
  const cookieStore = await cookies();
  const raw = cookieStore.get('anon_sid')?.value;
  if (raw && typeof raw === 'string') {
    const verified = verifyAnonSid(raw);
    if (verified) return verified;
  }
  const newSid = randomUUID();
  const signed = signAnonSid(newSid);
  try {
    cookieStore.set('anon_sid', signed, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
  } catch {
    // ignore cookie set errors in non-response contexts
  }
  return newSid;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const matchRaw = body?.match;
    const team1Raw = body?.team1;
    const team2Raw = body?.team2;
    const matchDateRaw = body?.matchDate;
    const sportRaw = body?.sport ?? 'football';
    const operationId = body?.operationId;
    const sport = typeof sportRaw === 'string' ? sportRaw : 'football';

    const hasTeam1 = typeof team1Raw === 'string' && team1Raw.trim().length > 0;
    const hasTeam2 = typeof team2Raw === 'string' && team2Raw.trim().length > 0;
    if (hasTeam1 !== hasTeam2) {
      return NextResponse.json(
        { error: 'Укажите обе команды или используйте старый формат с полем match.' },
        { status: 400 }
      );
    }

    let trimmedMatch: string;
    if (hasTeam1 && hasTeam2) {
      trimmedMatch = `${team1Raw.trim()} vs ${team2Raw.trim()}`;
    } else if (typeof matchRaw === 'string' && matchRaw.trim().length > 0) {
      trimmedMatch = matchRaw.trim();
    } else {
      return NextResponse.json(
        { error: 'Не указан матч для анализа. Введите название матча.' },
        { status: 400 }
      );
    }

    let matchDate: string | null = null;
    if (matchDateRaw !== undefined && matchDateRaw !== null) {
      if (typeof matchDateRaw !== 'string') {
        return NextResponse.json(
          { error: 'Дата матча должна быть строкой в формате YYYY-MM-DD.' },
          { status: 400 }
        );
      }
      const dateStr = matchDateRaw.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return NextResponse.json(
          { error: 'Дата матча должна быть в формате YYYY-MM-DD.' },
          { status: 400 }
        );
      }
      const [y, m, d] = dateStr.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (
        Number.isNaN(dt.getTime()) ||
        dt.getUTCFullYear() !== y ||
        dt.getUTCMonth() !== m - 1 ||
        dt.getUTCDate() !== d
      ) {
        return NextResponse.json(
          { error: 'Указана несуществующая календарная дата.' },
          { status: 400 }
        );
      }
      matchDate = dateStr;
    }

    // Client-supplied operation identifier: identifies a single logical analysis
    // (so a retried request reuses one credit reservation). It never influences
    // the charged user or the price — both stay server-side.
    const clientOperationId: string | null = typeof operationId === 'string' ? operationId : null;
    if (clientOperationId !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(clientOperationId)) {
      return NextResponse.json(
        { error: 'Некорректный идентификатор операции.' },
        { status: 400 }
      );
    }

    const ydcApiKey = process.env.YDC_API_KEY;
    const keydealerApiKey = process.env.KEYDEALER_API_KEY;

    if (!ydcApiKey) {
      return NextResponse.json(
        { error: 'You.com Research failed: YDC_API_KEY is not configured in .env' },
        { status: 500 }
      );
    }

    if (!keydealerApiKey) {
      return NextResponse.json(
        { error: 'KeyDealer API key is not configured in .env' },
        { status: 500 }
      );
    }

    const currentDateStr = '2026 год';

    // ── ANALYSIS_COST (server-only, no default, fail closed) ─────────────
    const ANALYSIS_COST_STR = process.env.ANALYSIS_COST;
    if (!ANALYSIS_COST_STR || !/^[1-9]\d*$/.test(ANALYSIS_COST_STR)) {
      return NextResponse.json(
        { error: 'Service configuration error.' },
        { status: 500 },
      );
    }
    const ANALYSIS_COST = parseInt(ANALYSIS_COST_STR, 10);

    // ── Auth first: authed users pay with credits, bypass free-limit ────
    let creditSpendReservationId: string | null = null;
    let creditSpendIdemKey: string | null = null;
    let freeGenReservationId: string | null = null;
    let authedUserId: string | null = null;

    try {
      const ssrClient = await createClient();
      const session = await getCurrentSession(ssrClient);
      if (session.ok && session.user?.id) {
        authedUserId = session.user.id;
      }
    } catch {
      // fallthrough to anon
    }

    if (authedUserId) {
      const adminClient = createServiceRoleClient();
      // Key identity: the client operation id when present (retry of the same logical
      // request keeps it), otherwise a deterministic match+price fallback.
      const idemKey = clientOperationId
        ? `analysis:${authedUserId}:op:${clientOperationId}`
        : `analysis:${authedUserId}:m:${trimmedMatch.replace(/\s+/g, ' ').toLowerCase().slice(0, 180)}:${ANALYSIS_COST}`;
      creditSpendIdemKey = idemKey;
      const reserveRes = await reserveCreditSpend(adminClient, {
        userId: authedUserId,
        amount: ANALYSIS_COST,
        reason: 'analysis',
        idempotencyKey: idemKey,
      });
      if (!reserveRes.ok) {
        if (reserveRes.reason === 'insufficient_funds') {
          return NextResponse.json(
            { status: 'insufficient_credits', balance: reserveRes.balance ?? 0 },
            { status: 402 },
          );
        }
        // Same operation id reused for a different amount/match, or replayed after the
        // reservation was already released. Controlled client conflict, not a server fault.
        if (reserveRes.reason === 'idempotency_conflict') {
          return NextResponse.json(
            {
              status: 'idempotency_conflict',
              error: 'This operation conflicts with a previous credit operation. Please retry with a new operation id.',
            },
            { status: 409 },
          );
        }
        return NextResponse.json(
          { error: 'Credit reservation failed.' },
          { status: 500 },
        );
      }
      creditSpendReservationId = reserveRes.reservationId;
    } else {
      // Anonymous free-limit path (unchanged semantics)
      const anonSessionId = await getOrCreateAnonSessionId();
      const freeLimit = await reserveFreeGeneration(anonSessionId);
      if (!freeLimit.allowed) {
        if (freeLimit.reason === 'config_missing') {
          return NextResponse.json(
            { error: 'Service unavailable. Please try again later.' },
            { status: 503 },
          );
        }
        return NextResponse.json(
          { status: 'auth_required', message: 'Free generation limit reached. Please sign in.' },
          { status: 402 },
        );
      }
      freeGenReservationId = freeLimit.reservationId;
    }

    if (sport === 'hockey') {
      return await handleHockeyAnalysis(trimmedMatch, ydcApiKey, keydealerApiKey, freeGenReservationId, creditSpendReservationId, creditSpendIdemKey);
    }

    const researchQuery = { ...matchQueryFromFreeForm(trimmedMatch), date: matchDate };
    const researchCacheKey = buildResearchCacheKey(researchQuery);

    // ── DAL (STEP 9/10): опциональный контекст данных, полностью bypass по умолчанию.
    // Не влияет на You.com VDP pipeline; пустой DataPack не является ошибкой.
    // STEP 10: KeyDealer /v1/web/fetch — ТОЛЬКО при явном URL из ORAKUL_DAL_SOURCE_URLS.
    const dalEnabled = process.env.ORAKUL_DAL_ENABLED === 'true';
    let dalContext: ReturnType<typeof assembleVdp> | null = null;
    let dalDataPack: DataPack | null = null;
    if (dalEnabled) {
      const dalQuery = matchQueryFromFreeForm(trimmedMatch);
      const sourceUrls = parseDalSourceUrls(process.env.ORAKUL_DAL_SOURCE_URLS);
      const dalOutcome = await resolveDataPack(dalQuery, {
        cache: getSharedDataPackCache(),
        keyDealerWebFetcher: createKeyDealerWebFetcher(),
        sourceUrls,
      });
      dalDataPack = dalOutcome.dataPack;
      dalContext = assembleVdp(dalOutcome.dataPack);
      console.log(
        `[ORAKUL DAL] enabled=true cacheHit=${dalOutcome.cacheHit} status=${dalContext.stats.status} ` +
          `confirmed=${dalContext.stats.confirmed} sources=${dalOutcome.dataPack.sources.length} ` +
          `conflicts=${dalContext.conflicts.length} attempted=[${dalOutcome.attemptedSourceIds.join(',')}]`
      );
    } else {
      console.log('[ORAKUL DAL] enabled=false bypass');
    }

    // 1. Формирование исследовательского вопроса
    const matchDateClause = matchDate ? ` Запрошенная дата матча: ${matchDate}.` : '';
    const researchQuestion = `Проведи глубокое независимое спортивно-статистическое исследование матча "${trimmedMatch}" (актуальный контекст: ${currentDateStr}).${matchDateClause}

Ты создаёшь внутренний проверенный пакет данных (VERIFIED DATA PACK) для следующего этапа LLM-анализа. Отдавай приоритет официальным источникам. Каждый существенный факт должен иметь подтверждение из надёжного источника.

ПРАВИЛА ДЛЯ КАЖДОГО ФАКТА
Для каждого существенного факта укажи:
* FACT — конкретный факт;
* DATE — дата/актуальность информации;
* SOURCE — название источника;
* URL — ссылка;
* CONFIDENCE — CONFIRMED, PARTIALLY_CONFIRMED или UNCONFIRMED.

ПРИОРИТЕТ ИСТОЧНИКОВ — СТРОГАЯ ИЕРАРХИЯ TIER
Не считай все источники равнозначными. Для каждого факта выбирай максимально высокий доступный Tier. Не смешивай противоречивые данные молча.

TIER 1 — ОФИЦИАЛЬНЫЕ (наивысший приоритет):
* UEFA, FIFA;
* официальная федерация каждой сборной (например: Netherlands → KNVB, Germany → DFB, Portugal → FPF, Wales → FAW);
* официальный сайт турнира.

TIER 2 — СТАТИСТИЧЕСКИЕ БАЗЫ (для проверки и статистики):
* 11v11;
* FBref;
* Stathead / Statbunker (если доступно).

TIER 3 — КАЧЕСТВЕННЫЕ СМИ (для свежих новостей):
* Reuters;
* BBC Sport;
* Sky Sports;
* AP.

Если источники конфликтуют — пометь CONFLICTING. Если факт нельзя подтвердить — UNCONFIRMED. Не угадывай. Не используй один старый источник, если существует более свежая информация.

1. MATCH
Собери: дата; время; турнир; лига; группа; тур; стадион; хозяева/гости. Проверь существование матча.

2. TEAM 1 — RECENT FORM
Найди и зафиксируй ровно 5 последних завершённых ОФИЦИАЛЬНЫХ матчей перед анализируемой игрой.
Для КАЖДОГО матча обязательно укажи: DATE; COMPETITION; OPPONENT; HOME/AWAY; SCORE; RESULT (W, D или L); SOURCE; URL; CONFIDENCE.
Дополнительно, ЕСЛИ это можно обосновать доступными данными: OPPONENT_STRENGTH (сильный / средний / слабый). Если объективной основы нет — пиши UNKNOWN. Не придумывай рейтинг.
ПОРЯДОК СТРОГО ФИКСИРОВАН: MATCH 1 = самый свежий завершённый официальный матч; MATCH 5 = пятый по свежести. НЕ меняй порядок. DATE — фактическая дата матча.
НЕ заменяй эти пять матчей сводкой вида «2 победы, 2 ничьи, 1 поражение». Сначала получи 5 конкретных матчей, только затем вычисляй сводку формы.
Если найдено 5 матчей, итоговая последовательность RESULT должна содержать РОВНО 5 значений (например: W-D-D-L-W). Запрещено выдавать W-D-D-L при заявленных 5 матчах.
PENALTY SHOOTOUT (обязательное правило):
Серия пенальти НЕ превращает ничью в regulation/extra time в обычный W/L для RESULT SEQUENCE или FORM SUMMARY.
Если матч завершился, например, 2–2 после regulation/extra time и затем команда проиграла по пенальти:
* SCORE: 2–2 aet
* RESULT: D
* отдельно укажи PENALTY SHOOTOUT (например: lost 1–3)
* в RESULT SEQUENCE и в подсчёте W/D/L используй D
* результат серии пенальти НЕ используется для обычного W/L.
Не включай: товарищеские матчи (если возможно получить 5 официальных); отменённые матчи; будущие матчи; дубли одного матча.
Если официальный источник недоступен, используй приоритет: UEFA/FIFA → национальная федерация → официальный турнир/клуб → Reuters/AP/BBC/Sky → надёжная статистическая база.

3. TEAM 2 — RECENT FORM
Те же требования, что для TEAM 1.

ФОРМА КОМАНДЫ (FORM CALCULATION)
После получения конкретных матчей вычисли для каждой команды ТОЛЬКО из перечисленных MATCH 1–5:
* WINS
* DRAWS
* LOSSES
* GOALS FOR (сумма забитых из MATCH 1–5)
* GOALS AGAINST (сумма пропущенных из MATCH 1–5)
* GOAL DIFFERENCE (обязательно = GOALS FOR − GOALS AGAINST)
* RESULT SEQUENCE (ровно по одному символу W/D/L на каждый матч, в порядке MATCH 1 → MATCH 5)

RESULT SEQUENCE (жёсткое правило):
RESULT SEQUENCE MUST be generated mechanically from MATCH 1 → MATCH 5 in exactly that order.
MATCH 1 is always the newest match.
Never reverse, reorder, sort, or reconstruct the sequence independently.
The sequence MUST exactly equal the RESULT values written on MATCH 1, MATCH 2, MATCH 3, MATCH 4, MATCH 5.
Пример: MATCH 1=L, MATCH 2=W, MATCH 3=W, MATCH 4=L, MATCH 5=W обязательно даёт RESULT SEQUENCE: L-W-W-L-W.
Нельзя получать последовательность из отдельного агрегированного источника.

GOALS FOR / GOALS AGAINST (жёсткое правило):
GOALS FOR, GOALS AGAINST и GOAL DIFFERENCE MUST be calculated mechanically from MATCH 1–5 only.
Never copy these values from an external aggregate/statistics source.
Never estimate or infer them.
Recalculate them directly from the five listed match scores.
Для каждой команды:
GOALS FOR = sum of goals scored in MATCH 1–5.
GOALS AGAINST = sum of goals conceded in MATCH 1–5.
GOAL DIFFERENCE = GOALS FOR − GOALS AGAINST.
Если арифметика FORM SUMMARY не совпадает с построчными матчами — исправь FORM SUMMARY перед завершением VDP.

Строгие проверки перед выдачей:
1. WINS + DRAWS + LOSSES = количеству подтверждённых матчей (5, либо ровно столько, сколько реально подтверждено).
2. Длина RESULT SEQUENCE = количеству подтверждённых матчей.
3. GOALS FOR и GOALS AGAINST соответствуют указанным счетам MATCH 1–5.
4. GOAL DIFFERENCE = GOALS FOR − GOALS AGAINST.
5. Результаты вычисляй ТОЛЬКО из MATCH 1–5. Не используй отдельную агрегированную статистику сайта вместо этих матчей.
6. Если подтверждены только 4 матча — зафиксируй ровно 4. НЕ превращай 4 в 5. НЕ создавай недостающие матчи.
Если любая из проверок не проходит, НЕ считай блок подтверждённым и явно отметь проблему в VERIFIED DATA PACK.

ОБЯЗАТЕЛЬНЫЙ FINAL VALIDATION (для каждой команды, перед завершением VERIFIED DATA PACK):
CHECK 1 — ORDER: MATCH 1 = newest; RESULT SEQUENCE = RESULT(MATCH 1) → RESULT(MATCH 2) → RESULT(MATCH 3) → RESULT(MATCH 4) → RESULT(MATCH 5).
CHECK 2 — COUNTS: WINS + DRAWS + LOSSES = number of confirmed matches.
CHECK 3 — GOALS: GF = сумма GF MATCH 1–5; GA = сумма GA MATCH 1–5; GD = GF − GA.
CHECK 4 — PENALTY SHOOTOUT: если был penalty shootout, результат regulation/extra time используется в W/D/L; shootout result хранится отдельно; shootout НЕ меняет RESULT SEQUENCE.
CHECK 5 — INTERNAL CONSISTENCY: если какой-либо агрегат не совпадает с MATCH 1–5, НЕ выпускай противоречивый VDP — сначала пересчитай агрегат непосредственно из MATCH 1–5.

4. H2H
Последние 5–6 очных матчей: дата; счёт; победитель; турнир. Не используй только общий исторический баланс.

5. SQUADS
Актуальная заявка на данный матч.
Не используй агрегированные формулировки вроде «минимум 5 игроков травмированы» или «несколько игроков отсутствуют».
Для каждого существенного игрока, чей статус влияет на матч, фиксируй отдельную запись: PLAYER; STATUS; REASON; DATE; SOURCE; URL; CONFIDENCE; STATUS_TYPE.
STATUS_TYPE может быть: CONFIRMED_OUT; CONFIRMED_AVAILABLE; QUESTIONABLE; WITHDRAWN; SUSPENDED; UNCONFIRMED; CONFLICTING.
Пример структуры:
PLAYER: Harry Wilson
STATUS: withdrawn from squad
REASON: injury
DATE: 21.09.2026
SOURCE: official FAW
URL: ...
CONFIDENCE: CONFIRMED
STATUS_TYPE: WITHDRAWN

6. INJURIES / SUSPENSIONS
Для каждого отсутствующего или сомнительного игрока: игрок; причина; статус; дата последнего подтверждения; источник.
КРИТИЧЕСКИ ВАЖНО: если игрок сначала был в заявке, а затем выбыл, используй самое свежее подтверждение, а не старую заявку. Учитывай временную последовательность информации.
ПОСЛЕДНЕЕ СОСТОЯНИЕ ИГРОКА: для каждого спорного игрока учитывай последовательность INITIAL SQUAD → LATER INJURY/DOUBT → WITHDRAWAL/AVAILABILITY UPDATE → FINAL STATUS.
Если игрок сначала был в заявке, а затем официально выбыл, итоговое состояние — WITHDRAWN / CONFIRMED_OUT, а не просто «called up».
Если игрок был заменён, отдельно укажи игрока, пришедшего ему на замену.

7. COACHES
Актуальный тренер каждой команды на дату исследования.

8. TOURNAMENT CONTEXT
Положение в группе; предыдущая лига; повышение/понижение; предыдущая кампания; актуальная ситуация.

ПРОВЕРКА ПЕРЕД ФОРМИРОВАНИЕМ VERIFIED DATA PACK
Перед выдачей Research Report выполни внутреннюю проверку:
A. У каждой команды есть 5 конкретных последних официальных матчей.
B. У каждого матча есть дата, соперник и счёт.
C. Количество W/D/L соответствует пяти матчам.
D. Последовательность результатов содержит ровно 5 значений.
E. Существенные травмы/выбытия представлены конкретными игроками.
F. Для временно чувствительных данных используется самое свежее подтверждение.
G. Если источники противоречат друг другу — CONFLICTING, а не объединение двух версий.
H. Нельзя превращать UNCONFIRMED в CONFIRMED.

ЗАПРЕТ НА ВЫДУМЫВАНИЕ
Не превращай предположение в факт.
Если информация не подтверждена — пиши: UNCONFIRMED.
Если источники противоречат друг другу — пиши: CONFLICTING и укажи оба источника с датами.
Если информация устарела, она не должна считаться актуальной без дополнительного подтверждения.
Особенно внимательно проверяй: травмы; дисквалификации; заявки; тренеров; последние результаты; H2H; турнирный статус.

ТЕМПОРАЛЬНАЯ АКТУАЛЬНОСТЬ — КРИТИЧЕСКОЕ ПРАВИЛО
Для всех данных, которые могут измениться со временем (травмы; дисквалификации; вызовы/отказы от сборной; изменения состава; доступность игрока; статус тренера; последние результаты; турнирное положение), обязательно учитывай дату и время публикации источника.
Более свежий надёжный источник имеет приоритет над более старым источником.

КОНФЛИКТЫ ДАННЫХ
Если два источника противоречат друг другу, НЕ объединяй их в один факт.
В VERIFIED DATA PACK явно укажи CONFLICTING и приведи: более старое утверждение; более новое утверждение; дату каждого; источник каждого; какое утверждение считается актуальным и почему.
Приоритет: официальный источник + более свежая публикация > старый официальный источник; более свежий надёжный журналистский источник > старый журналистский источник.

СОСТАВЫ И ТРАВМЫ
Особенно тщательно проверяй финальный статус игроков.
Нельзя писать, что игрок доступен / выбыл / вернулся / вызван / снялся со сборной, если это основано только на более ранней заявке, когда существует более свежая информация.
Для каждого существенного изменения состава ищи последующее обновление.

ПРАВИЛО «ПОСЛЕДНЕЕ ПОДТВЕРЖДЕНИЕ»
Если игрок первоначально был включён в заявку, но позднее появились сообщения об отказе/травме/замене, итоговый VERIFIED DATA PACK должен отражать последнее подтверждённое состояние.
Логика: INITIAL SQUAD → LATER WITHDRAWAL → REPLACEMENT.
Итог: игрок = OUT / WITHDRAWN, замена = CALLED UP, если последнее состояние подтверждено источником.

H2H
Не называй старые очные встречи «последними», если существуют более свежие очные матчи.
Для H2H обязательно указывай: дату; турнир; счёт; победителя.
Если очных матчей давно не было, явно отметь их давность и НЕ придавай им чрезмерный вес.

ФОРМАТ RESEARCH REPORT
Верни структурированный текст с разделами:

MATCH VERIFICATION
...

TEAM 1 — RECENT FORM
...

TEAM 2 — RECENT FORM
...

HEAD-TO-HEAD
...

SQUADS & INJURIES
...

COACHES
...

TOURNAMENT CONTEXT
...

KEY VERIFIED FACTS
...

UNCERTAINTIES / UNCONFIRMED INFORMATION
...

SOURCES

1. [название] — [URL]
2. [название] — [URL]
...

В конце сформируй компактный внутренний блок VERIFIED DATA PACK (только для следующего шага LLM) в следующей структуре. Для каждого потенциально спорного факта обязательно сохраняй: FACT, DATE, SOURCE, URL, CONFIDENCE, STATUS. STATUS может быть: CONFIRMED, PARTIALLY_CONFIRMED, UNCONFIRMED, CONFLICTING. Для CONFLICTING обязательно сохрани оба конкурирующих утверждения (старое и новое, с датой и источником каждого) и объяснение, какое является более актуальным.

VERIFIED DATA PACK

MATCH
* FACT: ...
* DATE: ...
* SOURCE: ...
* URL: ...
* CONFIDENCE: CONFIRMED
* STATUS: CONFIRMED

TEAM 1 FORM
* FACT: ...
* SOURCE: ...
* URL: ...
* CONFIDENCE: CONFIRMED
* STATUS: CONFIRMED

MATCH 1
* DATE: ...
* COMPETITION: ...
* OPPONENT: ...
* HOME/AWAY: ...
* SCORE: ...
* RESULT: ...
* OPPONENT_STRENGTH: STRONG / MEDIUM / WEAK / UNKNOWN
* SOURCE: ...
* URL: ...
* CONFIDENCE: CONFIRMED

MATCH 2
* DATE: ...
* COMPETITION: ...
* OPPONENT: ...
* HOME/AWAY: ...
* SCORE: ...
* RESULT: ...
* OPPONENT_STRENGTH: STRONG / MEDIUM / WEAK / UNKNOWN
* SOURCE: ...
* URL: ...
* CONFIDENCE: CONFIRMED

MATCH 3
...

MATCH 4
...

MATCH 5
...

FORM SUMMARY
* wins: ...
* draws: ...
* losses: ...
* goalsFor: ...
* goalsAgainst: ...
* goalDifference: ... (обязательно = goalsFor − goalsAgainst)
* resultSequence: ... (ровно по одному W/D/L на каждый подтверждённый матч)

TEAM 2 FORM
* FACT: ...
* SOURCE: ...
* URL: ...
* CONFIDENCE: CONFIRMED
* STATUS: CONFIRMED

MATCH 1
* DATE: ...
* COMPETITION: ...
* OPPONENT: ...
* HOME/AWAY: ...
* SCORE: ...
* RESULT: ...
* OPPONENT_STRENGTH: STRONG / MEDIUM / WEAK / UNKNOWN
* SOURCE: ...
* URL: ...
* CONFIDENCE: CONFIRMED

MATCH 2
* DATE: ...
* COMPETITION: ...
* OPPONENT: ...
* HOME/AWAY: ...
* SCORE: ...
* RESULT: ...
* OPPONENT_STRENGTH: STRONG / MEDIUM / WEAK / UNKNOWN
* SOURCE: ...
* URL: ...
* CONFIDENCE: CONFIRMED

MATCH 3
...

MATCH 4
...

MATCH 5
...

FORM SUMMARY
* wins: ...
* draws: ...
* losses: ...
* goalsFor: ...
* goalsAgainst: ...
* goalDifference: ... (обязательно = goalsFor − goalsAgainst)
* resultSequence: ... (ровно по одному W/D/L на каждый подтверждённый матч)

H2H
* FACT: ...
* DATE: ...
* TOURNAMENT: ...
* SCORE: ...
* WINNER: ...
* SOURCE: ...
* STATUS: CONFIRMED

SQUADS
* PLAYER: ...
* STATUS: ...
* REASON: ...
* DATE: ...
* SOURCE: ...
* URL: ...
* CONFIDENCE: CONFIRMED
* STATUS_TYPE: CONFIRMED_AVAILABLE

INJURIES
* PLAYER: ...
* STATUS: ...
* REASON: ...
* DATE: ...
* SOURCE: ...
* URL: ...
* CONFIDENCE: CONFIRMED
* STATUS_TYPE: CONFIRMED_OUT

TOURNAMENT CONTEXT
* FACT: ...
* SOURCE: ...
* STATUS: CONFIRMED

CONFLICTS / UNCERTAINTIES
* CONFLICTING: старое утверждение → новое утверждение (дата и источник каждого), какое считается актуальным и почему.
* UNCONFIRMED: ...
...`;

    const cachedResearch = getCachedResearch(researchCacheKey);
    let researchReportText = cachedResearch?.report ?? '';
    let researchSources: ResearchSource[] = cachedResearch?.sources ?? [];

    if (!cachedResearch) {
      const researchResult = await getOrRunResearch(researchCacheKey, async () => {
        // 2. Инициализация фонового исследования (background: true)
    let taskId: string | null = null;
    try {
      const initRes = await fetch('https://api.you.com/v1/research', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-API-Key': ydcApiKey,
        },
        body: JSON.stringify({
          input: researchQuestion,
          research_effort: 'deep',
          background: true,
        }),
      });

      if (!initRes.ok) {
        const rawErrText = await initRes.text();
        const safeErrText = sanitizeSecrets(rawErrText);
        console.error(`You.com Research API init HTTP error: ${initRes.status}`, safeErrText);
        // The You.com Research contract is not documented in this repository, so no init
        // HTTP status can be treated as proof that no research task was created. The
        // reservation is deliberately kept (no release) for both 4xx and 5xx to avoid a
        // free-quota bypass on an ambiguous outcome.
        throw new Error(`You.com Research failed: HTTP ${initRes.status} — ${safeErrText}`);
      }

      const initData = await initRes.json();
      taskId = initData.task_id || initData.taskId || initData.id || null;

      if (!taskId) {
        const safeFields = Object.keys(initData).join(', ');
        console.error('You.com Research API did not return task_id. Top fields:', safeFields);
        // HTTP 200 means the request was accepted, and the missing known ID field is not
        // proof that the provider did not create a task. The reservation is kept active.
        throw new Error(`You.com Research init failed: task_id was missing in response (available fields: ${safeFields})`);
      }
    } catch (initErr: any) {
      const safeMsg = sanitizeSecrets(initErr?.message || String(initErr));
      console.error('You.com Research API init fetch error:', safeMsg);
      throw new Error(`You.com Research init connection failed: ${safeMsg}`);
    }

    // 3. Polling результатов (опрос GET /v1/research/{task_id})
    researchReportText = '';
    researchSources = [];
    
    const pollingIntervalMs = 2500; // 2.5 секунды
    const maxTimeoutMs = 180000;    // 180 секунд timeout
    const startTime = Date.now();

    let isCompleted = false;
    let lastStatus = 'unknown';
    let lastPollData: any = null;

    while (Date.now() - startTime < maxTimeoutMs) {
      try {
        const pollRes = await fetch(`https://api.you.com/v1/research/${taskId}`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-API-Key': ydcApiKey,
          },
        });

        if (!pollRes.ok) {
          const rawPollErrText = await pollRes.text();
          const safePollErrText = sanitizeSecrets(rawPollErrText);
          console.warn(`You.com Research poll HTTP error: ${pollRes.status}`, safePollErrText);
          await new Promise((r) => setTimeout(r, pollingIntervalMs));
          continue;
        }

        const pollData = await pollRes.json();
        lastPollData = pollData;
        const status = (pollData.status || pollData.state || '').toLowerCase();
        if (status) lastStatus = status;

        if (status === 'completed' || status === 'succeeded' || status === 'success') {
          isCompleted = true;
          
          const rawResultObj = pollData.result || pollData.output || pollData.data || pollData;
          
          // Извлекаем или находим сырой контент отчёта
          const candidateContent =
            typeof rawResultObj === 'string'
              ? rawResultObj
              : rawResultObj?.content ||
                rawResultObj?.output ||
                rawResultObj?.text ||
                rawResultObj?.response ||
                rawResultObj?.answer ||
                pollData.output ||
                pollData.result;

          researchReportText = candidateContent;

          const rawSources =
            pollData.sources ||
            rawResultObj?.sources ||
            pollData.citations ||
            rawResultObj?.citations ||
            pollData.references ||
            [];

          if (Array.isArray(rawSources)) {
            researchSources = rawSources.map((s: any) => ({
              title: s.title || s.name || s.url || s.link || 'Источник You.com Research',
              url: s.url || s.link || '',
            })).filter((s) => s.url);
          }

          break;
        } else if (status === 'failed' || status === 'error') {
          const taskErrMsg = sanitizeSecrets(
            pollData.error || pollData.failure_reason || pollData.message || JSON.stringify(pollData)
          );
          console.error(`You.com Research task ${taskId} failed with status: ${status}. Error:`, taskErrMsg);
            throw new Error(`You.com Research task failed (status: ${status}, task_id: ${taskId}): ${taskErrMsg}`);
        } else if (status === 'cancelled') {
          console.error(`You.com Research task ${taskId} was cancelled`);
            throw new Error(`You.com Research task cancelled (status: ${status}, task_id: ${taskId})`);
        }

        // Статусы 'queued', 'running', 'in_progress' — продолжаем опрос
        await new Promise((r) => setTimeout(r, pollingIntervalMs));
      } catch (pollErr: any) {
        const safePollErrMsg = sanitizeSecrets(pollErr?.message || String(pollErr));
        console.error(`Error polling You.com Research task ${taskId}:`, safePollErrMsg);
        await new Promise((r) => setTimeout(r, pollingIntervalMs));
      }
    }

    if (!isCompleted) {
      console.warn(`You.com Research polling timed out after ${maxTimeoutMs}ms for task ${taskId}. Last status: ${lastStatus}`);
      throw new Error(`You.com Research task timeout after 180s (last status: ${lastStatus}, task_id: ${taskId})`);
    }

    const normalizedResearchReport = normalizeResearchReport(researchReportText);

    if (!normalizedResearchReport || normalizedResearchReport.trim().length === 0) {
      const topFields = lastPollData ? Object.keys(lastPollData).join(', ') : 'none';
      const resultFields = lastPollData?.result ? Object.keys(lastPollData.result).join(', ') : 'none';
      console.warn('Research completed but normalized research report was empty. Available fields:', topFields, resultFields);
      // An empty normalized report only proves that the current extraction heuristic did
      // not recognize the content field; it is not proof that the provider returned no
      // result. The reservation is kept active on this ambiguous outcome.
      throw new Error(`Research completed but research report content was missing or empty (available top fields: ${topFields}, result fields: ${resultFields})`);
    }

        return { report: normalizedResearchReport, sources: researchSources };
      });
      researchReportText = researchResult.report;
      researchSources = researchResult.sources;
    }

    const normalizedResearchReport = normalizeResearchReport(researchReportText);

    // 4. Системный промпт эксперта-аналитика ORAKUL AI
    const systemPrompt = `Ты — независимый профессиональный спортивный аналитик мирового уровня и эксперт по вероятностному прогнозированию спортивных событий (ORAKUL AI).

Тебе передан исследовательский отчёт (YOU.COM RESEARCH REPORT) от автономной исследовательской системы You.com Research.

ТВОИ ПРАВИЛА:
1. VERIFIED DATA PACK является основным источником фактов. Остальной текст Research Report — вспомогательный контекст.
2. НЕ ПРИДУМЫВАЙ ФАКТЫ. Не добавляй отсутствующие сведения.
3. При конфликте используй более свежий и более авторитетный источник.
4. Не считай UNCONFIRMED установленным фактом. Не используй старую информацию, если есть более свежая.
4.1. Используй наиболее свежее CONFIRMED состояние; не используй устаревшее состояние игрока как текущее; не превращай UNCONFIRMED в факт; учитывай CONFLICTING только после разрешения конфликта по дате и надёжности источника; если конфликт не удалось разрешить — явно указывай неопределённость; не делай сильный вывод на основании старых H2H без учёта их давности.
4.2. DATA CONSISTENCY RULE: VERIFIED DATA PACK является источником конкретных фактов. Используй именно 5 конкретных матчей из TEAM 1/2 FORM → MATCH 1–5 и конкретные статусы игроков из SQUADS/INJURIES. Не придумывай отсутствующие матчи, результаты, травмы или статусы. Не восстанавливай пропущенные значения по догадке. Если VERIFIED DATA PACK содержит неполные или конфликтующие данные, явно учитывай неопределённость и не представляй её как подтверждённый факт.
5. Не копируй Research Report целиком. Верни только компактный структурированный результат.
6. Проверь подтверждённую дату, команды, турнир и статус матча. Если найденная дата отличается от введённой пользователем — используй подтверждённую дату.
7. Определи реальное преимущество на основе фактов и проведи контранализ (что говорит в пользу противоположной стороны / главные риски).
8. ВЕРОЯТНОСТИ:
   - Числовые вероятности УЖЕ рассчитаны Probability Engine и переданы тебе в user-сообщении (поля "ИТОГОВЫЕ ВЕРОЯТНОСТИ").
   - НЕ пересчитывай и НЕ изменяй эти числа. НЕ предлагай другие вероятности.
   - Верни в JSON ровно те значения team1/draw/team2, которые переданы в user-сообщении.
   - Твоя задача — только сформировать текстовое объяснение (explanation), почему эти вероятности следуют из фактов Research Report.
9. Не показывай пользователю URL, даты источников и технические статусы подтверждения (CONFIRMED/UNCONFIRMED и т.п.).

АНАЛИТИЧЕСКИЙ REASONING FRAMEWORK (ВЫПОЛНЯЙ ВНУТРЕННЕ, ПЕРЕД ФИНАЛЬНЫМ JSON; НЕ ВЫВОДИ ЕГО ПОЛЬЗОВАТЕЛЮ):
10. ГЛАВНЫЙ ИСТОЧНИК ФАКТОВ — VERIFIED DATA PACK. Используй конкретные данные из него, а не собственные знания о командах. Не придумывай отсутствующие матчи, даты, результаты, травмы, дисквалификации, составы, статистику, xG, тактические показатели и источники. Показатель из обычного текста Research (вне VDP) можно использовать только если он явно подтверждён источником и не противоречит VDP.
11. MATCH CONTEXT. Установи фактический контекст: турнир, стадия/тур, группа, дата, место, дом/выезд, турнирная мотивация, положение команд, дни отдыха, плотность календаря, важность. Отсутствующие пункты не реконструируй.
12. RECENT FORM. Используй до 5 последних подтверждённых завершённых официальных матчей каждой команды. Для каждого учитывай: дату, соревнование, соперника, дом/выезд, счёт, результат, забитые, пропущенные, качество соперника. Затем вычисли wins/draws/losses, goalsFor/goalsAgainst, goalDifference, resultSequence. Обязательно: wins+draws+losses = количеству реально подтверждённых матчей. Не заявляй «5 матчей», если подтверждено 4; недостающие не придумывай. Если матч завершился серией пенальти — учитывай результат основного/дополнительного времени как W/D/L, а PENALTY SHOOTOUT — только как дополнительное пояснение; не превращай победу по пенальти в обычный W без оговорки.
12.1. When describing recent form or any sequence of matches, use MATCH 1–5 as the only source of truth and verify the exact order before making the statement. Never describe the last N matches as wins/draws/losses unless that exact sequence is directly supported by MATCH 1–5. Do not paraphrase or approximate the match sequence.
12.2. Any quantitative or logical statement about recent form (for example: "last 4 matches without a win", "won 3 of the last 5", "unbeaten in 4") must be directly verified against MATCH 1–5 before being included. If the statement cannot be derived exactly from MATCH 1–5, do not make it.
13. QUALITY OF OPPOSITION. Не считай все победы равноценными. Учитывай силу соперника (сильный/средний/слабый), уровень турнира и стадию, если это определяется из Research. Победа над сильным соперником весомее крупной победы над слабым. Рейтинг силы без данных не выдумывай.
14. HOME/AWAY. Отдельно оцени домашнюю форму хозяев, выездную гостей, влияние стадиона и результаты в аналогичных условиях. Не считай домашнее поле автоматическим доказательством победы.
15. ATTACK. Оцени забитые голы, среднюю результативность, матчи без голов, крупные победы, стабильность создания моментов, ключевых атакующих игроков и доступность нападающих. Используй xG/shots/shots on target/big chances/conversion, только если они есть в Research; иначе не придумывай.
16. DEFENCE. Оцени пропущенные голы, clean sheets, матчи с несколькими пропущенными, стабильность обороны, доступность защитников, наличие основного вратаря, подтверждённые кадровые потери. xGA и другие defensive metrics — только если есть в Research.
17. SQUAD/INJURIES/SUSPENSIONS. Анализируй по конкретным игрокам (PLAYER, POSITION, STATUS, REASON, DATE, SOURCE, CONFIDENCE, STATUS_TYPE). Различай CONFIRMED_OUT, WITHDRAWN, SUSPENDED, QUESTIONABLE, CONFIRMED_AVAILABLE. Не превращай QUESTIONABLE в CONFIRMED_OUT. Оценивай функциональную значимость отсутствующих (основной нападающий, вратарь, центральный защитник, ключевой полузащитник, ротация). Учитывай подтверждённую замену.
18. COACH/TACTICAL CONTEXT. Учитывай тренера, недавнюю смену, смену системы, стиль, прессинг, переходы, владение, стандарты, слабые места соперника — только если есть в Research. При недавней смене тренера учитывай неопределённость сыгранности. Не утверждай тактическую схему как факт без подтверждения.
19. H2H. Используй как дополнительный, а не главный фактор. Учитывай дату, свежесть, соревнование, место, актуальность составов. Старые матчи — с меньшим весом, особенно при смене тренеров/составов. Не делай вывод о текущей силе только по старому H2H.
20. TEMPORAL WEIGHTING. При конфликте приоритет: свежая подтверждённая информация → официальный источник → качественный источник → более старые данные. Не используй устаревший статус при наличии более свежего подтверждённого.
21. SOURCE QUALITY. При конфликте приоритет: UEFA/FIFA → официальная федерация → официальный клуб/турнир → Reuters/AP/BBC/Sky и крупные СМИ → качественные статистические базы → остальные.
22. CONFLICT DETECTION. При конфликте (например, PLAYER: AVAILABLE и PLAYER: INJURED) проверяй дату, источник, свежесть, CONFIDENCE. Если не разрешимо — учитывай неопределённость, не превращай конфликт в подтверждённый факт.
23. MATCH SCENARIO ANALYSIS. Внутренне построй сценарии: A — условия победы команды 1; B — условия ничьей; C — условия победы команды 2. Определи, какие лучше поддержаны фактами. Пользователю сценарии не выводи — используй их для вероятностей.
24. CROSS-CHECK. Перед вероятностями проверь: подтверждён ли матч; есть ли до 5 конкретных матчей у каждой команды; совпадают ли W/D/L с матчами; совпадают ли goalsFor/Against с матчами; есть ли конкретные кадровые потери; нет ли устаревших/конфликтующих данных; не основан ли вывод на старом H2H; не использована ли неподтверждённая статистика; не переоценено ли домашнее поле или один фактор. При проблеме — снижай уверенность.
25. PROBABILITY CALCULATION. Вероятности — результат совокупной оценки: recent form, strength of opposition, home/away, attack, defence, squad/injuries/suspensions, coaching/tactics, tournament context, H2H, свежесть информации, неопределённость. Не назначай по имени фаворита. Не используй букмекерские коэффициенты и чужие прогнозы. При недостатке данных увеличивай неопределённость. team1+draw+team2=100.
26. ANTI-HALLUCINATION. Не заполняй пробелы догадкой. Не пиши «вероятно игрок травмирован», если Research не подтверждает; «команда имеет 5 побед», если подтверждено 4; «не играла 6 месяцев», если даты не подтверждают. Не придумывай даты, счёты, травмы, дисквалификации, xG, статистику, составы, тренеров, тактику. Неподтверждённый факт не используй как факт.
27. INTERNAL DEPTH / EXTERNAL BREVITY. Внутренний анализ максимально глубокий и использует всю релевантную информацию Research. Финальный JSON — предельно компактный (overview ≤ 220, team1Form ≤ 180, team2Form ≤ 180, h2h ≤ 160, squadAndInjuries ≤ 220, ровно 3 factors ≤ 130 каждый, usedSources ≤ 5). Сначала анализируй внутренне, затем выбери самые значимые факторы. КРАТКОСТЬ ВАЖНЕЕ ДЕТАЛИЗАЦИИ: если информации слишком много — сокращай формулировки, а не обрывай JSON.
28. FACT → IMPACT. Каждый фактор — связка «факт → влияние на матч» с подтверждённым фактом (например: «Португалия выиграла 3 из 5 последних официальных матчей; стабильная форма повышает её базовую оценку.»), а не голый факт или бездоказательное «команда сильнее».
29. FINAL SELF-CHECK. Перед JSON проверь: использованы ли реальные данные Research; не придуманы ли отсутствующие; учтена ли свежесть; учтены ли составы/травмы; учтено ли качество соперников; учтён ли дом/выезд; не переоценён ли H2H; не основан ли вывод на одном факторе; следуют ли вероятности из совокупности данных; полностью ли закрыт JSON и соответствует ли контракту. Только после этого формируй JSON.

## ВНУТРЕННЯЯ ПРОВЕРКА VERIFIED DATA PACK ПЕРЕД ФИНАЛЬНЫМ JSON

Перед формированием финального JSON выполни внутреннюю проверку всех релевантных фактов из полного VERIFIED DATA PACK. Эта проверка выполняется ВНУТРИ модели и НЕ должна попадать в финальный ответ.

### 1. SOURCE OF TRUTH
VERIFIED DATA PACK является главным источником конкретных фактов. Не используй собственные знания модели для заполнения отсутствующих данных. Если факт отсутствует в VERIFIED DATA PACK — не придумывай его.

### 2. ПРОВЕРКА ПОСЛЕДНИХ МАТЧЕЙ
Для каждой команды отдельно проверь: какие конкретно матчи присутствуют в MATCH 1–5; дату каждого матча; соперника; счёт; результат; количество найденных матчей; GF; GA; GD; последовательность W/D/L. Если фактически подтверждено только 4 матча — НЕ называй их 5 матчами. Если последовательность содержит 4 результата — НЕ дополняй её пятым результатом по догадке. FORM SUMMARY нельзя считать более надёжным, чем конкретные MATCH 1–5. Если summary противоречит конкретным матчам, приоритет имеют конкретные матчи. Перед использованием формы проверь: wins + draws + losses = количество фактически подтверждённых матчей и длина resultSequence = количество фактически подтверждённых матчей.

### 3. ПРОВЕРКА СОСТАВОВ И ТРАВМ
Для каждого важного игрока учитывай временную последовательность: INITIAL SQUAD → INJURY/DOUBT → WITHDRAWAL → FINAL STATUS. Если для одного игрока есть несколько статусов, используй самый свежий подтверждённый статус. Не называй игрока выбывшим, если более поздний источник подтверждает его доступность. Не называй игрока доступным, если более поздний подтверждённый источник сообщает о withdrawal/injury/suspension. Если статус не подтверждён — не представляй его как факт.

### 4. КОНФЛИКТЫ
Если два источника противоречат друг другу: 1) предпочитай более свежую информацию; 2) при одинаковой свежести предпочитай источник более высокого приоритета; 3) учитывай официальные источники выше вторичных; 4) если конфликт невозможно разрешить — считай факт неопределённым и НЕ используй его как подтверждённый аргумент. Не смешивай две разные версии одного факта.

### 5. ВРЕМЕННАЯ АКТУАЛЬНОСТЬ
Для текущего матча более свежие данные имеют больший вес. Особенно это относится к: травмам; withdrawals; suspensions; составам; тренерам; последним матчам; турнирному статусу. Старый факт не должен заменять более новый подтверждённый факт.

### 6. ПРОВЕРКА КАЧЕСТВА СОПЕРНИКОВ
При анализе формы учитывай не только W/D/L и голы, но и силу соперников, ЕСЛИ такая информация есть в VERIFIED DATA PACK. Не делай вывод, что одинаковые 3W-1D-1L автоматически означают одинаковый уровень формы. Победы/поражения против сильных и слабых соперников должны учитываться по-разному. Если данных о силе соперника нет — не придумывай рейтинг или оценку силы.

### 7. ПРОВЕРКА ДОМАШНЕГО/ВЫЕЗДНОГО ФАКТОРА
Если VERIFIED DATA PACK содержит домашнюю/выездную статистику — учитывай её. Если такой статистики нет — не придумывай её.

### 8. ПРОВЕРКА АТАКИ И ОБОРОНЫ
Если доступны подтверждённые данные о голах; пропущенных голах; xG; xGA; ударах; ударах в створ; созданных моментах; clean sheets — используй их в анализе. Если конкретной метрики нет — не восстанавливай её по собственным знаниям.

### 9. H2H
H2H используй только после проверки: даты; актуальности; количества найденных встреч; тренеров/составов при необходимости. Старые H2H не должны иметь тот же вес, что свежая форма и текущие составы. Не используй старый H2H как основной аргумент только потому, что он легко доступен.

### 10. СВЯЗЬ ФАКТА С ВЫВОДОМ
Каждый из трёх финальных факторов должен быть следствием конкретного подтверждённого факта из VERIFIED DATA PACK. Внутренне проверь: FACT → IMPACT → EFFECT ON MATCH. Если невозможно указать конкретный факт, фактор не используй.

### 11. ПРОВЕРКА ВЕРОЯТНОСТЕЙ
Перед финальным JSON повторно проверь, что вероятности являются результатом совокупности подтверждённых факторов: форма; сила соперников; атака; оборона; состав; травмы; домашнее/выездное положение; тренеры; H2H; свежесть информации; неопределённость. Не выбирай вероятности только потому, что одна команда выглядит сильнее по общему впечатлению. Не используй букмекерские коэффициенты или внешние прогнозы. Вероятности должны суммироваться ровно в 100.

### 12. ФИНАЛЬНАЯ SELF-CHECK ПЕРЕД ВЫВОДОМ
Перед отправкой JSON молча проверь:
A. Все факты взяты из VERIFIED DATA PACK.
B. Ни один отсутствующий факт не был придуман.
C. Количество матчей соответствует реально подтверждённым MATCH 1–5.
D. W/D/L соответствует конкретным матчам.
E. GF/GA соответствует конкретным счетам.
F. Статусы игроков соответствуют самому свежему подтверждённому статусу.
G. Конфликты источников разрешены по свежести и приоритету.
H. Старый H2H не получил чрезмерный вес.
I. Каждый финальный фактор имеет конкретную фактическую основу.
J. Вероятности логически согласуются с совокупностью фактов и дают ровно 100.
K. Финальный JSON соответствует существующему контракту.

### ВАЖНО
Вся эта проверка является ВНУТРЕННИМ reasoning. НЕ выводи reasoning, промежуточные расчёты, таблицы проверки или дополнительные поля. Пользователь должен получить только существующий короткий JSON. Не увеличивай лимиты длины существующих полей. Не меняй существующие ограничения: overview ≤ 220; team1Form ≤ 180; team2Form ≤ 180; h2h ≤ 160; squadAndInjuries ≤ 220; factors — ровно 3, каждый ≤ 130; usedSources ≤ 5. Не меняй JSON contract.

ФОРМАТ ОТВЕТА — СТРОГО ОДИН JSON-ОБЪЕКТ БЕЗ ЛИШНЕГО ТЕКСТА, БЕЗ MARKDOWN, БЕЗ КОДОВЫХ БЛОКОВ:

{
  "status": "success",
  "match": "Норвегия — Дания",
  "probabilities": {
    "team1": 45,
    "draw": 28,
    "team2": 27
  },
  "usedSources": [
    "источник 1",
    "источник 2"
  ],
  "explanation": {
    "overview": "Краткий итог анализа",
    "team1Form": "Форма первой команды",
    "team2Form": "Форма второй команды",
    "h2h": "Очные встречи",
    "squadAndInjuries": "Составы, травмы и доступность игроков",
    "factors": [
      "Ключевой фактор 1",
      "Ключевой фактор 2",
      "Ключевой фактор 3"
    ]
  }
}

ОБЯЗАТЕЛЬНЫЕ ТРЕБОВАНИЯ К ОТВЕТУ:
- "status" всегда строка "success" при успешном анализе.
- "match" — строка с названием анализируемого матча.
- "probabilities.team1", "probabilities.draw", "probabilities.team2" — ЧИСЛА (проценты), их сумма ровно 100. Это ровно те значения, которые переданы в user-сообщении (ИТОГОВЫЕ ВЕРОЯТНОСТИ). Не изменяй их.
- "usedSources" — массив строк с реальными источниками из Research Report.
- "explanation" обязательно должен быть заполнен.
- "explanation.overview", "explanation.team1Form", "explanation.team2Form", "explanation.h2h", "explanation.squadAndInjuries" — непустые строки.
- "explanation.factors" — массив строк с конкретными факторами.
- Никаких других верхнеуровневых полей.
- Не используй поля "prediction", "analytical_conclusion", "team_form" вместо требуемых.
- Не возвращай Markdown и не оборачивай JSON в \`\`\`json.

ЖЁСТКИЕ ОГРАНИЧЕНИЯ ПО ДЛИНЕ (кратко, конкретно, без повторения Research Report):
- "explanation.overview" — максимум 220 символов.
- "explanation.team1Form" — максимум 180 символов.
- "explanation.team2Form" — максимум 180 символов.
- "explanation.h2h" — максимум 160 символов.
- "explanation.squadAndInjuries" — максимум 220 символов.
- "explanation.factors" — РОВНО 3 фактора, каждый максимум 130 символов, одной короткой законченной строкой.
- "usedSources" — максимум 5 источников, только короткие названия источников.

ПРАВИЛО ФАКТОРОВ:
Каждый фактор должен содержать связку «факт → влияние на матч». Пример: «Домашнее поле и более сильная текущая форма дают Португалии дополнительное преимущество.» Не пиши голый факт без влияния (например, «Португалия играет дома.»).

КРИТИЧЕСКИ ВАЖНО ПРАВИЛО JSON:
Перед завершением ответа обязательно проверь, что JSON полностью закрыт.
Ответ должен закончиться закрывающими ] и }.
Никогда не обрывай строку посередине.
Никогда не добавляй текст после JSON.
Никаких дополнительных пояснений вне JSON.
Никаких Markdown-блоков и комментариев.
Верни только один валидный JSON-объект, закрытый полностью, включая все ] и }.
КРАТКОСТЬ ВАЖНЕЕ ДЕТАЛИЗАЦИИ. Вся глубокая аналитическая обработка выполняется ВНУТРИ модели, но наружный JSON должен быть предельно компактным. Если информации слишком много — сокращай формулировки, а не обрывай JSON.`;

    const truncatedResearchReport = truncateResearchReport(normalizedResearchReport, MAX_RESEARCH_CHARS);

    const vdpText = extractVDP(normalizedResearchReport);
    console.log('[ORAKUL DIAGNOSTIC] VDP extraction:', JSON.stringify({
      hasVDP: vdpText.length > 0,
      vdpLength: vdpText.length,
      vdpFirst200: vdpText.slice(0, 200),
    }));

    if (!vdpText || vdpText.trim().length === 0) {
      console.error('[ORAKUL] VERIFIED DATA PACK not found in research report. Aborting analysis.');
      if (freeGenReservationId) {
        const releaseResult = await releaseFreeGeneration(freeGenReservationId);
        if (!releaseResult.released) {
          console.error(`[ORAKUL] free generation reservation NOT released: reservationId=${freeGenReservationId} reason=${releaseResult.reason}`);
        }
        freeGenReservationId = null;
      }
      if (creditSpendReservationId) {
        await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
        creditSpendReservationId = null;
      }
      return NextResponse.json(
        { error: 'VERIFIED DATA PACK не найден в отчёте исследования. Анализ невозможно.' },
        { status: 422 }
      );
    }

    const parsedVDP = parseVDP(vdpText);
    console.log('[ORAKUL DIAGNOSTIC] ParsedVDP:', JSON.stringify({
      team1Name: parsedVDP.team1.teamName,
      team1Matches: parsedVDP.team1.matches.length,
      team2Name: parsedVDP.team2.teamName,
      team2Matches: parsedVDP.team2.matches.length,
      h2hCount: parsedVDP.h2h.length,
    }));

    // Guard: жёстко блокируется только VDP без идентифицированных команд.
    // Расхождение названий (кириллица/латиница, суффиксы, формат) — диагностика,
    // а не отказ: иначе анализ ломается на корректных матчах.
    const matchVerification = verifyMatchTeams(
      trimmedMatch,
      parsedVDP.team1.teamName,
      parsedVDP.team2.teamName,
    );
    if (!matchVerification.ok && matchVerification.reason !== 'teams_mismatch') {
      console.error(`[ORAKUL] Match verification failed (${matchVerification.reason}). Aborting before probability calculation.`);
      if (freeGenReservationId) {
        await releaseFreeGeneration(freeGenReservationId);
        freeGenReservationId = null;
      }
      if (creditSpendReservationId) {
        await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
        creditSpendReservationId = null;
      }
      return NextResponse.json({ error: MATCH_UNVERIFIED_ERROR }, { status: 422 });
    }

    const hasSufficientVDP =
      !!parsedVDP.team1.teamName &&
      !!parsedVDP.team2.teamName &&
      (parsedVDP.team1.matches.length > 0 ||
        parsedVDP.team2.matches.length > 0 ||
        parsedVDP.h2h.length > 0);

    if (!hasSufficientVDP) {
      console.error('[ORAKUL] VERIFIED DATA PACK is empty/invalid: insufficient data for probability calculation.');
      if (freeGenReservationId) {
        const releaseResult = await releaseFreeGeneration(freeGenReservationId);
        if (!releaseResult.released) {
          console.error(`[ORAKUL] free generation reservation NOT released: reservationId=${freeGenReservationId} reason=${releaseResult.reason}`);
        }
        freeGenReservationId = null;
      }
      if (creditSpendReservationId) {
        await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
        creditSpendReservationId = null;
      }
      return NextResponse.json(
        { error: 'VERIFIED DATA PACK невалиден: недостаточно данных для расчёта вероятностей.' },
        { status: 422 }
      );
    }

    // STEP 18: Engine Bridge — подтверждённый DataPack.form заполняет ТОЛЬКО
    // реально отсутствующие матчи команд. Валидный ParsedVDP всегда приоритетен;
    // H2H и opponentStrength/venue не синтезируются. Engine не изменяется.
    const mergedVDP = mergeEngineInput(parsedVDP, dalDataPack);
    console.log('[ORAKUL DIAGNOSTIC] Engine bridge:', JSON.stringify({
      t1Before: parsedVDP.team1.matches.length,
      t1After: mergedVDP.team1.matches.length,
      t2Before: parsedVDP.team2.matches.length,
      t2After: mergedVDP.team2.matches.length,
      h2h: mergedVDP.h2h.length,
    }));

    const generatedAt = new Date().toISOString();
    const engineComputation = calculateProbabilitiesWithTrace(mergedVDP);
    const engineProbabilities = engineComputation.result;
    console.log('[ORAKUL DIAGNOSTIC] Probability Engine:', `team1=${engineProbabilities.team1} draw=${engineProbabilities.draw} team2=${engineProbabilities.team2}`);
    console.log('[ProbabilityEngineTrace]', JSON.stringify(engineComputation.trace));

    persistGoldRecord({
      id: crypto.randomUUID(),
      generatedAt,
      preMatchDataCutoff: generatedAt,
      team1: mergedVDP.team1.teamName,
      team2: mergedVDP.team2.teamName,
      matchDate: null,
      competition: null,
      preMatch: mergedVDP,
      engineOutput: {
        probabilities: engineProbabilities,
        trace: engineComputation.trace,
      },
      actual: null,
    });

    const goalDistribution = calculateGoalDistribution(buildGoalDistributionInput(mergedVDP));
    console.log('[ORAKUL DIAGNOSTIC] Goal Distribution:', `lambda1=${goalDistribution.lambda1} lambda2=${goalDistribution.lambda2} residual=${goalDistribution.diagnostics.residual}`);
    if (goalDistribution.diagnostics.usedFallbacks.length > 0) {
      console.log('[ORAKUL DIAGNOSTIC] Goal Distribution:', `usedFallbacks=${JSON.stringify(goalDistribution.diagnostics.usedFallbacks)}`);
    }
    console.log('[ORAKUL DIAGNOSTIC] Goal Distribution markets:', JSON.stringify({
      result: goalDistribution.markets.result,
      doubleChance: goalDistribution.markets.doubleChance,
      totals: goalDistribution.markets.totals,
      btts: goalDistribution.markets.btts,
      teamScoring: goalDistribution.markets.teamScoring,
    }));

    const goalDistributionForLlm = {
      lambda1: goalDistribution.lambda1,
      lambda2: goalDistribution.lambda2,
      markets: {
        result: goalDistribution.markets.result,
        doubleChance: goalDistribution.markets.doubleChance,
        totals: goalDistribution.markets.totals,
        btts: goalDistribution.markets.btts,
        teamScoring: goalDistribution.markets.teamScoring,
      },
    };

    const userPrompt = `Матч для анализа: "${trimmedMatch}"

YOU.COM RESEARCH REPORT:
${truncatedResearchReport}

ИТОГОВЫЕ ВЕРОЯТНОСТИ (рассчитаны Probability Engine — единственный источник числовых вероятностей):
* team1: ${engineProbabilities.team1}%
* draw: ${engineProbabilities.draw}%
* team2: ${engineProbabilities.team2}%

Эти числа уже рассчитаны Probability Engine и являются окончательными. Ты НЕ должен пересчитывать, изменять или предлагать другие вероятности. Используй эти числа только для формирования текстового объяснения (explanation) — объясни, почему именно такие вероятности следуют из фактов Research Report. В итоговом JSON верни ровно эти числа в полях "probabilities.team1", "probabilities.draw", "probabilities.team2".

GOAL DISTRIBUTION (рассчитано production engine):
${JSON.stringify(goalDistributionForLlm)}

Значения Goal Distribution рассчитаны production engine и являются authoritative numerical inputs. Не пересчитывай, не изменяй и не заменяй lambda, score probabilities или derived markets. Используй их только для объяснения анализа. Не вычисляй новые числовые прогнозы и не подменяй ими authoritative 1X2 probabilities.`;

    // DIAGNOSTIC: размеры payload перед отправкой в KeyDealer (без секретов)
    const diagnosticPayload = JSON.stringify({
      model: 'sonnet-4-6',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
    });
    console.log('[ORAKUL DIAGNOSTIC] LLM request sizes:', JSON.stringify({
      model: 'sonnet-4-6',
      keydealerUrl: 'https://api.keydealer.ru/v1/chat/completions',
      normalizedResearchReportLength: normalizedResearchReport.length,
      truncatedResearchReportLength: truncatedResearchReport.length,
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt.length,
      messagesPayloadChars: diagnosticPayload.length,
    }));

    let rawParsed: any;
    let parsedAfterRetry = false;
    for (let llmAttempt = 0; llmAttempt < 2; llmAttempt += 1) {
      let chatRes: Response;
      try {
        chatRes = await fetch('https://api.keydealer.ru/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${keydealerApiKey}`,
          },
          body: JSON.stringify({
            model: 'sonnet-4-6',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.1,
          }),
        });
      } catch (networkError: any) {
        const safeLLMErr = JSON.stringify({
          message: String(networkError?.message || networkError),
          name: String(networkError?.name || 'Error'),
        });
        console.error('KeyDealer LLM fetch network error:', safeLLMErr);
        if (freeGenReservationId) {
          const releaseResult = await releaseFreeGeneration(freeGenReservationId);
          if (!releaseResult.released) {
            console.error(`[ORAKUL] free generation reservation NOT released: reservationId=${freeGenReservationId} reason=${releaseResult.reason}`);
          }
          freeGenReservationId = null;
        }
        if (creditSpendReservationId) {
          await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
          creditSpendReservationId = null;
        }
        return NextResponse.json(
          { error: `LLM API connection error: ${safeLLMErr}` },
          { status: 502 }
        );
      }

      if (!chatRes.ok) {
        const errBody = await chatRes.text();
        const safeErrBody = sanitizeSecrets(errBody);
        console.error(`KeyDealer LLM HTTP error: ${chatRes.status}`, safeErrBody);
        console.log('[ORAKUL DIAGNOSTIC] LLM response error:', JSON.stringify({
          httpStatus: chatRes.status,
          responseBodyFirst500Chars: safeErrBody.slice(0, 500),
        }));
        if (freeGenReservationId) {
          const releaseResult = await releaseFreeGeneration(freeGenReservationId);
          if (!releaseResult.released) {
            console.error(`[ORAKUL] free generation reservation NOT released: reservationId=${freeGenReservationId} reason=${releaseResult.reason}`);
          }
          freeGenReservationId = null;
        }
        if (creditSpendReservationId) {
          await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
          creditSpendReservationId = null;
        }
        return NextResponse.json(
          { error: `LLM API error: HTTP ${chatRes.status} — ${safeErrBody}` },
          { status: 502 }
        );
      }

      const chatData = await chatRes.json();
      const rawContent = chatData?.choices?.[0]?.message?.content || '';
      const cleanedJson = String(rawContent)
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();

      console.log('[ORAKUL DIAGNOSTIC] pre-parse LLM response:', JSON.stringify({
        model: 'sonnet-4-6',
        httpStatus: chatRes.status,
        rawContentLength: String(rawContent).length,
        cleanedJsonLength: cleanedJson.length,
      }));

      try {
        rawParsed = JSON.parse(cleanedJson);
        parsedAfterRetry = llmAttempt === 1;
        break;
      } catch (parseError: any) {
        console.error('JSON parse error from LLM:', parseError);
        console.log('[ORAKUL DIAGNOSTIC] JSON.parse error:', JSON.stringify({
          model: 'sonnet-4-6',
          httpStatus: chatRes.status,
          rawContentLength: String(rawContent).length,
          parseErrorMessage: parseError?.message || String(parseError),
        }));

        if (llmAttempt === 0 && String(rawContent).length > 0 && cleanedJson.length > 0) {
          console.log('[LLM] JSON parse failed, retrying once');
          continue;
        }

        if (llmAttempt === 1) {
          console.log('[LLM] JSON retry failed');
        }
      if (freeGenReservationId) {
        const releaseResult = await releaseFreeGeneration(freeGenReservationId);
        if (!releaseResult.released) {
          console.error(`[ORAKUL] free generation reservation NOT released: reservationId=${freeGenReservationId} reason=${releaseResult.reason}`);
        }
        freeGenReservationId = null;
      }
      if (creditSpendReservationId) {
        await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
        creditSpendReservationId = null;
      }
      return NextResponse.json(
        { error: 'LLM response was not valid JSON.' },
        { status: 502 }
      );
    }
  }

  if (parsedAfterRetry) {
    console.log('[LLM] JSON retry succeeded');
  }

  const contract = buildAnalysisContract(rawParsed);
  if (!contract) {
    console.log('[ORAKUL DIAGNOSTIC] LLM returned non-object payload:', JSON.stringify(String(rawParsed).slice(0, 300)));
    if (freeGenReservationId) {
      const releaseResult = await releaseFreeGeneration(freeGenReservationId);
      if (!releaseResult.released) {
        console.error(`[ORAKUL] free generation reservation NOT released: reservationId=${freeGenReservationId} reason=${releaseResult.reason}`);
      }
      freeGenReservationId = null;
    }
    if (creditSpendReservationId) {
      await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
      creditSpendReservationId = null;
    }
    return NextResponse.json(
      { error: 'LLM response had an unexpected structure.' },
      { status: 502 }
    );
  }

    // Если LLM не вернул match (или вернул пустую строку) — используем исходный пользовательский запрос.
    contract.match = contract.match || trimmedMatch;

    const llmProbabilities = extractProbabilities(contract);
    if (llmProbabilities) {
      console.log('[ORAKUL DIAGNOSTIC] LLM Contract probabilities:', `team1=${llmProbabilities.team1} draw=${llmProbabilities.draw} team2=${llmProbabilities.team2}`);
    } else {
      console.log('[ORAKUL DIAGNOSTIC] LLM Contract probabilities: INVALID');
    }
    console.log('[ORAKUL DIAGNOSTIC] Engine vs LLM:', `engine=${engineProbabilities.team1}/${engineProbabilities.draw}/${engineProbabilities.team2} llm=${llmProbabilities ? `${llmProbabilities.team1}/${llmProbabilities.draw}/${llmProbabilities.team2}` : 'INVALID'} match=${llmProbabilities !== null && llmProbabilities.team1 === engineProbabilities.team1 && llmProbabilities.draw === engineProbabilities.draw && llmProbabilities.team2 === engineProbabilities.team2}`);

    // A1: Probability Engine — единственный источник числовых вероятностей.
    // LLM отвечает только за текстовый анализ; числовые вероятности всегда берём из engineProbabilities.
    contract.probabilities = {
      team1: engineProbabilities.team1,
      draw: engineProbabilities.draw,
      team2: engineProbabilities.team2,
    };
    console.log('[ORAKUL DIAGNOSTIC] A1 final probabilities:', `team1=${contract.probabilities.team1} draw=${contract.probabilities.draw} team2=${contract.probabilities.team2}`);
    console.log('[ORAKUL DIAGNOSTIC] A1 vs Engine:', `engine=${engineProbabilities.team1}/${engineProbabilities.draw}/${engineProbabilities.team2} a1=${contract.probabilities.team1}/${contract.probabilities.draw}/${contract.probabilities.team2} match=${contract.probabilities.team1 === engineProbabilities.team1 && contract.probabilities.draw === engineProbabilities.draw && contract.probabilities.team2 === engineProbabilities.team2}`);

    const validationError = validateAnalysisContract(contract);
    if (validationError) {
      console.log('[ORAKUL DIAGNOSTIC] LLM contract validation failed:', JSON.stringify({
        reason: validationError,
        topLevelKeys: isRecord(rawParsed) ? Object.keys(rawParsed).join(', ') : 'n/a',
        hasStatus: isRecord(rawParsed) ? String(rawParsed.status) : 'n/a',
      }));
      if (freeGenReservationId) {
        const releaseResult = await releaseFreeGeneration(freeGenReservationId);
        if (!releaseResult.released) {
          console.error(`[ORAKUL] free generation reservation NOT released: reservationId=${freeGenReservationId} reason=${releaseResult.reason}`);
        }
        freeGenReservationId = null;
      }
      if (creditSpendReservationId) {
        await releaseCreditSpend(createServiceRoleClient(), creditSpendReservationId, creditSpendIdemKey);
        creditSpendReservationId = null;
      }
      return NextResponse.json(
        { error: `LLM response failed validation: ${validationError}` },
        { status: 502 }
      );
    }

    const response = adaptAnalysisContractToResponse(contract, trimmedMatch, researchSources, goalDistribution);
    const publicProbabilities = response.probabilities.outcomes.map((outcome: { value: string }) => toProbabilityNumber(outcome.value));
    console.log('[ORAKUL DIAGNOSTIC] Public Response probabilities:', `team1=${publicProbabilities[0]} draw=${publicProbabilities[1]} team2=${publicProbabilities[2]}`);

    if (creditSpendReservationId) {
      const adminClient = createServiceRoleClient();
      const consumeRes = await consumeCreditSpend(adminClient, creditSpendReservationId, creditSpendIdemKey);
      if (!consumeRes.success) {
        console.error('[ORAKUL] CRITICAL: consumeCreditSpend failed after success. Reservation left unconsumed. id=', creditSpendReservationId);
        return NextResponse.json(
          { error: 'Internal accounting error. The result was not delivered to avoid unaccounted credit spend.' },
          { status: 500 }
        );
      }

      // History is an additional feature, never a reason to re-charge or to withhold a
      // result that has already been paid for. A failure here is logged and ignored.
      if (authedUserId) {
        const historyIdemKey =
          creditSpendIdemKey ?? `analysis:${authedUserId}:res:${creditSpendReservationId}`;
        try {
          const saved = await savePrediction(adminClient, {
            userId: authedUserId,
            sport: 'football',
            matchTitle: response.match.title,
            payload: response as unknown as Record<string, unknown>,
            idempotencyKey: historyIdemKey,
          });
          if (!saved.ok) {
            console.error('[ORAKUL] prediction history NOT saved:', {
              status: saved.status,
              error: saved.error,
            });
          }
        } catch (historyErr: any) {
          console.error('[ORAKUL] prediction history NOT saved (unexpected error):', {
            message: historyErr?.message ? String(historyErr.message) : 'unknown',
          });
        }
      }

      creditSpendReservationId = null;
      return NextResponse.json(response);
    }

    // free anon path
    if (freeGenReservationId) {
      const consumeResult = await consumeFreeGeneration(freeGenReservationId);
      if (!consumeResult.success) {
        console.error('[ORAKUL] CRITICAL: consumeFreeGeneration failed after successful final response. Reservation left unconsumed to prevent double-use. reservationId:', freeGenReservationId);
        return NextResponse.json(
          { error: 'Internal accounting error. The result was not delivered to avoid unaccounted free generation.' },
          { status: 500 }
        );
      }
      freeGenReservationId = null;
    }
    return NextResponse.json(response);
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (msg.includes('ANON_SESSION_SECRET is not configured')) {
      console.error('[ORAKUL] ANON_SESSION_SECRET not configured');
      return NextResponse.json(
        { error: 'Service unavailable. Please try again later.' },
        { status: 503 },
      );
    }
    const safeErrorMsg = sanitizeSecrets(msg);
    console.error('Unhandled error in /api/analyze:', safeErrorMsg);
    return NextResponse.json(
      { error: `Unhandled server error: ${safeErrorMsg}` },
      { status: 500 }
    );
  }
}
