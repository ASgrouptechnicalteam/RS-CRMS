/**
 * performance-metric.ts — Pure performance score calculation.
 *
 * Centralizes the base-50.0 event-aggregated performance score used by the
 * /performance routes. Follows the repository's pure-calculation pattern
 * (see task-sla.status.ts): no HTTP, no Express, no DB writes, deterministic,
 * and unit-testable.
 *
 * NOTES ON THE EXISTING FORMULAS (behavior preserved):
 *  - /performance/my-score and /performance/team share the FULL formula.
 *  - /performance/leaderboard intentionally uses a REDUCED formula that only
 *    counts completed tasks + daily reports (no attendance or penalties).
 *  These differences are preserved; they are NOT normalized here.
 */

export const PERFORMANCE_BASE_SCORE = 50.0;

export const PERFORMANCE_WEIGHTS = {
  completedTaskBoost: 2.0,
  dailyReportBoost: 0.5,
  presentBoost: 0.5,
  propertyBookingBoost: 10.0,
  targetExceededBoost: 0.5,
  latePenalty: 1.0,
  halfDayPenalty: 1.0,
  belowTargetPenalty: 1.0,
  overduePenalty: 1.0,
  uninformedAbsentPenalty: 2.0,
} as const;

export interface PerformanceScoreInputs {
  completedTasks: number;
  overdueTasks: number;
  dailyReports: number;
  belowTargetEvents: number;
  targetExceededEvents: number;
  uninformedAbsentEvents: number;
  propertyBookingContributions: number;
  presentCount: number;
  lateCount: number;
  halfDayCount: number;
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
  belowTargetEvents: number;
  belowTargetPenalty: number;
  targetExceededEvents: number;
  targetExceededBoost: number;
  overdueTasks: number;
  overduePenalty: number;
  uninformedAbsentEvents: number;
  uninformedAbsentPenalty: number;
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
  belowTargetEvents: 0,
  belowTargetPenalty: 0,
  targetExceededEvents: 0,
  targetExceededBoost: 0,
  overdueTasks: 0,
  overduePenalty: 0,
  uninformedAbsentEvents: 0,
  uninformedAbsentPenalty: 0,
};

/** Round a raw score to one decimal place and clamp to 0 (lower bound). */
export function roundPerformanceScore(rawScore: number): number {
  return Math.max(0, Math.round(rawScore * 10) / 10);
}

/**
 * Full performance score — shared by /performance/my-score and /performance/team.
 * Pure: does not mutate the input and performs no database access.
 */
export function calculatePerformanceScore(inputs: PerformanceScoreInputs): PerformanceScoreResult {
  const breakdown: PerformanceScoreBreakdown = {
    ...ZERO_BREAKDOWN,
    completedTasks: inputs.completedTasks,
    taskBoost: inputs.completedTasks * PERFORMANCE_WEIGHTS.completedTaskBoost,
    dailyReports: inputs.dailyReports,
    reportBoost: inputs.dailyReports * PERFORMANCE_WEIGHTS.dailyReportBoost,
    presentCount: inputs.presentCount,
    presentBoost: inputs.presentCount * PERFORMANCE_WEIGHTS.presentBoost,
    propertyBookingContributions: inputs.propertyBookingContributions,
    propertyBookingBoost: inputs.propertyBookingContributions * PERFORMANCE_WEIGHTS.propertyBookingBoost,
    lateCount: inputs.lateCount,
    latePenalty: inputs.lateCount * PERFORMANCE_WEIGHTS.latePenalty,
    halfDayCount: inputs.halfDayCount,
    halfDayPenalty: inputs.halfDayCount * PERFORMANCE_WEIGHTS.halfDayPenalty,
    belowTargetEvents: inputs.belowTargetEvents,
    belowTargetPenalty: inputs.belowTargetEvents * PERFORMANCE_WEIGHTS.belowTargetPenalty,
    targetExceededEvents: inputs.targetExceededEvents,
    targetExceededBoost: inputs.targetExceededEvents * PERFORMANCE_WEIGHTS.targetExceededBoost,
    overdueTasks: inputs.overdueTasks,
    overduePenalty: inputs.overdueTasks * PERFORMANCE_WEIGHTS.overduePenalty,
    uninformedAbsentEvents: inputs.uninformedAbsentEvents,
    uninformedAbsentPenalty: inputs.uninformedAbsentEvents * PERFORMANCE_WEIGHTS.uninformedAbsentPenalty,
  };

  const rawScore = PERFORMANCE_BASE_SCORE
    + breakdown.taskBoost
    + breakdown.reportBoost
    + breakdown.presentBoost
    + breakdown.propertyBookingBoost
    + breakdown.targetExceededBoost
    - breakdown.latePenalty
    - breakdown.halfDayPenalty
    - breakdown.belowTargetPenalty
    - breakdown.overduePenalty
    - breakdown.uninformedAbsentPenalty;

  return {
    score: roundPerformanceScore(rawScore),
    breakdown,
  };
}
