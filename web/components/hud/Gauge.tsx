import styles from "./Gauge.module.css";

interface GaugeProps {
  /** 0..1。範囲外は丸める */
  value: number;
  /** リング中央の大きい文字 */
  readout: string;
  /** リング下の小さいラベル */
  caption?: string;
  tone?: "cyan" | "mint" | "dim";
}

const TONE_COLOR = {
  cyan: "var(--cyan)",
  mint: "var(--mint)",
  dim: "var(--cyan-dim)",
} as const;

/** 表示サイズ(px)。SVG は 100×100 の座標系をこの寸法へ縮める。 */
const SIZE = 92;
const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** 円弧は 270 度ぶんだけ使い、下側を開けて満タンかどうかを読み取りやすくする。 */
const ARC = CIRCUMFERENCE * 0.75;
const TICKS = 28;

/** リング状ゲージ。文字数チャージと確信度の両方に使う。 */
export default function Gauge({ value, readout, caption, tone = "cyan" }: GaugeProps) {
  const ratio = Math.min(1, Math.max(0, value));
  const color = TONE_COLOR[tone];

  return (
    <div className={styles.gauge}>
      <div className={styles.ring} style={{ width: SIZE, height: SIZE }}>
        <svg viewBox="0 0 100 100" width={SIZE} height={SIZE} aria-hidden>
          <g transform={`rotate(135 50 50)`}>
            <circle
              className={styles.track}
              cx="50"
              cy="50"
              r={RADIUS}
              strokeDasharray={`${ARC} ${CIRCUMFERENCE}`}
            />
            <circle
              className={styles.fill}
              cx="50"
              cy="50"
              r={RADIUS}
              stroke={color}
              strokeDasharray={`${ARC * ratio} ${CIRCUMFERENCE}`}
              style={{ filter: `drop-shadow(0 0 6px ${color})` }}
            />
          </g>
          <g className={styles.ticks}>
            {Array.from({ length: TICKS }, (_, i) => {
              const progress = i / (TICKS - 1);
              const lit = progress <= ratio;
              return (
                <line
                  key={i}
                  x1="50"
                  y1="3"
                  x2="50"
                  y2="8"
                  stroke={lit ? color : "var(--cyan-deep)"}
                  opacity={lit ? 0.9 : 0.3}
                  transform={`rotate(${135 + progress * 270} 50 50)`}
                />
              );
            })}
          </g>
        </svg>
        <div className={styles.center}>
          <span className={styles.readout} style={{ color }}>
            {readout}
          </span>
        </div>
      </div>
      {caption && <span className={styles.caption}>{caption}</span>}
    </div>
  );
}
