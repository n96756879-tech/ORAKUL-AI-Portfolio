import type { ParsedVDP, ParsedTeam } from "./vdp-parser";

export type ProbabilityResult = {
  team1: number;
  draw: number;
  team2: number;
};

export type EngineVenue = "HOME" | "AWAY" | "NEUTRAL" | "UNKNOWN";

// D-30: компактная observability-трассировка Probability Engine.
// Содержит фактически использованные inputs и промежуточные значения, чтобы
// можно было вручную пересчитать rawTeam1/rawTeam2 и нормализацию.
// НЕ влияет на расчёт: формулы, веса, clamp и fallback не меняются.
export type EngineTeamTrace = {
  teamName: string | null;
  matchesUsed: number;
  knownResults: { wins: number; draws: number; losses: number; denominator: number };
  goalInput: { goalsFor: number; goalsAgainst: number; goalDifference: number; avgGoalDifference: number };
  opponentStrengthInput: { matchesWithStrength: number };
  currentVenue: EngineVenue;
};

export type EngineDrawTrace = {
  base: number;
  totalMatches: number;
  drawRate: number | null;
  drawRateContribution: number;
  formDiff: number;
  formDiffContribution: number;
  h2hDrawRate: number | null;
  h2hDrawContribution: number;
  drawPct: number;
};

export type ProbabilityEngineTrace = {
  input: {
    team1: EngineTeamTrace;
    team2: EngineTeamTrace;
    h2h: { count: number; team1Wins: number; team2Wins: number; draws: number; h2hScore: number };
    currentVenue: EngineVenue;
  };
  components: {
    formScore: { team1: number; team2: number };
    goalScore: { team1: number; team2: number };
    opponentStrengthAdjustment: { team1: number; team2: number };
    h2hScore: number;
    venueAdjustment: number;
    weights: typeof WEIGHTS;
  };
  draw: EngineDrawTrace;
  raw: { team1: number; team2: number; draw: number; total: number };
  normalized: {
    exact: { team1: number; draw: number; team2: number };
    final: ProbabilityResult;
  };
};

// Веса факторов. Сумма не обязана быть 1 — нормализация выполняется позже.
// recentForm — основной фактор: текущая форма команды важнее всего.
// goals — второй по важности: разница голов отражает реальную силу.
// opponentStrength — корректировка формы с учётом силы соперников.
// h2h — небольшой вес: история встреч полезна, но не доминирует.
// venue — умеренный фактор: домашнее преимущество существует, но не решающее.
const WEIGHTS = {
  recentForm: 0.35,
  goals: 0.25,
  opponentStrength: 0.15,
  h2h: 0.10,
  venue: 0.15,
} as const;

// Базовая вероятность ничьей (в процентах). Корректируется факторами ниже.
const BASE_DRAW_PCT = 28;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

// Очки за форму: W=3, D=1, L=0. Нормализуется в [0,1].
// UNKNOWN-результаты исключаются из знаменателя: они не должны разбавлять форму.
export function formScore(team: ParsedTeam): number {
  const knownMatches = team.matches.filter(
    (m) => m.result === "W" || m.result === "D" || m.result === "L"
  );
  if (knownMatches.length === 0) return 0.5;
  let points = 0;
  for (const m of knownMatches) {
    if (m.result === "W") points += 3;
    else if (m.result === "D") points += 1;
  }
  return points / (knownMatches.length * 3);
}

// Очки за голы: goalDifference нормализуется относительно числа матчей.
// Диапазон примерно [-3, +3] на матч → сигмоида в [0,1].
function goalScore(team: ParsedTeam): number {
  const matches = team.matches;
  if (matches.length === 0) return 0.5;
  const avgGD = team.form.goalDifference / matches.length;
  // Сигмоида: 1/(1+e^(-x)), центрирована в 0.5 при avgGD=0
  return 1 / (1 + Math.exp(-avgGD));
}

// Корректировка на силу соперников.
// Победа над STRONG даёт бонус, поражение от WEAK — штраф.
// UNKNOWN не даёт ни бонуса, ни штрафа.
function opponentStrengthAdjustment(team: ParsedTeam): number {
  const matches = team.matches;
  if (matches.length === 0) return 0;
  let adj = 0;
  for (const m of matches) {
    if (m.opponentStrength === "UNKNOWN") continue;
    if (m.result === "W" && m.opponentStrength === "STRONG") adj += 0.15;
    else if (m.result === "W" && m.opponentStrength === "MEDIUM") adj += 0.05;
    else if (m.result === "L" && m.opponentStrength === "WEAK") adj -= 0.15;
    else if (m.result === "L" && m.opponentStrength === "MEDIUM") adj -= 0.05;
  }
  return clamp(adj / matches.length, -0.3, 0.3);
}

// H2H: доля побед team1 среди известных результатов.
// Возвращает значение в [0,1], где 0.5 = паритет.
function h2hScore(h2h: ParsedVDP["h2h"], team1Name: string | null): number {
  if (h2h.length === 0) return 0.5;
  let t1Wins = 0;
  let draws = 0;
  let total = 0;
  for (const m of h2h) {
    if (!m.winner || m.winner.toUpperCase() === "DRAW" || m.winner.toUpperCase() === "D") {
      draws++;
      total++;
      continue;
    }
    total++;
    if (team1Name && m.winner.toLowerCase().includes(team1Name.toLowerCase())) {
      t1Wins++;
    }
  }
  if (total === 0) return 0.5;
  // Ничьи считаем как 0.5 для каждой стороны
  return (t1Wins + draws * 0.5) / total;
}

// Venue: если team1 играет дома — бонус, если в гостях — штраф.
// NEUTRAL и UNKNOWN = 0.
// Venue берётся из ParsedVDP.currentVenue — venue ТЕКУЩЕГО анализируемого матча,
// а не из исторического matches[0]. currentVenue задан с точки зрения team1:
// HOME ⇒ team1 дома (+0.08), AWAY ⇒ team1 в гостях (−0.08).
function venueAdjustment(currentVenue: "HOME" | "AWAY" | "NEUTRAL" | "UNKNOWN"): number {
  if (currentVenue === "HOME") return 0.08;
  if (currentVenue === "AWAY") return -0.08;
  return 0;
}

// Расчёт вероятности ничьей.
// Факторы: количество ничьих в форме обеих команд, близость сил, H2H ничьи.
// D-30: возвращает не только итог (после clamp), но и каждую contribution —
// при этом сама формула и порядок сложения НЕ меняются.
function calculateDrawProbabilityTrace(
  team1: ParsedTeam,
  team2: ParsedTeam,
  h2h: ParsedVDP["h2h"]
): ProbabilityEngineTrace["draw"] {
  let drawPct = BASE_DRAW_PCT;
  const contributions = {
    base: BASE_DRAW_PCT,
    totalMatches: team1.matches.length + team2.matches.length,
    drawRate: null as number | null,
    drawRateContribution: 0,
    formDiff: 0,
    formDiffContribution: 0,
    h2hDrawRate: null as number | null,
    h2hDrawContribution: 0,
  };

  // Доля ничьих в последних матчах обеих команд
  const totalMatches = contributions.totalMatches;
  if (totalMatches > 0) {
    const totalDraws = team1.form.draws + team2.form.draws;
    const drawRate = totalDraws / totalMatches;
    const contribution = (drawRate - 0.25) * 30;
    // Если >40% матчей — ничейные, увеличиваем вероятность ничьей
    drawPct += contribution;
    contributions.drawRate = drawRate;
    contributions.drawRateContribution = contribution;
  }

  // Близость формы команд: чем ближе formScore, тем выше шанс ничьей
  const f1 = formScore(team1);
  const f2 = formScore(team2);
  const formDiff = Math.abs(f1 - f2);
  const formDiffContribution = (0.5 - formDiff) * 12;
  // При разнице 0 → +6%, при разнице 0.5 → 0, при >0.5 → отрицательная корректировка
  drawPct += formDiffContribution;
  contributions.formDiff = formDiff;
  contributions.formDiffContribution = formDiffContribution;

  // H2H ничьи
  if (h2h.length > 0) {
    const h2hDraws = h2h.filter(
      (m) => !m.winner || m.winner.toUpperCase() === "DRAW" || m.winner.toUpperCase() === "D"
    ).length;
    const h2hDrawRate = h2hDraws / h2h.length;
    const h2hDrawContribution = (h2hDrawRate - 0.25) * 15;
    drawPct += h2hDrawContribution;
    contributions.h2hDrawRate = h2hDrawRate;
    contributions.h2hDrawContribution = h2hDrawContribution;
  }

  return { ...contributions, drawPct: clamp(drawPct, 8, 45) };
}

// Публичная обёртка: числовая вероятность ничьей (в процентах) после clamp.
function calculateDrawProbability(
  team1: ParsedTeam,
  team2: ParsedTeam,
  h2h: ParsedVDP["h2h"]
): number {
  return calculateDrawProbabilityTrace(team1, team2, h2h).drawPct;
}

// Нормализация трёх значений так, чтобы сумма была ровно 100.
// Использует largest remainder method для целочисленного округления без потери суммы.
function normalizeTo100(a: number, b: number, c: number): [number, number, number] {
  const total = a + b + c;
  if (total <= 0) return [34, 33, 33];

  const rawA = (a / total) * 100;
  const rawB = (b / total) * 100;
  const rawC = (c / total) * 100;

  const floorA = Math.floor(rawA);
  const floorB = Math.floor(rawB);
  const floorC = Math.floor(rawC);

  let remainder = 100 - (floorA + floorB + floorC);

  const fractions = [
    { idx: 0, frac: rawA - floorA },
    { idx: 1, frac: rawB - floorB },
    { idx: 2, frac: rawC - floorC },
  ];
  fractions.sort((x, y) => y.frac - x.frac);

  const result = [floorA, floorB, floorC];
  for (let i = 0; i < remainder; i++) {
    result[fractions[i].idx]++;
  }

  return [result[0], result[1], result[2]];
}

// D-30: единый расчёт — возвращает и результат, и diagnostic trace.
// Это ТОТ ЖЕ арифметический путь, что и раньше: формулы, веса, clamp и нормализация
// не менялись; trace лишь фиксирует уже вычисленные промежуточные значения.
export type EngineComputation = {
  result: ProbabilityResult;
  trace: ProbabilityEngineTrace;
};

function computeWithTrace(parsed: ParsedVDP): EngineComputation {
  const f1 = formScore(parsed.team1);
  const f2 = formScore(parsed.team2);
  const g1 = goalScore(parsed.team1);
  const g2 = goalScore(parsed.team2);
  const os1 = opponentStrengthAdjustment(parsed.team1);
  const os2 = opponentStrengthAdjustment(parsed.team2);
  const h2hVal = h2hScore(parsed.h2h, parsed.team1.teamName);
  const venueAdj = venueAdjustment(parsed.currentVenue);

  // Сырые очки для team1 и team2 (до нормализации)
  const rawTeam1 =
    f1 * WEIGHTS.recentForm +
    g1 * WEIGHTS.goals +
    (0.5 + os1) * WEIGHTS.opponentStrength +
    h2hVal * WEIGHTS.h2h +
    (0.5 + venueAdj) * WEIGHTS.venue;

  const rawTeam2 =
    f2 * WEIGHTS.recentForm +
    g2 * WEIGHTS.goals +
    (0.5 + os2) * WEIGHTS.opponentStrength +
    (1 - h2hVal) * WEIGHTS.h2h +
    (0.5 - venueAdj) * WEIGHTS.venue;

  // Вероятность ничьей рассчитывается отдельно
  const drawTrace = calculateDrawProbabilityTrace(parsed.team1, parsed.team2, parsed.h2h);
  const drawRaw = drawTrace.drawPct / 100;

  const [team1, draw, team2] = normalizeTo100(rawTeam1, drawRaw, rawTeam2);
  const result: ProbabilityResult = { team1, draw, team2 };

  const total = rawTeam1 + drawRaw + rawTeam2;
  const teamTrace = (team: ParsedTeam, venue: EngineVenue): EngineTeamTrace => {
    const knownMatches = team.matches.filter(
      (m) => m.result === "W" || m.result === "D" || m.result === "L"
    );
    return {
      teamName: team.teamName,
      matchesUsed: team.matches.length,
      knownResults: {
        wins: knownMatches.filter((m) => m.result === "W").length,
        draws: knownMatches.filter((m) => m.result === "D").length,
        losses: knownMatches.filter((m) => m.result === "L").length,
        denominator: knownMatches.length,
      },
      goalInput: {
        goalsFor: team.form.goalsFor,
        goalsAgainst: team.form.goalsAgainst,
        goalDifference: team.form.goalDifference,
        avgGoalDifference: team.matches.length > 0 ? team.form.goalDifference / team.matches.length : 0,
      },
      opponentStrengthInput: {
        matchesWithStrength: team.matches.filter((m) => m.opponentStrength !== "UNKNOWN").length,
      },
      currentVenue: venue,
    };
  };

  // currentVenue трактуется с точки зрения team1: team1 = HOME ⇒ он дома, team2 в гостях.
  const team2Venue: EngineVenue =
    parsed.currentVenue === "HOME" ? "AWAY" : parsed.currentVenue === "AWAY" ? "HOME" : parsed.currentVenue;

  const trace: ProbabilityEngineTrace = {
    input: {
      team1: teamTrace(parsed.team1, parsed.currentVenue),
      team2: teamTrace(parsed.team2, team2Venue),
      h2h: {
        count: parsed.h2h.length,
        team1Wins: parsed.h2h.filter(
          (m) =>
            parsed.team1.teamName &&
            m.winner &&
            m.winner.toUpperCase() !== "DRAW" &&
            m.winner.toUpperCase() !== "D" &&
            m.winner.toLowerCase().includes(parsed.team1.teamName.toLowerCase())
        ).length,
        team2Wins: parsed.h2h.filter(
          (m) =>
            parsed.team2.teamName &&
            m.winner &&
            m.winner.toUpperCase() !== "DRAW" &&
            m.winner.toUpperCase() !== "D" &&
            m.winner.toLowerCase().includes(parsed.team2.teamName.toLowerCase())
        ).length,
        draws: parsed.h2h.filter(
          (m) => !m.winner || m.winner.toUpperCase() === "DRAW" || m.winner.toUpperCase() === "D"
        ).length,
        h2hScore: h2hVal,
      },
      currentVenue: parsed.currentVenue,
    },
    components: {
      formScore: { team1: f1, team2: f2 },
      goalScore: { team1: g1, team2: g2 },
      opponentStrengthAdjustment: { team1: os1, team2: os2 },
      h2hScore: h2hVal,
      venueAdjustment: venueAdj,
      weights: WEIGHTS,
    },
    draw: drawTrace,
    raw: { team1: rawTeam1, team2: rawTeam2, draw: drawRaw, total },
    normalized: {
      exact: {
        team1: (rawTeam1 / total) * 100,
        draw: (drawRaw / total) * 100,
        team2: (rawTeam2 / total) * 100,
      },
      final: result,
    },
  };

  return { result, trace };
}

export function calculateProbabilities(parsed: ParsedVDP): ProbabilityResult {
  return computeWithTrace(parsed).result;
}

// D-30: отдельная точка входа для observability. Возвращает результат Engine и полный trace.
export function calculateProbabilitiesWithTrace(parsed: ParsedVDP): EngineComputation {
  return computeWithTrace(parsed);
}

// D-30: только diagnostic trace (без изменения расчёта).
export function buildEngineTrace(parsed: ParsedVDP): ProbabilityEngineTrace {
  return computeWithTrace(parsed).trace;
}
