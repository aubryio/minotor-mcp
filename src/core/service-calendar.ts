import { DateTime } from 'luxon';

import type { ServiceDateRange } from './datasets.js';
import { TransitError } from './schemas.js';

/** Validate and deduplicate ISO service dates while preserving request order. */
export function validateServiceDates(input: string[]): string[] {
  if (!Array.isArray(input) || !input.length) {
    throw new TransitError(
      'INVALID_SERVICE_DATE',
      'Provide at least one --service-date YYYY-MM-DD',
    );
  }

  for (const date of input) {
    if (
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !DateTime.fromISO(date, { zone: 'UTC' }).isValid
    ) {
      throw new TransitError(
        'INVALID_SERVICE_DATE',
        `Invalid service date: ${date}`,
      );
    }
  }

  return [...new Set(input)];
}

/** Merge feed date ranges into coverage; actual service depends on calendar exceptions. */
export class ServiceCoverage {
  private ranges = new Map<string, string>();

  add(start: string, end = start) {
    const previous = this.ranges.get(start);

    if (!previous || end > previous) {
      this.ranges.set(start, end);
    }
  }

  finish(): ServiceDateRange[] {
    const result: ServiceDateRange[] = [];

    for (const [rawStart, rawEnd] of [...this.ranges].sort()) {
      const start = DateTime.fromFormat(rawStart, 'yyyyMMdd', { zone: 'UTC' });
      const end = DateTime.fromFormat(rawEnd, 'yyyyMMdd', { zone: 'UTC' });

      if (!start.isValid || !end.isValid || end < start) {
        throw new TransitError(
          'INVALID_CALENDAR',
          'Invalid calendar date range',
        );
      }

      const last = result.at(-1);

      if (
        last &&
        start <= DateTime.fromISO(last.end, { zone: 'UTC' }).plus({ days: 1 })
      ) {
        if (end.toISODate() > last.end) {
          last.end = end.toISODate();
        }
      } else {
        result.push({ start: start.toISODate(), end: end.toISODate() });
      }
    }

    return result;
  }
}
