import type { Dataset } from '../../core/datasets.js';
import type { Terminal } from '../terminal.js';
import { date, dateList, notes } from './format.js';

export function renderDatasets(
  value: { active?: string; datasets: Dataset[] },
  terminal: Terminal,
) {
  if (!value.datasets.length) {
    return (
      terminal.line('No datasets imported.') +
      '\n' +
      terminal.line(
        'Run: mn data import <feed.zip> --service-date YYYY-MM-DD',
        'muted',
      )
    );
  }

  return value.datasets
    .map((dataset) => {
      const coverage = dataset.serviceDateRanges
        .slice(0, 3)
        .map((range) =>
          range.start === range.end
            ? date(range.start)
            : `${date(range.start)}–${date(range.end)}`,
        )
        .join(', ');
      const lines = [
        terminal.line(
          `${dataset.id === value.active ? 'Active · ' : ''}${dataset.name}`,
          'heading',
        ),
        terminal.line(`ID: ${dataset.id}`, 'muted'),
        terminal.line(
          `Coverage: ${coverage}${dataset.serviceDateRanges.length > 3 ? ` · ${dataset.serviceDateRanges.length - 3} more ranges (--json for all)` : ''}`,
          'muted',
        ),
      ];

      if (!dataset.preparedDays.length) {
        lines.push(terminal.line('No prepared dates'));
      }

      for (const status of [
        'ready',
        'missing',
        'incompatible',
        'unavailable',
      ] as const) {
        const days = dataset.preparedDays
          .filter((day) => day.status === status)
          .map((day) => day.serviceDate);

        if (days.length) {
          lines.push(
            terminal.line(
              `${status[0].toUpperCase() + status.slice(1)}: ${dateList(days)}`,
              status === 'ready' ? 'success' : 'error',
            ),
          );
        }
      }

      const footer = notes(dataset, terminal);

      if (footer) {
        lines.push(footer);
      }

      return lines.join('\n');
    })
    .join('\n\n');
}

export function renderPrepared(
  dataset: Dataset,
  requested: string[],
  reused: Set<string>,
  terminal: Terminal,
) {
  const lines = [terminal.line(`Ready: ${dataset.name}`, 'success')];

  for (const day of [...new Set(requested)]) {
    lines.push(
      terminal.line(
        `${date(day)} · ${reused.has(day) ? 'already prepared' : 'ready'}`,
      ),
    );
  }

  const footer = notes(dataset, terminal);

  if (footer) {
    lines.push('', footer);
  }

  return lines.join('\n');
}
