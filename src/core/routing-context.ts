import { DateTime } from 'luxon';
import { Query, Router, RouteTypes } from 'minotor';
import { z as zod } from 'zod';

import type { Datasets } from './datasets.js';
import type { RoutingMetadata } from './outputs.js';
import { toStopOutput } from './routing-output.js';
import { routingSchema, TransitError } from './schemas.js';

type RoutingQuery = zod.output<typeof routingSchema>;

export type RoutingContext = Awaited<ReturnType<typeof prepareRouting>>;

/** GTFS measures time from local noon minus twelve hours, including on DST changes. */
function serviceDeparture(query: RoutingQuery, timezone: string) {
  const requestedDeparture = DateTime.fromISO(query.departure, {
    setZone: true,
  }).setZone(timezone);

  if (!requestedDeparture.isValid) {
    throw new TransitError('INVALID_TIME', 'Invalid departure timestamp');
  }

  const serviceDate = query.serviceDate ?? requestedDeparture.toISODate();
  const anchor = DateTime.fromISO(serviceDate + 'T12:00:00', {
    zone: timezone,
  }).minus({ hours: 12 });
  const departure = Math.ceil(
    requestedDeparture.diff(anchor, 'minutes').minutes,
  );

  if (departure < 0 || departure >= 65535) {
    throw new TransitError(
      'INVALID_TIME',
      'Departure falls outside the selected service-day time range',
    );
  }

  return { serviceDate, anchor, departure };
}

function configureQuery<Builder extends InstanceType<typeof Query.Builder>>(
  builder: Builder,
  query: RoutingQuery,
  originId: number,
  departure: number,
): Builder {
  // Minotor's fluent setters return `any` in its published declarations.
  builder.from(originId);
  builder.departureTime(departure);
  builder.maxTransfers(query.maxTransfers);
  builder.minTransferTime(query.minTransferTime);

  if (query.maxDuration !== undefined) {
    builder.maxDuration(query.maxDuration);
  }

  if (query.transportModes) {
    builder.transportModes(
      new Set(query.transportModes.map((mode) => RouteTypes[mode])),
    );
  }

  return builder;
}

/** Load one prepared service day and bind its output and query conversions. */
export async function prepareRouting(datasets: Datasets, query: RoutingQuery) {
  const dataset = await datasets.active();
  const { serviceDate, anchor, departure } = serviceDeparture(
    query,
    dataset.timezone,
  );
  const stops = await datasets.stops(dataset);
  const timetable = await datasets.timetable(dataset, serviceDate);
  const origin = stops.findStopBySourceStopId(query.origin);

  if (!origin) {
    throw new TransitError('UNKNOWN_STOP', `Unknown stop ID: ${query.origin}`);
  }

  const router = new Router(timetable, stops);
  const metadata = await datasets.stopMetadata(dataset);
  const stop = (id: number) => toStopOutput(metadata[id], stops);

  const time = (minute: number) => {
    const value = anchor.plus({ minutes: minute });

    if (!value.isValid) {
      throw new TransitError('INVALID_TIME', 'Invalid service time');
    }

    return { serviceMinutes: minute, iso: value.toISO() };
  };

  const arrival = (engineArrival: { arrival: number; legNumber: number }) => ({
    arrival: time(engineArrival.arrival),
    legNumber: engineArrival.legNumber,
    transferCount: Math.max(0, engineArrival.legNumber - 1),
  });

  const configure = <Builder extends InstanceType<typeof Query.Builder>>(
    builder: Builder,
  ) => configureQuery(builder, query, origin.id, departure);

  const meta: RoutingMetadata = {
    schemaVersion: 1,
    datasetId: dataset.id,
    timezone: dataset.timezone,
    serviceDate,
    realtime: false,
    precision: 'minute',
    effectiveDeparture: time(departure),
    query,
    warnings: [
      ...dataset.warnings,
      'Only the selected service-day timetable is included; adjacent timetables are not combined.',
    ],
    engine: 'minotor@13.0.1',
  };

  return {
    stops,
    router,
    departure,
    anchor,
    time,
    arrival,
    configure,
    meta,
    stop,
  };
}
