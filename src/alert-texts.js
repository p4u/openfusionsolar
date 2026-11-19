// Alert email texts in Catalan and English. Each email: what happened, what to do, link to the app.
// `x` holds the formatters for the language: time(ts), dur(ms), kwh(v), eur(v), pct(v), day(ts), month('YYYY-MM').

const T = {
  en: {
    noData: {
      fired: (f, x) => `no data from the plant since ${x.time(f.since)}`,
      resolved: () => 'data is arriving again',
      detail: (f, x, ev) => (ev === 'resolved' ? [] : [
        'Meanwhile the other alerts cannot see the plant.',
        f.network != null ? `FusionSolar reports a network connection error since ${x.time(f.network)}.` : '',
      ]),
      todo: () => 'Check the router and that the inverter dongle light is on. During a power cut data arrives once it ends.',
    },
    gridCut: {
      fired: (f, x) => `power cut since ${x.time(f.start)}${f.soc != null ? `, battery at ${x.pct(f.soc)}` : ''}`,
      past: (f, x) => `there was a power cut from ${x.time(f.start)} to ${x.time(f.end)}`,
      resolved: (f, x) => `power is back after ${x.dur(f.end - f.start)}`,
      detail: (f, x, ev) => [
        f.past ? `It lasted ${x.dur(f.end - f.start)}.` : f.end ? `The cut went from ${x.time(f.start)} to ${x.time(f.end)}.` : '',
        f.end ? x.covered(f.batteryCovered) : '',
        ev === 'resolved' && f.soc != null ? `Battery now at ${x.pct(f.soc)}.` : '',
      ],
      todo: (f) => [
        f.past ? (f.batteryCovered === false ? 'Check the reserve for power cuts in FusionSolar.' : '') : 'Keep consumption low so the battery lasts.',
        f.limiter ? 'Probably the power limiter tripped: reset it at the meter.' : '',
      ].filter(Boolean).join(' ') || null,
    },
    backupOverload: {
      fired: () => 'house without power: the battery cannot carry the load',
      past: (f, x) => `the house was without power from ${x.time(f.start)} to ${x.time(f.end)}: the battery could not carry the load`,
      resolved: () => 'the battery carries the house again',
      todo: () => 'Switch off large appliances (oven, heater, hob); the inverter retries by itself.',
    },
    batteryLowInCut: {
      fired: (f, x) => `battery at ${x.pct(f.soc)} during a power cut`,
      resolved: () => 'the battery is no longer low or the cut is over',
      detail: (f, x, ev) => [ev !== 'resolved' && f.leftMin ? `At the current load the battery lasts about ${x.dur(f.leftMin * 60e3)}.` : ''],
      todo: () => 'Switch off everything that is not essential now.',
    },
    collectorDown: {
      fired: (f, x) => (f.authBlocked || f.since == null ? 'the app cannot sign in to FusionSolar' : `the app cannot reach FusionSolar since ${x.time(f.since)}`),
      resolved: () => 'the app reads FusionSolar again',
      detail: (f, x, ev) => [ev !== 'resolved' && f.error ? `Last error: ${f.error}` : ''],
      todo: () => 'Tell whoever manages the app: check the FusionSolar user and password in the .env file.',
    },
    belowReserve: {
      fired: (f, x) => `battery at ${x.pct(f.soc)}, below the ${x.pct(f.reservePct)} reserve${f.since != null ? ` for ${x.dur(x.now - f.since)}` : ''}`,
      resolved: () => 'the battery is back above the reserve',
      detail: (f, x, ev) => (ev === 'resolved' ? [] : [
        'A power cut now would have less backup.',
        f.gridChargeOff ? 'Grid charging is off in FusionSolar.'
          : f.cutoffPct != null ? `The grid charging cutoff in FusionSolar is ${x.pct(f.cutoffPct)}, below the reserve.` : '',
      ]),
      todo: () => 'In FusionSolar, check that grid charging is on and its cutoff is at or above the reserve.',
    },
    panelsStopped: {
      fired: (f, x) => `the panels produced nothing from ${x.time(f.start)} to ${x.time(f.end)}`,
      resolved: () => 'the panels are producing again',
      todo: () => 'Look at the inverter and its breaker (snow also does this).',
    },
    deviceAlarm: {
      fired: (f) => `alarm: ${f.name} (${f.device})`,
      past: (f, x) => `there was an alarm from ${x.time(f.start)} to ${x.time(f.end)}: ${f.name} (${f.device})`,
      resolved: (f) => `alarm cleared: ${f.name}`,
      todo: () => 'Open FusionSolar for the alarm details and the suggested fix.',
    },
    powerLimit: {
      fired: (f, x) => `${x.kw(f.kw)} from the grid at ${x.time(f.ts)}, above the ${x.kw(f.limit)} contracted`,
      resolved: () => 'the power drawn is back under the contracted power',
      detail: () => ['The power limiter cuts the supply when this lasts.'],
      todo: () => 'Avoid running those appliances at the same time.',
    },
    weeklySummary: { fact: (f, x) => `week of ${x.week(f.from, f.to)}: ${x.kwh(f.pv ?? 0)} produced${f.cost == null ? '' : `, ${x.eur(f.cost)}`}` },
    dailySummary: { fact: (f, x) => `summary for ${x.day(f.day)}${f.pv == null ? '' : `: ${x.kwh(f.pv)} produced`}` },
    monthlyReport: { fact: (f, x) => `${x.month(f.month)} summary${f.bill == null ? '' : `: bill estimate ${x.eur(f.bill)}`}` },
    lines: {
      pv: 'Produced', load: 'Consumed', imp: 'Bought', exp: 'Sold', cost: 'Energy cost', bill: 'Bill estimate',
      savings: 'Savings thanks to solar', incidents: 'Incidents', yoy: 'Same month last year',
    },
    kinds: { gridCut: 'Power cut', overload: 'House without power (overload)', noProduction: 'Panels not producing' },
    peak: (f, x) => `Peak draw from the grid: ${x.kw(f.peakKw)} (${x.time(f.peakTs)})${f.contractedKw == null ? '' : `, contracted ${x.kw(f.contractedKw)}`}`,
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
      fired: (f, x) => `sense dades de la instal·lació des de les ${x.time(f.since)}`,
      resolved: () => 'tornen a arribar dades',
      detail: (f, x, ev) => (ev === 'resolved' ? [] : [
        'Mentrestant, els altres avisos no poden veure la instal·lació.',
        f.network != null ? `FusionSolar indica un error de connexió a la xarxa des de les ${x.time(f.network)}.` : '',
      ]),
      todo: () => "Comprova el router i que el llum del dongle de l'inversor estigui encès. Durant un tall, les dades arriben quan s'acaba.",
    },
    gridCut: {
      fired: (f, x) => `tall de corrent des de les ${x.time(f.start)}${f.soc != null ? `, bateria al ${x.pct(f.soc)}` : ''}`,
      past: (f, x) => `hi ha hagut un tall de corrent de ${x.time(f.start)} a ${x.time(f.end)}`,
      resolved: (f, x) => `torna a haver-hi corrent després de ${x.dur(f.end - f.start)}`,
      detail: (f, x, ev) => [
        f.past ? `Ha durat ${x.dur(f.end - f.start)}.` : f.end ? `El tall ha anat de ${x.time(f.start)} a ${x.time(f.end)}.` : '',
        f.end ? x.covered(f.batteryCovered) : '',
        ev === 'resolved' && f.soc != null ? `Ara la bateria és al ${x.pct(f.soc)}.` : '',
      ],
      todo: (f) => [
        f.past ? (f.batteryCovered === false ? 'Revisa la reserva per a talls a FusionSolar.' : '') : 'Redueix el consum perquè la bateria duri.',
        f.limiter ? "Probablement ha saltat el limitador de potència (ICP): rearma'l al comptador." : '',
      ].filter(Boolean).join(' ') || null,
    },
    backupOverload: {
      fired: () => 'casa sense corrent: la bateria no pot amb la càrrega',
      past: (f, x) => `la casa ha estat sense corrent de ${x.time(f.start)} a ${x.time(f.end)}: la bateria no podia amb la càrrega`,
      resolved: () => 'la bateria torna a alimentar la casa',
      todo: () => "Apaga els aparells grans (forn, estufa, placa); l'inversor ho torna a provar sol.",
    },
    batteryLowInCut: {
      fired: (f, x) => `bateria al ${x.pct(f.soc)} durant un tall de corrent`,
      resolved: () => "la bateria ja no està baixa o el tall s'ha acabat",
      detail: (f, x, ev) => [ev !== 'resolved' && f.leftMin ? `Amb el consum actual, la bateria dura uns ${x.dur(f.leftMin * 60e3)}.` : ''],
      todo: () => 'Apaga ara tot el que no sigui imprescindible.',
    },
    collectorDown: {
      fired: (f, x) => (f.authBlocked || f.since == null ? "l'aplicació no pot iniciar sessió a FusionSolar" : `l'aplicació no pot llegir FusionSolar des de les ${x.time(f.since)}`),
      resolved: () => "l'aplicació torna a llegir FusionSolar",
      detail: (f, x, ev) => [ev !== 'resolved' && f.error ? `Últim error: ${f.error}` : ''],
      todo: () => "Avisa qui gestiona l'aplicació: cal revisar l'usuari i la contrasenya de FusionSolar al fitxer .env.",
    },
    belowReserve: {
      fired: (f, x) => `bateria al ${x.pct(f.soc)}, per sota de la reserva del ${x.pct(f.reservePct)}${f.since != null ? ` des de fa ${x.dur(x.now - f.since)}` : ''}`,
      resolved: () => 'la bateria torna a estar per sobre de la reserva',
      detail: (f, x, ev) => (ev === 'resolved' ? [] : [
        'Si ara hi hagués un tall, hi hauria menys reserva.',
        f.gridChargeOff ? 'La càrrega des de la xarxa està desactivada a FusionSolar.'
          : f.cutoffPct != null ? `El límit de càrrega des de la xarxa a FusionSolar és del ${x.pct(f.cutoffPct)}, per sota de la reserva.` : '',
      ]),
      todo: () => 'A FusionSolar, comprova que la càrrega des de la xarxa està activada i que el seu límit és igual o superior a la reserva.',
    },
    panelsStopped: {
      fired: (f, x) => `les plaques no han produït res de ${x.time(f.start)} a ${x.time(f.end)}`,
      resolved: () => 'les plaques tornen a produir',
      todo: () => "Mira l'inversor i el seu magnetotèrmic (la neu també ho fa).",
    },
    deviceAlarm: {
      fired: (f) => `alarma: ${f.name} (${f.device})`,
      past: (f, x) => `hi ha hagut una alarma de ${x.time(f.start)} a ${x.time(f.end)}: ${f.name} (${f.device})`,
      resolved: (f) => `alarma resolta: ${f.name}`,
      todo: () => "Obre FusionSolar per veure el detall de l'alarma i la solució proposada.",
    },
    powerLimit: {
      fired: (f, x) => `${x.kw(f.kw)} de la xarxa a les ${x.time(f.ts)}, per sobre dels ${x.kw(f.limit)} contractats`,
      resolved: () => 'la potència consumida torna a ser per sota de la contractada',
      detail: () => ['El limitador talla el subministrament quan això dura.'],
      todo: () => 'Evita fer servir aquests aparells alhora.',
    },
    weeklySummary: { fact: (f, x) => `setmana ${x.week(f.from, f.to)}: ${x.kwh(f.pv ?? 0)} produïts${f.cost == null ? '' : `, ${x.eur(f.cost)}`}` },
    dailySummary: { fact: (f, x) => `resum del ${x.day(f.day)}${f.pv == null ? '' : `: ${x.kwh(f.pv)} produïts`}` },
    monthlyReport: { fact: (f, x) => `resum de ${x.month(f.month)}${f.bill == null ? '' : `: factura estimada ${x.eur(f.bill)}`}` },
    lines: {
      pv: 'Produït', load: 'Consumit', imp: 'Comprat', exp: 'Venut', cost: "Cost de l'energia", bill: 'Factura estimada',
      savings: 'Estalvi gràcies al sol', incidents: 'Incidències', yoy: "Mateix mes de l'any passat",
    },
    kinds: { gridCut: 'Tall de corrent', overload: 'Casa sense corrent (sobrecàrrega)', noProduction: 'Plaques sense producció' },
    peak: (f, x) => `Màxim consumit de la xarxa: ${x.kw(f.peakKw)} (${x.time(f.peakTs)})${f.contractedKw == null ? '' : `, contractats ${x.kw(f.contractedKw)}`}`,
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
  const now = ref;
  const n1 = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  return {
    now,
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
    kw: (v) => `${n1.format(v)} kW`,
    // 'YYYY-MM-DD' to 'YYYY-MM-DD': "9 to 15 November" / "del 9 al 15 de novembre" (de l'1, a l'11)
    week: (from, to) => {
      const [a, b] = [from, to].map((d) => new Date(`${d}T12:00`));
      const dm = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' });
      const first = a.getMonth() === b.getMonth() ? String(a.getDate()) : dm.format(a);
      if (lang === 'en') return `${first} to ${dm.format(b)}`;
      const el = (pre, s) => (/^1?1\b/.test(s) ? `${pre === 'del' ? 'de' : 'a'} l'${s}` : `${pre} ${s}`);
      return `${el('del', first)} ${el('al', dm.format(b))}`;
    },
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
  const list = Array.isArray(f.incidents) ? f.incidents : null; // the weekly summary lists them
  const rows = [
    ['pv', f.pv, x.kwh], ['load', f.load, x.kwh], ['imp', f.imp, x.kwh], ['exp', f.exp, x.kwh],
    ['cost', f.cost, x.eur], ['bill', f.bill, x.eur], ['savings', f.savings, x.eur], ['incidents', list ? list.length : f.incidents, String],
  ];
  const out = rows.filter(([, v]) => v != null).map(([k, v, fmt]) => `${L[k]}: ${fmt(v)}`);
  for (const i of list ?? []) out.push(`- ${t.kinds[i.kind] ?? i.kind}, ${x.time(i.start)}, ${x.dur(i.end - i.start)}`);
  if (f.peakKw != null) out.push(t.peak(f, x));
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
    const extra = delivery.event === 'report' ? reportLines(t, x, f) : (r.detail?.(f, x, delivery.event) ?? []);
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
