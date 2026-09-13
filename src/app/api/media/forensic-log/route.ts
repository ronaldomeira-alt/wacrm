import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

const LOG_FILE = path.join(process.cwd(), ".next", "forensic-trace.log");

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] STEP ${body.step ?? "?"} [${body.stepName ?? "TRACE"}]: ${JSON.stringify(body.data ?? body)}\n`;
    
    fs.appendFileSync(LOG_FILE, line, "utf8");
    console.log(line.trim());

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const content = fs.readFileSync(LOG_FILE, "utf8");
      return new NextResponse(content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new NextResponse("No forensic logs yet.", { headers: { "Content-Type": "text/plain" } });
  } catch (err) {
    return new NextResponse(`Error reading logs: ${err}`, { status: 500 });
  }
}

export async function DELETE() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
    }
    return NextResponse.json({ ok: true, cleared: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
