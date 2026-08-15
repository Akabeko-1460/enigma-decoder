"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import styles from "./RotorDrum.module.css";

/** スロット風スピンの長さ */
const SPIN_MS = 720;
/** 帯を何周ぶん並べるか。中央の周を映すので端でも隣が途切れない */
const LAPS = 3;

interface RotorDrumProps {
  options: readonly string[];
  /** options のインデックス */
  value: number;
  /** 省略すると読み取り専用になる */
  onChange?: (next: number) => void;
  /** 窓の下に出す短いラベル（L / M / R など） */
  caption?: string;
  /** 値を変えると同時にこの値も変えるとスロット風に回る */
  spinNonce?: number;
  tone?: "cyan" | "violet" | "mint";
}

/**
 * ローター表示器。
 *
 * 帯を 3 周ぶん並べて中央の複製を映すことで、端（Z→A）でも上下の隣が
 * 途切れない。周回をまたぐと長い距離を回るが、それが「ドラムが回った」
 * 手応えになるので意図的にそのままにしている。
 *
 * コマの高さは CSS 側（--row）が持ち、画面幅に応じて変わる。JS は映すコマの
 * 番号（--index）だけを渡し、移動量の計算は CSS の calc に任せる。
 */
export default function RotorDrum({
  options,
  value,
  onChange,
  caption,
  spinNonce,
  tone = "cyan",
}: RotorDrumProps) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [isSpinning, setIsSpinning] = useState(false);
  const isEditable = typeof onChange === "function";

  function step(delta: number) {
    if (!onChange) return;
    const count = options.length;
    onChange((((value + delta) % count) + count) % count);
  }

  // ホイールのリスナは張り替えたくないので、最新の step を ref 経由で見る
  const stepRef = useRef(step);
  stepRef.current = step;

  // スロット風スピン。nonce が変わったあいだだけ演出を強くする
  useEffect(() => {
    if (spinNonce === undefined) return;
    setIsSpinning(true);
    const id = setTimeout(() => setIsSpinning(false), SPIN_MS);
    return () => clearTimeout(id);
  }, [spinNonce]);

  // React の wheel はパッシブで preventDefault が効かないため直接張る
  useEffect(() => {
    const el = windowRef.current;
    if (!el || !isEditable) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stepRef.current(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isEditable]);

  // 中央の周にある現在値を映す
  const centerIndex = value + options.length;

  return (
    <div className={styles.drum} data-tone={tone}>
      {isEditable && (
        <button
          type="button"
          className={styles.nudge}
          onClick={() => step(-1)}
          aria-label="ひとつ戻す"
        >
          ▲
        </button>
      )}

      <div
        ref={windowRef}
        className={styles.window}
        style={{ "--index": centerIndex } as CSSProperties}
        data-editable={isEditable}
        data-spinning={isSpinning}
        role={isEditable ? "spinbutton" : undefined}
        aria-valuetext={options[value]}
        aria-label={caption}
        tabIndex={isEditable ? 0 : undefined}
        onClick={isEditable ? () => step(1) : undefined}
        onKeyDown={
          isEditable
            ? (e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  step(-1);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  step(1);
                }
              }
            : undefined
        }
      >
        <div className={styles.strip}>
          {Array.from({ length: LAPS }, (_, lap) =>
            options.map((option, i) => (
              <span
                key={`${lap}:${option}`}
                className={styles.cell}
                data-current={lap === 1 && i === value}
              >
                {option}
              </span>
            ))
          )}
        </div>
        <div className={styles.glass} />
      </div>

      {isEditable && (
        <button
          type="button"
          className={styles.nudge}
          onClick={() => step(1)}
          aria-label="ひとつ進める"
        >
          ▼
        </button>
      )}

      {caption && <span className={styles.caption}>{caption}</span>}
    </div>
  );
}
