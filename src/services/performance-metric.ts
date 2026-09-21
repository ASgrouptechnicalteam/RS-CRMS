/**
 * performance-metric.ts — Pure performance score calculation.
 *
 * Centralizes the base-50.0 event-aggregated performance score used by the
 * /performance routes. Follows the repository's pure-calculation pattern
 * (see task-sla.status.ts): no HTTP, no Express, no DB writes, deterministic,
 * and unit-testable.
 *
 * NOTES ON THE EXISTING FORMULAS:
 *  - /performance/my-score and /performance/team share the FULL formula
 *    (calculatePerformanceScore below).
 *  - § Phase 4: attendance scoring is no longer a flat presentCount * weight —
 *    see PerformanceScoreInputs.attendanceBoost and utils/time.ts's
 *    calculateAttendancePoints() for the time-of-day gradient this replaced.
 *  - The ranked leaderboard view is served by GET /performance/achievements
 *    (?employeeId=ALL), which ranks by deals closed / assisted conversions /
 *    site visits executed — a different, deal-outcome-based ranking, not a
 *    variant of this score formula. There is no separate
 *    calculateLeaderboardScore function; an earlier design called for one,
 *    but it was superseded by the achievements-based ranking.
 */

export const PERFORMANCE_BASE_SCORE = 50.0;

/**
 * Performance tiers — the same 4 zones already shown in the UI (Danger/
 * Satisfactory/Safe/Excellent), reused here as the basis for escalating
 * point multipliers rather than inventing a second taxonomy. Boundaries
 * must stay in sync with PerformanceScoreWidget.tsx's statusZone logic.
 */
export type PerformanceTier = 'DANGER' | 'SATISFACTORY' | 'SAFE' | 'EXCELLENT';

export function getPerformanceTier(score: number): PerformanceTier {
  if (score <= 40) return 'DANGER';
  if (score <= 65) return 'SATISFACTORY';
  if (score <= 85) return 'SAFE';
  return 'EXCELLENT';
}

/**
 * Escalating incentive curve: staying in Excellent pays out boosts at a
 * premium; staying in Danger makes penalties sting more. Satisfactory/Safe
 * are the neutral baseline (1.0/1.0) — most employees most of the time.
 */
export const PERFORMANCE_TIER_MULTIPLIERS: Record<
  PerformanceTier,
  { boost: number; penalty: number }
> = {
  EXCELLENT: { boost: 1.1, penalty: 1.0 },
  SAFE: { boost: 1.0, penalty: 1.0 },
  SATISFACTORY: { boost: 1.0, penalty: 1.0 },
  DANGER: { boost: 1.0, penalty: 1.25 },
};

export const PERFORMANCE_WEIGHTS = {
  completedTaskBoost: 2.0,
  dailyReportBoost: 0.5,
  propertyBookingBoost: 10.0,
  targetExceededBoost: 0.5,
  latePenalty: 1.0,
  halfDayPenalty: 1.0,
  belowTargetPenalty: 1.0,
  overduePenalty: 1.0,
  uninformedAbsentPenalty: 2.0,
  // Both written by jobs/tasks.ts's dailyAttendanceRollupJob at IST midnight.
  midnightAutoCheckoutPenalty: 1.0,
  missingDailyReportPenalty: 1.0,
  completedAllWorkBoost: 1.0,
} as const;

export interface PerformanceScoreInputs {
  completedTasks: number;
  overdueTasks: number;
  dailyReports: number;
  belowTargetEvents: number;
  targetExceededEvents: number;
  uninformedAbsentEvents: number;
  midnightAutoCheckoutEvents: number;
  missingDailyReportEvents: number;
  completedAllWorkEvents: number;
  propertyBookingContributions: number;
  presentCount: number;
  // § Phase 4: pre-summed points across the month's attendance logs, from
  // utils/time.ts's calculateAttendancePoints() per log — replaced the old
  // flat `presentCount * presentBoost` weight since a PRESENT check-in can
  // now earn 1.0/0.5/0.0 depending on time-of-day, and approved-late/
  // approved-half-day now correctly earn 0 instead of the old +0.5.
  attendanceBoost: number;
  lateCount: number;
  halfDayCount: number;
  manualAdjustmentsTotal: number;
  manualAdjustmentsCount: number;
}

export interface PerformanceScoreBreakdown {
  baseScore: number;
  completedTasks: number;
  taskBoost: number;
  dailyReports: number;
  reportBoost: number;
  presentCount: number;
  presentBoost: number;
  propertyBookingContributions: number;
  propertyBookingBoost: number;
  lateCount: number;
  latePenalty: number;
  halfDayCount: number;
  halfDayPenalty: number;
  manualAdjustmentsTotal: number;
  manualAdjustmentsCount: number;
  belowTargetEvents: number;
  belowTargetPenalty: number;
  targetExceededEvents: number;
  targetExceededBoost: number;
  overdueTasks: number;
  overduePenalty: number;
  uninformedAbsentEvents: number;
  uninformedAbsentPenalty: number;
  midnightAutoCheckoutEvents: number;
  midnightAutoCheckoutPenalty: number;
  missingDailyReportEvents: number;
  missingDailyReportPenalty: number;
  completedAllWorkEvents: number;
  completedAllWorkBoost: number;
  tier: PerformanceTier;
  tierBoostMultiplier: number;
  tierPenaltyMultiplier: number;
  tierBoostBonus: number;
  tierPenaltyExtra: number;
}

export interface PerformanceScoreResult {
  score: number;
  breakdown: PerformanceScoreBreakdown;
}

const ZERO_BREAKDOWN: PerformanceScoreBreakdown = {
  baseScore: PERFORMANCE_BASE_SCORE,
  completedTasks: 0,
  taskBoost: 0,
  dailyReports: 0,
  reportBoost: 0,
  presentCount: 0,
  presentBoost: 0,
  propertyBookingContributions: 0,
  propertyBookingBoost: 0,
  lateCount: 0,
  latePenalty: 0,
  halfDayCount: 0,
  halfDayPenalty: 0,
  manualAdjustmentsTotal: 0,
  manualAdjustmentsCount: 0,
  belowTargetEvents: 0,
  belowTargetPenalty: 0,
  targetExceededEvents: 0,
  targetExceededBoost: 0,
  overdueTasks: 0,
  overduePenalty: 0,
  uninformedAbsentEvents: 0,
  uninformedAbsentPenalty: 0,
  midnightAutoCheckoutEvents: 0,
  midnightAutoCheckoutPenalty: 0,
  missingDailyReportEvents: 0,
  missingDailyReportPenalty: 0,
  completedAllWorkEvents: 0,
  completedAllWorkBoost: 0,
  tier: 'SATISFACTORY',
  tierBoostMultiplier: 1.0,
  tierPenaltyMultiplier: 1.0,
  tierBoostBonus: 0,
  tierPenaltyExtra: 0,
};

/** Round a raw score to one decimal place and clamp to 0 (lower bound). */
export function roundPerformanceScore(rawScore: number): number {
  return Math.max(0, Math.round(rawScore * 10) / 10);
}

/**
 * Full performance score — shared by /performance/my-score and /performance/team.
 * Pure: does not mutate the input and performs no database access.
 *
 * `tierBasisScore` is the employee's score from BEFORE this period (e.g. last
 * month's final score) — it decides which tier's multiplier applies to THIS
 * period's points. It must never be this same period's own (in-progress)
 * score, or the tier would shift mid-calculation as points are added.
 * Omitting it (e.g. when computing that prior-period score itself) applies
 * no multiplier, which is exactly the neutral SATISFACTORY/SAFE baseline.
 */
export function calculatePerformanceScore(
  inputs: PerformanceScoreInputs,
  tierBasisScore?: number,
): PerformanceScoreResult {
  const tier = getPerformanceTier(tierBasisScore ?? PERFORMANCE_BASE_SCORE);
  const { boost: tierBoostMultiplier, penalty: tierPenaltyMultiplier } =
    PERFORMANCE_TIER_MULTIPLIERS[tier];

  const breakdown: PerformanceScoreBreakdown = {
    ...ZERO_BREAKDOWN,
    completedTasks: inputs.completedTasks,
    taskBoost: inputs.completedTasks * PERFORMANCE_WEIGHTS.completedTaskBoost,
    dailyReports: inputs.dailyReports,
    reportBoost: inputs.dailyReports * PERFORMANCE_WEIGHTS.dailyReportBoost,
    presentCount: inputs.presentCount,
    presentBoost: inputs.attendanceBoost,
    propertyBookingContributions: inputs.propertyBookingContributions,
    propertyBookingBoost:
      inputs.propertyBookingContributions * PERFORMANCE_WEIGHTS.propertyBookingBoost,
    lateCount: inputs.lateCount,
    latePenalty: inputs.lateCount * PERFORMANCE_WEIGHTS.latePenalty,
    halfDayCount: inputs.halfDayCount,
    halfDayPenalty: inputs.halfDayCount * PERFORMANCE_WEIGHTS.halfDayPenalty,
    manualAdjustmentsTotal: inputs.manualAdjustmentsTotal,
    manualAdjustmentsCount: inputs.manualAdjustmentsCount,
    belowTargetEvents: inputs.belowTargetEvents,
    belowTargetPenalty: inputs.belowTargetEvents * PERFORMANCE_WEIGHTS.belowTargetPenalty,
    targetExceededEvents: inputs.targetExceededEvents,
    targetExceededBoost: inputs.targetExceededEvents * PERFORMANCE_WEIGHTS.targetExceededBoost,
    overdueTasks: inputs.overdueTasks,
    overduePenalty: inputs.overdueTasks * PERFORMANCE_WEIGHTS.overduePenalty,
    uninformedAbsentEvents: inputs.uninformedAbsentEvents,
    uninformedAbsentPenalty:
      inputs.uninformedAbsentEvents * PERFORMANCE_WEIGHTS.uninformedAbsentPenalty,
    midnightAutoCheckoutEvents: inputs.midnightAutoCheckoutEvents,
    midnightAutoCheckoutPenalty:
      inputs.midnightAutoCheckoutEvents * PERFORMANCE_WEIGHTS.midnightAutoCheckoutPenalty,
    missingDailyReportEvents: inputs.missingDailyReportEvents,
    missingDailyReportPenalty:
      inputs.missingDailyReportEvents * PERFORMANCE_WEIGHTS.missingDailyReportPenalty,
    completedAllWorkEvents: inputs.completedAllWorkEvents,
    completedAllWorkBoost:
      inputs.completedAllWorkEvents * PERFORMANCE_WEIGHTS.completedAllWorkBoost,
    tier,
    tierBoostMultiplier,
    tierPenaltyMultiplier,
    tierBoostBonus: 0,
    tierPenaltyExtra: 0,
  };

  const totalBoosts =
    breakdown.taskBoost +
    breakdown.reportBoost +
    breakdown.presentBoost +
    breakdown.propertyBookingBoost +
    breakdown.targetExceededBoost +
    breakdown.completedAllWorkBoost;
  const totalPenalties =
    breakdown.latePenalty +
    breakdown.halfDayPenalty +
    breakdown.belowTargetPenalty +
    breakdown.overduePenalty +
    breakdown.uninformedAbsentPenalty +
    breakdown.midnightAutoCheckoutPenalty +
    breakdown.missingDailyReportPenalty;

  const adjustedBoosts = totalBoosts * tierBoostMultiplier;
  const adjustedPenalties = totalPenalties * tierPenaltyMultiplier;
  breakdown.tierBoostBonus = roundPerformanceScore(adjustedBoosts - totalBoosts);
  breakdown.tierPenaltyExtra = roundPerformanceScore(adjustedPenalties - totalPenalties);

  const rawScore =
    PERFORMANCE_BASE_SCORE + adjustedBoosts - adjustedPenalties + breakdown.manualAdjustmentsTotal;

  return {
    score: roundPerformanceScore(rawScore),
    breakdown,
  };
}
