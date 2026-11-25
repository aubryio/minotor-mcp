import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  Datasets,
  Results,
  RoutingService,
  reachabilityFields,
  reachabilitySummaryOutputSchema,
  queryReachabilityOutputSchema,
  computeReachabilityOutputSchema,
  computeReachabilitySchema,
} from '../dist/index.js';

const time = (minute) => ({
  serviceMinutes: minute,
  iso: new Date(Date.UTC(2026, 10, 24, 0, minute)).toISOString(),
});

function createRow(id, duration, options = {}) {
  const { name = id, latitude = 46, longitude = 6, transfers = 0 } = options;

  return {
    stop: {
      id,
      name,
      minotorId: 1,
      latitude,
      longitude,
      locationType: '0',
      children: [],
      parentId: 'station',
    },
    earliestArrival: {
      arrival: time(480 + duration),
      durationMinutes: duration,
      legNumber: transfers + 1,
      transferCount: transfers,
    },
  };
}

function result(stops, mode = 'single_departure') {
  return {
    schemaVersion: 1,
    datasetId: 'synthetic',
    timezone: 'UTC',
    serviceDate: '2026-11-24',
    realtime: false,
    precision: 'minute',
    effectiveDeparture: time(480),
    query: { origin: 'origin' },
    warnings: [],
    engine: 'test',
    mode,
    stops,
  };
}

async function store(testContext) {
  const root = await mkdtemp(join(tmpdir(), 'minotor-results-'));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const data = new Datasets(root);

  return { data, results: new Results(data) };
}

test('summaries and query aggregates cover all matches, before sorting, paging and projection', async (testContext) => {
  const { results } = await store(testContext);
  const source = result([
    createRow('z', 60, {
      name: 'Other',
      latitude: 48,
      longitude: 8,
      transfers: 2,
    }),
    createRow('b', 20, {
      name: 'Beta',
      latitude: 47,
      longitude: 7,
      transfers: 1,
    }),
    createRow('a', 20, { name: 'BETA' }),
    createRow('c', 40, {
      name: 'Beta remote',
      latitude: null,
      longitude: null,
    }),
  ]);
  delete source.stops[3].stop.latitude;
  delete source.stops[3].stop.longitude;
  const id = await results.save(source);
  const summary = reachabilitySummaryOutputSchema.parse(
    await results.summary(id),
  );
  computeReachabilityOutputSchema.parse(summary);
  computeReachabilityOutputSchema.parse({
    ...(await results.page(id)),
    view: 'page',
  });
  assert.equal(summary.total, 4);
  assert.equal(summary.basis, 'earliestArrival');
  assert.deepEqual(summary.statistics, {
    durationMinutes: { min: 20, max: 60, mean: 35 },
    withCoordinates: 3,
    bounds: { west: 6, south: 46, east: 8, north: 48 },
  });
  assert.deepEqual(
    summary.preview.map((row) => row.id),
    ['a', 'b', 'c', 'z'],
  );
  const filtered = queryReachabilityOutputSchema.parse(
    await results.query({
      resultId: id,
      filters: {
        stopIds: ['a', 'b', 'c'],
        name: 'beta',
        minDuration: 20,
        maxDuration: 40,
        maxTransfers: 1,
        hasCoordinates: true,
      },
      fields: ['name', 'name', 'platform'],
      order: 'desc',
      limit: 1,
    }),
  );
  assert.equal(filtered.total, 4);
  assert.equal(filtered.matched, 2);
  assert.equal(filtered.statistics.durationMinutes.mean, 20);
  assert.deepEqual(filtered.query.fields, ['id', 'name', 'platform']);
  assert.deepEqual(filtered.rows, [{ id: 'a', name: 'BETA' }]);
  assert.equal(filtered.nextOffset, 1);
  const second = await results.query({
    ...filtered.query,
    offset: filtered.nextOffset,
  });
  assert.deepEqual(second.rows, [{ id: 'b', name: 'Beta' }]);
  assert.equal(second.nextOffset, null);
  const missingCoords = await results.query({
    resultId: id,
    filters: { hasCoordinates: false },
    fields: [...reachabilityFields],
  });
  assert.equal(missingCoords.matched, 1);
  assert.equal(missingCoords.statistics.bounds, null);
  assert.equal(missingCoords.rows[0].latitude, undefined);
  assert.equal(missingCoords.rows[0].departure, undefined);
  assert.equal(missingCoords.rows[0].parentId, 'station');
  const aggregates = await results.query({
    resultId: id,
    offset: 999,
    limit: 0,
  });
  assert.deepEqual(aggregates.statistics, summary.statistics);
  assert.deepEqual(aggregates.rows, []);
  assert.equal(aggregates.nextOffset, null);
  const pastEnd = await results.query({ resultId: id, offset: 4 });
  assert.deepEqual(pastEnd.rows, []);
  assert.equal(pastEnd.matched, 4);
  assert.equal(pastEnd.nextOffset, null);

  for (const [sortBy, order, expected] of [
    ['arrival', 'desc', ['z', 'c', 'a', 'b']],
    ['name', 'asc', ['a', 'b', 'c', 'z']],
    ['id', 'desc', ['z', 'c', 'b', 'a']],
  ]) {
    assert.deepEqual(
      (await results.query({ resultId: id, sortBy, order })).rows.map(
        (row) => row.id,
      ),
      expected,
    );
  }

  assert.deepEqual(
    (await results.query({ resultId: id, fields: [] })).rows[0],
    { id: 'a' },
  );
  assert.deepEqual(
    JSON.parse(await readFile(summary.file, 'utf8')).result,
    source,
  );
});

test('empty results and no matches return zero counts and null statistics', async (testContext) => {
  const { results } = await store(testContext);
  const empty = await results.save(result([]));
  const expected = { durationMinutes: null, withCoordinates: 0, bounds: null };
  const summary = await results.summary(empty);
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.preview, []);
  assert.deepEqual(summary.statistics, expected);
  const id = await results.save(result([createRow('a', 10)]));

  for (const filters of [
    { stopIds: [] },
    { name: 'absent' },
    { minDuration: 11 },
  ]) {
    const queryResult = await results.query({ resultId: id, filters });
    assert.equal(queryResult.matched, 0);
    assert.deepEqual(queryResult.statistics, expected);
    assert.deepEqual(queryResult.rows, []);
    assert.equal(queryResult.nextOffset, null);
  }
});

test('real routing summaries and queries use one journey basis for each mode', async (testContext) => {
  const { results, data } = await store(testContext);
  await data.import(resolve('tests/fixtures/tiny.zip'), {
    serviceDates: ['2026-11-24'],
  });
  const service = new RoutingService(data);

  for (const mode of ['single_departure', 'departure_window']) {
    const full = await service.computeReachability({
      origin: 'A',
      departure: '2026-11-24T08:00:00+01:00',
      mode,
      ...(mode === 'departure_window'
        ? { latestDeparture: '2026-11-24T08:30:00+01:00' }
        : {}),
    });
    const id = await results.save(full);
    const basis =
      mode === 'single_departure' ? 'earliestArrival' : 'shortestDuration';
    const summary = await results.summary(id);
    assert.equal(summary.basis, basis);
    const durations = full.stops.map((row) => row[basis].durationMinutes);
    assert.equal(
      summary.statistics.durationMinutes.mean,
      durations.reduce((total, duration) => total + duration, 0) /
        durations.length,
    );
    const queryResult = await results.query({
      resultId: id,
      fields: [...reachabilityFields],
      filters: { stopIds: ['B'] },
    });
    const expected = full.stops.find((row) => row.stop.id === 'B')[basis];
    assert.deepEqual(queryResult.rows[0].arrival, expected.arrival);
    assert.equal(queryResult.rows[0].durationMinutes, expected.durationMinutes);
    assert.equal(queryResult.rows[0].transferCount, expected.transferCount);
    assert.deepEqual(queryResult.rows[0].departure, expected.departure);

    if (mode === 'departure_window') {
      const original = full.stops.find((row) => row.stop.id === 'B');
      assert.notDeepEqual(
        original.earliestArrival.arrival,
        original.shortestDuration.arrival,
      );
      assert.equal(queryResult.rows[0].durationMinutes, 25);
    }
  }

  // Deliberately different transfer counts ensure filtering follows shortest duration too.
  const windowRow = createRow('b', 50, { transfers: 0 });
  delete windowRow.earliestArrival.durationMinutes;
  windowRow.shortestDuration = {
    arrival: time(540),
    departure: time(515),
    durationMinutes: 25,
    transferCount: 2,
    legNumber: 3,
  };
  const id = await results.save(result([windowRow], 'departure_window'));
  assert.equal(
    (await results.query({ resultId: id, filters: { maxTransfers: 0 } }))
      .matched,
    0,
  );
});

test('saved results persist and share missing, corrupt and expired handling', async (testContext) => {
  const { results, data } = await store(testContext);
  const id = await results.save(result([createRow('a', 10)]));
  const summary = await results.summary(id);
  assert.deepEqual(await new Results(data).summary(id), summary);
  assert.equal((await new Results(data).query({ resultId: id })).matched, 1);
  const calls = (resultId) => [
    () => results.page(resultId),
    () => results.summary(resultId),
    () => results.query({ resultId }),
  ];

  for (const call of calls(randomUUID())) {
    await assert.rejects(call, { code: 'RESULT_NOT_FOUND' });
  }

  const saved = JSON.parse(await readFile(summary.file, 'utf8'));
  saved.expiresAt = '2000-01-01T00:00:00Z';
  await writeFile(summary.file, JSON.stringify(saved));

  for (const call of calls(id)) {
    await assert.rejects(call, { code: 'RESULT_EXPIRED' });
  }

  await writeFile(summary.file, 'invalid json');

  for (const call of calls(id)) {
    await assert.rejects(call, { code: 'RESULT_NOT_FOUND' });
  }
});

test('query inputs reject invalid fields, filters and pagination', async (testContext) => {
  const { results } = await store(testContext);
  const id = await results.save(result([createRow('a', 10)]));

  for (const options of [
    { fields: ['sql'] },
    { limit: -1 },
    { limit: 501 },
    { offset: -1 },
    { offset: 0.5 },
    { filters: { minDuration: 30, maxDuration: 20 } },
    { filters: { maxTransfers: -1 } },
    { filters: { expression: 'true' } },
    { sortBy: 'unknown' },
    { order: 'random' },
  ]) {
    await assert.rejects(results.query({ resultId: id, ...options }));
  }

  assert.throws(() =>
    computeReachabilitySchema.parse({ resultId: id, limit: 1 }),
  );
  assert.throws(() =>
    computeReachabilitySchema.parse({ resultId: id, offset: 0 }),
  );
  assert.throws(() =>
    computeReachabilitySchema.parse({ resultId: id, view: 'page', limit: 0 }),
  );
  assert.throws(() => computeReachabilitySchema.parse({}));
});

test('large results have bounded default responses and complete local-code analysis', async (testContext) => {
  const { results } = await store(testContext);
  const source = result(
    Array.from({ length: 10000 }, (unused, index) =>
      createRow(String(index).padStart(5, '0'), index % 100),
    ),
  );
  const id = await results.save(source);
  const summary = await results.summary(id);
  const oldPage = await results.page(id);
  assert.equal(summary.total, 10000);
  assert.equal(summary.preview.length, 5);
  assert.deepEqual(summary.statistics.durationMinutes, {
    min: 0,
    max: 99,
    mean: 49.5,
  });
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
  const pageBytes = Buffer.byteLength(JSON.stringify(oldPage));
  testContext.diagnostic(
    `Default summary: ${summaryBytes} bytes; previous 100-row page: ${pageBytes} bytes`,
  );
  assert.ok(summaryBytes < pageBytes / 5);
  const queryResult = await results.query({
    resultId: id,
    filters: { minDuration: 50 },
    limit: 1,
  });
  assert.equal(queryResult.matched, 5000);
  assert.equal(queryResult.rows.length, 1);
  assert.equal(queryResult.statistics.durationMinutes.mean, 74.5);
  assert.equal((await results.query({ resultId: id })).rows.length, 25);
  assert.equal(
    (await results.query({ resultId: id, limit: 500 })).rows.length,
    500,
  );
  const snapshot = JSON.parse(await readFile(summary.file, 'utf8'));
  assert.deepEqual(snapshot.result, source);
  assert.equal(snapshot.result.stops.length, 10000);
  const meanDuration =
    snapshot.result.stops.reduce(
      (total, row) => total + row.earliestArrival.durationMinutes,
      0,
    ) / snapshot.result.stops.length;
  assert.equal(meanDuration, 49.5);
});
