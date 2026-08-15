import type { Progress } from "@/lib/solver/types";
import styles from "./PhaseTracker.module.css";

export interface PhaseStep {
  key: Progress["phase"];
  en: string;
  jp: string;
}

/**
 * 解読の進行段。
 *
 * どの段を通るかはモードで違う（PB既知は Phase C を飛ばす）ので、
 * 並びは呼び出し側から渡す。現在段より前は点灯、現在段は脈動、後は消灯。
 */
export default function PhaseTracker({
  steps,
  current,
}: {
  steps: readonly PhaseStep[];
  current: Progress["phase"] | null;
}) {
  const activeIndex = current === null ? -1 : steps.findIndex((s) => s.key === current);

  return (
    <ol className={styles.track}>
      {steps.map((step, i) => (
        <li
          key={step.key}
          className={styles.step}
          data-state={stateOf(i, activeIndex)}
          aria-current={i === activeIndex ? "step" : undefined}
        >
          <span className={styles.marker} />
          <span className={styles.en}>{step.en}</span>
          <span className={styles.jp}>{step.jp}</span>
        </li>
      ))}
    </ol>
  );
}

function stateOf(index: number, activeIndex: number): "done" | "active" | "pending" {
  if (activeIndex < 0 || index > activeIndex) return "pending";
  return index < activeIndex ? "done" : "active";
}
