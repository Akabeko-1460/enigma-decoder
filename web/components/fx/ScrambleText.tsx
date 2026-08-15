"use client";

import { useRef, useState } from "react";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect";
import { useReducedMotion } from "./useReducedMotion";

/** ノイズに使う字。英字だけだと単調なので記号を少し混ぜる。 */
const NOISE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&$@";
/** ノイズを引き直す間隔。毎フレーム替えると目が痛い */
const NOISE_INTERVAL_MS = 45;
/** 長文でも待たされないよう全体の上限を設ける */
const MAX_DURATION_MS = 2000;
const MIN_DURATION_MS = 360;

interface ScrambleTextProps {
  text: string;
  className?: string;
  /** 1 文字あたりの確定時間 */
  msPerChar?: number;
}

/**
 * 復号リビール。ランダムな文字から左→右へ 1 文字ずつ確定していく。
 *
 * text が変わるたびに前回のループを止めて掛け直す。アンマウント時も同様。
 */
export default function ScrambleText({
  text,
  className,
  msPerChar = 18,
}: ScrambleTextProps) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(text);
  const frameRef = useRef<number | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (reduced || text.length === 0) {
      setDisplay(text);
      return;
    }

    const duration = Math.min(
      MAX_DURATION_MS,
      Math.max(MIN_DURATION_MS, text.length * msPerChar)
    );
    const start = performance.now();
    let noise = "";
    let noiseAt = -Infinity;
    let noiseFrom = -1;

    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const fixed = Math.floor(progress * text.length);

      if (fixed !== noiseFrom || now - noiseAt > NOISE_INTERVAL_MS) {
        noiseFrom = fixed;
        noiseAt = now;
        noise = "";
        for (let i = fixed; i < text.length; i++) {
          // 空白や記号はそのまま残す。文字組みが揺れると読みにくいため
          noise += /[A-Za-z]/.test(text[i])
            ? NOISE[(Math.random() * NOISE.length) | 0]
            : text[i];
        }
      }

      setDisplay(text.slice(0, fixed) + noise);

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(text);
        frameRef.current = null;
      }
    };

    // 初回はペイント前に一度描いて、最終文字列が露出しないようにする
    tick(start);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [text, reduced, msPerChar]);

  return <span className={className}>{display}</span>;
}
