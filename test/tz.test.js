// Gate F2: no module under src/ sets the process time zone on import (main.js decides it from PLANT_TZ).
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('importing the assistant leaves TZ unchanged', async () => {
  process.env.TZ = 'America/New_York';
  await import('../src/assistant.js');
  await import('../src/invoices.js');
  assert.equal(process.env.TZ, 'America/New_York');
});
