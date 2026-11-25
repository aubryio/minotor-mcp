import { z as zod } from 'zod';

import { TransitError } from '../../core/schemas.js';
import type { Terminal } from '../terminal.js';
import { date, dateList } from './format.js';

const STOP_SUGGESTION_LIMIT = 10;

export function errorData(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return {
    code: error instanceof TransitError ? error.code : 'ERROR',
    message,
    details: error instanceof TransitError ? error.details : undefined,
  };
}

export function renderError(error: unknown, terminal: Terminal) {
  const data = errorData(error);
  const details = data.details as
    | {
        command?: string;
        availableDates?: string[];
        completedDates?: string[];
        failedDate?: string;
      }
    | undefined;
  let message = data.message.replace(/^error: /, '');

  if (data.code === 'DAY_NOT_PREPARED') {
    message = `No timetable prepared for ${(data.details as { serviceDate: string }).serviceDate}.`;
  }

  if (data.code === 'TIMETABLE_UNAVAILABLE') {
    message = 'The prepared timetable is missing, corrupt, or incompatible.';
  }

  if (data.code === 'NO_DATASET') {
    message = 'No dataset is configured.';
  }

  if (error instanceof zod.ZodError) {
    message = error.issues
      .map((issue) => `${issue.path.join('.') || 'Input'}: ${issue.message}`)
      .join('; ');
  }

  const lines = [terminal.line(message, 'error')];

  if (data.code === 'AMBIGUOUS_STOP' && Array.isArray(data.details)) {
    lines.push(
      '',
      terminal.table(
        ['Name', 'GTFS ID'],
        data.details
          .slice(0, STOP_SUGGESTION_LIMIT)
          .map((stop: { name: string; id: string }) => [stop.name, stop.id]),
      ),
      '',
      terminal.line('Retry using one of these exact GTFS IDs.', 'muted'),
    );

    if (data.details.length > STOP_SUGGESTION_LIMIT) {
      lines.push(
        terminal.line(
          `Showing the first ${STOP_SUGGESTION_LIMIT} suggestions. Use mn stops search <name> --limit 100 for more.`,
          'muted',
        ),
      );
    }
  }

  if (details?.availableDates?.length) {
    lines.push(
      terminal.line(
        `Prepared dates: ${dateList(details.availableDates)}`,
        'muted',
      ),
    );
  }

  if (details?.completedDates?.length) {
    lines.push(
      terminal.line(
        `Already prepared: ${dateList(details.completedDates)}`,
        'success',
      ),
    );
  }

  if (details?.failedDate) {
    lines.push(terminal.line(`Failed date: ${date(details.failedDate)}`));
  }

  if (details?.command) {
    lines.push('', terminal.literal(`Run: ${details.command}`, 'accent'));
  }

  if (data.code === 'UNKNOWN_DATASET') {
    lines.push('', terminal.line('Run: mn data list', 'accent'));
  }

  if (data.code === 'NO_DATASET') {
    lines.push(
      '',
      terminal.line(
        'Run: mn data import <feed.zip> --service-date YYYY-MM-DD',
        'accent',
      ),
    );
  }

  if (data.code === 'UNKNOWN_STOP') {
    lines.push('', terminal.line('Run: mn stops search <name>', 'accent'));
  }

  return lines.join('\n');
}
