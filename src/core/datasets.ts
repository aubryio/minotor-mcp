import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import envPaths from 'env-paths';
import { StopsIndex, Timetable } from 'minotor';
import { GtfsParser, setParserLogLevel } from 'minotor/parser';
import StreamZip from 'node-stream-zip';

import { inspectFeed, profile } from './gtfs-feed.js';
import { TransitError } from './schemas.js';
import { ServiceCoverage, validateServiceDates } from './service-calendar.js';
import { atomic } from './storage.js';

// Preserve the existing public exports while keeping their implementations focused.
export { profile } from './gtfs-feed.js';
export { atomic } from './storage.js';

const ENGINE_VERSION = '13.0.1';

const FORMAT_VERSION = 1;

const TIMETABLE_VERSION = `${ENGINE_VERSION}-v${FORMAT_VERSION}`;

export interface PreparedDay {
  serviceDate: string;
  preparedAt: string;
  engineVersion: string;
  formatVersion: number;
  status: 'ready' | 'missing' | 'incompatible' | 'unavailable';
}

export interface ImportOptions {
  name?: string;
  serviceDates: string[];
  progress?: (message: string) => void;
}

export interface Dataset {
  id: string;
  name: string;
  timezone: string;
  importedAt: string;
  serviceDateRanges: ServiceDateRange[];
  warnings: string[];
  preparedDays: PreparedDay[];
}

export interface ServiceDateRange {
  start: string;
  end: string;
}

/** Manage retained feeds, active dataset selection, and prepared service days. */
export class Datasets {
  readonly data: string;

  readonly cache: string;

  constructor(root = process.env.MINOTOR_MCP_HOME) {
    const paths = envPaths('minotor-mcp', { suffix: '' });
    this.data = root ? join(root, 'data') : paths.data;
    this.cache = root ? join(root, 'cache') : paths.cache;
  }

  async init() {
    await Promise.all([
      mkdir(this.data, { recursive: true }),
      mkdir(this.cache, { recursive: true }),
    ]);
  }

  private async configuration(): Promise<{
    active?: string;
    datasets: Dataset[];
  }> {
    try {
      type StoredDataset = Omit<
        Dataset,
        'serviceDateRanges' | 'preparedDays'
      > & {
        serviceDateRanges?: ServiceDateRange[];
        preparedDays?: PreparedDay[];
        calendar?: Record<string, string>[];
        exceptions?: Record<string, string>[];
      };
      const config = JSON.parse(
        await readFile(join(this.data, 'config.json'), 'utf8'),
      ) as { active?: string; datasets: StoredDataset[] };
      const datasets = config.datasets.map((dataset): Dataset => {
        const { calendar, exceptions, ...metadata } = dataset;

        if (!metadata.serviceDateRanges) {
          const coverage = new ServiceCoverage();

          for (const row of calendar ?? []) {
            coverage.add(row.start_date, row.end_date);
          }

          for (const row of exceptions ?? []) {
            coverage.add(row.date);
          }

          metadata.serviceDateRanges = coverage.finish();
        }

        return {
          ...metadata,
          serviceDateRanges: metadata.serviceDateRanges,
          preparedDays: metadata.preparedDays ?? [],
        };
      });

      return { ...config, datasets };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { datasets: [] };
      }

      throw error;
    }
  }

  /** Reconcile recorded preparation status with files currently on disk. */
  async list() {
    const config = await this.configuration();

    for (const dataset of config.datasets) {
      for (const day of dataset.preparedDays) {
        day.status = await this.preparedDayStatus(dataset.id, day);
      }

      dataset.preparedDays.sort((left, right) =>
        left.serviceDate.localeCompare(right.serviceDate),
      );
    }

    return config;
  }

  private async preparedDayStatus(
    id: string,
    day: PreparedDay,
  ): Promise<PreparedDay['status']> {
    if (!this.compatible(day)) {
      return 'incompatible';
    }

    try {
      const info = await stat(this.dayFile(id, day.serviceDate));

      return info.isFile() && info.size > 0 ? 'ready' : 'unavailable';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'missing'
        : 'unavailable';
    }
  }

  private compatible(day: PreparedDay) {
    return (
      day.engineVersion === ENGINE_VERSION &&
      day.formatVersion === FORMAT_VERSION
    );
  }

  private dayFile(id: string, date: string) {
    return join(this.data, id, 'timetables', TIMETABLE_VERSION, `${date}.bin`);
  }

  async use(id: string) {
    const config = await this.configuration();

    if (!config.datasets.some((candidate) => candidate.id === id)) {
      throw new TransitError('UNKNOWN_DATASET', 'Unknown dataset ID');
    }

    config.active = id;
    await atomic(join(this.data, 'config.json'), JSON.stringify(config));
  }

  async active() {
    const config = await this.list();
    const dataset = config.datasets.find(
      (candidate) => candidate.id === config.active,
    );

    if (!dataset) {
      throw new TransitError(
        'NO_DATASET',
        'Import a GTFS ZIP with mn data import <file> --service-date YYYY-MM-DD',
      );
    }

    return dataset;
  }

  /** Register a feed by content hash, then prepare the requested service dates. */
  async import(path: string, options: ImportOptions) {
    const serviceDates = validateServiceDates(options.serviceDates);
    await this.init();
    options.progress?.('Reading feed and preparing stop metadata');
    const hash = createHash('sha256');

    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      hash.update(chunk);
    }

    const id = hash.digest('hex');
    const config = await this.configuration();
    const existing = config.datasets.find((candidate) => candidate.id === id);

    if (existing) {
      if (options.name !== undefined) {
        existing.name = options.name;
        await atomic(join(this.data, 'config.json'), JSON.stringify(config));
      }

      return this.prepareDays(id, serviceDates, options.progress);
    }

    const zip = new StreamZip.async({ file: path });

    try {
      const { timezone, serviceDateRanges, warnings } = await inspectFeed(zip);
      const dataset: Dataset = {
        id,
        name: options.name ?? path.split(/[\\/]/).pop() ?? path,
        timezone,
        serviceDateRanges,
        warnings,
        preparedDays: [],
        importedAt: new Date().toISOString(),
      };
      const dir = join(this.data, id);
      await mkdir(dir, { recursive: true });
      const temp = join(dir, randomUUID() + '.zip');
      await copyFile(path, temp);
      await rename(temp, join(dir, 'feed.zip'));
      setParserLogLevel('error');
      const stops = await new GtfsParser(
        join(dir, 'feed.zip'),
        profile,
      ).parseStops();
      await atomic(join(dir, 'stops.bin'), stops.serialize());
      // Preserve original coordinate precision independently of protobuf float serialization.
      await atomic(join(dir, 'stops.json'), JSON.stringify([...stops]));
      const updatedConfig = await this.configuration();
      updatedConfig.datasets = updatedConfig.datasets.filter(
        (candidate) => candidate.id !== id,
      );
      updatedConfig.datasets.push(dataset);
      await atomic(
        join(this.data, 'config.json'),
        JSON.stringify(updatedConfig),
      );

      return await this.prepareDays(id, serviceDates, options.progress);
    } finally {
      await zip.close();
    }
  }

  async stops(dataset: Dataset) {
    return StopsIndex.fromData(
      await readFile(join(this.data, dataset.id, 'stops.bin')),
    );
  }

  async stopMetadata(dataset: Dataset) {
    return JSON.parse(
      await readFile(join(this.data, dataset.id, 'stops.json'), 'utf8'),
    ) as import('minotor').Stop[];
  }

  private checkCoverage(dataset: Dataset, date: string) {
    validateServiceDates([date]);

    if (
      !dataset.serviceDateRanges.some(
        (range) => range.start <= date && date <= range.end,
      )
    ) {
      throw new TransitError(
        'DATE_OUTSIDE_COVERAGE',
        `Dataset does not cover service date ${date}`,
      );
    }
  }

  private async readTimetable(file: string) {
    const table = Timetable.fromData(await readFile(file));

    if (!table.getRoute(0)) {
      throw new Error('Timetable contains no supported trips');
    }

    return table;
  }

  /** Missing or corrupt files can be rebuilt only during explicit preparation. */
  private async tryReadTimetable(file: string): Promise<Timetable | undefined> {
    try {
      return await this.readTimetable(file);
    } catch {
      return undefined;
    }
  }

  private async parseTimetable(
    id: string,
    date: string,
    progress?: (message: string) => void,
  ) {
    setParserLogLevel('error');
    const [year, month, day] = date.split('-').map(Number);
    progress?.(
      `Parsing timetable for ${date} with Minotor. This may take a few minutes.`,
    );
    const timetable = await new GtfsParser(
      join(this.data, id, 'feed.zip'),
      profile,
    ).parseTimetable(new Date(year, month - 1, day, 12));

    if (!timetable.getRoute(0)) {
      throw new TransitError(
        'NO_SERVICE',
        `No supported trips on service date ${date}`,
      );
    }

    return timetable;
  }

  /** Adopt a compatible legacy cache before rebuilding from the retained feed. */
  private async prepareTimetable(
    id: string,
    date: string,
    progress?: (message: string) => void,
  ) {
    const cached = await this.tryReadTimetable(
      join(this.cache, `${id}-${TIMETABLE_VERSION}-${date}.bin`),
    );
    const timetable = cached ?? (await this.parseTimetable(id, date, progress));
    await mkdir(join(this.data, id, 'timetables', TIMETABLE_VERSION), {
      recursive: true,
    });
    await atomic(this.dayFile(id, date), timetable.serialize());
  }

  private recordPreparedDay(dataset: Dataset, date: string) {
    dataset.preparedDays = dataset.preparedDays.filter(
      (day) => day.serviceDate !== date,
    );
    dataset.preparedDays.push({
      serviceDate: date,
      preparedAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION,
      formatVersion: FORMAT_VERSION,
      status: 'ready',
    });
  }

  /** Prepare dates in order, retaining successful days if a later date fails. */
  async prepareDays(
    id: string,
    serviceDates: string[],
    progress?: (message: string) => void,
  ) {
    const requested = validateServiceDates(serviceDates);
    let config = await this.configuration();
    let dataset = config.datasets.find((candidate) => candidate.id === id);

    if (!dataset) {
      throw new TransitError('UNKNOWN_DATASET', 'Unknown dataset ID');
    }

    const completedDates: string[] = [];

    for (const date of requested) {
      try {
        this.checkCoverage(dataset, date);
        progress?.(`Preparing service date ${date}`);
        const existing = dataset.preparedDays.find(
          (day) => day.serviceDate === date,
        );
        const table =
          existing && this.compatible(existing)
            ? await this.tryReadTimetable(this.dayFile(id, date))
            : undefined;

        if (table) {
          if (!config.active) {
            config.active = id;
            await atomic(
              join(this.data, 'config.json'),
              JSON.stringify(config),
            );
          }

          progress?.(`Reused prepared service date ${date}`);
        } else {
          await this.prepareTimetable(id, date, progress);
          config = await this.configuration();
          dataset = config.datasets.find((candidate) => candidate.id === id);

          if (!dataset) {
            throw new TransitError('UNKNOWN_DATASET', 'Unknown dataset ID');
          }

          this.recordPreparedDay(dataset, date);
          config.active ??= id;
          await atomic(join(this.data, 'config.json'), JSON.stringify(config));
          progress?.(`Prepared service date ${date}`);
        }

        completedDates.push(date);
      } catch (error) {
        throw new TransitError(
          error instanceof TransitError ? error.code : 'PREPARATION_FAILED',
          error instanceof Error ? error.message : String(error),
          { datasetId: id, failedDate: date, completedDates },
        );
      }
    }

    const prepared = (await this.list()).datasets.find(
      (candidate) => candidate.id === id,
    );

    if (!prepared) {
      throw new TransitError('UNKNOWN_DATASET', 'Unknown dataset ID');
    }

    return prepared;
  }

  /** Load an already prepared day without starting GTFS preprocessing. */
  async timetable(dataset: Dataset, date: string) {
    this.checkCoverage(dataset, date);
    // Reload availability so callers holding a Dataset from before preparation
    // can use newly prepared days without silently initiating preprocessing.
    const current = (await this.list()).datasets.find(
      (candidate) => candidate.id === dataset.id,
    );
    const day = current?.preparedDays.find(
      (entry) => entry.serviceDate === date,
    );
    const command = `mn data prepare --dataset ${dataset.id} --service-date ${date}`;
    const details = {
      datasetId: dataset.id,
      serviceDate: date,
      availableDates:
        current?.preparedDays
          .filter((entry) => entry.status === 'ready')
          .map((entry) => entry.serviceDate) ?? [],
      command,
    };

    if (!day) {
      throw new TransitError(
        'DAY_NOT_PREPARED',
        `Service date ${date} is not prepared. Run: ${command}`,
        details,
      );
    }

    try {
      if (day.status !== 'ready') {
        throw new Error(day.status);
      }

      return await this.readTimetable(this.dayFile(dataset.id, date));
    } catch {
      throw new TransitError(
        'TIMETABLE_UNAVAILABLE',
        `Prepared timetable is missing, corrupt, or incompatible. Run: ${command}`,
        details,
      );
    }
  }
}
