import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Enigma Workbench",
  description:
    "エニグマ M3 の暗号生成・復号と、暗号文単独の解読機（クリブなし）を備えた Web ツール。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header className="site">
          <div className="inner">
            <span className="logo">⚙︎ Enigma Workbench</span>
            <nav>
              <Link href="/">ホーム</Link>
              <Link href="/machine">生成機・復号機</Link>
              <Link href="/break/known-plugboard">解読: PB既知</Link>
              <Link href="/break/plugboard">解読: PB未知</Link>
            </nav>
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
