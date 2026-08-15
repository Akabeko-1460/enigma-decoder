"use client";

import { useEffect } from "react";
import { playUiSound, setAudioEnabled, setAudioPaused, unlockAudio } from "@/lib/audio/engine";
import { getSoundEnabled } from "@/lib/audio/preference";
import type { SfxName } from "@/lib/audio/sfx";

/**
 * 音まわりの常駐処理。画面には何も出さない。
 *
 * 効果音はボタン 1 つずつに書かず、文書全体のクリックをここで拾う。
 * 既存のボタンに手を入れずに済み、あとから増えたボタンにも自動で乗るため。
 */

const INTERACTIVE = 'button, a[href], [role="button"], summary';

/** クリックされた要素に応じた効果音。対象外なら null。 */
function soundFor(target: EventTarget | null): SfxName | null {
  if (!(target instanceof Element)) return null;

  const control = target.closest(INTERACTIVE);
  if (!control) return null;
  // 自前で音を鳴らす要素は二重に鳴らさない
  if (control.hasAttribute("data-sfx-silent")) return null;
  if (control instanceof HTMLButtonElement && control.disabled) return null;
  if (control.getAttribute("aria-disabled") === "true") return null;

  if (control.classList.contains("btn--fire")) return "launch";
  if (control.closest(".segmented")) return "toggle";
  if (control.tagName === "A") return "nav";
  return "click";
}

export default function AudioController() {
  useEffect(() => {
    setAudioEnabled(getSoundEnabled());
    setAudioPaused(document.hidden);

    function handlePointerDown(event: PointerEvent): void {
      unlockAudio();
      const sound = soundFor(event.target);
      if (sound) playUiSound(sound);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      unlockAudio();
      // 押しっぱなしのキーリピートで鳴り続けないようにする
      if (event.repeat) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      const sound = soundFor(event.target);
      if (sound) playUiSound(sound);
    }

    function handleVisibilityChange(): void {
      setAudioPaused(document.hidden);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return null;
}
