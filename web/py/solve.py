"""
Web アプリ用の JSON エントリポイント。

Next.js の API ルートから
    python web/py/solve.py '<json>'
の形で呼び出される（cwd はリポジトリルート）。標準出力へは最終結果の
JSON を 1 行だけ出力する（進捗表示は verbose=False で抑制）。

入力 JSON:
    {
      "mode": "known_plugboard" | "plugboard",
      "ciphertext": "....",
      "language": "auto" | "english" | "romaji",
      "plugboard": "AB CD",      # known_plugboard のとき使用
      "accuracy": false,          # known_plugboard のとき: リング676通り探索
      "level": "accuracy",       # plugboard のとき: normal | accuracy | thorough
      "top_results": 5
    }

出力 JSON:
    {
      "ok": true,
      "rust": true/false,
      "level": "accuracy",        # 実際に使われた精度レベル（plugboard のみ）
      "elapsed": 1.23,
      "results": [
         {"score":.., "rotors":"II IV V", "positions":"HEW",
          "rings":"AAA", "plugboard":"AB CD", "lang":"english", "text":".."},
         ...
      ]
    }
"""
import sys
import os
import json
import time

# リポジトリルートを import パスへ
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)


def format_plugboard(pb):
    pairs, seen = [], set()
    for i in range(26):
        if pb[i] != i and i not in seen:
            pairs.append(chr(i + 65) + chr(pb[i] + 65))
            seen.add(i)
            seen.add(pb[i])
    return " ".join(pairs) if pairs else ""


def to_letters(arr):
    return "".join(chr(int(x) + 65) for x in arr)


def serialize(results):
    out = []
    for r in results:
        score, rotors, positions, rings, pb, lang, text = r
        out.append({
            "score": round(float(score), 4),
            "rotors": " ".join(rotors),
            "positions": to_letters(positions),
            "rings": to_letters(rings),
            "plugboard": format_plugboard(pb) or "(none)",
            "lang": lang,
            "text": text,
        })
    return out


def main():
    try:
        payload = json.loads(sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read())
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad input: {e}"}))
        return

    mode = payload.get("mode")
    ct = (payload.get("ciphertext") or "").strip()
    language = payload.get("language", "auto")
    top_results = int(payload.get("top_results", 5))

    cleaned = [c for c in ct.upper() if "A" <= c <= "Z"]
    if len(cleaned) < 20:
        print(json.dumps({"ok": False,
                          "error": "暗号文が短すぎます（A-Zで20文字以上必要）。"}))
        return

    t0 = time.time()
    level = None
    try:
        if mode == "known_plugboard":
            import decrypt_known_plugboard as dk
            pb = payload.get("plugboard", dk.KNOWN_PLUGBOARD) or ""
            accuracy = bool(payload.get("accuracy", False))
            results = dk.attack_known_plugboard(
                ct, plugboard_str=pb, language=language,
                top_n=20, top_results=top_results,
                accuracy=accuracy, verbose=False)
            rust = dk.HAS_RUST
        elif mode == "plugboard":
            import decrypt_plugboard as dp
            # 未知の値が来ても落とさず既定へ倒す（UI とサーバの版ズレ対策）
            level = payload.get("level") or dp.DEFAULT_MODE
            if level not in dp.MODE_PARAMS:
                level = dp.DEFAULT_MODE
            results = dp.attack_plugboard(
                ct, language=language, mode=level,
                top_results=top_results, verbose=False)
            rust = dp.HAS_RUST
        else:
            print(json.dumps({"ok": False, "error": f"unknown mode: {mode}"}))
            return
    except Exception as e:
        import traceback
        print(json.dumps({"ok": False, "error": str(e),
                          "trace": traceback.format_exc()}))
        return

    print(json.dumps({
        "ok": True,
        "rust": bool(rust),
        "level": level,
        "elapsed": round(time.time() - t0, 2),
        "results": serialize(results),
    }))


if __name__ == "__main__":
    main()
