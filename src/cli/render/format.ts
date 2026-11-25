import { DateTime } from 'luxon';

import type {
  JourneyOutput as Journey,
  StopOutput as Stop,
} from '../../core/outputs.js';
import type { Terminal } from '../terminal.js';

export type Time = { iso: string; serviceMinutes: number };

export function duration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`;
}

export function date(value: string) {
  const parsed = DateTime.fromISO(value, { zone: 'UTC', locale: 'en' });

  return parsed.isValid ? parsed.toFormat('d LLL yyyy') : value;
}

export function clock(
  time: Time,
  reference: Time,
  timezone: string,
  offset: boolean,
) {
  const value = DateTime.fromISO(time.iso).setZone(timezone);
  const start = DateTime.fromISO(reference.iso).setZone(timezone);
  const days = Math.round(
    value.startOf('day').diff(start.startOf('day'), 'days').days,
  );

  return `${value.toFormat('HH:mm')}${days ? ` (${days > 0 ? '+' : ''}${days}d)` : ''}${offset ? ` UTC${value.toFormat('ZZ')}` : ''}`;
}

export function header(
  meta: Pick<Journey, 'effectiveDeparture' | 'timezone' | 'serviceDate'>,
  terminal: Terminal,
) {
  const start = DateTime.fromISO(meta.effectiveDeparture.iso)
    .setZone(meta.timezone)
    .setLocale('en');

  return terminal.line(
    `${start.toFormat('ccc d LLL yyyy')} · ${meta.timezone} · Scheduled${start.toISODate() !== meta.serviceDate ? ` · Service date ${date(meta.serviceDate)}` : ''}`,
    'muted',
  );
}

export function notes(
  value: { warnings: string[]; limitations?: string[] },
  terminal: Terminal,
) {
  const concise: Record<string, string> = {
    'Only the selected service-day timetable is included; adjacent timetables are not combined.':
      "Only the selected service day's timetable is included.",
    'Intermediate stop sequences and original GTFS trip/route IDs are not exposed by Minotor journey legs.':
      'Journey details show boarding and alighting stops only.',
    'Window routing evaluates Minotor boarding departure slots; with no slots the result is empty, including access-only stops.':
      'Window results require a scheduled boarding departure.',
  };

  return [...new Set([...value.warnings, ...(value.limitations ?? [])])]
    .map((note) => terminal.line(`Note: ${concise[note] ?? note}`, 'muted'))
    .join('\n');
}

export function stopName(stop: Stop) {
  return `${stop.name}${stop.platform ? ` · Pl. ${stop.platform}` : ''}`;
}

export function dateList(dates: string[]) {
  const sorted = [...new Set(dates)].sort();
  const last = sorted.at(-1);

  if (sorted.length <= 5 || last === undefined) {
    return sorted.map(date).join(', ');
  }

  return `${sorted.slice(0, 3).map(date).join(', ')} and ${sorted.length - 3} more (through ${date(last)})`;
}
