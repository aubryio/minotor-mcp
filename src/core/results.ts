import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { z as zod } from 'zod';

import { Datasets } from './datasets.js';
import {
  type QueryReachabilityOutput,
  type ReachabilityPage,
  type ReachabilityResult,
  reachabilityResultSchema,
  type ReachabilitySummary,
} from './outputs.js';
import {
  analysisRows,
  compareValues,
  filterRows,
  projectRow,
  resultBasis,
  sortRows,
  summarizeRows,
} from './reachability-analysis.js';
import {
  type QueryReachabilityInput,
  queryReachabilitySchema,
  TransitError,
} from './schemas.js';
import { atomic } from './storage.js';

const snapshotSchema = zod.object({
  resultId: zod.uuid(),
  expiresAt: zod.iso.datetime(),
  result: reachabilityResultSchema,
});

/** Store expiring reachability snapshots and expose bounded views of their data. */
export class Results {
  constructor(private datasets = new Datasets()) {}

  private directory() {
    return join(this.datasets.cache, 'results');
  }

  /** Save the complete result for 24 hours and remove expired snapshots. */
  async save(result: ReachabilityResult) {
    await mkdir(this.directory(), { recursive: true });

    await this.removeExpiredSnapshots();

    const resultId = randomUUID();
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    await atomic(
      join(this.directory(), resultId + '.json'),
      JSON.stringify({ resultId, expiresAt, result }),
    );

    return resultId;
  }

  private async removeExpiredSnapshots() {
    for (const file of await readdir(this.directory())) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const old = JSON.parse(
          await readFile(join(this.directory(), file), 'utf8'),
        ) as {
          expiresAt: string;
        };

        if (Date.parse(old.expiresAt) < Date.now()) {
          await unlink(join(this.directory(), file));
        }
      } catch {
        /* Another process may have removed it. */
      }
    }
  }

  private async load(resultId: string) {
    if (!zod.uuid().safeParse(resultId).success) {
      throw new TransitError('INVALID_PAGE', 'Invalid result ID');
    }

    const file = join(this.directory(), resultId + '.json');
    let saved: zod.infer<typeof snapshotSchema>;

    try {
      saved = snapshotSchema.parse(JSON.parse(await readFile(file, 'utf8')));

      if (saved.resultId !== resultId) {
        throw new Error('Result ID mismatch');
      }
    } catch {
      throw new TransitError(
        'RESULT_NOT_FOUND',
        'Result unavailable; repeat the query',
      );
    }

    if (Date.parse(saved.expiresAt) < Date.now()) {
      throw new TransitError(
        'RESULT_EXPIRED',
        'Result expired; repeat the query',
      );
    }

    return { ...saved, file };
  }

  /** Return a bounded slice with the original full-detail stop records. */
  async page(
    resultId: string,
    offset = 0,
    limit = 100,
  ): Promise<ReachabilityPage> {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new TransitError(
        'INVALID_PAGE',
        'Invalid result ID, offset, or limit',
      );
    }

    const saved = await this.load(resultId);
    const { stops, ...meta } = saved.result;

    return {
      ...meta,
      resultId,
      expiresAt: saved.expiresAt,
      file: saved.file,
      total: stops.length,
      offset,
      nextOffset: offset + limit < stops.length ? offset + limit : null,
      stops: stops.slice(offset, offset + limit),
    };
  }

  /** Summarize all stops and include at most five compact preview rows. */
  async summary(resultId: string): Promise<ReachabilitySummary> {
    const saved = await this.load(resultId);
    const { stops, ...meta } = saved.result;
    const compact = analysisRows(saved.result);
    const preview = [...compact]
      .sort(
        (leftRow, rightRow) =>
          leftRow.durationMinutes - rightRow.durationMinutes ||
          compareValues(leftRow.id, rightRow.id),
      )
      .slice(0, 5)
      .map(({ id, name, durationMinutes, transferCount }) => ({
        id,
        name,
        durationMinutes,
        transferCount,
      }));

    return {
      ...meta,
      view: 'summary',
      resultId,
      expiresAt: saved.expiresAt,
      file: saved.file,
      total: stops.length,
      basis: resultBasis(saved.result),
      statistics: summarizeRows(compact),
      preview,
    };
  }

  /** Filter and summarize a saved result without running the router again. */
  async query(input: QueryReachabilityInput): Promise<QueryReachabilityOutput> {
    const query = queryReachabilitySchema.parse(input);
    query.fields = [...new Set(['id' as const, ...query.fields])];
    const saved = await this.load(query.resultId);
    const result = saved.result;
    const matches = filterRows(analysisRows(result), query.filters);
    const stats = summarizeRows(matches);

    if (query.limit > 0) {
      sortRows(matches, query);
    }

    const page = matches
      .slice(query.offset, query.offset + query.limit)
      .map((row) => {
        return projectRow(row, query.fields);
      });

    return {
      resultId: query.resultId,
      expiresAt: saved.expiresAt,
      datasetId: result.datasetId,
      serviceDate: result.serviceDate,
      timezone: result.timezone,
      mode: result.mode,
      realtime: result.realtime,
      precision: result.precision,
      basis: resultBasis(result),
      total: result.stops.length,
      matched: matches.length,
      statistics: stats,
      query,
      offset: query.offset,
      nextOffset:
        query.limit > 0 && query.offset + query.limit < matches.length
          ? query.offset + query.limit
          : null,
      rows: page,
    };
  }
}
