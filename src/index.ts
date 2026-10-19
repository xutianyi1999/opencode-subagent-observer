import { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { z } from "zod"
import { connect, verifyCaller } from "./client.ts"
import { inspectSubagent, listSubagents } from "./observe.ts"
import { InspectInput, ListInput, ObservationOutput, Options } from "./schema.ts"

const observationHint = "You may actively use list_subagents and inspect_subagent to read progress. Queries do not message or interrupt the child. Avoid tight polling and do not duplicate its work."
const BackgroundOutput = z.object({ sessionID: z.string(), status: z.literal("running"), output: z.string() }).passthrough()
const BackgroundSchema = z.object({ description: z.string().optional() }).passthrough()
const ToolSchema = z.object({ properties: z.record(z.string(), z.unknown()) }).passthrough()

export default Plugin.define({
  id: "subagent-observer",
  async setup(ctx) {
    const options = Options.parse(ctx.options)
    const getClient = async (sessionID: string, signal: AbortSignal) => {
      const client = await connect(options)
      await verifyCaller(client, ctx, sessionID, signal)
      return client
    }
    const signalFor = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "list_subagents",
        description: "Read your direct subagents and their current execution status. Pure pull, read-only; excludes forks. Use cursor for another page.",
        input: ListInput,
        output: ObservationOutput,
        options: { codemode: false },
        async execute(input, context) {
          const signal = signalFor(context.signal)
          const result = await listSubagents(await getClient(context.sessionID, signal), context.sessionID, input, signal)
          return { output: result, content: JSON.stringify(result) }
        },
      })
      tools.add({
        name: "inspect_subagent",
        description: "Read one of your direct subagents without notifying it. snapshot reads recent messages and tool states; include reasoning for visible persisted reasoning. changes reads durable events after afterSeq and returns nextAfterSeq. If the server omits event bodies, historyUnavailable=true and a current snapshot is included instead. An inactive child is not necessarily completed; inspect lastOutcome separately. No unfinished streaming tokens are available.",
        input: InspectInput,
        output: ObservationOutput,
        options: { codemode: false },
        async execute(input, context) {
          const signal = signalFor(context.signal)
          const result = await inspectSubagent(await getClient(context.sessionID, signal), context.sessionID, input, signal)
          return { output: result, content: JSON.stringify(result) }
        },
      })
      const subagent = tools.list().find((tool) => tool.name === "subagent")
      if (!subagent) return
      tools.update(subagent.id, (tool) => {
        const execute = tool.execute
        tool.execute = async (input, context) => {
          const result = await execute(input, context)
          const parsed = BackgroundOutput.safeParse(result.output)
          if (!parsed.success) return result
          return {
            ...result,
            output: { ...parsed.data, output: backgroundText(parsed.data.output) },
            content: typeof result.content === "string" ? backgroundText(result.content) : result.content,
          }
        }
      })
    })

    await ctx.session.hook("context", adaptContext)
  },
})

export function adaptContext(event: Pick<SessionContext, "tools">) {
  if (!event.tools.inspect_subagent) return
  const subagent = event.tools.subagent
  if (!subagent) return
  subagent.description += `\n${observationHint}`
  const input = ToolSchema.safeParse(subagent.input)
  if (!input.success) return
  const background = BackgroundSchema.safeParse(input.data.properties.background)
  if (!background.success) return
  subagent.input = {
    ...subagent.input,
    properties: {
      ...input.data.properties,
      background: { ...background.data, description: `Run in the background and return immediately. ${observationHint}` },
    },
  }
}

export function backgroundText(text: string) {
  return text
    .replace("DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.", observationHint)
    .replace("Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
      "Continue other work or inspect this subagent when useful; end your response when no further observation is needed.")
}
