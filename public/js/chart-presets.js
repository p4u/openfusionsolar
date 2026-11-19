// Chart presets shared by the billing summary (task 8) and the assistant (task 10). The list is final: task 9
// compares it with the server's. renderPreset is a stub until task 8 draws the real charts.
import { t } from './i18n.js';
import { emptyState } from './ui.js';

export const PRESET_TYPES = ['energy_bars', 'power_lines', 'battery_soc', 'import_by_period', 'bill_breakdown',
  'bill_real_vs_estimate', 'bill_kwh_vs_measured', 'price_per_kwh', 'savings'];

export function renderPreset(el) {
  el.innerHTML = emptyState({ title: t('core.soon') });
}
