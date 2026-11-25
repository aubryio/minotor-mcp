import type { z as zod } from 'zod';

import type {
  CompactReachabilityRow,
  ReachabilityResult,
  ReachabilityStatistics,
} from './outputs.js';
import { queryReachabilitySchema, TransitError } from './schemas.js';

export type AnalysisRow = CompactReachabilityRow & {
  name: string;
  durationMinutes: number;
  arrival: { serviceMinutes: number; iso: string };
  transferCount: number;
};

export function resultBasis(result: ReachabilityResult) {
  return result.mode === 'single_departure'
    ? 'earliestArrival'
    : 'shortestDuration';
}

/** Select earliest arrivals for departures and shortest durations for windows. */
export function analysisRows(result: ReachabilityResult): AnalysisRow[] {
  return result.stops.map(({ stop, earliestArrival, shortestDuration }) => {
    const selected =
      result.mode === 'single_departure' ? earliestArrival : shortestDuration;

    if (!selected || selected.durationMinutes === undefined) {
      throw new TransitError(
        'RESULT_NOT_FOUND',
        'Incomplete result; repeat the query',
      );
    }

    return {
      id: stop.id,
      name: stop.name,
      ...(stop.latitude !== undefined ? { latitude: stop.latitude } : {}),
      ...(stop.longitude !== undefined ? { longitude: stop.longitude } : {}),
      ...(stop.parentId !== undefined ? { parentId: stop.parentId } : {}),
      ...(stop.platform !== undefined ? { platform: stop.platform } : {}),
      durationMinutes: selected.durationMinutes,
      arrival: selected.arrival,
      ...(result.mode === 'departure_window' && shortestDuration
        ? { departure: shortestDuration.departure }
        : {}),
      transferCount: selected.transferCount,
    };
  });
}

function hasCoordinates(
  row: CompactReachabilityRow,
): row is CompactReachabilityRow & { latitude: number; longitude: number } {
  return Number.isFinite(row.latitude) && Number.isFinite(row.longitude);
}

/** Summarize durations and finite coordinates without allocating extra row arrays. */
export function summarizeRows(rows: AnalysisRow[]): ReachabilityStatistics {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let withCoordinates = 0;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const row of rows) {
    min = Math.min(min, row.durationMinutes);
    max = Math.max(max, row.durationMinutes);
    sum += row.durationMinutes;

    if (hasCoordinates(row)) {
      withCoordinates++;
      west = Math.min(west, row.longitude);
      east = Math.max(east, row.longitude);
      south = Math.min(south, row.latitude);
      north = Math.max(north, row.latitude);
    }
  }

  return {
    durationMinutes: rows.length ? { min, max, mean: sum / rows.length } : null,
    withCoordinates,
    bounds: withCoordinates ? { west, south, east, north } : null,
  };
}

export function compareValues(left: number | string, right: number | string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

type AnalysisQuery = zod.output<typeof queryReachabilitySchema>;

/** Apply filters before pagination so statistics describe every matching stop. */
export function filterRows(
  rows: AnalysisRow[],
  filters: AnalysisQuery['filters'],
) {
  const stopIds =
    filters.stopIds === undefined ? undefined : new Set(filters.stopIds);
  const name = filters.name?.toLowerCase();

  return rows.filter(
    (row) =>
      (!stopIds || stopIds.has(row.id)) &&
      (name === undefined || row.name.toLowerCase().includes(name)) &&
      (filters.minDuration === undefined ||
        row.durationMinutes >= filters.minDuration) &&
      (filters.maxDuration === undefined ||
        row.durationMinutes <= filters.maxDuration) &&
      (filters.maxTransfers === undefined ||
        row.transferCount <= filters.maxTransfers) &&
      (filters.hasCoordinates === undefined ||
        hasCoordinates(row) === filters.hasCoordinates),
  );
}

/** Use stop IDs as a stable tie-breaker regardless of the requested sort order. */
export function sortRows(rows: AnalysisRow[], query: AnalysisQuery) {
  rows.sort((leftRow, rightRow) => {
    const left =
      query.sortBy === 'arrival'
        ? leftRow.arrival.serviceMinutes
        : leftRow[query.sortBy];
    const right =
      query.sortBy === 'arrival'
        ? rightRow.arrival.serviceMinutes
        : rightRow[query.sortBy];

    return (
      compareValues(left, right) * (query.order === 'asc' ? 1 : -1) ||
      compareValues(leftRow.id, rightRow.id)
    );
  });
}

export function projectRow(
  row: AnalysisRow,
  fields: AnalysisQuery['fields'],
): CompactReachabilityRow {
  const projected: CompactReachabilityRow = { id: row.id };

  for (const field of fields) {
    const value = row[field];

    if (value !== undefined) {
      Object.assign(projected, { [field]: value });
    }
  }

  return projected;
}
