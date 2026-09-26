import type { ParsedVDP, ParsedTeam, ParsedMatch } from "./vdp-parser";

export type ProbabilityResult = {
  team1: number;
  draw: number;
  team2: number;
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
function formScore(team: ParsedTeam): number {
  const matches = team.matches;
  if (matches.length === 0) return 0.5;
  let points = 0;
  for (const m of matches) {
    if (m.result === "W") points += 3;
    else if (m.result === "D") points += 1;
  }
  const maxPoints = matches.length * 3;
  return points / maxPoints;
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
function venueAdjustment(team1Matches: ParsedMatch[], team2Matches: ParsedMatch[]): number {
  // Определяем venue по последнему матчу каждой команды как прокси.
  // Если у team1 последний матч HOME → team1 хозяин текущего матча.
  const lastT1 = team1Matches[team1Matches.length - 1];
  const lastT2 = team2Matches[team2Matches.length - 1];

  if (lastT1?.venue === "HOME" && lastT2?.venue === "AWAY") return 0.08;
  if (lastT1?.venue === "AWAY" && lastT2?.venue === "HOME") return -0.08;
  return 0;
}

// Расчёт вероятности ничьей.
// Факторы: количество ничьих в форме обеих команд, близость сил, H2H ничьи.
function calculateDrawProbability(
  team1: ParsedTeam,
  team2: ParsedTeam,
  h2h: ParsedVDP["h2h"]
): number {
  let drawPct = BASE_DRAW_PCT;

  // Доля ничьих в последних матчах обеих команд
  const totalMatches = team1.matches.length + team2.matches.length;
  if (totalMatches > 0) {
    const totalDraws = team1.form.draws + team2.form.draws;
    const drawRate = totalDraws / totalMatches;
    // Если >40% матчей — ничейные, увеличиваем вероятность ничьей
    drawPct += (drawRate - 0.25) * 30;
  }

  // Близость формы команд: чем ближе formScore, тем выше шанс ничьей
  const f1 = formScore(team1);
  const f2 = formScore(team2);
  const formDiff = Math.abs(f1 - f2);
  // При разнице 0 → +6%, при разнице 0.5 → 0, при >0.5 → отрицательная корректировка
  drawPct += (0.5 - formDiff) * 12;

  // H2H ничьи
  if (h2h.length > 0) {
    const h2hDraws = h2h.filter(
      (m) => !m.winner || m.winner.toUpperCase() === "DRAW" || m.winner.toUpperCase() === "D"
    ).length;
    const h2hDrawRate = h2hDraws / h2h.length;
    drawPct += (h2hDrawRate - 0.25) * 15;
  }

  return clamp(drawPct, 8, 45);
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

export function calculateProbabilities(parsed: ParsedVDP): ProbabilityResult {
  const f1 = formScore(parsed.team1);
  const f2 = formScore(parsed.team2);
  const g1 = goalScore(parsed.team1);
  const g2 = goalScore(parsed.team2);
  const os1 = opponentStrengthAdjustment(parsed.team1);
  const os2 = opponentStrengthAdjustment(parsed.team2);
  const h2hVal = h2hScore(parsed.h2h, parsed.team1.teamName);
  const venueAdj = venueAdjustment(parsed.team1.matches, parsed.team2.matches);

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
  const drawRaw = calculateDrawProbability(parsed.team1, parsed.team2, parsed.h2h) / 100;

  const [team1, draw, team2] = normalizeTo100(rawTeam1, drawRaw, rawTeam2);

  return { team1, draw, team2 };
}
