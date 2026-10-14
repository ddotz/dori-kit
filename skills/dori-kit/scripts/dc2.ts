import { cfg } from "./config.ts";
const TOKEN = JSON.parse(await Bun.file(`${process.env.HOME}/.config/agent-messenger/discordbot-credentials.json`).text()).bots[cfg.discord.bot_name].token;
export const dc2 = {
  async request(method: string, path: string, body?: unknown) {
    const r = await fetch('https://discord.com/api/v10'+path, { method, headers: { Authorization: 'Bot '+TOKEN, 'Content-Type':'application/json' }, body: body? JSON.stringify(body): undefined });
    if (!r.ok) throw new Error(r.status+' '+await r.text()); return r.status===204? null : r.json();
  },
  sendMessage(ch: string, content: string, opts: { reply_to?: string } = {}) { return this.request('POST', '/channels/'+ch+'/messages', { content, ...(opts.reply_to? { message_reference: { message_id: opts.reply_to, fail_if_not_exists:false } }: {}) }); }
};