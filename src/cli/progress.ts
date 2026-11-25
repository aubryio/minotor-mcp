import { safe, type Stream, type Terminal, wrap } from './terminal.js';

/** Keep transient parsing status separate from the final command summary. */
export class Progress {
  private visible = false;

  readonly reused = new Set<string>();

  constructor(
    private stream: Stream,
    private terminal: Terminal,
    private json = false,
  ) {}

  update(message: string) {
    const reused = /^Reused prepared service date (\d{4}-\d{2}-\d{2})$/.exec(
      message,
    );

    if (reused) {
      this.reused.add(reused[1]);
    }

    // Completion belongs to the final command summary, not a second progress log.
    if (/^(Prepared|Reused prepared|Preparing) service date /.test(message)) {
      return;
    }

    if (this.terminal.rich && !this.json) {
      this.clear();
      const parsing = /^Parsing timetable for (\d{4}-\d{2}-\d{2})/.exec(
        message,
      );
      const status = parsing
        ? this.terminal.width < 60
          ? 'May take minutes...'
          : `Timetable ${parsing[1]} · may take a few minutes...`
        : message;
      const first = wrap(safe(status), this.terminal.width - 1)[0];
      this.stream.write(this.terminal.paint(first, 'accent'));
      this.visible = true;
    } else {
      this.stream.write(this.terminal.line(message) + '\n');
    }
  }

  clear() {
    if (this.visible) {
      this.stream.write('\r\u001b[2K');
      this.visible = false;
    }
  }
}
