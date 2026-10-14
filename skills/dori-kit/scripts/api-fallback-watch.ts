// Env: FALLBACK_LOG (override log path), DRY=1 (print instead of posting to Discord).
import { dc2 } from "./dc2.ts";
import { cfg, LAYER_DIR } from "./config.ts";

const LOG = process.env.FALLBACK_LOG ?? `${process.env.HOME}/.omo/agent/logs/fallback.log`;
const STATE = `${LAYER_DIR}/api-fallback-watch.json`;
const ALERT_CHANNEL_ID = cfg.discord.channels.alert;
const DRY = process.env.DRY === "1";

const kst = (iso: string) =>
  new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function message(e: Record<string, string>): string | undefined {
  const to = e.to ?? "", from = e.from ?? "";
  if (e.event === "fallback_applied" && to.startsWith("anthropic-api/")) {
    const why = e.limit ? "구독 한도" : e.reason === "transient" ? "구독 쪽 일시 오류" : e.reason ?? "구독 오류";
    return `🔌 ${cfg.identity.name} API 사용 시작 (${kst(e.ts)}): ${why} → ${to.replace("anthropic-api/", "")} high, $100 크레딧 차감 중. 구독 살아나면 자동으로 Opus medium 복귀`;
  }
  if (e.event === "fallback_reverted" && from.startsWith("anthropic-api/")) {
    return `✅ ${cfg.identity.name} 구독 복귀 (${kst(e.ts)}): API 사용 끝, 다시 구독 ${(e.to ?? "").replace("anthropic/", "")}`;
  }
  return undefined;
}

async function readState(): Promise<{ offset: number }> {
  try { return JSON.parse(await Bun.file(STATE).text()); } catch { return { offset: -1 }; }
}

const FLAP_WINDOW_MS = 120_000;
let pendingRevert: ReturnType<typeof setTimeout> | undefined;
async function post(text: string, event: string) {
  if (DRY) { console.log("DRY", text); return; }
  try { await dc2.sendMessage(ALERT_CHANNEL_ID, text); console.log(new Date().toISOString(), "sent", event); }
  catch (err) { console.error(new Date().toISOString(), "send failed", String(err)); }
}

let { offset } = await readState();
for (;;) {
  const file = Bun.file(LOG);
  const size = (await file.exists()) ? file.size : 0;
  if (offset < 0 || size < offset) offset = offset < 0 ? size : 0; // first run: start at end; rotation: restart
  if (size > offset) {
    const chunk = await file.slice(offset, size).text();
    const end = chunk.lastIndexOf("\n");
    if (end >= 0) {
      for (const line of chunk.slice(0, end).split("\n")) {
        let e: Record<string, string>;
        try { e = JSON.parse(line); } catch { continue; }
        const text = message(e);
        if (!text) continue;
        // Circuit-probe flap (user 2026-10-12): a revert followed by an immediate re-apply is one ongoing API episode, not two events.
        if (e.event === "fallback_reverted") {
          if (pendingRevert) clearTimeout(pendingRevert);
          pendingRevert = setTimeout(() => { pendingRevert = undefined; void post(text, e.event); }, FLAP_WINDOW_MS);
          continue;
        }
        if (pendingRevert) { clearTimeout(pendingRevert); pendingRevert = undefined; console.log(new Date().toISOString(), "flap suppressed"); continue; }
        await post(text, e.event);
      }
      offset += Buffer.byteLength(chunk.slice(0, end + 1));
      if (!DRY) await Bun.write(STATE, JSON.stringify({ offset }));
    }
  }
  await Bun.sleep(5000);
}
