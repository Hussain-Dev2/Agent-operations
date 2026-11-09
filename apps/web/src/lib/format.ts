export function formatBytes(bytes: number, locale: string): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, { style: "unit", unit: units[unit], unitDisplay: "short", maximumFractionDigits: 1 }).format(value);
}

export function formatDuration(seconds: number, locale: string): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const fmt = (n: number, unit: "day" | "hour" | "minute"): string =>
    new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(n);
  if (days > 0) return `${fmt(days, "day")} ${fmt(hours, "hour")}`;
  if (hours > 0) return `${fmt(hours, "hour")} ${fmt(minutes, "minute")}`;
  return fmt(minutes, "minute");
}
