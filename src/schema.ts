import { z } from "zod"

export const Options = z.object({
  baseUrl: z.url().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().min(100).max(60000).default(15000),
})

export const ListInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
})

export const ObservationOutput = z.record(z.string(), z.unknown())

export const InspectInput = z.strictObject({
  sessionID: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
  maxChars: z.number().int().min(256).max(40000).default(12000),
  cursor: z.string().optional(),
  messageID: z.string().min(1).optional(),
  offset: z.number().int().nonnegative().default(0),
  revision: z.string().max(32).optional(),
}).refine((input) => !input.cursor || !input.messageID, {
  message: "cursor and messageID cannot be combined",
}).refine((input) => input.messageID || (!input.offset && !input.revision), {
  message: "offset and revision require messageID",
}).refine((input) => !input.offset || input.revision, {
  message: "Continuing a message at offset > 0 requires its revision",
})
