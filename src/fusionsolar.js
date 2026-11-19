// Client for the FusionSolar web portal's internal API (the one the browser uses).
// Login flow ported from hcraveiro/Home-Assistant-FusionSolar-App (api/auth.py),
// data endpoints from the same project and jgriss/FusionSolarPy.
import crypto from 'node:crypto';

const LOGIN_HOST = 'eu5.fusionsolar.huawei.com';
const SERVICE = '/unisess/v1/auth?service=%2Fnetecowebext%2Fhome%2Findex.html';
const DATA_REFERER = '/uniportal/pvmswebsite/assets/build/cloud.html';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CSRF_TTL_MS = 5 * 60 * 1000;

export class AuthError extends Error {}
export class SessionExpired extends AuthError {}
export class CaptchaRequired extends AuthError {
  constructor(image) {
    super('Login requires a CAPTCHA');
    this.image = image; // PNG bytes
  }
}

export function encryptPassword(pubKeyPem, password, version) {
  const enc = crypto.publicEncrypt(
    { key: pubKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha384' },
    Buffer.from(password, 'utf8'),
  );
  return enc.toString('base64') + version;
}

// shortcut: ignores cookie Path and Expires, fine for one portal; switch to tough-cookie if paths collide.
export class CookieJar {
  constructor(entries = []) {
    this.cookies = entries; // [{name, value, domain, hostOnly}]
  }

  store(host, setCookieHeaders) {
    for (const header of setCookieHeaders) {
      const [pair, ...attrs] = header.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const domainAttr = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
      const domain = domainAttr ? domainAttr.slice(7).replace(/^\./, '').toLowerCase() : host;
      const hostOnly = !domainAttr;
      const expired = value === '' || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain));
      if (!expired) this.cookies.push({ name, value, domain, hostOnly });
    }
  }

  header(host) {
    return this.cookies
      .filter((c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain)))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
}

export class FusionSolarClient {
  constructor({ user, password, loginHost = LOGIN_HOST, session, log = () => {} }) {
    this.user = user;
    this.password = password;
    this.loginHost = loginHost;
    this.jar = new CookieJar(session?.cookies);
    this.dataHost = session?.dataHost ?? null;
    this.csrf = null;
    this.csrfAt = 0;
    this.log = log;
  }

  exportSession() {
    return { dataHost: this.dataHost, cookies: this.jar.cookies };
  }

  async #fetch(url, { follow = true, ...opts } = {}) {
    for (let hops = 0; hops < 10; hops++) {
      const { host } = new URL(url);
      const headers = { 'user-agent': UA, 'accept-language': 'en-GB,en;q=0.9', ...opts.headers };
      const cookie = this.jar.header(host);
      if (cookie) headers.cookie = cookie;
      const res = await fetch(url, { ...opts, headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      this.jar.store(host, res.headers.getSetCookie());
      const location = res.headers.get('location');
      if (!follow || res.status < 300 || res.status >= 400 || !location) return res;
      url = new URL(location, url).href;
      opts = { ...opts, method: 'GET', body: undefined };
    }
    throw new Error('Too many redirects');
  }

  #loginPage(withService) {
    const base = `https://${this.loginHost}/unisso/login.action`;
    return withService ? `${base}?service=${encodeURIComponent(SERVICE)}` : base;
  }

  async login({ captcha } = {}) {
    const origin = `https://${this.loginHost}`;
    if (captcha) {
      if (!(await this.#prevalidateCaptcha(captcha))) throw new CaptchaRequired(await this.#captchaImage());
    } else {
      await this.#fetch(this.#loginPage(true)); // warms up the SSO session cookies
    }

    const pk = await (
      await this.#fetch(`${origin}/unisso/pubkey`, {
        headers: { accept: 'application/json', referer: this.#loginPage(true) },
      })
    ).json();
    const nonce = crypto.randomBytes(16).toString('hex');
    const body = JSON.stringify({
      organizationName: '',
      username: encodeURIComponent(decodeURIComponent(this.user)),
      password: encryptPassword(pk.pubKey, this.password, pk.version),
      multiRegionName: '',
      verifycode: captcha ?? '',
    });

    let lastCode = '';
    for (const withService of [true, false]) {
      let url = `${origin}/unisso/v3/validateUser.action?timeStamp=${pk.timeStamp}&nonce=${nonce}`;
      if (withService) url += `&service=${encodeURIComponent(SERVICE)}`;
      const res = await this.#fetch(url, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          origin,
          referer: this.#loginPage(withService),
          'x-requested-with': 'XMLHttpRequest',
        },
      });
      if (res.status !== 200) {
        this.log(`validateUser HTTP ${res.status} (service=${withService})`);
        continue;
      }
      const json = await res.json().catch(() => null);
      if (!json) continue;
      const redirect = json.respMultiRegionName?.[1] ?? json.redirectURL;
      if (redirect) return this.#finishSso(`${origin}${redirect}`);

      lastCode = String(json.errorCode ?? '');
      this.log(`validateUser rejected: errorCode=${lastCode} verifyCodeCreate=${!!json.verifyCodeCreate}`);
      if (lastCode === '411' || json.verifyCodeCreate) throw new CaptchaRequired(await this.#captchaImage());
    }
    throw new AuthError(lastCode === '406' ? 'Invalid username or password' : `Login failed (errorCode=${lastCode})`);
  }

  async #finishSso(url) {
    const res = await this.#fetch(url, {
      follow: false,
      headers: { accept: 'text/html,*/*', referer: `https://${this.loginHost}/pvmswebsite/loginCustomize.html` },
    });
    const location = res.headers.get('location');
    this.dataHost = location ? new URL(location, url).host : this.loginHost;
    if (!this.jar.cookies.some((c) => c.name === 'dp-session')) {
      throw new AuthError(`SSO redirect gave no dp-session cookie (HTTP ${res.status})`);
    }
    this.log(`logged in, data host ${this.dataHost}`);
    this.csrf = null;
    await this.refreshCsrf();
  }

  async #prevalidateCaptcha(code) {
    const origin = `https://${this.loginHost}`;
    const res = await this.#fetch(`${origin}/unisso/preValidVerifycode`, {
      method: 'POST',
      body: new URLSearchParams({ verifycode: code, index: '0' }),
      headers: {
        accept: 'application/json',
        origin,
        referer: `${origin}/unisso/login.action`,
        'x-requested-with': 'XMLHttpRequest',
      },
    });
    const text = (await res.text()).trim().replace(/^"|"$/g, '').toLowerCase();
    return res.status === 200 && ['true', 'success', '1', 'ok'].includes(text);
  }

  async #captchaImage() {
    const res = await this.#fetch(`https://${this.loginHost}/unisso/verifycode?timestamp=${Date.now()}`, {
      headers: { accept: '*/*', referer: `https://${this.loginHost}/unisso/login.action` },
    });
    return Buffer.from(await res.arrayBuffer());
  }

  async refreshCsrf() {
    if (!this.dataHost) throw new SessionExpired('No session');
    const json = await this.#request('GET', '/rest/dpcloud/auth/v1/keep-alive', { csrf: false });
    if (!json.payload) throw new SessionExpired('keep-alive returned no CSRF token');
    this.csrf = json.payload;
    this.csrfAt = Date.now();
  }

  async #request(method, path, { query, body, csrf = true } = {}) {
    const url = new URL(`https://${this.dataHost}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      for (const item of [v].flat()) url.searchParams.append(k, String(item));
    }
    const headers = {
      accept: 'application/json, text/plain, */*',
      referer: `https://${this.dataHost}${DATA_REFERER}`,
      'x-requested-with': 'XMLHttpRequest',
    };
    if (csrf) headers.roarand = this.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.#fetch(url.href, {
      method,
      headers,
      follow: false,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') ?? '';
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400) || type.includes('html')) {
      throw new SessionExpired(`${path}: HTTP ${res.status} ${type}`);
    }
    if (res.status !== 200) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  // Data call with CSRF refresh and one re-login on an expired session.
  async api(method, path, opts) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!this.csrf || Date.now() - this.csrfAt > CSRF_TTL_MS) await this.refreshCsrf();
        return await this.#request(method, path, opts);
      } catch (err) {
        if (!(err instanceof SessionExpired) || attempt > 0) throw err;
        this.log(`session expired (${err.message}), logging in again`);
        await this.login();
      }
    }
  }

  stationList() {
    return this.api('POST', '/rest/pvms/web/station/v1/station/station-list', {
      body: {
        curPage: 1,
        pageSize: 10,
        gridConnectedTime: '',
        queryTime: Date.now(),
        timeZone: tzOffsetHours(new Date()),
        sortId: 'createTime',
        sortDir: 'DESC',
        locale: 'en_US',
      },
    });
  }

  energyFlow(stationDn) {
    return this.api('GET', '/rest/pvms/web/station/v2/overview/energy-flow', { query: { stationDn } });
  }

  // timeDim: 2 day (5-min series), 4 month, 5 year, 6 lifetime. `date` in the machine's local time zone.
  energyBalance(stationDn, { timeDim = 2, date = new Date() } = {}) {
    const start =
      timeDim === 2
        ? new Date(date.getFullYear(), date.getMonth(), date.getDate())
        : timeDim === 4
          ? new Date(date.getFullYear(), date.getMonth(), 1)
          : new Date(date.getFullYear(), 0, 1);
    return this.api('GET', '/rest/pvms/web/station/v2/overview/energy-balance', {
      query: {
        stationDn,
        timeDim,
        queryTime: start.getTime(),
        timeZone: tzOffsetHours(start),
        timeZoneStr: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dateStr: `${localDate(start)} 00:00:00`,
        _: Date.now(),
      },
    });
  }

  deviceList(parentDn) {
    return this.api('GET', '/rest/neteco/web/config/device/v1/device-list', {
      query: {
        'conditionParams.parentDn': parentDn,
        'conditionParams.mocTypes': '20814,20815,20816,20819,20822,50017,60066,60014,60015,23037',
        _: Date.now(),
      },
    });
  }

  deviceRealtime(deviceDn) {
    return this.api('GET', '/rest/pvms/web/device/v1/device-realtime-data', {
      query: { deviceDn, displayAccessModel: true, _: Date.now() },
    });
  }

  // Signals with 5-minute history for a device: data.signalList[{id, name, unit: {unit}}].
  deviceSignals(deviceDn) {
    return this.api('GET', '/rest/pvms/web/device/v1/device-statistics-signal', { query: { deviceDn, _: Date.now() } });
  }

  // Device settings (battery SOC limits, grid charging, inverter protections): data[].configSignalDisplayList[].
  deviceConfig(dn) {
    return this.api('GET', '/rest/pvms/web/device/v1/deviceExt/get-config-signals', { query: { dn } });
  }

  // dataType CURRENT (active) or HISTORY (cleared); data.hits[], data.totalCount.
  alarms(stationDn, { dataType = 'HISTORY', pageNo = 1, pageSize = 100 } = {}) {
    return this.api('POST', '/rest/pvms/fm/v1/query', {
      body: { dataType, domainType: 'OC_SOLAR', pageNo, pageSize, nativeMeDn: stationDn },
    });
  }

  deviceHistory(deviceDn, signalIds, date = new Date()) {
    // The server picks the UTC day of `date`; local midnight would be the previous UTC day, so send noon.
    const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    return this.api('GET', '/rest/pvms/web/device/v1/device-history-data', {
      query: { signalIds, deviceDn, date: noon.getTime(), _: Date.now() },
    });
  }
}

function tzOffsetHours(d) {
  return -d.getTimezoneOffset() / 60;
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
