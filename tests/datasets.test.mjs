import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import StreamZip from 'node-stream-zip';
import { Datasets } from '../dist/index.js';
import { createZip } from './helpers/zip.mjs';

const calendarHeader =
  'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n';

const exceptionHeader = 'service_id,date,exception_type\n';

test('streamed calendar coverage and legacy configuration', async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'minotor-calendar-'));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const source = new StreamZip.async({
    file: resolve('tests/fixtures/tiny.zip'),
  });
  const base = new Map();

  try {
    for (const name of Object.keys(await source.entries())) {
      base.set(name, await source.entryData(name));
    }
  } finally {
    await source.close();
  }

  async function feed(label, calendar, exceptions) {
    const entries = new Map(base);

    for (const [file, content] of [
      ['calendar.txt', calendar],
      ['calendar_dates.txt', exceptions],
    ]) {
      if (content === undefined) {
        entries.delete(file);
      } else {
        entries.set(file, content);
      }
    }

    const path = join(root, label + '.zip');
    await writeFile(path, createZip(entries));
    const data = new Datasets(join(root, label));

    return {
      data,
      dataset: await data.import(path, { serviceDates: ['2026-11-24'] }),
    };
  }

  await testContext.test(
    'calendar-only, merged adjacent intervals, and gaps',
    async () => {
      const { data, dataset } = await feed(
        'calendar',
        calendarHeader +
          'svc,1,1,1,1,1,1,1,20261123,20261124\nother,1,1,1,1,1,1,1,20261125,20261125\nlast,1,1,1,1,1,1,1,20261127,20261127\n',
      );
      assert.deepEqual(dataset.serviceDateRanges, [
        { start: '2026-11-23', end: '2026-11-25' },
        { start: '2026-11-27', end: '2026-11-27' },
      ]);
      assert.ok((await data.timetable(dataset, '2026-11-24')).getRoute(0));
      await assert.rejects(data.timetable(dataset, '2026-11-26'), {
        code: 'DATE_OUTSIDE_COVERAGE',
      });
    },
  );
  await testContext.test(
    'exception-only additions, removals, and gaps',
    async () => {
      const { data, dataset } = await feed(
        'exceptions',
        undefined,
        exceptionHeader + 'svc,20261124,1\nsvc,20261126,2\n',
      );
      assert.ok((await data.timetable(dataset, '2026-11-24')).getRoute(0));
      await assert.rejects(data.timetable(dataset, '2026-11-25'), {
        code: 'DATE_OUTSIDE_COVERAGE',
      });
      await assert.rejects(data.prepareDays(dataset.id, ['2026-11-26']), {
        code: 'NO_SERVICE',
      });
    },
  );
  await testContext.test(
    'many exceptions produce a compact configuration',
    async () => {
      const exceptions =
        exceptionHeader +
        'svc,20261124,1\n' +
        Array.from(
          { length: 50000 },
          (unused, index) => `svc${index},20261124,1\n`,
        ).join('');
      const { data, dataset } = await feed('large', undefined, exceptions);
      assert.deepEqual(dataset.serviceDateRanges, [
        { start: '2026-11-24', end: '2026-11-24' },
      ]);
      const config = await readFile(join(data.data, 'config.json'), 'utf8');
      assert.ok(config.length < 1000);
      assert.equal('exceptions' in JSON.parse(config).datasets[0], false);
    },
  );
  await testContext.test(
    'legacy configs normalize without rewriting on read',
    async () => {
      const data = new Datasets(join(root, 'legacy'));
      await data.init();
      const file = join(data.data, 'config.json');
      const legacy = JSON.stringify({
        active: 'old',
        datasets: [
          {
            id: 'old',
            name: 'old',
            timezone: 'UTC',
            warnings: [],
            importedAt: '2026-01-01',
            calendar: [{ start_date: '20261124', end_date: '20261124' }],
            exceptions: [{ date: '20261126' }],
          },
        ],
      });
      await writeFile(file, legacy);
      assert.deepEqual((await data.active()).serviceDateRanges, [
        { start: '2026-11-24', end: '2026-11-24' },
        { start: '2026-11-26', end: '2026-11-26' },
      ]);
      assert.equal(await readFile(file, 'utf8'), legacy);
      await data.use('old');
      assert.equal(
        'exceptions' in JSON.parse(await readFile(file, 'utf8')).datasets[0],
        false,
      );
    },
  );
});
