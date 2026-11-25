import { DateTime } from 'luxon';

import type { JourneyOutput as Journey } from '../../core/outputs.js';
import type { Terminal } from '../terminal.js';
import { clock, duration, header, stopName, type Time } from './format.js';

const modeNames: Record<number, string> = {
  1: 'Tram',
  2: 'Metro',
  3: 'Train',
  4: 'Bus',
  5: 'Ferry',
  6: 'Cable tram',
  7: 'Cable car',
  8: 'Funicular',
  9: 'Trolleybus',
  10: 'Monorail',
};

export function renderJourney(
  value: Journey,
  origin: string,
  destination: string,
  terminal: Terminal,
) {
  const first = value.itineraries.at(0);
  const from = first?.legs.at(0)?.from.name ?? origin;
  const to = first?.legs.at(-1)?.to.name ?? destination;
  const blocks = [
    terminal.line(`${from} ${terminal.arrow} ${to}`, 'heading'),
    header(value, terminal),
  ];

  if (value.mode === 'departure_window' && value.effectiveLatestDeparture) {
    blocks.push(
      renderDepartureWindow(value, value.effectiveLatestDeparture, terminal),
    );
  }

  if (!first) {
    blocks.push(
      '',
      terminal.line(
        'No journey found for these stops and routing constraints.',
      ),
    );
  }

  for (const [index, journey] of value.itineraries.entries()) {
    if (value.mode === 'departure_window') {
      blocks.push('', terminal.line(`Journey ${index + 1}`, 'heading'));
    }

    blocks.push(...renderItinerary(value, journey, terminal));
  }

  return blocks.join('\n');
}

function renderDepartureWindow(
  value: Journey,
  latest: Time,
  terminal: Terminal,
) {
  const earliest = value.effectiveDeparture;
  const offsetChanges =
    DateTime.fromISO(earliest.iso).setZone(value.timezone).offset !==
    DateTime.fromISO(latest.iso).setZone(value.timezone).offset;
  const start = clock(earliest, earliest, value.timezone, offsetChanges);
  const end = clock(latest, earliest, value.timezone, offsetChanges);

  return terminal.line(`Departure window: ${start}–${end}`, 'muted');
}

type Itinerary = Journey['itineraries'][number];

type JourneyLeg = Itinerary['legs'][number];

/** Include UTC offsets when a journey crosses a daylight-saving transition. */
function renderItinerary(
  value: Journey,
  journey: Itinerary,
  terminal: Terminal,
) {
  const times = [
    value.effectiveDeparture,
    journey.departure,
    journey.arrival,
    ...journey.legs.flatMap((leg) =>
      leg.kind === 'vehicle' ? [leg.departure, leg.arrival] : [],
    ),
  ];
  const offsets = new Set(
    times.map(
      (time) => DateTime.fromISO(time.iso).setZone(value.timezone).offset,
    ),
  );
  const at = (time: Time) =>
    clock(time, value.effectiveDeparture, value.timezone, offsets.size > 1);
  const blocks = [
    '',
    terminal.line(
      `${at(journey.departure)}–${at(journey.arrival)}   ${duration(journey.durationMinutes)} journey   ${journey.transferCount} transfer${journey.transferCount === 1 ? '' : 's'}`,
      'accent',
    ),
  ];

  if (value.mode !== 'departure_window') {
    blocks.push(
      terminal.line(
        `Requested ${at(value.effectiveDeparture)} · ${duration(journey.elapsedMinutes)} total`,
        'muted',
      ),
    );
  }

  blocks.push('');
  blocks.push(...renderLegs(journey.legs, terminal, at));

  return blocks;
}

function renderLegs(
  legs: JourneyLeg[],
  terminal: Terminal,
  at: (time: Time) => string,
) {
  const blocks: string[] = [];

  for (const leg of legs) {
    const point = terminal.rich ? '●' : '*';
    const bar = terminal.rich ? '│' : '|';

    if (leg.kind === 'vehicle') {
      blocks.push(
        terminal.line(`${at(leg.departure)}  ${point} ${stopName(leg.from)}`),
        terminal.line(
          `${bar} ${modeNames[leg.route.type] ?? 'Transit'} ${leg.route.name} · ${duration(leg.arrival.serviceMinutes - leg.departure.serviceMinutes)}`,
          'accent',
          '       ',
        ),
        terminal.line(`${at(leg.arrival)}  ${point} ${stopName(leg.to)}`),
      );
    } else {
      const label =
        leg.kind === 'access'
          ? `Access · ${duration(leg.durationMinutes)}`
          : `Transfer${leg.minTransferTime !== undefined ? ` · minimum ${duration(leg.minTransferTime)}` : ' · timing unavailable'}`;
      blocks.push(
        terminal.line(
          `${bar} ${label}`,
          leg.kind === 'transfer' ? 'subtle' : 'accent',
          '       ',
        ),
      );

      if (leg.kind === 'access') {
        blocks.push(
          terminal.line(
            `${stopName(leg.from)} ${terminal.arrow} ${stopName(leg.to)}`,
            undefined,
            '         ',
          ),
        );
      }
    }
  }

  return blocks;
}
