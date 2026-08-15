"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import SoundToggle from "./SoundToggle";

/**
 * 上部ナビ。用途 2 系統（通信 / 解読）が並びで分かるよう英名を主にしている。
 * ロゴは置かず、左端をナビ、右端を音量トグルにしている。
 * トップへ戻る導線はナビの HOME が担う。
 */
const NAV = [
  { href: "/", en: "HOME", jp: "司令室" },
  { href: "/machine", en: "TRANSMIT", jp: "暗号通信" },
  { href: "/break/known-plugboard", en: "DECRYPT·01", jp: "PB既知" },
  { href: "/break/plugboard", en: "DECRYPT·02", jp: "PB未知" },
] as const;

export default function TopBar() {
  const pathname = usePathname();

  return (
    <header className="topbar">
      <div className="topbar__inner">
        <nav className="topbar__nav">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="topbar__link"
              data-active={isActive(pathname, item.href)}
            >
              {item.en}
              <span className="faint tiny">{item.jp}</span>
            </Link>
          ))}
        </nav>
        <div className="spacer" />
        <SoundToggle />
      </div>
    </header>
  );
}

/** ルートだけは完全一致で判定する（全ページが "/" で始まるため）。 */
function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
