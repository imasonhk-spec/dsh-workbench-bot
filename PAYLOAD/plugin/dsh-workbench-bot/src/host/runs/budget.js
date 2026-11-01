const ACTIVE = new Set(['planning', 'discussing', 'running', 'validating'])

export function accountRunTime(run, now = Date.now()) {
  run.activeMs = (run.activeMs || 0) + (run.activeSince == null ? 0 : Math.max(0, now - run.activeSince))
  run.activeSince = ACTIVE.has(run.state) ? now : null
}
