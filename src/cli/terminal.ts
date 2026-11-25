import { styleText } from 'node:util';

import stringWidth from 'string-width';

export type Tone =
  'heading' | 'accent' | 'muted' | 'subtle' | 'success' | 'error';

const styles = {
  heading: 'bold',
  accent: 'cyan',
  muted: 'dim',
  subtle: 'gray',
  success: 'green',
  error: 'red',
} as const;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Escape control characters so feed names and errors cannot control the terminal. */
export function safe(value: string): string {
  // eslint-disable-next-line no-control-regex -- Intentionally neutralize terminal control characters.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
    character === '\n'
      ? '\\n'
      : character === '\r'
        ? '\\r'
        : character === '\t'
          ? '\\t'
          : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Wrap by display width without splitting Unicode grapheme clusters. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  let spaces = '';

  for (const word of text.match(/ +|[^ ]+/g) ?? []) {
    if (/^ +$/.test(word)) {
      spaces = word;
      continue;
    }

    if (line && stringWidth(line + spaces + word) > width) {
      lines.push(line);
      line = '';
    }

    if (line) {
      line += spaces;
    }

    spaces = '';

    for (const { segment } of graphemes.segment(word)) {
      if (line && stringWidth(line + segment) > width) {
        lines.push(line);
        line = '';
      }

      line += segment;
    }
  }

  if (line || !lines.length) {
    lines.push(line);
  }

  return lines;
}

export type Stream = NodeJS.WritableStream & {
  isTTY?: boolean;
  columns?: number;
};

export function terminalFor(stream: Stream, color = true, env = process.env) {
  const rich = Boolean(
    stream.isTTY &&
    color &&
    env.NO_COLOR === undefined &&
    env.NODE_DISABLE_COLORS !== '1' &&
    env.TERM !== 'dumb',
  );

  return new Terminal(stream.columns || 80, rich);
}

/** Render safe, width-aware text for plain or styled terminals. */
export class Terminal {
  readonly width: number;

  constructor(
    width = 80,
    readonly rich = false,
  ) {
    this.width = Math.max(20, width);
  }

  get arrow() {
    return this.rich ? '→' : '->';
  }

  paint(text: string, tone?: Tone) {
    return this.rich && tone
      ? styleText(styles[tone], text, { validateStream: false })
      : text;
  }

  /** Preserve copyable commands by leaving soft wrapping to the terminal. */
  literal(text: string, tone?: Tone) {
    return this.paint(safe(text), tone);
  }

  line(text: string, tone?: Tone, indent = '') {
    return wrap(safe(text), Math.max(8, this.width - stringWidth(indent)))
      .map((line) => indent + this.paint(line, tone))
      .join('\n');
  }

  /** Use aligned columns when they fit, or labeled rows on narrow terminals. */
  table(
    headers: string[],
    rows: string[][],
    notes: (string | undefined)[] = [],
  ): string {
    const cleanRows = rows.map((row) => row.map(safe));
    const widths = headers.map((header, columnIndex) =>
      Math.max(
        stringWidth(header),
        ...cleanRows.map((row) => stringWidth(row[columnIndex] ?? '')),
      ),
    );
    const space =
      this.width -
      widths.slice(1).reduce((total, columnWidth) => total + columnWidth, 0) -
      (headers.length - 1) * 2;

    if (this.width < 80 || space < 16) {
      return this.renderStackedTable(headers, cleanRows, notes);
    }

    widths[0] = Math.min(widths[0], space);

    return [
      this.renderTableRow(headers, widths, true),
      ...cleanRows.map(
        (row, rowIndex) =>
          this.renderTableRow(row, widths) +
          (notes[rowIndex]
            ? '\n' + this.line(notes[rowIndex], 'muted', '  ')
            : ''),
      ),
    ].join('\n');
  }

  private renderStackedTable(
    headers: string[],
    rows: string[][],
    notes: (string | undefined)[],
  ) {
    return rows
      .map(
        (row, index) =>
          row
            .map((cell, columnIndex) =>
              wrap(`${headers[columnIndex]}: ${cell}`, this.width)
                .map((line) =>
                  this.paint(
                    line,
                    columnIndex === 0
                      ? 'heading'
                      : columnIndex === headers.length - 1
                        ? 'muted'
                        : undefined,
                  ),
                )
                .join('\n'),
            )
            .join('\n') +
          (notes[index] ? '\n' + this.line(notes[index], 'muted', '  ') : ''),
      )
      .join('\n\n');
  }

  private renderTableRow(cells: string[], widths: number[], header = false) {
    const wrapped = cells.map((cell, columnIndex) =>
      wrap(cell, widths[columnIndex]),
    );

    return Array.from(
      { length: Math.max(...wrapped.map((cell) => cell.length)) },
      (unused, line) =>
        wrapped
          .map((cell, columnIndex) => {
            const text = cell[line] ?? '';
            const padded =
              columnIndex < widths.length - 1
                ? text + ' '.repeat(widths[columnIndex] - stringWidth(text))
                : text;

            return this.paint(
              padded,
              header
                ? 'muted'
                : columnIndex === 0
                  ? 'heading'
                  : columnIndex === widths.length - 1
                    ? 'muted'
                    : undefined,
            );
          })
          .join('  ')
          .trimEnd(),
    ).join('\n');
  }
}

export { Progress } from './progress.js';
