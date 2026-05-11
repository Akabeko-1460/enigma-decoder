"""
エニグマM3シミュレータ。

ローター I-V、リフレクター B/C をサポート。
ダブルステッピングのアノマリも正しく実装している。
"""

# 各ローターの (配線, ノッチ位置)
ROTORS = {
    'I':   ('EKMFLGDQVZNTOWYHXUSPAIBRCJ', 'Q'),
    'II':  ('AJDKSIRUXBLHWTMCQGZNPYFVOE', 'E'),
    'III': ('BDFHJLCPRTXVZNYEIWGAKMUSQO', 'V'),
    'IV':  ('ESOVPZJAYQUIRHXLNFTGKDCMWB', 'J'),
    'V':   ('VZBRGITYUPSDNHLXAWMJQOFECK', 'Z'),
}

REFLECTORS = {
    'B': 'YRUHQSLDPXNGOKMIEBFZCWVJAT',
    'C': 'FVPJIAOYEDRZXWGCTKUQSBNMHL',
}

ROTOR_NAMES = ['I', 'II', 'III', 'IV', 'V']


class Enigma:
    """3ローターのエニグマM3。"""

    def __init__(self, rotor_names=('I', 'II', 'III'),
                 reflector_name='B',
                 ring_settings=(0, 0, 0),
                 positions=(0, 0, 0),
                 plugboard=''):
        # 順方向と逆方向の配線をint配列で持つ（高速化のため）
        self.fwd = []
        self.bwd = []
        for n in rotor_names:
            wiring = [ord(c) - 65 for c in ROTORS[n][0]]
            inv = [0] * 26
            for i, v in enumerate(wiring):
                inv[v] = i
            self.fwd.append(wiring)
            self.bwd.append(inv)
        self.notches = [ord(ROTORS[n][1]) - 65 for n in rotor_names]
        self.reflector = [ord(c) - 65 for c in REFLECTORS[reflector_name]]
        self.rings = list(ring_settings)
        self.initial_positions = list(positions)
        self.positions = list(positions)
        self.plugboard = self._parse_plugboard(plugboard)

    @staticmethod
    def _parse_plugboard(s):
        pb = list(range(26))
        if isinstance(s, str):
            pairs = s.split()
        else:
            pairs = s
        for pair in pairs:
            if len(pair) == 2:
                a = ord(pair[0].upper()) - 65
                b = ord(pair[1].upper()) - 65
                pb[a], pb[b] = b, a
        return pb

    def reset(self, positions=None):
        """ローター位置をリセット。"""
        if positions is None:
            self.positions = list(self.initial_positions)
        else:
            self.positions = list(positions)

    def _step(self):
        """ダブルステッピングを含むローター進行。"""
        # 中ローターがノッチ位置にあるなら、左と中の両方が進む（ダブルステップ）
        if self.positions[1] == self.notches[1]:
            self.positions[0] = (self.positions[0] + 1) % 26
            self.positions[1] = (self.positions[1] + 1) % 26
        elif self.positions[2] == self.notches[2]:
            self.positions[1] = (self.positions[1] + 1) % 26
        # 右ローターは常に進む
        self.positions[2] = (self.positions[2] + 1) % 26

    def encrypt_int(self, c):
        """単一文字（0-25）を暗号化/復号。"""
        self._step()
        c = self.plugboard[c]
        # 右→左
        for i in (2, 1, 0):
            offset = (self.positions[i] - self.rings[i]) % 26
            c = (c + offset) % 26
            c = self.fwd[i][c]
            c = (c - offset) % 26
        # リフレクター
        c = self.reflector[c]
        # 左→右
        for i in (0, 1, 2):
            offset = (self.positions[i] - self.rings[i]) % 26
            c = (c + offset) % 26
            c = self.bwd[i][c]
            c = (c - offset) % 26
        c = self.plugboard[c]
        return c

    def encrypt(self, text):
        """文字列を暗号化/復号（A-Zのみ処理）。"""
        text = text.upper()
        out = []
        for ch in text:
            if 'A' <= ch <= 'Z':
                out.append(chr(self.encrypt_int(ord(ch) - 65) + 65))
        return ''.join(out)


def precompute_rotor_arrays(rotor_names, reflector):
    """ローター・リフレクターの配線をint配列で事前計算。"""
    fwd = [[ord(c) - 65 for c in ROTORS[n][0]] for n in rotor_names]
    bwd = []
    for w in fwd:
        inv = [0] * 26
        for i, v in enumerate(w):
            inv[v] = i
        bwd.append(inv)
    notches = [ord(ROTORS[n][1]) - 65 for n in rotor_names]
    reflector_arr = [ord(c) - 65 for c in REFLECTORS[reflector]]
    return fwd, bwd, notches, reflector_arr


def decrypt_fast(ciphertext_ints, fwd, bwd, notches, reflector_arr,
                 ring_settings, positions, plugboard_array):
    """
    内部ループ用の高速版（ローター配列は事前計算済みで渡される）。
    """
    # ローカル変数化（Python の属性参照を減らすため）
    fwd0, fwd1, fwd2 = fwd[0], fwd[1], fwd[2]
    bwd0, bwd1, bwd2 = bwd[0], bwd[1], bwd[2]
    n0, n1, n2 = notches[0], notches[1], notches[2]
    r0, r1, r2 = ring_settings[0], ring_settings[1], ring_settings[2]
    p0, p1, p2 = positions[0], positions[1], positions[2]

    out = []
    out_append = out.append
    for c in ciphertext_ints:
        # ダブルステッピング
        if p1 == n1:
            p0 = (p0 + 1) % 26
            p1 = (p1 + 1) % 26
        elif p2 == n2:
            p1 = (p1 + 1) % 26
        p2 = (p2 + 1) % 26

        x = plugboard_array[c]
        # 右→左
        x = fwd2[(x + p2 - r2) % 26]
        x = (x - p2 + r2) % 26
        x = fwd1[(x + p1 - r1) % 26]
        x = (x - p1 + r1) % 26
        x = fwd0[(x + p0 - r0) % 26]
        x = (x - p0 + r0) % 26
        # リフレクター
        x = reflector_arr[x]
        # 左→右
        x = bwd0[(x + p0 - r0) % 26]
        x = (x - p0 + r0) % 26
        x = bwd1[(x + p1 - r1) % 26]
        x = (x - p1 + r1) % 26
        x = bwd2[(x + p2 - r2) % 26]
        x = (x - p2 + r2) % 26
        out_append(plugboard_array[x])
    return out


def decrypt_with_settings(ciphertext_ints, rotor_names, reflector,
                          ring_settings, positions, plugboard_array):
    """便利な互換ラッパー（毎回事前計算するので遅い。テスト用）。"""
    fwd, bwd, notches, refl = precompute_rotor_arrays(rotor_names, reflector)
    return decrypt_fast(ciphertext_ints, fwd, bwd, notches, refl,
                        ring_settings, positions, plugboard_array)


# 既知の自己テスト
if __name__ == '__main__':
    # 既知の正解: rotors=I,II,III, reflector=B, all rings 0, position 0,
    # input AAAAA → output BDZGO
    e = Enigma(('I', 'II', 'III'), 'B', (0, 0, 0), (0, 0, 0), '')
    result = e.encrypt('AAAAA')
    assert result == 'BDZGO', f'Expected BDZGO, got {result}'
    print(f'[OK] AAAAA → {result}')

    # 対合性のテスト
    e1 = Enigma(('I', 'II', 'III'), 'B', (5, 12, 7), (3, 14, 9), 'AB CD EF')
    plaintext = 'HELLOWORLDTHISISATEST'
    ct = e1.encrypt(plaintext)
    e2 = Enigma(('I', 'II', 'III'), 'B', (5, 12, 7), (3, 14, 9), 'AB CD EF')
    pt = e2.encrypt(ct)
    assert pt == plaintext, f'Round trip failed: {plaintext} → {ct} → {pt}'
    print(f'[OK] {plaintext} → {ct} → {pt}')
    print('全テスト合格')
