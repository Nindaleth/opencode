import type { SessionMessageAssistantArtifact } from "@opencode/client/promise"
import { useI18n } from "@opencode/ui/context/i18n"
import { Show } from "solid-js"
import { useData } from "../context"

export function artifactPresentation(
  content: SessionMessageAssistantArtifact,
  sessionID: string | undefined,
  messageID: string,
  href?: (sessionID: string, messageID: string, key: string) => string | undefined,
) {
  const bytes = content.size
  const size =
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return { name: content.name, size, href: sessionID ? href?.(sessionID, messageID, content.key) : undefined }
}

export function ArtifactContent(props: { messageID: string; content: SessionMessageAssistantArtifact }) {
  const data = useData()
  const i18n = useI18n()
  const presentation = () => artifactPresentation(props.content, data.sessionID, props.messageID, data.artifactHref)
  return (
    <div class="flex items-center gap-3 rounded-md border border-border-base px-3 py-2 text-13 leading-[var(--line-height-compact)]">
      <div class="min-w-0 flex-1">
        <div class="truncate">{presentation().name}</div>
        <div class="text-text-weak">{presentation().size}</div>
      </div>
      <Show when={presentation().href}>
        {(url) => (
          <a href={url()} download={props.content.name} aria-label={i18n.t("ui.message.artifact.download")}>
            {i18n.t("ui.message.artifact.download")}
          </a>
        )}
      </Show>
    </div>
  )
}
