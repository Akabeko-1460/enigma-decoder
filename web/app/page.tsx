import Link from "next/link";
import BootSequence from "@/components/fx/BootSequence";
import GlitchText from "@/components/fx/GlitchText";
import LevelMeter from "@/components/hud/LevelMeter";
import Panel from "@/components/hud/Panel";
import StatRow from "@/components/hud/StatRow";
import styles from "./home.module.css";

/** CH.02 の入口。難易度順に並べる。 */
const MISSIONS = [
  {
    href: "/break/known-plugboard",
    name: "DECRYPT·01",
    jp: "プラグボード既知",
    level: 2,
  },
  {
    href: "/break/plugboard",
    name: "DECRYPT·02",
    jp: "プラグボード未知",
    level: 5,
  },
] as const;

export default function Home() {
  return (
    <>
      <BootSequence />

      <section className={styles.hero}>
        <p className="eyebrow">Enigma M3 · 3 rotors · Reflector B</p>
        <h1 className="display">
          <GlitchText>ENIGMA</GlitchText>
        </h1>
        <p className={styles.heroTag}>Crypto Terminal</p>
        <p className="sub">
          エニグマ M3 の暗号を作って送り合う通信卓と、暗号文だけから鍵を復元する解読機。暗号化も解析もブラウザ内で完結します。
        </p>
      </section>

      <div className={styles.missions}>
        <Panel
          id="CH.01"
          label="Transmit"
          status="READY"
          led="ok"
          tone="accent"
          href="/machine"
        >
          <div className={styles.mission}>
            <h2 className={styles.missionTitle}>TRANSMIT</h2>
            <p className={styles.missionJp}>暗号通信</p>
            <p className={styles.missionBody}>
              鍵（ローター・リング・初期位置・プラグボード）を組んで平文を暗号文に変えます。同じ鍵に通せば元に戻るので、鍵を相手に渡せばそのまま読めます。
            </p>
            <div className={styles.enter}>
              <span>通信卓を開く</span>
              <span>&rarr;</span>
            </div>
          </div>
        </Panel>

        <Panel id="CH.02" label="Cryptanalysis" status="STANDBY" led="on" tone="accent">
          <div className={styles.mission}>
            <h2 className={styles.missionTitle}>DECRYPT</h2>
            <p className={styles.missionJp}>暗号解読</p>
            <p className={styles.missionBody}>
              鍵を知らない状態から、暗号文だけで設定を割り出します。n-gram 頻度と英単語リストで平文らしさを採点し、候補を絞り込みます。
            </p>
            <div className={styles.levels}>
              {MISSIONS.map((mission) => (
                <Link key={mission.href} href={mission.href} className={styles.level}>
                  <span className={styles.levelName}>{mission.name}</span>
                  <span className={styles.levelJp}>{mission.jp}</span>
                  <span className="spacer" />
                  <LevelMeter value={mission.level} />
                  <span className="mono">&rarr;</span>
                </Link>
              ))}
            </div>
          </div>
        </Panel>
      </div>

      <div className={styles.spec}>
        <Panel id="SYS" label="Specification">
          <StatRow
            items={[
              { k: "実行場所", v: "IN-BROWSER" },
              { k: "解析コア", v: "RUST → WASM" },
              { k: "並列化", v: "WEB WORKERS" },
              { k: "言語モデル", v: "3.9M CHARS" },
              { k: "サーバー送信", v: "NONE", tone: "ok" },
            ]}
          />
          <div className={styles.footer}>
            <span>SOURCE</span>
            <a
              href="https://github.com/Akabeko-1460/enigma-decoder"
              target="_blank"
              rel="noreferrer"
            >
              github.com/Akabeko-1460/enigma-decoder
            </a>
          </div>
        </Panel>
      </div>
    </>
  );
}
