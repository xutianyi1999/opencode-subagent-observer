import type {
  OpenCodeClient,
  SessionEventDurable,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client"
import type { z } from "zod"
import { InspectInput, ListInput, Visibility } from "./schema.ts"
import { fit, publicFields, readMessage, selectContent, snapshot } from "./messages.ts"

export async function listSubagents(
  client: OpenCodeClient,
  callerID: string,
  input: z.infer<typeof ListInput>,
  signal: AbortSignal,
) {
  const startedAt = Date.now()
  const [page, active] = await Promise.all([
    client.session.list({ parentID: callerID, limit: input.limit, cursor: input.cursor }, { signal }),
    client.session.active({ signal }),
  ])
  // Server pagination remembers filters; verify returned ownership even with a supplied cursor.
  if (page.data.some((session) => session.parentID !== callerID)) {
    throw new Error("Cursor does not belong to the calling parent session")
  }
  return {
    observed: { startedAt, endedAt: Date.now() },
    subagents: page.data.filter((session) => !session.fork).map((session) => ({
      ...identity(session),
      execution: execution(session, active[session.id] !== undefined),
    })),
    cursor: page.data.length ? page.cursor.next ?? undefined : undefined,
    visibility: Visibility,
  }
}

export async function inspectSubagent(
  client: OpenCodeClient,
  callerID: string,
  input: z.infer<typeof InspectInput>,
  signal: AbortSignal,
) {
  const startedAt = Date.now()
  const session = await client.session.get({ sessionID: input.sessionID }, { signal })
  if (session.parentID !== callerID || session.fork) {
    throw new Error("Only the calling session's direct, non-fork subagents can be inspected")
  }
  // Read the replay boundary before its fallback snapshot, so advancing the cursor cannot hide a newer projection.
  const changes = input.view === "changes" ? await readChanges(client, input, signal) : undefined
  const [active, page, permissions, historical, message] = await Promise.all([
    client.session.active({ signal }),
    client.message.list({ sessionID: session.id, order: "desc", limit: input.cursor || input.messageID ? 20 : input.limit }, { signal }),
    client.permission.request.list({ location: { directory: session.location.directory } }, { signal }),
    input.cursor ? client.message.list({ sessionID: session.id, cursor: input.cursor, limit: input.limit }, { signal }) : undefined,
    input.messageID ? client.session.message.get({ sessionID: session.id, messageID: input.messageID }, { signal }) : undefined,
  ])
  const running = active[session.id] !== undefined
  const waiting = permissions.data.filter((request) => request.sessionID === session.id)
  const details = changes ?? (message ? readMessage(message, input) : snapshot(historical ?? page, input))
  return {
    session: identity(session),
    observed: { startedAt, endedAt: Date.now() },
    execution: execution(session, running),
    activity: {
      phase: waiting.length ? "waiting_permission" : phase(page.data, running),
      lastProjectedUpdate: session.time.updated,
      pendingPermissions: waiting.map((request) => ({
        id: request.id, action: request.action, resources: request.resources,
      })),
    },
    ...details,
    ...("historyUnavailable" in details && details.historyUnavailable
      ? { snapshot: snapshot(page, input) } : {}),
    visibility: Visibility,
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

async function readChanges(client: OpenCodeClient, input: z.infer<typeof InspectInput>, signal: AbortSignal) {
  const items: Array<{ seq: number; type: string; created: number; data: unknown; truncated: boolean }> = []
  let nextAfterSeq = input.afterSeq ?? 0
  let synced = false
  let remaining = input.maxChars
  let scanned = 0
  let historyUnavailable = false
  // Finite historical replay: the SDK handles SSE and closes its iterator on break.
  for await (const event of client.session.log({ sessionID: input.sessionID, after: input.afterSeq, follow: false }, { signal })) {
    if (event.type === "log.synced") {
      if (event.seq !== undefined && event.seq < nextAfterSeq) {
        throw new Error("Log cursor is ahead of retained history; restart from a snapshot without afterSeq")
      }
      // Some hosts expose a sequence boundary but omit replayable event bodies.
      // Preserve the boundary and return a fresh projection rather than pretending no work occurred.
      historyUnavailable = scanned === 0 && event.seq !== undefined && event.seq > nextAfterSeq
      nextAfterSeq = event.seq ?? nextAfterSeq
      synced = true
      break
    }
    if (includeEvent(event, input.include)) {
      if (items.length >= input.limit || remaining <= 0) break
      const data = event.type === "session.message.content.updated"
        ? { ...publicFields(event.data), content: selectContent(event.data.content, input.include) }
        : publicFields(event.data)
      const fitted = fit(data, remaining)
      items.push({
        seq: event.durable.seq, type: event.type, created: event.created,
        ...("assistantMessageID" in event.data ? { messageID: event.data.assistantMessageID } : {}),
        ...("messageID" in event.data ? { messageID: event.data.messageID } : {}),
        ...fitted,
      })
      remaining -= fitted.size
    }
    nextAfterSeq = event.durable.seq
    scanned++
    // Bound reads through unrelated durable history without skipping unprocessed events.
    if (scanned >= 1000) break
  }
  return {
    view: "changes", items, nextAfterSeq, synced, historyUnavailable,
    ...(historyUnavailable ? {
      notice: "The server advanced its log sequence without returning event bodies. A current projected snapshot is included; this does not reconstruct intermediate events.",
    } : {}),
    truncated: !synced || items.some((item) => item.truncated),
  }
}

function includeEvent(event: SessionEventDurable, include: z.infer<typeof InspectInput>["include"]) {
  if (/^session\.(execution|step|retry|compaction|revert)\./.test(event.type)) return true
  if (event.type === "session.message.content.updated") return include.length > 0
  if (/^session\.(tool|shell)\./.test(event.type)) return include.includes("tools")
  if (event.type.startsWith("session.reasoning.")) return include.includes("reasoning")
  if (/^session\.(text|agent|model|skill|instructions)\./.test(event.type) ||
    ["session.inbox.delivered", "session.synthetic", "session.moved"].includes(event.type)) return include.includes("messages")
  return false
}
