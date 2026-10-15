import { useDialog } from "@opencode/ui/context/dialog"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useLanguage } from "@/runtime/i18n/language"

export function ReplaceDraftDialog(props: { onReplace: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  let replace = false

  return (
    <Dialog
      fit
      onCloseAutoFocus={(event) => {
        if (!replace) return
        // Installing after close keeps the dialog from returning focus to the next-step button.
        event.preventDefault()
        props.onReplace()
      }}
    >
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("session.nextSteps.replace.title")}
          description={language.t("session.nextSteps.replace.description")}
        />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={() => dialog.close()}>
          {language.t("session.nextSteps.replace.keep")}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            replace = true
            dialog.close()
          }}
        >
          {language.t("session.nextSteps.replace.replace")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
