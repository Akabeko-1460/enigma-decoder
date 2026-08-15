/**
 * エニグマの鍵を「チャットに貼れる 1 行」へ直列化する。
 *
 * 用途は身内間の暗号通信。暗号文だけ送っても相手は復号できないので、
 * 鍵をそのまま渡せる形にしておく。読めない Base64 ではなく、目で見て
 * 設定が分かる形式にした（口頭でも伝えられる）。
 *
 *   ENQ1:II-IV-V:B:BUL:HEW:ARGKOX
 *   └版  └ローター  └反 └リング └位置 └プラグボード（無しは "-"）
 */

import { ROTOR_NAMES, type EnigmaConfig } from "./enigma";

const VERSION = "ENQ1";
const FIELD_SEP = ":";
const ROTOR_SEP = "-";
const NO_PLUGBOARD = "-";
/** URL で鍵を渡すときのクエリ名 */
export const KEY_PARAM = "k";

/** 0..25 の 3 要素を "BUL" のような 3 文字へ。 */
function toLetters(values: readonly number[]): string {
  return values.map((n) => String.fromCharCode(65 + n)).join("");
}

/** "BUL" を [1, 20, 11] へ。A-Z 以外や長さ違いは null。 */
function fromLetters(text: string): [number, number, number] | null {
  if (!/^[A-Z]{3}$/.test(text)) return null;
  return [
    text.charCodeAt(0) - 65,
    text.charCodeAt(1) - 65,
    text.charCodeAt(2) - 65,
  ];
}

/** 設定を共有用の 1 行にする。 */
export function encodeKey(cfg: EnigmaConfig): string {
  const plugboard = cfg.plugboard.toUpperCase().replace(/[^A-Z]/g, "");
  return [
    VERSION,
    cfg.rotors.join(ROTOR_SEP),
    cfg.reflector,
    toLetters(cfg.rings),
    toLetters(cfg.positions),
    plugboard || NO_PLUGBOARD,
  ].join(FIELD_SEP);
}

/**
 * 共有用の 1 行を設定へ戻す。形式が違えば null。
 *
 * 受け取った文字列は人の手を経ている前提なので、前後の空白や小文字、
 * URL 全体を貼られた場合も拾えるようにしている。
 */
export function decodeKey(input: string): EnigmaConfig | null {
  const text = extractKey(input);
  if (!text) return null;

  const parts = text.split(FIELD_SEP);
  if (parts.length !== 6 || parts[0] !== VERSION) return null;

  const [, rotorField, reflectorField, ringField, positionField, plugField] = parts;

  const rotors = rotorField.split(ROTOR_SEP);
  if (rotors.length !== 3 || rotors.some((r) => !ROTOR_NAMES.includes(r))) return null;

  const reflector = reflectorField === "B" ? "B" : reflectorField === "C" ? "C" : null;
  if (reflector === null) return null;

  const rings = fromLetters(ringField);
  const positions = fromLetters(positionField);
  if (!rings || !positions) return null;

  const plugboard = decodePlugboard(plugField);
  if (plugboard === null) return null;

  return {
    rotors: rotors as [string, string, string],
    reflector,
    rings,
    positions,
    plugboard,
  };
}

/** "ARGKOX" → "AR GK OX"。"-" は結線なし。壊れていれば null。 */
function decodePlugboard(field: string): string | null {
  if (field === NO_PLUGBOARD || field === "") return "";
  if (!/^[A-Z]+$/.test(field) || field.length % 2 !== 0) return null;

  const pairs = field.match(/.{2}/g) ?? [];
  const used = new Set<string>();
  for (const pair of pairs) {
    const [a, b] = pair;
    // 自己結線と使い回しは実機にありえない
    if (a === b || used.has(a) || used.has(b)) return null;
    used.add(a);
    used.add(b);
  }
  return pairs.join(" ");
}

/** 貼られた文字列から鍵の本体を取り出す（URL 丸ごとでも可）。 */
function extractKey(input: string): string | null {
  const text = input.trim().toUpperCase();
  if (!text) return null;

  // URL ごと貼られた場合はクエリから抜く
  const fromQuery = text.match(new RegExp(`[?&]${KEY_PARAM.toUpperCase()}=([^&#\\s]+)`));
  if (fromQuery) {
    try {
      return decodeURIComponent(fromQuery[1]);
    } catch {
      return fromQuery[1];
    }
  }

  const fromText = text.match(/ENQ1(?::[^\s:]*){5}/);
  return fromText ? fromText[0] : null;
}

/** 現在地を基準にした共有 URL。ブラウザでのみ呼ぶこと。 */
export function shareUrl(cfg: EnigmaConfig): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set(KEY_PARAM, encodeKey(cfg));
  return url.toString();
}
