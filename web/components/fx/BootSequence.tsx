"use client";

import { useRef, useState } from "react";
import styles from "./BootSequence.module.css";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect";
import { useReducedMotion } from "./useReducedMotion";

const SEEN_KEY = "enigma:booted";
const DURATION_MS = 1500;
const FADE_MS = 420;

/** 起動ログ。実際の初期化とは連動しない“儀式”なので固定文言でよい。 */
const LINES = [
  "POWER ON SELF TEST .................. OK",
  "MOUNT ROTOR ASSEMBLY I-V ............ OK",
  "REFLECTOR B/C ....................... OK",
  "LOAD LANGUAGE MODEL (3.9M CHARS) .... OK",
  "SPIN UP WASM CRYPTANALYSIS CORE ..... OK",
  "NETWORK ISOLATION ................... LOCAL-ONLY",
];

type Phase = "pending" | "running" | "fading" | "done";

/**
 * sessionStorage はプライベートモードや埋め込み環境で例外を投げうる。
 * 起動演出のためだけに画面を落としたくないので、読めなければ
 * 「まだ見ていない」扱いにして 1 回流す。
 */
function hasBooted(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markBooted(): void {
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    // 保存できなくても演出自体は成立する
  }
}

/**
 * 初回訪問時だけ流す起動演出。
 *
 * セッション中 1 回に限る（sessionStorage）。モーション低減時は再生しない。
 * SSR では overlay を描いたうえで、ペイント前のレイアウト効果で
 * 「もう見た」場合に消すので、再読み込み時にチラつかない。
 */
export default function BootSequence() {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("pending");
  const [progress, setProgress] = useState(0);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (reduced || hasBooted()) {
      setPhase("done");
      return;
    }

    markBooted();
    setPhase("running");

    const start = performance.now();
    const tick = (now: number) => {
      const ratio = Math.min(1, (now - start) / DURATION_MS);
      setProgress(ratio);
      if (ratio < 1) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      frameRef.current = null;
      setPhase("fading");
      timerRef.current = setTimeout(() => setPhase("done"), FADE_MS);
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [reduced]);

  if (phase === "done") return null;

  const shown = Math.round(progress * LINES.length);
  const percent = Math.round(progress * 100);

  return (
    <div className={styles.overlay} data-fading={phase === "fading"} aria-hidden>
      <div className={styles.console}>
        <div className={styles.title}>ENIGMA M3</div>
        <div className={styles.sub}>CRYPTANALYSIS TERMINAL / BOOT SEQUENCE</div>
        <ul className={styles.lines}>
          {LINES.map((line, i) => (
            <li key={line} data-shown={i < shown}>
              <span>&gt;</span> {line}
            </li>
          ))}
        </ul>
        <div className="bar" style={{ marginTop: 18 }}>
          <div className="bar__fill" style={{ width: `${percent}%` }} />
        </div>
        <div className={styles.percent}>
          {String(percent).padStart(3, "0")}% — INITIALIZING
        </div>
      </div>
    </div>
  );
}
