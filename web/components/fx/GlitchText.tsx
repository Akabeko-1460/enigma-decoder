/**
 * RGB ずれのグリッチを掛けた文字。
 *
 * 実体は globals.css の `.glitch`。疑似要素が `data-text` を複製して
 * ずらすので、子は必ず素の文字列にすること（要素を入れても複製されない）。
 */
export default function GlitchText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span
      className={["glitch", className].filter(Boolean).join(" ")}
      data-text={children}
    >
      {children}
    </span>
  );
}
