// Worker entrypoint (`main` in wrangler.jsonc): Astro handles requests, the cron trigger sends the
// monthly commute report.
import { handle } from '@astrojs/cloudflare/handler';
import { sendMonthlyCommuteReports } from './lib/commuteReport';

export default {
  fetch: handle,
  async scheduled(controller, _env, ctx) {
    await sendMonthlyCommuteReports((p) => ctx.waitUntil(p), new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
