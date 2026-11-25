import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  rename,
  mkdir,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Datasets, RoutingService } from '../dist/index.js';

const fixture = resolve('tests/fixtures/tiny.zip');

test('explicit preparation, persistence, repair, and partial failures', async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'minotor-preparation-'));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const data = new Datasets(root);
  await assert.rejects(data.import(fixture, { serviceDates: [] }), {
    code: 'INVALID_SERVICE_DATE',
  });
  await assert.rejects(data.import(fixture, { serviceDates: ['2026-02-30'] }), {
    code: 'INVALID_SERVICE_DATE',
  });
  assert.equal((await data.list()).datasets.length, 0);
  const messages = [];
  const progress = (message) => messages.push(message);
  const dataset = await data.import(fixture, {
    serviceDates: ['2026-11-24', '2026-11-24'],
    name: 'fixture',
    progress,
  });
  assert.equal(dataset.preparedDays.length, 1);
  assert.equal(messages[0], 'Reading feed and preparing stop metadata');
  assert.deepEqual(
    messages.filter((message) => message.includes('few minutes')),
    [
      'Parsing timetable for 2026-11-24 with Minotor. This may take a few minutes.',
    ],
  );
  const file = join(
    data.data,
    dataset.id,
    'timetables',
    '13.0.1-v1',
    '2026-11-24.bin',
  );
  const before = (await stat(file)).mtimeMs;
  messages.length = 0;
  await data.import(fixture, { serviceDates: ['2026-11-24'], progress });
  assert.ok(messages.includes('Reused prepared service date 2026-11-24'));
  assert.ok(!messages.some((message) => message.includes('few minutes')));
  assert.equal((await stat(file)).mtimeMs, before);
  assert.equal((await data.active()).name, 'fixture');
  messages.length = 0;
  await data.prepareDays(dataset.id, ['2026-11-26'], progress);
  assert.deepEqual(
    messages.filter((message) => message.includes('few minutes')),
    [
      'Parsing timetable for 2026-11-26 with Minotor. This may take a few minutes.',
    ],
  );
  const query = {
    origin: 'A',
    destination: 'B',
    departure: '2026-11-24T08:00:00+01:00',
  };
  const feed = join(data.data, dataset.id, 'feed.zip');
  await rename(feed, feed + '.hidden');
  await rm(data.cache, { recursive: true, force: true });
  const restarted = new Datasets(root);
  const service = new RoutingService(restarted);
  assert.equal(
    (await service.planJourney(query)).itineraries[0].elapsedMinutes,
    50,
  );
  await assert.rejects(
    service.planJourney({ ...query, departure: '2026-11-27T08:00:00+01:00' }),
    { code: 'DAY_NOT_PREPARED' },
  );
  await assert.rejects(
    service.planJourney({ ...query, departure: '2025-11-24T08:00:00+01:00' }),
    { code: 'DATE_OUTSIDE_COVERAGE' },
  );
  // A compatible legacy cache can be adopted with the source ZIP unavailable.
  const legacy = join(data.cache, `${dataset.id}-13.0.1-v1-2026-11-24.bin`);
  await mkdir(data.cache, { recursive: true });
  await rename(file, legacy);
  assert.equal(
    (await data.list()).datasets[0].preparedDays[0].status,
    'missing',
  );
  await assert.rejects(service.planJourney(query), {
    code: 'TIMETABLE_UNAVAILABLE',
  });
  messages.length = 0;
  await data.prepareDays(dataset.id, ['2026-11-24'], progress);
  assert.ok(!messages.some((message) => message.includes('few minutes')));
  assert.equal((await service.planJourney(query)).itineraries.length, 1);
  await rename(feed + '.hidden', feed);
  await rm(legacy);
  await writeFile(file, Buffer.from([255]));
  await assert.rejects(service.planJourney(query), {
    code: 'TIMETABLE_UNAVAILABLE',
  });
  await data.prepareDays(dataset.id, ['2026-11-24']);
  assert.equal((await service.planJourney(query)).itineraries.length, 1);
  const configFile = join(data.data, 'config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.datasets[0].preparedDays.find(
    (preparedDay) => preparedDay.serviceDate === '2026-11-24',
  ).formatVersion = 999;
  await writeFile(configFile, JSON.stringify(config));
  assert.equal(
    (await data.list()).datasets[0].preparedDays[0].status,
    'incompatible',
  );
  await assert.rejects(service.planJourney(query), {
    code: 'TIMETABLE_UNAVAILABLE',
  });
  await data.prepareDays(dataset.id, ['2026-11-24']);
  await assert.rejects(
    data.prepareDays(dataset.id, ['2026-11-28', '2026-11-25']),
    (error) => {
      assert.equal(error.code, 'NO_SERVICE');
      assert.deepEqual(error.details.completedDates, ['2026-11-28']);

      return true;
    },
  );
  const days = (await data.list()).datasets[0].preparedDays.map(
    (preparedDay) => preparedDay.serviceDate,
  );
  assert.ok(days.includes('2026-11-28'));
  assert.ok(!days.includes('2026-11-25'));
  await assert.rejects(data.prepareDays(dataset.id, ['2025-01-01']), {
    code: 'DATE_OUTSIDE_COVERAGE',
  });
  await assert.rejects(data.prepareDays('unknown', ['2026-11-24']), {
    code: 'UNKNOWN_DATASET',
  });
  // A ZIP comment changes feed identity without changing its synthetic schedule.
  const original = await readFile(fixture);
  const secondZip = Buffer.concat([original, Buffer.from('x')]);
  secondZip.writeUInt16LE(1, original.length - 2);
  const secondPath = join(root, 'second.zip');
  await writeFile(secondPath, secondZip);
  await assert.rejects(
    data.import(secondPath, { serviceDates: ['2026-11-24', '2026-11-25'] }),
    (error) => {
      assert.equal(error.code, 'NO_SERVICE');
      assert.deepEqual(error.details.completedDates, ['2026-11-24']);

      return true;
    },
  );
  const second = (await data.list()).datasets.find(
    (candidate) => candidate.id !== dataset.id,
  );
  assert.equal(second.preparedDays.length, 1);
  assert.equal((await data.active()).id, dataset.id);
  await data.prepareDays(second.id, ['2026-11-30']);
  assert.ok(
    !(await data.active()).preparedDays.some(
      (day) => day.serviceDate === '2026-11-30',
    ),
  );
  await data.use(second.id);
  assert.equal((await data.active()).id, second.id);
});
