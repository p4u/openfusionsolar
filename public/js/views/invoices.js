// Bills view: stub until task 7 lands.
import { register, t } from '../i18n.js';
import dict from '../i18n/invoices.js';
import { esc, emptyState, moneyTabs } from '../ui.js';

register(dict);

export async function render(root, ctx) {
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('invoices.title'))}</h1></header>
    ${moneyTabs('invoices', ctx.params)}
    ${emptyState({ title: t('core.soon') })}`;
}
