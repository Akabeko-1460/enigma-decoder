import type { Metadata, Viewport } from "next";
import { Chakra_Petch, JetBrains_Mono, Orbitron } from "next/font/google";
import Backdrop from "@/components/hud/Backdrop";
import StatusBar from "@/components/hud/StatusBar";
import TopBar from "@/components/hud/TopBar";
import "./globals.css";

/**
 * 書体は 3 系統。日本語は Google Fonts から取らない
 * （next/font は日本語サブセットに対応せず全ウェイト取得になるため）。
 * 日本語はシステムスタックに任せ、ラテン部分の書体で世界観を作る。
 */
const display = Orbitron({
  subsets: ["latin"],
  weight: ["700", "900"],
  variable: "--font-display",
  display: "swap",
});

const ui = Chakra_Petch({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ENIGMA // M3 CRYPTO TERMINAL",
  description:
    "エニグマ M3 の暗号を仲間と作って送り合い、暗号文だけを手がかりに解読する Web ターミナル。暗号化も解析もすべてブラウザ内で完結します。",
  applicationName: "ENIGMA",
};

/** モバイルのブラウザ枠まで暗くして、画面の地色と繋げる。 */
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#03070b",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={`${display.variable} ${ui.variable} ${mono.variable}`}>
      <body>
        <Backdrop />
        <TopBar />
        <main className="container">{children}</main>
        <StatusBar />
      </body>
    </html>
  );
}
