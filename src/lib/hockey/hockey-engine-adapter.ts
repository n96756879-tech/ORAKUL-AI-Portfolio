import type { HockeyVDP } from './types';
import type {
  HockeyEngineInput,
  SemanticMatchIdentity,
  SemanticTeamInput,
  SemanticRecentFormSignal,
  SemanticGoaltendingSignal,
  SemanticShotSignal,
  SemanticSpecialTeamsSignal,
  SemanticAvailabilitySignal,
  SemanticH2HSignal,
  SemanticH2HMatch,
} from './engine-types';

/**
 * Pure Semantic Adapter: Transforms HockeyVDP into HockeyEngineInput.
 *
 * Rules:
 * 1. Preserves DataStatus (FOUND, NOT_FOUND, UNKNOWN, NOT_APPLICABLE). Never turns UNKNOWN/NOT_FOUND into 0.
 * 2. Preserves Confidence (CONFIRMED, PARTIALLY_CONFIRMED, UNCONFIRMED).
 * 3. Preserves Temporal Metadata (sampleSize, season, temporalType).
 * 4. Does NOT apply weights, coefficients, probabilities, or numerical penalties.
 * 5. Does NOT apply home advantage multipliers or league baseline fallbacks.
 * 6. Does NOT perform OT/SO resolution or score predictions.
 */
export function adaptHockeyVDPToEngineInput(vdp: HockeyVDP): HockeyEngineInput {
  const match: SemanticMatchIdentity = {
    team1Name: vdp.match.team1Name,
    team2Name: vdp.match.team2Name,
    homeTeam: vdp.match.homeTeam,
    awayTeam: vdp.match.awayTeam,
    league: vdp.match.league,
    date: vdp.match.date,
    venue: vdp.match.venue,
  };

  const adaptTeam = (teamData: HockeyVDP['team1']): SemanticTeamInput => {
    const recentForm: SemanticRecentFormSignal = {
      matches: teamData.recentForm.matches.map((m) => ({
        date: m.date,
        opponent: m.opponent,
        venue: m.venue,
        goalsFor: m.goalsFor,
        goalsAgainst: m.goalsAgainst,
        regulationResult: m.regulationResult,
        overtimeResult: m.overtimeResult,
        shootoutResult: m.shootoutResult,
        outcomeType: m.outcomeType,
        opponentStrength: m.opponentStrength,
      })),
      summary: {
        gamesPlayed: teamData.recentForm.gamesPlayed,
        winsRegulation: teamData.recentForm.winsRegulation,
        winsOT: teamData.recentForm.winsOT,
        winsSO: teamData.recentForm.winsSO,
        lossesRegulation: teamData.recentForm.lossesRegulation,
        lossesOT: teamData.recentForm.lossesOT,
        lossesSO: teamData.recentForm.lossesSO,
        goalsForTotal: teamData.recentForm.goalsForTotal,
        goalsAgainstTotal: teamData.recentForm.goalsAgainstTotal,
      },
    };

    const goaltending: SemanticGoaltendingSignal = {
      starterName: teamData.goaltending.starterName,
      backupName: teamData.goaltending.backupName,
      starterStatus: teamData.goaltending.starterStatus,
      svPct: teamData.goaltending.svPct,
      gaa: teamData.goaltending.gaa,
      saves: teamData.goaltending.saves,
      shotsAgainst: teamData.goaltending.shotsAgainst,
    };

    const specialTeams: SemanticSpecialTeamsSignal = {
      ppPct: teamData.specialTeams.ppPct,
      pkPct: teamData.specialTeams.pkPct,
      powerPlayGoals: teamData.specialTeams.powerPlayGoals,
      shortHandedGoals: teamData.specialTeams.shortHandedGoals,
      penalties: teamData.specialTeams.penalties,
      penaltyMinutes: teamData.specialTeams.penaltyMinutes,
    };

    const shots: SemanticShotSignal = {
      sog: teamData.shots.sog,
      shotsAgainst: teamData.shots.shotsAgainst,
      shotDifferential: teamData.shots.shotDifferential,
      faceoffPct: teamData.shots.faceoffPct,
      hits: teamData.shots.hits,
      blockedShots: teamData.shots.blockedShots,
      takeaways: teamData.shots.takeaways,
      giveaways: teamData.shots.giveaways,
    };

    const availability: SemanticAvailabilitySignal = {
      confirmedOut: teamData.availability.confirmedOut,
      dayToDay: teamData.availability.dayToDay,
      unconfirmed: teamData.availability.unconfirmed,
    };

    return {
      teamName: teamData.teamName,
      recentForm,
      goaltending,
      specialTeams,
      shots,
      scoring: teamData.scoring,
      availability,
    };
  };

  const h2hMatches: SemanticH2HMatch[] = vdp.h2h.map((h) => ({
    date: h.date,
    homeTeam: h.homeTeam,
    awayTeam: h.awayTeam,
    homeScore: h.homeScore,
    awayScore: h.awayScore,
    winner: h.winner,
    result: h.result,
    venue: h.venue,
    starterGoalies: h.starterGoalies,
  }));

  // Build match identifiers for potential deduplication down the line
  const matchIdentifiers = h2hMatches.map(
    (m) => `${m.date || 'UNKNOWN'}_${m.homeTeam}_vs_${m.awayTeam}_${m.homeScore}-${m.awayScore}`
  );

  const h2hSignal: SemanticH2HSignal = {
    matches: h2hMatches,
    matchIdentifiers,
  };

  return {
    match,
    team1: adaptTeam(vdp.team1),
    team2: adaptTeam(vdp.team2),
    h2h: h2hSignal,
    standings: vdp.standings,
    context: vdp.context,
    notFound: vdp.notFound,
  };
}
