import BreakForm from "@/components/BreakForm";

export default function KnownPlugboardPage() {
  return (
    <div>
      <h1>解読機 — プラグボード既知</h1>
      <p className="sub">
        プラグボード配線が判明している前提で、ローター・初期位置・リング設定を
        暗号文だけから復元します。プラグボードが既知だと探索空間が大幅に減るため、
        短文でも高精度・高速に解読できます（数秒程度）。
      </p>
      <div className="card">
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          計算はすべて<b>あなたのブラウザ内</b>で行われます（Rust を WebAssembly 化し、
          CPU コア数ぶんの Web Worker で並列実行）。暗号文がサーバーへ送られることは
          ありません。
        </p>
      </div>
      <BreakForm mode="known_plugboard" />
    </div>
  );
}
