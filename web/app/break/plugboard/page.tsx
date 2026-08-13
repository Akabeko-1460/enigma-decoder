import BreakForm from "@/components/BreakForm";

export default function PlugboardPage() {
  return (
    <div>
      <h1>解読機 — プラグボード未知</h1>
      <p className="sub">
        全設定が未知の状態から、ローター・位置・リング・プラグボードのすべてを
        暗号文だけで復元します。プラグボード復元には段階スコア
        （IC → bigram → trigram）を使います。暗号解析の中で最も難しいシナリオで、
        計算量も大きいため、精度（探索の広さ）を 3 段階から選べます。
      </p>
      <div className="card" style={{ borderColor: "var(--accent-2)" }}>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          <b style={{ color: "var(--accent-2)" }}>目安</b>：暗号文が長いほど確実です。
          <b>120 文字以上</b>を推奨します。50〜100 字はプラグボード数が少なければ
          解ける場合がありますが、短文＋多プラグはユニシティ距離を下回り原理的に
          不安定です。（プラグボードが分かっている場合は「PB既知」ページの方が
          短文でも高精度です）
        </p>
      </div>
      <div className="card">
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          計算はすべて<b>あなたのブラウザ内</b>で行われます（Rust を WebAssembly 化し、
          CPU コア数ぶんの Web Worker で並列実行）。暗号文がサーバーへ送られることは
          ありません。解読中はタブを開いたままにしてください。
        </p>
      </div>
      <BreakForm mode="plugboard" />
    </div>
  );
}
