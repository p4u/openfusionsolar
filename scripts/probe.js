// Logs in (or reuses .session.json), then dumps raw responses of the read endpoints to data/samples/.
// CAPTCHA: if asked, the image lands in data/captcha.png; rerun with CAPTCHA=<code>.
import fs from 'node:fs';
import { FusionSolarClient, CaptchaRequired } from '../src/fusionsolar.js';

process.loadEnvFile?.('.env');
const SESSION = '.session.json';
const OUT = 'data/samples';
fs.mkdirSync(OUT, { recursive: true });

const client = new FusionSolarClient({
  user: process.env.FUSIONSOLAR_USER,
  password: process.env.FUSIONSOLAR_PASSWORD,
  session: fs.existsSync(SESSION) ? JSON.parse(fs.readFileSync(SESSION, 'utf8')) : undefined,
  log: (m) => console.log('·', m),
});
const saveSession = () => {
  fs.writeFileSync(`${SESSION}.tmp`, JSON.stringify(client.exportSession()), { mode: 0o600 });
  fs.renameSync(`${SESSION}.tmp`, SESSION);
};

try {
  if (process.env.CAPTCHA) await client.login({ captcha: process.env.CAPTCHA });
  else if (client.dataHost) await client.refreshCsrf().catch(() => client.login());
  else await client.login();
} catch (err) {
  saveSession(); // the CAPTCHA is bound to these cookies
  if (err instanceof CaptchaRequired) {
    fs.writeFileSync('data/captcha.png', err.image);
    console.error('CAPTCHA required: see data/captcha.png and rerun with CAPTCHA=<code>');
    process.exit(2);
  }
  throw err;
}
saveSession();
console.log('✓ authenticated, data host:', client.dataHost);

const dump = (name, json) => {
  fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify(json, null, 2));
  const d = json?.data;
  const shape = Array.isArray(d) ? `array[${d.length}]` : d && typeof d === 'object' ? Object.keys(d).join(',') : typeof d;
  console.log(`✓ ${name}: success=${json?.success} data=${shape}`);
  return json;
};

const stations = dump('station-list', await client.stationList());
const station = stations.data.list[0];
console.log(`  station ${station.dn} "${station.name}"`);
dump('energy-flow', await client.energyFlow(station.dn));
dump('energy-balance-day', await client.energyBalance(station.dn, { timeDim: 2 }));
dump('energy-balance-month', await client.energyBalance(station.dn, { timeDim: 4 }));
const devices = dump('device-list', await client.deviceList(station.dn));
for (const dev of devices.data ?? []) {
  console.log(`  device ${dev.dn} ${dev.mocTypeName ?? dev.mocTypeId} "${dev.name}"`);
  dump(`device-realtime-${dev.dn.replace(/\W+/g, '_')}`, await client.deviceRealtime(dev.dn));
}
saveSession();
