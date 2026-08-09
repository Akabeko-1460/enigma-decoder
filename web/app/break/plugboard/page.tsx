import BreakForm from "@/components/BreakForm";

export default function PlugboardPage() {
  return (
    <div>
      <h1>解読機 — プラグボード未知（最高精度）</h1>
      <p className="sub">
        全設定が未知の状態から、ローター・位置・リング・プラグボードのすべてを
        暗号文だけで復元します。プラグボード復元には段階スコア
        （IC → bigram → trigram）を用いる最高精度モードです。
        暗号解析の中で最も難しいシナリオのため、10〜60 秒ほどかかります。
      </p>
      <div className="card" style={{ borderColor: "var(--accent-2)" }}>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          <b style={{ color: "var(--accent-2)" }}>目安</b>：プラグボード未知の解読は
          暗号文が長いほど確実です。<b>120 文字以上</b>を推奨します。
          50〜100 字はプラグボード数が少なければ解ける場合がありますが、
          短文＋多プラグはユニシティ距離を下回り原理的に不安定です。
          （プラグボードが分かっている場合は「PB既知」ページの方が短文でも高精度です）
        </p>
      </div>
      <BreakForm mode="plugboard" />
    </div>
  );
}
