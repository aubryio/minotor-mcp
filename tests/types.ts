import {
  RoutingService,
  Results,
  type SearchOutput,
  type JourneyOutput,
  type JourneyLeg,
  type ReachabilityResult,
  type ReachabilityPage,
} from 'minotor-mcp';

// Compile against the published declarations, as a package consumer would.
async function consume(service: RoutingService, results: Results) {
  const search: SearchOutput = await service.searchStops({ query: 'Alpha' });
  const children: string[] = search.stops[0].children;
  const query = { origin: 'A', departure: '2026-11-24T08:00:00+01:00' };
  const journey: JourneyOutput = await service.planJourney({
    ...query,
    destination: 'B',
  });
  const version: 1 = journey.schemaVersion;
  const realtime: false = journey.realtime;
  const leg: JourneyLeg = journey.itineraries[0].legs[0];

  if (leg.kind === 'vehicle') {
    const name: string = leg.route.name;
  }

  const rangeJourney: JourneyOutput = await service.planJourney({
    ...query,
    destination: 'B',
    latestDeparture: '2026-11-24T08:30:00+01:00',
  });
  const windowEnd: number | undefined =
    rangeJourney.effectiveLatestDeparture?.serviceMinutes;
  const routingMode: 'single_departure' | 'departure_window' | undefined =
    rangeJourney.mode;

  const searches = await service.searchStopsBatch({
    queries: [{ query: 'Alpha' }],
  });
  const journeys = await service.planJourneys({
    queries: [{ ...query, destination: 'B' }],
  });

  for (const item of searches.results) {
    if (item.ok) {
      const result: SearchOutput = item.result;
    } else {
      const code: string = item.error.code;
    }
  }

  for (const item of journeys.results) {
    if (item.ok) {
      const result: JourneyOutput = item.result;
    } else {
      const message: string = item.error.message;
    }
  }

  await service.planJourneys({
    // @ts-expect-error Journey batches require exact-ID string endpoints.
    queries: [{ ...query, destination: { name: 'Beta' } }],
  });

  const reachability: ReachabilityResult =
    await service.computeReachability(query);
  const id = await results.save(reachability);
  const page: ReachabilityPage = await results.page(id);

  // @ts-expect-error A saved result must contain full routing metadata.
  await results.save({ stops: [] });
  // @ts-expect-error Misspelled constraints are not part of the public input.
  await service.computeReachability({ ...query, maxTransfer: 0 });
}
