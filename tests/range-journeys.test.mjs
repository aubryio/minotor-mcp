import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import StreamZip from 'node-stream-zip';
import {
  Datasets,
  RoutingService,
  journeyOutputSchema,
  journeySchema,
} from '../dist/index.js';
import { renderJourney } from '../dist/cli/render.js';
import { Terminal } from '../dist/cli/terminal.js';
import { createZip } from './helpers/zip.mjs';

const query = {
  origin: 'A',
  destination: 'B',
  departure: '2026-11-24T08:00:00+01:00',
  latestDeparture: '2026-11-24T08:30:00+01:00',
};

function timings(result) {
  return result.itineraries.map((itinerary) => [
    itinerary.departure.serviceMinutes,
    itinerary.arrival.serviceMinutes,
    itinerary.durationMinutes,
    itinerary.transferCount,
  ]);
}

test('departure-window journeys retain complete, correctly paired alternatives', async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'minotor-range-'));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const datasets = new Datasets(root);
  await datasets.import('tests/fixtures/tiny.zip', {
    serviceDates: ['2026-11-24', '2026-03-29', '2026-10-25'],
  });
  const service = new RoutingService(datasets);

  await testContext.test(
    'alternatives have individual timings, legs, and metadata',
    async () => {
      const result = await service.planJourney(query);
      journeyOutputSchema.parse(result);
      assert.equal(result.mode, 'departure_window');
      assert.equal(result.effectiveDeparture.serviceMinutes, 480);
      assert.equal(result.effectiveLatestDeparture.serviceMinutes, 510);
      assert.deepEqual(timings(result), [
        [485, 530, 45, 0],
        [510, 535, 25, 0],
      ]);
      assert.deepEqual(
        result.itineraries.map((itinerary) => itinerary.elapsedMinutes),
        [50, 55],
      );

      for (const itinerary of result.itineraries) {
        assert.equal(itinerary.legs[0].departure.iso, itinerary.departure.iso);
        assert.equal(itinerary.legs[0].arrival.iso, itinerary.arrival.iso);
      }
    },
  );

  await testContext.test(
    'dominance and constraints are evaluated for the requested window',
    async () => {
      assert.deepEqual(
        timings(await service.planJourney({ ...query, destination: 'C' })),
        [[510, 550, 40, 1]],
      );
      assert.deepEqual(
        timings(
          await service.planJourney({
            ...query,
            destination: 'C',
            latestDeparture: '2026-11-24T08:10:00+01:00',
          }),
        ),
        [[485, 550, 65, 1]],
      );
      assert.deepEqual(
        timings(await service.planJourney({ ...query, maxDuration: 30 })),
        [[510, 535, 25, 0]],
      );
      assert.deepEqual(
        (
          await service.planJourney({
            ...query,
            destination: 'C',
            maxTransfers: 0,
          })
        ).itineraries,
        [],
      );
      assert.deepEqual(
        (await service.planJourney({ ...query, transportModes: ['BUS'] }))
          .itineraries,
        [],
      );
      assert.deepEqual(
        (
          await service.planJourney({
            ...query,
            destination: 'C',
            minTransferTime: 10,
          })
        ).itineraries,
        [],
      );
    },
  );

  await testContext.test(
    'inclusive bounds and minute rounding select the right slots',
    async () => {
      const exact = { ...query, departure: query.latestDeparture };
      assert.deepEqual(timings(await service.planJourney(exact)), [
        [510, 535, 25, 0],
      ]);
      const rounded = await service.planJourney({
        ...query,
        departure: '2026-11-24T08:05:01+01:00',
        latestDeparture: '2026-11-24T08:30:59+01:00',
      });
      assert.equal(rounded.effectiveDeparture.serviceMinutes, 486);
      assert.equal(rounded.effectiveLatestDeparture.serviceMinutes, 510);
      assert.deepEqual(timings(rounded), [[510, 535, 25, 0]]);
      assert.deepEqual(
        timings(
          await service.planJourney({
            ...query,
            latestDeparture: '2026-11-24T08:29:59+01:00',
          }),
        ),
        [[485, 530, 45, 0]],
      );

      for (const latestDeparture of [
        '2026-11-24T07:59:00+01:00',
        '2027-01-10T08:00:00+01:00',
      ]) {
        await assert.rejects(
          service.planJourney({ ...query, latestDeparture }),
          { code: 'INVALID_WINDOW' },
        );
      }

      await assert.rejects(
        service.planJourney({
          ...query,
          departure: '2026-11-24T08:30:01+01:00',
          latestDeparture: '2026-11-24T08:30:59+01:00',
        }),
        { code: 'INVALID_WINDOW' },
      );
    },
  );

  await testContext.test(
    'invalid mode combinations are rejected before accessing a dataset',
    async () => {
      const invalid = [
        { ...query, mode: 'departure_window', latestDeparture: undefined },
        { ...query, mode: 'single_departure' },
        { ...query, maxInitialWaitingTime: 0 },
        { ...query, latestDeparture: '2026-11-24T08:30:00' },
        { ...query, mode: 'unknown' },
        { ...query, latestDepartur: query.latestDeparture },
      ];

      for (const input of invalid) {
        assert.equal(journeySchema.safeParse(input).success, false);
      }

      await assert.rejects(
        service.planJourney({ ...query, destination: 'missing' }),
        { code: 'UNKNOWN_STOP' },
      );
    },
  );

  await testContext.test(
    'unreachable, station, and access-only destinations remain well-defined',
    async () => {
      assert.deepEqual(
        (await service.planJourney({ ...query, destination: 'D' })).itineraries,
        [],
      );
      const noSlots = {
        ...query,
        departure: '2026-11-24T08:06:00+01:00',
        latestDeparture: '2026-11-24T08:29:00+01:00',
      };
      assert.deepEqual((await service.planJourney(noSlots)).itineraries, []);
      assert.deepEqual(
        (await service.planJourney({ ...noSlots, destination: 'A' }))
          .itineraries,
        [],
      );
      const sameStop = await service.planJourney({
        ...query,
        destination: 'A',
      });
      assert.deepEqual(timings(sameStop), [[510, 510, 0, 0]]);
      assert.deepEqual(sameStop.itineraries[0].legs, []);

      for (const origin of ['P', 'P1', 'P2']) {
        const station = await service.planJourney({
          ...query,
          origin,
          departure: '2026-11-24T10:00:00+01:00',
          latestDeparture: '2026-11-24T10:05:00+01:00',
        });
        assert.deepEqual(timings(station), [[605, 615, 10, 0]]);
        assert.equal(station.itineraries[0].legs[0].from.id, 'P1');
      }
    },
  );

  await testContext.test(
    'overnight, time offsets, and DST retain service-day semantics',
    async () => {
      const overnight = await service.planJourney({
        ...query,
        departure: '2026-11-25T00:00:00+01:00',
        latestDeparture: '2026-11-25T00:10:00+01:00',
        serviceDate: '2026-11-24',
      });
      assert.deepEqual(timings(overnight), [[1450, 1470, 20, 0]]);
      assert.equal(
        overnight.itineraries[0].arrival.iso,
        '2026-11-25T00:30:00.000+01:00',
      );
      const utc = await service.planJourney({
        ...query,
        departure: '2026-11-24T07:00:00Z',
        latestDeparture: '2026-11-24T07:30:00Z',
      });
      assert.deepEqual(timings(utc), [
        [485, 530, 45, 0],
        [510, 535, 25, 0],
      ]);

      for (const [date, offset] of [
        ['2026-03-29', '+02:00'],
        ['2026-10-25', '+01:00'],
      ]) {
        const result = await service.planJourney({
          ...query,
          departure: `${date}T08:00:00${offset}`,
          latestDeparture: `${date}T08:30:00${offset}`,
        });
        assert.deepEqual(timings(result), [
          [485, 530, 45, 0],
          [510, 535, 25, 0],
        ]);
        assert.equal(
          result.itineraries[0].arrival.iso,
          `${date}T08:50:00.000${offset}`,
        );
      }

      const fallback = await service.planJourney({
        ...query,
        departure: '2026-10-25T02:30:00+02:00',
        latestDeparture: '2026-10-25T02:30:00+01:00',
      });
      assert.equal(fallback.effectiveDeparture.serviceMinutes, 90);
      assert.equal(fallback.effectiveLatestDeparture.serviceMinutes, 150);
      const displayed = renderJourney(fallback, 'A', 'B', new Terminal(120));
      assert.match(displayed, /02:30 UTC\+02:00–02:30 UTC\+01:00/);
    },
  );

  await testContext.test(
    'window display lists every journey without notes or requested-time totals',
    async () => {
      const result = await service.planJourney(query);

      for (const width of [40, 120]) {
        const output = renderJourney(result, 'A', 'B', new Terminal(width));
        assert.equal(output.match(/Departure window:/g).length, 1);
        assert.match(output, /08:00–08:30/);
        assert.match(output, /Journey 1/);
        assert.match(output, /Journey 2/);
        assert.ok(
          output.indexOf('08:05–08:50') < output.indexOf('08:30–08:55'),
        );
        assert.doesNotMatch(output, /Requested|Note:/);
      }

      const manyJourneys = {
        ...result,
        itineraries: Array.from({ length: 12 }, () => result.itineraries[0]),
      };
      const complete = renderJourney(manyJourneys, 'A', 'B', new Terminal());
      assert.equal(complete.match(/Journey \d+/g).length, 12);

      const empty = renderJourney(
        await service.planJourney({ ...query, destination: 'D' }),
        'A',
        'D',
        new Terminal(),
      );
      assert.match(empty, /Departure window:/);
      assert.match(empty, /No journey found/);
      const { mode, latestDeparture, ...singleQuery } = query;
      const single = await service.planJourney(singleQuery);
      assert.equal(single.mode, undefined);
      assert.equal(single.effectiveLatestDeparture, undefined);
      assert.deepEqual(timings(single), [[485, 530, 45, 0]]);
      assert.match(
        renderJourney(single, 'A', 'B', new Terminal()),
        /Requested 08:00/,
      );
    },
  );

  await testContext.test(
    'each retained run supplies its own transfer count',
    async () => {
      const zip = new StreamZip.async({ file: 'tests/fixtures/tiny.zip' });
      const entries = new Map();

      try {
        for (const name of Object.keys(await zip.entries())) {
          entries.set(name, await zip.entryData(name));
        }
      } finally {
        await zip.close();
      }

      entries.set('trips.txt', entries.get('trips.txt') + 'r,svc,direct\n');
      entries.set(
        'stop_times.txt',
        entries.get('stop_times.txt') +
          'direct,08:40:00,08:40:00,A,1\ndirect,09:20:00,09:20:00,C,2\n',
      );
      const file = join(root, 'alternatives.zip');
      await writeFile(file, createZip(entries));
      const alternativeData = new Datasets(join(root, 'alternatives'));
      await alternativeData.import(file, { serviceDates: ['2026-11-24'] });
      const alternatives = await new RoutingService(
        alternativeData,
      ).planJourney({
        ...query,
        destination: 'C',
        latestDeparture: '2026-11-24T08:40:00+01:00',
      });
      assert.deepEqual(timings(alternatives), [
        [510, 550, 40, 1],
        [520, 560, 40, 0],
      ]);
      assert.deepEqual(
        alternatives.itineraries.map((itinerary) => itinerary.legNumber),
        [2, 1],
      );
    },
  );
});
