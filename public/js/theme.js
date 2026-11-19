// Classic script in <head>: applies the saved theme before the first paint (absent means follow the device).
try {
  var saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch (e) { /* storage blocked: follow the device */ }
