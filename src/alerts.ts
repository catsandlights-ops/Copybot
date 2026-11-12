/**
 * Phone alerts through Telegram (bot token + chat id) and/or a Discord webhook.
 * Messages are plain text (no markup, no @mentions), rate-limited, and repeated errors are
 * collapsed so a bad RPC can't flood your phone.
 */
import { readSecret } from './env';

// Overridable only so tests can point at a local fake server.
const tgApi = () => process.env.COPYBOT_TELEGRAM_API || 'https://api.telegram.org';

export type AlertKind = 'trades' | 'errors' | 'guard' | 'autopilot';
export const isTelegramToken = (s: string) => /^\d{5,15}:[\w-]{30,60}$/.test(s);
export const isDiscordWebhook = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(u.hostname) && /^\/api\/webhooks\/\d+\/[\w-]+$/.test(u.pathname);
  } catch {
    return false;
  }
};
export const isChatId = (s: string) => /^-?\d{3,20}$/.test(s) || /^@[A-Za-z]\w{4,31}$/.test(s);

/** Plain text only, short. */
export const clip = (s: string, max = 900) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);

type Channels = { telegram: { token: string; chatId: string } | null; discord: string | null };
export function channels(): Channels {
  let token: string | null = null;
  let discord: string | null = null;
  try {
    token = readSecret('TELEGRAM_BOT_TOKEN', 'Telegram bot token');
  } catch {
    /* encrypted for another machine */
  }
  try {
    discord = readSecret('DISCORD_WEBHOOK_URL', 'Discord webhook');
  } catch {
    /* same */
  }
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || '';
  return { telegram: token && chatId ? { token, chatId } : null, discord: discord && isDiscordWebhook(discord) ? discord : null };
}
export const alertsConfigured = () => {
  const c = channels();
  return !!(c.telegram || c.discord);
};

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

/** Send one message to every configured channel now. Returns per-channel errors (empty = all sent). */
export async function sendNow(text: string): Promise<string[]> {
  const c = channels();
  const errs: string[] = [];
  const msg = clip(text);
  if (c.telegram) {
    await post(`${tgApi()}/bot${c.telegram.token}/sendMessage`, { chat_id: c.telegram.chatId, text: msg, disable_web_page_preview: true }).catch((e) =>
      errs.push(`Telegram: ${(e as Error).message === 'HTTP 401' ? 'the bot token was rejected' : (e as Error).message === 'HTTP 400' ? 'wrong chat ID, or you haven’t messaged the bot yet' : (e as Error).message}`),
    );
  }
  if (c.discord) {
    await post(c.discord, { content: msg, allowed_mentions: { parse: [] }, username: 'Remora' }).catch((e) => errs.push(`Discord: ${(e as Error).message === 'HTTP 404' ? 'the webhook no longer exists' : (e as Error).message}`));
  }
  return errs;
}

/** Find the chat ID of whoever last messaged the bot (so the user doesn't have to look it up). */
export async function detectTelegramChat(token: string): Promise<{ chatId: string; name: string } | null> {
  const r = await fetch(`${tgApi()}/bot${token}/getUpdates?limit=20`, { signal: AbortSignal.timeout(10_000) });
  if (r.status === 401 || r.status === 404) throw new Error('Telegram rejected the bot token. Copy it again from @BotFather.');
  if (!r.ok) throw new Error(`Telegram error (HTTP ${r.status})`);
  const j = (await r.json()) as { result?: { message?: { chat?: { id?: number; first_name?: string; title?: string; username?: string } } }[] };
  const chats = (j.result ?? []).map((u) => u.message?.chat).filter((c): c is NonNullable<typeof c> => typeof c?.id === 'number');
  const c = chats[chats.length - 1];
  return c ? { chatId: String(c.id), name: clip(c.first_name || c.title || c.username || 'you', 40) } : null;
}

/**
 * Queue with limits: at most `perMinute` messages a minute (extra ones are merged into one
 * summary), and the same error text at most once per 10 minutes.
 */
export class AlertQueue {
  private sentAt: number[] = [];
  private held: string[] = [];
  private lastError = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private send: (text: string) => Promise<unknown>,
    private perMinute = 12,
    private now: () => number = Date.now,
  ) {}

  push(text: string, kind?: AlertKind) {
    if (kind === 'errors') {
      const key = text.replace(/\d+/g, '#');
      const last = this.lastError.get(key) ?? -Infinity;
      if (this.now() - last < 10 * 60_000) return false;
      this.lastError.set(key, this.now());
      if (this.lastError.size > 200) this.lastError.delete(this.lastError.keys().next().value!);
    }
    this.sentAt = this.sentAt.filter((t) => this.now() - t < 60_000);
    if (this.sentAt.length < this.perMinute && !this.held.length) {
      this.sentAt.push(this.now());
      this.send(text).catch(() => {});
      return true;
    }
    this.held.push(text);
    this.timer ??= setTimeout(() => this.flush(), 60_000);
    this.timer.unref?.();
    return false;
  }

  flush() {
    this.timer = null;
    if (!this.held.length) return;
    const all = this.held.splice(0);
    const body = all.length === 1 ? all[0] : `${all.length} updates:\n` + all.map((t) => `• ${t.split('\n')[0]}`).join('\n');
    this.sentAt.push(this.now());
    this.send(body).catch(() => {});
  }
}
