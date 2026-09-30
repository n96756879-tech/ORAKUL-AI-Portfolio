import type { DataSource, DataSourceTier, DataSourceReliability } from '../data/types';
import type { AnalysisSource, AnalysisExplanation } from '../../types/analysis';

// -----------------------------------------------------------------------------
// 1. Data Status & Missing Data Wrappers
// -----------------------------------------------------------------------------

export type DataStatus =
  | 'FOUND'
  | 'NOT_FOUND'
  | 'NOT_APPLICABLE'
  | 'UNKNOWN';

export interface MetricValue<T> {
  status: DataStatus;
  value: T | null;
  confidence: 'CONFIRMED' | 'PARTIALLY_CONFIRMED' | 'UNCONFIRMED';
  source?: string;
}

export type TemporalType =
  | 'current_match'
  | 'recent_form'
  | 'season_to_date'
  | 'previous_season'
  | 'historical_h2h';

export interface TemporalMetric<T> extends MetricValue<T> {
  sampleSize: number | null;
  season: string | null;
  temporalType: TemporalType;
}

// -----------------------------------------------------------------------------
// 2. Hockey Result Semantics
// -----------------------------------------------------------------------------

export type HockeyRegulationResult =
  | 'WIN'
  | 'LOSS'
  | 'TIE'
  | 'UNKNOWN';

export type HockeyOTResult =
  | 'WIN'
  | 'LOSS'
  | 'NOT_APPLICABLE'
  | 'UNKNOWN';

export type HockeySOResult =
  | 'WIN'
  | 'LOSS'
  | 'NOT_APPLICABLE'
  | 'UNKNOWN';

export type HockeyOutcomeType =
  | 'REGULATION'
  | 'OVERTIME'
  | 'SHOOTOUT';

export interface HockeyMatchResult {
  regulation: HockeyRegulationResult;
  overtime: HockeyOTResult;
  shootout: HockeySOResult;
  winningTeam: string;
  outcomeType: HockeyOutcomeType;
  /**
   * Optional / league-aware points earned (e.g. 2 for RW/OTW/SOW, 1 for OTL/SOL, 0 for RL in NHL).
   * Kept optional to preserve raw match semantics without tying contract to a specific league model.
   */
  pointsEarned?: number;
}

// -----------------------------------------------------------------------------
// 3. Match Identity
// -----------------------------------------------------------------------------

export interface HockeyMatchIdentity {
  team1Name: string;
  team2Name: string;
  date: string;
  league: string;
  venue: string;
  homeTeam: string;
  awayTeam: string;
}

// -----------------------------------------------------------------------------
// 4. Recent Form
// -----------------------------------------------------------------------------

export interface HockeyFormMatch {
  date: string | null;
  opponent: string | null;
  venue: 'HOME' | 'AWAY' | 'NEUTRAL' | 'UNKNOWN';
  goalsFor: number | null;
  goalsAgainst: number | null;
  regulationResult: HockeyRegulationResult;
  overtimeResult: HockeyOTResult;
  shootoutResult: HockeySOResult;
  outcomeType: HockeyOutcomeType | 'UNKNOWN';
  /**
   * Opponent strength estimation if available. Supports absence of data without
   * forcing UNKNOWN to default to neutral.
   */
  opponentStrength: MetricValue<'STRONG' | 'MEDIUM' | 'WEAK'>;
}

export interface HockeyRecentForm {
  matches: HockeyFormMatch[];
  gamesPlayed: number;
  winsRegulation: number;
  winsOT: number;
  winsSO: number;
  lossesOT: number;
  lossesSO: number;
  lossesRegulation: number;
  goalsForTotal: number;
  goalsAgainstTotal: number;
}

// -----------------------------------------------------------------------------
// 5. Goaltending
// -----------------------------------------------------------------------------

export type GoalieAvailabilityStatus =
  | 'CONFIRMED'
  | 'EXPECTED'
  | 'UNCONFIRMED'
  | 'INJURED'
  | 'RESTING'
  | 'UNKNOWN';

export interface HockeyGoaltending {
  starterName: MetricValue<string>;
  backupName: MetricValue<string>;
  starterStatus: MetricValue<GoalieAvailabilityStatus>;

  // Goalie metrics with mandatory temporal context envelope
  svPct: TemporalMetric<number>;
  gaa: TemporalMetric<number>;

  // Absolute match-level figures
  saves: MetricValue<number>;
  shotsAgainst: MetricValue<number>;
}

// -----------------------------------------------------------------------------
// 6. Special Teams
// -----------------------------------------------------------------------------

export interface HockeySpecialTeams {
  ppPct: TemporalMetric<number>;
  pkPct: TemporalMetric<number>;
  powerPlayGoals: MetricValue<number>;
  shortHandedGoals: MetricValue<number>;
  penalties: MetricValue<number>;
  penaltyMinutes: MetricValue<number>;
}

// -----------------------------------------------------------------------------
// 7. Shot & Defensive Data
// -----------------------------------------------------------------------------

export interface HockeyShotData {
  sog: MetricValue<number>;
  shotsAgainst: MetricValue<number>;
  shotDifferential: MetricValue<number>;
  faceoffPct: MetricValue<number>;
  hits: MetricValue<number>;
  blockedShots: MetricValue<number>;
  takeaways: MetricValue<number>;
  giveaways: MetricValue<number>;
}

// -----------------------------------------------------------------------------
// 8. Scoring Breakdown
// -----------------------------------------------------------------------------

export interface GoalsByPeriod {
  period1: number;
  period2: number;
  period3: number;
  overtime: number | null;
}

export interface HockeyScoringData {
  goalsByPeriod: MetricValue<GoalsByPeriod>;
  evenStrengthGoals: MetricValue<number>;
  powerPlayGoals: MetricValue<number>;
  shortHandedGoals: MetricValue<number>;
  emptyNetGoals: MetricValue<number>;
}

// -----------------------------------------------------------------------------
// 9. Head-to-Head (H2H)
// -----------------------------------------------------------------------------

export interface HockeyH2HMatch {
  date: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  winner: string | null;
  result: HockeyMatchResult;
  venue: string | null;
  starterGoalies?: {
    homeGoalie?: string;
    awayGoalie?: string;
  };
}

// -----------------------------------------------------------------------------
// 10. Availability & Domain Roles
// -----------------------------------------------------------------------------

export type HockeyPlayerRole =
  | 'GOALIE'
  | 'DEFENSE'
  | 'FORWARD'
  | 'UNKNOWN';

export interface HockeyInjuredPlayer {
  playerName: string;
  role: HockeyPlayerRole;
  reason: string;
  statusDetails?: string;
}

export interface HockeyAvailability {
  confirmedOut: HockeyInjuredPlayer[];
  dayToDay: HockeyInjuredPlayer[];
  unconfirmed: HockeyInjuredPlayer[];
}

// -----------------------------------------------------------------------------
// 11. Standings & Context (Reusing shared/minimal context)
// -----------------------------------------------------------------------------

export interface HockeyStandingsData {
  rank: MetricValue<number>;
  points: MetricValue<number>;
  divisionRank: MetricValue<number>;
  conferenceRank: MetricValue<number>;
}

export interface HockeyTournamentContext {
  stage: string | null; // e.g. "Regular Season", "Playoffs Round 1"
  notes: string | null;
}

// -----------------------------------------------------------------------------
// 12. Team Data & Root HockeyVDP Contract
// -----------------------------------------------------------------------------

export interface HockeyTeamData {
  teamName: string;
  recentForm: HockeyRecentForm;
  goaltending: HockeyGoaltending;
  specialTeams: HockeySpecialTeams;
  shots: HockeyShotData;
  scoring: HockeyScoringData;
  availability: HockeyAvailability;
}

export interface HockeyVDP {
  match: HockeyMatchIdentity;
  team1: HockeyTeamData;
  team2: HockeyTeamData;
  h2h: HockeyH2HMatch[];
  standings: HockeyStandingsData;
  context: HockeyTournamentContext;
  sources: AnalysisSource[];
  notFound: string[];
}
