// Static files: safe path resolution under public/, plus whitelisted fonts and the icon sprite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url));

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};
const SERVED = new Set(['.html', '.js', '.css', '.svg', '.webmanifest', '.png']);

export function resolveStatic(root, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  // a segment starting with '.' covers '..', dotfiles and dot directories
  if (p.includes('\0') || p.split(/[/\\]/).some((s) => s.startsWith('.'))) return null;
  const base = path.resolve(root);
  const abs = path.join(base, p);
  if (!abs.startsWith(base + path.sep) || !SERVED.has(path.extname(abs))) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

const font = (pkg, file) => path.join(MODULES, '@fontsource-variable', pkg, 'files', file);
export const FONTS = Object.freeze({
  '/fonts/inter-latin-wght-normal.woff2': font('inter', 'inter-latin-wght-normal.woff2'),
  '/fonts/inter-latin-ext-wght-normal.woff2': font('inter', 'inter-latin-ext-wght-normal.woff2'),
  '/fonts/eb-garamond-latin-wght-normal.woff2': font('eb-garamond', 'eb-garamond-latin-wght-normal.woff2'),
  '/fonts/eb-garamond-latin-ext-wght-normal.woff2': font('eb-garamond', 'eb-garamond-latin-ext-wght-normal.woff2'),
});

const LUCIDE_DIR = path.join(MODULES, 'lucide-static', 'icons');

export const ICONS = Object.freeze([
  'sun', 'house', 'utility-pole', 'battery-medium', 'battery-charging', 'battery-warning', 'zap', 'zap-off', 'wifi-off',
  'triangle-alert', 'circle-check', 'info', 'clock', 'calendar', 'chevron-left', 'chevron-right', 'download', 'table',
  'bell', 'bell-off', 'settings', 'log-out', 'languages', 'moon', 'sun-medium', 'activity', 'euro', 'cpu', 'refresh-cw',
  'x', 'ellipsis', 'mail', 'thermometer', 'gauge', 'circle-alert', 'chevron-down', 'check', 'plug-zap', 'rotate-ccw',
  'sliders-horizontal', 'book-open', 'calendar-range', 'sun-moon', 'eye', 'eye-off',
]);

// Stroke attributes live on the outer <svg> and are dropped: CSS `.icon` sets them.
export function buildSprite(dir = LUCIDE_DIR) {
  const symbols = ICONS.map((name) => {
    const src = fs.readFileSync(path.join(dir, `${name}.svg`), 'utf8');
    const inner = /<svg\b[^>]*>([\s\S]*?)<\/svg>/.exec(src)?.[1];
    if (inner == null) throw new Error(`icon ${name}: no <svg> element`);
    return `<symbol id="${name}" viewBox="0 0 24 24">${inner.trim().replace(/\s*\n\s*/g, '')}</symbol>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>`;
}
