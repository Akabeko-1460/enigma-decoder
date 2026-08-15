"use client";

import { useSyncExternalStore, type CSSProperties } from "react";
import { changeSoundEnabled } from "@/lib/audio/engine";
import {
  getSoundEnabled,
  getSoundEnabledOnServer,
  subscribeSoundEnabled,
} from "@/lib/audio/preference";
import styles from "./SoundToggle.module.css";

const BARS = 5;

/** 上部バーの音量トグル。レベルメーターが動いていれば音が出ている。 */
export default function SoundToggle() {
  const enabled = useSyncExternalStore(
    subscribeSoundEnabled,
    getSoundEnabled,
    getSoundEnabledOnServer
  );

  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={() => changeSoundEnabled(!enabled)}
      data-on={enabled}
      // 自前で合図音を鳴らすので、共通のクリック音は付けない
      data-sfx-silent=""
      aria-pressed={enabled}
      aria-label={enabled ? "音を消す" : "音を出す"}
      title={enabled ? "音を消す" : "音を出す"}
    >
      <span className={styles.meter} aria-hidden="true">
        {Array.from({ length: BARS }, (_, index) => (
          <i key={index} style={{ "--bar": index } as CSSProperties} />
        ))}
      </span>
      <span className={styles.label}>{enabled ? "SOUND" : "MUTED"}</span>
    </button>
  );
}
