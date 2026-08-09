"use client";

import { useState } from "react";
import { Enigma, ROTOR_NAMES, group5 } from "@/lib/enigma";

type Mode = "known_plugboard" | "plugboard";

interface ResultRow {
  score: number;
  rotors: string;
  positions: string;
  rings: string;
  plugboard: string;
  lang: string;
  text: string;
}
interface ApiResult {
  ok: boolean;
  rust?: boolean;
  elapsed?: number;
  results?: ResultRow[];
  error?: string;
  detail?: string;
}

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

function randomInt(n: number) {
  return Math.floor(Math.random() * n);
}

export default function BreakForm({ mode }: { mode: Mode }) {
  const [ciphertext, setCiphertext] = useState("");
  const [language, setLanguage] = useState<"auto" | "english" | "romaji">("english");
  const [plugboard, setPlugboard] = useState("AB CD EF");
  const [accuracy, setAccuracy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [genInfo, setGenInfo] = useState<string | null>(null);

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
    setResult(null);
  }

  async function solve() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/break", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          ciphertext,
          language,
          plugboard,
          accuracy,
          top_results: 5,
        }),
      });
      const json: ApiResult = await res.json();
      setResult(json);
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setLoading(false);
    }
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
            <select value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
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
        </div>

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

        <div style={{ marginTop: 16 }}>
          <button onClick={solve} disabled={loading || cleanedLen < 20}>
            {loading ? <><span className="spinner" />解読中…</> : "解読する"}
          </button>
          {cleanedLen > 0 && cleanedLen < 20 && (
            <span className="muted" style={{ marginLeft: 10, fontSize: 13 }}>
              20 文字以上必要です
            </span>
          )}
        </div>
        {loading && (
          <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
            {mode === "plugboard"
              ? "プラグボード未知の全探索＋段階スコアを実行中。10〜60 秒ほどかかります。"
              : "ローター・位置・リングを探索中。数秒〜数十秒かかります。"}
          </p>
        )}
      </div>

      {result && <ResultView result={result} />}
    </div>
  );
}

function ResultView({ result }: { result: ApiResult }) {
  if (!result.ok) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }} className="bad">エラー</h2>
        <p>{result.error}</p>
        {result.detail && (
          <pre className="out" style={{ fontSize: 12 }}>{result.detail}</pre>
        )}
      </div>
    );
  }
  const rows = result.results || [];
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
        <span className="tag">{result.rust ? "Rust+Rayon" : "純Python"}</span>
        <span className="tag">{result.elapsed}s</span>
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
              <tr><td className="k">ローター</td><td className="mono">{r.rotors}</td></tr>
              <tr><td className="k">初期位置</td><td className="mono">{r.positions}</td></tr>
              <tr><td className="k">リング設定</td><td className="mono">{r.rings}</td></tr>
              <tr><td className="k">プラグボード</td><td className="mono">{r.plugboard}</td></tr>
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
