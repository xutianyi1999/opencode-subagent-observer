import { OpenCode } from "@opencode/client"
import type { OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { z } from "zod"
import type { Options } from "./schema.ts"

export async function connect(
  options: z.infer<typeof Options>,
): Promise<OpenCodeClient> {
  if (options.baseUrl) return OpenCode.make({ baseUrl: options.baseUrl, headers: options.headers })
  const endpoint = await Service.discover()
  if (!endpoint) throw new Error("No healthy running OpenCode service found. Configure baseUrl explicitly.")
  return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
}

export async function verifyCaller(
  client: OpenCodeClient,
  ctx: Context,
  sessionID: string,
  signal: AbortSignal,
) {
  const [host, remote] = await Promise.all([
    ctx.session.get({ sessionID }, { signal }),
    client.session.get({ sessionID }, { signal }),
  ])
  if (
    host.id !== remote.id || host.projectID !== remote.projectID ||
    host.time.created !== remote.time.created || host.location.directory !== remote.location.directory
  ) throw new Error("Observer is connected to a different OpenCode server. Check baseUrl.")
}
