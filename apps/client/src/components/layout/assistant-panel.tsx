import { SparklesIcon, XIcon } from 'lucide-react'

import { Button } from '#/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '#/components/ui/sheet'
import { useIsMobile } from '#/hooks/use-mobile'
import { ASSISTANT_AVAILABLE, useLayoutStore } from '#/lib/layout-store'

const PANEL_ID = 'assistant-panel'

/** The header button that opens and closes the panel. */
export function AssistantToggle() {
  const open = useLayoutStore((s) => s.assistantOpen)
  const toggle = useLayoutStore((s) => s.toggleAssistant)
  if (!ASSISTANT_AVAILABLE) return null
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-pressed={open}
      aria-controls={PANEL_ID}
      title={open ? 'Close assistant' : 'Open assistant'}
      onClick={toggle}
    >
      <SparklesIcon />
      <span className="sr-only">
        {open ? 'Close assistant' : 'Open assistant'}
      </span>
    </Button>
  )
}

/**
 * The right-hand panel, beside the page (never on top of it) on wider
 * screens and a drawer on phones. Its content is a placeholder until the
 * assistant is built; the slot, sizing and open/close are what matter now.
 */
export function AssistantPanel() {
  const open = useLayoutStore((s) => s.assistantOpen)
  const setOpen = useLayoutStore((s) => s.setAssistantOpen)
  const isMobile = useIsMobile()
  if (!ASSISTANT_AVAILABLE) return null

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-sm">
          <SheetTitle className="sr-only">Assistant</SheetTitle>
          <SheetDescription className="sr-only">
            Ask about what is on this page.
          </SheetDescription>
          <PanelBody onClose={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    // The outer box animates its width; the inner one keeps a fixed width,
    // so the panel's content never reflows while it slides open or shut.
    <aside
      id={PANEL_ID}
      aria-label="Assistant"
      data-open={open}
      inert={!open}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
      className="hidden w-0 shrink-0 overflow-hidden opacity-0 transition-[width,margin,opacity] duration-200 ease-out motion-reduce:transition-none data-[open=true]:ml-2 data-[open=true]:w-(--assistant-width) data-[open=true]:opacity-100 md:block"
    >
      <div className="flex h-full w-(--assistant-width) flex-col overflow-hidden rounded-xl bg-background shadow-sm ring-1 ring-sidebar-border">
        <PanelBody onClose={() => setOpen(false)} />
      </div>
    </aside>
  )
}

function PanelBody({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <SparklesIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Assistant</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={onClose}
        >
          <XIcon />
          <span className="sr-only">Close assistant</span>
        </Button>
      </div>
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        The AI assistant arrives in a later step. This panel is where it will
        live.
      </div>
    </>
  )
}
