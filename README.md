# OpenFusionSolar

A small self-hosted monitor for a Huawei FusionSolar home plant (inverter, battery, meter). It reads your plant
from the FusionSolar web portal every few minutes, keeps the readings in a local SQLite file and shows them in a
password-protected web app, in Catalan or English, light or dark. It can email you when something goes wrong.

It is generic: plant name, capacity, battery size and limits come from FusionSolar or from `.env`, never from code.

## What you get

- **Now**: one sentence that answers "do I need to do anything?", where the electricity is going right now, the
  battery, today's totals and chart, this month so far and the latest incidents.
- **Energy**: any range (today, days, months, years, custom) with comparison to the previous period or the same
  period last year, power or energy charts, where consumption came from and where solar went, table and CSV.
- **Battery**: charge level, limits (each one says whether it comes from FusionSolar or `.env`), charge and
  discharge, equivalent cycles, round-trip efficiency, hours below the reserve.
- **Panels**: production, peak power, kWh per kWp, year on year, per-string and inverter temperature details.
- **Bill**: estimated bill, savings and surplus income for the Spanish 2.0TD tariff when prices are set; kWh only
  otherwise.
- **Incidents**: power cuts, internet losses, stopped panels and device alarms, grouped and explained.
- **Technical data**: any stored device signal over any range.
- **Settings**: alert recipients and what each one gets, alert rules, quiet hours, test email, alert history, plant
  facts, collector state, appearance and a glossary.

## Quick start (Docker)

```sh
cp .env.example .env
# edit .env: FUSIONSOLAR_USER, FUSIONSOLAR_PASSWORD and APP_PASSWORD are required
docker compose up -d --build
```

Open <http://127.0.0.1:8080> and log in with `APP_PASSWORD`. The first start downloads history in the background
(`BACKFILL_DAYS`, default 730 in the example); the Now view shows the progress.

The container listens on `127.0.0.1:8080` only. To reach it from other devices, put a TLS reverse proxy in front
(Caddy, nginx, Traefik) and set `TRUST_PROXY=1` and `APP_URL` (see below). Do not publish port 8080 directly on the
internet: the login is a single shared password. The proxy must pass the original host (`Host` or
`X-Forwarded-Host`) and `X-Forwarded-Proto`; otherwise the login answers 403. All clients behind the proxy or the
Docker bridge share one address unless `TRUST_PROXY=1`, so five wrong passwords lock everyone out for 15 minutes.

Docker checks `/healthz` every minute (see `Dockerfile`); it turns unhealthy when the collector has not run for
20 minutes. `docker compose ps` shows the state.

## Configuration (`.env`)

Every key is listed and commented in [`.env.example`](.env.example). Empty optional keys are taken from FusionSolar
or disabled.

| Key | Required | What it does |
|---|---|---|
| `FUSIONSOLAR_USER`, `FUSIONSOLAR_PASSWORD` | yes | A FusionSolar account with access to the plant (the owner account works). |
| `APP_PASSWORD` | yes | Password for the web app. The server refuses to start without it; use 8 characters or more. Changing it logs out every session. |
| `TRUST_PROXY` | no | `1` only behind a reverse proxy: client IP, `https` and host are then read from `X-Forwarded-*` (rate limit, `Secure` cookie, CSRF check). |
| `APP_URL` | no | Public address of the app, used for the link in alert emails. |
| `PLANT_NAME`, `PLANT_TZ` | no | Friendlier name and time zone; default to FusionSolar's. |
| `BACKFILL_DAYS` | no | Days of history to fetch on start. |
| `BATTERY_KWH`, `BATTERY_MIN_PCT` | no | Battery capacity and minimum charge, if FusionSolar's are wrong or missing. |
| `BATTERY_RESERVE_PCT`, `BATTERY_RESERVE_SINCE` | no | Power-cut reserve ("Backup power SOC" in the FusionSolar app). The API does not expose it, so it is only shown when set. |
| `PRICE_*`, `POWER_P*_KW`, `TAX_*` | no | Tariff (2.0TD, Península). Without `PRICE_P1..P3` the app shows kWh only. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` (or `SMTP_PASSWORD`), `SMTP_FROM` | no | Outgoing mail for alerts. `SMTP_SECURE` defaults to on for port 465, off otherwise. Credentials are never shown in the app or logged. |
| `ALERT_TO` | no | First alert recipients, comma separated, until Settings is saved once. Each gets the "Everything important" alerts in the app language. |

## Alerts

The alert engine runs every minute and after every collection. In Settings, Alerts you add one or more email
addresses (paste several at once, separated by commas or spaces) and choose, per address, its language and which
alerts it gets: a preset (Everything important, Urgent only, Reports only) or any mix. Thresholds, quiet hours and
the on/off switch of each rule are shared by everyone.

| Group | Alert | When | New address |
|---|---|---|---|
| Urgent, sent at once also at night | Power cut | A cut lasting 2 minutes or more, and when power is back (duration, whether the battery covered the house). Says when the power limiter probably tripped | yes |
| | House dark: overload | The battery could not carry the load during a cut | yes |
| | Battery low during a cut | Charge below 20 % during a cut or just after it | yes |
| Problems, held at night until the end of quiet hours | Plant offline | No data for 12 hours while the app reads FusionSolar fine (router, dongle, inverter) | yes |
| | App cannot read FusionSolar | Login paused, or 60 minutes of failed reads | yes |
| | Backup reserve not restored | 5 points below `BATTERY_RESERVE_PCT` for 3 hours, outside cuts | yes |
| | Panels not producing | 0 kW for an hour between 10:00 and 15:00 | yes |
| | Equipment alarm | FusionSolar alarms of severity 1-2 | yes |
| | Contracted power exceeded | A 5-minute reading above `POWER_P1_KW` / `POWER_P2_KW`, once a day; hidden without them | no |
| Reports | Weekly summary | Monday 08:00 | yes |
| | Monthly report | Day 1, 08:00 | yes |
| | Daily summary | 21:00 (rule off by default) | no |

- **Without SMTP** nothing is lost: every alert is still evaluated and listed in Settings, Alert history, as
  "Not sent: email is not set up". Add the `SMTP_*` keys later and restart.
- **With SMTP**: set the `SMTP_*` keys, restart, then use "Send test email" next to each address. The result, or the
  SMTP error, appears next to the button.
- Each alert goes only to the addresses that chose it, as a separate email to each address in its own language
  (addresses never see each other). With nobody subscribed it is logged as "Not sent: nobody subscribed to it". The
  history shows who each email went to, and a failed email is retried only to the addresses it failed for.
- Quiet hours (default 22:00 to 08:00) hold the problem alerts and send each address one digest of its own alerts
  when they end. A safety cap allows at most 10 alert events per hour, however many addresses each one reaches (an
  alert to 3 addresses counts once); anything above is logged as skipped.
- Nothing is sent for history: alerts only cover incidents that start, or are still ongoing, after the first start.
- FusionSolar reports alarms with a delay, and a power cut that also takes your router down is only seen afterwards.
- If the machine running the app or its internet is down, no email goes out: the weekly summary is the sign of life.
- Upgrading keeps a saved configuration: older plain address lists become addresses with the "Everything important"
  alerts, and the retired FusionSolar low-battery alert is dropped.

## Install on a phone

Behind the HTTPS proxy the app installs like a native one: in Chrome on Android use "Install app" (or "Add to
Home screen"), in Safari on iOS use Share, then "Add to Home Screen". The icon is labelled "Solar": the manifest is a
static file, so it cannot carry the plant name. Service workers need a secure context, so this only works over HTTPS
(or on `localhost`).

Offline, the app opens from its cache and the Now view shows the last status it received, marked "Offline, data from
HH:MM"; the other views need the server. Nothing else from `/api` is kept on the device, and logging out deletes that
copy. When a new version is deployed, a "New version available" message offers to reload. If you change the list of
files in `public/js` or `public/css`, update the lists in `public/sw.js` and bump its `VERSION` (`test/pwa.test.js`
checks the lists).

## Data

Everything lives in `./data` (mounted into the container): `openfusionsolar.db` (readings, incidents, alert
settings and history) and `.session.json` (the FusionSolar portal session). Back up that folder to keep your history.
Nothing is sent anywhere except to FusionSolar (to read your plant) and your SMTP server (alerts).

If the FusionSolar login fails, the collector pauses logins for 30 minutes to avoid locking the account; Settings
shows when it will try again.

## Development

Node 22.5 or newer, no build step.

```sh
npm ci
npm test
```

Run the app without touching FusionSolar, from a copy of a database:

```sh
APP_PASSWORD=devpass COLLECT=0 DB_PATH=/tmp/copy.db PORT=18080 npm start
```

`COLLECT=0` turns the collector off. Tests use fakes and never call FusionSolar or send email.
