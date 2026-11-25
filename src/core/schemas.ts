import { z as zod } from 'zod';

export const modes = [
  'TRAM',
  'SUBWAY',
  'RAIL',
  'BUS',
  'FERRY',
  'CABLE_TRAM',
  'AERIAL_LIFT',
  'FUNICULAR',
  'TROLLEYBUS',
  'MONORAIL',
] as const;

const minutes = zod.number().int().min(0).max(65534);

export const searchSchema = zod
  .object({
    query: zod.string().trim().min(1),
    limit: zod.number().int().min(1).max(100).default(10),
  })
  .strict();

export const routingSchema = zod
  .object({
    origin: zod.string().min(1),
    departure: zod.iso.datetime({ offset: true }),
    serviceDate: zod.iso.date().optional(),
    maxDuration: minutes.optional(),
    maxTransfers: zod.number().int().min(0).max(20).default(5),
    minTransferTime: minutes.default(2),
    transportModes: zod.array(zod.enum(modes)).min(1).optional(),
  })
  .strict();

const routingModes = zod.enum(['single_departure', 'departure_window']);

/** Reject window options that the selected routing mode cannot honor. */
function validateRoutingMode(
  query: {
    mode?: string;
    latestDeparture?: string;
  },
  context: zod.RefinementCtx,
) {
  const mode =
    query.mode ??
    (query.latestDeparture ? 'departure_window' : 'single_departure');

  if (mode === 'departure_window' && !query.latestDeparture) {
    context.addIssue({
      code: 'custom',
      message: 'Window mode requires latestDeparture',
    });
  }

  if (mode !== 'departure_window' && query.latestDeparture) {
    context.addIssue({
      code: 'custom',
      message: 'latestDeparture requires departure_window mode',
    });
  }
}

export const journeySchema = routingSchema
  .extend({
    destination: zod.string().min(1),
    mode: routingModes.optional(),
    latestDeparture: zod.iso.datetime({ offset: true }).optional(),
  })
  .superRefine(validateRoutingMode);

/** Batches validate every item before any query is executed. */
export const searchBatchSchema = zod
  .object({
    queries: zod.array(searchSchema).min(1).max(20),
  })
  .strict();
export const journeyBatchSchema = zod
  .object({
    queries: zod.array(journeySchema).min(1).max(20),
  })
  .strict();

/** Keep MCP's object root while validating exactly one request form. */
function batchRequestSchema<
  T extends Record<string, zod.ZodType>,
  Q extends zod.ZodType,
>(
  single: zod.ZodObject<T>,
  batch: zod.ZodObject<{ queries: zod.ZodArray<Q> }>,
) {
  const shape = Object.fromEntries(
    Object.entries(single.shape).map(([key, value]) => [
      key,
      zod.optional(value instanceof zod.ZodDefault ? value.unwrap() : value),
    ]),
  );

  return zod
    .object({ ...shape, queries: batch.shape.queries.optional() })
    .strict()
    .superRefine((value, context) => {
      const result = ('queries' in value ? batch : single).safeParse(value);

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

export const searchToolSchema = batchRequestSchema(
  searchSchema,
  searchBatchSchema,
);
export const journeyToolSchema = batchRequestSchema(
  journeySchema,
  journeyBatchSchema,
);
export type SearchBatchInput = zod.input<typeof searchBatchSchema>;
export type JourneyBatchInput = zod.input<typeof journeyBatchSchema>;

export const reachabilitySchema = routingSchema
  .extend({
    mode: routingModes.optional(),
    latestDeparture: zod.iso.datetime({ offset: true }).optional(),
  })
  .superRefine(validateRoutingMode);

export type RoutingInput = zod.input<typeof routingSchema>;

export type SearchInput = zod.input<typeof searchSchema>;

export type ReachabilityInput = zod.input<typeof reachabilitySchema>;

export type JourneyInput = zod.input<typeof journeySchema>;

export const computeReachabilitySchema = zod
  .object({
    query: reachabilitySchema.optional(),
    resultId: zod.uuid().optional(),
    view: zod.enum(['summary', 'page']).default('summary'),
    offset: zod.number().int().min(0).optional(),
    limit: zod.number().int().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (Boolean(query.query) === Boolean(query.resultId)) {
      context.addIssue({
        code: 'custom',
        message: 'Provide exactly one of query or resultId',
      });
    }

    if (
      query.view === 'summary' &&
      (query.offset !== undefined || query.limit !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'offset and limit require view: page',
      });
    }
  });

export const reachabilityFields = [
  'id',
  'name',
  'latitude',
  'longitude',
  'parentId',
  'platform',
  'durationMinutes',
  'arrival',
  'departure',
  'transferCount',
] as const;

export const reachabilityFiltersSchema = zod
  .object({
    stopIds: zod.array(zod.string().min(1)).optional(),
    name: zod.string().trim().min(1).optional(),
    minDuration: minutes.optional(),
    maxDuration: minutes.optional(),
    maxTransfers: zod.number().int().min(0).max(20).optional(),
    hasCoordinates: zod.boolean().optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.minDuration === undefined ||
      query.maxDuration === undefined ||
      query.minDuration <= query.maxDuration,
    'minDuration must not exceed maxDuration',
  );

export const queryReachabilitySchema = zod
  .object({
    resultId: zod.uuid(),
    filters: reachabilityFiltersSchema.default({}),
    fields: zod
      .array(zod.enum(reachabilityFields))
      .max(reachabilityFields.length)
      .default(['id', 'name', 'durationMinutes', 'transferCount']),
    sortBy: zod
      .enum(['durationMinutes', 'arrival', 'name', 'id'])
      .default('durationMinutes'),
    order: zod.enum(['asc', 'desc']).default('asc'),
    offset: zod.number().int().min(0).default(0),
    limit: zod.number().int().min(0).max(500).default(25),
  })
  .strict();

export type ComputeReachabilityInput = zod.input<
  typeof computeReachabilitySchema
>;

export type QueryReachabilityInput = zod.input<typeof queryReachabilitySchema>;

export type ReachabilityField = (typeof reachabilityFields)[number];

export class TransitError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
