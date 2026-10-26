import { Option, Schema } from "effect"
import { createMemo, For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"

const decodeToolInput = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

const isString = Schema.is(Schema.String)

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.action}.description`
    // SAFETY: an action without a curated description returns the key itself, which the check below detects.
    const value = language.t(key as Parameters<typeof language.t>[0])

    if (value === key) return ""

    return value
  }

  const input = () =>
    Option.match(decodeToolInput(props.request.metadata?.input), {
      onNone: () => [],
      onSome: (value) =>
        Object.entries(value).map(([key, item]) => `${key}: ${isString(item) ? item : JSON.stringify(item)}`),
    })

  const decodedInputs = createMemo(() => decodeBase64Fields(props.request.metadata?.input, ""))

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Show when={props.request.save?.length}>
              <Button
                variant="neutral"
                size="normal"
                onClick={() => props.onDecide("always")}
                disabled={props.responding}
              >
                {language.t("ui.permission.allowAlways")}
              </Button>
            </Show>
            <Button variant="submit" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="permission-row" class="select-text">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <Show when={toolDescription()} fallback={<code data-slot="permission-action">{props.request.action}</code>}>
          <div data-slot="permission-hint">{toolDescription()}</div>
        </Show>
      </div>

      <Show when={props.request.message}>
        {(message) => (
          <div data-slot="permission-row" class="select-text">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint">{message()}</div>
          </div>
        )}
      </Show>

      <Show when={input().length > 0}>
        <div data-slot="permission-row" class="select-text">
          <span data-slot="permission-spacer" aria-hidden="true" />
          {/* Scrolls rather than truncates: the user approves these arguments, so all of them must be reachable */}
          <div data-slot="permission-input" data-scrollable>
            <For each={input()}>{(line) => <code class="text-text-weak break-all">{line}</code>}</For>
          </div>
        </div>
      </Show>

      <Show when={props.request.resources.length > 0}>
        <div data-slot="permission-row" class="select-text">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.resources}>
              {(pattern) => <code class="text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>

      <For each={decodedInputs()}>
        {(field) => (
          <div data-slot="permission-row" class="select-text">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div class="min-w-0 flex flex-col gap-1 mb-2">
              <div class="text-12-medium text-text-weak">{language.t("ui.permission.decoded", { key: field.key })}</div>
              <pre
                data-slot="permission-decoded"
                class="text-12-regular text-text-base min-w-0 max-h-52 overflow-auto whitespace-pre-wrap break-all border-s-2 border-v2-border-border-strong ps-3"
              >
                {field.preview}
              </pre>
            </div>
          </div>
        )}
      </For>
    </DockPrompt>
  )
}

function decodeBase64Fields(value: unknown, key: string): { key: string; preview: string }[] {
  if (Array.isArray(value)) return value.flatMap((item) => decodeBase64Fields(item, key))
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([name, item]) => decodeBase64Fields(item, name))
  if (typeof value !== "string" || !/base64/i.test(key)) return []
  const text = decodeUtf8Base64(value)
  if (!text) return []
  return [{ key, preview: text.replace(/\r?\n$/, "").replace(/\r\n/g, "\n") }]
}

function decodeUtf8Base64(value: string) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
    )
    if (text.includes("\0")) return
    return text
  } catch {
    return
  }
}
