import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  legalSeriesBuckets, legalEnergyBuckets, autoEnergyBucket, compareDays, spanDays, bucketCount, addMonths,
} from '../public/js/buckets.js';

test('bucket rules follow the span table and the 750 cap', () => {
  assert.ok(legalSeriesBuckets(2).includes('5m'));
  assert.deepEqual(legalSeriesBuckets(3), ['15m', '1h', '1d']);
  assert.deepEqual(legalSeriesBuckets(8), ['1h', '1d']);
  assert.ok(legalSeriesBuckets(31).includes('1h'));
  assert.deepEqual(legalSeriesBuckets(32), ['1d']);
  assert.ok(!legalSeriesBuckets(751).includes('1d'));
  assert.equal(autoEnergyBucket(120), '1d');
  assert.equal(autoEnergyBucket(121), '1mo');
  assert.equal(autoEnergyBucket(1826), '1mo');
  assert.equal(autoEnergyBucket(1827), '1y');
  assert.deepEqual(legalEnergyBuckets(751), ['1mo', '1y']);
  assert.equal(spanDays('2026-03-28', '2026-03-30'), 3);
  assert.equal(bucketCount('2026-01-15', '2026-03-02', '1mo'), 3);
});

test('compareDays handles month ends and leap days', () => {
  assert.deepEqual(compareDays('2024-02-29', '2024-02-29', 'yoy'), { from: '2023-02-28', to: '2023-02-28' });
  assert.deepEqual(compareDays('2026-11-10', '2026-11-16', 'prev'), { from: '2026-11-03', to: '2026-11-09' });
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
});
