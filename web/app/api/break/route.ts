import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { isBreakLevel, type BreakLevel } from "@/lib/breakLevels";

// Python 子プロセスを起動するため Node.js ランタイム必須。
export const runtime = "nodejs";
// 解読は数秒〜数十秒かかるので動的実行。
export const dynamic = "force-dynamic";
// セルフホストの node サーバでは無視される。実際の打ち切りは LEVEL_TIMEOUT_MS。
export const maxDuration = 60;

/**
 * この経路はローカル専用。
 *
 * ブラウザ版（WASM）が既定の解読エンジンで、Vercel 上には Python も Rust 拡張も
 * 存在しないため動かない。手元で native Rayon の速度を使いたいときだけ
 * `ENABLE_PYTHON_API=1` を立てて有効化する。
 */
const PYTHON_API_ENABLED = process.env.ENABLE_PYTHON_API === "1";

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
  level?: BreakLevel;
  top_results?: number;
}

// 精度レベルごとの打ち切り時間（ミリ秒）。これを超えたら子プロセスを殺す。
// 放置すると解析プロセスだけが生き残って CPU を占有し続けるため。
const LEVEL_TIMEOUT_MS: Record<BreakLevel, number> = {
  normal: 180_000,
  accuracy: 300_000,
  thorough: 1_800_000,
};
// PB既知モードは精度レベルを持たないので固定値。
const KNOWN_PLUGBOARD_TIMEOUT_MS = 300_000;

function runSolver(
  payload: BreakRequest
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const timeoutMs =
    payload.mode === "plugboard"
      ? LEVEL_TIMEOUT_MS[payload.level ?? "accuracy"]
      : KNOWN_PLUGBOARD_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(PYTHON, [SOLVE, JSON.stringify(payload)], {
      cwd: REPO_ROOT,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err), timedOut });
    });
  });
}

export async function POST(req: NextRequest) {
  if (!PYTHON_API_ENABLED) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Python 解析経路は無効です（ローカルで ENABLE_PYTHON_API=1 のときのみ有効）。" +
          "ブラウザ内の WASM エンジンを使ってください。",
      },
      { status: 501 }
    );
  }

  let body: BreakRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (body.mode !== "known_plugboard" && body.mode !== "plugboard") {
    return NextResponse.json({ ok: false, error: "invalid mode" }, { status: 400 });
  }
  if (body.level !== undefined && !isBreakLevel(body.level)) {
    return NextResponse.json({ ok: false, error: "invalid level" }, { status: 400 });
  }
  const cleaned = (body.ciphertext || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (cleaned.length < 20) {
    return NextResponse.json(
      { ok: false, error: "暗号文が短すぎます（A-Zで20文字以上）。" },
      { status: 400 }
    );
  }

  const { code, stdout, stderr, timedOut } = await runSolver(body);
  if (timedOut) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "解析が制限時間を超えたため打ち切りました。精度を下げるか、暗号文を短くして再試行してください。",
      },
      { status: 504 }
    );
  }
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
