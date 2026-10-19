import type { SessionMessageAssistant, SessionMessageInfo, SessionMessagesResponse } from "@opencode/client"
import type { z } from "zod"
import type { InspectInput } from "./schema.ts"

type Include = z.infer<typeof InspectInput>["include"]

export function snapshot(page: SessionMessagesResponse, input: z.infer<typeof InspectInput>) {
  const selected = page.data.flatMap((message) => {
    const data = messageData(message, input.include)
    return data ? [{ message, data }] : []
  })
  const sections = selected.reduce((count, entry) => count + (entry.message.type === "assistant"
    ? Math.max(1, selectContent(entry.message.content, input.include).length) : 1), 0)
  const budget = Math.floor(input.maxChars / Math.max(1, sections))
  const items = selected.map(({ message, data }) => {
    if (message.type !== "assistant") {
      const fitted = fit(data, budget)
      return {
        messageID: message.id, type: message.type, time: message.time,
        ...("status" in message ? { status: message.status } : {}),
        ...("outcome" in message ? { outcome: message.outcome } : {}),
        data: fitted.data, truncated: fitted.truncated,
      }
    }
    const content = selectContent(message.content, input.include).map((part) => {
      const fitted = fit(part, budget)
      return {
        index: part.index, type: part.type,
        ...(part.type === "tool" ? {
          id: part.id, name: part.name, status: part.state.status, executed: part.executed, time: part.time,
          ...(part.state.status === "error" ? {
            error: { type: part.state.error.type, message: part.state.error.message.slice(0, 512) },
          } : {}),
        } : {}),
        data: fitted.data, truncated: fitted.truncated,
      }
    })
    return {
      messageID: message.id, type: message.type, time: message.time,
      finish: message.finish,
      error: message.error ? { type: message.error.type, message: message.error.message.slice(0, 512) } : undefined,
      retry: message.retry ? { attempt: message.retry.attempt, at: message.retry.at } : undefined,
      data: { content }, truncated: content.some((part) => part.truncated) || (message.error?.message.length ?? 0) > 512,
    }
  })
  return {
    view: "snapshot", items, truncated: items.some((item) => item.truncated),
    cursor: page.data.length ? page.cursor.next ?? undefined : undefined,
    order: "newest_first", included: input.include,
    notice: "Every fetched message and selected content part has an entry. Truncated content can be read using messageID, then nextOffset and revision. cursor reads older messages; omit it to refresh current activity.",
  }
}

export function readMessage(message: SessionMessageInfo, input: z.infer<typeof InspectInput>) {
  const data = messageData(message, input.include)
  if (!data) throw new Error("This message is excluded by include; enable messages or tools as appropriate")
  const text = JSON.stringify(data)
  const revision = Bun.hash(text).toString(16)
  if (input.revision && input.revision !== revision) {
    throw new Error("Message changed since the previous chunk; restart at offset=0 without revision")
  }
  if (input.offset > text.length) throw new Error("offset exceeds message length")
  return {
    view: "message", messageID: message.id, type: message.type, revision,
    encoding: "json", text: text.slice(input.offset, input.offset + input.maxChars),
    offset: input.offset, totalChars: text.length,
    nextOffset: input.offset + input.maxChars < text.length ? input.offset + input.maxChars : null,
    truncated: input.offset + input.maxChars < text.length,
    notice: "Concatenate JSON text chunks using nextOffset and the same revision/include. A changed message requires a fresh read.",
  }
}

export function messageData(message: SessionMessageInfo, include: Include): Record<string, unknown> | undefined {
  if (message.type === "assistant") {
    return { ...publicFields(message), content: selectContent(message.content, include) }
  }
  if (!include.includes("messages") && !(message.type === "shell" && include.includes("tools"))) return
  return publicFields(message)
}

export function selectContent(content: SessionMessageAssistant["content"], include: Include) {
  return content.flatMap<SessionMessageAssistant["content"][number] & { index: number }>((part, index) => {
    if (part.type === "tool" && include.includes("tools")) return [{
      index, type: part.type, id: part.id, name: part.name, executed: part.executed, state: part.state, time: part.time,
    }]
    if (part.type === "reasoning" && include.includes("reasoning")) return [{ index, type: part.type, text: part.text, time: part.time }]
    if (part.type === "text" && include.includes("messages")) return [{ index, type: part.type, text: part.text }]
    return []
  })
}

// Native provider checkpoints and raw message metadata are transport internals, not visible conversation content.
export function publicFields(data: object) {
  return Object.fromEntries(Object.entries(data).filter(([key]) =>
    !["metadata", "providerState", "providerResultState", "providerContext", "state"].includes(key),
  ))
}

export function fit(data: unknown, maxChars: number) {
  const text = JSON.stringify(data)
  if (text.length <= maxChars) return { data, truncated: false, size: text.length }
  return { data: { previewJson: text.slice(0, maxChars) }, truncated: true, size: maxChars }
}
