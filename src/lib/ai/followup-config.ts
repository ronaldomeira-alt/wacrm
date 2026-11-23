// ============================================================
// Tunables for follow-up generation (BLOCO 3/4) — centralized here,
// same discipline as lead-analysis-config.ts.
// ============================================================

/** A conversation is a follow-up candidate once it's been quiet for at least
 *  this long (12h allows leads who spoke yesterday to be prepared before the
 *  start of the morning workday while excluding active live chats). */
export const FOLLOWUP_MIN_HOURS_SINCE_CONTACT = 12;

/** Minimum cooldown after a human team member (Ronaldo/Tatiana) sent an outbound
 *  message without a subsequent customer reply, avoiding insistent duplicate nudges. */
export const FOLLOWUP_RECENT_TEAM_CONTACT_COOLDOWN_HOURS = 12;

/** Cap on how many candidates one cron run scores, so a large account
 *  with many stale conversations can't blow the run's time/cost budget
 *  in a single invocation — the rest are picked up on the next run. */
export const FOLLOWUP_MAX_CANDIDATES_PER_RUN = 25;

/** Below this score, a follow-up suggestion is not created at all —
 *  same "don't create noise on weak evidence" discipline as the
 *  pipeline-move suggestion threshold. */
export const FOLLOWUP_MIN_SCORE = 55;

/** Cap on how many due `scheduled_sends` rows one cron tick processes —
 *  same reasoning as FOLLOWUP_MAX_CANDIDATES_PER_RUN, so a backlog
 *  can't blow one run's time budget; the rest go out on the next tick. */
export const FOLLOWUP_MAX_SENDS_PER_RUN = 25;
