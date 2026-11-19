// Login page. No inline script (CSP). The DOM wiring is guarded so tests can import safeNext under Node.

// Where to go after login: only a path on this origin, anything else goes home (no open redirect).
export function safeNext(next, origin) {
  try {
    const u = new URL(next || '/', origin);
    return u.origin === origin ? u.pathname + u.search + u.hash : '/';
  } catch {
    return '/';
  }
}

if (typeof document !== 'undefined') {
  const form = document.getElementById('login');
  const error = document.getElementById('login-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: form.password.value }),
      });
      if (res.status === 204) {
        location.assign(safeNext(new URLSearchParams(location.search).get('next'), location.origin));
      } else if (res.status === 429) {
        error.textContent = `Too many attempts. Try again in ${Math.ceil(Number(res.headers.get('retry-after')) / 60)} min.`;
      } else {
        error.textContent = res.status === 401 ? 'Wrong password.' : 'Login failed. Try again.';
      }
    } catch {
      error.textContent = 'Cannot reach the server.';
    }
  });
}
