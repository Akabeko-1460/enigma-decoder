import Link from "next/link";

export default function Home() {
  return (
    <div>
      <h1>Enigma Workbench</h1>
      <p className="sub">
        エニグマ M3（陸軍3ローター式・リフレクター B）の暗号を作って解く Web ツール。
        暗号化・復号も暗号文単独の解読も、すべてあなたのブラウザ内で完結します
        （解析エンジンは Rust を WebAssembly 化したもの）。
      </p>

      <div className="hero-links">
        <Link href="/machine" className="card">
          <h3>① 生成機・復号機（内部状態 固定）</h3>
          <p>
            あらかじめ固定した内部状態で、平文 → 暗号文、暗号文 → 平文を相互変換。
            設定を知っていれば一瞬で復号できることを体験できます。
          </p>
        </Link>
        <Link href="/break/known-plugboard" className="card">
          <h3>② 解読機（プラグボード既知）</h3>
          <p>
            プラグボード配線が判明している前提で、ローター・位置・リングを
            暗号文だけから復元。数秒で終わります。
          </p>
        </Link>
        <Link href="/break/plugboard" className="card">
          <h3>③ 解読機（プラグボード未知）</h3>
          <p>
            全設定が未知の状態から、段階スコア（IC→bigram→trigram）で
            プラグボードごと復元。精度を 3 段階から選べます。
          </p>
        </Link>
        <a
          href="https://github.com/Akabeko-1460/enigma-decoder"
          className="card"
          target="_blank"
          rel="noreferrer"
        >
          <h3>リポジトリ</h3>
          <p>
            解析エンジン本体（Python + Rust/PyO3/Rayon）と、この Web アプリの
            ソースコード。アルゴリズムの詳細は README を参照。
          </p>
        </a>
      </div>

      <h2>仕組み</h2>
      <div className="card">
        <table className="kv">
          <tbody>
            <tr>
              <td className="k">暗号化 / 復号</td>
              <td>
                TypeScript 実装のエニグマをブラウザ内で実行（サーバー通信なし・即時）。
              </td>
            </tr>
            <tr>
              <td className="k">解読（暗号解析）</td>
              <td>
                Rust 製の解析コアを WebAssembly 化し、CPU コア数ぶんの Web Worker で
                並列実行します。暗号文はサーバーへ送られません。
              </td>
            </tr>
            <tr>
              <td className="k">言語モデル</td>
              <td>
                約 390 万字のコーパスから作った n-gram 頻度表＋英単語リストで
                「平文らしさ」を評価。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
