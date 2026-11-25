import type { StopOutput as Stop } from '../../core/outputs.js';
import type { Terminal } from '../terminal.js';

function stopType(stop: Stop) {
  const names: Record<string, string> = {
    STATION: 'Station',
    SIMPLE_STOP_OR_PLATFORM: stop.platform || stop.parentId ? 'Pl.' : 'Stop',
    ENTRANCE_EXIT: 'Entrance / exit',
    GENERIC_NODE: 'Connection point',
    BOARDING_AREA: 'Boarding area',
  };

  return `${names[stop.locationType] ?? 'Stop'}${stop.platform ? ` ${stop.platform}` : ''}`;
}

export function renderStops(
  stops: Stop[],
  query: string,
  limit: number,
  terminal: Terminal,
) {
  const lines = [
    terminal.line(`Stops matching “${query}”`, 'heading'),
    terminal.line(
      `${stops.length} match${stops.length === 1 ? '' : 'es'} returned`,
      'muted',
    ),
    '',
  ];

  if (!stops.length) {
    lines.push(
      terminal.line('No matching stops. Try a shorter or different name.'),
    );
  } else {
    lines.push(
      terminal.table(
        ['Name', 'Type / Pl.', 'GTFS ID'],
        stops.map((stop) => [stop.name, stopType(stop), stop.id]),
        stops.map((stop) =>
          stop.parentId ? `Parent: ${stop.parentId}` : undefined,
        ),
      ),
    );
    lines.push(
      '',
      terminal.line(
        'Use an exact GTFS ID in route commands to resolve ambiguous names.',
        'muted',
      ),
    );

    if (stops.length >= limit) {
      lines.push(
        terminal.line(
          `Limit of ${limit} reached; more matches may exist. Increase --limit (maximum 100).`,
          'muted',
        ),
      );
    }
  }

  return lines.join('\n');
}
