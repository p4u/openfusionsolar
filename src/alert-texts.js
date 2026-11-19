// Alert email texts in Catalan and English. Each email: what happened, what to do, link to the app.
// `x` holds the formatters for the language: time(ts), dur(ms), kwh(v), eur(v), pct(v), day(ts), month('YYYY-MM').

const T = {
  en: {
    noData: {
      fired: (f, x) => `no data since ${x.time(f.since)}${f.authBlocked ? ': the FusionSolar login is failing' : ''}`,
      resolved: () => 'data is arriving again',
      todo: (f) => (f.authBlocked
        ? 'Check the FusionSolar user and password in the .env file and restart the app.'
        : 'Check that the router and the inverter dongle are on and online. During a power cut data arrives once it ends.'),
    },
    gridCut: {
      fired: (f, x) => `power cut since ${x.time(f.start)}`,
      past: (f, x) => `there was a power cut from ${x.time(f.start)} to ${x.time(f.end)}`,
      resolved: (f, x) => `power is back after ${x.dur(f.end - f.start)}`,
      detail: (f, x) => [
        f.past ? `It lasted ${x.dur(f.end - f.start)}.` : f.end ? `The cut went from ${x.time(f.start)} to ${x.time(f.end)}.` : '',
        f.end ? x.covered(f.batteryCovered) : '',
      ],
      todo: () => 'Keep consumption low so the battery lasts. FusionSolar reports cuts with some delay.',
    },
    batteryLowInCut: {
      fired: (f, x) => `battery at ${x.pct(f.soc)} during a power cut`,
      resolved: () => 'the battery is no longer low or the cut is over',
      todo: () => 'Switch off large loads: the battery will run out soon.',
    },
    batteryLow: {
      fired: (f, x) => `FusionSolar reports a low battery since ${x.time(f.start)}`,
      past: (f, x) => `FusionSolar reported a low battery from ${x.time(f.start)} to ${x.time(f.end)}`,
      resolved: () => 'the low battery alarm has cleared',
      todo: () => 'Check the battery settings in FusionSolar and keep consumption low.',
    },
    belowReserve: {
      fired: (f, x) => `battery at ${x.pct(f.soc)}, below the ${x.pct(f.reservePct)} reserve`,
      resolved: () => 'the battery is back above the reserve',
      todo: () => 'Check that the battery can charge (grid charging and its limit in FusionSolar).',
    },
    panelsStopped: {
      fired: (f, x) => `the panels produced nothing from ${x.time(f.start)} to ${x.time(f.end)}`,
      resolved: () => 'the panels are producing again',
      todo: () => 'Check the inverter and its breaker. Snow or a fault can stop production.',
    },
    deviceAlarm: {
      fired: (f) => `alarm: ${f.name} (${f.device})`,
      past: (f, x) => `there was an alarm from ${x.time(f.start)} to ${x.time(f.end)}: ${f.name} (${f.device})`,
      resolved: (f) => `alarm cleared: ${f.name}`,
      todo: () => 'Open FusionSolar for the alarm details and the suggested fix.',
    },
    dailySummary: { fact: (f, x) => `summary for ${x.day(f.day)}` },
    monthlyReport: { fact: (f, x) => `${x.month(f.month)} summary` },
    lines: {
      pv: 'Produced', load: 'Consumed', imp: 'Bought', exp: 'Sold', cost: 'Energy cost', bill: 'Bill estimate',
      savings: 'Savings thanks to solar', incidents: 'Incidents', yoy: 'Same month last year',
    },
    yoy: (y, x) => `produced ${x.kwh(y.pv)}, consumed ${x.kwh(y.load)}${y.bill == null ? '' : `, bill ${x.eur(y.bill)}`}`,
    covered: (v) => ({
      true: 'The battery kept the house powered.',
      false: 'The battery did not power the house.',
      overload: 'The battery could not carry the load (overload): the house went dark.',
    })[v] ?? 'There is no data on whether the battery covered the house.',
    reminder: (fact) => `still ${fact}`,
    resolvedTodo: 'Nothing to do.',
    digest: (n) => `${n} ${n === 1 ? 'alert' : 'alerts'} during quiet hours`,
    digestTodo: 'These alerts were held during quiet hours. Open the app to see if any is still active.',
    test: 'test email',
    testBody: 'Alert emails from this app reach this address.',
    link: (url) => `Open the app: ${url}`,
  },
  ca: {
    noData: {
      fired: (f, x) => `sense dades des de les ${x.time(f.since)}${f.authBlocked ? ": l'inici de sessió a FusionSolar falla" : ''}`,
      resolved: () => 'tornen a arribar dades',
      todo: (f) => (f.authBlocked
        ? "Comprova l'usuari i la contrasenya de FusionSolar al fitxer .env i reinicia l'aplicació."
        : "Comprova que el router i el dongle de l'inversor estiguin engegats i connectats. Durant un tall, les dades arriben quan s'acaba."),
    },
    gridCut: {
      fired: (f, x) => `tall de corrent des de les ${x.time(f.start)}`,
      past: (f, x) => `hi ha hagut un tall de corrent de ${x.time(f.start)} a ${x.time(f.end)}`,
      resolved: (f, x) => `torna a haver-hi corrent després de ${x.dur(f.end - f.start)}`,
      detail: (f, x) => [
        f.past ? `Ha durat ${x.dur(f.end - f.start)}.` : f.end ? `El tall ha anat de ${x.time(f.start)} a ${x.time(f.end)}.` : '',
        f.end ? x.covered(f.batteryCovered) : '',
      ],
      todo: () => 'Redueix el consum perquè la bateria duri. FusionSolar informa dels talls amb cert retard.',
    },
    batteryLowInCut: {
      fired: (f, x) => `bateria al ${x.pct(f.soc)} durant un tall de corrent`,
      resolved: () => "la bateria ja no està baixa o el tall s'ha acabat",
      todo: () => "Apaga els aparells grans: la bateria s'acabarà aviat.",
    },
    batteryLow: {
      fired: (f, x) => `FusionSolar avisa de bateria baixa des de les ${x.time(f.start)}`,
      past: (f, x) => `FusionSolar ha avisat de bateria baixa de ${x.time(f.start)} a ${x.time(f.end)}`,
      resolved: () => "l'avís de bateria baixa s'ha esborrat",
      todo: () => 'Revisa la configuració de la bateria a FusionSolar i redueix el consum.',
    },
    belowReserve: {
      fired: (f, x) => `bateria al ${x.pct(f.soc)}, per sota de la reserva del ${x.pct(f.reservePct)}`,
      resolved: () => 'la bateria torna a estar per sobre de la reserva',
      todo: () => 'Comprova que la bateria pot carregar (càrrega des de la xarxa i el seu límit a FusionSolar).',
    },
    panelsStopped: {
      fired: (f, x) => `les plaques no han produït res de ${x.time(f.start)} a ${x.time(f.end)}`,
      resolved: () => 'les plaques tornen a produir',
      todo: () => "Revisa l'inversor i el seu magnetotèrmic. La neu o una avaria poden aturar la producció.",
    },
    deviceAlarm: {
      fired: (f) => `alarma: ${f.name} (${f.device})`,
      past: (f, x) => `hi ha hagut una alarma de ${x.time(f.start)} a ${x.time(f.end)}: ${f.name} (${f.device})`,
      resolved: (f) => `alarma resolta: ${f.name}`,
      todo: () => "Obre FusionSolar per veure el detall de l'alarma i la solució proposada.",
    },
    dailySummary: { fact: (f, x) => `resum del ${x.day(f.day)}` },
    monthlyReport: { fact: (f, x) => `resum de ${x.month(f.month)}` },
    lines: {
      pv: 'Produït', load: 'Consumit', imp: 'Comprat', exp: 'Venut', cost: "Cost de l'energia", bill: 'Factura estimada',
      savings: 'Estalvi gràcies al sol', incidents: 'Incidències', yoy: "Mateix mes de l'any passat",
    },
    yoy: (y, x) => `produït ${x.kwh(y.pv)}, consumit ${x.kwh(y.load)}${y.bill == null ? '' : `, factura ${x.eur(y.bill)}`}`,
    covered: (v) => ({
      true: 'La bateria ha mantingut la casa amb corrent.',
      false: 'La bateria no ha alimentat la casa.',
      overload: "La bateria no ha pogut amb la càrrega (sobrecàrrega): la casa s'ha quedat sense corrent.",
    })[v] ?? 'No hi ha dades per saber si la bateria ha cobert la casa.',
    reminder: (fact) => `continua: ${fact}`,
    resolvedTodo: 'No cal fer res.',
    digest: (n) => `${n} ${n === 1 ? 'avís' : 'avisos'} durant les hores de silenci`,
    digestTodo: "Aquests avisos s'han retingut durant les hores de silenci. Obre l'aplicació per veure si algun continua actiu.",
    test: 'correu de prova',
    testBody: "Els avisos per correu d'aquesta aplicació arriben a aquesta adreça.",
    link: (url) => `Obre l'aplicació: ${url}`,
  },
};

const LOCALE = { ca: 'ca-ES', en: 'en-GB' };
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const p2 = (n) => String(n).padStart(2, '0');

function formatters(lang, ref) {
  const locale = LOCALE[lang];
  const n1 = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  return {
    // plant-local HH:MM, with the date when it is not the day of the email
    time: (ts) => {
      const d = new Date(ts);
      return `${sameDay(ts, ref) ? '' : `${d.getDate()}/${d.getMonth() + 1} `}${p2(d.getHours())}:${p2(d.getMinutes())}`;
    },
    dur: (ms) => {
      const m = Math.max(0, Math.round(ms / 60e3));
      return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
    },
    kwh: (v) => `${n1.format(v)} kWh`,
    eur: (v) => money.format(v),
    pct: (v) => `${n1.format(v)} %`,
    day: (day) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${day}T12:00`)),
    month: (m) => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(`${m}-15T12:00`)),
  };
}

// One-line fact for an alert (also used for digest lines).
function fact(t, x, d) {
  const r = t[d.rule];
  const f = d.facts ?? {};
  if (d.event === 'report') return r.fact(f, x);
  if (d.event === 'resolved') return r.resolved(f, x);
  const fired = f.past && r.past ? r.past(f, x) : r.fired(f, x);
  return d.event === 'reminder' ? t.reminder(fired) : fired;
}

function reportLines(t, x, f) {
  const L = t.lines;
  const rows = [
    ['pv', f.pv, x.kwh], ['load', f.load, x.kwh], ['imp', f.imp, x.kwh], ['exp', f.exp, x.kwh],
    ['cost', f.cost, x.eur], ['bill', f.bill, x.eur], ['savings', f.savings, x.eur], ['incidents', f.incidents, String],
  ];
  const out = rows.filter(([, v]) => v != null).map(([k, v, fmt]) => `${L[k]}: ${fmt(v)}`);
  if (f.yoy) out.push(`${L.yoy}: ${t.yoy(f.yoy, x)}`);
  return out;
}

// delivery: { rule, event, facts, at } or { rule: 'digest', event: 'digest', items, at } or { event: 'test' }.
export function render(lang, delivery, { plantName, appUrl } = {}) {
  const t = T[lang] ?? T.ca;
  const x = { ...formatters(T[lang] ? lang : 'ca', delivery.at ?? Date.now()) };
  x.covered = t.covered;
  let head;
  let body;
  let todo;
  if (delivery.event === 'test') {
    [head, body, todo] = [t.test, [t.testBody], null];
  } else if (delivery.event === 'digest') {
    const items = delivery.items ?? [];
    head = t.digest(items.length);
    body = items.map((i) => `${x.time(i.at)}  ${cap(fact(t, x, i))}.`);
    todo = t.digestTodo;
  } else {
    const r = t[delivery.rule];
    const f = delivery.facts ?? {};
    head = fact(t, x, delivery);
    const extra = delivery.event === 'report' ? reportLines(t, x, f) : (r.detail?.(f, x) ?? []);
    body = [`${cap(head)}.`, ...extra.filter(Boolean)];
    todo = delivery.event === 'report' ? null : delivery.event === 'resolved' ? t.resolvedTodo : r.todo(f, x);
  }
  const paragraphs = [body, todo && [todo], appUrl && [t.link(appUrl)]].filter(Boolean);
  const plant = plantName ?? 'FusionSolar';
  const subject = `[${plant}]: ${head}`.replace(/[\r\n]+/g, ' ');
  const text = paragraphs.map((p) => p.join('\n')).join('\n\n');
  const html = [[`<strong>${esc(plant)}</strong>`], ...paragraphs.map((p) => p.map(esc))].map((p) => `<p>${p.join('<br>')}</p>`).join('\n');
  return { subject, text, html };
}
