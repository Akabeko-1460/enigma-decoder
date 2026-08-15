import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

/*
 * eslint-config-next 15.5 は eslintrc 形式のままなので、FlatCompat を挟んで
 * flat config から読み込む（create-next-app が生成するのと同じ形）。
 */
const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [
      ".next/**",
      "next-env.d.ts",
      // wasm-pack と build_web_assets.py の生成物。手で直す対象ではない
      "lib/wasm/**",
      "public/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
