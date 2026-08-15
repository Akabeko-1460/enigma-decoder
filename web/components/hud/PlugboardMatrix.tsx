"use client";

import { useMemo, useState } from "react";
import { formatPlugboard, parsePlugboard } from "@/lib/solver/types";
import { KEY_ROWS as ROWS } from "./keyRows";
import styles from "./PlugboardMatrix.module.css";

/**
 * 盤面の幾何。SVG の座標系として持ち、画面には比率で配置する
 * （実寸で組むと狭い画面で横スクロールが必要になるため）。
 */
const CELL = 30;
const GAP = 5;
const PITCH = CELL + GAP;
const WIDTH = ROWS[0].length * PITCH - GAP;
const BOARD_H = ROWS.length * PITCH - GAP;
/** ケーブルが盤の下へ垂れるぶんの余地 */
const SAG_ROOM = 28;
const TOTAL_H = BOARD_H + SAG_ROOM;
const MAX_PAIRS = 13;

/** 文字 → 盤面上の中心座標（SVG 座標系）。 */
const CENTERS: Record<string, { x: number; y: number }> = {};
/** 文字 → ソケットの左上（％。CSS の絶対配置に使う）。 */
const SLOTS: Record<string, { left: number; top: number }> = {};

ROWS.forEach((row, rowIndex) => {
  const rowWidth = row.length * PITCH - GAP;
  const rowLeft = (WIDTH - rowWidth) / 2;
  [...row].forEach((ch, colIndex) => {
    const x = rowLeft + colIndex * PITCH;
    const y = rowIndex * PITCH;
    CENTERS[ch] = { x: x + CELL / 2, y: y + CELL / 2 };
    SLOTS[ch] = { left: (x / WIDTH) * 100, top: (y / TOTAL_H) * 100 };
  });
});

const SOCKET_W = (CELL / WIDTH) * 100;
const SOCKET_H = (CELL / TOTAL_H) * 100;

interface PlugboardMatrixProps {
  /** "AR GK OX" 形式 */
  value: string;
  /** 省略すると読み取り専用 */
  onChange?: (next: string) => void;
}

/**
 * プラグボード盤。
 *
 * 文字を 2 つ続けて押すと結線、結線済みを押すと解除。値は "AR GK OX" 形式の
 * 文字列のまま受け渡しし、内部では lib/solver/types の parse/format を使う。
 * 入力欄と併置しても双方向ループにならないよう、盤は文字列を解釈するだけで
 * 解釈結果を親へ書き戻さない（変更操作のときだけ onChange する）。
 */
export default function PlugboardMatrix({ value, onChange }: PlugboardMatrixProps) {
  const [armed, setArmed] = useState<string | null>(null);
  const isEditable = typeof onChange === "function";

  const wiring = useMemo(() => parsePlugboard(value), [value]);

  // 結線を 1 ペア 1 件に畳む（置換表は A→R と R→A の両方を持つため）
  const pairs = useMemo(() => {
    const found: [string, string][] = [];
    for (let i = 0; i < 26; i++) {
      const partner = wiring[i];
      if (partner !== i && i < partner) {
        found.push([String.fromCharCode(65 + i), String.fromCharCode(65 + partner)]);
      }
    }
    return found;
  }, [wiring]);

  const isFull = pairs.length >= MAX_PAIRS;

  function emitWiring(next: Uint8Array) {
    onChange?.(formatPlugboard(next));
  }

  function handlePress(ch: string) {
    if (!isEditable) return;
    const index = ch.charCodeAt(0) - 65;
    const next = Uint8Array.from(wiring);

    // 結線済みなら解除。掴んでいた線も手放す
    if (next[index] !== index) {
      const partner = next[index];
      next[partner] = partner;
      next[index] = index;
      setArmed(null);
      emitWiring(next);
      return;
    }

    if (armed === null) {
      if (!isFull) setArmed(ch);
      return;
    }

    if (armed === ch) {
      setArmed(null);
      return;
    }

    const from = armed.charCodeAt(0) - 65;
    next[from] = index;
    next[index] = from;
    setArmed(null);
    emitWiring(next);
  }

  return (
    <div className={styles.board}>
      <div className={styles.stage}>
        <div
          className={styles.grid}
          style={{ aspectRatio: `${WIDTH} / ${TOTAL_H}` }}
        >
          <svg
            className={styles.cables}
            viewBox={`0 0 ${WIDTH} ${TOTAL_H}`}
            preserveAspectRatio="xMidYMid meet"
            aria-hidden
          >
            {pairs.map(([a, b], i) => (
              <path
                key={`${a}${b}`}
                d={cablePath(a, b)}
                className={styles.cable}
                /* stroke ではなく color に入れる。glow の currentColor と揃えるため */
                style={{ color: cableColor(i) }}
              />
            ))}
          </svg>

          {Object.entries(SLOTS).map(([ch, slot]) => {
            const index = ch.charCodeAt(0) - 65;
            const isWired = wiring[index] !== index;
            return (
              <button
                key={ch}
                type="button"
                className={styles.socket}
                style={{
                  left: `${slot.left}%`,
                  top: `${slot.top}%`,
                  width: `${SOCKET_W}%`,
                  height: `${SOCKET_H}%`,
                }}
                data-wired={isWired}
                data-armed={armed === ch}
                data-editable={isEditable}
                disabled={!isEditable}
                onClick={() => handlePress(ch)}
                aria-pressed={isWired}
                aria-label={
                  isWired
                    ? `${ch} は ${String.fromCharCode(65 + wiring[index])} と結線済み`
                    : ch
                }
              >
                {ch}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.meta}>
        <span className={styles.count} data-full={isFull}>
          {String(pairs.length).padStart(2, "0")} / {MAX_PAIRS} PAIRS
        </span>
        <span className={styles.hint}>
          {!isEditable
            ? "読み取り専用"
            : armed
              ? `${armed} の接続先を選択`
              : isFull
                ? "上限に達しています"
                : "2 文字を続けて押すと結線"}
        </span>
        {isEditable && pairs.length > 0 && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setArmed(null);
              onChange?.("");
            }}
          >
            全解除
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * ソケット間を下方向にたわませたケーブル。距離が長いほど深く垂らすが、
 * 描画域からはみ出さないよう制御点の落差を抑える
 * （3次ベジェの実際のたわみは制御点の 3/4 程度に収まる）。
 */
function cablePath(a: string, b: string): string {
  const from = CENTERS[a];
  const to = CENTERS[b];
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const sag = Math.min(SAG_ROOM * 1.33, 14 + distance * 0.12);
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + sag}, ${to.x} ${to.y + sag}, ${to.x} ${to.y}`;
}

/** 線が重なっても追えるよう、水色〜青の範囲で色相をずらす。 */
function cableColor(i: number): string {
  return `hsl(${168 + ((i * 43) % 44)} 100% 62%)`;
}
