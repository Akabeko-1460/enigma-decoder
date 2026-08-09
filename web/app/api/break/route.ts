import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";

// Python 子プロセスを起動するため Node.js ランタイム必須。
export const runtime = "nodejs";
// 解読は数秒〜数十秒かかるので動的実行。
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// リポジトリルート（web/ の 1 つ上）と solve.py の場所。
const REPO_ROOT = path.resolve(process.cwd(), "..");
const SOLVE = path.join(REPO_ROOT, "web", "py", "solve.py");
const PYTHON = process.env.PYTHON_BIN || "python";

interface BreakRequest {
  mode: "known_plugboard" | "plugboard";
  ciphertext: string;
  language?: "auto" | "english" | "romaji";
  plugboard?: string;
  accuracy?: boolean;
  top_results?: number;
}

function runSolver(payload: BreakRequest): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [SOLVE, JSON.stringify(payload)], {
      cwd: REPO_ROOT,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

export async function POST(req: NextRequest) {
  let body: BreakRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (body.mode !== "known_plugboard" && body.mode !== "plugboard") {
    return NextResponse.json({ ok: false, error: "invalid mode" }, { status: 400 });
  }
  const cleaned = (body.ciphertext || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (cleaned.length < 20) {
    return NextResponse.json(
      { ok: false, error: "暗号文が短すぎます（A-Zで20文字以上）。" },
      { status: 400 }
    );
  }

  const { code, stdout, stderr } = await runSolver(body);
  if (code !== 0 || !stdout.trim()) {
    return NextResponse.json(
      { ok: false, error: "解析プロセスが失敗しました。", detail: stderr.slice(-2000) },
      { status: 500 }
    );
  }
  try {
    // solve.py は最終行に JSON を出力する。念のため最後の非空行を採用。
    const lines = stdout.trim().split("\n").filter((l) => l.trim());
    const json = JSON.parse(lines[lines.length - 1]);
    return NextResponse.json(json);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "結果の解析に失敗しました。", detail: String(e), raw: stdout.slice(-2000) },
      { status: 500 }
    );
  }
}
