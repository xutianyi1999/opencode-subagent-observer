import { OpenCode } from "@opencode/client"
import type { OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/service"
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

