"use client";

import { useEffect } from "react";

function isTextInput(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT";
}

/** Sets `--app-height`, the app shell's structural height, only in real
 *  iOS standalone-PWA use — a no-op everywhere else (desktop, a regular
 *  Safari tab), where plain `dvh` already behaves correctly and this
 *  hook doesn't touch anything.
 *
 *  Why this exists (2026-08-07, parte 27): on-device measurements taken
 *  minutes apart, no keyboard involved, showed `window.innerHeight`
 *  (which `dvh` tracks) flip between 932 and 873 on the *same* device —
 *  proof that no static CSS formula built from `dvh` can be correct in
 *  both states, because the "correct" answer genuinely differs between
 *  them. `window.outerHeight`, across every real-device reading taken
 *  in this project's history, has been 932 every single time — the one
 *  stable signal available.
 *
 *  So: rest on `outerHeight` (stable) when nothing needs the keyboard,
 *  and switch to `visualViewport.height` (live, keyboard-aware — this
 *  part was never the problem, `dvh`'s own keyboard-shrink behavior,
 *  parte 14, already worked) the moment a text field is focused.
 *  Critically, *what triggers the switch* is the `focusin`/`focusout`
 *  event, not a threshold on the height number itself — inferring
 *  "is the keyboard open" from the height reading is exactly what
 *  doesn't work here, since that reading is the unreliable part.
 *  Earlier attempts at a JS-driven height (partes 13, 17) failed
 *  because they tried to correct or compensate *after* reading an
 *  ambiguous number; this one sidesteps the ambiguity instead.
 *
 *  The same focus tracking also drives two more properties, both only
 *  ever set to a plain value or left unset — never to something
 *  containing `env(...)` itself (round-tripping an `env()` token
 *  *through* a JS-assigned custom property didn't resolve reliably in
 *  real on-device testing, parte 32 — the whole calc() using it went
 *  invalid, a much larger regression than either of these were meant
 *  to fix):
 *
 *   - `--composer-safe-bottom` — the Inbox composer's own bottom
 *     padding (message-composer.tsx). iOS keeps reporting the resting
 *     `env(safe-area-inset-bottom)` even once the keyboard covers that
 *     area in standalone PWA mode (Safari tabs correctly zero it out;
 *     standalone doesn't) — this collapses it to `0px` while focused,
 *     `env(...)` itself staying as `var()`'s fallback in the CSS,
 *     never assigned through this property.
 *   - `--app-bg-override` — `html`/`body`'s background (globals.css).
 *     However close `--app-height` gets to the keyboard's real edge,
 *     getting it pixel-perfect on every iOS version isn't realistic
 *     (parte 33/34: chasing the exact remaining slop via
 *     `visualViewport.offsetTop` just moved the seam without closing
 *     it, and fighting the keyboard's own animation with a CSS
 *     `transition` on `--app-height` made the motion worse, not
 *     smoother — both reverted). Painting whatever sliver remains the
 *     *same* colour as the composer (`var(--card)`) instead of the
 *     page's own darker background is what actually reads as seamless
 *     regardless of how many pixels are left over. */
// ================= TEMPORARY DEBUG OVERLAY — REMOVE BEFORE SHIPPING =================
// On-screen live readout of every viewport/keyboard signal this hook
// touches, plus the composer's actual rendered position — added purely
// to diagnose the composer motion/gap bugs on a real iPhone, since no
// Mac is available for Safari's remote Web Inspector. Self-contained;
// delete this block and its two call sites below (debug?.log(...)) to
// remove entirely once the real fix is confirmed.
function createDebugOverlay() {
  const el = document.createElement("pre");
  el.id = "__kb_debug_overlay";
  Object.assign(el.style, {
    position: "fixed",
    top: "0",
    right: "0",
    zIndex: "999999",
    margin: "0",
    padding: "3px 5px",
    fontSize: "8px",
    lineHeight: "1.3",
    color: "#4ade80",
    background: "rgba(0,0,0,0.82)",
    width: "52vw",
    maxHeight: "16vh",
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  const lines: string[] = [];
  let start = performance.now();
  return {
    reset() {
      start = performance.now();
    },
    log(label: string) {
      const vv = window.visualViewport;
      const composerEl = document.querySelector<HTMLElement>("[data-composer-root]");
      const rect = composerEl?.getBoundingClientRect();
      const t = (performance.now() - start).toFixed(0).padStart(4, " ");
      lines.push(
        `t=${t} ${label.padEnd(9)} vvH=${vv?.height.toFixed(0)} appH=${document.documentElement.style.getPropertyValue("--app-height")} cB=${rect?.bottom.toFixed(0)} sY=${document.scrollingElement?.scrollTop}`,
      );
      if (lines.length > 20) lines.shift();
      el.textContent = lines.join("\n");
    },
  };
}
// ================= END TEMPORARY DEBUG OVERLAY =================

export function useAppHeight() {
  useEffect(() => {
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ?? false;
    if (!standalone) return;

    const root = document.documentElement;
    const debug = createDebugOverlay(); // TEMPORARY — see block above

    // Confirmed by the previous round's debug data (parte 35): iOS's own
    // "scroll the focused input into view" behavior briefly sets
    // `document.scrollingElement.scrollTop` to a large value (measured:
    // 354px) at the *exact same moment* the `visualViewport` resize
    // event fires — one frame before dashboard-shell.tsx's own reactive
    // `scroll`-event listener catches and reverts it. That single frame,
    // rendered with the composer's real position thrown off by the
    // stray scroll, is what read as a jarring jump. Resetting it here,
    // synchronously in the exact same handler that already reacts to
    // this event (rather than a separate listener reacting to a
    // *different* event after the fact), closes that gap as tightly as
    // is possible from JS.
    function resetScroll() {
      const scroller = document.scrollingElement;
      if (scroller && scroller.scrollTop !== 0) scroller.scrollTop = 0;
    }

    function setResting() {
      root.style.setProperty("--app-height", `${window.outerHeight}px`);
      // Removed (not set to the resting inset) so the composer's own
      // `var(--composer-safe-bottom, env(safe-area-inset-bottom))`
      // falls through to its fallback — see the doc comment above.
      root.style.removeProperty("--composer-safe-bottom");
      root.style.removeProperty("--app-bg-override");
      debug.log("resting");
    }

    function setLive(label = "resize") {
      resetScroll();
      const h = window.visualViewport?.height ?? window.innerHeight;
      root.style.setProperty("--app-height", `${h}px`);
      debug.log(label);
    }

    // Stable wrapper — `setLive` itself takes an optional label, so it
    // can't be handed to addEventListener directly (that would pass the
    // Event object as the label argument).
    function onVvResize() {
      setLive("resize");
    }

    function onFocusIn(e: FocusEvent) {
      if (!isTextInput(e.target)) return;
      debug.reset();
      resetScroll();
      debug.log("focusin");
      setLive("focusin-set");
      root.style.setProperty("--composer-safe-bottom", "0px");
      root.style.setProperty("--app-bg-override", "var(--card)");
      window.visualViewport?.addEventListener("resize", onVvResize);
    }

    function onFocusOut(e: FocusEvent) {
      if (!isTextInput(e.target)) return;
      debug.log("focusout");
      window.visualViewport?.removeEventListener("resize", onVvResize);
      // A focusout can be immediately followed by a focusin on the next
      // field (tabbing between inputs) — wait a tick so that case
      // doesn't flash back to the resting height mid-transition.
      setTimeout(() => {
        if (!isTextInput(document.activeElement)) {
          setResting();
        }
      }, 50);
    }

    setResting();
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("orientationchange", setResting);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("orientationchange", setResting);
      window.visualViewport?.removeEventListener("resize", onVvResize);
    };
  }, []);
}
