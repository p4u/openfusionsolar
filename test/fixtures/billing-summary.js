// Hand-made /api/billing answers for the view tests (shape: src/billing.js billingSummary). No bill contents of anyone.
const days = (month) => ({ from: `${month}-01`, to: `${month}-28` });

// One bill view. verdict 'nodata' has no measured side, like compareInvoice answers under 90 % coverage.
export function bill(id, month, verdict = 'ok') {
  const nodata = verdict === 'nodata';
  return {
    id, month, period: days(month), total: 59.15,
    parts: { energy: 31.59, fixed: 20, taxes: 9, other: 1.59, surplus: 1.5 },
    kwh: { p1: 10, p2: 20, p3: 70 },
    prices: { p1: 0.249, p2: 0.169, p3: 0.15, surplus: 0.03 },
    compare: {
      days: 28, daysWithData: nodata ? 16 : 28, coverage: nodata ? 0.57 : 1, verdict,
      kwh: { billed: { p1: 10, p2: 20, p3: 70, total: 100 }, measured: nodata ? null : { p1: 11, p2: 20, p3: 69, total: 100 } },
      surplus: { billed: 50, measured: nodata ? null : 52, eur: 1.5, lostEur: 0 },
      estimateEnv: nodata ? null : 57.5, estimateBill: nodata ? null : 58,
      real: 59.15, loadKwh: nodata ? null : 300,
      diff: nodata ? null : { prices: 0.5, kwh: 0.1, other: 1.59 },
      savings: nodata ? null : { withoutSolar: 120, avoided: 60, surplusDiscount: 1.5, other: -0.65 },
    },
  };
}

export function summaryOf(invoices, extra = {}) {
  return {
    invoices,
    tiles: { total: 118.3, average: 59.15, pricePerKwh: 0.59, surplusDiscount: 3, bills: invoices.length, months: 12 },
    crossTiles: { homeCostPerKwh: 0.2, coveredPct: 66.7 },
    breakdown: { energy: { eur: 40, pct: 40 }, fixed: { eur: 30, pct: 30 }, taxes: { eur: 20, pct: 20 }, other: { eur: 10, pct: 10 } },
    missing: [], review: [], advice: [],
    ...extra,
  };
}
