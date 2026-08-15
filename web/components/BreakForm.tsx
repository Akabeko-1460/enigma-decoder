"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./break.module.css";
import ScrambleText from "@/components/fx/ScrambleText";
import LogStream from "@/components/fx/LogStream";
import Gauge from "@/components/hud/Gauge";
import Panel from "@/components/hud/Panel";
import PhaseTracker, { type PhaseStep } from "@/components/hud/PhaseTracker";
import PlugboardMatrix from "@/components/hud/PlugboardMatrix";
import RotorDrum from "@/components/hud/RotorDrum";
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

/** 解読に必要な最低文字数。これを満たすまで実行を解禁しない */
const MIN_LENGTH = 20;
const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

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

const STEP_INIT: PhaseStep = { key: "init", en: "INIT", jp: "言語モデル読込" };
const STEP_A: PhaseStep = { key: "phase1", en: "PHASE A", jp: "ローター・位置" };
const STEP_C: PhaseStep = { key: "phase2", en: "PHASE C", jp: "プラグボード復元" };
const STEP_B: PhaseStep = { key: "refine", en: "PHASE B", jp: "リング設定" };

/** PB既知は Phase C を通らない。 */
const STEPS: Record<Mode, readonly PhaseStep[]> = {
  known_plugboard: [STEP_INIT, STEP_A, STEP_B],
  plugboard: [STEP_INIT, STEP_A, STEP_C, STEP_B],
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
  const [genInfo, setGenInfo] = useState<GeneratedKey | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [cores, setCores] = useState(1);
  const abortRef = useRef<AbortController | null>(null);

  // タブを離れるときにワーカーを片付ける
  useEffect(() => () => terminatePool(), []);

  useEffect(() => setCores(navigator.hardwareConcurrency || 1), []);

  // 実行中の経過時間。0.1 秒刻みで十分読める
  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    return () => clearInterval(id);
  }, [loading]);

  // テスト用暗号文を生成（ブラウザ内の TS エニグマで）
  function generateSample() {
    const pool = mode === "known_plugboard" ? SAMPLES_KNOWN : SAMPLES_UNKNOWN;
    const plaintext = pool[randomInt(pool.length)];

    const pickRotor = () => ROTOR_NAMES[randomInt(ROTOR_NAMES.length)];
    const rotors: [string, string, string] = [pickRotor(), pickRotor(), pickRotor()];
    // 3 枚が重複しないよう選び直す
    while (new Set(rotors).size < 3) {
      rotors[0] = pickRotor();
      rotors[1] = pickRotor();
      rotors[2] = pickRotor();
    }

    const positions: [number, number, number] = [randomInt(26), randomInt(26), randomInt(26)];
    // PB既知モードでは画面で指定中の配線をそのまま使う（それが前提条件のため）
    const usedPlugboard = mode === "known_plugboard" ? plugboard : "QW ER TY GH";
    const generated = new Enigma({
      rotors,
      reflector: "B",
      rings: [0, 0, 0],
      positions,
      plugboard: usedPlugboard,
    }).encrypt(plaintext);

    setCiphertext(group5(generated));
    setGenInfo({ rotors, positions, plugboard: usedPlugboard });
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

  const letterCount = ciphertext.toUpperCase().replace(/[^A-Z]/g, "").length;
  const isReady = letterCount >= MIN_LENGTH;
  const workerCount = usePython ? 1 : cores;

  return (
    <div className="stack" style={{ marginTop: 18 }}>
      <Panel
        id="RX"
        label="Intercepted Signal"
        status={`${letterCount} CHARS`}
        led={isReady ? "ok" : "on"}
        tone="accent"
      >
        <div className={styles.intercept}>
          <div className={styles.interceptMain}>
            <div className="row">
              <button className="btn btn--sm" onClick={generateSample} disabled={loading}>
                テスト暗号文を生成
              </button>
            </div>

            <label>暗号文（A-Z 以外は無視されます）</label>
            <textarea
              value={ciphertext}
              onChange={(e) => setCiphertext(e.target.value)}
              placeholder="解読したい暗号文を貼り付け"
            />
          </div>

          <div className={styles.charge}>
            <Gauge
              value={letterCount / MIN_LENGTH}
              readout={String(letterCount)}
              caption={isReady ? "READY" : `MIN ${MIN_LENGTH}`}
              tone={isReady ? "cyan" : "dim"}
            />
          </div>
        </div>

        {genInfo && <GeneratedKeyNote info={genInfo} mode={mode} />}
      </Panel>

      <Panel id="CFG" label="Attack Parameters" status={mode === "plugboard" ? "FULL KEY" : "PARTIAL"}>
        <div className="grid2">
          <div>
            <label>平文の言語</label>
            <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
              <option value="english">英語</option>
              <option value="romaji">ローマ字</option>
              <option value="auto">自動判定</option>
            </select>
          </div>
        </div>

        {mode === "known_plugboard" && (
          <>
            <label>既知のプラグボード配線</label>
            <PlugboardMatrix value={plugboard} onChange={loading ? undefined : setPlugboard} />
            <input
              type="text"
              value={plugboard}
              onChange={(e) => setPlugboard(e.target.value)}
              placeholder="AB CD EF（テキストでも入力できます）"
              aria-label="プラグボードをテキストで入力"
              style={{ marginTop: 10 }}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={accuracy}
                onChange={(e) => setAccuracy(e.target.checked)}
              />
              精度モード（リング設定 676 通りを探索・やや遅い）
            </label>
          </>
        )}

        {mode === "plugboard" && (
          <>
            <label>精度（探索の広さ）</label>
            <div className={styles.levels}>
              {BREAK_LEVELS.map((lv) => (
                <button
                  key={lv}
                  type="button"
                  className={styles.level}
                  data-active={level === lv}
                  disabled={loading}
                  onClick={() => setLevel(lv)}
                >
                  <span className={styles.levelHead}>
                    <span className="led" data-status={level === lv ? "on" : "off"} />
                    {BREAK_LEVEL_INFO[lv].label}
                  </span>
                  <span className={styles.levelEta}>ETA {BREAK_LEVEL_INFO[lv].estimate}</span>
                  <span className={styles.levelHint}>{BREAK_LEVEL_INFO[lv].hint}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {PYTHON_API_ENABLED && (
          <label className="check">
            <input
              type="checkbox"
              checked={usePython}
              onChange={(e) => setUsePython(e.target.checked)}
            />
            ローカルの Python + Rust 経路を使う（ネイティブ並列で高速）
          </label>
        )}

        <div className={styles.launch}>
          <button className="btn btn--fire" onClick={solve} disabled={loading || !isReady}>
            {loading ? "解読中…" : "解読開始"}
          </button>
          {loading && (
            <button className="btn btn--alert" onClick={cancel}>
              中止
            </button>
          )}
          {!isReady && letterCount > 0 && (
            <span className="alert small">
              あと {MIN_LENGTH - letterCount} 文字必要です
            </span>
          )}
        </div>
      </Panel>

      {loading && (
        <Panel id="RUN" label="Cryptanalysis" status="IN PROGRESS" led="on" tone="accent">
          <div className={styles.runHead}>
            <span className={styles.runElapsed}>{(elapsed / 1000).toFixed(1)}s</span>
            <span className={styles.runPhase}>
              {progress ? PHASE_LABELS[progress.phase] : "準備中…"}
            </span>
            <span className="spacer" />
            {progress && progress.total > 0 && (
              <span className={styles.runCount}>
                {progress.done} / {progress.total} SHARDS
              </span>
            )}
          </div>

          <div className="bar" style={{ marginBottom: 16 }}>
            <div
              className="bar__fill"
              style={{
                width: progress && progress.total > 0
                  ? `${(progress.done / progress.total) * 100}%`
                  : "8%",
              }}
            />
          </div>

          <PhaseTracker steps={STEPS[mode]} current={progress?.phase ?? null} />

          <div className="row" style={{ marginTop: 16, gap: 18 }}>
            <div className="stat">
              <span className="stat__k">Workers</span>
              <div className={styles.workers}>
                {Array.from({ length: Math.min(workerCount, 16) }, (_, i) => (
                  <span
                    className={styles.worker}
                    key={i}
                    style={{ animationDelay: `${i * 70}ms` }}
                  />
                ))}
              </div>
            </div>
            <span className="spacer" />
            {mode === "plugboard" && (
              <span className="tag">ETA {BREAK_LEVEL_INFO[level].estimate}</span>
            )}
          </div>

          <div style={{ marginTop: 16 }}>
            <LogStream
              active={loading}
              status={progress ? PHASE_LABELS[progress.phase] : null}
            />
          </div>
        </Panel>
      )}

      {error && (
        <Panel id="ERR" label="Failure" status="ABORTED" led="alert" tone="alert">
          <p className={`${styles.banner} ${styles.bannerBad}`}>DECRYPTION FAILED</p>
          <p className="mono small" style={{ margin: 0 }}>
            {error}
          </p>
        </Panel>
      )}

      {outcome && <ResultView outcome={outcome} />}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
   生成した暗号文の「答え」
   ──────────────────────────────────────────────────────────── */

interface GeneratedKey {
  rotors: [string, string, string];
  positions: [number, number, number];
  plugboard: string;
}

function GeneratedKeyNote({ info, mode }: { info: GeneratedKey; mode: Mode }) {
  return (
    <details style={{ marginTop: 14 }}>
      <summary className="mono tiny" style={{ cursor: "pointer", color: "var(--cyan-dim)" }}>
        生成に使った鍵を表示（答え合わせ用）
      </summary>
      <table className="kv" style={{ marginTop: 8 }}>
        <tbody>
          <tr>
            <td className="k">Rotors</td>
            <td className="v">{info.rotors.join(" · ")}</td>
          </tr>
          <tr>
            <td className="k">Position</td>
            <td className="v">{intsToText(info.positions)}</td>
          </tr>
          {mode === "plugboard" && (
            <tr>
              <td className="k">Plugboard</td>
              <td className="v">{info.plugboard}（未知として解読します）</td>
            </tr>
          )}
        </tbody>
      </table>
    </details>
  );
}

/* ────────────────────────────────────────────────────────────
   結果
   ──────────────────────────────────────────────────────────── */

function ResultView({ outcome }: { outcome: Outcome }) {
  const rows = outcome.results;

  if (rows.length === 0) {
    return (
      <Panel id="RESULT" label="No Candidate" status="EMPTY" led="alert" tone="alert">
        <p className={`${styles.banner} ${styles.bannerBad}`}>NO CANDIDATE</p>
        <p className="muted small" style={{ margin: 0 }}>
          候補が見つかりませんでした。精度を上げるか、暗号文を長くしてください。
        </p>
      </Panel>
    );
  }

  const [best, ...rest] = rows;
  const scoreGap = rows.length >= 2 ? best.score - rows[1].score : Infinity;
  const confidenceNote =
    scoreGap > 0.5
      ? "第1候補がほぼ確実に正解です。"
      : scoreGap > 0.2
        ? "第1候補が有力です。"
        : "スコア差が小さいため、複数候補を見比べてください。";
  // 0.6 差でほぼ確定とみなす（scoreGap が Infinity のときは満タン）
  const confidenceRatio = Math.min(1, scoreGap / 0.6);

  return (
    <div className="stack">
      <Panel
        id="RESULT"
        label="Decryption Complete"
        status={`${(outcome.elapsedMs / 1000).toFixed(1)}s`}
        led="ok"
        tone="ok"
      >
        <p className={styles.banner}>
          <span className="led" data-status="ok" />
          DECRYPTION COMPLETE
        </p>

        <div className="row" style={{ marginBottom: 14 }}>
          {outcome.level && <span className="tag">{BREAK_LEVEL_INFO[outcome.level].label}</span>}
          <span className="tag">
            {outcome.engine === "wasm" ? `WASM × ${outcome.workers} WORKERS` : "PYTHON + RUST"}
          </span>
          <span className="tag" data-tone="ok">
            SCORE {best.score.toFixed(3)}
          </span>
          <span className="tag">{best.lang.toUpperCase()}</span>
        </div>

        <label>復元された平文</label>
        <div className="readout readout--lg">
          <ScrambleText text={group5(best.text)} msPerChar={12} />
        </div>

        <div className={styles.verdict} style={{ marginTop: 18 }}>
          <Gauge
            value={confidenceRatio}
            readout={`${Math.round(confidenceRatio * 100)}%`}
            caption="Confidence"
            tone={confidenceRatio > 0.6 ? "mint" : "dim"}
          />
          <div className={styles.verdictText}>
            <p className="small" style={{ margin: 0 }}>
              {confidenceNote}
            </p>
            <p className="faint tiny" style={{ margin: "6px 0 0" }}>
              第1候補と第2候補のスコア差から算出しています。
            </p>
          </div>
        </div>
      </Panel>

      <Panel id="KEY" label="Recovered Key" status="SOLVED" led="ok" tone="accent">
        <div className={styles.keyGroups}>
          <KeyGroup label="Rotors" values={best.rotors.map((n) => ROTOR_LABELS[n])} options={ROTOR_LABELS} />
          <KeyGroup label="Position" values={[...intsToText(best.pos)]} options={LETTERS} />
          <KeyGroup label="Ring" values={[...intsToText(best.rings)]} options={LETTERS} />
        </div>

        <label>Plugboard</label>
        <PlugboardMatrix value={formatPlugboard(best.pb)} />
      </Panel>

      {rest.length > 0 && (
        <Panel id="ALT" label="Other Candidates" status={`${rest.length} ROWS`}>
          {rest.map((r, i) => (
            <div key={i} style={{ marginTop: i === 0 ? 0 : 18 }}>
              <div className={styles.rank}>
                <span className={styles.rankNo}>#{String(i + 2).padStart(2, "0")}</span>
                <span className="tag">SCORE {r.score.toFixed(3)}</span>
                <span className="tag">{r.lang.toUpperCase()}</span>
              </div>
              <div className="readout">{group5(r.text)}</div>
              <table className="kv" style={{ marginTop: 8 }}>
                <tbody>
                  <tr>
                    <td className="k">Rotors</td>
                    <td className="v">{r.rotors.map((n) => ROTOR_LABELS[n]).join(" · ")}</td>
                  </tr>
                  <tr>
                    <td className="k">Position / Ring</td>
                    <td className="v">
                      {intsToText(r.pos)} / {intsToText(r.rings)}
                    </td>
                  </tr>
                  <tr>
                    <td className="k">Plugboard</td>
                    <td className="v">{formatPlugboard(r.pb) || "(なし)"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

/** 復元された鍵をドラム表示器で見せる（読み取り専用）。 */
function KeyGroup({
  label,
  values,
  options,
}: {
  label: string;
  values: string[];
  options: readonly string[];
}) {
  return (
    <div className={styles.keyGroup}>
      <span className={styles.keyGroupLabel}>{label}</span>
      <div className={styles.keyDrums}>
        {values.map((v, i) => (
          <RotorDrum key={i} options={options} value={options.indexOf(v)} tone="mint" />
        ))}
      </div>
    </div>
  );
}
