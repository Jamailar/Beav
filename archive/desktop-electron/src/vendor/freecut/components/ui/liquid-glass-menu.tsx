"use client"

import * as React from "react"
import { GlassCard } from "@developer-hub/liquid-glass"

import { cn } from "@/shared/ui/cn"

function readShadowMode() {
  if (typeof document === "undefined") return false
  return document.documentElement.getAttribute("data-theme") !== "dark"
}

function useLiquidGlassShadowMode() {
  const [shadowMode, setShadowMode] = React.useState(readShadowMode)

  React.useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const sync = () => setShadowMode(readShadowMode())
    sync()

    const observer = new MutationObserver(sync)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    })

    return () => observer.disconnect()
  }, [])

  return shadowMode
}

function createSurfaceStyle(shadowMode: boolean): React.CSSProperties {
  if (shadowMode) {
    return {
      background:
        "linear-gradient(180deg, rgba(255,252,246,0.82) 0%, rgba(255,244,224,0.74) 52%, rgba(255,223,168,0.66) 100%)",
      border: "1px solid rgba(255,255,255,0.84)",
      boxShadow:
        "0 18px 44px rgba(92, 71, 35, 0.18), 0 4px 18px rgba(255, 196, 88, 0.14), inset 0 1px 0 rgba(255,255,255,0.88)",
    }
  }

  return {
    background:
      "linear-gradient(180deg, rgba(31,35,43,0.3) 0%, rgba(15,18,24,0.24) 52%, rgba(12,14,18,0.32) 100%)",
    border: "1px solid rgba(255,255,255,0.22)",
    boxShadow:
      "0 24px 72px rgba(0, 0, 0, 0.3), 0 6px 26px rgba(116, 180, 255, 0.1), inset 0 1px 0 rgba(255,255,255,0.14)",
  }
}

export const liquidGlassMenuLabelClassName =
  "px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-tertiary dark:text-white/45"

export const liquidGlassMenuSeparatorClassName =
  "my-1 h-px rounded-full bg-gradient-to-r from-transparent via-black/12 to-transparent dark:via-white/12"

export function getLiquidGlassMenuItemClassName(options?: {
  destructive?: boolean
  inset?: boolean
  className?: string
}) {
  const { destructive = false, inset = false, className } = options ?? {}

  return cn(
    "relative flex min-h-[36px] w-full cursor-default select-none items-center gap-2 rounded-[8px] px-3 py-2 text-left text-sm font-medium outline-none transition-[background-color,color,box-shadow,opacity,transform] duration-150",
    "disabled:pointer-events-none disabled:opacity-45 data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
    destructive
      ? "text-rose-600 hover:bg-white/34 hover:text-rose-700 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.42),0_8px_22px_rgba(255,184,76,0.12)] focus-visible:bg-white/34 data-[highlighted]:bg-white/34 dark:text-rose-300 dark:hover:bg-white/[0.14] dark:hover:text-rose-100 dark:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_8px_24px_rgba(72,149,255,0.16)] dark:focus-visible:bg-white/[0.14] dark:data-[highlighted]:bg-white/[0.14]"
      : "text-text-primary hover:bg-white/34 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.42),0_8px_22px_rgba(255,184,76,0.12)] focus-visible:bg-white/34 data-[highlighted]:bg-white/34 dark:text-white/85 dark:hover:bg-white/[0.14] dark:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_8px_24px_rgba(72,149,255,0.16)] dark:focus-visible:bg-white/[0.14] dark:data-[highlighted]:bg-white/[0.14]",
    inset && "pl-8",
    className
  )
}

export const LiquidGlassSurface = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, style, children, ...props }, ref) => {
  const shadowMode = useLiquidGlassShadowMode()

  return (
    <div
      ref={ref}
      className={cn("inline-block align-top", className)}
      style={style}
      {...props}
    >
      <GlassCard
        className="inline-block align-top"
        cornerRadius={12}
        displacementScale={shadowMode ? 56 : 82}
        blurAmount={shadowMode ? 0.22 : 0.12}
        padding="0px"
        shadowMode={shadowMode}
        style={createSurfaceStyle(shadowMode)}
      >
        <div className="relative inline-block min-w-full overflow-hidden rounded-[12px]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-[12px]"
            style={{
              background: shadowMode
                ? "linear-gradient(180deg, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0.24) 34%, rgba(255,196,84,0.16) 100%)"
                : "linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.08) 34%, rgba(100,170,255,0.1) 100%)",
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-[8%] top-0 h-[44%] rounded-full blur-xl"
            style={{
              background: shadowMode
                ? "radial-gradient(circle at 50% 0%, rgba(255,255,255,0.72), rgba(255,255,255,0) 72%)"
                : "radial-gradient(circle at 50% 0%, rgba(255,255,255,0.22), rgba(255,255,255,0) 72%)",
            }}
          />
          <div className="relative inline-block min-w-full rounded-[12px]">
            {children}
          </div>
        </div>
      </GlassCard>
    </div>
  )
})
LiquidGlassSurface.displayName = "LiquidGlassSurface"

export const LiquidGlassMenuPanel = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    surfaceClassName?: string
    innerClassName?: string
  }
>(({ className, surfaceClassName, innerClassName, children, ...props }, ref) => (
  <div ref={ref} className={cn("inline-block align-top", className)} {...props}>
    <LiquidGlassSurface className={cn("min-w-full", surfaceClassName)}>
      <div
        className={cn(
          "max-h-[min(24rem,calc(100vh-24px))] overflow-y-auto overflow-x-hidden p-1.5",
          innerClassName
        )}
      >
        {children}
      </div>
    </LiquidGlassSurface>
  </div>
))
LiquidGlassMenuPanel.displayName = "LiquidGlassMenuPanel"

export function LiquidGlassMenuSeparator({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(liquidGlassMenuSeparatorClassName, className)} {...props} />
}
