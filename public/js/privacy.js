// The one-time notice about what leaves the server when the assistant reads a bill or answers a question.
import { t } from './i18n.js';
import { esc } from './ui.js';

const KEY = 'ofs.aiNotice';

const accepted = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

// Resolves true once the notice is accepted (now or before), false when the user prefers to do it by hand.
export function ensureAiNotice() {
  if (accepted()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'sheet';
    dialog.setAttribute('aria-labelledby', 'ai-notice-title');
    dialog.innerHTML = `<h2 id="ai-notice-title" class="view-title">${esc(t('core.privacy.title'))}</h2>
      <p>${esc(t('core.privacy.body'))}</p>
      <div class="actions">
        <button type="button" class="pill pill-primary" data-answer="yes">${esc(t('core.privacy.ok'))}</button>
        <button type="button" class="pill pill-outline" data-answer="no">${esc(t('core.privacy.manual'))}</button>
      </div>`;
    let answer = false;
    dialog.addEventListener('click', (e) => {
      const choice = e.target.closest('[data-answer]')?.dataset.answer;
      if (!choice) return;
      answer = choice === 'yes';
      if (answer) {
        try {
          localStorage.setItem(KEY, '1');
        } catch { /* asked again next time */ }
      }
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer); // Escape counts as "by hand"
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// Permanent copy for Settings.
export const aiNoticeHtml = () => `<h3>${esc(t('core.privacy.settingsTitle'))}</h3><p>${esc(t('core.privacy.body'))}</p>`;
