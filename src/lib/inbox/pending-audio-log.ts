/**
 * Structured console logging for the voice-note record/upload/send
 * pipeline (message-composer.tsx, pending-audio-sync.ts). Every stage of
 * a recording's life is logged under a single greppable prefix so a stuck
 * take can be traced from `recording:stopped` through to `cleanup` (or
 * whichever stage it died at) directly from the browser console / Safari
 * remote inspector — this was previously undiagnosable from the outside,
 * since nothing in the mic flow logged anything.
 */

const PREFIX = "[voice-note]";

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export function audioLog(stage: string, data?: Record<string, unknown>): void {
  console.log(`${PREFIX} ${ts()} ${stage}`, data ?? "");
}

export function audioLogError(stage: string, error: unknown, data?: Record<string, unknown>): void {
  console.error(`${PREFIX} ${ts()} ${stage}`, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    ...data,
  });
}
