// Router tables, no DOM (app.js, ui.js and the tests import them). Hash path to view module: Forecast is the old
// estimate view (module `bill`), reached at #/forecast; #/money is now the billing summary.
export const ROUTES = {
  '': 'now', energy: 'energy', battery: 'battery', panels: 'panels', money: 'billing', invoices: 'invoices',
  forecast: 'bill', assistant: 'assistant', incidents: 'incidents', signals: 'signals', settings: 'settings',
};
export const PATHS = Object.fromEntries(Object.entries(ROUTES).map(([path, name]) => [name, path]));
export const CARRIED = ['r', 'd', 'from', 'to', 'cmp', 'b']; // the time range follows the user across these views
export const RANGED = new Set(['energy', 'battery', 'panels', 'bill', 'billing', 'invoices', 'incidents', 'signals']);
export const IN_SHEET = new Set(['panels', 'incidents', 'signals', 'settings']);
// a child view keeps its parent's nav link and tab current
export const PARENT = { invoices: 'billing', bill: 'billing' };
