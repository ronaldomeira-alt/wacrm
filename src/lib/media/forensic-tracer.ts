"use client";

export interface ForensicEntry {
  id: string;
  step: number;
  stepName: string;
  status: "ok" | "fail" | "info";
  timestamp: string;
  data: Record<string, unknown>;
}

type Listener = (entries: ForensicEntry[]) => void;

class ForensicTracer {
  private entries: ForensicEntry[] = [];
  private listeners: Set<Listener> = new Set();

  log(step: number, stepName: string, status: "ok" | "fail" | "info", data: Record<string, unknown> = {}) {
    const entry: ForensicEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      step,
      stepName,
      status,
      timestamp: new Date().toLocaleTimeString(),
      data,
    };

    this.entries.push(entry);
    if (this.entries.length > 200) this.entries.shift();

    // Notify listeners for UI HUD
    for (const l of this.listeners) {
      try {
        l([...this.entries]);
      } catch {}
    }

    // Console log locally on iPhone
    const prefix = `[FORENSIC ${status.toUpperCase()} STEP ${step}: ${stepName}]`;
    if (status === "fail") {
      console.error(prefix, data);
    } else {
      console.log(prefix, data);
    }

    // POST to backend so agent/CLI sees it in real-time
    if (typeof window !== "undefined") {
      try {
        fetch("/api/media/forensic-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            step,
            stepName,
            status,
            data,
            userAgent: navigator.userAgent,
          }),
          keepalive: true,
        }).catch(() => {});
      } catch {}
    }
  }

  getEntries(): ForensicEntry[] {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
    for (const l of this.listeners) {
      try {
        l([]);
      } catch {}
    }
    if (typeof window !== "undefined") {
      fetch("/api/media/forensic-log", { method: "DELETE" }).catch(() => {});
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener([...this.entries]);
    return () => this.listeners.delete(listener);
  }
}

export const forensic = new ForensicTracer();
