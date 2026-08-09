import BreakForm from "@/components/BreakForm";

export default function KnownPlugboardPage() {
  return (
    <div>
      <h1>解読機 — プラグボード既知</h1>
      <p className="sub">
        プラグボード配線が判明している前提で、ローター・初期位置・リング設定を
        暗号文だけから復元します。プラグボードが既知だと探索空間が大幅に減るため、
        短文でも高精度・高速に解読できます（Rust+Rayon 並列）。
      </p>
      <BreakForm mode="known_plugboard" />
    </div>
  );
}
