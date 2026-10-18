import type { APIRoute } from 'astro';
import { ruleJobProgress } from '../../lib/db';
import { processRuleJob } from '../../lib/ruleJob';

/** Progress of the "apply rules to past rides" queue. */
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.athlete) return new Response(null, { status: 401 });
  return Response.json(await ruleJobProgress(locals.athlete.id));
};

/** Called by the rules page while it is open: processes the next batch and returns progress. */
export const POST: APIRoute = async ({ locals }) => {
  if (!locals.athlete) return new Response(null, { status: 401 });
  return Response.json(await processRuleJob(locals.athlete.id, 8000));
};
