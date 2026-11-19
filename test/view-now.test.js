process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headline, flow, autonomyHours, reserveNote, STALE_MS } from '../public/js/views/now-model.js';
import nowDict from '../public/js/i18n/now.js';
import { fmtTime, duration } from '../public/js/format.js';

const NOW = Date.UTC(2026, 10, 19, 12, 0);
const rt = { pv_kw: 2, load_kw: 1, grid_kw: 0, battery_kw: 0, soc: 80 };
const status = (o = {}) => ({ lastSampleTs: NOW - 60e3, realtime: rt, battery: { reservePct: 30 }, ...o });

test('fine when data is fresh and no alarm', () => {
  const h = headline(status(), [], NOW);
  assert.deepEqual([h.state, h.key], ['ok', 'now.head.ok']);
  // an ended cut and an internet loss do not turn the headline
  const past = [{ kind: 'gridCut', start: NOW - 5 * 3600e3, end: NOW - 4 * 3600e3 }, { kind: 'network', ongoing: true, start: NOW - 1e6, end: NOW }];
  assert.equal(headline(status(), past, NOW).state, 'ok');
});

test('stale after 20 minutes names the time', () => {
  const last = NOW - STALE_MS - 60e3;
  const h = headline(status({ lastSampleTs: last }), [], NOW);
  assert.deepEqual([h.state, h.key], ['warn', 'now.head.stale']);
  assert.equal(h.vars.time, fmtTime(last));
  assert.equal(headline(status({ lastSampleTs: NOW - STALE_MS }), [], NOW).state, 'ok');
});

test('the stale line counts from the end of the last reading, like the incident', () => {
  const last = NOW - 3 * 3600e3;
  assert.equal(headline(status({ lastSampleTs: last }), [], NOW).vars.ago, duration(3 * 3600e3 - 5 * 60e3));
});

test('the 24 hour summary counts an internet loss by its start, other events by their end', async () => {
  const { recentEvents } = await import('../public/js/views/now-model.js');
  const H = 3600e3;
  const ev = (kind, start, end) => ({ kind, start: NOW - start * H, end: NOW - end * H, ongoing: false });
  const list = [ev('network', 30, 2), ev('network', 5, 4), ev('gridCut', 30, 2), ev('gridCut', 30, 26)];
  assert.deepEqual(recentEvents(list, NOW), [list[1], list[2]]);
});

test('waiting when there has never been data', () => {
  const h = headline({ lastSampleTs: null, realtime: null, battery: {} }, [], NOW);
  assert.deepEqual([h.state, h.key], ['waiting', 'now.head.waiting']);
});

test('below reserve and recharging is info, not recharging is warn', () => {
  const low = (battery_kw) => status({ realtime: { ...rt, soc: 20, battery_kw } });
  const a = headline(low(1.5), [], NOW);
  assert.deepEqual([a.state, a.key, a.vars], ['info', 'now.head.recharging', { soc: 20, reserve: 30 }]);
  assert.deepEqual([headline(low(0), [], NOW).state, headline(low(-0.4), [], NOW).key], ['warn', 'now.head.notRecharging']);
  assert.equal(headline(status({ battery: {} , realtime: { ...rt, soc: 5 } }), [], NOW).state, 'ok'); // no reserve known
});

test('an ongoing cut outranks a stale reading', () => {
  const cut = [{ kind: 'gridCut', ongoing: true, start: NOW - 1e6, end: NOW }];
  assert.equal(headline(status({ lastSampleTs: NOW - 3600e3 }), cut, NOW).key, 'now.head.cut');
});

test('flow links follow the signs of grid and battery', () => {
  const pairs = (r) => flow(r).links.map((l) => `${l.from}>${l.to}`).sort();
  assert.deepEqual(pairs({ pv_kw: 0, load_kw: 1, grid_kw: 1, battery_kw: 0 }), ['grid>home']);
  assert.deepEqual(pairs({ pv_kw: 3, load_kw: 1, grid_kw: -2, battery_kw: 0 }), ['pv>grid', 'pv>home']);
  assert.deepEqual(pairs({ pv_kw: 3, load_kw: 1, grid_kw: 0, battery_kw: 2 }), ['pv>bat', 'pv>home']);
  assert.deepEqual(pairs({ pv_kw: 0, load_kw: 1, grid_kw: 0, battery_kw: -1 }), ['bat>home']);
  assert.deepEqual(pairs({ pv_kw: 0, load_kw: 0.5, grid_kw: 2, battery_kw: 1.5 }), ['grid>bat', 'grid>home']);
  assert.deepEqual(pairs(null), []);
});

test('autonomy is null without capacity', () => {
  assert.equal(autonomyHours(50, {}, 1), null);
  assert.equal(autonomyHours(null, { capacityKwh: 10 }, 1), null);
  assert.equal(autonomyHours(50, { capacityKwh: 10 }, 1), 5);
  assert.equal(autonomyHours(50, { capacityKwh: 10, minPct: 10 }, 2), 2); // the floor is not usable
  assert.equal(autonomyHours(5, { capacityKwh: 10, minPct: 10 }, 1), 0);
  assert.equal(autonomyHours(100, { capacityKwh: 10 }, 0), 10 / 0.15); // a tiny load is floored
});

test('below the reserve with the grid cutoff under it, nothing promises a refill from the grid', () => {
  const bat = { reservePct: 60, chargeFromGrid: true, gridChargeCutoffPct: 50 };
  assert.equal(reserveNote(70, bat), null);
  assert.equal(reserveNote(55, bat).key, 'gridStops'); // above the cutoff: only the sun can fill it
  assert.equal(reserveNote(40, bat).key, 'gridUntil');
  assert.equal(reserveNote(40, { reservePct: 60, chargeFromGrid: true, gridChargeCutoffPct: 90 }).key, 'plain');
  assert.equal(reserveNote(40, { reservePct: 60, chargeFromGrid: false }).key, 'sunOnly');
  // at night above the cutoff it is expected: info, not "check that grid charging is on"
  const h = headline(status({ battery: bat, realtime: { ...rt, soc: 55, battery_kw: 0 } }), [], NOW);
  assert.deepEqual([h.state, h.key, h.vars.cutoff], ['info', 'now.head.gridStops', 50]);
  const low = headline(status({ battery: bat, realtime: { ...rt, soc: 40, battery_kw: 0 } }), [], NOW);
  assert.deepEqual([low.state, low.key], ['warn', 'now.head.notRecharging']);
  for (const lang of ['en', 'ca']) {
    for (const k of ['plain', 'gridStops', 'gridUntil', 'sunOnly']) {
      assert.doesNotMatch(nowDict[lang][`now.bat.reserve.${k}`], /refills before|s’omple abans/, `${lang} ${k}`);
    }
  }
});

test('every headline has a short title and a sentence in both languages', () => {
  const keys = ['ok', 'cut', 'alarm', 'waiting', 'stale', 'stopped', 'stoppedRepeat', 'recharging', 'notRecharging', 'gridStops', 'sunOnly'];
  for (const lang of ['en', 'ca']) {
    for (const k of keys) {
      assert.equal(typeof nowDict[lang][`now.head.${k}`], 'string', `${lang} ${k}`);
      const title = nowDict[lang][`now.head.${k}.title`];
      assert.ok(title && title.length <= 40, `${lang} ${k}.title is short`);
    }
  }
});

test('before any sun today there is no savings tile, and a negative figure never gets a check icon', async () => {
  const { todayTiles } = await import('../public/js/views/now-model.js');
  const night = { pv_kwh: 0, load_kwh: 2, import_kwh: 2, export_kwh: 0, money: { energy: 0.46, savings: -0.46 } };
  const tiles = todayTiles(night, { pricesConfigured: true });
  assert.equal(tiles.find((x) => x.icon === 'check'), undefined);
  assert.equal(tiles.filter((x) => x.icon === 'euro').length, 1, 'only the cost tile');
  const day = { ...night, pv_kwh: 3, self_use_kwh: 1 };
  const neg = todayTiles(day, { pricesConfigured: true }).at(-1);
  assert.equal(neg.icon, 'euro', 'negative savings: neutral icon');
  assert.equal(neg.status, undefined);
  const pos = todayTiles({ ...day, money: { energy: 0.2, savings: 0.8 } }, { pricesConfigured: true }).at(-1);
  assert.deepEqual([pos.icon, pos.status], ['check', 'ok']);
});
