import Link from "next/link";
import type { ReactNode } from "react";

export type PanelTone = "default" | "accent" | "alert" | "ok";
export type LedStatus = "on" | "ok" | "alert" | "off";

interface PanelProps {
  /** バー左端の識別子。"CH.01" のような短い記号を想定 */
  id?: string;
  /** バーの見出し。英字大文字が前提のデザイン */
  label?: string;
  /** バー右端の状態表示 */
  status?: string;
  led?: LedStatus;
  tone?: PanelTone;
  /** 指定すると外枠がリンクになる（ホームのミッション選択で使う） */
  href?: string;
  className?: string;
  children: ReactNode;
}

/**
 * HUD パネル。
 *
 * 角を斜めに落とした 1px 枠を出すため、外側（枠色）と内側（地の色）の
 * 二重構造にしている。clip-path が border ごと切り落としてしまうため、
 * 外側の 1px padding を枠線として見せるのが最も素直だった。
 */
export default function Panel({
  id,
  label,
  status,
  led,
  tone = "default",
  href,
  className,
  children,
}: PanelProps) {
  const hasBar = Boolean(id || label || status || led);

  const inner = (
    <div className="hud-panel__frame">
      {hasBar && (
        <div className="hud-panel__bar">
          {id && <span className="hud-panel__id">{id}</span>}
          {label && <span className="hud-panel__label">{label}</span>}
          <span className="hud-panel__ticks" />
          {status && <span className="hud-panel__status">{status}</span>}
          {led && <span className="led" data-status={led} />}
        </div>
      )}
      <div className="hud-panel__body">{children}</div>
    </div>
  );

  const classes = ["hud-panel", className].filter(Boolean).join(" ");

  if (href) {
    return (
      <Link href={href} className={classes} data-tone={tone}>
        {inner}
      </Link>
    );
  }

  return (
    <section className={classes} data-tone={tone}>
      {inner}
    </section>
  );
}
