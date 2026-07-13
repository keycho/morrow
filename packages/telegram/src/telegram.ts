// telegram sender. sends to the bot api, or logs the message when dry_run is
// on or the token is unset. dry_run is on by default until the operator sets
// the token, so nothing is posted before then.

export interface SenderConfig {
  botToken: string;
  chatId: string;
  dryRun: boolean;
}

export interface Sender {
  send(text: string): Promise<void>;
  readonly live: boolean;
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [telegram] ${msg}`);
}

export function makeSender(cfg: SenderConfig): Sender {
  const live = !cfg.dryRun && cfg.botToken !== "" && cfg.chatId !== "";
  if (!live) {
    return {
      live: false,
      async send(text: string): Promise<void> {
        log(`dry-run, would send:\n${text}`);
      },
    };
  }
  return {
    live: true,
    async send(text: string): Promise<void> {
      const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`telegram send failed: ${res.status} ${body.slice(0, 200)}`);
      }
    },
  };
}
