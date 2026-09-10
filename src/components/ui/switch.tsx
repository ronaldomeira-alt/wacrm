"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

// Root: primary token when checked (responds to the active color theme),
// slate when unchecked.
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border/60 transition-colors shadow-inner",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[checked]:bg-primary data-[checked]:border-primary data-[unchecked]:bg-zinc-700/90 dark:data-[unchecked]:bg-zinc-700/90 hover:data-[unchecked]:bg-zinc-600",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block h-3.5 w-3.5 rounded-full bg-white shadow-md ring-0 transition-transform",
          "data-[checked]:translate-x-4 data-[unchecked]:translate-x-0.5 data-[unchecked]:bg-zinc-200",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
