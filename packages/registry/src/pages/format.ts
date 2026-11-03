const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Owner and name are validated by the registry; encoded anyway. */
export function registryPath(owner: string, name: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function versionPath(owner: string, name: string, version: string): string {
  return `${registryPath(owner, name)}?version=${encodeURIComponent(version)}`;
}

/** `Oct 19, 2026` from SQLite's `2026-10-19 03:12:44`, or the text as is when it isn't one. */
export function formatDate(timestamp: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(timestamp);
  if (!match) return timestamp;
  const [, year, month, day] = match;
  const monthName = MONTHS[Number(month) - 1];
  if (monthName === undefined) return timestamp;
  return `${monthName} ${Number(day)}, ${year}`;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
