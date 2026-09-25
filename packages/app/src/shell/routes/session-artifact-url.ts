import { authTokenFromCredentials } from "@/runtime/server/api"

export function sessionArtifactUrl(input: {
  url: string
  password?: string
  sessionID: string
  messageID: string
  key: string
}) {
  const url = new URL(
    `api/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}/artifact/${encodeURIComponent(input.key)}`,
    `${input.url.replace(/\/+$/, "")}/`,
  )
  if (input.password) url.searchParams.set("auth_token", authTokenFromCredentials({ password: input.password }))
  return url.href
}
