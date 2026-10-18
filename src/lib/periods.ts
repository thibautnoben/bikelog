/** 'YYYY-MM' keys of the last `count` calendar months, oldest first, ending with the current month. */
export function lastMonths(count: number, now = new Date()): string[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

export function monthLabel(key: string, month: 'short' | 'long' = 'short'): string {
  return new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-GB', { month, year: 'numeric', timeZone: 'UTC' });
}

export function formatHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}
