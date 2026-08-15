import BreakForm from "@/components/BreakForm";
import TypeOut from "@/components/fx/TypeOut";
import LevelMeter from "@/components/hud/LevelMeter";
import Panel from "@/components/hud/Panel";
import StatRow from "@/components/hud/StatRow";

const BRIEFING =
  "鍵が完全に未知の状態から、プラグボードを含むすべての設定を暗号文だけで復元します。" +
  "候補の絞り込みには段階スコア（IC → bigram → trigram）を使います。";

export default function PlugboardPage() {
  return (
    <>
      <p className="eyebrow">CH.02 / Mission 02 — Full Key Recovery</p>
      <h1>解読機 — プラグボード未知</h1>
      <p className="sub">
        <TypeOut text={BRIEFING} />
      </p>

      <div className="stack" style={{ marginTop: 20 }}>
        <Panel id="BRIEF" label="Mission Briefing" status="STANDBY" led="on" tone="accent">
          <StatRow
            items={[
              { k: "難易度", v: <LevelMeter value={5} /> },
              { k: "所要時間", v: "1〜60 分" },
              { k: "推奨文字数", v: "120+" },
              { k: "復元対象", v: "ALL" },
              { k: "既知情報", v: "NONE" },
            ]}
          />
        </Panel>

        <Panel id="LIMIT" label="Operational Limit" status="READ FIRST" led="alert" tone="alert">
          <p className="small" style={{ margin: 0 }}>
            暗号文が長いほど確実です。<b>120 文字以上</b>を推奨します。50〜100 字はプラグボードが少なければ解ける場合がありますが、短文かつプラグボードが多いとユニシティ距離を下回り、原理的に復元できません。プラグボードが分かっている場合は<b>ミッション 01</b>の方が短文でも精度が出ます。
          </p>
        </Panel>

        <Panel id="OPSEC" label="Execution Environment" status="LOCAL-ONLY" led="ok">
          <p className="muted small" style={{ margin: 0 }}>
            計算はブラウザ内で行われます（Rust を WebAssembly 化し、CPU コア数ぶんの Web Worker で並列実行）。暗号文がサーバーへ送られることはありません。解読中はタブを開いたままにしてください。
          </p>
        </Panel>
      </div>

      <BreakForm mode="plugboard" />
    </>
  );
}
