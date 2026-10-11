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
      components: [],
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
              `Не явились без одобренной неявки: **${S.absent?.length ?? 0}**` +
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
  async function syncPanel() {
    const ch = await channel(ids.setupChannel);
    if (!ch) return console.error('Брифинг: канал настройки не найден.');
    const payload = panelPayload();
    if (S.panelMsgId) {
      const msg = await ch.messages.fetch(S.panelMsgId).catch(() => null);
      if (msg) {
        await msg.edit(payload).catch((e) => console.error('Брифинг: не удалось обновить панель:', e.message));
        return;
      }
    }
    // Ищем уже существующую панель бота в последних сообщениях (после потери id), иначе создаём
    const recent = await ch.messages.fetch({ limit: 30 }).catch(() => null);
    const old = recent?.find((m) => m.author.id === client.user.id && m.embeds[0]?.title?.startsWith('📢'));
    if (old) {
      S.panelMsgId = old.id;
      await old.edit(payload).catch(() => {});
    } else {
      const m = await ch.send(payload).catch((e) => console.error('Брифинг: не удалось отправить панель:', e.message));
      if (m) S.panelMsgId = m.id;
    }
    store.save();
  }

  /** Отдельное сообщение управления (с пингом при создании). */
  async function sendControl(withPing) {
    const ch = await channel(ids.setupChannel);
    if (!ch) return;
    await deleteControl();
    const payload = controlPayload();
    if (withPing) {
      // Пингуем только роли управления; личный пользователь из controllerUserIds не пингуется
      payload.content = controllerRoleIds.map((r) => `<@&${r}>`).join(' ');
      payload.allowedMentions = { roles: controllerRoleIds, users: [] };
    }
    const m = await ch.send(payload).catch((e) => console.error('Брифинг: не удалось отправить управление:', e.message));
    if (m) { S.controlMsgId = m.id; store.save(); }
  }
  async function editControl() {
    const ch = await channel(ids.setupChannel);
    const msg = S.controlMsgId ? await ch?.messages.fetch(S.controlMsgId).catch(() => null) : null;
    if (msg) await msg.edit(controlPayload()).catch(() => {});
    else await sendControl(false);
  }
  async function deleteControl() {
    if (!S.controlMsgId) return;
    const ch = await channel(ids.setupChannel);
    await ch?.messages.delete(S.controlMsgId).catch(() => {});
    S.controlMsgId = null;
    store.save();
  }

  // ---------- Мероприятие (Scheduled Event) ----------
  async function createEvent(startAt) {
    try {
      const ev = await getGuild().scheduledEvents.create({
        name: 'Брифинг SWAT',
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
    store.save();
  }
  async function editEvent(data) {
    if (!S.eventId) return;
    await getGuild().scheduledEvents.edit(S.eventId, data).catch((e) => console.error('Брифинг: ошибка мероприятия:', e.message));
  }
  async function deleteEvent() {
    if (!S.eventId) return;
    await getGuild().scheduledEvents.delete(S.eventId).catch(() => {});
    S.eventId = null;
    store.save();
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
        `Оперативникам SWAT объявлен брифинг на **${fmtDate(startAt)}** в **${fmtTime(startAt)}** (МСК).\n\n` +
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
    if (S.phase !== 'idle') return i.reply(ephemeral('❌ Брифинг уже назначен.'));
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
    S.punished = false;
    S.muted = false;
    S.deafened = false;
    S.absMarks = {};
    armReminders();
    store.save();

    const msg = await newsSend({ content: '@everyone', embeds: [announceEmbed(startAt)] });
    S.announceMsgId = msg?.id ?? null;
    await createEvent(startAt);
    store.save();
    await syncPanel();
    await i.editReply({ content: `✅ Брифинг назначен на **${fmtFull(startAt)}**.` });
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
    store.save();
    await editEvent({ scheduledStartTime: new Date(ms) });
    // Прошлые напоминания уже неактуальны
    await deleteReminders();
    const announce = S.announceMsgId;
    await newsSend({
      content: '@everyone',
      embeds: [
        new EmbedBuilder()
          .setColor(colors.warn)
          .setTitle('🔄 Время брифинга изменено')
          .setDescription(`Было: ~~${fmtFull(old)}~~\nСтало: **${fmtFull(ms)}**\n<t:${unix(ms)}:R>`)
          .setTimestamp(),
      ],
      ...(announce ? { reply: { messageReference: announce, failIfNotExists: false } } : {}),
    });
    await syncPanel();
    await i.editReply({ content: `✅ Брифинг перенесён на **${fmtFull(ms)}**.` });
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
    await newsSend({
      content: reason ? `@everyone брифинг отменен! Причина: ${reason}` : '@everyone брифинг отменен!',
      ...(announce ? { reply: { messageReference: announce, failIfNotExists: false } } : {}),
    });
    await deleteReminders();
    await deleteEvent();
    resetToIdle();
    await syncPanel();
    await i.editReply({ content: '✅ Брифинг отменён.' });
  }

  function resetToIdle() {
    S.phase = 'idle';
    for (const k of ['startAt', 'createdAt', 'createdBy', 'announceMsgId', 'eventId', 'startedAt', 'endedAt', 'absent', 'excused', 'pending', 'controlMsgId']) delete S[k];
    S.present = {};
    S.reminderIds = [];
    S.absMarks = {};
    S.muted = S.deafened = S.punished = false;
    store.save();
  }

  async function deleteReminders() {
    const ch = await news();
    for (const id of S.reminderIds ?? []) await ch?.messages.delete(id).catch(() => {});
    S.reminderIds = [];
    store.save();
  }

  // ---------- Таймер: напоминания и переход «пора начинать» ----------
  let ticking = false;
  let lastAbsSync = 0;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (S.phase === 'scheduled') {
        const left = S.startAt - Date.now();
        if (left <= 0) {
          S.phase = 'ready';
          store.save();
          await syncPanel();
          await sendControl(true);
        } else if (left <= 5 * 60_000 && !S.fiveSent) {
          S.fiveSent = true;
          S.hourSent = true;
          store.save();
          const m = await newsSend({ content: '@everyone до брифинга 5 минут!' });
          if (m) { S.reminderIds.push(m.id); store.save(); }
        } else if (left <= 3600_000 && !S.hourSent) {
          S.hourSent = true;
          store.save();
          const m = await newsSend({ content: '@everyone до брифинга остался час!' });
          if (m) { S.reminderIds.push(m.id); store.save(); }
        }
      }
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
    for (const m of humansInBrief()) S.present[m.id] = { at: S.startedAt, onStart: true };
    store.save();
    await deleteReminders();
    await newsSend({ content: '@everyone Брифинг начался!' });
    await editEvent({ status: GuildScheduledEventStatus.Active });
    await syncPanel();
    await editControl();
  }

  /** Вход в канал брифинга во время брифинга: запоминаем время, применяем активные «заглушки». */
  async function onVoiceUpdate(oldS, newS) {
    if (S.phase !== 'running' || newS.guild.id !== guildId) return;
    if (newS.channelId !== ids.briefingVoice || oldS.channelId === ids.briefingVoice) return;
    const m = newS.member;
    if (!m || m.user.bot) return;
    if (!S.present[m.id]) { S.present[m.id] = { at: Date.now(), onStart: false }; store.save(); }
    if (!isController(m) && (S.muted || S.deafened)) {
      await m.edit({ mute: S.muted ? true : undefined, deaf: S.deafened ? true : undefined }).catch(() => {});
    }
  }

  // ---------- Голосовое управление ----------
  async function voiceAll(i, label, data, flags) {
    if (!isController(i.member)) return i.reply(ephemeral('❌ Нет прав.'));
    if (S.phase !== 'running') return i.reply(ephemeral('❌ Брифинг не идёт.'));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    Object.assign(S, flags);
    store.save();
    let n = 0;
    for (const m of humansInBrief()) {
      if (isController(m)) continue;
      await m.edit(data).then(() => n++).catch(() => {});
      await sleep(120);
    }
    await i.editReply({ content: `✅ ${label}: ${n} чел.` });
  }

  // ---------- Неявки ----------
  const snowflake = (ms) => ((BigInt(ms) - 1420070400000n) << 22n).toString();
  const isOkEmoji = (e) => e?.name === OK_EMOJI;
  let syncing = false;
  let syncAgain = false;

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
          if (ok) {
            const users = await client.rest.get(Routes.channelMessageReaction(ids.absenceChannel, msg.id, encodeURIComponent(OK_EMOJI)), { query: new URLSearchParams({ limit: '100' }) });
            for (const u of users) {
              if (u.id === client.user.id) continue;
              if (controllerUserIds.includes(u.id) || controllerRoleIds.some((rid) => guild.members.cache.get(u.id)?.roles.cache.has(rid))) { approved = true; break; }
            }
          }
          if (approved) result[authorId] = msg.id;
          const mine = !!ok?.me;
          if (approved && !mine) await client.rest.put(Routes.channelMessageOwnReaction(ids.absenceChannel, msg.id, encodeURIComponent(OK_EMOJI))).catch(() => {});
          if (!approved && mine) await client.rest.delete(Routes.channelMessageOwnReaction(ids.absenceChannel, msg.id, encodeURIComponent(OK_EMOJI))).catch(() => {});
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
    const excusedMap = await syncAbsences(S.endedAt);
    store.save();

    // 1) Переносим всех из канала брифинга (кроме руководства), снимая заглушки
    const dest = ids.afterVoice;
    for (const m of humansInBrief()) {
      if (isController(m)) continue;
      await m.edit({ channel: dest, mute: S.muted ? false : undefined, deaf: S.deafened ? false : undefined }).catch(() => {});
      await sleep(150);
    }
    S.muted = S.deafened = false;

    // 2) Списки
    const guild = getGuild();
    const expected = guild.members.cache.filter((m) => !m.user.bot && m.roles.cache.some((r) => attendeeRoleIds.includes(r.id)));
    const atStart = [], late = [], absent = [], excused = [];
    for (const [id, p] of Object.entries(S.present)) (p.onStart ? atStart : late).push([id, p]);
    for (const m of expected.values()) {
      if (S.present[m.id]) continue;
      (excusedMap[m.id] ? excused : absent).push(m.id);
    }
    late.sort((a, b) => a[1].at - b[1].at);
    S.absent = absent;
    S.excused = excused;
    store.save();

    const lines = (arr) => (arr.length ? arr.join('\n') : '—');
    const embeds = [
      ...chunkEmbeds('✅ Были на брифинге', colors.ok, atStart.map(([id]) => `<@${id}>`), `Всего: ${atStart.length}`),
      ...chunkEmbeds('🕐 Зашли во время брифинга', colors.warn, late.map(([id, p]) => `<@${id}> — зашёл в **${timeStr(p.at)}**`), `Всего: ${late.length}`),
      ...chunkEmbeds('❌ Не пришли', colors.no, absent.map((id) => `<@${id}>`), `Всего: ${absent.length}`),
      ...(excused.length ? chunkEmbeds('📝 Не пришли (неявка одобрена)', colors.main, excused.map((id) => `<@${id}>`), `Всего: ${excused.length}`) : []),
    ];
    embeds[0].setAuthor({ name: `Брифинг ${fmtDate(S.startAt)}, ${fmtTime(S.startAt)} (МСК)` });
    const lc = await channel(ids.listsChannel);
    for (let k = 0; k < embeds.length; k += 10) {
      await lc?.send({ embeds: embeds.slice(k, k + 10), allowedMentions: { parse: [] } }).catch((e) => console.error('Брифинг: не удалось отправить списки:', e.message));
    }

    // 3) Мероприятие, панели
    await editEvent({ status: GuildScheduledEventStatus.Completed });
    await syncPanel();
    await editControl();
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
    store.save();
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = getGuild();
    let given = 0, dmFail = 0, skipped = 0;
    for (const uid of S.absent ?? []) {
      if (isControllerId(uid)) { skipped++; continue; } // руководству выговор ботом не выдаётся
      const c = pings.createPred(uid, i.user.id, 'Отсутствие на брифинге');
      given++;
      const ok = await pings.sendDM(uid, { embeds: [pings.punishEmbed(c, guild)] });
      if (!ok) dmFail++;
      await sleep(250);
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
    if (i.isButton()) {
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
    await syncPanel();
    if (S.phase === 'ready' || S.phase === 'running' || S.phase === 'ended') await editControl();
    client.on('raw', onRaw);
    client.on('voiceStateUpdate', (o, n) => onVoiceUpdate(o, n).catch((e) => console.error('Брифинг: войс:', e.message)));
    setInterval(tick, 15_000);
    await tick();
  }

  return { init, owns, handle };
};
