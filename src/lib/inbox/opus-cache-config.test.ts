import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { config as middlewareConfig } from "@/middleware";

describe("Opus encoder asset caching & middleware exclusion", () => {
  it("matches fingerprinted SHA-256 prefix on public/opus/encoderWorker.8.0.5-c3a64a87b286.min.js", () => {
    const legacyPath = path.join(process.cwd(), "public", "opus", "encoderWorker.min.js");
    const fingerprintedPath = path.join(
      process.cwd(),
      "public",
      "opus",
      "encoderWorker.8.0.5-c3a64a87b286.min.js",
    );
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.existsSync(fingerprintedPath)).toBe(true);

    const buf = fs.readFileSync(fingerprintedPath);
    const hashPrefix = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);
    expect(hashPrefix).toBe("c3a64a87b286");
    expect(buf.equals(fs.readFileSync(legacyPath))).toBe(true);
  });

  it("bypasses middleware for opus encoderWorker assets while still protecting private routes", () => {
    const pattern = middlewareConfig.matcher[0];
    const re = new RegExp(`^${pattern}$`);

    // Must bypass middleware
    expect(re.test("/opus/encoderWorker.8.0.5-c3a64a87b286.min.js")).toBe(false);
    expect(re.test("/opus/encoderWorker.min.js")).toBe(false);

    // Must NOT bypass middleware for private/dynamic routes
    expect(re.test("/inbox")).toBe(true);
    expect(re.test("/inbox?c=123")).toBe(true);
    expect(re.test("/dashboard")).toBe(true);
    expect(re.test("/settings")).toBe(true);
    expect(re.test("/api/whatsapp/send")).toBe(true);
    expect(re.test("/api/diagnostics/audio-telemetry")).toBe(true);
  });
});
