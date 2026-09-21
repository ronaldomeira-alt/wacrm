"use client";

import { useEffect } from "react";

function isTextInput(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return (
      type === "text" ||
      type === "search" ||
      type === "tel" ||
      type === "url" ||
      type === "email" ||
      type === "password" ||
      type === "number" ||
      !type
    );
  }
  return false;
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
export function useAppHeight() {
  useEffect(() => {
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ?? false;
    if (!standalone) return;

    const root = document.documentElement;

    // Tells the inbox thread (message-thread.tsx) that the shell's box just
    // changed, synchronously, so it can re-pin its scroll position in the
    // *same* frame — before paint — instead of polling a frame later.
    const notifyLayout = () => window.dispatchEvent(new Event("wacrm:app-height"));

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

    // Spring-driven `--app-height` follow for the keyboard's opening and
    // closing moves (setResting() itself stays a plain instant set — used
    // for init/orientation change and as the spring's landing state).
    //
    // A plain CSS `transition` on --app-height was tried here before
    // (parte 33/34, see doc comment above) and reverted for "fighting"
    // the keyboard. The real reason a transition can't work: iOS fires
    // `visualViewport`'s "resize" event several times over the course of
    // one keyboard opening, not once — each firing used to call
    // setProperty with a new value immediately, so a fixed-duration CSS
    // transition would restart from wherever it currently sat every
    // single time, producing a staircase of independently-timed
    // mini-transitions instead of one continuous motion — which is
    // exactly why the shell looked like it "jumped"/"got shoved" up
    // rather than being smoothly carried.
    //
    // A spring sidesteps this structurally instead of just re-tuning a
    // duration: it has one job every frame — keep closing the gap to
    // whatever `target` currently is — so a mid-flight retarget (the
    // next resize event) just bends the existing trajectory instead of
    // restarting a new animation. Semi-implicit Euler integration of a
    // damped harmonic oscillator (Hooke's law + linear drag), `dt`
    // measured via performance.now() rather than assumed, so it settles
    // in the same real time on a 60Hz and a 120Hz (ProMotion) iPhone
    // alike. Tuned to a damping ratio just under 1 (slightly
    // underdamped) — enough to read as "carried along" with a touch of
    // inertia, not so little that it visibly overshoots/bounces back.
    const SPRING_STIFFNESS = 210;
    const SPRING_DAMPING = 26;
    const SPRING_REST_EPSILON = 0.5;
    let springRaf: number | null = null;
    let springLastT: number | null = null;
    let springCurrent = window.outerHeight;
    let springVelocity = 0;
    let springTarget = window.outerHeight;

    // Keyboard-open app height (last live `visualViewport.height` seen while
    // a field was focused) and the device's resting bottom safe-area inset in
    // px. Together they let the composer's bottom padding be driven by the
    // spring's own progress instead of flipping in one step — see
    // applySafeBottom(). `null` until the first keyboard-open is observed.
    let keyboardH: number | null = null;
    let safeInset: number | null = null;
    // True while the spring is heading back to the resting height (keyboard
    // closing); settling there hands over to setResting() to clear the
    // overrides.
    let closing = false;

    function measureSafeInset(): number {
      if (safeInset === null) {
        // `env()` can't be read from JS directly (and must never be
        // round-tripped through a custom property — see the doc comment
        // above); resolving it through a throwaway element's padding is the
        // one reliable way to get the number.
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom)";
        document.body.appendChild(probe);
        safeInset = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
        probe.remove();
      }
      return safeInset;
    }

    // The composer's bottom safe-area padding is only "real" while the
    // keyboard is down, and must be 0 once the keyboard covers that area.
    // Flipping it in one step at focus/blur moved the composer — and the
    // pinned last bubble above it — by the whole inset (34px on current
    // iPhones) in a single frame, ahead of (open) or against (close) the
    // keyboard's own motion. Scaling it with the spring's progress between
    // "keyboard open" and "resting" makes it part of the same smooth move.
    function applySafeBottom() {
      if (keyboardH === null) return;
      const span = window.outerHeight - keyboardH;
      if (span < 1) return;
      const progress = Math.min(1, Math.max(0, (springCurrent - keyboardH) / span));
      root.style.setProperty("--composer-safe-bottom", `${measureSafeInset() * progress}px`);
    }

    function stopSpring() {
      if (springRaf !== null) {
        cancelAnimationFrame(springRaf);
        springRaf = null;
      }
      springLastT = null;
    }

    function springTick(t: number) {
      const dt = springLastT === null ? 1 / 60 : Math.min((t - springLastT) / 1000, 1 / 30);
      springLastT = t;

      const displacement = springCurrent - springTarget;
      const acceleration = -SPRING_STIFFNESS * displacement - SPRING_DAMPING * springVelocity;
      springVelocity += acceleration * dt;
      springCurrent += springVelocity * dt;

      if (
        Math.abs(springCurrent - springTarget) < SPRING_REST_EPSILON &&
        Math.abs(springVelocity) < SPRING_REST_EPSILON
      ) {
        springCurrent = springTarget;
        stopSpring();
        if (closing) {
          setResting();
          return;
        }
        root.style.setProperty("--app-height", `${springCurrent}px`);
        applySafeBottom();
        notifyLayout();
        return;
      }
      root.style.setProperty("--app-height", `${springCurrent}px`);
      applySafeBottom();
      notifyLayout();
      springRaf = requestAnimationFrame(springTick);
    }

    function springTo(h: number) {
      springTarget = h;
      if (springRaf === null) springRaf = requestAnimationFrame(springTick);
    }

    function setResting() {
      stopSpring();
      closing = false;
      springCurrent = window.outerHeight;
      springTarget = springCurrent;
      springVelocity = 0;
      root.style.setProperty("--app-height", `${springCurrent}px`);
      // Removed (not set to the resting inset) so the composer's own
      // `var(--composer-safe-bottom, env(safe-area-inset-bottom))`
      // falls through to its fallback — see the doc comment above.
      root.style.removeProperty("--composer-safe-bottom");
      root.style.removeProperty("--app-bg-override");
      notifyLayout();
    }

    function setLive() {
      resetScroll();
      const h = window.visualViewport?.height ?? window.innerHeight;
      closing = false;
      if (h < window.outerHeight - 1) keyboardH = h;
      springTo(h);
    }

    // Keyboard closing: follow it back down with the same spring instead of
    // snapping to the resting height in one frame, which teleported the
    // composer and the last bubble to the bottom of the screen — behind the
    // keyboard that was still sliding away.
    function closeKeyboard() {
      if (keyboardH === null || springCurrent >= window.outerHeight - 1) {
        setResting();
        return;
      }
      closing = true;
      springTo(window.outerHeight);
    }

    function onVvResize() {
      setLive();
    }

    function onFocusIn(e: FocusEvent) {
      if (!isTextInput(e.target)) return;
      setLive();
      root.style.setProperty("--app-bg-override", "var(--card)");
      notifyLayout();
      window.visualViewport?.addEventListener("resize", onVvResize);
    }

    function onFocusOut(e: FocusEvent) {
      if (!isTextInput(e.target)) return;
      window.visualViewport?.removeEventListener("resize", onVvResize);
      // A focusout can be immediately followed by a focusin on the next
      // field (tabbing between inputs) — wait a tick so that case
      // doesn't flash back to the resting height mid-transition.
      setTimeout(() => {
        if (!isTextInput(document.activeElement)) {
          closeKeyboard();
        }
      }, 50);
    }

    setResting();
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    const onOrientationChange = () => {
      keyboardH = null;
      safeInset = null;
      setResting();
    };
    window.addEventListener("orientationchange", onOrientationChange);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("orientationchange", onOrientationChange);
      window.visualViewport?.removeEventListener("resize", onVvResize);
      stopSpring();
    };
  }, []);
}
