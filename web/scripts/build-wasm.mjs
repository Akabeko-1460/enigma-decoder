/**
 * WASM 解読エンジンをビルドして配置する。
 *
 *   npm run build:wasm
 *
 * wasm-pack の出力（JS グルー・型定義）は web/lib/wasm/ に置き、実行時に
 * 読み込む .wasm 本体だけ web/public/wasm/ へコピーする。バンドラの wasm
 * 解決に頼らず固定 URL で取得するため。
 *
 * 前提: rustup target add wasm32-unknown-unknown / cargo install wasm-pack
 * 生成物はコミットする（Vercel のビルド環境に Rust が無いため）。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = path.resolve(WEB, "..", "enigma_decoder");
const OUT_DIR = path.join(WEB, "lib", "wasm");
const PUBLIC_WASM = path.join(WEB, "public", "wasm");
const WASM_NAME = "enigma_decoder_bg.wasm";

/**
 * wasm-pack は毎回 out-dir に「全部無視」の .gitignore を書く。
 * JS グルーと型定義はコミットしないと Vercel でビルドできないので上書きし直す。
 */
const GITIGNORE = `# wasm-pack が生成する成果物。Vercel のビルド環境には Rust が無いため、
# JS グルーと型定義は「コミットする」必要がある（＝ここでは無視しない）。
#
# .wasm 本体だけは public/wasm/ 側を配信に使うので、この場所のコピーは除外する。
# 再生成は web/ で \`npm run build:wasm\`（このファイルも書き直される）。
${WASM_NAME}
package.json
`;

execFileSync(
  process.platform === "win32" ? "wasm-pack.exe" : "wasm-pack",
  ["build", "--target", "web", "--out-dir", OUT_DIR, "--release",
   "--", "--no-default-features", "--features", "wasm"],
  { cwd: CRATE, stdio: "inherit" }
);

fs.mkdirSync(PUBLIC_WASM, { recursive: true });
fs.copyFileSync(path.join(OUT_DIR, WASM_NAME), path.join(PUBLIC_WASM, WASM_NAME));
fs.writeFileSync(path.join(OUT_DIR, ".gitignore"), GITIGNORE);

const sizeKb = (fs.statSync(path.join(PUBLIC_WASM, WASM_NAME)).size / 1024).toFixed(1);
console.log(`\npublic/wasm/${WASM_NAME} を更新しました (${sizeKb} KB)`);
