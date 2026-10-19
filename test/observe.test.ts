import { afterEach, expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import type { SessionInfo, SessionLogItem, SessionMessageInfo } from "@opencode/client"
import { inspectSubagent, listSubagents } from "../src/observe.ts"
import { InspectInput, ListInput } from "../src/schema.ts"
import { adaptContext, backgroundText } from "../src/index.ts"

const servers = new Set<{ stop(closeActiveConnections?: boolean): unknown }>()
afterEach(() => {
  servers.forEach((server) => server.stop(true))
  servers.clear()
})

function session(id = "child", parentID = "parent"): SessionInfo {
  return {
    id, parentID, projectID: "project", title: "Fixture task", agent: "general",
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    outcome: "succeeded", time: { created: 1, updated: 2, idle: 2 }, location: { directory: "/fixture" },
  }
}

function textEvent(seq: number, text = "visible text"): SessionLogItem {
  return {
    id: `evt-${seq}`, created: seq, type: "session.text.ended",
    durable: { aggregateID: "child", seq, version: 1 },
    data: { sessionID: "child", assistantMessageID: "msg", ordinal: 0, text },
  }
}

function fixture() {
  const state = {
    sessions: [session()], active: true,
    messages: [{
      id: "msg", type: "assistant", time: { created: 3 }, agent: "general",
      model: { providerID: "opencode", id: "free" },
      content: [
        { type: "text", text: "Working" },
        { type: "reasoning", text: "Visible reasoning", providerState: { hidden: "do not expose" } },
        { type: "tool", id: "call", name: "read", time: { created: 3 },
          state: { status: "running", input: { path: "README.md" }, metadata: {} } },
      ],
    }] as SessionMessageInfo[],
    olderMessages: [] as SessionMessageInfo[],
    events: [textEvent(1), textEvent(2)] as SessionLogItem[],
    omitLogEvents: false,
    onLog: () => {},
    permissions: [] as Array<{ id: string; sessionID: string; action: string; resources: string[] }>,
    requests: [] as Array<{ method: string; url: URL }>,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url)
      state.requests.push({ method: request.method, url })
      if (request.method !== "GET") return new Response("Unexpected write", { status: 405 })
      if (url.pathname === "/api/session/active") return Response.json({ data: state.active ? { child: { type: "running" } } : {} })
      if (url.pathname === "/api/session") return Response.json({ data: state.sessions, cursor: { next: "next-page" } })
      if (url.pathname.endsWith("/message")) return Response.json({
        data: url.searchParams.has("cursor") ? state.olderMessages : state.messages,
        cursor: !url.searchParams.has("cursor") && state.olderMessages.length ? { next: "older-page" } : {},
      })
      if (url.pathname.includes("/message/")) {
        const message = [...state.messages, ...state.olderMessages].find((entry) => entry.id === url.pathname.split("/").at(-1))
        return message ? Response.json({ data: message }) : new Response("Unknown message", { status: 404 })
      }
      if (url.pathname.endsWith("/log")) {
        state.onLog()
        const after = Number(url.searchParams.get("after") ?? 0)
        const events = state.events.filter((event) => event.type !== "log.synced" && event.durable.seq > after)
        const seq = state.events.at(-1)
        const synced = { type: "log.synced", aggregateID: "child", seq: seq && seq.type !== "log.synced" ? seq.durable.seq : 0 }
        return new Response([...(state.omitLogEvents ? [] : events), synced].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (url.pathname === "/api/permission/request") return Response.json({ location: { directory: "/fixture" }, data: state.permissions })
      const target = state.sessions.find((entry) => url.pathname === `/api/session/${entry.id}`)
      if (target) return Response.json({ data: target })
      return new Response(`Missing fixture: ${url.pathname}`, { status: 404 })
    },
  })
  servers.add(server)
  return { state, client: OpenCode.make({ baseUrl: server.url.href }) }
}

const signal = () => AbortSignal.timeout(5000)

test("lists only direct non-fork children and keeps the real next cursor", async () => {
  const f = fixture()
  f.state.sessions.push({ ...session("fork"), fork: { sessionID: "parent", boundary: { type: "through", messageID: "old" } } })
  const result = await listSubagents(f.client, "parent", ListInput.parse({}), signal())
  expect(result.subagents.map((entry) => entry.sessionID)).toEqual(["child"])
  expect(result.cursor).toBe("next-page")
  expect(f.state.requests.find((request) => request.url.pathname === "/api/session")?.url.searchParams.get("parentID")).toBe("parent")
})

test("rejects cursors that return another parent's sessions", async () => {
  const f = fixture()
  f.state.sessions = [session("other", "different-parent")]
  await expect(listSubagents(f.client, "parent", ListInput.parse({ cursor: "untrusted" }), signal())).rejects.toThrow("Cursor")
})

test("active execution does not overwrite the last completed outcome", async () => {
  const f = fixture()
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child" }), signal())
  expect(result.execution).toEqual({ active: true, lastOutcome: "succeeded", lastIdleAt: 2 })
  expect(result.activity.phase).toBe("tool_running")
  expect(JSON.stringify(result)).toContain("Visible reasoning")
  expect(f.state.requests.every((request) => request.method === "GET")).toBe(true)
})

test("reasoning can be selected explicitly and provider state is omitted", async () => {
  const f = fixture()
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", include: ["reasoning"] }), signal())
  expect(JSON.stringify(result)).toContain("Visible reasoning")
  expect(JSON.stringify(result)).not.toContain("do not expose")
})

test("reasoning can be explicitly excluded without losing tool calls", async () => {
  const f = fixture()
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", include: ["messages", "tools"] }), signal())
  expect(JSON.stringify(result)).not.toContain("Visible reasoning")
  expect(JSON.stringify(result)).toContain("README.md")
})

test("long reasoning cannot crowd out tool identities, errors or older messages", async () => {
  const f = fixture()
  const message = f.state.messages[0]
  if (message?.type !== "assistant") throw new Error("Missing assistant fixture")
  message.content = [
    { type: "reasoning", text: "x".repeat(20000) },
    { type: "tool", id: "important-call", name: "read", time: { created: 3 },
      state: { status: "error", input: { path: "missing.txt" }, error: { type: "NotFound", message: "Important failure" } } },
  ]
  f.state.messages.push({ id: "older", type: "user", time: { created: 1 }, text: "Earlier request" })
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", maxChars: 256 }), signal())
  if (!("items" in result)) throw new Error("Expected snapshot")
  expect(result.items.map((item) => "messageID" in item ? item.messageID : undefined)).toEqual(["msg", "older"])
  expect(JSON.stringify(result.items)).toContain("important-call")
  expect(JSON.stringify(result.items)).toContain("Important failure")
  expect(JSON.stringify(result.items)).toContain('"status":"error"')
  expect(result.truncated).toBe(true)
})

test("assistant failures without text, system, shell, compaction and control messages are retained", async () => {
  const f = fixture()
  const assistant = f.state.messages[0]
  if (assistant?.type !== "assistant") throw new Error("Missing assistant fixture")
  f.state.messages = [
    { ...assistant, content: [], error: { type: "ProviderError", message: "Model unavailable" } },
    { id: "sys", type: "system", time: { created: 1 }, text: "Instruction update" },
    { id: "shell", type: "shell", time: { created: 1 }, shellID: "shell-id", command: "pwd", status: "exited", exit: 0,
      output: { output: "/fixture", cursor: 8, size: 8, truncated: false } },
    { id: "compact", type: "compaction", status: "running", time: { created: 1 }, reason: "auto", summary: "Summary", recent: "Recent" },
    { id: "switch", type: "agent-switched", time: { created: 1 }, agent: "general", previous: "explore" },
    { id: "idle", type: "idle", time: { created: 1 }, outcome: "failed", error: { type: "Failure", message: "Execution failed" } },
  ]
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child" }), signal())
  if (!("items" in result)) throw new Error("Expected snapshot")
  expect(result.items.map((item) => item.type)).toEqual(["assistant", "system", "shell", "compaction", "agent-switched", "idle"])
  expect(JSON.stringify(result.items)).toContain("Model unavailable")
  expect(JSON.stringify(result.items)).toContain("Instruction update")
  expect(JSON.stringify(result.items)).toContain("Execution failed")
})

test("older history uses the official cursor without changing current activity", async () => {
  const f = fixture()
  f.state.olderMessages = [{ id: "old", type: "user", time: { created: 1 }, text: "Earlier task" }]
  const first = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child" }), signal())
  if (!("cursor" in first)) throw new Error("Expected snapshot")
  expect(first.cursor).toBe("older-page")
  const older = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", cursor: first.cursor }), signal())
  if (!("items" in older)) throw new Error("Expected snapshot")
  expect(older.items.map((item) => "messageID" in item ? item.messageID : undefined)).toEqual(["old"])
  expect(older.activity.phase).toBe("tool_running")
  const request = f.state.requests.find((request) => request.url.searchParams.has("cursor"))
  expect(request?.url.searchParams.get("cursor")).toBe("older-page")
  expect(request?.url.searchParams.has("order")).toBe(false)
})

test("a long message can be recovered completely in bounded chunks using the SDK message endpoint", async () => {
  const f = fixture()
  const original = "完整文本🙂".repeat(1000)
  f.state.messages = [{ id: "long", type: "system", time: { created: 1 }, text: original }]
  const chunks: string[] = []
  const first = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", messageID: "long", maxChars: 400 }), signal())
  if (!("nextOffset" in first)) throw new Error("Expected message detail")
  chunks.push(first.text)
  let nextOffset = first.nextOffset
  while (nextOffset !== null) {
    const next = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", messageID: "long", maxChars: 400, offset: nextOffset, revision: first.revision }), signal())
    if (!("nextOffset" in next)) throw new Error("Expected message detail")
    expect(next.text.length).toBeLessThanOrEqual(400)
    chunks.push(next.text)
    nextOffset = next.nextOffset
  }
  expect(JSON.parse(chunks.join("")).text).toBe(original)
  expect(f.state.requests.some((request) => request.url.pathname.endsWith("/message/long"))).toBe(true)
  expect(f.state.requests.every((request) => request.method === "GET")).toBe(true)
})

test("continuing a changed message fails explicitly instead of combining different revisions", async () => {
  const f = fixture()
  f.state.messages = [{ id: "long", type: "system", time: { created: 1 }, text: "x".repeat(1000) }]
  const first = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", messageID: "long", maxChars: 256 }), signal())
  if (!("nextOffset" in first) || first.nextOffset === null) throw new Error("Expected chunked message")
  f.state.messages = [{ id: "long", type: "system", time: { created: 1 }, text: "Updated content" }]
  await expect(inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", messageID: "long", offset: first.nextOffset, revision: first.revision }), signal())).rejects.toThrow("Message changed")
})

test("message detail preserves complete reasoning, tool arguments and results", async () => {
  const f = fixture()
  const message = f.state.messages[0]
  if (message?.type !== "assistant") throw new Error("Missing assistant fixture")
  const reasoning = "reasoning ".repeat(1000)
  const output = "tool result ".repeat(1000)
  message.content = [
    { type: "reasoning", text: reasoning, state: { encrypted: "private-state" } },
    { type: "tool", id: "full-call", name: "shell", executed: true, time: { created: 3, completed: 4 },
      providerState: { encrypted: "private-state" },
      state: { status: "completed", input: { command: "read fixture" }, content: [{ type: "text", text: output }] } },
  ]
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", messageID: "msg", maxChars: 40000 }), signal())
  if (!("text" in result)) throw new Error("Expected message detail")
  const decoded = JSON.parse(result.text)
  expect(decoded.content[0].text).toBe(reasoning)
  expect(decoded.content[1].state.input).toEqual({ command: "read fixture" })
  expect(decoded.content[1].state.content[0].text).toBe(output)
  expect(decoded.content[1].executed).toBe(true)
  expect(result.text).not.toContain("private-state")
})

test("compaction activity is identified from the current projection", async () => {
  const f = fixture()
  f.state.messages = [{ id: "compact", type: "compaction", status: "running", time: { created: 3 }, reason: "auto", summary: "", recent: "" }]
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child" }), signal())
  expect(result.activity.phase).toBe("compacting")
})

test("message detail cannot bypass child ownership checks", async () => {
  const f = fixture()
  f.state.sessions = [session("child", "other")]
  await expect(inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", messageID: "msg" }), signal())).rejects.toThrow("direct")
  expect(f.state.requests.map((request) => request.url.pathname)).toEqual(["/api/session/child"])
})

test("a failed tool does not turn the whole child into a failed execution", async () => {
  const f = fixture()
  const message = f.state.messages[0]
  if (message?.type !== "assistant") throw new Error("Missing assistant fixture")
  message.content = [{ type: "tool", id: "failed-call", name: "read", time: { created: 3, completed: 4 },
    state: { status: "error", input: { path: "missing.txt" }, error: { type: "NotFound", message: "File missing" } } }]
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child" }), signal())
  expect(result.execution.active).toBe(true)
  expect(result.execution.lastOutcome).toBe("succeeded")
  if (!("items" in result)) throw new Error("Expected snapshot")
  expect(JSON.stringify(result.items)).toContain("File missing")
})

test("inactive sessions retain an interrupted outcome without reporting completion", async () => {
  const f = fixture()
  f.state.active = false
  f.state.sessions = [{ ...session(), outcome: "interrupted" }]
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child" }), signal())
  expect(result.execution).toEqual({ active: false, lastOutcome: "interrupted", lastIdleAt: 2 })
  expect(result.activity.phase).toBe("inactive")
})

test("refreshes updates inside an existing assistant message", async () => {
  const f = fixture()
  const input = InspectInput.parse({ sessionID: "child" })
  expect((await inspectSubagent(f.client, "parent", input, signal())).activity.phase).toBe("tool_running")
  const message = f.state.messages[0]
  if (message?.type !== "assistant") throw new Error("Missing assistant fixture")
  message.content = [{ type: "tool", id: "call", name: "read", time: { created: 3, completed: 4 },
    state: { status: "completed", input: { path: "README.md" }, content: [{ type: "text", text: "Read finished" }] } }]
  const result = await inspectSubagent(f.client, "parent", input, signal())
  expect(JSON.stringify(result)).toContain("Read finished")
  expect(result.activity.phase).not.toBe("tool_running")
})

test("permission waits are limited to the inspected child", async () => {
  const f = fixture()
  f.state.permissions.push(
    { id: "mine", sessionID: "child", action: "read", resources: [".env"] },
    { id: "other", sessionID: "unrelated", action: "shell", resources: ["command"] },
  )
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child" }), signal())
  expect(result.activity.phase).toBe("waiting_permission")
  expect(result.activity.pendingPermissions.map((request) => request.id)).toEqual(["mine"])
})

test("ownership rejection happens before reading a child's contents", async () => {
  const f = fixture()
  f.state.sessions = [session("child", "someone-else")]
  await expect(inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child" }), signal())).rejects.toThrow("direct")
  expect(f.state.requests.map((request) => request.url.pathname)).toEqual(["/api/session/child"])
})

test("finite log replay continues from the last returned event without gaps", async () => {
  const f = fixture()
  const first = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", view: "changes", limit: 1 }), signal())
  if (!("nextAfterSeq" in first)) throw new Error("Expected changes result")
  expect(first.nextAfterSeq).toBe(1)
  expect(first.synced).toBe(false)
  const next = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", view: "changes", afterSeq: first.nextAfterSeq }), signal())
  if (!("nextAfterSeq" in next)) throw new Error("Expected changes result")
  expect(next.items.map((item) => "seq" in item ? item.seq : undefined)).toEqual([2])
  expect(next.synced).toBe(true)
  expect(f.state.requests.filter((request) => request.url.pathname.endsWith("/log")).every((request) => request.url.searchParams.get("follow") === "false")).toBe(true)
})

test("oversized events are explicitly truncated and preserve their sequence", async () => {
  const f = fixture()
  f.state.events = [textEvent(1, "x".repeat(10000)), textEvent(2)]
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", view: "changes", maxChars: 256 }), signal())
  expect(result.truncated).toBe(true)
  if (!("nextAfterSeq" in result)) throw new Error("Expected changes result")
  expect(result.nextAfterSeq).toBe(1)
  expect(result.items[0]?.truncated).toBe(true)
})

test("a cursor beyond available history requests an explicit reset", async () => {
  const f = fixture()
  await expect(inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", view: "changes", afterSeq: 100 }), signal())).rejects.toThrow("cursor")
})

test("a host with sequence markers but no event bodies returns an explicit snapshot fallback", async () => {
  const f = fixture()
  f.state.omitLogEvents = true
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", view: "changes" }), signal())
  if (!("nextAfterSeq" in result)) throw new Error("Expected changes result")
  expect(result.nextAfterSeq).toBe(2)
  expect(result.historyUnavailable).toBe(true)
  expect(result.items).toEqual([])
  expect(JSON.stringify(result.snapshot)).toContain("README.md")
})

test("fallback snapshots are fetched after the log boundary they acknowledge", async () => {
  const f = fixture()
  f.state.omitLogEvents = true
  f.state.onLog = () => {
    f.state.messages = [{ id: "fresh", type: "system", time: { created: 4 }, text: "Newly projected update" }]
  }
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", view: "changes" }), signal())
  expect(JSON.stringify(result.snapshot)).toContain("Newly projected update")
  const paths = f.state.requests.map((request) => request.url.pathname)
  expect(paths.indexOf("/api/experimental/session/child/log")).toBeLessThan(paths.indexOf("/api/session/child/message"))
})

test("durable content replacements retain tools and reasoning without exposing provider checkpoints", async () => {
  const f = fixture()
  f.state.events = [{
    id: "evt-1", type: "session.message.content.updated", created: 1,
    durable: { aggregateID: "child", seq: 1, version: 1 },
    data: { sessionID: "child", messageID: "msg", content: [
      { type: "reasoning", text: "Replaced reasoning", state: { encrypted: "hidden-checkpoint" } },
      { type: "tool", id: "replacement-call", name: "read", time: { created: 1 },
        providerState: { encrypted: "hidden-checkpoint" },
        state: { status: "completed", input: { path: "README.md" }, content: [{ type: "text", text: "Replacement result" }] } },
    ] },
  }]
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", view: "changes" }), signal())
  expect(JSON.stringify(result)).toContain("Replaced reasoning")
  expect(JSON.stringify(result)).toContain("Replacement result")
  expect(JSON.stringify(result)).not.toContain("hidden-checkpoint")
})

test("incompatible pagination and detail arguments are rejected at the schema boundary", () => {
  expect(InspectInput.safeParse({ sessionID: "child", view: "changes", cursor: "older" }).success).toBe(false)
  expect(InspectInput.safeParse({ sessionID: "child", messageID: "msg", cursor: "older" }).success).toBe(false)
  expect(InspectInput.safeParse({ sessionID: "child", offset: 2 }).success).toBe(false)
  expect(InspectInput.safeParse({ sessionID: "child", messageID: "msg", offset: 2 }).success).toBe(false)
})

test("caller cancellation reaches the SDK", async () => {
  const f = fixture()
  await expect(inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child" }), AbortSignal.abort())).rejects.toThrow()
})

test("prompt adaptation only changes delegation guidance and preserves other schema fields", () => {
  const event = { tools: {
    inspect_subagent: { description: "Inspect", input: {} },
    subagent: { description: "Delegate", input: {
      type: "object", properties: { background: { type: "boolean", description: "DO NOT poll" }, prompt: { type: "string" } },
    } },
  } }
  adaptContext(event)
  expect(JSON.stringify(event.tools.subagent)).toContain("read progress")
  expect(JSON.stringify(event.tools.subagent)).not.toContain("DO NOT poll")
  expect(event.tools.subagent.input.properties.prompt).toEqual({ type: "string" })
  const original = "The subagent is working in the background (sessionID: child). You will be notified automatically when it finishes.\nDO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using."
  expect(backgroundText(original)).toContain("inspect_subagent")
  expect(backgroundText(original)).toContain("sessionID: child")
  expect(backgroundText("Unrelated text")).toBe("Unrelated text")
})
