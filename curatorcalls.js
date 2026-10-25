const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, MessageFlags,
} = require('discord.js');

module.exports = function createCuratorCalls(client, cfg) {
  const { guildId, ids, controllerRoleIds, store, sendDM, colors } = cfg;
  const S = store.data;
  S.calls ??= {};
  S.effects ??= {};
  S.muted ??= false;
  S.deafened ??= false;
  S.locked ??= false;
  S.logs ??= [];
  const locks = new Set();
  const guild = () => client.guilds.cache.get(guildId);
  const control = (m) => !!m && m.roles.cache.some((r) => controllerRoleIds.includes(r.id));
  const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
  const save = () => store.saveNow();
  const channel = (id) => client.channels.fetch(id);
  const button = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  const commands = ['call', 'uncall'].map((name) => new SlashCommandBuilder()
    .setName(name).setDescription(name === 'call' ? 'Вызвать участника в кабинет Отца' : 'Отменить вызов к Отцу')
    .addUserOption((o) => o.setName('человек').setDescription('Участник сервера').setRequired(true))
    .addStringOption((o) => o.setName('причина').setDescription('Причина (необязательно)').setMaxLength(500)));

  // Логи сохраняются до успешной доставки: краткий сбой Discord не теряет действия.
  let logging = false;
  async function flushLogs() {
    if (logging || !S.logs.length) return;
    logging = true;
    try {
      const ch = await channel(ids.logChannel);
      while (S.logs.length) {
        await ch.send({ embeds: [S.logs[0]], allowedMentions: { parse: [] } });
        S.logs.shift(); save();
      }
    } catch (e) { console.error('Вызовы: доставка логов:', e.message); }
    finally { logging = false; }
  }
  async function log(title, text) {
    S.logs.push(new EmbedBuilder().setColor(colors.main).setTitle(title)
      .setDescription(text.slice(0, 4000)).setTimestamp().toJSON());
    save(); await flushLogs();
  }
  function panelPayload() {
    return {
      embeds: [new EmbedBuilder().setColor(colors.main).setTitle('Кабинет Отца — управление')
        .setDescription('Для управления нужна одна из ролей управления (ОП, 9 и 10 ранги, «*») и присутствие в <#' + ids.officeVoice + '>.\n\n' +
          '**Кик всех** — отключает посетителей от войса кабинета.\n' +
          '**Заглушить всех** — включает серверное заглушение посетителей; повторное нажатие возвращает прежнее состояние.\n' +
          '**Отключить наушники** — отключает звук посетителям; повторное нажатие возвращает прежнее состояние.\n' +
          '**Не впускать** — бот отключает новых посетителей от кабинета; повторное нажатие открывает вход. Одобренный кнопкой «Да» перенос разрешён.\n' +
          'Участники с ролями управления и боты не затрагиваются. Новые посетители получают включённые ограничения. При выходе ограничения, применённые этой панелью, снимаются.\n\n' +
          '**/call человек [причина]** — вызов в ЛС: явиться в канал ожидания <#' + ids.waitingVoice + '> в течение 24 часов.\n' +
          '**/uncall человек [причина]** — отменить вызов и уведомить в ЛС.\n' +
          'При появлении вызванного участника в любом войсе появится предложение переноса. Кнопка «Нет» отменяет вызов, а через 24 часа после вызова он закрывается сам (без пингов, запись остаётся в логе).\n\n' +
          'Микрофоны: **' + (S.muted ? 'заглушены' : 'обычно') + '** • Наушники: **' + (S.deafened ? 'отключены' : 'обычно') + '** • Вход: **' + (S.locked ? 'закрыт' : 'открыт') + '**')],
      components: [new ActionRowBuilder().addComponents(
        button('cc_kick', 'Кик всех', ButtonStyle.Danger),
        button('cc_mute', S.muted ? 'Разглушить всех' : 'Заглушить всех', ButtonStyle.Secondary),
        button('cc_deaf', S.deafened ? 'Включить наушники' : 'Отключить наушники', ButtonStyle.Secondary),
        button('cc_lock', S.locked ? 'Впускать' : 'Не впускать', ButtonStyle.Secondary))],
      allowedMentions: { parse: [] },
    };
  }
  async function syncPanel() {
    const ch = await channel(ids.setupChannel);
    let msg;
    if (S.panelId) {
      try { msg = await ch.messages.fetch(S.panelId); }
      catch (e) { if (e.code !== 10008) throw e; }
    }
    if (!msg) {
      const recent = await ch.messages.fetch({ limit: 100 });
      msg = recent.find((m) => m.author.id === client.user.id && m.components.some((r) => r.components.some((c) => c.customId === 'cc_kick')));
    }
    if (msg) await msg.edit(panelPayload());
    else msg = await ch.send(panelPayload());
    S.panelId = msg.id; save();
  }
  async function guard(i) {
    const m = await i.guild.members.fetch(i.user.id);
    if (!control(m)) { await i.reply(ephemeral('Нет прав: нужна одна из ролей управления кабинетом.')); return false; }
    if (m.voice.channelId !== ids.officeVoice) { await i.reply(ephemeral('Для управления зайдите в кабинет <#' + ids.officeVoice + '>.')); return false; }
    return true;
  }
  async function deletePrompt(c) {
    if (!c.promptId) return;
    const ch = await channel(ids.setupChannel);
    try { await ch.messages.delete(c.promptId); }
    catch (e) { if (e.code !== 10008) throw e; }
    delete c.promptId; delete c.promptVoice; save();
  }
  async function prompt(c, m) {
    if (!m.voice.channelId || m.voice.channelId === ids.officeVoice || c.status === 'cancelled' || c.status === 'completed') return;
    if (c.promptId && c.promptVoice === m.voice.channelId) return;
    await deletePrompt(c);
    // /uncall мог выполниться, пока шла доставка сообщения.
    if (S.calls[m.id] !== c || ['cancelled', 'completed'].includes(c.status)) return;
    const ch = await channel(ids.setupChannel);
    const text = m.voice.channelId === ids.waitingVoice ? 'зашёл в канал ожидания' : 'находится в голосовом канале <#' + m.voice.channelId + '>';
    const msg = await ch.send({
      content: '<@' + c.callerId + '>, участник <@' + m.id + '> ' + text + '. Перекинуть его в кабинет Отца?',
      components: [new ActionRowBuilder().addComponents(
        button('cc_yes:' + m.id + ':' + c.id, 'Да', ButtonStyle.Success),
        button('cc_no:' + m.id + ':' + c.id, 'Нет', ButtonStyle.Secondary))],
      allowedMentions: { users: [c.callerId] },
    });
    c.promptId = msg.id; c.promptVoice = m.voice.channelId; save();
    await log('Предложение переноса', 'Участник <@' + m.id + '>; вызвал <@' + c.callerId + '>; войс <#' + m.voice.channelId + '>.');
  }
  // Сохраняем прежний server mute/deaf, чтобы не снимать чужие ограничения.
  async function applyEffects(m) {
    if (control(m) || m.user.bot || m.voice.channelId !== ids.officeVoice) return;
    for (const [flag, enabled] of [['mute', S.muted], ['deaf', S.deafened]]) {
      if (!enabled) continue;
      const entry = S.effects[m.id] ??= {};
      if (!(flag in entry)) { entry[flag] = !!m.voice[flag === 'mute' ? 'serverMute' : 'serverDeaf']; save(); }
      await m.edit({ [flag]: true }, 'Панель кабинета Отца');
    }
  }
  async function restoreEffects(m, flag) {
    const entry = S.effects[m.id];
    if (!entry || !m.voice.channelId) return;
    for (const key of flag ? [flag] : ['mute', 'deaf']) {
      if (!(key in entry)) continue;
      if (m.voice.channelId) await m.edit({ [key]: entry[key] }, 'Возврат состояния до панели Отца');
      delete entry[key]; save();
    }
    if (!Object.keys(entry).length) { delete S.effects[m.id]; save(); }
  }
  async function command(i) {
    const user = i.options.getUser('человек', true);
    const key = 'user:' + user.id;
    if (locks.has(key)) return i.reply(ephemeral('Вызов этого участника уже обрабатывается.'));
    locks.add(key);
    try {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const reason = i.options.getString('причина')?.trim() || 'Не указана';
      const prev = S.calls[user.id];
      if (i.commandName === 'uncall') {
        if (!prev || ['cancelled', 'completed'].includes(prev.status)) return i.editReply('У участника нет открытого вызова.');
        prev.status = 'cancelled'; prev.cancelledAt = Date.now(); save();
        await deletePrompt(prev);
        const ok = await sendDM(user.id, { content: 'Ваш вызов в кабинет Отца на сервере «' + i.guild.name + '» отменён.\nОтменил: <@' + i.user.id + '>.\nПричина: ' + reason, allowedMentions: { parse: [] } });
        await log('Вызов отменён', 'Участник <@' + user.id + '>; отменил <@' + i.user.id + '>.\nПричина: ' + reason + '\nЛС: ' + (ok ? 'доставлено' : 'не доставлено'));
        return i.editReply('Вызов отменён.' + (ok ? ' ЛС отправлено.' : ' Не удалось отправить ЛС.'));
      }
      if (user.bot || user.id === i.user.id) return i.editReply('Нельзя вызвать себя или бота.');
      const m = await i.guild.members.fetch(user.id).catch((e) => { if (e.code === 10007) return null; throw e; });
      if (!m) return i.editReply('Участник не найден на сервере.');
      if (prev && !['cancelled', 'completed'].includes(prev.status)) return i.editReply('У участника уже есть открытый вызов. Сначала отмените его через /uncall.');
      const c = { id: require('crypto').randomBytes(6).toString('hex'), userId: user.id, callerId: i.user.id, reason, createdAt: Date.now(), deadline: Date.now() + 86400000, status: 'pending' };
      S.calls[user.id] = c; save();
      const ok = await sendDM(user.id, {
        content: 'Вас вызывают в кабинет Отца на сервере «' + i.guild.name + '».\nВызвал: <@' + i.user.id + '>.\nПричина: ' + reason + '\n\nВ течение 24 часов зайдите в канал ожидания: https://discord.com/channels/' + guildId + '/' + ids.waitingVoice + '\nСрок: <t:' + Math.floor(c.deadline / 1000) + ':F>. За неявку вы можете получить наказание.',
        allowedMentions: { parse: [] },
      });
      c.dmDelivered = ok; save();
      await log('Вызов создан', 'Участник <@' + user.id + '>; вызвал <@' + i.user.id + '>.\nПричина: ' + reason + '\nЛС: ' + (ok ? 'доставлено' : 'не доставлено') + '\nСрок: <t:' + Math.floor(c.deadline / 1000) + ':F>.');
      if (m.voice.channelId === ids.waitingVoice || m.voice.channelId === ids.officeVoice) { c.arrivedAt = Date.now(); c.status = m.voice.channelId === ids.officeVoice ? 'completed' : 'arrived'; save(); }
      if (m.voice.channelId) await prompt(c, m);
      await i.editReply('Вызов создан.' + (ok ? ' ЛС отправлено.' : ' ЛС не доставлено — сообщите участнику о вызове самостоятельно.'));
    } finally { locks.delete(key); }
  }
  async function decide(i) {
    const [action, uid, id] = i.customId.split(':');
    const key = 'user:' + uid;
    if (locks.has(key)) return i.reply(ephemeral('Этот вызов уже обрабатывается.'));
    locks.add(key);
    try {
      const c = S.calls[uid];
      if (!c || c.id !== id || c.promptId !== i.message.id || ['cancelled', 'completed'].includes(c.status)) {
        await i.reply(ephemeral('Предложение устарело.'));
        await i.message.delete(); return;
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (action === 'cc_yes') {
          const m = await i.guild.members.fetch(uid);
          if (!m.voice.channelId) { await i.editReply('Участник уже вышел из войса.'); return; }
          c.admitted = true; save();
          try { await m.voice.setChannel(ids.officeVoice, 'Вызов к Отцу: ' + i.user.tag); }
          catch (e) { c.admitted = false; save(); throw e; }
          c.status = 'completed'; c.completedAt = Date.now(); save();
          await log('Участник перенесён', '<@' + uid + '> перенесён в кабинет. Выполнил <@' + i.user.id + '>; вызвал <@' + c.callerId + '>.');
          await i.editReply('Участник перенесён в кабинет.');
        } else {
          c.status = 'cancelled'; c.cancelledAt = Date.now(); c.cancelReason = 'declined'; save(); // «Нет» закрывает вызов насовсем — больше никаких вопросов и пингов
          await log('Перенос отклонён — вызов отменён', 'Участник <@' + uid + '>; отказал <@' + i.user.id + '>; вызвал <@' + c.callerId + '>. Вызов закрыт.');
          await i.editReply('Перенос отклонён, вызов отменён.');
        }
      } finally { await deletePrompt(c); }
    } finally { locks.delete(key); }
  }
  async function panelAction(i) {
    if (locks.has('panel')) return i.reply(ephemeral('Панель уже обрабатывает действие.'));
    locks.add('panel');
    try {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const office = await channel(ids.officeVoice);
      const action = i.customId;
      let ok = 0; const errors = [];
      if (action === 'cc_lock') { S.locked = !S.locked; save(); }
      else {
        const flag = action === 'cc_mute' ? 'mute' : action === 'cc_deaf' ? 'deaf' : null;
        if (flag) { S[flag === 'mute' ? 'muted' : 'deafened'] = !S[flag === 'mute' ? 'muted' : 'deafened']; save(); }
        const members = action === 'cc_kick' || (flag && S[flag === 'mute' ? 'muted' : 'deafened'])
          ? [...office.members.values()].filter((m) => !m.user.bot && !control(m))
          : await Promise.all(Object.keys(S.effects).map((uid) => i.guild.members.fetch(uid).catch(() => null)));
        for (const m of members) {
          if (!m) continue;
          try {
            if (action === 'cc_kick') await m.voice.disconnect('Панель кабинета: ' + i.user.tag);
            else if (S[flag === 'mute' ? 'muted' : 'deafened']) await applyEffects(m);
            else await restoreEffects(m, flag);
            ok++;
          } catch (e) { errors.push('<@' + m.id + '>: ' + e.message); }
        }
      }
      const TITLES = { cc_kick: 'Кик всех', cc_mute: S.muted ? 'Заглушить всех' : 'Разглушить всех', cc_deaf: S.deafened ? 'Отключить наушники' : 'Включить наушники', cc_lock: S.locked ? 'Не впускать (вход закрыт)' : 'Впускать (вход открыт)' };
      await log('Кабинет Отца: ' + (TITLES[action] ?? action), 'Выполнил <@' + i.user.id + '>. Успешно: ' + ok + '.\nВход: ' + (S.locked ? 'закрыт' : 'открыт') + '; микрофоны: ' + (S.muted ? 'заглушены' : 'обычные') + '; наушники: ' + (S.deafened ? 'отключены' : 'обычные') + '.\n' + errors.join('\n'));
      await syncPanel();
      await i.editReply('Готово. Успешно: ' + ok + '.' + (errors.length ? ' Ошибок: ' + errors.length + '. Подробности в логе.' : ''));
    } finally { locks.delete('panel'); }
  }
  async function onVoice(oldS, newS) {
    if (newS.guild.id !== guildId || oldS.channelId === newS.channelId) return;
    const m = newS.member ?? oldS.member;
    if (!m || m.user.bot) return;
    if (oldS.channelId === ids.officeVoice && m.voice.channelId !== ids.officeVoice) {
      if (S.calls[m.id]) { delete S.calls[m.id].admitted; save(); }
      await restoreEffects(m);
    }
    if (m.voice.channelId && m.voice.channelId !== ids.officeVoice && S.effects[m.id]) await restoreEffects(m);
    if (m.voice.channelId !== newS.channelId) return; // Участник уже сменил войс, пока выполнялся запрос Discord.
    if (newS.channelId === ids.officeVoice) {
      if (S.locked && !control(m) && !S.calls[m.id]?.admitted) {
        await m.voice.disconnect('Кабинет Отца закрыт для входа');
        await log('Вход в кабинет отклонён', 'Участник <@' + m.id + '>: включено «Не впускать».');
        return;
      }
      await applyEffects(m);
    }
    const c = S.calls[m.id];
    if (!c || ['cancelled', 'completed'].includes(c.status) || locks.has('user:' + m.id)) return;
    locks.add('user:' + m.id);
    try {
      if (newS.channelId === ids.waitingVoice || newS.channelId === ids.officeVoice) {
        if (!c.arrivedAt) { c.arrivedAt = Date.now(); c.status = 'arrived'; save(); await log('Участник явился', '<@' + m.id + '> вошёл в <#' + newS.channelId + '>. Вызвал <@' + c.callerId + '>.'); }
        if (newS.channelId === ids.officeVoice) { c.status = 'completed'; c.completedAt = Date.now(); save(); }
      }
      await deletePrompt(c);
      delete c.declinedVoice; save();
      if (newS.channelId) await prompt(c, m);
    } finally { locks.delete('user:' + m.id); }
  }
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await flushLogs();
      const g = guild(); if (!g) return;
      for (const uid of Object.keys(S.effects)) {
        const m = g.members.cache.get(uid);
        if (!m?.voice.channelId) continue;
        try {
          if (m.voice.channelId !== ids.officeVoice || control(m)) await restoreEffects(m);
          else { if (!S.muted) await restoreEffects(m, 'mute'); if (!S.deafened) await restoreEffects(m, 'deaf'); }
        } catch (e) { console.error('Кабинет: восстановление голоса:', e.message); }
      }
      for (const [uid, c] of Object.entries(S.calls)) {
        if (locks.has('user:' + uid)) continue;
        locks.add('user:' + uid);
        try {
          const current = g.members.cache.get(uid);
          if (['pending', 'overdue', 'arrived'].includes(c.status) && [ids.waitingVoice, ids.officeVoice].includes(current?.voice.channelId)) {
            if (!c.arrivedAt) { c.arrivedAt = Date.now(); await log('Участник явился', '<@' + uid + '> находится в <#' + current.voice.channelId + '>. Вызвал <@' + c.callerId + '>.'); }
            c.status = current.voice.channelId === ids.officeVoice ? 'completed' : 'arrived'; save();
          }
          // Прошли сутки с момента вызова — вызов закрывается сам. Без пингов: запись остаётся только в логе.
          if (['pending', 'arrived', 'overdue'].includes(c.status) && c.deadline <= Date.now()) {
            c.status = 'cancelled'; c.cancelledAt = Date.now(); c.cancelReason = 'expired'; save();
            await deletePrompt(c);
            await log('Вызов закрыт по сроку', '<@' + uid + '> не был перенесён в кабинет за 24 часа. Вызвал <@' + c.callerId + '>.\nПричина: ' + c.reason + '\nЛС вызова: ' + (c.dmDelivered ? 'доставлено' : 'не доставлено') + '.');
            continue;
          }
          if (['cancelled', 'completed'].includes(c.status)) { await deletePrompt(c); continue; }
          const m = g.members.cache.get(uid);
          if (c.promptId && c.promptVoice !== m?.voice.channelId) { await deletePrompt(c); delete c.declinedVoice; save(); }
          if (m?.voice.channelId && !c.promptId && c.declinedVoice !== m.voice.channelId) await prompt(c, m);
        } catch (e) { console.error('Вызовы: проверка участника:', e.message); }
        finally { locks.delete('user:' + uid); }
      }
    } finally { ticking = false; }
  }
  function owns(i) {
    return (i.isChatInputCommand() && ['call', 'uncall'].includes(i.commandName)) || (i.isButton() && i.customId.startsWith('cc_'));
  }
  async function handleAction(i) {
    if (i.guildId !== guildId || !(await guard(i))) return;
    if (i.isButton() && i.channelId !== ids.setupChannel) return i.reply(ephemeral('Эта кнопка работает только в канале настройки.'));
    if (i.isChatInputCommand()) return command(i);
    if (/^cc_(yes|no):/.test(i.customId)) return decide(i);
    if (['cc_kick', 'cc_mute', 'cc_deaf', 'cc_lock'].includes(i.customId)) return panelAction(i);
    return i.reply(ephemeral('Неизвестная кнопка.'));
  }
  async function handle(i) {
    try { return await handleAction(i); }
    catch (e) {
      await log('Ошибка действия кабинета', 'Выполнил <@' + i.user.id + '>. Действие: ' + (i.commandName || i.customId) + '.\n' + e.message);
      throw e;
    }
  }
  async function init() {
    // Подписываемся независимо от доступности панели.
    client.on('voiceStateUpdate', (o, n) => onVoice(o, n).catch(async (e) => {
      console.error('Вызовы: голосовое событие:', e.message);
      await log('Ошибка голосового действия', 'Участник <@' + n.id + '>: ' + e.message);
    }));
    setInterval(() => tick().catch((e) => console.error('Вызовы: таймер:', e.message)), 30000).unref?.();
    const g = guild();
    if (g) {
      for (const uid of Object.keys(S.effects)) {
        const m = await g.members.fetch(uid).catch(() => null);
        if (m && (m.voice.channelId !== ids.officeVoice || control(m))) await restoreEffects(m);
        else if (m) { if (!S.muted) await restoreEffects(m, 'mute'); if (!S.deafened) await restoreEffects(m, 'deaf'); }
      }
      const office = await channel(ids.officeVoice);
      for (const m of office.members.values()) await applyEffects(m);
      for (const c of Object.values(S.calls)) {
        const m = g.members.cache.get(c.userId);
        if (['pending', 'overdue', 'arrived'].includes(c.status) && [ids.waitingVoice, ids.officeVoice].includes(m?.voice.channelId)) {
          c.arrivedAt ??= Date.now(); c.status = m.voice.channelId === ids.officeVoice ? 'completed' : 'arrived'; save();
        }
        if (c.promptId) {
          const ch = await channel(ids.setupChannel);
          try { await ch.messages.fetch(c.promptId); } catch (e) { if (e.code !== 10008) throw e; delete c.promptId; delete c.promptVoice; save(); }
          if (c.promptId && c.promptVoice !== m?.voice.channelId) await deletePrompt(c);
        }
      }
    }
    await tick();
    await syncPanel();
  }
  return { init, owns, handle, commands, _internals: { onVoice, tick, command, decide, panelAction, applyEffects, restoreEffects, S } };
};
