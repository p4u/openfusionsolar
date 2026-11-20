// Web tool rules (spec 3.3, AC5): queries without personal data or household figures; reads only from this turn's
// search results or the guide's sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryRefusal, urlRefusal, canonicalUrl, fold } from '../src/web-rules.js';
import { groundedSet } from '../src/grounding.js';

// a get_energy result of this turn, plus the store's personal strings
const G = groundedSet(['{"bucket":"1mo","buckets":[{"key":"2026-07","pv_kwh":612.4,"import_kwh":87.25,"load_kwh":402,"p":[0,1,2,20]}]}']);
const personal = ['Casa Ramírez', 'FX-4471-ZQ', 'CT-55512', 'Porta del darrere amb clau'];
const ctx = { groundedNonWeb: G, personal };

const QUERIES = [
  ['preu PVPC avui Espanya', null],
  ['compensació excedents autoconsum 2026', null], // a year is fine
  ['tarifa 2.0TD peatges P1 2026 BOE', null], // 2, 0, 1 and 20 are in G: masked like in the answer check
  ['és normal produir 612 kWh al juliol amb 5 kWp', /612, a figure from the household/],
  ['consum 87,25 kWh mes', /87,25/],
  ['factura FX-4471-ZQ som energia', /plant name, a bill number/],
  ['instal·lació casa ramirez plaques', /plant name/],
  ['cups ES0031000000000001BJ0F', /cups/],
  ['meu correu algu@example.com', /email/],
  ['truca al 612 345 678', /phone/],
  ['NIF 12345678Z', /tax id/],
  ['IBAN ES91 2100 0418 4502 0005 1332', /iban/],
  ['x'.repeat(201), /longer than 200/],
  ['   ', /empty/],
];
for (const [q, re] of QUERIES) {
  test(`query: ${q.slice(0, 50)}`, () => {
    const r = queryRefusal(q, ctx);
    if (re == null) assert.equal(r, null);
    else assert.match(r ?? '', re);
  });
}

const allowed = new Set(['https://www.ree.es/es/datos/mercados', 'https://www.boe.es/buscar/doc.php?id=BOE-A-2019-5089'].map(canonicalUrl));

const URLS = [
  ['https://www.ree.es/es/datos/mercados', null],
  ['https://WWW.REE.ES/es/datos/mercados', null], // the same after canonicalisation
  ['https://www.boe.es/buscar/doc.php?id=BOE-A-2019-5089', null],
  ['https://www.boe.es/buscar/doc.php?id=BOE-A-2019-5089&x=1', /only a url returned/], // one extra query parameter
  ['https://www.ree.es/es/datos/mercados#top', /only a url returned/],
  ['https://www.ree.es/es/datos/mercados/otra', /only a url returned/],
  ['http://www.ree.es/es/datos/mercados', /only https/],
  ['https://user:pw@www.ree.es/es/datos/mercados', /user name/],
  ['https://192.168.1.10/admin', /ip address/],
  ['https://2130706433/', /ip address/], // decimal 127.0.0.1
  ['https://[::1]/', /ip address/],
  ['https://localhost/x', /local address/],
  ['https://router/x', /local address/],
  ['https://www.ree.es:443/es/datos/mercados', /port/],
  ['https://www.ree.es:8443/es/datos/mercados', /port/],
  ['javascript:alert(1)', /only https/],
  ['not a url', /not a url/],
];
for (const [u, re] of URLS) {
  test(`url: ${u}`, () => {
    const r = urlRefusal(u, allowed);
    if (re == null) assert.equal(r, null);
    else assert.match(r ?? '', re);
  });
}

// gate F3: backslashes parse as slashes, so the port is read from the parsed url too, even when search returned it
test('url: a port written after backslashes is refused', () => {
  const ported = new Set([canonicalUrl('https://example.com:8443/x')]);
  assert.match(urlRefusal('https:\\\\example.com:8443\\x', ported) ?? '', /port/);
  assert.match(urlRefusal('https://example.com:8443/x', ported) ?? '', /port/);
});

test('fold strips accents and case', () => assert.equal(fold('  Casa  RAMÍREZ '), 'casa ramirez'));

// preflight F5: only the household's figures block a query, not the date or the guide's numbers in the system prompt
test("a query with today's day number or a number that only the guide gave is accepted", () => {
  const household = groundedSet(['{"bucket":"1d","buckets":[{"key":"2026-11-19","pv_kwh":14.7,"import_kwh":3.85}]}']);
  const c = { groundedNonWeb: household, personal };
  assert.equal(queryRefusal('preu llum 20 novembre 2026', c), null);
  assert.equal(queryRefusal('IVA 21 % electricitat', c), null);
  // the same query is refused once the system prompt (today 2026-11-20, the guide's 21 %) enters the set
  const withPrompt = groundedSet(['Today is 2026-11-20. VAT on electricity: 21 %.'], new Set(household));
  assert.match(queryRefusal('preu llum 20 novembre 2026', { groundedNonWeb: withPrompt }) ?? '', /contains 20/);
});

test('a query with a device name is refused', () => {
  const c = { groundedNonWeb: G, personal: [...personal, 'SUN2000-5KTL-M1 HV2150012345', 'NE=34567890'] };
  assert.match(queryRefusal('error inversor sun2000-5ktl-m1 hv2150012345', c) ?? '', /plant name/);
  assert.match(queryRefusal('dispositiu NE=34567890 alarma', c) ?? '', /plant name/);
});
