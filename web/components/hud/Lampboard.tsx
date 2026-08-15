"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "@/components/fx/useReducedMotion";
import { KEY_ROWS } from "./keyRows";
import styles from "./Lampboard.module.css";

/** 残光として残す直近の点灯数。先頭ほど明るい。 */
const TRAIL = 4;
/** 全体の走査時間。長文でも待たされないよう上限にする */
const TOTAL_MS = 1800;
const MIN_STEP_MS = 16;
const MAX_STEP_MS = 60;

/**
 * ランプ盤。出力された文字を 1 文字ずつ点灯させる。
 *
 * 実機は打鍵のたびに 1 個だけ光るが、画面上では速すぎて追えないので
 * 直近数文字を残光として残している。走査し終えたら消灯する。
 */
export default function Lampboard({ text }: { text: string }) {
  const reduced = useReducedMotion();
  const [trail, setTrail] = useState<string[]>([]);

  useEffect(() => {
    const letters = text.toUpperCase().replace(/[^A-Z]/g, "");
    if (reduced || letters.length === 0) {
      setTrail([]);
      return;
    }

    const step = Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, TOTAL_MS / letters.length));
    let i = 0;

    const id = setInterval(() => {
      if (i >= letters.length) {
        clearInterval(id);
        setTrail([]);
        return;
      }
      const ch = letters[i++];
      setTrail((prev) => [ch, ...prev].slice(0, TRAIL));
    }, step);

    return () => clearInterval(id);
  }, [text, reduced]);

  return (
    <div className={styles.lampboard} aria-hidden>
      {KEY_ROWS.map((row) => (
        <div className={styles.row} key={row}>
          {[...row].map((ch) => {
            const rank = trail.indexOf(ch);
            return (
              <span
                key={ch}
                className={styles.lamp}
                data-lit={rank >= 0}
                style={rank >= 0 ? { opacity: 1 - rank * 0.22 } : undefined}
              >
                {ch}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
