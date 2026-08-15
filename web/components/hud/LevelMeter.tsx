const STEPS = 5;

/** 難易度の目盛り。点灯した本数で 5 段階を示す。 */
export default function LevelMeter({ value }: { value: number }) {
  const lit = Math.min(STEPS, Math.max(0, value));
  return (
    <span className="levelmeter" title={`難易度 ${lit} / ${STEPS}`}>
      {Array.from({ length: STEPS }, (_, i) => (
        <i key={i} data-lit={i < lit} />
      ))}
    </span>
  );
}
