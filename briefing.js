// ===================== БРИФИНГИ =====================
// Отдельный модуль: назначение брифинга, напоминания, управление войсом, учёт явки,
// неявки (✅ от руководителей) и выдача выговоров.
//
// Фазы: idle → scheduled → ready → running → ended → idle
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  Routes,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
} = require('discord.js');

module.exports = function createBriefing(client, cfg) {
  const {
    guildId,
    store,
    colors,
    ids,
    controllerUserIds,
    controllerRoleIds,
    attendeeRoleIds,
    utcOffsetMin,
    pings, // { createPred(userId, modId, reason), sendDM, punishEmbed }
  } = cfg;

  const S = store.data;
  S.phase ??= 'idle';
  S.present ??= {};
  S.reminderIds ??= [];


  const validPhases = new Set(['idle', 'scheduled', 'ready', 'running', 'ended', 'recovery']);
  const persist = () => store.saveNow ? store.saveNow() : store.save();
  function archiveState(reason) {
    const { recoveryHistory, ...snapshot } = S;
    S.recoveryHistory = [...(Array.isArray(recoveryHistory) ? recoveryHistory : []),
      { at: Date.now(), reason, state: JSON.parse(JSON.stringify(snapshot)) }].slice(-5);
    persist();
  }
  // Сохраняем корректный назначенный брифинг. Повреждённое состояние показываем явно.
  if (!validPhases.has(S.phase) || (['scheduled', 'ready', 'running', 'ended'].includes(S.phase) &&
      (!Number.isFinite(Number(S.startAt)) || Number(S.startAt) <= 0))) {
    archiveState('Некорректная фаза или время после загрузки data/briefing.json');
    S.phase = 'recovery'; persist();
  } else if (S.phase !== 'idle' && S.phase !== 'recovery') {
    S.startAt = Number(S.startAt);
  }
  if (!S.present || typeof S.present !== 'object' || Array.isArray(S.present)) S.present = {};
  if (!Array.isArray(S.reminderIds)) S.reminderIds = [];
  let lastPanelPhase = null;
  let lastControlCheck = 0;
  let controlDirty = true;
  let controlSignature = null;
  const resetConfirmations = new Map();
  let resetting = false;

  const MIN_AHEAD = 5 * 60_000;
  const MAX_AHEAD = 7 * 24 * 3600_000;
  const OK_EMOJI = '✅';
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
  const getGuild = () => client.guilds.cache.get(guildId);

  // ---------- Права ----------
  const isController = (member) =>
    !!member && (controllerUserIds.includes(member.id) || member.roles.cache.some((r) => controllerRoleIds.includes(r.id)));
  const isControllerId = (userId) => {
    if (controllerUserIds.includes(userId)) return true;
    const m = getGuild()?.members.cache.get(userId);
    return !!m && isController(m);
  };

  // ---------- Время (вводится и показывается по часовому поясу сервера, МСК = +180) ----------
  const shift = utcOffsetMin * 60_000;
  const pad = (n) => String(n).padStart(2, '0');
  function parts(ms) {
    const d = new Date(ms + shift);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
  }
  const fmtDate = (ms) => { const p = parts(ms); return `${p.d} ${MONTHS[p.mo]}`; };
  const fmtTime = (ms) => { const p = parts(ms); return `${pad(p.h)}:${pad(p.mi)}`; };
  const fmtFull = (ms) => `${fmtDate(ms)} в ${fmtTime(ms)} (МСК)`;
  const inputDate = (ms) => { const p = parts(ms); return `${pad(p.d)}.${pad(p.mo + 1)}.${pad(p.y % 100)}`; };
  const unix = (ms) => Math.floor(ms / 1000);

  /** Строго dd.mm.yy → { y, mo, d } или null */
  function parseDate(str) {
    const m = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(String(str).trim());
    if (!m) return null;
    const d = +m[1], mo = +m[2] - 1, y = 2000 + +m[3];
    const t = new Date(Date.UTC(y, mo, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo || t.getUTCDate() !== d) return null;
    return { y, mo, d };
  }
  /** Строго hh:mm → { h, mi } или null */
  function parseTime(str) {
    const m = /^(\d{2}):(\d{2})$/.exec(String(str).trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return { h: +m[1], mi: +m[2] };
  }
  const toMs = (dt, tm) => Date.UTC(dt.y, dt.mo, dt.d, tm.h, tm.mi) - shift;
  /** Проверка границ: не раньше чем через 5 минут и не позже чем через неделю. Возвращает текст ошибки или null. */
  function checkRange(ms) {
    const now = Date.now();
    if (ms < now) return '❌ Нельзя назначить брифинг на прошедшее время.';
    if (ms < now + MIN_AHEAD) return '❌ Брифинг можно назначить минимум за **5 минут** до начала.';
    if (ms > now + MAX_AHEAD) return '❌ Брифинг можно назначить максимум за **неделю** до начала.';
    return null;
  }

  // ---------- Блокировка: пока один человек работает с кнопкой, остальным нельзя ----------
  let lock = null; // { userId, until }
  const LOCK_MS = 5 * 60_000;
  function takeLock(userId) {
    if (lock && lock.until > Date.now() && lock.userId !== userId) return false;
    lock = { userId, until: Date.now() + LOCK_MS };
    return true;
  }
  const freeLock = (userId) => { if (lock?.userId === userId) lock = null; };
  const lockedBy = () => (lock && lock.until > Date.now() ? lock.userId : null);
  async function guard(i) {
    if (!isController(i.member)) {
      await i.reply(ephemeral('❌ У вас нет прав для управления брифингами.'));
      return false;
    }
    if (!takeLock(i.user.id)) {
      await i.reply(ephemeral(`⏳ Сейчас с брифингом работает <@${lockedBy()}>. Подождите, пока он закончит.`));
      return false;
    }
    return true;
  }

  // ---------- Каналы ----------
  async function channel(id) {
    return client.channels.fetch(id).catch(() => null);
  }
  const news = () => channel(ids.newsChannel);

  // ---------- Сообщения панели ----------
  const row = (...btns) => new ActionRowBuilder().addComponents(...btns);
  const btn = (id, label, style, emoji) => {
    const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
    if (emoji) b.setEmoji(emoji);
    return b;
  };

  function panelPayload() {
    if (S.phase === 'recovery') return {
      embeds: [new EmbedBuilder().setColor(colors.warn).setTitle('📢 Восстановление брифинга')
        .setDescription('Сохранённое состояние брифинга некорректно. Его копия сохранена в briefing.json. Нажмите «Сбросить брифинг», чтобы начать заново.')],
      components: [row(btn('br_reset', 'Сбросить брифинг', ButtonStyle.Danger, '↩️'))],
    };
    if (S.phase === 'idle') {
      return {
        embeds: [
          new EmbedBuilder()
            .setColor(colors.main)
            .setTitle('📢 НАСТРОЙКА БРИФИНГА')
            .setDescription(
              'Нажмите кнопку, чтобы назначить брифинг.\n\n' +
                '> Формат: `дд.мм.гг чч:мм` (время МСК)\n' +
                '> Не раньше чем через **5 минут** и не позже чем через **неделю**'
            ),
        ],
        components: [row(btn('br_new', 'Назначить брифинг', ButtonStyle.Primary, '📅'))],
      };
    }
    if (S.phase === 'scheduled') {
      return {
        embeds: [
          new EmbedBuilder()
            .setColor(colors.ok)
            .setTitle('📢 Брифинг назначен')
            .setDescription(`Брифинг будет начат в **${fmtFull(S.startAt)}**\n<t:${unix(S.startAt)}:R>`),
        ],
        components: [
          row(
            btn('br_chdate', 'Поменять дату', ButtonStyle.Secondary, '📆'),
            btn('br_chtime', 'Поменять время', ButtonStyle.Secondary, '🕐'),
            btn('br_cancel', 'Откатить брифинг', ButtonStyle.Danger, '↩️')
          ),
        ],
      };
    }
    const names = { ready: 'Время брифинга наступило', running: 'Брифинг идёт', ended: 'Брифинг завершён' };
    return {
      embeds: [new EmbedBuilder().setColor(colors.warn).setTitle(`📢 ${names[S.phase]}`).setDescription(`Начало по плану: **${fmtFull(S.startAt)}**\nУправление — в сообщении ниже.`)],
      components: [row(btn('br_reset', 'Сбросить брифинг', ButtonStyle.Secondary, '↩️'))],
    };
  }

  function controlPayload() {
    if (S.phase === 'ready') {
      return {
        embeds: [new EmbedBuilder().setColor(colors.warn).setTitle('⏰ Пора начинать брифинг').setDescription('Нажмите кнопку, когда будете готовы.')],
        components: [row(btn('br_start', 'Начать брифинг', ButtonStyle.Success, '▶️'))],
      };
    }
    if (S.phase === 'running') {
      const inChan = presentCount();
      return {
        embeds: [
          new EmbedBuilder()
            .setColor(colors.ok)
            .setTitle('🎙️ Брифинг идёт')
            .setDescription(`Начался: <t:${unix(S.startedAt)}:T>\nПрисутствовали: **${inChan}**`),
        ],
        components: [
          row(btn('br_end', 'Закончить брифинг', ButtonStyle.Danger, '⏹️')),
          row(
            btn('br_mute', 'Заглушить всех', ButtonStyle.Secondary, '🔇'),
            btn('br_unmute', 'Разглушить всех', ButtonStyle.Secondary, '🔊'),
            btn('br_deaf', 'Выключить наушники всем', ButtonStyle.Secondary, '🎧'),
            btn('br_undeaf', 'Включить всем наушники', ButtonStyle.Secondary, '🎧')
          ),
        ],
      };
    }
    // ended
    return {
      embeds: [
        new EmbedBuilder()
          .setColor(colors.main)
          .setTitle('🏁 Брифинг завершён')
          .setDescription(
            `Списки отправлены в <#${ids.listsChannel}>.\n` +
              `Не явились без одобренной неявки: **${S.absent?.length ?? 0}**\n` +
              `Выговор за посещаемость (<50% / вход после 85%): **${S.lowAttend?.length ?? 0}**` +
              (S.punished ? '\n✅ Выговоры выданы.' : '')
          ),
      ],
      components: [
        row(
          btn('br_pred', S.punished ? 'Выговоры выданы' : 'Выдать игрокам выговор', ButtonStyle.Danger, '📋').setDisabled(!!S.punished),
          btn('br_finish', 'Закончить', ButtonStyle.Success, '✔️')
        ),
      ],
    };
  }

  /** Гарантирует, что сообщение панели есть и соответствует фазе. */

  // Не создаём новую панель при сетевой ошибке: только 10008 означает удалённое сообщение.
  const panelTitles = new Set(['📢 НАСТРОЙКА БРИФИНГА', '📢 Брифинг назначен', '📢 Время брифинга наступило', '📢 Брифинг идёт', '📢 Брифинг завершён', '📢 Восстановление брифинга']);
  const isPanel = (m) => m?.author.id === client.user.id && panelTitles.has(m.embeds[0]?.title);
  async function fetchMessage(ch, id) {
    try { return await ch.messages.fetch(id); }
    catch (e) { if (e.code === 10008) return null; throw e; }
  }
  let panelQueue = Promise.resolve();
  function syncPanel(staleMessage) {
    const next = panelQueue.catch(() => {}).then(() => writePanel(staleMessage));
    panelQueue = next;
    return next;
  }
  async function writePanel(staleMessage) {
    const ch = await channel(ids.setupChannel);
    if (!ch) throw new Error('Брифинг: канал настройки недоступен.');
    const phase = S.phase;
    const payload = { content: '', ...panelPayload() };
    let msg = null;
    // Быстрый путь: редактируем сообщение по сохранённому ID без предварительных запросов
    if (S.panelMsgId) {
      try { msg = await ch.messages.edit(S.panelMsgId, payload); }
      catch (e) { if (e.code !== 10008 && e.code !== 50005) throw e; }
    }
    // Медленный путь (только если панель потеряна): ищем среди последних сообщений и чистим дубли
    if (!msg) {
      const recent = await ch.messages.fetch({ limit: 100 });
      const found = recent.find(isPanel) ?? (isPanel(staleMessage) ? staleMessage : null);
      msg = found ? await found.edit(payload) : await ch.send(payload);
      S.panelMsgId = msg.id; persist();
      const duplicates = new Map([...recent.values()].filter(isPanel).map((m) => [m.id, m]));
      if (isPanel(staleMessage)) duplicates.set(staleMessage.id, staleMessage);
      await Promise.all([...duplicates.values()].filter((old) => old.id !== msg.id && old.components.length).map((old) =>
        old.edit({ content: 'Актуальная панель: https://discord.com/channels/' + guildId + '/' + ids.setupChannel + '/' + msg.id, components: [] }).catch(() => {})));
    } else if (staleMessage && staleMessage.id !== msg.id && isPanel(staleMessage) && staleMessage.components.length) {
      // Нажали кнопку на старой панели — отправляем человека на актуальную
      await staleMessage.edit({ content: 'Актуальная панель: https://discord.com/channels/' + guildId + '/' + ids.setupChannel + '/' + msg.id, components: [] }).catch(() => {});
    }
    lastPanelPhase = phase;
  }

  /** Восстанавливаем управление по сохранённому ID, не удаляя его при сетевом сбое. */
  async function sendControl(withPing) {
    const ch = await channel(ids.setupChannel);
    if (!ch) throw new Error('Брифинг: канал управления недоступен.');
    const payload = controlPayload();
    const signature = JSON.stringify(payload);
    const id = S.controlMsgId && S.controlMsgId !== S.panelMsgId ? S.controlMsgId : null;
    let exists = false;
    if (id) {
      if (controlDirty || controlSignature !== signature) {
        // Редактируем сразу, без предварительной загрузки сообщения
        try { await ch.messages.edit(id, payload); exists = true; }
        catch (e) { if (e.code !== 10008 && e.code !== 50005) throw e; }
      } else {
        exists = !!(await fetchMessage(ch, id)); // плановая проверка, что сообщение не удалили
      }
    }
    if (!exists) {
      if (withPing || S.controlPingPending) {
        payload.content = controllerRoleIds.map((r) => '<@&' + r + '>').join(' ');
        payload.allowedMentions = { roles: controllerRoleIds, users: [] };
      }
      const msg = await ch.send(payload);
      S.controlMsgId = msg.id;
    }
    delete S.controlPingPending;
    persist();
    controlSignature = signature;
    controlDirty = false;
    lastControlCheck = Date.now();
  }
  const editControl = () => sendControl(false);
  async function deleteControl() {
    if (!S.controlMsgId) return;
    const ch = await channel(ids.setupChannel);
    if (!ch) throw new Error('Брифинг: канал управления недоступен.');
    try { await ch.messages.delete(S.controlMsgId); }
    catch (e) { if (e.code !== 10008) throw e; }
    S.controlMsgId = null;
    controlDirty = true; controlSignature = null;
    persist();
  }

  async function handleResetButton(i) {
    if (!isController(i.member)) return i.reply(ephemeral('❌ Нет прав.'));
    resetConfirmations.set(i.user.id, { phase: S.phase, startAt: S.startAt, until: Date.now() + 5 * 60000 });
    return i.reply({ content: 'Сбросить текущий брифинг? Его состояние будет сохранено в briefing.json. Автоматические выговоры не выдаются.',
      flags: MessageFlags.Ephemeral,
      components: [row(btn('br_reset_yes', 'Да, сбросить', ButtonStyle.Danger), btn('br_reset_no', 'Нет', ButtonStyle.Secondary))] });
  }
  async function handleResetConfirm(i) {
    if (!isController(i.member)) return i.reply(ephemeral('❌ Нет прав.'));
    const request = resetConfirmations.get(i.user.id);
    resetConfirmations.delete(i.user.id);
    if (!request || request.until < Date.now() || request.phase !== S.phase || request.startAt !== S.startAt)
      return i.update({ content: 'Брифинг изменился или подтверждение устарело. Нажмите сброс заново.', components: [] });
    if (resetting) return i.reply(ephemeral('Брифинг уже сбрасывается.'));
    resetting = true;
    try {
      await i.update({ content: 'Сбрасываю брифинг…', components: [] });
      archiveState('Сброс управляющим ' + i.user.id);
      // Восстанавливаем ограничения брифинга перед сбросом состояния.
      const errors = [];
      for (const m of humansInBrief()) {
        if (isController(m)) continue;
        try { await m.edit({ mute: S.muted ? false : undefined, deaf: S.deafened ? false : undefined }); }
        catch (e) { errors.push(m.id + ': ' + e.message); }
      }
      if (errors.length) throw new Error('Не удалось снять голосовые ограничения: ' + errors.join('; '));
      await deleteReminders();
      await deleteEvent();
      await deleteControl();
      resetToIdle(); persist();
      await syncPanel();
      await i.editReply({ content: 'Брифинг сброшен. Можно назначить новый.' });
    } finally { resetting = false; }
  }

  // ---------- Мероприятие (Scheduled Event) ----------
  async function createEvent(startAt) {
    try {
      const ev = await getGuild().scheduledEvents.create({
        name: 'Брифинг Russia Mafia',
        scheduledStartTime: new Date(startAt),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.Voice,
        channel: ids.briefingVoice,
        description: 'Явка обязательна.',
      });
      S.eventId = ev.id;
    } catch (e) {
      S.eventId = null;
      console.error('Брифинг: не удалось создать мероприятие (нужно право «Управление мероприятиями»):', e.message);
    }
    persist();
  }
  async function editEvent(data) {
    if (!S.eventId) return;
    await getGuild().scheduledEvents.edit(S.eventId, data).catch((e) => console.error('Брифинг: ошибка мероприятия:', e.message));
  }
  async function deleteEvent() {
    if (!S.eventId) return;
    try { await getGuild().scheduledEvents.delete(S.eventId); }
    catch (e) { if (e.status !== 404) throw e; }
    S.eventId = null;
    persist();
  }

  // ---------- Объявления в новостях ----------
  const everyone = { parse: ['everyone'] };
  async function newsSend(payload) {
    const ch = await news();
    if (!ch) return null;
    return ch.send({ allowedMentions: everyone, ...payload }).catch((e) => { console.error('Брифинг: ошибка отправки в новости:', e.message); return null; });
  }
  function announceEmbed(startAt) {
    return new EmbedBuilder()
      .setColor(colors.main)
      .setTitle('📢 Брифинг!')
      .setDescription(
        `Участникам Russia Mafia объявлен брифинг на **${fmtDate(startAt)}** в **${fmtTime(startAt)}** (МСК).\n\n` +
          `Явка обязательна. Не можете прийти — подайте неявку в канал <#${ids.absenceChannel}>.`
      )
      .addFields({ name: 'По вашему времени', value: `<t:${unix(startAt)}:F> (<t:${unix(startAt)}:R>)` })
      .setTimestamp();
  }
  function armReminders() {
    const left = S.startAt - Date.now();
    S.hourSent = left <= 3600_000;
    S.fiveSent = left <= 5 * 60_000;
  }

  // ---------- Назначение ----------
  async function handleNewButton(i) {
    if (S.phase !== 'idle') {
      await i.reply(ephemeral('Брифинг уже назначен. Обновляю панель по сохранённому состоянию.'));
      await syncPanel(i.message);
      if (['ready', 'running', 'ended'].includes(S.phase)) await editControl();
      return;
    }
    if (!(await guard(i))) return;
    const now = Date.now() + 3600_000;
    const modal = new ModalBuilder()
      .setCustomId('br_new_modal')
      .setTitle('Назначить брифинг')
      .addComponents(
        row2(
          new TextInputBuilder()
            .setCustomId('dt')
            .setLabel('Дата и время (дд.мм.гг чч:мм, МСК)')
            .setPlaceholder(`Например: ${inputDate(now)} ${fmtTime(now)}`)
            .setStyle(TextInputStyle.Short)
            .setMinLength(14)
            .setMaxLength(14)
            .setRequired(true)
        )
      );
    await i.showModal(modal);
  }
  const row2 = (input) => new ActionRowBuilder().addComponents(input);

  async function handleNewModal(i) {
    if (S.phase !== 'idle') { freeLock(i.user.id); return i.reply(ephemeral('❌ Брифинг уже назначен.')); }
    const raw = i.fields.getTextInputValue('dt').trim();
    const m = /^(\d{2}\.\d{2}\.\d{2}) (\d{2}:\d{2})$/.exec(raw);
    const dt = m && parseDate(m[1]);
    const tm = m && parseTime(m[2]);
    if (!dt || !tm) {
      freeLock(i.user.id);
      return i.reply(ephemeral('❌ Неверный формат. Нужно строго `дд.мм.гг чч:мм`, например `' + `${inputDate(Date.now() + 3600_000)} ${fmtTime(Date.now() + 3600_000)}` + '`.'));
    }
    const ms = toMs(dt, tm);
    const err = checkRange(ms);
    if (err) { freeLock(i.user.id); return i.reply(ephemeral(err)); }
    lock = { userId: i.user.id, until: Date.now() + LOCK_MS };
    S.pending = { by: i.user.id, startAt: ms };
    return i.reply({
      content: `Вы уверены, что хотите запустить брифинг на **${fmtFull(ms)}**?`,
      components: [row(btn('br_yes', 'Да', ButtonStyle.Success), btn('br_no', 'Нет', ButtonStyle.Secondary))],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleYes(i) {
    if (S.phase !== 'idle' || !S.pending || S.pending.by !== i.user.id) {
      return i.update({ content: '❌ Запрос устарел.', components: [] });
    }
    const startAt = S.pending.startAt;
    delete S.pending;
    freeLock(i.user.id);
    const err = checkRange(startAt);
    if (err) return i.update({ content: err + ' Назначьте заново.', components: [] });
    await i.update({ content: '⏳ Назначаю брифинг…', components: [] });

    S.phase = 'scheduled';
    S.startAt = startAt;
    S.createdAt = Date.now(); // неявки читаем только после этого момента
    S.createdBy = i.user.id;
    S.reminderIds = [];
    S.present = {};
    S.absent = null;
    S.excused = null;
    S.lowAttend = null;
    S.punished = false;
    S.muted = false;
    S.deafened = false;
    S.absMarks = {};
    absCache.clear();
    armReminders();
    persist();

    // Объявление и мероприятие создаются одновременно; ответ и панель — тоже
    const [msg] = await Promise.all([newsSend({ content: '@everyone', embeds: [announceEmbed(startAt)] }), createEvent(startAt)]);
    S.announceMsgId = msg?.id ?? null;
    persist();
    await Promise.all([syncPanel(), i.editReply({ content: `✅ Брифинг назначен на **${fmtFull(startAt)}**.` })]);
  }
  async function handleNo(i) {
    delete S.pending;
    freeLock(i.user.id);
    return i.update({ content: 'Отменено. Брифинг не назначен.', components: [] });
  }

  // ---------- Смена даты / времени ----------
  async function handleChangeButton(i, kind) {
    if (S.phase !== 'scheduled') return i.reply(ephemeral('❌ Сейчас нечего менять.'));
    if (!(await guard(i))) return;
    const isDate = kind === 'date';
    const input = new TextInputBuilder()
      .setCustomId('v')
      .setLabel(isDate ? 'Новая дата (дд.мм.гг)' : 'Новое время (чч:мм, МСК)')
      .setPlaceholder(isDate ? `Например: ${inputDate(S.startAt)}` : `Например: ${fmtTime(S.startAt)}`)
      .setStyle(TextInputStyle.Short)
      .setMinLength(isDate ? 8 : 5)
      .setMaxLength(isDate ? 8 : 5)
      .setRequired(true);
    await i.showModal(new ModalBuilder().setCustomId(isDate ? 'br_chdate_modal' : 'br_chtime_modal').setTitle(isDate ? 'Поменять дату' : 'Поменять время').addComponents(row2(input)));
  }
  async function handleChangeModal(i, kind) {
    if (S.phase !== 'scheduled') { freeLock(i.user.id); return i.reply(ephemeral('❌ Сейчас нечего менять.')); }
    const v = i.fields.getTextInputValue('v').trim();
    const cur = parts(S.startAt);
    let ms;
    if (kind === 'date') {
      const dt = parseDate(v);
      if (!dt) { freeLock(i.user.id); return i.reply(ephemeral('❌ Неверная дата. Нужно строго `дд.мм.гг`.')); }
      ms = toMs(dt, { h: cur.h, mi: cur.mi });
    } else {
      const tm = parseTime(v);
      if (!tm) { freeLock(i.user.id); return i.reply(ephemeral('❌ Неверное время. Нужно строго `чч:мм`.')); }
      ms = toMs({ y: cur.y, mo: cur.mo, d: cur.d }, tm);
    }
    const err = checkRange(ms);
    if (err) { freeLock(i.user.id); return i.reply(ephemeral(err)); }
    freeLock(i.user.id);
    if (ms === S.startAt) return i.reply(ephemeral('Это то же самое время — ничего не изменилось.'));

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const old = S.startAt;
    S.startAt = ms;
    armReminders();
    persist();
    const announce = S.announceMsgId;
    // Событие, удаление старых напоминаний и объявление о переносе — одновременно (прошлые напоминания уже неактуальны)
    await Promise.all([
      editEvent({ scheduledStartTime: new Date(ms) }),
      deleteReminders(),
      newsSend({
        content: '@everyone',
        embeds: [
          new EmbedBuilder()
            .setColor(colors.warn)
            .setTitle('🔄 Время брифинга изменено')
            .setDescription(`Было: ~~${fmtFull(old)}~~\nСтало: **${fmtFull(ms)}**\n<t:${unix(ms)}:R>`)
            .setTimestamp(),
        ],
        ...(announce ? { reply: { messageReference: announce, failIfNotExists: false } } : {}),
      }),
    ]);
    await Promise.all([syncPanel(), i.editReply({ content: `✅ Брифинг перенесён на **${fmtFull(ms)}**.` })]);
  }

  // ---------- Откат ----------
  async function handleCancelButton(i) {
    if (S.phase !== 'scheduled') return i.reply(ephemeral('❌ Сейчас нечего откатывать.'));
    if (!(await guard(i))) return;
    await i.showModal(
      new ModalBuilder()
        .setCustomId('br_cancel_modal')
        .setTitle('Откатить брифинг')
        .addComponents(
          row2(
            new TextInputBuilder()
              .setCustomId('reason')
              .setLabel('Причина (можно оставить пустой)')
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(300)
              .setRequired(false)
          )
        )
    );
  }
  async function handleCancelModal(i) {
    freeLock(i.user.id);
    if (S.phase !== 'scheduled') return i.reply(ephemeral('❌ Сейчас нечего откатывать.'));
    const reason = i.fields.getTextInputValue('reason').trim();
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const announce = S.announceMsgId;
    await Promise.all([
      newsSend({
        content: reason ? `@everyone брифинг отменен! Причина: ${reason}` : '@everyone брифинг отменен!',
        ...(announce ? { reply: { messageReference: announce, failIfNotExists: false } } : {}),
      }),
      deleteReminders(),
      deleteEvent(),
    ]);
    resetToIdle();
    await Promise.all([syncPanel(), i.editReply({ content: '✅ Брифинг отменён.' })]);
  }

  function resetToIdle() {
    lock = null;
    resetConfirmations.clear();
    S.phase = 'idle';
    for (const k of ['startAt', 'createdAt', 'createdBy', 'announceMsgId', 'eventId', 'startedAt', 'endedAt', 'absent', 'excused', 'lowAttend', 'pending', 'controlMsgId']) delete S[k];
    S.present = {};
    S.reminderIds = [];
    S.absMarks = {};
    S.muted = S.deafened = S.punished = false;
    delete S.controlPingPending;
    delete S.excusedMap;
    controlDirty = true; controlSignature = null;
    persist();
  }

  async function deleteReminders() {
    if (!S.reminderIds.length) return;
    const ch = await news();
    if (!ch) throw new Error('Брифинг: канал новостей недоступен.');
    const list = [...S.reminderIds];
    const results = await Promise.allSettled(list.map((id) => ch.messages.delete(id)));
    const failed = [];
    results.forEach((r, k) => { if (r.status === 'rejected' && r.reason?.code !== 10008) failed.push(list[k]); });
    S.reminderIds = S.reminderIds.filter((v) => !list.includes(v) || failed.includes(v));
    persist();
    const firstError = results.find((r, k) => r.status === 'rejected' && failed.includes(list[k]));
    if (firstError) throw firstError.reason;
  }

  // ---------- Таймер: напоминания и переход «пора начинать» ----------
  let ticking = false;
  let lastAbsSync = 0;
  async function tick() {
    if (ticking || resetting) return;
    ticking = true;
    try {
      if (S.phase === 'scheduled') {
        const left = S.startAt - Date.now();
        if (left <= 0) {
          S.phase = 'ready';
          S.controlPingPending = true; controlDirty = true;
          persist();
          await Promise.all([syncPanel(), sendControl(true)]); // панель и кнопка «Начать» появляются одновременно
        } else if (left <= 5 * 60_000 && !S.fiveSent) {
          S.fiveSent = true;
          S.hourSent = true;
          persist();
          const m = await newsSend({ content: '@everyone до брифинга 5 минут!' });
          if (m) { S.reminderIds.push(m.id); persist(); }
        } else if (left <= 3600_000 && !S.hourSent) {
          S.hourSent = true;
          persist();
          const m = await newsSend({ content: '@everyone до брифинга остался час!' });
          if (m) { S.reminderIds.push(m.id); persist(); }
        }
      }
      if (lastPanelPhase !== S.phase) await syncPanel();
      if (['ready', 'running', 'ended'].includes(S.phase) && (controlDirty || Date.now() - lastControlCheck > 60000)) await editControl();
      if (['scheduled', 'ready', 'running'].includes(S.phase) && Date.now() - lastAbsSync > 60_000) {
        lastAbsSync = Date.now();
        await syncAbsences();
      }
    } catch (e) {
      console.error('Брифинг: ошибка таймера:', e.message);
    } finally {
      ticking = false;
    }
  }

  // ---------- Старт ----------
  const briefChannel = () => getGuild()?.channels.cache.get(ids.briefingVoice);
  const humansInBrief = () => [...(briefChannel()?.members.values() ?? [])].filter((m) => !m.user.bot);
  const presentCount = () => Object.keys(S.present).length;

  async function handleStart(i) {
    if (!isController(i.member)) return i.reply(ephemeral('❌ Нет прав.'));
    if (S.phase !== 'ready') return i.reply(ephemeral('❌ Брифинг уже начат или не назначен.'));
    await i.deferUpdate();
    S.phase = 'running';
    S.startedAt = Date.now();
    S.present = {};
    for (const m of humansInBrief()) S.present[m.id] = { at: S.startedAt, onStart: true, sessions: [{ in: S.startedAt, out: null }] };
    persist();
    // Всё независимое — одновременно; кнопки управления обновляются первыми по скорости, а не в хвосте очереди
    await Promise.all([
      editControl(),
      syncPanel(),
      newsSend({ content: '@everyone Брифинг начался!' }),
      deleteReminders(),
      editEvent({ status: GuildScheduledEventStatus.Active }),
    ]);
  }

  // Сессии присутствия: [{ in, out }], out = null — человек всё ещё в канале.
  function ensureSessions(p) {
    if (!Array.isArray(p.sessions) || !p.sessions.length) p.sessions = [{ in: p.at, out: null }];
    return p.sessions;
  }

  /** Вход/выход из канала брифинга во время брифинга: пишем сессии, применяем активные «заглушки». */
  async function onVoiceUpdate(oldS, newS) {
    if (resetting || S.phase !== 'running' || newS.guild.id !== guildId) return;
    const wasIn = oldS.channelId === ids.briefingVoice;
    const isIn = newS.channelId === ids.briefingVoice;
    if (wasIn === isIn) return;
    const m = newS.member ?? oldS.member;
    if (!m || m.user.bot) return;
    const now = Date.now();
    if (isIn) {
      let p = S.present[m.id];
      if (!p) p = S.present[m.id] = { at: now, onStart: false, sessions: [{ in: now, out: null }] };
      else {
        const sess = ensureSessions(p);
        if (sess[sess.length - 1].out != null) sess.push({ in: now, out: null });
      }
      persist();
      if (!isController(m) && (S.muted || S.deafened)) {
        await m.edit({ mute: S.muted ? true : undefined, deaf: S.deafened ? true : undefined }).catch(() => {});
      }
    } else {
      const p = S.present[m.id];
      if (!p) return;
      const sess = ensureSessions(p);
      const last = sess[sess.length - 1];
      if (last.out == null) { last.out = now; persist(); }
    }
  }

  /** После перезапуска бота сверяем сессии с реальным составом канала. */
  function reconcileSessions() {
    const ch = briefChannel();
    if (S.phase !== 'running' || !ch) return;
    const now = Date.now();
    const inNow = new Set(humansInBrief().map((m) => m.id));
    for (const [id, p] of Object.entries(S.present)) {
      const sess = ensureSessions(p);
      const last = sess[sess.length - 1];
      if (last.out == null && !inNow.has(id)) last.out = now;
      else if (last.out != null && inNow.has(id)) sess.push({ in: now, out: null });
    }
    for (const id of inNow) if (!S.present[id]) S.present[id] = { at: now, onStart: false, sessions: [{ in: now, out: null }] };
    persist();
  }

  // ---------- Посещаемость в процентах ----------
  const LATE_RATIO = 0.85; // зашёл после 85% брифинга → выговор
  const MIN_RATIO = 0.5;   // отсидел меньше 50% → выговор (ровно 50% — без выговора)
  const pc = (r) => Math.floor(Math.max(0, Math.min(1, r)) * 100);

  function calcStats(p, start, end) {
    const total = Math.max(1, end - start);
    let att = 0;
    const sess = ensureSessions(p).map((x) => {
      const a = Math.min(Math.max(x.in, start), end);
      const b = Math.min(x.out ?? end, end);
      att += Math.max(0, b - a);
      return { in: x.in, out: x.out, joinRatio: (a - start) / total, attRatio: att / total };
    });
    return { sess, total, attRatio: att / total, joinRatio: sess[0].joinRatio };
  }
  function presenceLine(id, p, st, end, mark) {
    const bits = [];
    st.sess.forEach((x, idx) => {
      if (!(idx === 0 && p.onStart)) bits.push(`зашёл в **${timeStr(x.in)}** (${pc(x.joinRatio)}%)`);
      if (x.out != null && x.out < end) bits.push(`вышел в **${timeStr(x.out)}** (отсидел ${pc(x.attRatio)}%)`);
    });
    const text = bits.length ? `${bits.join(', ')} — итого **${pc(st.attRatio)}%**` : `весь брифинг (**${pc(st.attRatio)}%**)`;
    return `<@${id}> — ${text}${mark ? ' ⚠️ выговор' : ''}`;
  }

  // ---------- Голосовое управление ----------
  async function voiceAll(i, label, data, flags) {
    if (!isController(i.member)) return i.reply(ephemeral('❌ Нет прав.'));
    if (S.phase !== 'running') return i.reply(ephemeral('❌ Брифинг не идёт.'));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    Object.assign(S, flags);
    persist();
    const targets = humansInBrief().filter((m) => !isController(m));
    // Тем, у кого уже нужное состояние, запрос не отправляем
    const need = targets.filter((m) =>
      ('mute' in data ? !!m.voice.serverMute !== data.mute : false) || ('deaf' in data ? !!m.voice.serverDeaf !== data.deaf : false));
    const res = await Promise.allSettled(need.map((m) => m.edit(data)));
    const n = targets.length - res.filter((r) => r.status === 'rejected').length;
    await i.editReply({ content: `✅ ${label}: ${n} чел.` });
  }

  // ---------- Неявки ----------
  const snowflake = (ms) => ((BigInt(ms) - 1420070400000n) << 22n).toString();
  const isOkEmoji = (e) => e?.name === OK_EMOJI;
  let syncing = false;
  let syncAgain = false;
  // Кэш: id сообщения → { count, approved }. Список ✅ перезапрашиваем, только если число реакций изменилось.
  const absCache = new Map();

  /** Читает канал неявок (только сообщения после назначения брифинга) → { userId: messageId }. Ставит/убирает ✅ бота. */
  async function syncAbsences(until) {
    if (syncing) { syncAgain = true; return S.excusedMap ?? {}; }
    syncing = true;
    const result = {};
    try {
      if (!S.createdAt) return result;
      const guild = getGuild();
      let after = snowflake(S.createdAt);
      for (let page = 0; page < 5; page++) {
        const msgs = await client.rest.get(Routes.channelMessages(ids.absenceChannel), { query: new URLSearchParams({ after, limit: '100' }) });
        if (!msgs.length) break;
        for (const msg of msgs) {
          if (BigInt(msg.id) > BigInt(after)) after = msg.id;
          if (until && new Date(msg.timestamp).getTime() > until) continue;
          let authorId = msg.author?.id;
          if (msg.author?.bot) authorId = msg.mentions?.[0]?.id; // неявку могла оформить форма-бот
          if (!authorId) continue;
          const ok = (msg.reactions ?? []).find((r) => isOkEmoji(r.emoji));
          let approved = false;
          const cached = ok ? absCache.get(msg.id) : null;
          if (ok && cached && cached.count === ok.count) {
            approved = cached.approved;
          } else if (ok) {
            const users = await client.rest.get(Routes.channelMessageReaction(ids.absenceChannel, msg.id, encodeURIComponent(OK_EMOJI)), { query: new URLSearchParams({ limit: '100' }) });
            for (const u of users) {
              if (u.id === client.user.id) continue;
              if (controllerUserIds.includes(u.id) || controllerRoleIds.some((rid) => guild.members.cache.get(u.id)?.roles.cache.has(rid))) { approved = true; break; }
            }
            absCache.set(msg.id, { count: ok.count, approved });
          } else absCache.delete(msg.id);
          if (approved) result[authorId] = msg.id;
          const mine = !!ok?.me;
          if (approved && !mine) { absCache.delete(msg.id); await client.rest.put(Routes.channelMessageOwnReaction(ids.absenceChannel, msg.id, encodeURIComponent(OK_EMOJI))).catch(() => {}); }
          if (!approved && mine) { absCache.delete(msg.id); await client.rest.delete(Routes.channelMessageOwnReaction(ids.absenceChannel, msg.id, encodeURIComponent(OK_EMOJI))).catch(() => {}); }
        }
        if (msgs.length < 100) break;
      }
      S.excusedMap = result;
    } catch (e) {
      console.error('Брифинг: ошибка чтения неявок:', e.message);
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; setTimeout(() => syncAbsences(until).catch(() => {}), 500); }
    }
    return result;
  }

  let debounce = null;
  /** Реакции в канале неявок во время брифинга → быстро перепроверяем. */
  function onRaw(packet) {
    if (!['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE', 'MESSAGE_REACTION_REMOVE_ALL', 'MESSAGE_REACTION_REMOVE_EMOJI', 'MESSAGE_DELETE'].includes(packet.t)) return;
    if (packet.d?.channel_id !== ids.absenceChannel) return;
    if (packet.d.message_id) absCache.delete(packet.d.message_id); // реакции на этом сообщении изменились — перепроверим
    else if (packet.d.id) absCache.delete(packet.d.id);
    if (!['scheduled', 'ready', 'running'].includes(S.phase)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => syncAbsences().catch(() => {}), 800);
  }

  // ---------- Конец брифинга ----------
  const timeStr = (ms) => fmtTime(ms);
  async function handleEnd(i) {
    if (!isController(i.member)) return i.reply(ephemeral('❌ Нет прав.'));
    if (S.phase !== 'running') return i.reply(ephemeral('❌ Брифинг не идёт.'));
    await i.deferUpdate();
    S.phase = 'ended';
    S.endedAt = Date.now();
    clearTimeout(debounce);
    for (let w = 0; syncing && w < 50; w++) await sleep(100); // дожидаемся уже идущей проверки, чтобы итог был точным
    const excusedMap = await syncAbsences(S.endedAt);
    persist();

    // 1) Люди для переноса / снятия заглушек (сам перенос запускаем ниже, параллельно со списками)
    const dest = ids.afterVoice || undefined; // пусто — никого не переносим, только снимаем заглушки
    const moveJobs = [];
    for (const m of humansInBrief()) {
      if (isController(m)) continue;
      const opts = { channel: dest, mute: S.muted ? false : undefined, deaf: S.deafened ? false : undefined };
      if (opts.channel === undefined && opts.mute === undefined && opts.deaf === undefined) continue;
      if (dest === undefined && !((opts.mute === false && m.voice.serverMute) || (opts.deaf === false && m.voice.serverDeaf))) continue;
      moveJobs.push(m.edit(opts).catch(() => {}));
    }
    S.muted = S.deafened = false;

    // 2) Списки
    const guild = getGuild();
    const expected = guild.members.cache.filter((m) => !m.user.bot && m.roles.cache.some((r) => attendeeRoleIds.includes(r.id)));
    const atStart = [], late = [], absent = [], excused = [], lowAttend = [];
    for (const [id, p] of Object.entries(S.present)) {
      const st = calcStats(p, S.startedAt, S.endedAt);
      let reason = null;
      if (!isControllerId(id)) {
        if (st.joinRatio >= LATE_RATIO) reason = `Опоздание на брифинг (зашёл после 85%, в ${pc(st.joinRatio)}%)`;
        else if (st.attRatio < MIN_RATIO) reason = `Присутствие на брифинге менее 50% (отсидел ${pc(st.attRatio)}%)`;
      }
      if (reason) lowAttend.push({ id, reason });
      (p.onStart ? atStart : late).push([id, p, st, !!reason]);
    }
    for (const m of expected.values()) {
      if (S.present[m.id]) continue;
      (excusedMap[m.id] ? excused : absent).push(m.id);
    }
    late.sort((a, b) => a[1].at - b[1].at);
    S.absent = absent;
    S.excused = excused;
    S.lowAttend = lowAttend;
    persist();

    const lines = (arr) => (arr.length ? arr.join('\n') : '—');
    const embeds = [
      ...chunkEmbeds('✅ Были на брифинге', colors.ok, atStart.map(([id, p, st, mk]) => presenceLine(id, p, st, S.endedAt, mk)), `Всего: ${atStart.length}`),
      ...chunkEmbeds('🕐 Зашли во время брифинга', colors.warn, late.map(([id, p, st, mk]) => presenceLine(id, p, st, S.endedAt, mk)), `Всего: ${late.length}`),
      ...(lowAttend.length ? chunkEmbeds('⚠️ Выговор за посещаемость', colors.no, lowAttend.map((x) => `<@${x.id}> — ${x.reason}`), `Всего: ${lowAttend.length}`) : []),
      ...chunkEmbeds('❌ Не пришли', colors.no, absent.map((id) => `<@${id}>`), `Всего: ${absent.length}`),
      ...(excused.length ? chunkEmbeds('📝 Не пришли (неявка одобрена)', colors.main, excused.map((id) => `<@${id}>`), `Всего: ${excused.length}`) : []),
    ];
    embeds[0].setAuthor({ name: `Брифинг ${fmtDate(S.startAt)}, ${fmtTime(S.startAt)} (МСК)` });
    const lc = await channel(ids.listsChannel);
    const sendLists = async () => {
      for (let k = 0; k < embeds.length; k += 10) { // по порядку, чтобы списки не перемешались
        await lc?.send({ embeds: embeds.slice(k, k + 10), allowedMentions: { parse: [] } }).catch((e) => console.error('Брифинг: не удалось отправить списки:', e.message));
      }
    };

    // 3) Перенос людей, списки, мероприятие и панели — одновременно
    await Promise.all([Promise.all(moveJobs), sendLists(), editEvent({ status: GuildScheduledEventStatus.Completed }), syncPanel(), editControl()]);
  }
  function chunkEmbeds(title, color, items, footer) {
    const out = [];
    let cur = [], len = 0;
    const flush = () => out.push(new EmbedBuilder().setColor(color).setTitle(out.length ? `${title} (продолжение)` : title).setDescription(cur.length ? cur.join('\n') : '—'));
    for (const it of items) {
      if (len + it.length + 1 > 3900) { flush(); cur = []; len = 0; }
      cur.push(it); len += it.length + 1;
    }
    flush();
    out[out.length - 1].setFooter({ text: footer });
    return out;
  }

  // ---------- Выговоры ----------
  async function handlePred(i) {
    if (!isController(i.member)) return i.reply(ephemeral('❌ Нет прав.'));
    if (S.phase !== 'ended') return i.reply(ephemeral('❌ Брифинг ещё не завершён.'));
    if (S.punished) return i.reply(ephemeral('❌ Выговоры уже выданы.'));
    S.punished = true; // защита от двойного нажатия
    persist();
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = getGuild();
    let given = 0, dmFail = 0, skipped = 0;
    const targets = [
      ...(S.absent ?? []).map((uid) => ({ uid, reason: 'Отсутствие на брифинге' })),
      ...(S.lowAttend ?? []).map((x) => ({ uid: x.id, reason: x.reason })),
    ];
    const jobs = [];
    for (const { uid, reason } of targets) {
      if (isControllerId(uid)) { skipped++; continue; } // руководству выговор ботом не выдаётся
      const c = pings.createPred(uid, i.user.id, reason); // выговор записывается сразу
      given++;
      jobs.push({ uid, c });
    }
    // ЛС рассылаем небольшими пачками одновременно (вместо паузы 250 мс на каждого)
    for (let k = 0; k < jobs.length; k += 5) {
      const res = await Promise.all(jobs.slice(k, k + 5).map(({ uid, c }) => pings.sendDM(uid, { embeds: [pings.punishEmbed(c, guild)] })));
      dmFail += res.filter((ok) => !ok).length;
    }
    await editControl();
    await i.editReply({
      content: `✅ Выговоров выдано: **${given}**.` + (dmFail ? `\n✉️ Не удалось написать в ЛС: ${dmFail}.` : '') + (skipped ? `\nПропущено (руководство): ${skipped}.` : ''),
    });
  }

  // ---------- Полное завершение ----------
  async function handleFinish(i) {
    if (!isController(i.member)) return i.reply(ephemeral('❌ Нет прав.'));
    if (S.phase !== 'ended') return i.reply(ephemeral('❌ Брифинг ещё не завершён.'));
    await i.deferUpdate();
    await deleteControl();
    resetToIdle();
    await syncPanel();
  }

  // ---------- Диспетчер ----------
  /** true — обработано модулем */
  function owns(i) {
    return (i.isButton() || i.isModalSubmit()) && typeof i.customId === 'string' && i.customId.startsWith('br_');
  }
  async function handle(i) {
    const id = i.customId;
    if (resetting) return i.reply(ephemeral('Подождите: брифинг сбрасывается.'));
    if (i.isButton()) {
      if (id === 'br_reset') return handleResetButton(i);
      if (id === 'br_reset_yes') return handleResetConfirm(i);
      if (id === 'br_reset_no') { resetConfirmations.delete(i.user.id); return i.update({ content: 'Сброс отменён.', components: [] }); }
      if (id === 'br_new') return handleNewButton(i);
      if (id === 'br_yes') return handleYes(i);
      if (id === 'br_no') return handleNo(i);
      if (id === 'br_chdate') return handleChangeButton(i, 'date');
      if (id === 'br_chtime') return handleChangeButton(i, 'time');
      if (id === 'br_cancel') return handleCancelButton(i);
      if (id === 'br_start') return handleStart(i);
      if (id === 'br_end') return handleEnd(i);
      if (id === 'br_mute') return voiceAll(i, 'Заглушено', { mute: true }, { muted: true });
      if (id === 'br_unmute') return voiceAll(i, 'Разглушено', { mute: false }, { muted: false });
      if (id === 'br_deaf') return voiceAll(i, 'Наушники выключены', { deaf: true }, { deafened: true });
      if (id === 'br_undeaf') return voiceAll(i, 'Наушники включены', { deaf: false }, { deafened: false });
      if (id === 'br_pred') return handlePred(i);
      if (id === 'br_finish') return handleFinish(i);
    } else {
      if (id === 'br_new_modal') return handleNewModal(i);
      if (id === 'br_chdate_modal') return handleChangeModal(i, 'date');
      if (id === 'br_chtime_modal') return handleChangeModal(i, 'time');
      if (id === 'br_cancel_modal') return handleCancelModal(i);
    }
  }

  async function init() {
    // Сначала подписки и таймер: ошибка REST при старте не отключает модуль.

    client.on('raw', onRaw);
    client.on('voiceStateUpdate', (o, n) => onVoiceUpdate(o, n).catch((e) => console.error('Брифинг: войс:', e.message)));
    setInterval(tick, 5_000); // проверка времени каждые 5 секунд — «Пора начинать» появляется почти сразу
    reconcileSessions();
    await tick(); // tick восстанавливает панель и управление; при сбое повторит через 15 секунд.
  }

  return { init, owns, handle };
};
