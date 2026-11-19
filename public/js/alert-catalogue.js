// Alert catalogue shared by the server (src/alerts.js) and the Settings page: groups, urgency and presets.

export const GROUPS = {
  urgent: ['gridCut', 'backupOverload', 'batteryLowInCut'], // sent at once, also during quiet hours
  problems: ['noData', 'collectorDown', 'belowReserve', 'panelsStopped', 'deviceAlarm', 'powerLimit'],
  reports: ['weeklySummary', 'monthlyReport', 'dailySummary'],
};

// What a new address receives ("Everything important").
export const DEFAULT_ON = [...GROUPS.urgent, 'noData', 'collectorDown', 'belowReserve', 'panelsStopped', 'deviceAlarm',
  'weeklySummary', 'monthlyReport'];

export const PRESETS = {
  important: DEFAULT_ON,
  urgent: GROUPS.urgent,
  reports: ['weeklySummary', 'monthlyReport'],
};

// The preset a list of ids matches, or 'custom'.
export function presetOf(ids) {
  const set = new Set(ids);
  for (const [name, list] of Object.entries(PRESETS)) if (list.length === set.size && list.every((id) => set.has(id))) return name;
  return 'custom';
}
