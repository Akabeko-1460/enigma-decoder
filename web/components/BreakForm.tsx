"use client";

import { useEffect, useRef, useState } from "react";
import { Enigma, ROTOR_NAMES, group5 } from "@/lib/enigma";
import {
  BREAK_LEVELS,
  BREAK_LEVEL_INFO,
  DEFAULT_BREAK_LEVEL,
  type BreakLevel,
} from "@/lib/breakLevels";
import { solveKnownPlugboard, solvePlugboard } from "@/lib/solver/pipeline";
import { terminatePool } from "@/lib/solver/pool";
import {
  ROTOR_LABELS,
  formatPlugboard,
  intsToText,
  parsePlugboard,
  type Language,
  type Progress,
  type ResultRow,
} from "@/lib/solver/types";

type Mode = "known_plugboard" | "plugboard";

/** ローカルでのみ Python 解析経路を使えるようにする（既定はブラウザ実行）。 */
const PYTHON_API_ENABLED = process.env.NEXT_PUBLIC_ENABLE_PYTHON_API === "1";

// 既知プラグボード用: 短めでも解読できるので手頃な長さ
const SAMPLES_KNOWN = [
  "MEET ME AT THE OLD BRIDGE AT DAWN BRING THE DOCUMENTS AND DO NOT BE LATE",
  "THE ENEMY FLEET HAS BEEN SPOTTED NEAR THE NORTHERN COAST PREPARE DEFENSES",
  "ALL UNITS MUST MAINTAIN RADIO SILENCE UNTIL WE REACH THE RENDEZVOUS POINT",
];

// プラグボード未知用: Phase 1(IC) が正解を捕捉できるよう長め（120字超）にする
const SAMPLES_UNKNOWN = [
  "THE ALLIED FORCES ARE PREPARING FOR A MAJOR OFFENSIVE ALONG THE WESTERN FRONT ALL UNITS MUST BE READY TO ADVANCE AT FIRST LIGHT TOMORROW MORNING WITHOUT FAIL",
  "OUR INTELLIGENCE REPORTS CONFIRM THAT THE ENEMY WILL ATTEMPT A CROSSING AT THE NARROW STRAIT DURING THE NIGHT SO WE MUST FORTIFY THAT SECTOR HEAVILY AT ONCE",
  "COMMAND HAS AUTHORIZED THE USE OF RESERVE BATTALIONS IN THE UPCOMING ENGAGEMENT PROCEED WITH MAXIMUM CAUTION AND MAINTAIN RADIO CONTACT WITH BASE AT ALL TIMES",
];

const PHASE_LABELS: Record<Progress["phase"], string> = {
  init: "言語モデルを読み込み中",
  phase1: "Phase A: ローター・初期位置を全探索中",
  phase2: "Phase C: プラグボードを復元中",
  refine: "Phase B: リング設定を再探索中",
};

interface Outcome {
  results: ResultRow[];
  elapsedMs: number;
  workers: number;
  engine: "wasm" | "python";
  level?: BreakLevel;
}

function randomInt(n: number) {
  return Math.floor(Math.random() * n);
}

export default function BreakForm({ mode }: { mode: Mode }) {
  const [ciphertext, setCiphertext] = useState("");
  const [language, setLanguage] = useState<Language>("english");
  const [plugboard, setPlugboard] = useState("AB CD EF");
  const [accuracy, setAccuracy] = useState(false);
  const [level, setLevel] = useState<BreakLevel>(DEFAULT_BREAK_LEVEL);
  const [usePython, setUsePython] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [genInfo, setGenInfo] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // タブを離れるときにワーカーを片付ける
  useEffect(() => () => terminatePool(), []);

  // テスト用暗号文を生成（ブラウザ内の TS エニグマで）
  function generateSample() {
    const pool = mode === "known_plugboard" ? SAMPLES_KNOWN : SAMPLES_UNKNOWN;
    const pt = pool[randomInt(pool.length)];
    const rotors: [string, string, string] = [
      ROTOR_NAMES[randomInt(5)],
      ROTOR_NAMES[randomInt(5)],
      ROTOR_NAMES[randomInt(5)],
    ];
    // 3 枚が重複しないよう選び直す
    while (new Set(rotors).size < 3) {
      rotors[0] = ROTOR_NAMES[randomInt(5)];
      rotors[1] = ROTOR_NAMES[randomInt(5)];
      rotors[2] = ROTOR_NAMES[randomInt(5)];
    }
    const positions: [number, number, number] = [randomInt(26), randomInt(26), randomInt(26)];
    const pb = mode === "known_plugboard" ? plugboard : "QW ER TY GH";
    const ct = new Enigma({ rotors, reflector: "B", rings: [0, 0, 0], positions, plugboard: pb }).encrypt(pt);
    setCiphertext(group5(ct));
    const posStr = positions.map((n) => String.fromCharCode(65 + n)).join("");
    setGenInfo(
      `生成に使った真の設定 → ローター ${rotors.join(" ")} / 位置 ${posStr}` +
        (mode === "plugboard" ? ` / プラグボード ${pb}（未知として解読します）` : "")
    );
    setOutcome(null);
    setError(null);
  }

  async function solveInBrowser(signal: AbortSignal): Promise<Outcome> {
    const common = {
      ciphertext,
      language,
      topResults: 5,
      onProgress: setProgress,
      signal,
    };
    if (mode === "plugboard") {
      const out = await solvePlugboard({ ...common, level });
      return { ...out, engine: "wasm", level };
    }
    const out = await solveKnownPlugboard({
      ...common,
      plugboard,
      plugboardArray: parsePlugboard(plugboard),
      accuracy,
    });
    return { ...out, engine: "wasm" };
  }

  async function solveViaPython(): Promise<Outcome> {
    const res = await fetch("/api/break", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, ciphertext, language, plugboard, accuracy, level, top_results: 5 }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "解析に失敗しました");
    // Python 経路は表示用に整形済みの行を返すので、そのまま使えるよう詰め替える
    const results: ResultRow[] = (json.results || []).map(
      (r: { score: number; rotors: string; positions: string; rings: string; plugboard: string; lang: string; text: string }) => ({
        score: r.score,
        rotors: r.rotors.split(" ").map((n) => ROTOR_LABELS.indexOf(n as (typeof ROTOR_LABELS)[number])) as [number, number, number],
        pos: [...r.positions].map((c) => c.charCodeAt(0) - 65) as [number, number, number],
        rings: [...r.rings].map((c) => c.charCodeAt(0) - 65) as [number, number, number],
        pb: Array.from(parsePlugboard(r.plugboard === "(none)" ? "" : r.plugboard)),
        lang: r.lang,
        text: r.text,
      })
    );
    return { results, elapsedMs: (json.elapsed ?? 0) * 1000, workers: 1, engine: "python", level: json.level };
  }

  async function solve() {
    setLoading(true);
    setOutcome(null);
    setError(null);
    setProgress(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setOutcome(usePython ? await solveViaPython() : await solveInBrowser(controller.signal));
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
      setProgress(null);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
    // ワーカーは中断指示を見ないので、実際に止めるには落とすしかない
    terminatePool();
    setLoading(false);
    setProgress(null);
  }

  const cleanedLen = ciphertext.toUpperCase().replace(/[^A-Z]/g, "").length;

  return (
    <div>
      <div className="card">
        <div className="row">
          <button className="ghost" onClick={generateSample} disabled={loading}>
            テスト暗号文を生成
          </button>
          <div style={{ flex: 3 }} />
        </div>
        {genInfo && (
          <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>{genInfo}</p>
        )}

        <label>暗号文（A-Z以外は無視。{cleanedLen} 文字）</label>
        <textarea
          value={ciphertext}
          onChange={(e) => setCiphertext(e.target.value)}
          placeholder="解読したい暗号文を貼り付け"
        />

        <div className="grid2">
          <div>
            <label>平文の言語</label>
            <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
              <option value="english">英語</option>
              <option value="romaji">ローマ字</option>
              <option value="auto">自動判定</option>
            </select>
          </div>
          {mode === "known_plugboard" && (
            <div>
              <label>既知プラグボード（例: AB CD EF）</label>
              <input type="text" value={plugboard} onChange={(e) => setPlugboard(e.target.value)} />
            </div>
          )}
          {mode === "plugboard" && (
            <div>
              <label>精度（探索の広さ）</label>
              <select value={level} onChange={(e) => setLevel(e.target.value as BreakLevel)}>
                {BREAK_LEVELS.map((lv) => (
                  <option key={lv} value={lv}>
                    {BREAK_LEVEL_INFO[lv].label} — 目安 {BREAK_LEVEL_INFO[lv].estimate}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {mode === "plugboard" && (
          <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            {BREAK_LEVEL_INFO[level].hint}
          </p>
        )}

        {mode === "known_plugboard" && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
            <input
              type="checkbox"
              checked={accuracy}
              onChange={(e) => setAccuracy(e.target.checked)}
              style={{ width: "auto" }}
            />
            精度モード（リング設定 676 通りを探索・やや遅い）
          </label>
        )}

        {PYTHON_API_ENABLED && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <input
              type="checkbox"
              checked={usePython}
              onChange={(e) => setUsePython(e.target.checked)}
              style={{ width: "auto" }}
            />
            ローカルの Python + Rust 経路を使う（ネイティブ並列で高速）
          </label>
        )}

        <div style={{ marginTop: 16 }}>
          <button onClick={solve} disabled={loading || cleanedLen < 20}>
            {loading ? <><span className="spinner" />解読中…</> : "解読する"}
          </button>
          {loading && (
            <button className="ghost" onClick={cancel} style={{ marginLeft: 8 }}>
              中止
            </button>
          )}
          {cleanedLen > 0 && cleanedLen < 20 && (
            <span className="muted" style={{ marginLeft: 10, fontSize: 13 }}>
              20 文字以上必要です
            </span>
          )}
        </div>

        {loading && (
          <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
            {progress
              ? `${PHASE_LABELS[progress.phase]}（${progress.done}/${progress.total}）`
              : "準備中…"}
            {mode === "plugboard" && ` — 目安 ${BREAK_LEVEL_INFO[level].estimate}`}
          </p>
        )}
      </div>

      {error && (
        <div className="card">
          <h2 style={{ marginTop: 0 }} className="bad">エラー</h2>
          <p>{error}</p>
        </div>
      )}
      {outcome && <ResultView outcome={outcome} />}
    </div>
  );
}

function ResultView({ outcome }: { outcome: Outcome }) {
  const rows = outcome.results;
  if (rows.length === 0) {
    return (
      <div className="card">
        <p>候補が見つかりませんでした。精度を上げるか、暗号文を長くしてください。</p>
      </div>
    );
  }

  const gap = rows.length >= 2 ? rows[0].score - rows[1].score : Infinity;
  const confidence =
    gap > 0.5 ? "第1候補がほぼ確実に正解です。"
    : gap > 0.2 ? "第1候補が有力です。"
    : "スコア差が小さいため、複数候補を見比べてください。";

  return (
    <div>
      <div className="row" style={{ margin: "18px 0 6px", alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: "0 0 auto" }}>解読結果</h2>
        <div style={{ flex: 1 }} />
        {outcome.level && <span className="tag">{BREAK_LEVEL_INFO[outcome.level].label}</span>}
        <span className="tag">
          {outcome.engine === "wasm" ? `WASM × ${outcome.workers} ワーカー` : "Python + Rust"}
        </span>
        <span className="tag">{(outcome.elapsedMs / 1000).toFixed(1)}s</span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{confidence}</p>

      {rows.map((r, i) => (
        <div className="card" key={i}>
          <div className="row" style={{ alignItems: "center" }}>
            <h3 style={{ margin: 0, flex: "0 0 auto", fontSize: 16 }}>
              候補 {i + 1} {i === 0 && <span className="good">★</span>}
            </h3>
            <div style={{ flex: 1 }} />
            <span className="tag">{r.lang}</span>
            <span className="tag">score {r.score.toFixed(3)}</span>
          </div>
          <div className="out" style={{ marginTop: 10 }}>{group5(r.text)}</div>
          <table className="kv" style={{ marginTop: 10 }}>
            <tbody>
              <tr><td className="k">ローター</td><td className="mono">{r.rotors.map((n) => ROTOR_LABELS[n]).join(" ")}</td></tr>
              <tr><td className="k">初期位置</td><td className="mono">{intsToText(r.pos)}</td></tr>
              <tr><td className="k">リング設定</td><td className="mono">{intsToText(r.rings)}</td></tr>
              <tr><td className="k">プラグボード</td><td className="mono">{formatPlugboard(r.pb) || "(なし)"}</td></tr>
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
