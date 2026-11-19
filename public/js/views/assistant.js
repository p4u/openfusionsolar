// Assistant view: stub until task 10 lands.
import { register, t } from '../i18n.js';
import dict from '../i18n/assistant.js';
import { esc, emptyState } from '../ui.js';

register(dict);

export async function render(root) {
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('assistant.title'))}</h1></header>
    ${emptyState({ title: t('core.soon') })}`;
}
