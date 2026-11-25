import { DateTime } from 'luxon';

import type { RoutingContext } from './routing-context.js';
import { TransitError } from './schemas.js';

/** Round the inclusive window end down using the same service-day anchor as departure. */
export function latestDepartureMinute(
  latestDeparture: string | undefined,
  context: Pick<RoutingContext, 'anchor' | 'departure'>,
): number {
  if (!latestDeparture) {
    throw new TransitError(
      'INVALID_WINDOW',
      'Window mode requires latestDeparture',
    );
  }

  const latest = Math.floor(
    DateTime.fromISO(latestDeparture, { setZone: true }).diff(
      context.anchor,
      'minutes',
    ).minutes,
  );

  if (
    !Number.isFinite(latest) ||
    latest < context.departure ||
    latest >= 65535
  ) {
    throw new TransitError(
      'INVALID_WINDOW',
      'Window end must follow departure and fit within the service-day time range',
    );
  }

  return latest;
}
