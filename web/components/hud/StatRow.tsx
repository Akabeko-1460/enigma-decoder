import type { ReactNode } from "react";

export interface StatItem {
  k: string;
  v: ReactNode;
  tone?: "cyan" | "plain" | "ok";
}

/** ラベル + 値を等幅で横並びにする計器風のブロック。 */
export default function StatRow({ items }: { items: StatItem[] }) {
  return (
    <div className="statrow">
      {items.map((item) => (
        <div className="stat" key={item.k}>
          <span className="stat__k">{item.k}</span>
          <span className="stat__v" data-tone={item.tone ?? "cyan"}>
            {item.v}
          </span>
        </div>
      ))}
    </div>
  );
}
