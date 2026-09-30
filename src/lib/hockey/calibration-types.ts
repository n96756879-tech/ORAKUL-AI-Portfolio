import type {
  MetricValue,
  HockeyRecentForm,
  HockeyGoaltending,
  HockeySpecialTeams,
  HockeyShotData,
  HockeyAvailability,
  HockeyH2HMatch,
} from './types';

// -----------------------------------------------------------------------------
// 1. Match Identity
// -----------------------------------------------------------------------------

export interface HistoricalMatchIdentity {
  matchId: string;
  predictionCutoff: string; // ISO 8601 timestamp string
  matchStart: string; // ISO 8601 timestamp string
  league: string;
  season: string;
  homeTeam: string;
  awayTeam: string;
  venueType: 'HOME_AWAY' | 'NEUTRAL';
}

// -----------------------------------------------------------------------------
// 2. Pre-Match Feature Blocks
// -----------------------------------------------------------------------------

export interface HistoricalTeamFeaturePair<T> {
  home: T;
  away: T;
}

export interface HistoricalRatingsBlock {
  homeOffenseRating?: MetricValue<number>;
  homeDefenseRating?: MetricValue<number>;
  awayOffenseRating?: MetricValue<number>;
  awayDefenseRating?: MetricValue<number>;
}

export interface HistoricalPreMatchSnapshot {
  ratings?: HistoricalRatingsBlock | null;
  recentForm?: HistoricalTeamFeaturePair<HockeyRecentForm> | null;
  goaltending?: HistoricalTeamFeaturePair<HockeyGoaltending> | null;
  shots?: HistoricalTeamFeaturePair<HockeyShotData> | null;
  specialTeams?: HistoricalTeamFeaturePair<HockeySpecialTeams> | null;
  availability?: HistoricalTeamFeaturePair<HockeyAvailability> | null;
  h2h?: HockeyH2HMatch[] | null;
}

// -----------------------------------------------------------------------------
// 3. Post-Match Target Signals
// -----------------------------------------------------------------------------

export interface HistoricalRegulationTarget {
  homeGoals: number;
  awayGoals: number;
}

export interface HistoricalFinalTarget {
  homeGoals: number;
  awayGoals: number;
}

export type HistoricalOTStatus =
  | 'NOT_APPLICABLE'
  | 'HOME_WIN'
  | 'AWAY_WIN'
  | 'UNRESOLVED_TO_SO'
  | 'UNKNOWN';

export interface HistoricalOvertimeTarget {
  status: HistoricalOTStatus;
}

export type HistoricalSOStatus =
  | 'NOT_APPLICABLE'
  | 'HOME_WIN'
  | 'AWAY_WIN'
  | 'UNKNOWN';

export interface HistoricalShootoutTarget {
  status: HistoricalSOStatus;
}

export interface HistoricalTarget {
  regulation: HistoricalRegulationTarget;
  final: HistoricalFinalTarget;
  overtime: HistoricalOvertimeTarget;
  shootout: HistoricalShootoutTarget;
}

// -----------------------------------------------------------------------------
// 4. Historical Context & Baseline Reference
// -----------------------------------------------------------------------------

export interface HistoricalCalibrationContext {
  baselineRef?: string | null;
  metadata?: Record<string, unknown> | null;
}

// -----------------------------------------------------------------------------
// 5. Root Calibration Record Contract
// -----------------------------------------------------------------------------

export interface HistoricalCalibrationRecord {
  match: HistoricalMatchIdentity;
  preMatch?: HistoricalPreMatchSnapshot | null;
  target: HistoricalTarget;
  context?: HistoricalCalibrationContext | null;
}
