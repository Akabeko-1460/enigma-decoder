"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./LogStream.module.css";
import { useReducedMotion } from "./useReducedMotion";

const MAX_LINES = 9;
const DECOR_INTERVAL_MS = 210;
const ROTORS = ["I", "II", "III", "IV", "V"];
const HEX = "0123456789ABCDEF";

interface LogLine {
  id: number;
  text: string;
  kind: "event" | "trace";
}

/**
 * 解読中に流れるログ。
 *
 * `status` が変わるたびに実イベントの行を積み、その合間に装飾行（探索の
 * トレース風）を流す。装飾行は実際の探索内容ではないので `trace` として
 * 暗い色で描き、実イベントと区別できるようにしている。
 */
export default function LogStream({
  active,
  status,
}: {
  active: boolean;
  status?: string | null;
}) {
  const reduced = useReducedMotion();
  const [lines, setLines] = useState<LogLine[]>([]);
  const idRef = useRef(0);

  // 実イベント
  useEffect(() => {
    if (!active || !status) return;
    setLines((prev) => append(prev, { id: ++idRef.current, text: status, kind: "event" }));
  }, [active, status]);

  // 装飾行
  useEffect(() => {
    if (!active || reduced) return;
    const id = setInterval(() => {
      setLines((prev) =>
        append(prev, { id: ++idRef.current, text: traceLine(), kind: "trace" })
      );
    }, DECOR_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, reduced]);

  // 停止したら片付ける
  useEffect(() => {
    if (!active) setLines([]);
  }, [active]);

  if (!active) return null;

  return (
    <div className={styles.stream} role="log" aria-live="off">
      {lines.map((line) => (
        <div key={line.id} className={styles.line} data-kind={line.kind}>
          <span className={styles.marker}>{line.kind === "event" ? "▶" : "·"}</span>
          {line.text}
        </div>
      ))}
    </div>
  );
}

function append(prev: LogLine[], line: LogLine): LogLine[] {
  const next = [...prev, line];
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

function pick<T>(arr: readonly T[]): T {
  return arr[(Math.random() * arr.length) | 0];
}

function hex(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += HEX[(Math.random() * 16) | 0];
  return s;
}

function letters(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(65 + ((Math.random() * 26) | 0));
  return s;
}

/** 探索の様子を思わせるダミー行。実データではないので trace 扱い。 */
function traceLine(): string {
  switch ((Math.random() * 3) | 0) {
    case 0:
      return `SCAN ${pick(ROTORS)}·${pick(ROTORS)}·${pick(ROTORS)}  POS ${letters(3)}  IC ${(
        0.032 + Math.random() * 0.03
      ).toFixed(4)}`;
    case 1:
      return `HEAP 0x${hex(6)}  ${Array.from({ length: 6 }, () => hex(2)).join(" ")}`;
    default:
      return `PLUG ${letters(2)}↔${letters(2)}  Δ ${(Math.random() * 2 - 1).toFixed(3)}`;
  }
}
