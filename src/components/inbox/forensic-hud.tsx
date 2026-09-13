"use client";

import { useEffect, useState } from "react";
import { forensic, type ForensicEntry } from "@/lib/media/forensic-tracer";
import { Activity, X, Trash2, Copy, Check, ChevronUp } from "lucide-react";

export function ForensicHud() {
  const [entries, setEntries] = useState<ForensicEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    return forensic.subscribe((newEntries) => {
      setEntries(newEntries);
    });
  }, []);

  const latest = entries[entries.length - 1];

  const handleCopy = () => {
    const text = entries
      .map(
        (e) =>
          `[${e.timestamp}] STEP ${e.step} [${e.stepName}] (${e.status.toUpperCase()}): ${JSON.stringify(e.data)}`
      )
      .join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed bottom-20 right-3 z-50 flex flex-col items-end gap-2 font-mono text-xs select-none">
      {/* Mini Floating Pill */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 shadow-lg border backdrop-blur-md transition-all ${
            latest?.status === "fail"
              ? "bg-red-600/90 text-white border-red-500 animate-pulse"
              : latest?.status === "ok"
              ? "bg-emerald-600/90 text-white border-emerald-500"
              : "bg-zinc-900/85 text-zinc-200 border-zinc-700"
          }`}
        >
          <Activity className="h-3.5 w-3.5 animate-pulse" />
          <span className="font-semibold text-[11px]">
            {latest ? `Step ${latest.step}: ${latest.stepName}` : "Diagnóstico Ativo"}
          </span>
          <ChevronUp className="h-3 w-3 opacity-70" />
        </button>
      )}

      {/* Expanded Modal / Drawer */}
      {open && (
        <div className="w-[320px] sm:w-[380px] max-h-[420px] flex flex-col rounded-xl border border-border bg-zinc-950/95 text-zinc-100 shadow-2xl backdrop-blur-xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2 bg-zinc-900/60 rounded-t-xl">
            <div className="flex items-center gap-1.5">
              <Activity className="h-4 w-4 text-amber-400" />
              <span className="font-bold text-[12px] text-zinc-200">Diagnóstico Forense (1..22)</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleCopy}
                className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                title="Copiar logs"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => forensic.clear()}
                className="p-1 rounded text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                title="Limpar"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Log list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 text-[11px] max-h-[340px]">
            {entries.length === 0 ? (
              <div className="p-4 text-center text-zinc-500 italic">
                Aguardando interação no iPhone (toque em Anexar → Foto)...
              </div>
            ) : (
              entries.map((e) => (
                <div
                  key={e.id}
                  className={`p-2 rounded border transition-colors ${
                    e.status === "fail"
                      ? "bg-red-950/40 border-red-800/80 text-red-200"
                      : e.status === "ok"
                      ? "bg-emerald-950/30 border-emerald-800/60 text-emerald-200"
                      : "bg-zinc-900/50 border-zinc-800 text-zinc-300"
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span>
                      Passo {e.step}: {e.stepName}
                    </span>
                    <span
                      className={`text-[9px] px-1 rounded uppercase font-bold ${
                        e.status === "fail"
                          ? "bg-red-600 text-white"
                          : e.status === "ok"
                          ? "bg-emerald-600 text-white"
                          : "bg-zinc-700 text-zinc-200"
                      }`}
                    >
                      {e.status}
                    </span>
                  </div>
                  <div className="mt-1 text-[10px] opacity-90 break-all">
                    {Object.entries(e.data).map(([k, v]) => (
                      <div key={k}>
                        <span className="text-zinc-400">{k}:</span> {typeof v === "object" ? JSON.stringify(v) : String(v)}
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[9px] text-zinc-500 text-right">{e.timestamp}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
