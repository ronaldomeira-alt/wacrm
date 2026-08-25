"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

// Two-thumb range slider — value/defaultValue is a [min, max] pair.
// Flat primary-color fill, no gradient (Contacts score filter spec).
function Slider({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("relative flex w-full touch-none select-none items-center", className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full items-center py-1.5">
        <SliderPrimitive.Track className="relative h-1.5 w-full grow rounded-full bg-muted">
          <SliderPrimitive.Indicator className="absolute h-full rounded-full bg-primary" />
          <SliderPrimitive.Thumb
            index={0}
            data-slot="slider-thumb"
            className="block size-3.5 rounded-full border-2 border-primary bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-50"
          />
          <SliderPrimitive.Thumb
            index={1}
            data-slot="slider-thumb"
            className="block size-3.5 rounded-full border-2 border-primary bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-50"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
