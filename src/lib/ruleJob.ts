import {
  claimRuleJobItems,
  finishRuleJobItem,
  getAthlete,
  listRules,
  markStale,
  pauseRuleJob,
  ruleJobProgress,
  type RuleJobProgress,
} from './db';
import { applyRule } from './gearRules';
import { RateLimitError, accessToken, getActivity, type StravaActivity } from './strava';

const BATCH_SIZE = 5;

/**
 * Applies queued rules to past rides until `budgetMs` runs out, the queue is empty, or Strava's rate
 * limit is hit (then the queue pauses until the limit resets). Safe to run concurrently: items are
 * claimed atomically. Returns the progress afterwards.
 */
export async function processRuleJob(athleteId: number, budgetMs: number): Promise<RuleJobProgress | null> {
  const deadline = Date.now() + budgetMs;
  const athlete = await getAthlete(athleteId);
  if (!athlete) return null;
  if (athlete.rule_job_paused_until && athlete.rule_job_paused_until > Date.now() / 1000) {
    return ruleJobProgress(athleteId);
  }

  const rules = await listRules(athleteId);
  let changedAny = false;

  claiming: while (Date.now() < deadline) {
    const items = await claimRuleJobItems(athleteId, BATCH_SIZE);
    if (items.length === 0) break;

    for (const [i, item] of items.entries()) {
      // Out of time: hand the rest of this batch back to the queue.
      if (Date.now() >= deadline) {
        for (const rest of items.slice(i)) await finishRuleJobItem(athleteId, rest.activity_id, 'pending');
        break claiming;
      }
      const rule = rules.find((r) => r.id === item.rule_id);
      if (!rule) {
        await finishRuleJobItem(athleteId, item.activity_id, 'failed', 'The rule was deleted');
        continue;
      }
      try {
        let activity = JSON.parse(item.activity_json) as StravaActivity;
        // Descriptions and private notes are only in the detailed activity; fetch it so unchanged
        // ones aren't rewritten. Other fields can be compared using the queued summary.
        if (rule.set_description || rule.set_private_note) {
          activity = await getActivity(await accessToken(athlete), item.activity_id);
        }
        const changed = await applyRule(athlete, activity, rule, 'manual');
        changedAny ||= changed;
        await finishRuleJobItem(athleteId, item.activity_id, changed ? 'changed' : 'unchanged');
      } catch (e) {
        if (e instanceof RateLimitError) {
          for (const rest of items.slice(i)) await finishRuleJobItem(athleteId, rest.activity_id, 'pending');
          await pauseRuleJob(athleteId, e.retryAt);
          break claiming;
        }
        await finishRuleJobItem(athleteId, item.activity_id, 'failed', e instanceof Error ? e.message : String(e));
      }
    }
  }

  if (changedAny) await markStale(athleteId);
  return ruleJobProgress(athleteId);
}
