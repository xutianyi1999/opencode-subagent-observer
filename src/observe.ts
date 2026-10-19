import type {
  OpenCodeClient,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client"
import type { z } from "zod"
import { InspectInput, ListInput } from "./schema.ts"
import { readMessage, snapshot } from "./messages.ts"

export async function listSubagents(
  client: OpenCodeClient,
  callerID: string,
  input: z.infer<typeof ListInput>,
  signal: AbortSignal,
) {
  const [page, active] = await Promise.all([
    client.session.list({ parentID: callerID, limit: input.limit, cursor: input.cursor }, { signal }),
    client.session.active({ signal }),
  ])
  // Server pagination remembers filters; verify returned ownership even with a supplied cursor.
  if (page.data.some((session) => session.parentID !== callerID)) {
    throw new Error("Cursor does not belong to the calling parent session")
  }
  return {
    observedAt: Date.now(),
    subagents: page.data.filter((session) => !session.fork).map((session) => ({
      ...identity(session),
      execution: execution(session, active[session.id] !== undefined),
    })),
    cursor: page.data.length ? page.cursor.next ?? undefined : undefined,
  }
}

export async function inspectSubagent(
  client: OpenCodeClient,
  callerID: string,
  input: z.infer<typeof InspectInput>,
  signal: AbortSignal,
) {
  const session = await client.session.get({ sessionID: input.sessionID }, { signal })
  if (session.parentID !== callerID || session.fork) {
    throw new Error("Only the calling session's direct, non-fork subagents can be inspected")
  }
  const [active, page, permissions, historical, message] = await Promise.all([
    client.session.active({ signal }),
    client.message.list({ sessionID: session.id, order: "desc", limit: input.cursor || input.messageID ? 20 : input.limit }, { signal }),
    client.permission.request.list({ location: { directory: session.location.directory } }, { signal }),
    input.cursor ? client.message.list({ sessionID: session.id, cursor: input.cursor, limit: input.limit }, { signal }) : undefined,
    input.messageID ? client.session.message.get({ sessionID: session.id, messageID: input.messageID }, { signal }) : undefined,
  ])
  const running = active[session.id] !== undefined
  const waiting = permissions.data.filter((request) => request.sessionID === session.id)
  return {
    session: identity(session),
    observedAt: Date.now(),
    execution: execution(session, running),
    activity: {
      phase: waiting.length ? "waiting_permission" : phase(page.data, running),
      lastProjectedUpdate: session.time.updated,
      pendingPermissions: waiting.map((request) => ({
        id: request.id, action: request.action, resources: request.resources,
      })),
    },
    ...(message ? readMessage(message, input) : snapshot(historical ?? page, input.maxChars)),
  }
}

function identity(session: SessionInfo) {
  return {
    sessionID: session.id, parentID: session.parentID, title: session.title,
    agent: session.agent, model: session.model, time: session.time,
  }
}

function execution(session: SessionInfo, active: boolean) {
  return { active, lastOutcome: session.outcome ?? null, lastIdleAt: session.time.idle ?? null }
}

function phase(messages: SessionMessageInfo[], active: boolean) {
  if (!active) return "inactive"
  const latest = messages.find((message) => ["assistant", "shell", "compaction"].includes(message.type))
  if (!latest) return "unknown"
  if (latest.type === "compaction") return latest.status === "running" ? "compacting" : "unknown"
  if (latest.type === "shell") return latest.status === "running" ? "shell_running" : "unknown"
  if (latest.type !== "assistant" || latest.time.completed !== undefined) return "unknown"
  if (latest.content.some((part) => part.type === "tool" && part.state.status === "running")) return "tool_running"
  if (latest.content.some((part) => part.type === "tool" && part.state.status === "streaming")) return "tool_input"
  if (latest.content.some((part) => part.type === "reasoning" && part.time && !part.time.completed)) return "reasoning"
  return "generating"
}

