// Technical data view. Stub until task 10 fills it in.
import { register, t } from '../i18n.js';
import dict from '../i18n/signals.js';
import { esc, emptyState } from '../ui.js';

register(dict);

export async function render(root) {
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('signals.title'))}</h1></header>
    ${emptyState({ title: t('core.empty.soon'), body: t('core.empty.soonBody') })}`;
}
