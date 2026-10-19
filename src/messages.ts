import type { SessionMessageInfo, SessionMessagesResponse } from "@opencode/client"
import type { z } from "zod"
import type { InspectInput } from "./schema.ts"

export function snapshot(page: SessionMessagesResponse, maxChars: number) {
  const sections = page.data.reduce((count, message) =>
    count + (message.type === "assistant" ? Math.max(1, message.content.length) : 1), 0)
  const budget = Math.floor(maxChars / Math.max(1, sections))
  const messages = page.data.map((message) => {
    const header = { id: message.id, type: message.type, time: message.time }
    if (message.type !== "assistant") {
      const details = preview(visibleFields(message), budget)
      return {
        ...header,
        ...("status" in message ? { status: message.status } : {}),
        ...("outcome" in message ? { outcome: message.outcome } : {}),
        details: details.value, truncated: details.truncated,
      }
    }
    const content = message.content.map((part) => {
      if (part.type !== "tool") {
        const text = preview(part.text, budget)
        return { type: part.type, text: text.value, ...("time" in part ? { time: part.time } : {}), truncated: text.truncated }
      }
      const details = preview(part.state, budget)
      return {
        type: part.type, id: part.id, name: part.name, status: part.state.status,
        executed: part.executed, time: part.time,
        ...(part.state.status === "error" ? {
          error: { type: part.state.error.type, message: part.state.error.message.slice(0, 512) },
        } : {}),
        details: details.value, truncated: details.truncated,
      }
    })
    return {
      ...header, finish: message.finish,
      error: message.error ? { type: message.error.type, message: message.error.message.slice(0, 512) } : undefined,
      retry: message.retry ? { attempt: message.retry.attempt, at: message.retry.at } : undefined,
      content, truncated: content.some((part) => part.truncated) || (message.error?.message.length ?? 0) > 512,
    }
  })
  return {
    messages, cursor: page.data.length ? page.cursor.next ?? undefined : undefined,
    truncated: messages.some((message) => message.truncated),
  }
}

export function readMessage(message: SessionMessageInfo, input: z.infer<typeof InspectInput>) {
  const data = message.type === "assistant"
    ? { ...visibleFields(message), content: message.content.map((part) =>
      part.type === "tool" ? { ...visibleFields(part), state: part.state } : visibleFields(part)) }
    : visibleFields(message)
  const text = JSON.stringify(data)
  const revision = Bun.hash(text).toString(16)
  if (input.revision && input.revision !== revision) {
    throw new Error("Message changed; restart at offset=0 without revision")
  }
  if (input.offset > text.length) throw new Error("offset exceeds message length")
  return {
    messageID: message.id, type: message.type, revision, encoding: "json",
    text: text.slice(input.offset, input.offset + input.maxChars),
    nextOffset: input.offset + input.maxChars < text.length ? input.offset + input.maxChars : null,
    truncated: input.offset + input.maxChars < text.length,
  }
}

// Provider checkpoints are not visible conversation content; tool execution state is retained explicitly above.
function visibleFields(data: object) {
  return Object.fromEntries(Object.entries(data).filter(([key]) =>
    !["metadata", "providerState", "providerResultState", "providerContext", "state"].includes(key),
  ))
}

function preview<Value>(value: Value, maxChars: number) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return { value: text.length <= maxChars ? value : text.slice(0, maxChars), truncated: text.length > maxChars }
}
