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
  HockeyH2HMatch,
  HockeyAvailability,
  HockeyInjuredPlayer,
  HockeyStandingsData,
  HockeyTournamentContext,
  MetricValue,
  TemporalMetric,
  DataStatus,
  GoalieAvailabilityStatus,
} from './types';

// -----------------------------------------------------------------------------
// 1. Semantic Match Identity (Non-Mathematical Metadata)
// -----------------------------------------------------------------------------

export interface SemanticMatchIdentity {
  team1Name: string;
  team2Name: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  date: string;
  venue: string;
}

// -----------------------------------------------------------------------------
// 2. Semantic Recent Form Signal
// -----------------------------------------------------------------------------

export interface SemanticFormMatch {
  date: string | null;
  opponent: string | null;
  venue: 'HOME' | 'AWAY' | 'NEUTRAL' | 'UNKNOWN';
  goalsFor: number | null;
  goalsAgainst: number | null;
  regulationResult: 'WIN' | 'LOSS' | 'TIE' | 'UNKNOWN';
  overtimeResult: 'WIN' | 'LOSS' | 'NOT_APPLICABLE' | 'UNKNOWN';
  shootoutResult: 'WIN' | 'LOSS' | 'NOT_APPLICABLE' | 'UNKNOWN';
  outcomeType: 'REGULATION' | 'OVERTIME' | 'SHOOTOUT' | 'UNKNOWN';
  opponentStrength: MetricValue<'STRONG' | 'MEDIUM' | 'WEAK'>;
}

export interface SemanticRecentFormSignal {
  /**
   * Primary Source Observations: Array of individual match records.
   * Model input candidates can derive goalsFor/game, win rates, etc. directly from this array.
   */
  matches: SemanticFormMatch[];

  /**
   * Source Summary Aggregates (kept as received from VDP for verification).
   */
  summary: {
    gamesPlayed: number;
    winsRegulation: number;
    winsOT: number;
    winsSO: number;
    lossesRegulation: number;
    lossesOT: number;
    lossesSO: number;
    goalsForTotal: number;
    goalsAgainstTotal: number;
  };
}

// -----------------------------------------------------------------------------
// 3. Semantic Goaltending Signal
// -----------------------------------------------------------------------------

/**
   * MODEL-DEPENDENT: GAA is preserved as a metric candidate for diagnostic or fallback usage,
   * while SV% serves as the primary goalie skill metric.
   */
export interface SemanticGoaltendingSignal {
  starterName: MetricValue<string>;
  backupName: MetricValue<string>;
  starterStatus: MetricValue<GoalieAvailabilityStatus>;

  /** Primary Goalie Skill Signal */
  svPct: TemporalMetric<number>;

  /** MODEL-DEPENDENT: Alternative/Diagnostic Goalie Metric */
  gaa: TemporalMetric<number>;

  /** Workload & Volume Metrics (Not to be duplicated with SV%) */
  saves: MetricValue<number>;
  shotsAgainst: MetricValue<number>;
}

// -----------------------------------------------------------------------------
// 4. Semantic Shot & Possession Signal
// -----------------------------------------------------------------------------

/**
   * MODEL-DEPENDENT: shotDifferential (SOG - shotsAgainst) is a deterministic derived duplicate.
   * It is preserved here as a model candidate parameter, but engine solvers should use SOG & shotsAgainst directly.
   */
export interface SemanticShotSignal {
  sog: MetricValue<number>;
  shotsAgainst: MetricValue<number>;
  /** DERIVED DUPLICATE / MODEL-DEPENDENT */
  shotDifferential: MetricValue<number>;
  faceoffPct: MetricValue<number>;
  hits: MetricValue<number>;
  blockedShots: MetricValue<number>;
  takeaways: MetricValue<number>;
  giveaways: MetricValue<number>;
}

// -----------------------------------------------------------------------------
// 5. Semantic Special Teams Signal
// -----------------------------------------------------------------------------

/**
   * MODEL-DEPENDENT: Rate metrics (PP%, PK%) are primary signals, while counting metrics (PPG, SHG)
   * are preserved for rate-vs-volume model formulations.
   */
export interface SemanticSpecialTeamsSignal {
  ppPct: TemporalMetric<number>;
  pkPct: TemporalMetric<number>;
  powerPlayGoals: MetricValue<number>;
  shortHandedGoals: MetricValue<number>;
  penalties: MetricValue<number>;
  penaltyMinutes: MetricValue<number>;
}

// -----------------------------------------------------------------------------
// 6. Semantic Availability & Roster Signal
// -----------------------------------------------------------------------------

export interface SemanticAvailabilitySignal {
  confirmedOut: HockeyInjuredPlayer[];
  dayToDay: HockeyInjuredPlayer[];
  /** Preserved strictly as unconfirmed status, NOT converted to numerical penalties */
  unconfirmed: HockeyInjuredPlayer[];
}

// -----------------------------------------------------------------------------
// 7. Semantic Team Input Container
// -----------------------------------------------------------------------------

export interface SemanticTeamInput {
  teamName: string;
  recentForm: SemanticRecentFormSignal;
  goaltending: SemanticGoaltendingSignal;
  specialTeams: SemanticSpecialTeamsSignal;
  shots: SemanticShotSignal;
  scoring: HockeyScoringData;
  availability: SemanticAvailabilitySignal;
}

// -----------------------------------------------------------------------------
// 8. Semantic H2H Signal
// -----------------------------------------------------------------------------

export interface SemanticH2HMatch {
  date: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  winner: string | null;
  result: {
    regulation: 'WIN' | 'LOSS' | 'TIE' | 'UNKNOWN';
    overtime: 'WIN' | 'LOSS' | 'NOT_APPLICABLE' | 'UNKNOWN';
    shootout: 'WIN' | 'LOSS' | 'NOT_APPLICABLE' | 'UNKNOWN';
    winningTeam: string;
    outcomeType: 'REGULATION' | 'OVERTIME' | 'SHOOTOUT' | 'UNKNOWN';
  };
  venue: string | null;
  starterGoalies?: {
    homeGoalie?: string;
    awayGoalie?: string;
  };
}

export interface SemanticH2HSignal {
  matches: SemanticH2HMatch[];
  /**
   * Identifier list allowing downstream engine/preprocessor to detect temporal overlap
   * between recentForm matches and historical H2H matches without modifying raw logs.
   */
  matchIdentifiers: string[];
}

// -----------------------------------------------------------------------------
// 9. Semantic League Configuration Interface (No Numerical Hardcodes)
// -----------------------------------------------------------------------------

/**
 * Interface defining parameters that a future probability engine solver will require.
 * DO NOT hardcode values in the semantic adapter. Values are injected from external configuration.
 */
export interface HockeyLeagueConfig {
  leagueId: string;
  /** MODEL-DEPENDENT: Expected league average total goals per 60 min */
  averageGoalsPerGame?: number;
  /** MODEL-DEPENDENT: Expected 60-min regulation tie rate baseline */
  regulationTieRate?: number;
  /** MODEL-DEPENDENT: Home ice advantage scalar multiplier */
  homeAdvantageMultiplier?: number;
  /** MODEL-DEPENDENT: Goalie baseline SV% for shrinkage/fallback */
  goalieBaselineSvPct?: number;
  /** MODEL-DEPENDENT: Baseline Power Play % for shrinkage/fallback */
  ppBaselinePct?: number;
  /** MODEL-DEPENDENT: Baseline Penalty Kill % for shrinkage/fallback */
  pkBaselinePct?: number;
}

// -----------------------------------------------------------------------------
// 10. Complete HockeyEngineInput Semantic Contract
// -----------------------------------------------------------------------------

export interface HockeyEngineInput {
  /** Match metadata & non-mathematical identity */
  match: SemanticMatchIdentity;

  /** Team 1 Semantic Signals */
  team1: SemanticTeamInput;

  /** Team 2 Semantic Signals */
  team2: SemanticTeamInput;

  /** Historical Head-to-Head Signal */
  h2h: SemanticH2HSignal;

  /** League Standings Context */
  standings: HockeyStandingsData;

  /** Tournament Context */
  context: HockeyTournamentContext;

  /** Unresolved Data Lines from VDP */
  notFound: string[];
}
