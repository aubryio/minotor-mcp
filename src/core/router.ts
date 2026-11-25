import { Query, RangeQuery } from 'minotor';
import { z as zod } from 'zod';

import { Datasets } from './datasets.js';
import type {
  JourneyBatchOutput,
  JourneyOutput,
  ReachabilityResult,
  SearchBatchOutput,
  SearchOutput,
} from './outputs.js';
import { prepareRouting, type RoutingContext } from './routing-context.js';
import {
  sourceStopId,
  toJourneyItinerary,
  toStopOutput,
} from './routing-output.js';
import { latestDepartureMinute } from './routing-window.js';
import {
  type JourneyBatchInput,
  journeyBatchSchema,
  type JourneyInput,
  journeySchema,
  type ReachabilityInput,
  reachabilitySchema,
  type SearchBatchInput,
  searchBatchSchema,
  type SearchInput,
  searchSchema,
  TransitError,
} from './schemas.js';

type ReachabilityQuery = zod.output<typeof reachabilitySchema> & {
  mode: 'single_departure' | 'departure_window';
};

const JOURNEY_LIMITATION =
  'Intermediate stop sequences and original GTFS trip/route IDs are not exposed by Minotor journey legs.';
const WINDOW_LIMITATION =
  'Window routing evaluates Minotor boarding departure slots; with no slots the result is empty, including access-only stops.';

/** Route exact GTFS stop IDs against the active dataset and prepared service days. */
export class RoutingService {
  constructor(public datasets = new Datasets()) {}

  async searchStops(input: SearchInput): Promise<SearchOutput> {
    const query = searchSchema.parse(input);
    const dataset = await this.datasets.active();
    const stops = await this.datasets.stops(dataset);
    const metadata = await this.datasets.stopMetadata(dataset);

    return {
      datasetId: dataset.id,
      stops: stops
        .findStopsByName(query.query, query.limit)
        .map((candidate) => toStopOutput(metadata[candidate.id], stops)),
    };
  }

  async searchStopsBatch(input: SearchBatchInput): Promise<SearchBatchOutput> {
    const { queries } = searchBatchSchema.parse(input);

    return executeBatch(queries, (query) => this.searchStops(query));
  }

  async planJourneys(input: JourneyBatchInput): Promise<JourneyBatchOutput> {
    const { queries } = journeyBatchSchema.parse(input);

    return executeBatch(queries, (query) => this.planJourney(query));
  }

  /** Resolve a CLI stop name, rejecting ambiguity instead of choosing a match. */
  async resolve(value: string) {
    const dataset = await this.datasets.active();
    const stops = await this.datasets.stops(dataset);
    const exact = stops.findStopBySourceStopId(value);

    if (exact) {
      return value;
    }

    const found = stops.findStopsByName(value, 100);
    const names = found.filter(
      (candidate) =>
        candidate.name.toLocaleLowerCase() === value.toLocaleLowerCase(),
    );
    const candidates = names.length ? names : found;

    if (!candidates.length) {
      throw new TransitError('UNKNOWN_STOP', `No stop matches: ${value}`);
    }

    if (candidates.length === 1) {
      return sourceStopId(candidates[0]);
    }

    throw new TransitError(
      'AMBIGUOUS_STOP',
      'Use a GTFS stop ID from stops search',
      candidates.map((candidate) => ({
        id: sourceStopId(candidate),
        name: candidate.name,
      })),
    );
  }

  /** Return an earliest journey or the retained departure-window alternatives. */
  async planJourney(input: JourneyInput): Promise<JourneyOutput> {
    const query = journeySchema.parse(input);
    const context = await prepareRouting(this.datasets, query);
    const destination = context.stops.findStopBySourceStopId(query.destination);

    if (!destination) {
      throw new TransitError(
        'UNKNOWN_STOP',
        `Unknown stop ID: ${query.destination}`,
      );
    }

    if (query.latestDeparture !== undefined) {
      return this.departureWindowJourneys(query, context, destination.id);
    }

    const builder = context.configure(new Query.Builder());
    builder.to(destination.id);
    const result = context.router.route(builder.build());
    const arrival = result.arrivalAt(destination.id);
    const route = result.bestRoute();

    if (!arrival || !route) {
      return { ...context.meta, query, itineraries: [] };
    }

    return {
      ...context.meta,
      query,
      itineraries: [toJourneyItinerary(route, arrival, context)],
      limitations: [JOURNEY_LIMITATION],
    };
  }

  private departureWindowJourneys(
    query: zod.output<typeof journeySchema>,
    context: RoutingContext,
    destinationId: number,
  ): JourneyOutput {
    const latest = latestDepartureMinute(query.latestDeparture, context);
    const builder = context.configure(new RangeQuery.Builder());
    builder.to(destinationId);
    builder.lastDepartureTime(latest);
    builder.rangeOptions({ optimizeBeyondLatestDeparture: false });
    const result = context.router.rangeRoute(builder.build());
    const itineraries: JourneyOutput['itineraries'] = [];

    // Minotor retains runs latest-first; the display and API use earliest-first.
    for (const run of [...result].reverse()) {
      const route = run.result.bestRoute();
      const arrival = run.result.arrivalAt(destinationId);

      if (!route || !arrival) {
        throw new TransitError(
          'INVALID_RESULT',
          'Retained journey is missing its route or arrival',
        );
      }

      itineraries.push(
        toJourneyItinerary(route, arrival, context, run.departureTime),
      );
    }

    return {
      ...context.meta,
      query,
      mode: 'departure_window',
      effectiveLatestDeparture: context.time(latest),
      itineraries,
      limitations: [JOURNEY_LIMITATION, WINDOW_LIMITATION],
    };
  }

  /** Find reachable stops for one departure or a bounded departure window. */
  async computeReachability(
    input: ReachabilityInput,
  ): Promise<ReachabilityResult> {
    const parsedQuery = reachabilitySchema.parse(input);
    const query: ReachabilityQuery = {
      ...parsedQuery,
      mode:
        parsedQuery.latestDeparture !== undefined
          ? 'departure_window'
          : 'single_departure',
    };
    const context = await prepareRouting(this.datasets, query);

    if (query.mode === 'single_departure') {
      return this.singleDepartureReachability(query, context);
    }

    return this.departureWindowReachability(query, context);
  }

  private singleDepartureReachability(
    query: ReachabilityQuery,
    context: RoutingContext,
  ): ReachabilityResult {
    const result = context.router.route(
      context.configure(new Query.Builder()).build(),
    );

    return {
      ...context.meta,
      query,
      mode: query.mode,
      stops: [...result.arrivals()].map((arrival) => ({
        stop: context.stop(arrival.stop),
        earliestArrival: {
          ...context.arrival(arrival),
          durationMinutes: arrival.arrival - context.departure,
        },
      })),
    };
  }

  private departureWindowReachability(
    query: ReachabilityQuery,
    context: RoutingContext,
  ): ReachabilityResult {
    const latest = latestDepartureMinute(query.latestDeparture, context);
    const builder = context.configure(new RangeQuery.Builder());
    builder.lastDepartureTime(latest);
    builder.rangeOptions({ optimizeBeyondLatestDeparture: false });
    const result = context.router.rangeRoute(builder.build());
    const shortest = new Map(
      [...result.shortestDurations()].map((arrival) => [arrival.stop, arrival]),
    );

    return {
      ...context.meta,
      query,
      mode: query.mode,
      effectiveLatestDeparture: context.time(latest),
      stops: [...result.arrivals()].map((arrival) => {
        const best = shortest.get(arrival.stop);

        if (!best) {
          throw new TransitError(
            'INVALID_RESULT',
            'Reachable stop is missing its shortest duration',
          );
        }

        return {
          stop: context.stop(arrival.stop),
          earliestArrival: context.arrival(arrival),
          shortestDuration: {
            ...context.arrival(best),
            durationMinutes: best.duration,
            departure: context.time(best.arrival - best.duration),
          },
        };
      }),
      limitations: [WINDOW_LIMITATION],
    };
  }
}

async function executeBatch<Input, Output>(
  queries: Input[],
  execute: (query: Input) => Promise<Output>,
) {
  const results = [];

  for (const query of queries) {
    try {
      results.push({ ok: true as const, result: await execute(query) });
    } catch (error) {
      results.push({
        ok: false as const,
        error: {
          code: error instanceof TransitError ? error.code : 'QUERY_FAILED',
          message: error instanceof Error ? error.message : String(error),
          details: error instanceof TransitError ? error.details : undefined,
        },
      });
    }
  }

  return { results };
}
