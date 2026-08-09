# Enigma Workbench (Web)

エニグマ M3 の暗号生成・復号と、暗号文単独の解読機を備えた Next.js アプリ。

## 画面

| ページ | 内容 | 実行場所 |
|---|---|---|
| `/machine` | 生成機・復号機（内部状態を固定）| **ブラウザ内**（TypeScript 実装のエニグマ）|
| `/break/known-plugboard` | プラグボード既知の解読 | API → Python 解読機 |
| `/break/plugboard` | プラグボード未知・最高精度の解読 | API → Python 解読機 |

- 暗号化・復号は `web/lib/enigma.ts`（`enigma.py` の忠実な移植、`AAAAA→BDZGO` で検証）で
  サーバー通信なしに即時実行。
- 解読（暗号解析）は API ルート `web/app/api/break/route.ts` が
  `web/py/solve.py` を子プロセス起動し、リポジトリ本体の Python + Rust 解読機を呼ぶ。

## 動かし方

前提: リポジトリルートで Python 解読機が動くこと。高速化のため Rust コアを推奨。

```bash
# 1) 解析エンジン（リポジトリルート）
cd ..
cd enigma_decoder && maturin build --release && pip install target/wheels/*.whl && cd ..
#   ※ Rust 未ビルドでも純Pythonで動くが遅い

# 2) Web アプリ
cd web
npm install
npm run dev        # http://localhost:3000
#   本番は npm run build && npm run start
```

環境変数 `PYTHON_BIN` で Python 実行ファイルを指定できる（既定 `python`）。

## 構成

```
web/
├── app/
│   ├── page.tsx                     ホーム
│   ├── machine/page.tsx             生成機・復号機（クライアント完結）
│   ├── break/known-plugboard/…      PB既知 解読ページ
│   ├── break/plugboard/…            PB未知 解読ページ
│   └── api/break/route.ts           解読 API（Python 子プロセス）
├── components/BreakForm.tsx         解読フォーム＋結果表示（共通）
├── lib/enigma.ts                    エニグマ M3（TypeScript 移植）
├── lib/fixedConfig.ts               固定内部状態の定義
└── py/solve.py                      Python 解読機の JSON ラッパ
```

## 注意

- 解読 API は Python 環境（と Rust 拡張）がサーバー側に必要。静的ホスティング単体では
  `/machine`（生成・復号）のみ動作する。
- プラグボード未知の解読は暗号文が長いほど確実（120 文字以上推奨）。
