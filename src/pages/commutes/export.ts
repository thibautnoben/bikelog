import type { APIRoute } from 'astro';
import { listBikes, listCommutes, listCommutesInMonth } from '../../lib/db';
import { commutesCsv } from '../../lib/commuteReport';

/** CSV download of the commutes in one month (`?month=YYYY-MM`, athlete's local time) or, without it, all of them. */
export const GET: APIRoute = async ({ locals, url }) => {
  const athlete = locals.athlete!;
  const month = url.searchParams.get('month');
  if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return new Response('month must be YYYY-MM', { status: 400 });
  }
  const [commutes, bikes] = await Promise.all([
    month ? listCommutesInMonth(athlete.id, month) : listCommutes(athlete.id),
    listBikes(athlete.id),
  ]);
  const csv = commutesCsv(commutes, new Map(bikes.map((b) => [b.id, b.name])));
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="commutes-${month ?? 'all'}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
};
