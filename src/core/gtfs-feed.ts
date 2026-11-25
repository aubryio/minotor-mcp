import { parse } from 'csv-parse';
import { DateTime } from 'luxon';
import { extendedGtfsProfile, standardGtfsProfile } from 'minotor/parser';
import StreamZip from 'node-stream-zip';

import { TransitError } from './schemas.js';
import { ServiceCoverage } from './service-calendar.js';

export const profile = {
  deriveSiblingTransfers: true,
  routeTypeParser: (routeType: number) =>
    standardGtfsProfile.routeTypeParser(routeType) ??
    extendedGtfsProfile.routeTypeParser(routeType),
};

type FeedArchive = InstanceType<typeof StreamZip.async>;

type FeedEntries = Awaited<ReturnType<FeedArchive['entries']>>;

type FeedRow = Record<string, string>;

async function* streamRows(
  zip: FeedArchive,
  file: string,
): AsyncGenerator<FeedRow> {
  const stream = await zip.stream(file);
  const rows = stream.pipe(
    parse({ columns: true, bom: true, skip_empty_lines: true }),
  );

  for await (const row of rows as AsyncIterable<FeedRow>) {
    yield row;
  }
}

async function readRows(
  zip: FeedArchive,
  entries: FeedEntries,
  file: string,
): Promise<FeedRow[]> {
  if (!Object.hasOwn(entries, file)) {
    return [];
  }

  const rows: FeedRow[] = [];

  for await (const row of streamRows(zip, file)) {
    rows.push(row);
  }

  return rows;
}

async function readTimezone(zip: FeedArchive, entries: FeedEntries) {
  const agencies = await readRows(zip, entries, 'agency.txt');
  const zones = new Set(agencies.map((agency) => agency.agency_timezone));
  const timezone = [...zones][0];

  if (
    zones.size !== 1 ||
    !timezone ||
    !DateTime.now().setZone(timezone).isValid
  ) {
    throw new TransitError(
      'INVALID_TIMEZONE',
      'Feed must specify one valid agency timezone',
    );
  }

  return timezone;
}

async function readServiceCoverage(zip: FeedArchive, entries: FeedEntries) {
  const coverage = new ServiceCoverage();

  for (const file of ['calendar.txt', 'calendar_dates.txt']) {
    if (!Object.hasOwn(entries, file)) {
      continue;
    }

    for await (const row of streamRows(zip, file)) {
      if (file === 'calendar.txt') {
        coverage.add(row.start_date, row.end_date);
      } else {
        coverage.add(row.date);
      }
    }
  }

  const serviceDateRanges = coverage.finish();

  if (!serviceDateRanges.length) {
    throw new TransitError('INVALID_CALENDAR', 'No service calendar');
  }

  return serviceDateRanges;
}

async function readWarnings(zip: FeedArchive, entries: FeedEntries) {
  const warnings: string[] = [];
  const routes = await readRows(zip, entries, 'routes.txt');
  const unsupported = routes.filter(
    (row) => profile.routeTypeParser(Number(row.route_type)) === undefined,
  );

  if (unsupported.length) {
    warnings.push(
      `${unsupported.length} routes have unsupported transport modes and will be omitted`,
    );
  }

  if (
    (await readRows(zip, entries, 'frequencies.txt')).some(
      (row) => row.exact_times !== '1',
    )
  ) {
    warnings.push(
      'Non-exact frequency services are approximated as scheduled departures by Minotor',
    );
  }

  return warnings;
}

/** Validate required GTFS files and collect the metadata used during import. */
export async function inspectFeed(zip: FeedArchive) {
  const entries = await zip.entries();

  for (const file of [
    'agency.txt',
    'stops.txt',
    'routes.txt',
    'trips.txt',
    'stop_times.txt',
  ]) {
    if (!Object.hasOwn(entries, file)) {
      throw new TransitError('INVALID_FEED', `Missing ${file}`);
    }
  }

  const timezone = await readTimezone(zip, entries);
  const serviceDateRanges = await readServiceCoverage(zip, entries);
  const warnings = await readWarnings(zip, entries);

  return { timezone, serviceDateRanges, warnings };
}
