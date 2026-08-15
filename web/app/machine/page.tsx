import { Suspense } from "react";
import TypeOut from "@/components/fx/TypeOut";
import Panel from "@/components/hud/Panel";
import TransmitConsole from "@/components/TransmitConsole";

const BRIEFING =
  "エニグマは対合的な暗号です。同じ鍵に暗号文をもう一度通すと平文に戻ります。" +
  "鍵を組み、平文を暗号化し、鍵ごと相手に渡してください。";

export default function MachinePage() {
  return (
    <>
      <p className="eyebrow">CH.01 / Transmit</p>
      <h1>通信卓</h1>
      <p className="sub">
        <TypeOut text={BRIEFING} />
      </p>

      <div style={{ margin: "20px 0 18px" }}>
        {/* useSearchParams を含むため、静的生成できるよう境界を置く */}
        <Suspense fallback={<ConsoleFallback />}>
          <TransmitConsole />
        </Suspense>
      </div>
    </>
  );
}

function ConsoleFallback() {
  return (
    <Panel id="KEY" label="Machine Setup" status="LOADING" led="alert">
      <p className="muted mono small" style={{ margin: 0 }}>
        <span className="spinner" /> 通信卓を起動しています…
      </p>
    </Panel>
  );
}
