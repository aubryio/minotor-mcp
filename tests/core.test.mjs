import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  journeyOutputSchema,
  searchOutputSchema,
  reachabilityOutputSchema,
  Datasets,
  RoutingService,
  Results,
} from '../dist/index.js';

const fixture = resolve('tests/fixtures/tiny.zip');

test('real Minotor core, persistence, service dates, range semantics and CLI', async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'minotor-test-'));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const data = new Datasets(root);
  const service = new RoutingService(data);
  const dataset = await data.import(fixture, {
    serviceDates: ['2026-11-24', '2026-03-29', '2026-10-25', '2027-01-01'],
  });
  assert.equal((await data.active()).id, dataset.id);
  const query = { origin: 'A', departure: '2026-11-24T08:00:00+01:00' };
  await testContext.test(
    'output schemas and DST service-time conversion',
    async () => {
      searchOutputSchema.parse(await service.searchStops({ query: 'Alpha' }));
      journeyOutputSchema.parse(
        await service.planJourney({ ...query, destination: 'C' }),
      );
      const store = new Results(data);

      for (const mode of ['single_departure', 'departure_window']) {
        const result = await service.computeReachability({
          ...query,
          mode,
          ...(mode === 'departure_window'
            ? { latestDeparture: '2026-11-24T08:30:00+01:00' }
            : {}),
        });
        reachabilityOutputSchema.parse(
          await store.page(await store.save(result)),
        );
      }

      for (const [date, offset] of [
        ['2026-03-29', '+02:00'],
        ['2026-10-25', '+01:00'],
      ]) {
        const result = await service.computeReachability({
          ...query,
          departure: date + 'T08:00:00' + offset,
        });
        assert.equal(result.effectiveDeparture.serviceMinutes, 480);
        assert.equal(result.stops[1].earliestArrival.durationMinutes, 50);
      }

      const addition = await service.computeReachability({
        ...query,
        departure: '2027-01-01T08:00:00+01:00',
      });
      assert.equal(addition.stops[1].earliestArrival.durationMinutes, 50);
    },
  );
  await testContext.test(
    'station hierarchy and boarding via a station',
    async () => {
      const search = await service.searchStops({ query: 'Hub' });
      assert.deepEqual(search.stops[0].children, ['P1', 'P2']);
      const journey = await service.planJourney({
        ...query,
        origin: 'P',
        destination: 'B',
        departure: '2026-11-24T10:00:00+01:00',
      });
      assert.equal(journey.itineraries[0].legs[0].from.id, 'P1');
      assert.equal(journey.itineraries[0].elapsedMinutes, 15);
    },
  );
  await testContext.test('search and ambiguity', async () => {
    assert.equal(
      (await service.searchStops({ query: 'Alpha' })).stops.length,
      2,
    );
    await assert.rejects(service.resolve('Alpha'), { code: 'AMBIGUOUS_STOP' });
    assert.equal(await service.resolve('A'), 'A');
    assert.equal(await service.resolve('Beta'), 'B');
    await assert.rejects(service.resolve('No such stop'), {
      code: 'UNKNOWN_STOP',
    });
  });
  await testContext.test(
    'unknown query options are rejected before routing',
    async () => {
      for (const request of [
        service.searchStops({ query: 'Alpha', limt: 1 }),
        service.planJourney({ ...query, destination: 'B', maxTransfer: 0 }),
        service.computeReachability({ ...query, maxTransfer: 0 }),
      ]) {
        await assert.rejects(request, (error) =>
          error.issues.some((issue) => issue.code === 'unrecognized_keys'),
        );
      }
    },
  );
  await testContext.test(
    'broken stop references fail instead of exporting undefined IDs',
    async () => {
      class BrokenMetadata extends Datasets {
        async stopMetadata(selectedDataset) {
          const metadata = await super.stopMetadata(selectedDataset);
          metadata
            .find((stop) => stop.sourceStopId === 'P')
            .children.push(999999);

          return metadata;
        }
      }
      await assert.rejects(
        new RoutingService(new BrokenMetadata(root)).searchStops({
          query: 'Hub',
        }),
        {
          code: 'INVALID_STOP_DATA',
        },
      );
    },
  );
  await testContext.test(
    'single departure and full cache roundtrip',
    async () => {
      const reachability = await service.computeReachability(query);
      assert.deepEqual(
        reachability.stops.map((entry) => entry.stop.id),
        ['A', 'B', 'C'],
      );
      assert.equal(reachability.stops[1].earliestArrival.durationMinutes, 50);
      assert.equal(reachability.stops[2].earliestArrival.transferCount, 1);
      assert.deepEqual(await service.computeReachability(query), reachability);
    },
  );
  await testContext.test(
    'shortest duration differs from earliest arrival',
    async () => {
      const reachability = await service.computeReachability({
        ...query,
        mode: 'departure_window',
        latestDeparture: '2026-11-24T08:30:00+01:00',
      });
      const beta = reachability.stops.find((entry) => entry.stop.id === 'B');
      assert.equal(beta.earliestArrival.arrival.serviceMinutes, 530);
      assert.equal(beta.shortestDuration.durationMinutes, 25);
      assert.equal(beta.shortestDuration.departure.serviceMinutes, 510);
      const narrow = await service.computeReachability({
        ...query,
        mode: 'departure_window',
        latestDeparture: '2026-11-24T08:10:00+01:00',
      });
      assert.equal(
        narrow.stops.find((entry) => entry.stop.id === 'B').shortestDuration
          .durationMinutes,
        45,
      );
    },
  );
  await testContext.test(
    'latestDeparture selects a window without an explicit mode',
    async () => {
      const windowQuery = {
        ...query,
        latestDeparture: '2026-11-24T08:30:00+01:00',
      };
      const implicit = await service.computeReachability(windowQuery);
      const explicit = await service.computeReachability({
        ...windowQuery,
        mode: 'departure_window',
      });
      assert.deepEqual(implicit, explicit);
      assert.equal(implicit.mode, 'departure_window');
      assert.equal(implicit.query.mode, 'departure_window');
      const journeyQuery = { ...windowQuery, destination: 'B' };
      assert.deepEqual(
        (await service.planJourney(journeyQuery)).itineraries,
        (
          await service.planJourney({
            ...journeyQuery,
            mode: 'departure_window',
          })
        ).itineraries,
      );

      for (const options of [
        { mode: 'single_departure' },
        { maxInitialWaitingTime: 0 },
      ]) {
        await assert.rejects(
          service.computeReachability({ ...windowQuery, ...options }),
        );
        await assert.rejects(
          service.planJourney({ ...journeyQuery, ...options }),
        );
      }
    },
  );
  await testContext.test('journey and constraints', async () => {
    const journey = await service.planJourney({ ...query, destination: 'C' });
    assert.equal(journey.itineraries[0].elapsedMinutes, 70);
    assert.equal(journey.itineraries[0].legs.length, 2);
    assert.equal(
      (await service.planJourney({ ...query, destination: 'D' })).itineraries
        .length,
      0,
    );
    assert.equal(
      (await service.computeReachability({ ...query, maxDuration: 49 })).stops
        .length,
      1,
    );
    assert.equal(
      (await service.computeReachability({ ...query, maxTransfers: 0 })).stops
        .length,
      2,
    );
  });
  await testContext.test('invalid IDs, dates, and options', async () => {
    await assert.rejects(
      service.computeReachability({ ...query, origin: 'bad' }),
      {
        code: 'UNKNOWN_STOP',
      },
    );
    await assert.rejects(
      service.computeReachability({
        ...query,
        serviceDate: '2025-11-24',
        departure: '2025-11-24T08:00:00+01:00',
      }),
      { code: 'DATE_OUTSIDE_COVERAGE' },
    );
    await assert.rejects(
      service.computeReachability({
        ...query,
        serviceDate: '2026-11-25',
        departure: '2026-11-25T08:00:00+01:00',
      }),
      { code: 'DAY_NOT_PREPARED' },
    );
    await assert.rejects(
      service.computeReachability({ ...query, mode: 'departure_window' }),
    );
  });
  await testContext.test('overnight and offset equivalence', async () => {
    const reachability = await service.computeReachability({
      ...query,
      departure: '2026-11-25T00:00:00+01:00',
      serviceDate: '2026-11-24',
    });
    assert.equal(
      reachability.stops.find((entry) => entry.stop.id === 'B').earliestArrival
        .arrival.iso,
      '2026-11-25T00:30:00.000+01:00',
    );
    const utc = await service.computeReachability({
      ...query,
      departure: '2026-11-24T07:00:00Z',
    });
    assert.equal(utc.stops[1].earliestArrival.durationMinutes, 50);
  });
  await testContext.test(
    'persistent pagination equals complete export',
    async () => {
      const reachability = await service.computeReachability(query);
      const store = new Results(data);
      const id = await store.save(reachability);
      const firstPage = await store.page(id, 0, 2);
      const nextPage = await new Results(data).page(id, 2, 2);
      assert.deepEqual(
        [...firstPage.stops, ...nextPage.stops],
        JSON.parse(JSON.stringify(reachability.stops)),
      );
      assert.equal(firstPage.nextOffset, 2);
      assert.equal(nextPage.nextOffset, null);
      const snapshot = JSON.parse(await readFile(firstPage.file, 'utf8'));
      snapshot.expiresAt = '2000-01-01T00:00:00Z';
      await writeFile(firstPage.file, JSON.stringify(snapshot));
      await assert.rejects(store.page(id), { code: 'RESULT_EXPIRED' });
    },
  );
});
