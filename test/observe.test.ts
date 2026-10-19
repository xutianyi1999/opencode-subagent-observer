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
    events: [textEvent(1), textEvent(2)] as SessionLogItem[],
    omitLogEvents: false,
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
      if (url.pathname.endsWith("/message")) return Response.json({ data: state.messages, cursor: {} })
      if (url.pathname.endsWith("/log")) {
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
  expect(JSON.stringify(result)).not.toContain("Visible reasoning")
  expect(f.state.requests.every((request) => request.method === "GET")).toBe(true)
})

test("reasoning is opt-in and provider state is omitted", async () => {
  const f = fixture()
  const result = await inspectSubagent(f.client, "parent", InspectInput.parse({ sessionID: "child", include: ["reasoning"] }), signal())
  expect(JSON.stringify(result)).toContain("Visible reasoning")
  expect(JSON.stringify(result)).not.toContain("do not expose")
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
