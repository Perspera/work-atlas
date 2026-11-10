/** 展示格式化，口径与原前端保持一致。 */

export function num(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 0.8231 → 82.3% */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

/** 服务端金额已按万元返回 */
export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${num(value, 2)} 万`;
}

export function hours(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${num(value, 2)} h`;
}

export function clock(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
