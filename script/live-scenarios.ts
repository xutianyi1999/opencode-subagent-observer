import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import type { z } from "zod"
import type { snapshot } from "../src/messages.ts"
import { connect } from "../src/client.ts"
import { inspectSubagent, listSubagents } from "../src/observe.ts"
import { InspectInput, ListInput, Options } from "../src/schema.ts"

type Preview = ReturnType<typeof snapshot>["messages"][number]
type PreviewPart = Extract<Preview, { content: unknown }>["content"][number]

const client = await connect(Options.parse({}))
const directory = await mkdtemp(join(tmpdir(), "opencode-observer-scenarios-"))
await Bun.write(join(directory, "README.md"), "# Test project\nRead-only observation fixture.\n")
const longText = Array.from({ length: 180 }, (_, index) => `${index}: 中文🙂 tool result, preserve every exposed character.\n`).join("")
await Bun.write(join(directory, "long.txt"), longText)
const entrypoint = resolve(`.test-artifacts/scenarios-plugin-${crypto.randomUUID()}.js`)
await Bun.write(entrypoint, Bun.file("dist/index.js"))
await Bun.write(join(directory, ".opencode/plugins/observer/index.ts"), `export { default } from ${JSON.stringify(entrypoint)}\n`)
const models = await client.model.list({ location: { directory } })
const model = models.data.find((entry) => entry.providerID === "opencode" && entry.id === (process.env.OBSERVER_TEST_MODEL ?? "mimo-v2.6-flash-free"))
assert(model && model.cost.every((tier) => tier.input === 0 && tier.output === 0), "Requires an available zero-cost model")
const modelRef = { providerID: model.providerID, id: model.id }
const parent = await client.session.create({ location: { directory }, title: "Observer scenario test", model: modelRef })
const definitions = [
  { name: "reader", task: "First read the complete long.txt file in this directory. Then run shell command printf 'reader-complete\\n'. Summarize the file in one sentence. Do not modify files." },
  { name: "tool-error", task: "First call the read tool on definitely-missing-observer.txt in this directory; this file intentionally does not exist. After its error, read README.md and report the failure and recovery in one sentence. Do not create files or search for alternatives." },
  { name: "interrupt", task: "First run shell command sleep 60. After it exits, say finished. Do not modify files." },
  { name: "permission", task: "Run shell command printf 'permission-checked\\n'. After it exits, say finished. Do not modify files." },
]
const children = []
for (const definition of definitions) {
  const session = await client.session.create({
    location: { directory }, parentID: parent.id, title: definition.name, agent: "general", model: modelRef,
    ...(definition.name === "permission" ? { permissions: [{ action: "shell", resource: "*", effect: "ask" as const }] } : {}),
  })
  children.push({ ...definition, session })
}
console.log(JSON.stringify({ phase: "started", parentID: parent.id, directory, model: modelRef, children: children.map((child) => ({ name: child.name, id: child.session.id })) }))
const signal = () => AbortSignal.timeout(15000)
const inspect = (sessionID: string, input: Omit<z.input<typeof InspectInput>, "sessionID"> = {}) =>
  inspectSubagent(client, parent.id, InspectInput.parse({ sessionID, ...input }), signal())
const idle = await inspect(children[0]!.session.id)
assert.equal(idle.execution.active, false)
assert.equal(idle.execution.lastOutcome, null)
await Promise.all(children.map((child) => client.session.prompt({ sessionID: child.session.id, text: child.task })))
const phases = new Set<string>()
const statuses = new Map<string, Set<string>>()
let interrupted = false
let permissionObserved = false
let revisionChanged = false
const deadline = Date.now() + 240000
try {
  while (true) {
    const views: Awaited<ReturnType<typeof inspect>>[] = await Promise.all(children.map((child) => inspect(child.session.id, { limit: 100, maxChars: 256 })))
    for (const [index, view] of views.entries()) {
      const child = children[index]!
      phases.add(view.activity.phase)
      assert("messages" in view)
      for (const message of view.messages) {
        if (!("content" in message)) continue
        for (const part of message.content) {
          if (part.type !== "tool" || !("id" in part)) continue
          const key = `${child.session.id}/${part.id}`
          const seen = statuses.get(key) ?? new Set<string>()
          seen.add(part.status)
          statuses.set(key, seen)
          if (child.name === "interrupt" && part.name === "shell" && part.status === "running" && !interrupted) {
            const before = await inspect(child.session.id, { messageID: message.id, maxChars: 256 })
            assert("text" in before && before.nextOffset !== null)
            await client.session.interrupt({ sessionID: child.session.id })
            await client.session.wait({ sessionID: child.session.id }, { signal: signal() })
            await assert.rejects(inspect(child.session.id, {
              messageID: message.id, offset: before.nextOffset, revision: before.revision, maxChars: 256,
            }), /Message changed/)
            interrupted = true
            revisionChanged = true
          }
        }

      }
      if (child.name === "permission" && view.activity.pendingPermissions.length) {
        assert.equal(view.activity.phase, "waiting_permission")
        permissionObserved = true
        for (const request of view.activity.pendingPermissions) {
          await client.permission.reply({ sessionID: child.session.id, requestID: request.id, decision: "once" })
        }
      }
    }
    if (views.every((view) => !view.execution.active && view.execution.lastOutcome !== null)) break
    assert(Date.now() < deadline, "Scenario timeout")
    await Bun.sleep(1000)
  }
} finally {
  // Only stop sessions created by this run, including a child blocked on a failed assertion.
  const active = await client.session.active()
  for (const child of children) {
    if (active[child.session.id]) await client.session.interrupt({ sessionID: child.session.id })
  }
}
assert(interrupted && revisionChanged, "Did not verify interruption and a changed message revision")
assert(permissionObserved, "Did not observe an actual permission wait")
const listed: string[] = []
let listCursor: string | undefined
for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
  const page = await listSubagents(client, parent.id, ListInput.parse({ limit: 1, cursor: listCursor }), signal())
  listed.push(...page.subagents.map((entry) => entry.sessionID))
  listCursor = page.cursor
  if (!listCursor) break
}
assert.equal(listCursor, undefined, "Child pagination did not terminate")
assert.deepEqual([...listed].sort(), children.map((child) => child.session.id).sort())
const reports = []
for (const child of children) {
  const beforeSession = await client.session.get({ sessionID: child.session.id })
  const raw = await client.message.list({ sessionID: child.session.id, order: "desc", limit: 100 })
  assert(raw.data.length < 100, "Fixture exceeds raw comparison page")
  const preview = await inspect(child.session.id, { limit: 100, maxChars: 256 })
  assert("messages" in preview)
  for (const [index, message] of raw.data.entries()) {
    const visible: Preview = preview.messages[index]!
    assert.equal(visible.id, message.id)
    if (message.type !== "assistant") continue
    assert("content" in visible)
    assert.equal(visible.content.length, message.content.length)
    for (const [partIndex, part] of message.content.entries()) {
      const actual: PreviewPart = visible.content[partIndex]!
      assert.equal(actual.type, part.type)
      if (part.type !== "tool") continue
      assert("id" in actual)
      assert.equal(actual.id, part.id)
      assert.equal(actual.name, part.name)
      assert.equal(actual.status, part.state.status)
    }
  }
  const ids: string[] = []
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await inspect(child.session.id, { limit: 1, cursor, maxChars: 256 })
    assert("messages" in page)
    ids.push(...page.messages.map((message) => message.id))
    cursor = page.cursor
    if (!cursor) break
  }
  assert.equal(cursor, undefined, "Message pagination did not terminate")
  assert.deepEqual(ids, raw.data.map((message) => message.id), "History omitted or duplicated messages")
  let chunks = 0
  for (const message of raw.data) {
    const text: string[] = []
    let offset = 0
    let revision: string | undefined
    while (true) {
      const detail = await inspect(child.session.id, { messageID: message.id, offset, revision, maxChars: 256 })
      assert("text" in detail)
      assert(detail.text.length <= 256)
      text.push(detail.text)
      chunks++
      if (detail.nextOffset === null) break
      offset = detail.nextOffset
      revision = detail.revision
    }
    const recovered = JSON.parse(text.join("")) as SessionMessageInfo
    assert.equal(recovered.id, message.id)
    if (message.type === "assistant") {
      assert.equal(recovered.type, "assistant")
      if (recovered.type !== "assistant") throw new Error("Missing assistant detail")
      assert.equal(recovered.content.length, message.content.length)
      for (const [index, part] of message.content.entries()) {
        const actual: SessionMessageAssistant["content"][number] = recovered.content[index]!
        assert.equal(actual.type, part.type)
        if (part.type === "tool") {
          assert.equal(actual.type, "tool")
          if (actual.type !== "tool") throw new Error("Missing tool detail")
          assert.deepEqual(actual.state, part.state, "Tool arguments/results were changed or omitted")
          assert.equal(actual.id, part.id)
          assert.equal(actual.name, part.name)
        }
        if (part.type !== "tool") {
          assert(actual.type !== "tool")
          assert.equal(actual.text, part.text, "Text or visible reasoning was changed or omitted")
        }
      }
      assert.deepEqual(recovered.error, message.error)
    }
    if (message.type === "user") {
      assert.equal(recovered.type, "user")
      if (recovered.type === "user") assert.equal(recovered.text, message.text)
    }
  }
  const after = await client.message.list({ sessionID: child.session.id, order: "desc", limit: 100 })
  const afterSession = await client.session.get({ sessionID: child.session.id })
  assert.deepEqual(after, raw, "Read-only observation changed child history")
  assert.deepEqual(afterSession, beforeSession, "Read-only observation changed child metadata")
  assert.equal(afterSession.cost, 0)
  const tools = raw.data.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [])
  if (child.name === "tool-error") assert(tools.some((part) => part.state.status === "error"), "No actual tool failure")
  if (child.name === "interrupt") assert.equal(afterSession.outcome, "interrupted")
  reports.push({ name: child.name, sessionID: child.session.id, outcome: afterSession.outcome, cost: afterSession.cost,
    messages: ids.length, chunks, reasoningParts: raw.data.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "reasoning") : []).length,
    tools: tools.map((part) => ({ name: part.name, status: part.state.status })), unchanged: true })
}
const foreign = await client.session.create({ location: { directory }, title: "Unrelated test session", model: modelRef })
await assert.rejects(inspect(foreign.id), /direct/)
await assert.rejects(inspect(parent.id), /direct/)
const fork = await client.session.fork({ sessionID: children[0]!.session.id })
await assert.rejects(inspectSubagent(client, children[0]!.session.id, InspectInput.parse({ sessionID: fork.id }), signal()), /direct/)
const forkList = await listSubagents(client, children[0]!.session.id, ListInput.parse({}), signal())
assert(!forkList.subagents.some((entry) => entry.sessionID === fork.id))
// Cross-session cursors must not expose any messages from the other session.
const otherPage = await client.message.list({ sessionID: children[1]!.session.id, order: "desc", limit: 1 })
if (otherPage.cursor.next) {
  const page = await inspect(children[0]!.session.id, { cursor: otherPage.cursor.next, limit: 100 })
  assert("messages" in page)
  const own = await client.message.list({ sessionID: children[0]!.session.id, order: "desc", limit: 100 })
  assert(page.messages.every((message) => own.data.some((entry) => entry.id === message.id)), "Foreign cursor leaked another session")
}
const report = { parentID: parent.id, directory, model: modelRef, interrupted, permissionObserved, revisionChanged,
  phases: [...phases], toolTransitions: [...statuses].map(([id, states]) => ({ id, states: [...states] })), children: reports }
await Bun.write(`.test-artifacts/scenarios-${model.id}.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ phase: "passed", ...report }))
