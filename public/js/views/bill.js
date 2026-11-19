// Bill view. Stub until task 8 fills it in.
import { register, t } from '../i18n.js';
import dict from '../i18n/bill.js';
import { esc, emptyState } from '../ui.js';

register(dict);

export async function render(root) {
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('bill.title'))}</h1></header>
    ${emptyState({ title: t('core.empty.soon'), body: t('core.empty.soonBody') })}`;
}
