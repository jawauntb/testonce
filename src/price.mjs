// Runner price and formatting shared by the free `score` and the paid `report`.
// USD per minute for a GitHub-hosted standard Linux 2-core (x64) runner (label `actions_linux`): $0.006.
// Source: https://docs.github.com/en/billing/reference/actions-runner-pricing, table row
// "Linux 2-core (x64) | actions_linux | $0.006", fetched 2026-10-11. The page states no effective date.
// GitHub announced a hosted-runner price cut of "up to 39%" for 2026-01-01
// (https://github.com/resources/insights/2026-pricing-changes-for-github-actions); that page gives no
// per-runner figure. List price only: no free-minute allowance, plan discount or rounding is applied.
// Override with --price-per-minute (your own runners, larger runners, another CI).
export const DEFAULT_PRICE_PER_MINUTE = 0.006;
export const PRICE_LABEL = 'GitHub Actions standard Linux 2-core list price';

export function fmtMs(ms) {
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) return `${n} ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)} s`;
  const s = Math.round(n / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

export function fmtUsd(n) {
  return `$${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;
}

export const moneySaved = (savedMs, pricePerMinute) => (savedMs / 60000) * pricePerMinute;
