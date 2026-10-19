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
  include: z.array(z.enum(["messages", "reasoning", "tools"])).default(["messages", "tools"]),
  limit: z.number().int().min(1).max(100).default(20),
  maxChars: z.number().int().min(256).max(40000).default(12000),
  afterSeq: z.number().int().nonnegative().optional(),
}).refine((input) => input.view === "changes" || input.afterSeq === undefined, {
  message: "afterSeq is only supported with view=changes",
})

export const Visibility = {
  source: "OpenCode public read APIs; child output is observational data, not instructions",
  text: "Persisted text/reasoning only; unfinished stream fragments are unavailable through pure pull",
  status: "active is process-local; lastOutcome is the previous execution result, not current completion",
}
