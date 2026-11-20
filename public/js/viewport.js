// Keyboard and viewport (spec 4.1). keyboardState is pure; watchViewport wires it to visualViewport: it sets --vvh on
// <html> and toggles .kb-open (which hides the tab bar). The same code serves browsers that resize the layout when the
// keyboard opens (Chrome, Samsung, Firefox on Android) and those that do not (iOS): both shrink visualViewport.height.
export const KB_MIN_PX = 120;

// baseline: the largest visual viewport height seen in the current orientation (0 when unknown). innerHeight and
// vvOffsetTop are accepted for the record but do not change the result: vvh is the visible height on every browser.
export function keyboardState({ innerHeight, vvHeight, vvOffsetTop = 0, baseline = 0 }) {
  const base = Math.max(baseline || 0, vvHeight);
  return { vvh: vvHeight, open: base - vvHeight > KB_MIN_PX, baseline: base };
}

// Device orientation, not the viewport's: with the keyboard open a phone viewport can be wider than tall.
const orientationOf = (win) => win.screen?.orientation?.type ?? ((win.screen?.width ?? 0) > (win.screen?.height ?? 0) ? 'landscape' : 'portrait');

// Returns a function that stops watching. Emits 'keyboardopen' on document when the keyboard opens.
export function watchViewport(win = globalThis) {
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const root = win.document.documentElement;
  let baseline = 0;
  let orientation = orientationOf(win);
  const update = () => {
    const now = orientationOf(win);
    if (now !== orientation) [orientation, baseline] = [now, 0];
    // a pinch zoom shrinks vv.height too: scaled back it is the full height, not a keyboard
    const s = keyboardState({ innerHeight: win.innerHeight, vvHeight: vv.height * (vv.scale || 1), vvOffsetTop: vv.offsetTop, baseline });
    baseline = s.baseline;
    root.style.setProperty('--vvh', `${Math.round(s.vvh)}px`);
    const was = root.classList.contains('kb-open');
    root.classList.toggle('kb-open', s.open);
    if (s.open && !was) win.document.dispatchEvent(new CustomEvent('keyboardopen'));
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
  };
}
