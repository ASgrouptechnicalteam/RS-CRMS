/**
 * deriveTaskSlaStatus — Pure SLA state derivation from a Task record.
 *
 * Uses only existing Task model fields:
 *   - status (PENDING / COMPLETED / OVERDUE)
 *   - target_date (SLA deadline)
 *   - created_at (SLA start, not directly used in derivation)
 *   - completed_at (completion timestamp)
 *
 * Accepts `now` as a parameter for deterministic testing.
 * Does NOT mutate the task record.
 *
 * @param task Task record from the repository
 * @param now  Reference timestamp for breach/comparison (deterministic in tests)
 * @returns "ACTIVE" | "COMPLETED" | "BREACHED"
 */
export function deriveTaskSlaStatus(
  task: {
    status: string
    target_date: Date
    completed_at?: Date | null
    [key: string]: any
  },
  now: Date
): "ACTIVE" | "COMPLETED" | "BREACHED" {
  // COMPLETED takes absolute precedence per approved 15-1E semantics
  if (task.status === "COMPLETED") {
    return "COMPLETED"
  }

  // Breach: past deadline and not completed
  if (now > task.target_date) {
    return "BREACHED"
  }

  // Active: not completed, within deadline
  return "ACTIVE"
}