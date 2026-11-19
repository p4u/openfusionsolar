// Energy view. Stub until task 6 fills it in.
import { register, t } from '../i18n.js';
import dict from '../i18n/energy.js';
import { esc, emptyState } from '../ui.js';

register(dict);

export async function render(root) {
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('energy.title'))}</h1></header>
    ${emptyState({ title: t('core.empty.soon'), body: t('core.empty.soonBody') })}`;
}
