#!/usr/bin/env python3
"""
Enigma Cipher Cracker
=====================
Cracks Enigma ciphertext without knowing the internal state.

Algorithm:
  Phase 1: Search all rotor orders(60) x positions(17,576) -> filter by IoC
  Phase 2: Hill-climbing for plugboard optimization
  Phase 3: Final ranking by chi-squared frequency analysis
"""

import itertools
import string
import argparse
import time
from collections import Counter
from multiprocessing import Pool, cpu_count

ALPHABET = string.ascii_uppercase

# ===== Rotor & Reflector Definitions (Wehrmacht Enigma I) =====
ROTOR_WIRINGS = {
    'I':   'EKMFLGDQVZNTOWYHXUSPAIBRCJ',
    'II':  'AJDKSIRUXBLHWTMCQGZNPYFVOE',
    'III': 'BDFHJLCPRTXVZNYEIWGAKMUSQO',
    'IV':  'ESOVPZJAYQUIRHXLNFTGKDCMWB',
    'V':   'VZBRGITYUPSDNHLXAWMJQOFECK',
}
ROTOR_NOTCHES = {'I': 16, 'II': 4, 'III': 21, 'IV': 9, 'V': 25}

REFLECTOR_WIRINGS = {
    'B': 'YRUHQSLDPXNGOKMIEBFZCWVJAT',
    'C': 'FVPJIAOYEDRZXWGCTKUQSBNMHL',
}

# ===== Language Frequency Tables =====
ENGLISH_FREQ = [
    0.08167, 0.01492, 0.02782, 0.04253, 0.12702, 0.02228, 0.02015,
    0.06094, 0.06966, 0.00153, 0.00772, 0.04025, 0.02406, 0.06749,
    0.07507, 0.01929, 0.00095, 0.05987, 0.06327, 0.09056, 0.02758,
    0.00978, 0.02360, 0.00150, 0.01974, 0.00074,
]
GERMAN_FREQ = [
    0.06516, 0.01886, 0.02732, 0.05076, 0.16396, 0.01656, 0.03009,
    0.04577, 0.06550, 0.00268, 0.01417, 0.03437, 0.02534, 0.09776,
    0.02594, 0.00670, 0.00018, 0.07003, 0.07270, 0.06154, 0.04166,
    0.00846, 0.01921, 0.00034, 0.00039, 0.01134,
]
# Romaji (romanized Japanese) letter frequencies
# Vowels A,I,U,E,O are dominant; L,Q,V,X are virtually absent
ROMAJI_FREQ = [
    0.146, 0.010, 0.006, 0.022, 0.066, 0.004, 0.016,
    0.040, 0.120, 0.005, 0.056, 0.000, 0.032, 0.072,
    0.106, 0.003, 0.000, 0.038, 0.056, 0.064, 0.096,
    0.000, 0.012, 0.000, 0.013, 0.006,
]
# Map language keys to (freq_tables_list, target_ioc)
LANG_CONFIG = {
    'en':   ([ENGLISH_FREQ], 0.067),
    'de':   ([GERMAN_FREQ], 0.076),
    'ja':   ([ROMAJI_FREQ], 0.078),
    'auto': ([ENGLISH_FREQ, ROMAJI_FREQ], 0.067),
}


# ===== Enigma Machine Simulator =====
class EnigmaMachine:
    """Full simulation of the Enigma cipher machine."""

    def __init__(self, rotor_names, reflector_name='B',
                 positions=(0, 0, 0), rings=(0, 0, 0), plugboard_pairs=None):
        self.fwd = []
        self.bwd = []
        self.notches = []
        self.positions = list(positions)
        self.rings = list(rings)

        for name in rotor_names:
            w = [ord(c) - 65 for c in ROTOR_WIRINGS[name]]
            inv = [0] * 26
            for i, v in enumerate(w):
                inv[v] = i
            self.fwd.append(w)
            self.bwd.append(inv)
            self.notches.append(ROTOR_NOTCHES[name])

        self.reflector = [ord(c) - 65 for c in REFLECTOR_WIRINGS[reflector_name]]

        self.plugboard = list(range(26))
        if plugboard_pairs:
            for a, b in plugboard_pairs:
                self.plugboard[a] = b
                self.plugboard[b] = a

    def step(self):
        """Rotor stepping with double-step anomaly."""
        if self.positions[1] == self.notches[1]:
            self.positions[1] = (self.positions[1] + 1) % 26
            self.positions[0] = (self.positions[0] + 1) % 26
        elif self.positions[2] == self.notches[2]:
            self.positions[1] = (self.positions[1] + 1) % 26
        self.positions[2] = (self.positions[2] + 1) % 26

    def encrypt_char(self, c):
        """Encrypt/decrypt a single character (numeric 0-25)."""
        self.step()
        c = self.plugboard[c]
        # Forward: Right -> Middle -> Left
        for i in (2, 1, 0):
            shift = self.positions[i] - self.rings[i]
            c = (self.fwd[i][(c + shift) % 26] - shift) % 26
        # Reflector
        c = self.reflector[c]
        # Backward: Left -> Middle -> Right
        for i in (0, 1, 2):
            shift = self.positions[i] - self.rings[i]
            c = (self.bwd[i][(c + shift) % 26] - shift) % 26
        c = self.plugboard[c]
        return c

    def process(self, text):
        """Encrypt/decrypt text (only alphabetic chars)."""
        result = []
        for ch in text.upper():
            if ch in ALPHABET:
                result.append(chr(self.encrypt_char(ord(ch) - 65) + 65))
        return ''.join(result)

    def process_nums(self, nums):
        """Encrypt/decrypt a list of numbers (0-25)."""
        return [self.encrypt_char(n) for n in nums]


# ===== Scoring Functions =====
def calc_ioc(nums):
    """Calculate Index of Coincidence."""
    n = len(nums)
    if n < 2:
        return 0.0
    counts = [0] * 26
    for c in nums:
        counts[c] += 1
    total = sum(c * (c - 1) for c in counts)
    return total / (n * (n - 1))


def calc_chi_squared(nums, freq_table):
    """Chi-squared statistic (lower = closer to natural language)."""
    n = len(nums)
    if n == 0:
        return float('inf')
    counts = [0] * 26
    for c in nums:
        counts[c] += 1
    chi2 = 0.0
    for i in range(26):
        expected = freq_table[i] * n
        if expected > 0:
            chi2 += (counts[i] - expected) ** 2 / expected
    return chi2


# ===== Phase 1: Exhaustive Rotor Search =====
def _search_batch(args):
    """Worker: find top candidates by IoC filter + chi2 ranking."""
    rotor_combos, ct_nums, reflector, ioc_thresh, top_n, freq_tables = args
    candidates = []

    for r1, r2, r3 in rotor_combos:
        fwd_tables = []
        bwd_tables = []
        notches_list = []
        for name in (r1, r2, r3):
            w = [ord(c) - 65 for c in ROTOR_WIRINGS[name]]
            inv = [0] * 26
            for i, v in enumerate(w):
                inv[v] = i
            fwd_tables.append(w)
            bwd_tables.append(inv)
            notches_list.append(ROTOR_NOTCHES[name])

        ref = [ord(c) - 65 for c in REFLECTOR_WIRINGS[reflector]]

        for p0 in range(26):
            for p1 in range(26):
                for p2 in range(26):
                    # Inline decryption for speed
                    pos = [p0, p1, p2]
                    plain = []
                    for c in ct_nums:
                        # Stepping
                        if pos[1] == notches_list[1]:
                            pos[1] = (pos[1] + 1) % 26
                            pos[0] = (pos[0] + 1) % 26
                        elif pos[2] == notches_list[2]:
                            pos[1] = (pos[1] + 1) % 26
                        pos[2] = (pos[2] + 1) % 26

                        # Forward: R -> M -> L
                        x = c
                        for i in (2, 1, 0):
                            x = (fwd_tables[i][(x + pos[i]) % 26] - pos[i]) % 26
                        x = ref[x]
                        for i in (0, 1, 2):
                            x = (bwd_tables[i][(x + pos[i]) % 26] - pos[i]) % 26
                        plain.append(x)

                    ioc = calc_ioc(plain)
                    if ioc > ioc_thresh:
                        chi2 = min(calc_chi_squared(plain, ft) for ft in freq_tables)
                        # Combined score: chi2/ioc (lower=better)
                        # Rewards both low chi2 AND high IoC
                        score = chi2 / ioc
                        candidates.append((
                            score, chi2, ioc, r1, r2, r3, p0, p1, p2, list(plain)
                        ))

    # Sort by combined score (ascending = better)
    candidates.sort(key=lambda x: x[0])
    return candidates[:top_n]


# ===== Phase 2: Plugboard Optimization =====
def optimize_plugboard(ct_nums, rotor_names, reflector, positions, freq_table, max_pairs=10):
    """Hill-climbing to find optimal plugboard settings."""
    best_pairs = []
    best_score = float('inf')

    # Initial score (no plugboard)
    machine = EnigmaMachine(rotor_names, reflector, positions)
    plain = machine.process_nums(ct_nums)
    best_score = calc_chi_squared(plain, freq_table)
    best_plain = plain

    for _ in range(max_pairs):
        improved = False
        best_swap = None

        for a in range(26):
            for b in range(a + 1, 26):
                in_use = any(a in p or b in p for p in best_pairs)
                if in_use:
                    continue

                trial_pairs = best_pairs + [(a, b)]
                machine = EnigmaMachine(rotor_names, reflector, positions,
                                        plugboard_pairs=trial_pairs)
                plain = machine.process_nums(ct_nums)
                score = calc_chi_squared(plain, freq_table)

                if score < best_score:
                    best_score = score
                    best_swap = (a, b)
                    best_plain = plain
                    improved = True

        if improved and best_swap:
            best_pairs.append(best_swap)
        else:
            break

    return best_pairs, best_plain, best_score


# ===== Main Cracking Logic =====
def crack_enigma(ciphertext, language='auto', reflector='B',
                 top_n=10, workers=None, crib=None):
    """Crack Enigma ciphertext using statistical analysis."""
    freq_tables, target_ioc = LANG_CONFIG.get(language, LANG_CONFIG['auto'])

    ct_clean = ''.join(c for c in ciphertext.upper() if c in ALPHABET)
    ct_nums = [ord(c) - 65 for c in ct_clean]
    msg_len = len(ct_nums)

    # Dynamic IoC threshold: lower for short messages (more statistical noise)
    if msg_len < 15:
        ioc_mult = 0.35
    elif msg_len < 25:
        ioc_mult = 0.42
    elif msg_len < 40:
        ioc_mult = 0.50
    else:
        ioc_mult = 0.55
    ioc_threshold = target_ioc * ioc_mult

    # More candidates for short messages
    cand_mult = 50 if msg_len < 30 else 30

    if msg_len < 5:
        print("[WARNING] Ciphertext is very short (10+ chars recommended)")

    lang_names = {'en': 'English', 'de': 'German', 'ja': 'Romaji',
                  'auto': 'Auto (English + Romaji)'}
    print(f"Ciphertext : {ct_clean}")
    print(f"Length     : {msg_len}")
    print(f"Language   : {lang_names.get(language, language)}")
    print(f"Reflector  : {reflector}")
    print(f"IoC thresh : {ioc_threshold:.4f} (adjusted for length)")
    print()

    # ----- Crib attack -----
    if crib:
        return _crib_attack(ct_nums, ct_clean, crib, reflector, freq_tables, top_n)

    # ----- Phase 1: Exhaustive rotor search -----
    print("=" * 60)
    print("Phase 1: Exhaustive rotor search (~1,000,000 combinations)")
    print("=" * 60)

    rotor_names = list(ROTOR_WIRINGS.keys())
    all_perms = list(itertools.permutations(rotor_names, 3))

    if workers is None:
        workers = min(cpu_count(), 8)

    chunk_size = max(1, len(all_perms) // workers)
    chunks = []
    for i in range(0, len(all_perms), chunk_size):
        batch = all_perms[i:i + chunk_size]
        chunks.append((batch, ct_nums, reflector, ioc_threshold, top_n * cand_mult, freq_tables))

    start = time.time()
    print(f"Workers: {workers}, Chunks: {len(chunks)}")
    print("Searching...")

    try:
        with Pool(workers) as pool:
            results = pool.map(_search_batch, chunks)
    except Exception:
        print("(Running single-process fallback)")
        results = [_search_batch(c) for c in chunks]

    all_candidates = []
    for r in results:
        all_candidates.extend(r)
    all_candidates.sort(key=lambda x: x[0])  # Sort by chi2 ascending
    all_candidates = all_candidates[:top_n * 30]

    elapsed = time.time() - start
    print(f"Done: {elapsed:.1f}s, Candidates: {len(all_candidates)}")
    print()

    if not all_candidates:
        print("[X] No promising candidates found.")
        print("    -> Try lowering IoC threshold or a different reflector.")
        return []

    # ----- Phase 2: Ranking by chi-squared (no plugboard) -----
    # Note: IoC is plugboard-invariant, so Phase 1 correctly identifies
    # rotor settings. Chi2 without plugboard is already computed in Phase 1.
    # Plugboard only does monoalphabetic substitution, so the correct
    # rotor settings will produce text closest to natural language even
    # without plugboard.
    print("=" * 60)
    print("Phase 2: Ranking candidates (chi-squared)")
    print("=" * 60)

    final_results = []
    seen = set()
    for cand in all_candidates:
        score_val, chi2_val, ioc, r1, r2, r3, p0, p1, p2, plain_nums = cand
        key = (r1, r2, r3, p0, p1, p2)
        if key in seen:
            continue
        seen.add(key)

        pos_str = ''.join(chr(p + 65) for p in (p0, p1, p2))
        plain_text = ''.join(chr(c + 65) for c in plain_nums)

        final_results.append({
            'rank': 0,
            'rotors': f"{r1}-{r2}-{r3}",
            'positions': pos_str,
            'plugboard': 'none',
            'ioc': ioc,
            'chi2': chi2_val,
            'plaintext': plain_text,
        })

        if len(final_results) >= top_n:
            break

    # ----- Phase 3: Final output -----
    print()
    print("=" * 60)
    print("Final Results (without plugboard)")
    print("=" * 60)
    print("(If a plugboard was used, letter pairs will be swapped.)")
    print("(Use --plug-candidate N to optimize plugboard for candidate N.)")

    for i, res in enumerate(final_results):
        res['rank'] = i + 1
        print(f"\n--- Candidate {res['rank']} ---")
        print(f"  Rotors    : {res['rotors']}")
        print(f"  Positions : {res['positions']}")
        print(f"  IoC       : {res['ioc']:.5f}")
        print(f"  Chi2      : {res['chi2']:.2f}")
        print(f"  Plaintext : {res['plaintext']}")

    return final_results


# ===== Crib (Known-Plaintext) Attack =====
def _crib_attack(ct_nums, ct_clean, crib, reflector, freq_tables, top_n):
    """Attack using known plaintext (crib)."""
    if not isinstance(freq_tables, list):
        freq_tables = [freq_tables]
    crib_upper = crib.upper().replace(' ', '')
    crib_nums = [ord(c) - 65 for c in crib_upper if c in ALPHABET]

    print("=" * 60)
    print(f"Crib Attack: known plaintext = '{crib_upper}'")
    print("=" * 60)

    rotor_names = list(ROTOR_WIRINGS.keys())
    candidates = []

    for r1, r2, r3 in itertools.permutations(rotor_names, 3):
        for p0 in range(26):
            for p1 in range(26):
                for p2 in range(26):
                    machine = EnigmaMachine(
                        [r1, r2, r3], reflector, (p0, p1, p2)
                    )
                    plain = machine.process_nums(ct_nums)
                    match = all(
                        plain[i] == crib_nums[i]
                        for i in range(min(len(crib_nums), len(plain)))
                    )
                    if match:
                        plain_text = ''.join(chr(c + 65) for c in plain)
                        pos_str = ''.join(chr(p + 65) for p in (p0, p1, p2))
                        chi2 = min(calc_chi_squared(plain, ft) for ft in freq_tables)
                        candidates.append({
                            'rank': 0,
                            'rotors': f"{r1}-{r2}-{r3}",
                            'positions': pos_str,
                            'plugboard': 'none',
                            'ioc': calc_ioc(plain),
                            'chi2': chi2,
                            'plaintext': plain_text,
                        })

    candidates.sort(key=lambda x: x['chi2'])
    print(f"Crib matches: {len(candidates)}")

    for i, res in enumerate(candidates[:top_n]):
        res['rank'] = i + 1
        print(f"\n--- Candidate {res['rank']} ---")
        print(f"  Rotors    : {res['rotors']}")
        print(f"  Positions : {res['positions']}")
        print(f"  Plaintext : {res['plaintext']}")

    return candidates[:top_n]


# ===== Encryption Helper (for testing) =====
def encrypt(plaintext, rotor_names, reflector='B',
            positions=(0, 0, 0), rings=(0, 0, 0), plugboard_pairs=None):
    """Encrypt with specified Enigma settings (for testing)."""
    machine = EnigmaMachine(rotor_names, reflector, positions, rings, plugboard_pairs)
    return machine.process(plaintext)


# ===== CLI =====
def main():
    parser = argparse.ArgumentParser(
        description='Enigma Cipher Cracker',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python enigma.py -c "BDZGO XFNGS"
  python enigma.py -c "BDZGO" -l ja        # Romaji Japanese
  python enigma.py -c "BDZGO XFNGS" --crib "HELLO"
  python enigma.py --test
        """)
    parser.add_argument('-c', '--ciphertext', type=str, help='Ciphertext')
    parser.add_argument('-l', '--language', choices=['en', 'de', 'ja', 'auto'],
                        default='auto', help='Target language (default: auto=English+Romaji)')
    parser.add_argument('-r', '--reflector', choices=['B', 'C'],
                        default='B', help='Reflector (default: B)')
    parser.add_argument('-t', '--top', type=int, default=10,
                        help='Number of top candidates (default: 10)')
    parser.add_argument('-w', '--workers', type=int, default=None,
                        help='Parallel workers (default: CPU count)')
    parser.add_argument('--crib', type=str, default=None,
                        help='Known plaintext (crib)')
    parser.add_argument('--test', action='store_true',
                        help='Test mode: encrypt then crack')

    args = parser.parse_args()

    print("+==========================================+")
    print("|        Enigma Cipher Cracker             |")
    print("+==========================================+")
    print()

    if args.test:
        _run_test()
        return

    if args.ciphertext:
        ct = args.ciphertext
    else:
        print("Enter ciphertext (press Enter to confirm):")
        ct = input("> ").strip()
        if not ct:
            print("No ciphertext provided.")
            return

    crack_enigma(
        ciphertext=ct,
        language=args.language,
        reflector=args.reflector,
        top_n=args.top,
        workers=args.workers,
        crib=args.crib,
    )


def _run_test():
    """Test mode: encrypt with known settings, then crack."""
    test_cases = [
        ("ENGLISH", "THETROOPSAREMOVINGATDAWNTOTHEEASTERNFRONT",
         ['II', 'IV', 'I'], (2, 20, 3)),
        ("ROMAJI", "WATASHIHAENIGUMAWOKAIDOKUSHIMASU",
         ['III', 'I', 'V'], (5, 10, 15)),
    ]

    for label, plaintext, rotors, positions in test_cases:
        print(f"\n{'='*60}")
        print(f"TEST: {label}")
        print(f"{'='*60}")

        ct = encrypt(plaintext, rotors, 'B', positions)
        print(f"Plaintext  : {plaintext}")
        print(f"Settings   : Rotors={rotors}, Pos={''.join(chr(p+65) for p in positions)}")
        print(f"Ciphertext : {ct}")

        # Verify symmetric decryption
        dec = encrypt(ct, rotors, 'B', positions)
        assert dec == plaintext, "Decryption verification FAILED!"
        print("[OK] Symmetric decryption verified\n")

        # Brute-force crack
        results = crack_enigma(ct, top_n=10)
        if results:
            found_rank = None
            for res in results:
                if res['plaintext'] == plaintext:
                    found_rank = res['rank']
                    break
            if found_rank:
                print(f"\n[OK] {label}: Correct plaintext at rank {found_rank}.")
            else:
                print(f"\n[!] {label}: Not found in top {len(results)} candidates.")


if __name__ == '__main__':
    main()
