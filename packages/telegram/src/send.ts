// low-level telegram send. shared by the public alert sender and the ops
// transport. never called when a token is unset; callers gate on that.

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`telegram send failed: ${res.status} ${body.slice(0, 200)}`);
  }
}
