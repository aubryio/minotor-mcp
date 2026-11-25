import { z as zod } from 'zod';

import { queryReachabilitySchema } from './schemas.js';

export const stopSchema = zod.object({
  id: zod.string(),
  minotorId: zod.number().int(),
  name: zod.string(),
  latitude: zod.number().optional(),
  longitude: zod.number().optional(),
  platform: zod.string().optional(),
  locationType: zod.string(),
  parentId: zod.string().optional(),
  children: zod.array(zod.string()),
});

export type StopOutput = zod.infer<typeof stopSchema>;

const time = zod.object({ serviceMinutes: zod.number(), iso: zod.string() });

const arrival = zod.object({
  arrival: time,
  legNumber: zod.number().int(),
  transferCount: zod.number().int(),
});

const base = zod.object({
  schemaVersion: zod.literal(1),
  datasetId: zod.string(),
  timezone: zod.string(),
  serviceDate: zod.string(),
  realtime: zod.literal(false),
  precision: zod.literal('minute'),
  effectiveDeparture: time,
  query: zod.record(zod.string(), zod.unknown()),
  warnings: zod.array(zod.string()),
  engine: zod.string(),
});

export type RoutingMetadata = zod.infer<typeof base>;

const endpoints = { from: stopSchema, to: stopSchema };

const leg = zod.discriminatedUnion('kind', [
  zod.object({
    ...endpoints,
    kind: zod.literal('vehicle'),
    route: zod.object({ name: zod.string(), type: zod.number() }),
    departure: time,
    arrival: time,
    pickUpType: zod.number(),
    dropOffType: zod.number(),
  }),
  zod.object({
    ...endpoints,
    kind: zod.literal('access'),
    durationMinutes: zod.number(),
  }),
  zod.object({
    ...endpoints,
    kind: zod.literal('transfer'),
    type: zod.number(),
    minTransferTime: zod.number().optional(),
  }),
]);

export type JourneyLeg = zod.infer<typeof leg>;

export const searchOutputSchema = zod.object({
  datasetId: zod.string(),
  stops: zod.array(stopSchema),
});

export type SearchOutput = zod.infer<typeof searchOutputSchema>;

export const journeyOutputSchema = base.extend({
  mode: zod.enum(['single_departure', 'departure_window']).optional(),
  effectiveLatestDeparture: time.optional(),
  itineraries: zod.array(
    arrival.extend({
      departure: time,
      durationMinutes: zod.number(),
      elapsedMinutes: zod.number(),
      legs: zod.array(leg),
    }),
  ),
  limitations: zod.array(zod.string()).optional(),
});

export type JourneyOutput = zod.infer<typeof journeyOutputSchema>;

export const reachabilityOutputSchema = base.extend({
  mode: zod.enum(['single_departure', 'departure_window']),
  effectiveLatestDeparture: time.optional(),
  limitations: zod.array(zod.string()).optional(),
  resultId: zod.string(),
  expiresAt: zod.string(),
  file: zod.string(),
  total: zod.number().int(),
  offset: zod.number().int(),
  nextOffset: zod.number().int().nullable(),
  stops: zod.array(
    zod.object({
      stop: stopSchema,
      earliestArrival: arrival.extend({
        durationMinutes: zod.number().optional(),
      }),
      shortestDuration: arrival
        .extend({ durationMinutes: zod.number(), departure: time })
        .optional(),
    }),
  ),
});

export type ReachabilityPage = zod.infer<typeof reachabilityOutputSchema>;

// The complete routing result and on-disk export remain unchanged.
export const reachabilityResultSchema = reachabilityOutputSchema.omit({
  resultId: true,
  expiresAt: true,
  file: true,
  total: true,
  offset: true,
  nextOffset: true,
});

export type ReachabilityResult = zod.infer<typeof reachabilityResultSchema>;

export const compactReachabilityRowSchema = zod.object({
  id: zod.string(),
  name: zod.string().optional(),
  latitude: zod.number().optional(),
  longitude: zod.number().optional(),
  parentId: zod.string().optional(),
  platform: zod.string().optional(),
  durationMinutes: zod.number().optional(),
  arrival: time.optional(),
  departure: time.optional(),
  transferCount: zod.number().int().optional(),
});

export type CompactReachabilityRow = zod.infer<
  typeof compactReachabilityRowSchema
>;

export const reachabilityStatisticsSchema = zod.object({
  durationMinutes: zod
    .object({ min: zod.number(), max: zod.number(), mean: zod.number() })
    .nullable(),
  withCoordinates: zod.number().int().min(0),
  bounds: zod
    .object({
      west: zod.number(),
      south: zod.number(),
      east: zod.number(),
      north: zod.number(),
    })
    .nullable(),
});

export type ReachabilityStatistics = zod.infer<
  typeof reachabilityStatisticsSchema
>;

const basis = zod.enum(['earliestArrival', 'shortestDuration']);

const resultReference = {
  resultId: zod.string(),
  expiresAt: zod.string(),
  file: zod.string(),
  total: zod.number().int(),
};

export const reachabilitySummaryOutputSchema = reachabilityResultSchema
  .omit({ stops: true })
  .extend({
    ...resultReference,
    view: zod.literal('summary'),
    basis,
    statistics: reachabilityStatisticsSchema,
    preview: zod.array(compactReachabilityRowSchema).max(5),
  });

const reachabilityPageOutputSchema = reachabilityOutputSchema.extend({
  view: zod.literal('page'),
});

// Keep the MCP schema an object at its root for older protocol clients.
export const computeReachabilityOutputSchema = reachabilitySummaryOutputSchema
  .omit({ view: true, basis: true, statistics: true, preview: true })
  .extend({
    view: zod.enum(['summary', 'page']),
    basis: basis.optional(),
    statistics: reachabilityStatisticsSchema.optional(),
    preview: zod.array(compactReachabilityRowSchema).max(5).optional(),
    offset: reachabilityOutputSchema.shape.offset.optional(),
    nextOffset: reachabilityOutputSchema.shape.nextOffset.optional(),
    stops: reachabilityOutputSchema.shape.stops.optional(),
  })
  .superRefine((value, context) => {
    const schema =
      value.view === 'summary'
        ? reachabilitySummaryOutputSchema
        : reachabilityPageOutputSchema;
    const checked = schema.safeParse(value);

    if (!checked.success) {
      for (const issue of checked.error.issues) {
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
      }
    }
  });

export const queryReachabilityOutputSchema = zod.object({
  resultId: zod.string(),
  expiresAt: zod.string(),
  datasetId: zod.string(),
  serviceDate: zod.string(),
  timezone: zod.string(),
  mode: reachabilityResultSchema.shape.mode,
  realtime: zod.literal(false),
  precision: zod.literal('minute'),
  basis,
  total: zod.number().int(),
  matched: zod.number().int(),
  statistics: reachabilityStatisticsSchema,
  query: queryReachabilitySchema,
  offset: zod.number().int(),
  nextOffset: zod.number().int().nullable(),
  rows: zod.array(compactReachabilityRowSchema),
});

export type ReachabilitySummary = zod.infer<
  typeof reachabilitySummaryOutputSchema
>;

export type ComputeReachabilityOutput =
  ReachabilitySummary | zod.infer<typeof reachabilityPageOutputSchema>;

export type QueryReachabilityOutput = zod.infer<
  typeof queryReachabilityOutputSchema
>;

export const datasetsOutputSchema = zod.object({
  active: zod.string().optional(),
  datasets: zod.array(
    zod.object({
      id: zod.string(),
      name: zod.string(),
      timezone: zod.string(),
      importedAt: zod.string(),
      warnings: zod.array(zod.string()),
      serviceDateRanges: zod.array(
        zod.object({ start: zod.iso.date(), end: zod.iso.date() }),
      ),
      preparedDays: zod.array(
        zod.object({
          serviceDate: zod.iso.date(),
          preparedAt: zod.string(),
          engineVersion: zod.string(),
          formatVersion: zod.number().int(),
          status: zod.enum(['ready', 'missing', 'incompatible', 'unavailable']),
        }),
      ),
    }),
  ),
});

export const queryErrorSchema = zod.object({
  code: zod.string(),
  message: zod.string(),
  details: zod.unknown().optional(),
});

function batchOutputSchema<T extends zod.ZodType>(result: T) {
  return zod.object({
    results: zod.array(
      zod.discriminatedUnion('ok', [
        zod.object({ ok: zod.literal(true), result }),
        zod.object({ ok: zod.literal(false), error: queryErrorSchema }),
      ]),
    ),
  });
}

export const searchBatchOutputSchema = batchOutputSchema(searchOutputSchema);
export const journeyBatchOutputSchema = batchOutputSchema(journeyOutputSchema);
export type SearchBatchOutput = zod.infer<typeof searchBatchOutputSchema>;
export type JourneyBatchOutput = zod.infer<typeof journeyBatchOutputSchema>;

function toolOutputSchema<T extends zod.ZodRawShape, B extends zod.ZodRawShape>(
  single: zod.ZodObject<T>,
  batch: zod.ZodObject<B>,
) {
  return single
    .partial()
    .extend(batch.partial().shape)
    .superRefine((value, context) => {
      const result = ('results' in value ? batch : single).safeParse(value);

      if (!result.success) {
        for (const issue of result.error.issues) {
          context.addIssue({
            code: 'custom',
            path: issue.path,
            message: issue.message,
          });
        }
      }
    });
}

export const searchToolOutputSchema = toolOutputSchema(
  searchOutputSchema,
  searchBatchOutputSchema,
);
export const journeyToolOutputSchema = toolOutputSchema(
  journeyOutputSchema,
  journeyBatchOutputSchema,
);
