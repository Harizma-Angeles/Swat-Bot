// ===================== СВЕРКА ВЫГОВОРОВ: ИГРА ↔ ДИСКОРД =====================
// Lua-скрипт (MoonLoader) ловит окно /members в игре и шлёт на бота «ник, число выговоров».
// Бот сверяет с выговорами в Дискорде, пишет расхождения в канал (кнопки «Сделано» / «Отменить оповещение»)
// и присылает полную таблицу.
const http = require('http');
const crypto = require('crypto');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');

module.exports = function createPredSync(client, cfg) {
  const { store, colors, ids, controllerUserIds, controllerRoleIds, port, getRegistry, countDiscordPreds } = cfg;

  const S = store.data;
  S.game ??= {}; // lower(ник) → { nick, count, rank, raw, seen }
  S.alerts ??= {}; // userId → { g, d, msgId, status: open|done|dismissed, doneAt }
  S.tableMsgIds ??= [];
  if (process.env.PREDSYNC_TOKEN) S.token = process.env.PREDSYNC_TOKEN;
  S.token ??= crypto.randomBytes(16).toString('hex');
  store.save();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (n) => String(n ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  const channel = (id) => client.channels.fetch(id).catch(() => null);
  const MAX_ALERTS_PER_SNAPSHOT = 20;
  const DONE_RECHECK_MS = 10 * 60_000; // «Сделано», а расхождение всё ещё есть — напомним не раньше чем через 10 минут

  // ---------- Права ----------
  const canPress = (member) =>
    !!member && (controllerUserIds.includes(member.id) || member.roles.cache.some((r) => controllerRoleIds.includes(r.id)));

  // ---------- Реестр: игровой ник → Discord ID ----------
  function registryMap() {
    const m = new Map();
    for (const [id, nick] of getRegistry()) if (nick) m.set(norm(nick), id);
    return m;
  }

  // ---------- Оповещения ----------
  const row = (uid) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ps_done:${uid}`).setLabel('Сделано').setStyle(ButtonStyle.Success).setEmoji('✅'),
      new ButtonBuilder().setCustomId(`ps_dismiss:${uid}`).setLabel('Отменить оповещение').setStyle(ButtonStyle.Secondary).setEmoji('🚫')
    );

  function alertEmbed(uid, nick, g, d) {
    const inGameMore = g > d;
    return new EmbedBuilder()
      .setColor(inGameMore ? colors.warn : colors.no)
      .setTitle(inGameMore ? '⚠️ Выговор есть в игре, но не в Дискорде' : '⚠️ Выговор есть в Дискорде, но не в игре')
      .setDescription(
        `Игрок: <@${uid}> — \`${nick}\`\n\n` +
          (inGameMore
            ? 'В игре выговор выдан, а в Дискорде — нет. Нужно выдать выговор в Дискорде.'
            : 'В Дискорде выговор выдан, а в игре — нет. Нужно выдать выговор в игре.')
      )
      .addFields(
        { name: '🎮 В игре', value: String(g), inline: true },
        { name: '💬 В Дискорде', value: String(d), inline: true }
      )
      .setTimestamp();
  }

  async function sendAlert(uid, nick, g, d) {
    const ch = await channel(ids.alertChannel);
    if (!ch) return console.error('Сверка выговоров: канал оповещений не найден.');
    const old = S.alerts[uid];
    if (old?.msgId) await ch.messages.delete(old.msgId).catch(() => {});
    const msg = await ch
      .send({
        content: controllerRoleIds.map((r) => `<@&${r}>`).join(' '),
        embeds: [alertEmbed(uid, nick, g, d)],
        components: [row(uid)],
        allowedMentions: { roles: controllerRoleIds, users: [] },
      })
      .catch((e) => { console.error('Сверка выговоров: не отправить оповещение:', e.message); return null; });
    S.alerts[uid] = { g, d, nick, msgId: msg?.id ?? null, status: 'open' };
    store.save();
  }

  async function closeAlertMessage(uid, text, color) {
    const a = S.alerts[uid];
    if (!a?.msgId) return;
    const ch = await channel(ids.alertChannel);
    const msg = await ch?.messages.fetch(a.msgId).catch(() => null);
    if (!msg) return;
    const emb = EmbedBuilder.from(msg.embeds[0] ?? new EmbedBuilder()).setColor(color).setFooter({ text });
    await msg.edit({ content: '', embeds: [emb], components: [] }).catch(() => {});
  }

  /** Сравнивает одну запись. Возвращает 'ok' | 'mismatch' | 'unknown' */
  async function evaluate(entry, map, budget) {
    const uid = map.get(norm(entry.nick));
    if (!uid) return 'unknown';
    const g = entry.count;
    const d = countDiscordPreds(uid);
    const a = S.alerts[uid];
    if (g === d) {
      if (a) { await closeAlertMessage(uid, '✅ Теперь совпадает', colors.ok); delete S.alerts[uid]; store.save(); }
      return 'ok';
    }
    const same = a && a.g === g && a.d === d;
    if (same && a.status === 'open') return 'mismatch';
    if (same && a.status === 'dismissed') return 'mismatch';
    if (same && a.status === 'done' && Date.now() - (a.doneAt ?? 0) < DONE_RECHECK_MS) return 'mismatch';
    if (budget.left > 0) {
      budget.left--;
      await sendAlert(uid, entry.nick, g, d);
      await sleep(400);
    }
    return 'mismatch';
  }

  // ---------- Таблица ----------
  async function sendTable(map, stats) {
    const ch = await channel(ids.tableChannel);
    if (!ch) return;
    const rows = Object.values(S.game).map((e) => {
      const uid = map.get(norm(e.nick));
      const d = uid ? countDiscordPreds(uid) : null;
      const st = uid == null ? 'unknown' : d === e.count ? 'ok' : 'mismatch';
      return { nick: e.nick, g: e.count, d, st, seen: e.seen };
    });
    const order = { mismatch: 0, unknown: 1, ok: 2 };
    rows.sort((a, b) => order[a.st] - order[b.st] || a.nick.localeCompare(b.nick, 'en', { sensitivity: 'base' }));
    const icon = { ok: '✅', mismatch: '⚠️', unknown: '❓' };
    const w = Math.max(10, ...rows.map((r) => r.nick.length));
    const lines = [`${'Ник'.padEnd(w)}  Игра  Дискорд`];
    for (const r of rows) lines.push(`${r.nick.padEnd(w)}  ${String(r.g).padEnd(4)}  ${String(r.d ?? '-').padEnd(7)} ${icon[r.st]}`);

    const chunks = [];
    let cur = [];
    let len = 0;
    for (const l of lines) {
      if (len + l.length + 1 > 1800) { chunks.push(cur); cur = []; len = 0; }
      cur.push(l); len += l.length + 1;
    }
    if (cur.length) chunks.push(cur);

    // Ничего не изменилось с прошлой таблицы — не переотправляем (скрипт может слать данные каждые несколько секунд)
    const hash = crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
    if (S.tableHash === hash && S.tableMsgIds.length) return;
    S.tableHash = hash;
    for (const id of S.tableMsgIds) await ch.messages.delete(id).catch(() => {});
    S.tableMsgIds = [];
    const mism = rows.filter((r) => r.st === 'mismatch').length;
    const unk = rows.filter((r) => r.st === 'unknown').length;
    const head = await ch
      .send({
        content:
          `📊 **Сверка выговоров** — обновлено <t:${Math.floor(Date.now() / 1000)}:f>\n` +
          `Игроков в таблице: **${rows.length}** • ✅ совпадает: **${rows.length - mism - unk}** • ⚠️ расхождений: **${mism}** • ❓ нет в Дискорде (нет в реестре ников): **${unk}**` +
          (stats?.unparsed ? `\n⚠️ Строк, где не удалось найти выговоры: **${stats.unparsed}**` : ''),
        allowedMentions: { parse: [] },
      })
      .catch(() => null);
    if (head) S.tableMsgIds.push(head.id);
    for (const c of chunks) {
      const m = await ch.send({ content: '```\n' + c.join('\n') + '\n```', allowedMentions: { parse: [] } }).catch(() => null);
      if (m) S.tableMsgIds.push(m.id);
      await sleep(300);
    }
    store.save();
  }

  // ---------- Приём данных из игры ----------
  /** Тело: строки «ник \t число|? \t звание \t сырая строка» */
  async function processBody(text) {
    const entries = [];
    let unparsed = 0;
    for (const line of text.split('\n')) {
      const p = line.replace(/\r/g, '').split('\t');
      const nick = (p[0] ?? '').trim();
      if (!/^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(nick)) continue;
      const count = /^\d{1,2}$/.test((p[1] ?? '').trim()) ? Number(p[1]) : null;
      if (count == null) { unparsed++; continue; }
      entries.push({ nick, count, rank: (p[2] ?? '').slice(0, 40), raw: (p[3] ?? '').slice(0, 200), seen: Date.now() });
    }
    for (const e of entries) S.game[norm(e.nick)] = e;
    S.lastSnapshotAt = Date.now();
    store.save();

    const map = registryMap();
    const budget = { left: MAX_ALERTS_PER_SNAPSHOT };
    const res = { matched: 0, mismatch: 0, unknown: 0 };
    for (const e of entries) {
      const r = await evaluate(e, map, budget);
      res[r === 'ok' ? 'matched' : r]++;
    }
    await sendTable(map, { unparsed });
    return { received: entries.length, unparsed, ...res };
  }

  const tokenOk = (given) => {
    const a = Buffer.from(String(given ?? ''));
    const b = Buffer.from(S.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  function startServer() {
    const server = http.createServer((req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url === '/ping') return send(200, { ok: true });
      if (req.method !== 'POST' || req.url !== '/members') return send(404, { ok: false });
      if (!tokenOk(req.headers['x-token'])) return send(403, { ok: false, error: 'bad token' });
      let body = '';
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 512 * 1024) { send(413, { ok: false }); req.destroy(); return; }
        body += c;
      });
      req.on('end', async () => {
        try {
          send(200, { ok: true, ...(await processBody(body)) });
        } catch (e) {
          console.error('Сверка выговоров: ошибка обработки:', e);
          send(500, { ok: false });
        }
      });
    });
    server.on('error', (e) => console.error(`Сверка выговоров: сервер не запущен (порт ${port}):`, e.message));
    server.listen(port, '0.0.0.0', () =>
      console.log(`Сверка выговоров: слушаю порт ${port}. Токен для Lua-скрипта: ${S.token}`)
    );
  }

  // ---------- Кнопки ----------
  const owns = (i) => i.isButton() && /^ps_(done|dismiss):/.test(i.customId);
  async function handle(i) {
    if (!canPress(i.member)) return i.reply({ content: '❌ У вас нет прав на эту кнопку.', flags: MessageFlags.Ephemeral });
    const [action, uid] = i.customId.split(':');
    const a = S.alerts[uid];
    const base = EmbedBuilder.from(i.message.embeds[0]);
    if (action === 'ps_done') {
      if (a) { a.status = 'done'; a.doneAt = Date.now(); store.save(); }
      base.setColor(colors.ok).setFooter({ text: `✅ Сделано — ${i.user.tag}` });
    } else {
      if (a) { a.status = 'dismissed'; store.save(); }
      base.setColor(0x95a5a6).setFooter({ text: `🚫 Оповещение отменено — ${i.user.tag}` });
    }
    await i.update({ content: '', embeds: [base], components: [] });
  }

  /** Раз в 2 минуты: если в Дискорде выдали/сняли выговор и всё сошлось — закрываем оповещения. */
  async function tick() {
    for (const uid of Object.keys(S.alerts)) {
      const a = S.alerts[uid];
      const e = S.game[norm(a.nick)];
      if (e && e.count === countDiscordPreds(uid)) {
        await closeAlertMessage(uid, '✅ Теперь совпадает', colors.ok);
        delete S.alerts[uid];
        store.save();
      }
    }
  }

  function init() {
    startServer();
    setInterval(() => tick().catch(() => {}), 120_000);
  }

  return { init, owns, handle };
};
