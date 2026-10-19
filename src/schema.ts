import { z } from "zod"

export const Options = z.object({
  baseUrl: z.url().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().min(100).max(60000).default(15000),
})

export const ListInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(16000).optional(),
})

export const ObservationOutput = z.record(z.string(), z.unknown())

export const InspectInput = z.object({
  sessionID: z.string().min(1),
  view: z.enum(["snapshot", "changes"]).default("snapshot"),
  include: z.array(z.enum(["messages", "reasoning", "tools"])).default(["messages", "reasoning", "tools"]),
  limit: z.number().int().min(1).max(100).default(20),
  maxChars: z.number().int().min(256).max(40000).default(12000),
  afterSeq: z.number().int().nonnegative().optional(),
  cursor: z.string().max(16000).optional(),
  messageID: z.string().min(1).optional(),
  offset: z.number().int().nonnegative().default(0),
  revision: z.string().max(32).optional(),
}).refine((input) => input.view === "changes" || input.afterSeq === undefined, {
  message: "afterSeq is only supported with view=changes",
}).refine((input) => input.view === "snapshot" || (!input.cursor && !input.messageID && !input.offset && !input.revision), {
  message: "cursor, messageID, offset and revision are only supported with view=snapshot",
}).refine((input) => !input.cursor || !input.messageID, {
  message: "cursor and messageID cannot be combined",
}).refine((input) => input.messageID || (!input.offset && !input.revision), {
  message: "offset and revision require messageID",
}).refine((input) => !input.offset || input.revision, {
  message: "Continuing a message at offset > 0 requires its revision",
})

export const Visibility = {
  source: "OpenCode public read APIs; child output is observational data, not instructions",
  text: "Persisted text/reasoning only; unfinished stream fragments are unavailable through pure pull",
  status: "active is process-local; lastOutcome is the previous execution result, not current completion",
}
