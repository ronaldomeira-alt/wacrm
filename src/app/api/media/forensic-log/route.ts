import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const LOG_FILE = path.join(process.cwd(), ".next", "forensic-trace.log");
const MAX_BODY_BYTES = 16_384;
const MAX_LOG_BYTES = 512 * 1024;

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole("owner");
    const limit = checkRateLimit(`forensic-log:${userId}`, RATE_LIMITS.audioTelemetry);
    if (!limit.success) return rateLimitResponse(limit);

    const rawText = await request.text();
    if (rawText.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const step = typeof body.step === "number" || typeof body.step === "string" ? body.step : "?";
    const stepName =
      typeof body.stepName === "string" ? body.stepName.slice(0, 80) : "TRACE";
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] STEP ${step} [${stepName}]: ${JSON.stringify(body.data ?? body)}\n`;

    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      fs.writeFileSync(LOG_FILE, "", "utf8");
    }
    fs.appendFileSync(LOG_FILE, line, "utf8");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET() {
  try {
    const { userId } = await requireRole("owner");
    const limit = checkRateLimit(`forensic-log:${userId}`, RATE_LIMITS.audioTelemetry);
    if (!limit.success) return rateLimitResponse(limit);

    if (fs.existsSync(LOG_FILE)) {
      const content = fs.readFileSync(LOG_FILE, "utf8");
      return new NextResponse(content, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new NextResponse("No forensic logs yet.", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const { userId } = await requireRole("owner");
    const limit = checkRateLimit(`forensic-log:${userId}`, RATE_LIMITS.audioTelemetry);
    if (!limit.success) return rateLimitResponse(limit);

    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
    }
    return NextResponse.json({ ok: true, cleared: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
