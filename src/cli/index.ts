#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

import { Command, CommanderError, Option } from 'commander';

import { RoutingService } from '../core/router.js';
import {
  type ReachabilityInput,
  type RoutingInput,
  routingSchema,
} from '../core/schemas.js';
import { version } from '../metadata.js';
import {
  errorData,
  renderDatasets,
  renderError,
  renderJourney,
  renderPrepared,
  renderReachability,
  renderStops,
} from './render.js';
import { Progress, terminalFor } from './terminal.js';

const app = new Command()
  .name('mn')
  .version(version)
  .description('Local GTFS routing and reachability')
  .option('--json', 'Print structured JSON')
  .option('--no-color', 'Use plain text without color or cursor updates')
  .exitOverride()
  .configureOutput({
    outputError: () => {}, // Errors are rendered by the catch handler below.
    writeErr: (text) => {
      if (!jsonMode()) {
        process.stderr.write(text);
      }
    },
  });

const service = new RoutingService();

let mcpMode = false;

let progress: Progress | undefined;

const args = process.argv.slice(2);

const optionArgs = args.slice(
  0,
  args.indexOf('--') < 0 ? args.length : args.indexOf('--'),
);

const jsonMode = () =>
  Boolean(app.opts().json || optionArgs.includes('--json'));

const terminal = () =>
  terminalFor(process.stdout, app.opts().color !== false && !jsonMode());

function stopProgress() {
  progress?.clear();
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', terminated);
}

function interrupted() {
  stopProgress();
  process.exit(130);
}

function terminated() {
  stopProgress();
  process.exit(143);
}

function startProgress() {
  progress = new Progress(
    process.stderr,
    terminalFor(process.stderr, app.opts().color !== false && !jsonMode()),
    jsonMode(),
  );
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', terminated);

  return progress;
}

async function show(
  value: unknown,
  human: () => string,
  options: { output?: string } = {},
) {
  stopProgress();

  if (options.output) {
    await writeFile(options.output, JSON.stringify(value, null, 2) + '\n');
    console.log(
      jsonMode()
        ? JSON.stringify({ file: options.output })
        : terminal().line(`Saved ${options.output}`, 'success'),
    );
  } else {
    console.log(jsonMode() ? JSON.stringify(value, null, 2) : human());
  }
}

function collectDates(date: string, previous: string[]) {
  return [...previous, date];
}

type ImportOptions = { name?: string; serviceDate: string[] };

type PrepareOptions = { dataset?: string; serviceDate: string[] };

type RoutingOptions = {
  depart: string;
  serviceDate?: string;
  maxDuration?: string;
  maxTransfers?: string;
  minTransferTime?: string;
  transportModes?: string;
  output?: string;
};

type WindowRoutingOptions = RoutingOptions & {
  mode: ReachabilityInput['mode'];
  latestDeparture?: string;
};

const data = app.command('data').description('Manage local datasets');

data
  .command('import <zip>')
  .option('--name <name>')
  .requiredOption(
    '--service-date <date>',
    'Service date to prepare; repeat for multiple days',
    collectDates,
    [],
  )
  .action(async (zip: string, options: ImportOptions) => {
    const status = startProgress();
    const dataset = await service.datasets.import(zip, {
      name: options.name,
      serviceDates: options.serviceDate,
      progress: (message) => {
        status.update(message);
      },
    });
    await show(dataset, () =>
      renderPrepared(dataset, options.serviceDate, status.reused, terminal()),
    );
  });

data
  .command('prepare')
  .description('Prepare service days from a retained feed')
  .option('--dataset <id>', 'Dataset ID; defaults to the active dataset')
  .requiredOption(
    '--service-date <date>',
    'Service date to prepare; repeat for multiple days',
    collectDates,
    [],
  )
  .action(async (options: PrepareOptions) => {
    const status = startProgress();
    const id = options.dataset ?? (await service.datasets.active()).id;
    const dataset = await service.datasets.prepareDays(
      id,
      options.serviceDate,
      (message) => {
        status.update(message);
      },
    );
    await show(dataset, () =>
      renderPrepared(dataset, options.serviceDate, status.reused, terminal()),
    );
  });

data.command('list').action(async () => {
  const listing = await service.datasets.list();
  await show(listing, () => renderDatasets(listing, terminal()));
});

data.command('use <id>').action(async (id: string) => {
  await service.datasets.use(id);
  const name = jsonMode() ? '' : (await service.datasets.active()).name;
  await show({ active: id }, () =>
    terminal().line(`Active dataset: ${name}`, 'success'),
  );
});

app
  .command('stops')
  .command('search <query>')
  .option('--limit <number>', 'Maximum matches', '10')
  .action(async (query: string, options: { limit: string }) => {
    const limit = Number(options.limit);
    const result = await service.searchStops({ query, limit });
    await show(result, () =>
      renderStops(result.stops, query, limit, terminal()),
    );
  });

function addRoutingOptions(command: Command) {
  return command
    .requiredOption('--depart <timestamp>', 'Departure timestamp with offset')
    .option('--service-date <date>')
    .option('--max-duration <minutes>')
    .option('--max-transfers <count>')
    .option('--min-transfer-time <minutes>')
    .option('--transport-modes <modes>', 'Comma-separated modes, e.g. RAIL,BUS')
    .option('--output <file>', 'Write full JSON');
}

/** Validate CLI constraints and resolve the origin name to an exact GTFS ID. */
async function routingInput(
  origin: string,
  options: RoutingOptions,
): Promise<RoutingInput> {
  const query = routingSchema.parse({
    origin,
    departure: options.depart,
    serviceDate: options.serviceDate,
    maxDuration:
      options.maxDuration === undefined
        ? undefined
        : Number(options.maxDuration),
    maxTransfers:
      options.maxTransfers === undefined
        ? undefined
        : Number(options.maxTransfers),
    minTransferTime:
      options.minTransferTime === undefined
        ? undefined
        : Number(options.minTransferTime),
    transportModes: options.transportModes?.split(','),
  });

  return { ...query, origin: await service.resolve(origin) };
}

function addDepartureWindowOptions(command: Command) {
  return command
    .addOption(
      new Option('--mode <mode>', 'Explicit routing mode (optional)')
        .choices(['single_departure', 'departure_window'])
        .hideHelp(),
    )
    .option(
      '--latest-departure <timestamp>',
      'Search a departure window ending at this timestamp (inclusive)',
    );
}

addDepartureWindowOptions(
  addRoutingOptions(app.command('route <origin> <destination>')),
).action(
  async (
    origin: string,
    destination: string,
    options: WindowRoutingOptions,
  ) => {
    const result = await service.planJourney({
      ...(await routingInput(origin, options)),
      destination: await service.resolve(destination),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.latestDeparture !== undefined
        ? { latestDeparture: options.latestDeparture }
        : {}),
    });
    await show(
      result,
      () => renderJourney(result, origin, destination, terminal()),
      options,
    );
  },
);

addDepartureWindowOptions(
  addRoutingOptions(app.command('reachability <origin>')),
).action(async (origin: string, options: WindowRoutingOptions) => {
  const result = await service.computeReachability({
    ...(await routingInput(origin, options)),
    mode: options.mode,
    latestDeparture: options.latestDeparture,
  });
  await show(
    result,
    () => renderReachability(result, origin, terminal()),
    options,
  );
});

app.command('mcp').action(async () => {
  mcpMode = true;
  const { startServer } = await import('../mcp/server.js');
  startServer();
});

app.parseAsync().catch((error: unknown) => {
  stopProgress();

  if (error instanceof CommanderError && error.exitCode === 0) {
    return;
  }

  if (error instanceof CommanderError && error.code === 'commander.help') {
    if (jsonMode()) {
      console.error(
        JSON.stringify({
          code: 'MISSING_COMMAND',
          message: 'Choose a command; use --help for usage.',
        }),
      );
    }

    process.exitCode = 1;

    return;
  }

  console.error(
    jsonMode() || mcpMode
      ? JSON.stringify(errorData(error))
      : renderError(
          error,
          terminalFor(process.stderr, app.opts().color !== false),
        ),
  );
  process.exitCode = 1;
});
