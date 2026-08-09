import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // API ルートで Python 解読機を子プロセス起動するため、
  // ルート実行を Node.js ランタイムに固定する（後述の各 route で runtime 指定）。
  reactStrictMode: true,
};

export default nextConfig;
