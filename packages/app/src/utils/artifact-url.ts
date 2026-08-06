import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

// artifact urls arrive from the server as origin-relative paths. A plain anchor cannot
// carry the SDK client's base url or Authorization header, so resolve both here: the
// auth_token query parameter is what the server accepts for browser-initiated requests.
export function artifactUrl(server: ServerConnection.HttpBase, url: string) {
  const next = new URL(url, server.url)
  if (server.password)
    next.searchParams.set(
      "auth_token",
      authTokenFromCredentials({ username: server.username, password: server.password }),
    )
  return next.toString()
}
