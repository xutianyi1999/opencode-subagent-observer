import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { connect } from "../src/client.ts"
import { inspectSubagent } from "../src/observe.ts"
import { InspectInput, Options } from "../src/schema.ts"

const client = await connect(Options.parse({}))
const directory = await mkdtemp(join(tmpdir(), "opencode-observer-test-"))
await Bun.write(join(directory, "README.md"), "# Fixture project\nA small fixture project used to validate read-only subagent observation.\n")
const entrypoint = resolve(`.test-artifacts/live-plugin-${crypto.randomUUID()}.js`)
await Bun.write(entrypoint, Bun.file("dist/index.js"))
await Bun.write(join(directory, ".opencode/plugins/observer/index.ts"),
  `export { default } from ${JSON.stringify(entrypoint)}\n`)

const models = await client.model.list({ location: { directory } })
const model = models.data.find((model) => model.providerID === "opencode" && model.id === (process.env.OBSERVER_TEST_MODEL ?? "mimo-v2.6-flash-free"))
if (!model || !model.cost.every((tier) => tier.input === 0 && tier.output === 0)) {
  throw new Error("Expected an available zero-cost test model; refusing a paid fallback")
}
const plugins = await client.plugin.list({ location: { directory } })
if (!plugins.data.some((plugin) => plugin.id === "subagent-observer" && plugin.state.status === "active")) {
  throw new Error("Observer plugin was not loaded")
}
const parent = await client.session.create({ location: { directory }, title: "Observer integration test", model: { providerID: model.providerID, id: model.id } })
console.log(JSON.stringify({ phase: "started", parentID: parent.id, directory, model: `${model.providerID}/${model.id}` }))
await client.session.prompt({ sessionID: parent.id, text: [
  "This is a tool integration test. Make no file changes. Follow these steps precisely:",
  "1. Call list_subagents.",
  "2. Launch exactly one general subagent with background=true. Its task: first run shell command sleep 12, then read README.md in this directory and summarize it briefly. Do not mention observation or monitoring to the child. Do not set a model; inherit yours.",
  "3. Call inspect_subagent with its sessionID and limit=1. Then pass the returned cursor to another query to read an older history page.",
  "4. Call inspect_subagent with sessionID, limit=100 and maxChars=256. In the messages array choose a type=user message and remember its id.",
  "5. Call inspect_subagent with that messageID and maxChars=256. If nextOffset is not null, call again with the same messageID, offset=nextOffset, revision from the first chunk, and maxChars=256.",
  "6. Refresh by calling inspect_subagent with just sessionID, then finish with a short report. Do not repeat completed work.",
  "Use the observer tools directly. Do not use shell, sleep, or other tools in the parent. Do not repeat the child's work.",
].join("\n") })

const deadline = Date.now() + 240000
while (true) {
  const active = await client.session.active()
  const current = await client.session.get({ sessionID: parent.id })
  if (!active[parent.id] && current.time.idle) break
  if (Date.now() >= deadline) {
    await client.session.interrupt({ sessionID: parent.id })
    throw new Error(`Live test timeout; parent ${parent.id}`)
  }
  await Bun.sleep(1000)
}
const messages = await client.message.list({ sessionID: parent.id, limit: 200, order: "asc" })
const calls = messages.data.flatMap((message) => message.type === "assistant"
  ? message.content.filter((part) => part.type === "tool") : [])
const observations = calls.filter((call) => ["list_subagents", "inspect_subagent"].includes(call.name))
console.log(JSON.stringify({ phase: "calls", calls: calls.map((call) => ({ name: call.name, status: call.state.status })) }))
if (!observations.some((call) => call.name === "list_subagents") || observations.filter((call) => call.name === "inspect_subagent").length < 3) {
  throw new Error("Parent did not exercise both observation tools")
}
if (observations.some((call) => call.state.status !== "completed")) throw new Error("An observation call failed")
const historyRead = observations.some((call) => call.state.status === "completed" && typeof call.state.input.cursor === "string")
const messageRead = observations.some((call) => call.state.status === "completed" && typeof call.state.input.messageID === "string")
const chunkRead = observations.some((call) => call.state.status === "completed" && typeof call.state.input.offset === "number" && call.state.input.offset > 0)
if (!historyRead || !messageRead || !chunkRead) throw new Error("Parent did not exercise history pagination and long-message continuation")
const children = await client.session.list({ parentID: parent.id })
const child = children.data.find((entry) => !entry.fork)
if (!child) throw new Error("No real child session created")
await client.session.wait({ sessionID: child.id }, { signal: AbortSignal.timeout(60000) })
const [before, beforeSession] = await Promise.all([
  client.message.list({ sessionID: child.id, limit: 200, order: "asc" }),
  client.session.get({ sessionID: child.id }),
])
await inspectSubagent(client, parent.id, InspectInput.parse({ sessionID: child.id }), AbortSignal.timeout(15000))
const originalPrompt = before.data.find((message) => message.type === "user")
if (!originalPrompt) throw new Error("Missing original child prompt")
await inspectSubagent(client, parent.id, InspectInput.parse({ sessionID: child.id, messageID: originalPrompt.id, maxChars: 256 }), AbortSignal.timeout(15000))
const [after, afterSession] = await Promise.all([
  client.message.list({ sessionID: child.id, limit: 200, order: "asc" }),
  client.session.get({ sessionID: child.id }),
])
if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(beforeSession) !== JSON.stringify(afterSession)) {
  throw new Error("Observation changed a settled child's messages or session metadata")
}
if (before.data.some((message) => message.type === "assistant" && message.content.some((part) =>
  part.type === "tool" && ["list_subagents", "inspect_subagent"].includes(part.name)))) {
  throw new Error("Child unexpectedly invoked an observation tool")
}
const queries = observations.flatMap((call) => call.state.status === "completed"
  ? call.state.content.filter((part) => part.type === "text").map((part) => JSON.parse(part.text) as Record<string, unknown>) : [])
const report = {
  parentID: parent.id, childID: child.id, directory, model: `${model.providerID}/${model.id}`,
  observations: observations.map((call) => ({ name: call.name, status: call.state.status })),
  childTools: before.data.flatMap((message) => message.type === "assistant"
    ? message.content.filter((part) => part.type === "tool").map((part) => part.name) : []),
  childMessagesUnchanged: true, childSessionUnchanged: true, queries,
  historyRead, messageRead, chunkRead,
}
await Bun.write(".test-artifacts/live-report.json", JSON.stringify(report, null, 2))
console.log(JSON.stringify({ phase: "passed", parentID: parent.id, childID: child.id, childMessagesUnchanged: true, childSessionUnchanged: true }))
