import type { Arrival, Leg, Route, Stop } from 'minotor';

import type { JourneyLeg, JourneyOutput, StopOutput } from './outputs.js';
import type { RoutingContext } from './routing-context.js';
import { TransitError } from './schemas.js';

export function sourceStopId(stop: Stop | undefined): string {
  if (!stop?.sourceStopId) {
    throw new TransitError(
      'INVALID_STOP_DATA',
      'Stop metadata contains a missing GTFS stop reference',
    );
  }

  return stop.sourceStopId;
}

export function toStopOutput(
  stop: Stop | undefined,
  index: { findStopById(id: number): Stop | undefined },
): StopOutput {
  if (!stop) {
    throw new TransitError('INVALID_STOP_DATA', 'Stop metadata is missing');
  }

  return {
    id: sourceStopId(stop),
    minotorId: stop.id,
    name: stop.name,
    latitude: stop.lat,
    longitude: stop.lon,
    platform: stop.platform,
    locationType: stop.locationType,
    parentId:
      stop.parent === undefined
        ? undefined
        : sourceStopId(index.findStopById(stop.parent)),
    children: stop.children.map((id) => sourceStopId(index.findStopById(id))),
  };
}

/** Preserve the engine's vehicle, access, and transfer leg distinctions. */
export function toJourneyLeg(leg: Leg, context: RoutingContext): JourneyLeg {
  const base = {
    from: context.stop(leg.from.id),
    to: context.stop(leg.to.id),
  };

  if ('route' in leg) {
    return {
      ...base,
      kind: 'vehicle',
      route: leg.route,
      departure: context.time(leg.departureTime),
      arrival: context.time(leg.arrivalTime),
      pickUpType: leg.pickUpType,
      dropOffType: leg.dropOffType,
    };
  }

  if ('duration' in leg) {
    return { ...base, kind: 'access', durationMinutes: leg.duration };
  }

  return {
    ...base,
    kind: 'transfer',
    type: leg.type,
    minTransferTime: leg.minTransferTime,
  };
}

/** Keep each itinerary's timings and transfer count tied to its own routing run. */
export function toJourneyItinerary(
  route: Route,
  arrival: Arrival,
  context: RoutingContext,
  departure?: number,
): JourneyOutput['itineraries'][number] {
  const hasVehicle = route.legs.some((leg) => 'route' in leg);
  const originDeparture =
    departure ?? (hasVehicle ? route.departureTime() : context.departure);

  return {
    ...context.arrival(arrival),
    departure: context.time(originDeparture),
    durationMinutes: arrival.arrival - originDeparture,
    elapsedMinutes: arrival.arrival - context.departure,
    legs: route.legs.map((leg) => toJourneyLeg(leg, context)),
  };
}
