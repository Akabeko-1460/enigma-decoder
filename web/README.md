# Enigma Workbench (Web)

エニグマ M3 の暗号生成・復号と、暗号文単独の解読機を備えた Next.js アプリ。
**解読を含めてすべてブラウザ内で完結する**ので、静的ホスティング（Vercel 等）に
そのまま載る。暗号文はサーバーへ送られない。

## 画面

| ページ | 内容 | 実行場所 |
|---|---|---|
| `/machine` | 生成機・復号機（内部状態を固定）| ブラウザ内（TypeScript 実装のエニグマ）|
| `/break/known-plugboard` | プラグボード既知の解読 | ブラウザ内（WASM × Web Worker）|
| `/break/plugboard` | プラグボード未知の解読（精度3段階）| ブラウザ内（WASM × Web Worker）|

## アーキテクチャ

解析コアは Rust 1 本で、ネイティブ（PyO3 + Rayon）とブラウザ（wasm-bindgen）の
2 つの入口を持つ。アルゴリズムは `enigma_decoder/src/core.rs` に集約されており、
違いは並列化の方法だけ。

```
enigma_decoder/src/
├── core.rs       アルゴリズム本体（プラットフォーム非依存）
├── langmodel.rs  n-gram 言語モデル・単語照合（scoring.py の移植）
├── lib.rs        PyO3 + Rayon 版（feature = "python", ローカル CLI 用）
└── wasm.rs       wasm-bindgen 版（feature = "wasm", ブラウザ用）

web/lib/solver/
├── pipeline.ts   全体進行（attack_plugboard / attack_known_plugboard の移植）
├── pool.ts       Web Worker プール（Rayon の代わり）
├── worker.ts     ワーカー本体（WASM インスタンスを 1 つ持つ）
├── assets.ts     言語データの取得と gzip 展開
└── types.ts      共有型・変換ユーティリティ
```

**並列化**: `wasm-bindgen-rayon` は nightly Rust と COOP/COEP ヘッダを要求するため
使っていない。代わりに CPU コア数（最大 8）ぶんの Web Worker を立て、各ワーカーが
独立した WASM インスタンスを持つ。Rayon が並列化していた粒度（Phase A はローター順、
Phase C は候補）をそのままワーカーへ配るので、分割の仕方で結果は変わらない。

ただし SA の乱数シードは候補の通し番号から決まるため、シャードには
**全体での位置**（`baseIndex`）を渡す必要がある。

**言語データ**（`public/data/`, 計 約250KB）は `python tools/build_web_assets.py` で生成。
各ワーカーが起動時に読み込んで密配列を組む。

## 開発

```bash
npm install
npm run dev            # http://localhost:3000

npm run build:wasm     # Rust → WASM（Rust ツールチェーンが要る。下記）
npm run verify:wasm    # WASM が Python と同じ結果を出すか検証（ブラウザ不要）
npm run build          # 本番ビルド
```

`npm run build:wasm` の前提:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

生成物（`lib/wasm/*.js`, `lib/wasm/*.d.ts`, `public/wasm/*.wasm`）は
**コミットする**。Vercel のビルド環境に Rust が無いため。

## PB未知解読の精度レベル

`/break/plugboard` のセレクタで探索の広さを選べる。定義は
[`lib/breakLevels.ts`](lib/breakLevels.ts)。

| 値 | 表示 | 探索幅（長文 / 150字未満 / 80字未満）| 目安 |
|---|---|---|---|
| `normal` | 通常（速い）| 300 / 300 / 900 | 10 秒〜1 分 |
| `accuracy` | 精度（既定）| 1000 / 1000 / 3000 | 1〜3 分 |
| `thorough` | 徹底（非常に遅い）| 3000 / 3000 / 9000 | 10 分〜1 時間 |

目安は 8 ワーカー環境での実測に基づく（4ペア・157字・精度モードで 84 秒）。

### Python 版との違い（意図的）

Python 側 `decrypt_plugboard.MODE_PARAMS` は Phase A の保持数（`top_n`）と
Phase C の実行数（`max_candidates`）が別で、後者が小さい。そのため
**捕捉できているのに評価されない候補**が出る。

実測: 131字・3ペアで正解は Phase A の 537 位に居たが、`max_candidates=200` に
切られて解読失敗。その候補だけを Phase C に通すと 131/131 完全復元する。

ブラウザ版はサーバーの実行時間上限が無く並列度も上げられるので、この 2 つを
`breadth` 1 本に統合し「残した候補は全部評価する」ことにしている。
CLI 側は従来どおりの値のまま（速度重視）。

## Vercel へのデプロイ

1. Vercel のプロジェクト設定で **Root Directory を `web`** にする（リポジトリ直下ではない）。
2. Framework は Next.js が自動検出される。ビルドコマンドの変更は不要。
3. 環境変数は不要。`ENABLE_PYTHON_API` は**設定しない**こと（下記）。

WASM とデータは `public/` から静的配信されるだけなので、追加設定は要らない。
`wasm-bindgen-rayon` を使っていないので COOP/COEP ヘッダも不要。

## ローカル専用の Python 経路

`app/api/break/route.ts` はリポジトリ本体の Python + Rust 解読機を子プロセスで
呼ぶ経路。native Rayon のほうが速いので、手元で長時間の徹底探索を回すときに使う。

既定では無効（501 を返す）。有効にするには両方を設定して `npm run dev`:

```bash
ENABLE_PYTHON_API=1            # サーバー側: API を有効化
NEXT_PUBLIC_ENABLE_PYTHON_API=1 # クライアント側: UI に切替チェックボックスを出す
PYTHON_BIN=py                   # python コマンドが無い環境（Windows 等）
```

Vercel には Python も Rust 拡張も無いため、本番では有効にしないこと。
