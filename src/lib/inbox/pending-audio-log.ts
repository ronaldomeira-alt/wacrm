/**
 * Structured console logging for the voice-note record/upload/send
 * pipeline (message-composer.tsx, pending-audio-sync.ts). Every stage of
 * a recording's life is logged under a single greppable prefix so a stuck
 * take can be traced from `recording:stopped` through to `cleanup` (or
 * whichever stage it died at) directly from the browser console / Safari
 * remote inspector — this was previously undiagnosable from the outside,
 * since nothing in the mic flow logged anything.
 */

declare global {
  interface Window {
    __wacrm_diag?: Array<{ time: string; stage: string; error?: string; data?: unknown }>;
  }
}

const PREFIX = "[voice-note]";

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function pushDiag(entry: { time: string; stage: string; error?: string; data?: unknown }): void {
  if (typeof window === "undefined") return;
  if (!window.__wacrm_diag) window.__wacrm_diag = [];
  window.__wacrm_diag.push(entry);
  if (window.__wacrm_diag.length > 100) {
    window.__wacrm_diag.shift();
  }
}

export function audioLog(stage: string, data?: Record<string, unknown>): void {
  const time = ts();
  pushDiag({ time, stage, data });
  console.log(`${PREFIX} ${time} ${stage}`, data ?? "");
}

export function audioLogError(stage: string, error: unknown, data?: Record<string, unknown>): void {
  const time = ts();
  const errorMsg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  pushDiag({ time, stage, error: errorMsg, data });
  console.error(`${PREFIX} ${time} ${stage}`, {
    error: errorMsg,
    ...data,
  });
}
