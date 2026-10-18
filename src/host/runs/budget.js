const ACTIVE = new Set(['planning', 'discussing', 'running', 'validating'])

export function accountRunTime(run, now = Date.now()) {
  run.activeMs = (run.activeMs || 0) + (run.activeSince == null ? 0 : Math.max(0, now - run.activeSince))
  run.activeSince = ACTIVE.has(run.state) ? now : null
}

export function budgetExhausted(run, now = Date.now()) {
  const { budget: b, usage: u } = run
  const activeMs = (run.activeMs || 0) + (ACTIVE.has(run.state) && run.activeSince != null ? Math.max(0, now - run.activeSince) : 0)
  return u.requests >= b.maxRequests || u.turns >= b.maxTurns || u.tokens >= b.maxTokens || activeMs >= b.maxMinutes * 60000
}
