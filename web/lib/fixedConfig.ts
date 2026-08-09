import type { EnigmaConfig } from "./enigma";

/**
 * 「てきとうに固定した」エニグマ内部状態。
 *
 * 生成機と復号機はこの同一設定を共有する。エニグマは対合的なので、
 * 同じ設定で暗号文をもう一度通せば平文に戻る。
 * 友人間のカジュアル通信を想定した 3 ペアのプラグボード。
 */
export const FIXED_CONFIG: EnigmaConfig = {
  rotors: ["II", "IV", "V"],
  reflector: "B",
  rings: [1, 20, 11], // B U L
  positions: [7, 4, 22], // H E W
  plugboard: "AR GK OX",
};

/** 表示用に設定を人間可読な文字列へ整形する。 */
export function describeConfig(cfg: EnigmaConfig): {
  rotors: string;
  reflector: string;
  rings: string;
  positions: string;
  plugboard: string;
} {
  const toLetters = (arr: number[]) =>
    arr.map((n) => String.fromCharCode(65 + n)).join(" ");
  return {
    rotors: cfg.rotors.join(" - "),
    reflector: cfg.reflector,
    rings: `${toLetters(cfg.rings)}  (${cfg.rings.join(", ")})`,
    positions: `${toLetters(cfg.positions)}  (${cfg.positions.join(", ")})`,
    plugboard: cfg.plugboard || "(なし)",
  };
}
