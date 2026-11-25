import { DateTime } from 'luxon';

import type { ReachabilityResult } from '../../core/outputs.js';
import { TransitError } from '../../core/schemas.js';
import type { Terminal } from '../terminal.js';
import { clock, duration, header, notes, stopName } from './format.js';

export function renderReachability(
  value: ReachabilityResult,
  origin: string,
  terminal: Terminal,
) {
  const window = value.mode === 'departure_window';
  const rows = value.stops.map((row) => {
    const arrival = window ? row.shortestDuration : row.earliestArrival;

    if (!arrival || arrival.durationMinutes === undefined) {
      throw new TransitError(
        'INVALID_RESULT',
        'Reachability row is missing its duration',
      );
    }

    return {
      stop: row.stop,
      arrival,
      durationMinutes: arrival.durationMinutes,
    };
  });
  rows.sort(
    (left, right) =>
      left.durationMinutes - right.durationMinutes ||
      (left.stop.id < right.stop.id
        ? -1
        : left.stop.id > right.stop.id
          ? 1
          : 0),
  );
  const reference = value.effectiveDeparture;
  const offset =
    new Set(
      [reference, ...rows.map((row) => row.arrival.arrival)].map(
        (time) => DateTime.fromISO(time.iso).setZone(value.timezone).offset,
      ),
    ).size > 1;
  const lines = [
    terminal.line(`Reachable from ${origin}`, 'heading'),
    header(value, terminal),
    terminal.line(
      `${rows.length} stop/Pl. rows · ${window ? 'Shortest duration in departure window' : 'Earliest arrival, including initial waiting'}`,
      'accent',
    ),
  ];

  if (window && value.effectiveLatestDeparture) {
    lines.push(
      terminal.line(
        `Departure window: ${clock(reference, reference, value.timezone, offset)}–${clock(value.effectiveLatestDeparture, reference, value.timezone, offset)}`,
        'muted',
      ),
    );
  }

  if (!rows.length) {
    lines.push(
      '',
      terminal.line('No reachable stops for these routing constraints.'),
    );
  } else {
    lines.push(
      '',
      terminal.table(
        ['Stop', 'Duration', 'Arrival', 'Transfers', 'GTFS ID'],
        rows
          .slice(0, 20)
          .map(({ stop, arrival, durationMinutes }) => [
            stopName(stop),
            duration(durationMinutes),
            clock(arrival.arrival, reference, value.timezone, offset),
            String(arrival.transferCount),
            stop.id,
          ]),
      ),
      '',
      terminal.line(
        `Showing ${Math.min(20, rows.length)} of ${rows.length} rows. Use --json or --output for complete results.`,
        'muted',
      ),
    );
  }

  const footer = notes(value, terminal);

  if (footer) {
    lines.push('', footer);
  }

  return lines.join('\n');
}
