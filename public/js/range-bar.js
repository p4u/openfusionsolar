// Range bar: preset radio group (a preset select on phones), previous/next, custom dialog, compare and (advanced) bucket selects.
// onChange(patch) receives URL params (null deletes a key); views pass (p) => ctx.setParams(p).
import { register, t, locale } from './i18n.js';
import dict from './i18n/charts.js';
import { PRESETS, COMPARES, parseRange, rangeParams, stepRange, rangeLabel } from './range.js';
import { legalSeriesBuckets, legalEnergyBuckets } from './buckets.js';
import { esc, icon, overlay } from './ui.js';

register(dict);
let uid = 0;

export function renderRangeBar(container, { range, ctx, mode = null, compare = true, onChange }) {
  const id = `rb${++uid}`;
  const prev = stepRange(range, -1, ctx);
  const next = stepRange(range, 1, ctx);
  const buckets = mode ? (mode === 'power' ? legalSeriesBuckets : legalEnergyBuckets)(range.days) : [];
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;

  container.innerHTML = `<div class="range-bar">
    <div class="segmented range-presets" role="radiogroup" aria-label="${esc(t('charts.range.label'))}">${PRESETS.map((p) =>
      `<label><input type="radio" name="${id}" value="${p}"${p === range.r ? ' checked' : ''}>${esc(t(`charts.range.${p}`))}</label>`).join('')}</div>
    <div class="field range-field range-preset"><label class="sr-only" for="${id}-preset">${esc(t('charts.range.label'))}</label>
      <select id="${id}-preset">${PRESETS.map((p) => opt(p, t(`charts.range.${p}`), range.r)).join('')}</select></div>
    <div class="range-step">
      <button type="button" class="pill pill-outline pill-icon" data-step="-1" aria-label="${esc(t('charts.range.prev'))}"${prev ? '' : ' disabled'}>${icon('chevron-left')}</button>
      <span class="range-label num" aria-live="polite">${esc(rangeLabel(range, locale()))}</span>
      <button type="button" class="pill pill-outline pill-icon" data-step="1" aria-label="${esc(t('charts.range.next'))}"${next ? '' : ' disabled'}>${icon('chevron-right')}</button>
    </div>
    ${compare ? `<div class="field range-field"><label class="sr-only" for="${id}-cmp">${esc(t('charts.compare.label'))}</label>
      <select id="${id}-cmp">${COMPARES.map((c) => opt(c, t(`charts.compare.${c}`), range.cmp)).join('')}</select></div>` : ''}
    ${mode ? `<details class="disclosure range-advanced"><summary aria-label="${esc(t('charts.advanced'))}" title="${esc(t('charts.advanced'))}"><span class="range-advanced-icon">${icon('sliders-horizontal', { size: 20 })}</span><span class="range-advanced-text">${esc(t('charts.advanced'))}</span><span class="range-advanced-chevron">${icon('chevron-down', { size: 16 })}</span></summary>
      <div class="field range-field"><label for="${id}-b">${esc(t('charts.bucket.label'))}</label>
        <select id="${id}-b">${opt('auto', t('charts.bucket.auto'), range.b)}${buckets.map((b) => opt(b, t(`charts.bucket.${b}`), range.b)).join('')}</select></div></details>` : ''}
    <dialog class="range-dialog" aria-labelledby="${id}-title"><form method="dialog">
      <h2 id="${id}-title" class="card-title">${esc(t('charts.range.customTitle'))}</h2>
      <div class="field"><label for="${id}-from">${esc(t('charts.range.from'))}</label>
        <input type="date" id="${id}-from" required min="${esc(ctx.firstDay ?? '')}" max="${esc(ctx.today)}" value="${esc(range.from)}"></div>
      <div class="field"><label for="${id}-to">${esc(t('charts.range.to'))}</label>
        <input type="date" id="${id}-to" required min="${esc(ctx.firstDay ?? '')}" max="${esc(ctx.today)}" value="${esc(range.to)}"></div>
      <div class="range-dialog-actions">
        <button type="button" class="pill pill-outline" data-cancel>${esc(t('charts.range.cancel'))}</button>
        <button type="submit" class="pill pill-primary">${esc(t('charts.range.apply'))}</button></div>
    </form></dialog>
  </div>`;

  const q = (s) => container.querySelector(s);
  const dialog = q('dialog');
  const sheet = overlay(dialog);
  const emit = (r) => onChange(rangeParams(r));
  // a new period resets the bucket: a legal one for the old span may be illegal for the new one
  const keep = { cmp: range.cmp, b: 'auto' };
  const restore = () => {
    q(`input[name="${id}"][value="${range.r}"]`).checked = true;
    q(`#${id}-preset`).value = range.r;
  };

  const onPreset = (e) => {
    if (e.target.name !== id && e.target.id !== `${id}-preset`) return;
    if (e.target.value === 'custom') sheet.open();
    else emit(parseRange({ r: e.target.value, ...keep }, ctx));
  };
  const onClick = (e) => {
    const step = e.target.closest('[data-step]');
    if (step) {
      const r = stepRange(range, Number(step.dataset.step), ctx);
      if (r) emit({ ...r, ...keep });
    } else if (e.target.closest('[data-cancel]')) dialog.close();
    // a click on the already selected "Custom" radio does not fire change: reopen the dialog
    else if (e.target.name === id && e.target.value === 'custom' && range.r === 'custom') sheet.open();
  };
  const onSubmit = (e) => {
    e.preventDefault();
    const [from, to] = [q(`#${id}-from`).value, q(`#${id}-to`).value];
    dialog.close();
    // after the dialog's history entry is popped, or that pop would undo the new range
    sheet.closed().then(() => emit(parseRange({ r: 'custom', from, to, ...keep }, ctx)));
  };
  const onSelect = (e) => {
    if (e.target.id === `${id}-cmp`) emit({ ...range, cmp: e.target.value });
    else if (e.target.id === `${id}-b`) emit({ ...range, b: e.target.value });
  };
  container.addEventListener('change', onPreset);
  container.addEventListener('change', onSelect);
  container.addEventListener('click', onClick);
  dialog.addEventListener('submit', onSubmit);
  dialog.addEventListener('close', restore);

  return {
    destroy() {
      container.removeEventListener('change', onPreset);
      container.removeEventListener('change', onSelect);
      container.removeEventListener('click', onClick);
      if (dialog.open) dialog.close();
      container.replaceChildren();
    },
  };
}
