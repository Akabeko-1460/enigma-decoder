"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./useReducedMotion";

interface TypeOutProps {
  text: string;
  className?: string;
  /** 1 文字あたりの間隔 */
  msPerChar?: number;
}

/**
 * タイプライター表示。ブリーフィング文に使う。
 *
 * 文字数ぶん setTimeout を積むと重いので、経過時間から表示文字数を
 * 逆算する rAF ループにしている。
 */
export default function TypeOut({ text, className, msPerChar = 16 }: TypeOutProps) {
  const reduced = useReducedMotion();
  const [shownCount, setShownCount] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) {
      setShownCount(text.length);
      return;
    }

    setShownCount(0);
    const start = performance.now();

    const tick = (now: number) => {
      const shown = Math.min(text.length, Math.floor((now - start) / msPerChar));
      setShownCount(shown);
      if (shown < text.length) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        frameRef.current = null;
      }
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [text, reduced, msPerChar]);

  return (
    <span className={className}>
      {text.slice(0, shownCount)}
      {shownCount < text.length && <span className="caret" aria-hidden />}
    </span>
  );
}
