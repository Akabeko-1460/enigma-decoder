/**
 * エニグマ M3 シミュレータ（TypeScript 版）。
 *
 * enigma.py の忠実な移植。ローター I-V、リフレクター B/C、
 * ダブルステッピングのアノマリも同一に実装している。
 * 既知ベクトル AAAAA → BDZGO（rotors I,II,III / reflector B / rings 0 / pos 0）で検証。
 */

// 各ローターの [配線, ノッチ文字]
export const ROTORS: Record<string, [string, string]> = {
  I: ["EKMFLGDQVZNTOWYHXUSPAIBRCJ", "Q"],
  II: ["AJDKSIRUXBLHWTMCQGZNPYFVOE", "E"],
  III: ["BDFHJLCPRTXVZNYEIWGAKMUSQO", "V"],
  IV: ["ESOVPZJAYQUIRHXLNFTGKDCMWB", "J"],
  V: ["VZBRGITYUPSDNHLXAWMJQOFECK", "Z"],
};

export const REFLECTORS: Record<string, string> = {
  B: "YRUHQSLDPXNGOKMIEBFZCWVJAT",
  C: "FVPJIAOYEDRZXWGCTKUQSBNMHL",
};

export const ROTOR_NAMES = ["I", "II", "III", "IV", "V"];

const A = 65;

export interface EnigmaConfig {
  rotors: [string, string, string];
  reflector: "B" | "C";
  rings: [number, number, number]; // 0-25
  positions: [number, number, number]; // 0-25
  plugboard: string; // "AB CD EF" 形式
}

function parsePlugboard(s: string): number[] {
  const pb = Array.from({ length: 26 }, (_, i) => i);
  for (const pair of s.toUpperCase().split(/\s+/)) {
    if (pair.length === 2) {
      const a = pair.charCodeAt(0) - A;
      const b = pair.charCodeAt(1) - A;
      if (a >= 0 && a < 26 && b >= 0 && b < 26) {
        pb[a] = b;
        pb[b] = a;
      }
    }
  }
  return pb;
}

export class Enigma {
  private fwd: number[][] = [];
  private bwd: number[][] = [];
  private notches: number[];
  private reflector: number[];
  private rings: number[];
  private positions: number[];
  private plugboard: number[];

  constructor(cfg: EnigmaConfig) {
    for (const n of cfg.rotors) {
      const wiring = ROTORS[n][0].split("").map((c) => c.charCodeAt(0) - A);
      const inv = new Array(26).fill(0);
      wiring.forEach((v, i) => (inv[v] = i));
      this.fwd.push(wiring);
      this.bwd.push(inv);
    }
    this.notches = cfg.rotors.map((n) => ROTORS[n][1].charCodeAt(0) - A);
    this.reflector = REFLECTORS[cfg.reflector].split("").map((c) => c.charCodeAt(0) - A);
    this.rings = [...cfg.rings];
    this.positions = [...cfg.positions];
    this.plugboard = parsePlugboard(cfg.plugboard);
  }

  private step(): void {
    // ダブルステッピング: 中ローターがノッチ位置なら左と中が同時に進む
    if (this.positions[1] === this.notches[1]) {
      this.positions[0] = (this.positions[0] + 1) % 26;
      this.positions[1] = (this.positions[1] + 1) % 26;
    } else if (this.positions[2] === this.notches[2]) {
      this.positions[1] = (this.positions[1] + 1) % 26;
    }
    this.positions[2] = (this.positions[2] + 1) % 26;
  }

  private encryptInt(c: number): number {
    this.step();
    let x = this.plugboard[c];
    // 右→左
    for (const i of [2, 1, 0]) {
      const offset = ((this.positions[i] - this.rings[i]) % 26 + 26) % 26;
      x = (x + offset) % 26;
      x = this.fwd[i][x];
      x = ((x - offset) % 26 + 26) % 26;
    }
    // リフレクター
    x = this.reflector[x];
    // 左→右
    for (const i of [0, 1, 2]) {
      const offset = ((this.positions[i] - this.rings[i]) % 26 + 26) % 26;
      x = (x + offset) % 26;
      x = this.bwd[i][x];
      x = ((x - offset) % 26 + 26) % 26;
    }
    return this.plugboard[x];
  }

  /** A-Z のみ処理して暗号化/復号（対合的なので同じ操作）。 */
  encrypt(text: string): string {
    const out: string[] = [];
    for (const ch of text.toUpperCase()) {
      const code = ch.charCodeAt(0);
      if (code >= A && code <= A + 25) {
        out.push(String.fromCharCode(this.encryptInt(code - A) + A));
      }
    }
    return out.join("");
  }
}

/** ワンショットで暗号化/復号する便利関数（毎回 fresh な状態で実行）。 */
export function runEnigma(cfg: EnigmaConfig, text: string): string {
  return new Enigma(cfg).encrypt(text);
}

/** 5文字ごとに空白を入れる（軍用電文の慣習）。 */
export function group5(s: string): string {
  return (s.match(/.{1,5}/g) || []).join(" ");
}
