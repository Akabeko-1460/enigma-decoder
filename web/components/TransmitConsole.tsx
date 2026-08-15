"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import styles from "@/app/machine/machine.module.css";
import ScrambleText from "@/components/fx/ScrambleText";
import { useDebouncedValue } from "@/components/fx/useDebouncedValue";
import Lampboard from "@/components/hud/Lampboard";
import Panel from "@/components/hud/Panel";
import PlugboardMatrix from "@/components/hud/PlugboardMatrix";
import RotorDrum from "@/components/hud/RotorDrum";
import StatRow from "@/components/hud/StatRow";
import { Enigma, ROTOR_NAMES, group5, type EnigmaConfig } from "@/lib/enigma";
import { FIXED_CONFIG } from "@/lib/fixedConfig";
import { KEY_PARAM, decodeKey, encodeKey, shareUrl } from "@/lib/shareKey";

type Mode = "fixed" | "custom";
type Toast = { text: string; tone: "ok" | "bad" } | null;

const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const REFLECTORS = ["B", "C"] as const;
const SLOT_CAPTIONS = ["L", "M", "R"] as const;
/** リビール演出を掛け直す前に打鍵が落ち着くのを待つ時間 */
const SETTLE_MS = 280;
const TOAST_MS = 2600;

const INITIAL_CUSTOM: EnigmaConfig = {
  rotors: ["I", "II", "III"],
  reflector: "B",
  rings: [0, 0, 0],
  positions: [0, 0, 0],
  plugboard: "",
};

export default function TransmitConsole() {
  const searchParams = useSearchParams();

  const [mode, setMode] = useState<Mode>("fixed");
  const [custom, setCustom] = useState<EnigmaConfig>(INITIAL_CUSTOM);
  const [plainIn, setPlainIn] = useState("HELLO MY FRIEND MEET ME AT DAWN");
  const [cipherIn, setCipherIn] = useState("");
  const [received, setReceived] = useState("");
  const [spinNonce, setSpinNonce] = useState(0);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cfg = mode === "fixed" ? FIXED_CONFIG : custom;
  const isEditable = mode === "custom";

  const notify = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    setToast({ text, tone });
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
  }, []);

  // 共有 URL で開かれたら鍵を復元する。以後はユーザー操作を真とするので一度きり
  const keyApplied = useRef(false);
  useEffect(() => {
    if (keyApplied.current) return;
    const raw = searchParams.get(KEY_PARAM);
    if (!raw) return;

    keyApplied.current = true;
    const decoded = decodeKey(raw);
    if (!decoded) {
      notify("鍵の形式が正しくありません", "bad");
      return;
    }
    setCustom(decoded);
    setMode("custom");
    setSpinNonce((n) => n + 1);
    notify("鍵を受信しました — KEY LOADED");
  }, [searchParams, notify]);

  // エニグマは対合的なので、暗号化も復号も同じ操作
  const cipherOut = useMemo(() => encryptOrEmpty(cfg, plainIn), [cfg, plainIn]);
  const plainOut = useMemo(() => encryptOrEmpty(cfg, cipherIn), [cfg, cipherIn]);

  // 打鍵が止まってから演出を掛ける
  const settledCipher = useDebouncedValue(cipherOut, SETTLE_MS);
  const settledPlain = useDebouncedValue(plainOut, SETTLE_MS);

  const keyLine = useMemo(() => encodeKey(cfg), [cfg]);
  const hasDuplicateRotors = new Set(cfg.rotors).size < 3;

  function updateKey(next: Partial<EnigmaConfig>) {
    setCustom((prev) => ({ ...prev, ...next }));
  }

  function setRotor(slot: number, name: string) {
    setCustom((prev) => {
      const rotors = [...prev.rotors] as [string, string, string];
      rotors[slot] = name;
      return { ...prev, rotors };
    });
  }

  /** リング設定と初期位置は同じ形（0..25 の 3 連）なので 1 本にまとめる。 */
  function setTriple(field: "rings" | "positions", slot: number, value: number) {
    setCustom((prev) => {
      const next = [...prev[field]] as [number, number, number];
      next[slot] = value;
      return field === "rings" ? { ...prev, rings: next } : { ...prev, positions: next };
    });
  }

  function randomizeKey() {
    setCustom(randomConfig());
    setSpinNonce((n) => n + 1);
    notify("鍵を再生成しました — KEY RANDOMIZED");
  }

  async function copyToClipboard(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${label}をコピーしました`);
    } catch {
      notify("コピーできませんでした（手動で選択してください）", "bad");
    }
  }

  function loadReceivedKey() {
    const decoded = decodeKey(received);
    if (!decoded) {
      notify("鍵として読み取れませんでした", "bad");
      return;
    }
    setCustom(decoded);
    setMode("custom");
    setSpinNonce((n) => n + 1);
    setReceived("");
    notify("鍵を読み込みました — KEY LOADED");
  }

  return (
    <>
      {/* ── 鍵の設定 ───────────────────────────────── */}
      <Panel
        id="KEY"
        label="Machine Setup"
        status={isEditable ? "EDITABLE" : "LOCKED"}
        led={isEditable ? "on" : "ok"}
        tone="accent"
      >
        <div className="row">
          <div className="segmented">
            <button data-active={mode === "fixed"} onClick={() => setMode("fixed")}>
              固定の鍵
            </button>
            <button data-active={mode === "custom"} onClick={() => setMode("custom")}>
              自分で組む
            </button>
          </div>
          <span className="spacer" />
          {isEditable && (
            <button className="btn btn--sm" onClick={randomizeKey}>
              鍵をランダム生成
            </button>
          )}
        </div>

        <p className="muted small" style={{ marginTop: 10 }}>
          {isEditable
            ? "ドラムはクリック・ホイール・↑↓キーで回します。プラグボードは 2 文字を続けて押すと結線、結線済みを押すと解除します。"
            : "あらかじめ決めてある共通の鍵です。相手も同じ鍵を選べば読み合えます。"}
        </p>

        <div className={styles.keyRow}>
          <span className={styles.keyLabel}>
            <span className={styles.keyLabelEn}>Rotors</span>
            <span className={styles.keyLabelJp}>ローター / 反射板</span>
          </span>
          <div className={styles.drumGroup}>
            <div className={styles.drums}>
              {[0, 1, 2].map((i) => (
                <RotorDrum
                  key={i}
                  options={ROTOR_NAMES}
                  value={ROTOR_NAMES.indexOf(cfg.rotors[i])}
                  caption={SLOT_CAPTIONS[i]}
                  spinNonce={spinNonce}
                  onChange={isEditable ? (n) => setRotor(i, ROTOR_NAMES[n]) : undefined}
                />
              ))}
            </div>
            <div className={styles.divider} />
            <RotorDrum
              options={REFLECTORS}
              value={REFLECTORS.indexOf(cfg.reflector)}
              caption="UKW"
              tone="violet"
              spinNonce={spinNonce}
              onChange={
                isEditable ? (n) => updateKey({ reflector: REFLECTORS[n] }) : undefined
              }
            />
          </div>
        </div>

        <div className={styles.keyRow}>
          <span className={styles.keyLabel}>
            <span className={styles.keyLabelEn}>Ring Setting</span>
            <span className={styles.keyLabelJp}>リング設定</span>
          </span>
          <div className={styles.drums}>
            {[0, 1, 2].map((i) => (
              <RotorDrum
                key={i}
                options={LETTERS}
                value={cfg.rings[i]}
                caption={SLOT_CAPTIONS[i]}
                spinNonce={spinNonce}
                onChange={isEditable ? (n) => setTriple("rings", i, n) : undefined}
              />
            ))}
          </div>
        </div>

        <div className={styles.keyRow}>
          <span className={styles.keyLabel}>
            <span className={styles.keyLabelEn}>Start Position</span>
            <span className={styles.keyLabelJp}>初期位置</span>
          </span>
          <div className={styles.drums}>
            {[0, 1, 2].map((i) => (
              <RotorDrum
                key={i}
                options={LETTERS}
                value={cfg.positions[i]}
                caption={SLOT_CAPTIONS[i]}
                spinNonce={spinNonce}
                onChange={isEditable ? (n) => setTriple("positions", i, n) : undefined}
              />
            ))}
          </div>
        </div>

        {hasDuplicateRotors && (
          <p className="alert small" style={{ marginTop: 4 }}>
            同じローターを 2 本以上使っています。実機にはない構成です（計算は通ります）。
          </p>
        )}

        <label>Plugboard / プラグボード</label>
        <PlugboardMatrix
          value={cfg.plugboard}
          onChange={isEditable ? (next) => updateKey({ plugboard: next }) : undefined}
        />
        {isEditable && (
          <input
            type="text"
            value={custom.plugboard}
            onChange={(e) => updateKey({ plugboard: e.target.value })}
            placeholder="AR GK OX（テキストでも入力できます）"
            aria-label="プラグボードをテキストで入力"
            style={{ marginTop: 10 }}
          />
        )}
      </Panel>

      {/* ── 鍵の共有 ───────────────────────────────── */}
      <div style={{ marginTop: 18 }}>
        <Panel id="KEY-SHARE" label="Key Exchange" status="1 LINE" led="on">
          <p className="muted small" style={{ marginTop: 0 }}>
            この 1 行が鍵のすべてです。暗号文と一緒に渡すと相手が復号できます。
          </p>
          <div className={styles.keyLine}>
            <span>{keyLine}</span>
          </div>
          <div className={styles.shareButtons}>
            <button className="btn btn--sm" onClick={() => copyToClipboard(keyLine, "鍵")}>
              鍵をコピー
            </button>
            <button
              className="btn btn--sm"
              onClick={() => copyToClipboard(shareUrl(cfg), "共有 URL")}
            >
              共有 URL をコピー
            </button>
            <button
              className="btn btn--sm"
              disabled={cipherOut.length === 0}
              onClick={() =>
                copyToClipboard(`${group5(cipherOut)}\n\nKEY: ${keyLine}`, "暗号文と鍵")
              }
            >
              暗号文＋鍵をコピー
            </button>
          </div>

          <label>受け取った鍵を読み込む</label>
          <div className={styles.receive}>
            <input
              type="text"
              value={received}
              onChange={(e) => setReceived(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loadReceivedKey();
              }}
              placeholder="ENQ1:… または共有 URL をそのまま貼り付け"
              aria-label="受け取った鍵"
            />
            <button className="btn" disabled={!received.trim()} onClick={loadReceivedKey}>
              読込
            </button>
          </div>
        </Panel>
      </div>

      {/* ── 生成 / 復号 ─────────────────────────────── */}
      <div className={styles.consoles} style={{ marginTop: 18 }}>
        <Panel id="TX" label="Encode" status="PLAIN → CIPHER" led="on" tone="accent">
          <label>平文</label>
          <textarea
            value={plainIn}
            onChange={(e) => setPlainIn(e.target.value)}
            placeholder="送りたい文を入力（A-Z 以外は無視されます）"
          />
          <label>暗号文（5 文字区切り）</label>
          {/* 生成側は打鍵に追従させたいのでリビールは掛けない。動きはランプ盤が担う */}
          <div className="readout" data-empty={cipherOut.length === 0}>
            {cipherOut ? group5(cipherOut) : "—"}
          </div>
          <div className={styles.lamps}>
            <Lampboard text={settledCipher} />
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn btn--sm"
              disabled={cipherOut.length === 0}
              onClick={() => copyToClipboard(group5(cipherOut), "暗号文")}
            >
              暗号文をコピー
            </button>
          </div>
        </Panel>

        <div className={styles.transfer}>
          <span className={styles.transferLine} />
          <button
            type="button"
            className={styles.transferBtn}
            disabled={cipherOut.length === 0}
            onClick={() => setCipherIn(group5(cipherOut))}
            title="生成した暗号文を復号機へ送る"
            aria-label="生成した暗号文を復号機へ送る"
          >
            &rarr;
          </button>
          <span className={styles.transferLine} />
        </div>

        <Panel id="RX" label="Decode" status="CIPHER → PLAIN" led="on" tone="accent">
          <label>暗号文</label>
          <textarea
            value={cipherIn}
            onChange={(e) => setCipherIn(e.target.value)}
            placeholder="受け取った暗号文を貼り付け（空白や改行は無視されます）"
          />
          <label>復号結果</label>
          <div className="readout readout--lg" data-empty={plainOut.length === 0}>
            {plainOut ? <ScrambleText text={settledPlain} msPerChar={14} /> : "—"}
          </div>
          <p className="faint tiny" style={{ marginTop: 12 }}>
            読めない文字列になる場合は鍵が違います。
          </p>
        </Panel>
      </div>

      {/* ── 現在の鍵の要約 ───────────────────────────── */}
      <div style={{ marginTop: 18 }}>
        <Panel id="STATE" label="Current Key" status={mode === "fixed" ? "FIXED" : "CUSTOM"}>
          <StatRow
            items={[
              { k: "Rotors", v: cfg.rotors.join(" · ") },
              { k: "Reflector", v: cfg.reflector },
              { k: "Rings", v: lettersOf(cfg.rings) },
              { k: "Position", v: lettersOf(cfg.positions) },
              {
                k: "Plugboard",
                v: cfg.plugboard || "NONE",
                tone: cfg.plugboard ? "cyan" : "plain",
              },
            ]}
          />
        </Panel>
      </div>

      {toast && (
        <div className={styles.toast} data-tone={toast.tone} role="status">
          <span className="led" data-status={toast.tone === "ok" ? "ok" : "alert"} />
          {toast.text}
        </div>
      )}
    </>
  );
}

/** 設定が不正でも画面を壊さないよう、失敗時は空文字にする。 */
function encryptOrEmpty(cfg: EnigmaConfig, text: string): string {
  try {
    return new Enigma(cfg).encrypt(text);
  } catch {
    return "";
  }
}

function lettersOf(values: readonly number[]): string {
  return values.map((n) => String.fromCharCode(65 + n)).join("");
}

function randomInt(n: number): number {
  return Math.floor(Math.random() * n);
}

/** 実機どおり 3 本は別々のローターを選び、プラグは 3 ペア張る。 */
function randomConfig(): EnigmaConfig {
  const pool = [...ROTOR_NAMES];
  const rotors: string[] = [];
  for (let i = 0; i < 3; i++) rotors.push(...pool.splice(randomInt(pool.length), 1));

  const alphabet = [...LETTERS];
  const pairs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const a = alphabet.splice(randomInt(alphabet.length), 1)[0];
    const b = alphabet.splice(randomInt(alphabet.length), 1)[0];
    pairs.push(a + b);
  }

  return {
    rotors: rotors as [string, string, string],
    reflector: Math.random() < 0.5 ? "B" : "C",
    rings: [randomInt(26), randomInt(26), randomInt(26)],
    positions: [randomInt(26), randomInt(26), randomInt(26)],
    plugboard: pairs.join(" "),
  };
}
