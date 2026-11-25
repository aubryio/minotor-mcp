import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { Terminal, terminalFor, Progress, safe } from '../dist/cli/terminal.js';
import {
  renderStops,
  renderJourney,
  renderReachability,
  renderDatasets,
  renderPrepared,
  renderError,
} from '../dist/cli/render.js';
import { TransitError } from '../dist/index.js';

const stop = (id, name = id, extras = {}) => ({
  id,
  name,
  minotorId: 0,
  locationType: 'SIMPLE_STOP_OR_PLATFORM',
  children: [],
  ...extras,
});

const time = (iso, serviceMinutes) => ({ iso, serviceMinutes });

const depart = time('2026-11-24T08:00:00+01:00', 480);

const arrival = time('2026-11-24T09:00:00+01:00', 540);

const meta = {
  timezone: 'Europe/Zurich',
  serviceDate: '2026-11-24',
  effectiveDeparture: depart,
  warnings: [],
  mode: 'single_departure',
};

const vehicle = (from, to, departure = depart, end = arrival) => ({
  kind: 'vehicle',
  from,
  to,
  route: { name: 'IR 15', type: 3 },
  departure,
  arrival: end,
});

const journey = (legs, overrides = {}) => ({
  ...meta,
  itineraries: [
    {
      departure: depart,
      arrival,
      durationMinutes: 60,
      elapsedMinutes: 60,
      transferCount: 0,
      legs,
      ...overrides,
    },
  ],
});

test('stop layouts preserve Unicode names, exact IDs and station hierarchy at wide and narrow widths', () => {
  const longId = '8500000:'.repeat(10);
  const stops = [
    stop('P', 'Genève 東京', { locationType: 'STATION' }),
    stop(longId, 'Cafe\u0301 ' + 'Long name '.repeat(10), {
      parentId: 'P',
      platform: '2',
    }),
  ];

  for (const width of [40, 80, 120]) {
    const result = renderStops(stops, 'Genève', 2, new Terminal(width, true));
    const plain = stripVTControlCharacters(result);
    assert.match(plain, /Station/);
    assert.match(plain, /Pl\. 2/);
    assert.match(plain, /more matches may\s+exist/);
    assert.ok(plain.replace(/\n */g, '').includes(longId));
    assert.ok(plain.includes('Genève 東京'));

    for (const line of plain.split('\n')) {
      assert.ok(stringWidth(line) <= width, line);
    }
  }

  const wide = renderStops(
    [stop('A', 'Alpha'), stop('B', 'Beta')],
    'a',
    10,
    new Terminal(100),
  );
  assert.match(wide, /Name +Type \/ Pl\. +GTFS ID/);
  assert.doesNotMatch(wide, /more matches/);
  assert.match(
    renderStops([], 'absent', 10, new Terminal()),
    /No matching stops/,
  );
  const injected = renderStops(
    [stop('id', 'bad\u001b[31m\nname')],
    'x',
    10,
    new Terminal(),
  );
  assert.doesNotMatch(injected, /\u001b/);
  assert.match(injected, /\\u001b/);
  assert.equal(safe('a\tb'), 'a\\tb');
});

test('route timelines abbreviate platforms and keep transfers visually subdued', () => {
  const alpha = stop('A', 'Alpha', { platform: '1' });
  const beta = stop('B', 'Beta');
  const gamma = stop('C', 'Gamma');
  const result = journey(
    [
      { kind: 'access', from: stop('entrance'), to: alpha, durationMinutes: 3 },
      vehicle(
        alpha,
        beta,
        time('2026-11-24T08:05:00+01:00', 485),
        time('2026-11-24T08:50:00+01:00', 530),
      ),
      { kind: 'transfer', from: beta, to: beta, minTransferTime: 2 },
      vehicle(
        beta,
        gamma,
        time('2026-11-24T08:58:00+01:00', 538),
        time('2026-11-24T09:10:00+01:00', 550),
      ),
    ],
    {
      departure: time('2026-11-24T08:05:00+01:00', 485),
      arrival: time('2026-11-24T09:10:00+01:00', 550),
      durationMinutes: 65,
      elapsedMinutes: 70,
      transferCount: 1,
    },
  );
  const text = stripVTControlCharacters(
    renderJourney(result, 'A', 'C', new Terminal(100, true)),
  );

  for (const phrase of [
    '1 h 5 min journey',
    '1 h 10 min total',
    'Pl. 1',
    'Access · 3 min',
    'Transfer · minimum 2 min',
    'Train IR 15',
    '08:05',
    '09:10',
  ]) {
    assert.ok(text.includes(phrase), phrase);
  }

  assert.doesNotMatch(text, /Connection interval|8 min wait/);
  assert.match(
    renderJourney(
      journey([{ kind: 'transfer', from: alpha, to: beta }]),
      'A',
      'B',
      new Terminal(),
    ),
    /timing unavailable/,
  );
  assert.match(
    renderJourney(
      journey([{ kind: 'access', from: alpha, to: beta, durationMinutes: 7 }], {
        durationMinutes: 7,
      }),
      'A',
      'B',
      new Terminal(),
    ),
    /Access · 7 min/,
  );
  assert.match(
    renderJourney({ ...meta, itineraries: [] }, 'A', 'B', new Terminal()),
    /No journey found/,
  );
});

test('route clocks retain overnight and DST meaning independent of host timezone', () => {
  const alpha = stop('A');
  const beta = stop('B');
  const start = time('2026-11-24T23:50:00+01:00', 1430);
  const end = time('2026-11-25T00:10:00+01:00', 1450);
  const overnight = {
    ...journey([vehicle(alpha, beta, start, end)], {
      departure: start,
      arrival: end,
      durationMinutes: 20,
    }),
    effectiveDeparture: start,
  };
  assert.match(
    renderJourney(overnight, 'A', 'B', new Terminal()),
    /00:10 \(\+1d\)/,
  );
  const fallStart = time('2026-10-25T02:50:00+02:00', 110);
  const fallEnd = time('2026-10-25T02:10:00+01:00', 130);
  const fall = {
    ...journey([vehicle(alpha, beta, fallStart, fallEnd)], {
      departure: fallStart,
      arrival: fallEnd,
      durationMinutes: 20,
    }),
    effectiveDeparture: fallStart,
    serviceDate: '2026-10-25',
  };
  const text = renderJourney(fall, 'A', 'B', new Terminal(120));
  assert.match(text, /02:50 UTC\+02:00/);
  assert.match(text, /02:10 UTC\+01:00/);
  assert.match(text, /20 min journey/);
  const late = { ...overnight, effectiveDeparture: end };
  assert.match(
    renderJourney(late, 'A', 'B', new Terminal(120)),
    /Service date 24 Nov 2026/,
  );
});

test('reachability sorts its preview by the correct journey basis without mixing arrivals', () => {
  const row = (id, minutes) => ({
    stop: stop(id),
    earliestArrival: { arrival, durationMinutes: minutes, transferCount: 0 },
  });
  const single = { ...meta, stops: [row('B', 60), row('A', 10)] };
  const text = renderReachability(single, 'Origin', new Terminal(120));
  assert.ok(text.indexOf('10 min') < text.indexOf('1 h'));
  const window = {
    ...meta,
    mode: 'departure_window',
    effectiveLatestDeparture: arrival,
    stops: [
      {
        ...row('B', 60),
        shortestDuration: {
          arrival: time('2026-11-24T09:30:00+01:00', 570),
          departure: arrival,
          durationMinutes: 30,
          transferCount: 2,
        },
      },
    ],
  };
  const windowText = renderReachability(window, 'Origin', new Terminal(120));
  assert.match(windowText, /Shortest duration/);
  assert.match(windowText, /30 min +09:30 +2/);
  assert.match(
    renderReachability({ ...meta, stops: [] }, 'A', new Terminal()),
    /No reachable stops/,
  );
  assert.match(
    renderReachability(
      {
        ...meta,
        stops: Array.from({ length: 25 }, (unused, index) =>
          row(String(index), index),
        ),
      },
      'A',
      new Terminal(),
    ),
    /Showing 20 of 25/,
  );
});

test('dataset summaries and errors hide diagnostic fields while retaining actionable IDs and partial success', () => {
  const dataset = {
    id: 'a'.repeat(64),
    name: 'Switzerland',
    warnings: [],
    serviceDateRanges: [{ start: '2026-01-01', end: '2026-12-31' }],
    preparedDays: [
      {
        serviceDate: '2026-11-24',
        status: 'ready',
        preparedAt: 'internal timestamp',
      },
    ],
  };
  const listing = renderDatasets(
    { active: dataset.id, datasets: [dataset] },
    new Terminal(100),
  );
  assert.match(listing, /Active · Switzerland/);
  assert.ok(listing.includes(dataset.id));
  assert.doesNotMatch(listing, /internal timestamp/);
  assert.match(
    renderPrepared(
      dataset,
      ['2026-11-24'],
      new Set(['2026-11-24']),
      new Terminal(),
    ),
    /already prepared/,
  );
  assert.doesNotMatch(
    renderPrepared(dataset, ['2026-11-24'], new Set(), new Terminal()),
    /[a-f0-9]{64}/,
  );
  const error = new TransitError('DAY_NOT_PREPARED', 'Technical details', {
    serviceDate: '2026-11-27',
    availableDates: ['2026-11-24'],
    command: 'mn data prepare --service-date 2026-11-27',
  });
  const text = renderError(error, new Terminal(100));
  assert.match(text, /No timetable prepared for 2026-11-27/);
  assert.match(text, /Run: mn data prepare/);
  assert.ok(
    renderError(error, new Terminal(40)).includes(
      `Run: ${error.details.command}`,
    ),
  );
  assert.doesNotMatch(text, /Technical details|"code"/);
  assert.match(
    renderError(
      new TransitError('NO_SERVICE', 'No service', {
        completedDates: ['2026-11-24'],
        failedDate: '2026-11-25',
      }),
      new Terminal(),
    ),
    /Already prepared: 24 Nov 2026/,
  );
  assert.match(
    renderError(
      new TransitError('AMBIGUOUS_STOP', 'Use an exact ID', [
        { name: 'Alpha', id: 'A' },
      ]),
      new Terminal(),
    ),
    /GTFS ID/,
  );
});

test('terminal styling and progress respect capabilities and clear a single updating line', () => {
  const stream = { isTTY: true, columns: 80, write() {} };
  assert.equal(terminalFor(stream, true, {}).rich, true);

  for (const env of [
    { NO_COLOR: '' },
    { TERM: 'dumb' },
    { NODE_DISABLE_COLORS: '1' },
  ]) {
    assert.equal(terminalFor(stream, true, env).rich, false);
  }

  assert.equal(
    terminalFor({ ...stream, isTTY: false }, true, { FORCE_COLOR: '1' }).rich,
    false,
  );
  assert.equal(terminalFor(stream, false, {}).rich, false);
  const writes = [];
  const progress = new Progress(
    { ...stream, write: (text) => writes.push(text) },
    new Terminal(80, true),
  );
  progress.update('Reading feed and preparing stop metadata');
  progress.update(
    'Parsing timetable for 2026-11-24 with Minotor. This may take a few minutes.',
  );
  progress.clear();
  assert.equal(writes.filter((text) => text === '\r\u001b[2K').length, 2);
  const count = writes.length;
  progress.clear();
  assert.equal(writes.length, count);
  assert.match(writes.join(''), /may take a few minutes/);
  const plain = [];
  const jsonProgress = new Progress(
    { ...stream, write: (text) => plain.push(text) },
    new Terminal(80, true),
    true,
  );
  jsonProgress.update('Preparing service date 2026-11-24');
  jsonProgress.update('Reused prepared service date 2026-11-24');
  assert.equal(plain.length, 0);
  assert.ok(jsonProgress.reused.has('2026-11-24'));
  jsonProgress.update(
    'Parsing timetable for 2026-11-26 with Minotor. This may take a few minutes.',
  );
  assert.doesNotMatch(plain.join(''), /\u001b/);
  assert.match(plain.join(''), /few minutes/);
});
