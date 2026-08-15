import BreakForm from "@/components/BreakForm";
import TypeOut from "@/components/fx/TypeOut";
import LevelMeter from "@/components/hud/LevelMeter";
import Panel from "@/components/hud/Panel";
import StatRow from "@/components/hud/StatRow";

const BRIEFING =
  "プラグボード配線が判明している前提で、ローター・初期位置・リング設定を暗号文だけから復元します。";

export default function KnownPlugboardPage() {
  return (
    <>
      <p className="eyebrow">CH.02 / Mission 01 — Partial Key Recovery</p>
      <h1>解読機 — プラグボード既知</h1>
      <p className="sub">
        <TypeOut text={BRIEFING} />
      </p>

      <div className="stack" style={{ marginTop: 20 }}>
        <Panel id="BRIEF" label="Mission Briefing" status="STANDBY" led="on" tone="accent">
          <StatRow
            items={[
              { k: "難易度", v: <LevelMeter value={2} /> },
              { k: "所要時間", v: "数秒", tone: "ok" },
              { k: "推奨文字数", v: "20+" },
              { k: "復元対象", v: "ROTOR / POS / RING" },
              { k: "既知情報", v: "PLUGBOARD", tone: "ok" },
            ]}
          />
        </Panel>

        <Panel id="OPSEC" label="Execution Environment" status="LOCAL-ONLY" led="ok">
          <p className="muted small" style={{ margin: 0 }}>
            計算はブラウザ内で行われます（Rust を WebAssembly 化し、CPU コア数ぶんの Web Worker で並列実行）。暗号文がサーバーへ送られることはありません。
          </p>
        </Panel>
      </div>

      <BreakForm mode="known_plugboard" />
    </>
  );
}
