/**
 * 画面全体の背面演出。
 *
 * 5 枚のレイヤを重ねて「暗い計器室のモニタ」を作る。見た目は globals.css の
 * `.backdrop*` が持っており、ここは重ね順を宣言するだけ。JS を持たないので
 * サーバーコンポーネントのまま置ける。
 */
export default function Backdrop() {
  return (
    <>
      <div className="backdrop" aria-hidden>
        <div className="backdrop__layer backdrop__glow" />
        <div className="backdrop__layer backdrop__grid" />
        <div className="backdrop__layer backdrop__dots" />
        <div className="backdrop__layer backdrop__scan" />
        <div className="backdrop__layer backdrop__sweep" />
        <div className="backdrop__layer backdrop__noise" />
      </div>
      {/* ビューポート四隅のブラケット。位置は nth-child で決まる */}
      <div className="viewframe" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </div>
    </>
  );
}
