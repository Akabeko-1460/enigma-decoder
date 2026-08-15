import styles from "./loading.module.css";

/**
 * 画面遷移中の待ち画面。
 *
 * 解読機と通信卓はどちらも読み込むコードが大きいので、押してから中身が
 * 出るまでに間がある。App Router はこのファイルがあると、その間を
 * Suspense のフォールバックとして埋めてくれる。
 *
 * 進み具合は取れないため、量ではなく「動いていること」だけを見せる。
 * 図案はアプリアイコンと同じローター。
 */
export default function Loading() {
  return (
    <div className={styles.screen} role="status" aria-live="polite">
      <svg className={styles.dial} viewBox="0 0 64 64" aria-hidden="true">
        <circle className={styles.ticks} cx="32" cy="32" r="26" />
        <circle className={styles.ring} cx="32" cy="32" r="20" />
        <circle className={styles.arc} cx="32" cy="32" r="20" />
        <circle className={styles.hub} cx="32" cy="32" r="5" />
      </svg>

      <p className={styles.label}>
        ESTABLISHING LINK
        <span className="caret" aria-hidden="true" />
      </p>
      <p className={styles.note}>モジュールを読み込んでいます</p>

      <div className={styles.track} aria-hidden="true" />
    </div>
  );
}
