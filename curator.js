// curator.js — система «Вызов в кабинет куратора»
// Подключение в index.js:
//   const { initCurator } = require('./curator');
//   initCurator(client);
// Нужные intents у клиента: Guilds, GuildVoiceStates (привилегированные не нужны).

const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');

// ───────────────────────── НАСТРОЙКИ ─────────────────────────
const CFG = {
  guildId: '1553150104062394448',
  setupChannelId: '1559535472374579220', // канал настройки (панель + запросы «перекинуть?»)
  curatorRoomId: '1553160581656223821', // голосовой «кабинет куратора»
  waitChannelId: '1559535100360654878', // голосовой канал ожидания
  logChannelId: '1559537571292389446', // лог всех действий
  allowedRoles: [
    '1553158349317742653',
    '1553158717787340971',
    '1558125529943642303',
  ],
  deadlineMs: 24 * 60 * 60 * 1000, // срок явки — сутки
};

// ───────────────────────── ХРАНИЛИЩЕ ─────────────────────────
const FILE = path.join(__dirname, 'data', 'curator.json');
let db = {
  guideMessageId: null,
  nextId: 1,
  calls: {},
  state: { muted: false, deafened: false, locked: false },
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db = { ...db, ...raw, state: { ...db.state, ...(raw.state || {}) } };
  } catch {
    /* первый запуск */
  }
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

// ───────────────────────── ХЕЛПЕРЫ ─────────────────────────
const EPH = MessageFlags.Ephemeral;
const hasRole = (member) =>
  !!member && CFG.allowedRoles.some((r) => member.roles.cache.has(r));
const ts = (ms, f = 'f') => `<t:${Math.floor(ms / 1000)}:${f}>`;
const activeCallFor = (targetId) =>
  Object.values(db.calls).find(
    (c) => c.targetId === targetId && c.status === 'pending',
  );

async function getChannel(client, id) {
  return client.channels.cache.get(id) || (await client.channels.fetch(id).catch(() => null));
}

async function sendLog(client, title, lines, color = 0x5865f2) {
  const ch = await getChannel(client, CFG.logChannelId);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setColor(color)
    .setTimestamp();
  await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

async function deletePrompt(client, call) {
  if (!call.promptMessageId) return;
  const ch = await getChannel(client, CFG.setupChannelId);
  if (ch) await ch.messages.delete(call.promptMessageId).catch(() => {});
  call.promptMessageId = null;
  save();
}

// ───────────────────────── ПАНЕЛЬ / ГИД ─────────────────────────
function guidePayload() {
  const embed = new EmbedBuilder()
    .setTitle('🚪 Кабинет куратора — панель управления')
    .setColor(0x2b2d31)
    .setDescription(
      [
        'Кнопки работают только если вы **находитесь в голосовом канале кабинета куратора** ' +
          `(<#${CFG.curatorRoomId}>). Сотрудников с ролями куратора кнопки не затрагивают.`,
        '',
        '**🦵 Кик всех** — отключает всех из канала кабинета.',
        '**🔇 Заглушить всех** — серверный мут всем (в т.ч. тем, кто зайдёт позже). Повторное нажатие снимает мут.',
        '**🎧 Отключить наушники** — серверный deafen всем (в т.ч. новым). Повторное нажатие снимает.',
        '**🚫 Не впускать** — закрывает вход в канал для остальных. Повторное нажатие открывает.',
        '',
        '**Команды**',
        '`/call человек [причина]` — вызвать человека в кабинет. Ему приходит ЛС, ' +
          `на явку в <#${CFG.waitChannelId}> даётся сутки.`,
        '`/uncall человек [причина]` — отменить вызов (человеку придёт ЛС).',
        '',
        'Когда вызванный зайдёт в канал ожидания (или в любой другой голосовой канал, ' +
          'либо уже сидит в нём), здесь появится запрос: **перекинуть ли его** — Да / Нет.',
      ].join('\n'),
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cur:kick').setLabel('Кик всех').setEmoji('🦵').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('cur:mute').setLabel('Заглушить всех').setEmoji('🔇').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cur:deaf').setLabel('Отключить наушники').setEmoji('🎧').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cur:lock').setLabel('Не впускать').setEmoji('🚫').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

async function ensureGuide(client) {
  const ch = await getChannel(client, CFG.setupChannelId);
  if (!ch) return console.error('[curator] не найден канал настройки');
  let msg = null;
  if (db.guideMessageId) msg = await ch.messages.fetch(db.guideMessageId).catch(() => null);
  if (msg) {
    await msg.edit(guidePayload()).catch(() => {});
  } else {
    msg = await ch.send(guidePayload());
    db.guideMessageId = msg.id;
    save();
  }
}

// ───────────────────────── КОМАНДЫ ─────────────────────────
const commandDefs = [
  new SlashCommandBuilder()
    .setName('call')
    .setDescription('Вызвать человека в кабинет куратора')
    .setDMPermission(false)
    .addUserOption((o) => o.setName('человек').setDescription('Кого вызываем').setRequired(true))
    .addStringOption((o) => o.setName('причина').setDescription('Причина вызова').setRequired(false).setMaxLength(500)),
  new SlashCommandBuilder()
    .setName('uncall')
    .setDescription('Отменить вызов в кабинет куратора')
    .setDMPermission(false)
    .addUserOption((o) => o.setName('человек').setDescription('Кому отменяем вызов').setRequired(true))
    .addStringOption((o) => o.setName('причина').setDescription('Причина отмены').setRequired(false).setMaxLength(500)),
].map((c) => c.toJSON());

async function registerCommands(client) {
  const guild = client.guilds.cache.get(CFG.guildId) || (await client.guilds.fetch(CFG.guildId).catch(() => null));
  if (!guild) return console.error('[curator] бот не на сервере', CFG.guildId);
  // create() обновляет команду с тем же именем и НЕ трогает остальные команды бота
  for (const def of commandDefs) await guild.commands.create(def).catch((e) => console.error('[curator] команда', def.name, e.message));
}

// ───────────────────────── ЗАПРОС «ПЕРЕКИНУТЬ?» ─────────────────────────
async function promptMove(client, call, kind, voiceChannelId) {
  const ch = await getChannel(client, CFG.setupChannelId);
  if (!ch) return;
  await deletePrompt(client, call); // не плодим дубли

  const where =
    kind === 'wait'
      ? `зашёл в канал ожидания (<#${CFG.waitChannelId}>)`
      : `находится в голосовом канале <#${voiceChannelId}>`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cur:go:${call.id}`).setLabel('Да').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cur:stay:${call.id}`).setLabel('Нет').setStyle(ButtonStyle.Danger),
  );

  const msg = await ch
    .send({
      content: `<@${call.callerId}>, вызванный вами <@${call.targetId}> ${where}. Перекинуть его в кабинет куратора?`,
      components: [row],
      allowedMentions: { users: [call.callerId] }, // пингуем только вызвавшего
    })
    .catch(() => null);
  if (msg) {
    call.promptMessageId = msg.id;
    save();
  }
  await sendLog(client, '📨 Запрос на перемещение', [
    `Вызванный: <@${call.targetId}>`,
    `Вызвал: <@${call.callerId}>`,
    `Статус: ${kind === 'wait' ? 'в канале ожидания' : `в канале <#${voiceChannelId}>`}`,
  ]);
}

// ───────────────────────── /call и /uncall ─────────────────────────
async function cmdCall(client, i) {
  if (!hasRole(i.member)) return i.reply({ content: '❌ У вас нет доступа к этой команде.', flags: EPH });

  const target = i.options.getMember('человек');
  const reason = i.options.getString('причина');

  if (!target) return i.reply({ content: '❌ Этого человека нет на сервере.', flags: EPH });
  if (target.user.bot) return i.reply({ content: '❌ Нельзя вызвать бота.', flags: EPH });
  if (target.id === i.user.id) return i.reply({ content: '❌ Нельзя вызвать самого себя.', flags: EPH });

  const existing = activeCallFor(target.id);
  if (existing)
    return i.reply({
      content: `❌ <@${target.id}> уже вызван (<@${existing.callerId}>, до ${ts(existing.deadline)}). Сначала /uncall.`,
      flags: EPH,
      allowedMentions: { parse: [] },
    });

  if (target.voice?.channelId === CFG.curatorRoomId)
    return i.reply({ content: '❌ Этот человек уже находится в кабинете куратора.', flags: EPH });

  await i.deferReply({ flags: EPH });

  const now = Date.now();
  const call = {
    id: String(db.nextId++),
    targetId: target.id,
    callerId: i.user.id,
    reason: reason || null,
    createdAt: now,
    deadline: now + CFG.deadlineMs,
    status: 'pending',
    arrived: false,
    overdueNotified: false,
    promptMessageId: null,
  };
  db.calls[call.id] = call;
  save();

  // ЛС вызванному
  const dm = new EmbedBuilder()
    .setTitle('📢 Вас вызывают в кабинет куратора')
    .setColor(0xed4245)
    .setDescription(
      [
        `Вас вызвал(а) куратор **${i.member.displayName}**.`,
        reason ? `**Причина:** ${reason}` : null,
        '',
        `Вам нужно в течение дня (до ${ts(call.deadline)}) зайти в голосовой канал <#${CFG.waitChannelId}>.`,
        '**Иначе вы получите наказание.**',
      ]
        .filter((l) => l !== null)
        .join('\n'),
    )
    .setTimestamp();
  const dmOk = await target.send({ embeds: [dm] }).then(() => true).catch(() => false);

  await sendLog(
    client,
    '📢 Новый вызов',
    [
      `Вызвал: <@${i.user.id}>`,
      `Вызванный: <@${target.id}>`,
      `Причина: ${reason || '—'}`,
      `Срок явки: ${ts(call.deadline)}`,
      `ЛС доставлено: ${dmOk ? 'да' : '**нет (закрыты ЛС)**'}`,
    ],
    0xed4245,
  );

  await i.editReply({
    content:
      `✅ Вызов оформлен: <@${target.id}>.` +
      (dmOk ? '' : '\n⚠️ Не удалось отправить ЛС (закрыты) — предупредите человека сами.'),
    allowedMentions: { parse: [] },
  });

  // Если человек уже в войсе — сразу показываем запрос
  const vcId = target.voice?.channelId;
  if (vcId) {
    if (vcId === CFG.waitChannelId) {
      call.arrived = true;
      save();
      await promptMove(client, call, 'wait', vcId);
    } else {
      await promptMove(client, call, 'other', vcId);
    }
  }
}

async function cmdUncall(client, i) {
  if (!hasRole(i.member)) return i.reply({ content: '❌ У вас нет доступа к этой команде.', flags: EPH });

  const target = i.options.getUser('человек');
  const reason = i.options.getString('причина');
  const call = activeCallFor(target.id);
  if (!call) return i.reply({ content: '❌ У этого человека нет активного вызова.', flags: EPH });

  await i.deferReply({ flags: EPH });

  call.status = 'cancelled';
  await deletePrompt(client, call);
  save();

  const dm = new EmbedBuilder()
    .setTitle('✅ Вызов отменён')
    .setColor(0x57f287)
    .setDescription(
      [
        'Вызов в кабинет куратора отменён — приходить не нужно.',
        reason ? `**Причина:** ${reason}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .setTimestamp();
  const dmOk = await target.send({ embeds: [dm] }).then(() => true).catch(() => false);

  await sendLog(
    client,
    '🛑 Вызов отменён',
    [
      `Отменил: <@${i.user.id}>`,
      `Вызванный: <@${target.id}>`,
      `Вызывал: <@${call.callerId}>`,
      `Причина: ${reason || '—'}`,
      `ЛС доставлено: ${dmOk ? 'да' : '**нет**'}`,
    ],
    0x57f287,
  );

  await i.editReply({
    content: `✅ Вызов <@${target.id}> отменён.` + (dmOk ? '' : '\n⚠️ ЛС не доставлено (закрыты).'),
    allowedMentions: { parse: [] },
  });
}

// ───────────────────────── КНОПКИ ПАНЕЛИ ─────────────────────────
async function handlePanel(client, i, action) {
  if (!hasRole(i.member))
    return i.reply({ content: '❌ У вас нет доступа к этой панели.', flags: EPH });
  if (i.member.voice?.channelId !== CFG.curatorRoomId)
    return i.reply({
      content: `❌ Чтобы пользоваться панелью, зайдите в канал <#${CFG.curatorRoomId}>.`,
      flags: EPH,
    });

  const room = await getChannel(client, CFG.curatorRoomId);
  if (!room) return i.reply({ content: '❌ Канал кабинета не найден.', flags: EPH });

  await i.deferReply({ flags: EPH });

  const targets = [...room.members.values()].filter(
    (m) => m.id !== client.user.id && !hasRole(m),
  );
  const count = (arr) => arr.filter(Boolean).length;
  let text = '';
  let logTitle = '';

  if (action === 'kick') {
    const res = await Promise.all(
      targets.map((m) => m.voice.disconnect(`Кик всех — ${i.user.tag}`).then(() => true).catch(() => false)),
    );
    text = `🦵 Отключено из канала: **${count(res)}** из ${targets.length}.`;
    logTitle = '🦵 Кик всех';
  } else if (action === 'mute') {
    db.state.muted = !db.state.muted;
    const res = await Promise.all(
      targets.map((m) => m.voice.setMute(db.state.muted, `Заглушить всех — ${i.user.tag}`).then(() => true).catch(() => false)),
    );
    save();
    text = `🔇 Заглушение: **${db.state.muted ? 'ВКЛ' : 'ВЫКЛ'}** (затронуто ${count(res)}).`;
    logTitle = db.state.muted ? '🔇 Заглушить всех — ВКЛ' : '🔊 Заглушить всех — ВЫКЛ';
  } else if (action === 'deaf') {
    db.state.deafened = !db.state.deafened;
    const res = await Promise.all(
      targets.map((m) => m.voice.setDeaf(db.state.deafened, `Отключить наушники — ${i.user.tag}`).then(() => true).catch(() => false)),
    );
    save();
    text = `🎧 Отключение наушников: **${db.state.deafened ? 'ВКЛ' : 'ВЫКЛ'}** (затронуто ${count(res)}).`;
    logTitle = db.state.deafened ? '🎧 Наушники отключены — ВКЛ' : '🎧 Наушники — ВЫКЛ';
  } else if (action === 'lock') {
    db.state.locked = !db.state.locked;
    try {
      if (db.state.locked) {
        // куратором вход разрешаем явно, остальным запрещаем
        for (const roleId of CFG.allowedRoles)
          await room.permissionOverwrites.edit(roleId, { Connect: true });
        await room.permissionOverwrites.edit(room.guild.roles.everyone, { Connect: false });
      } else {
        await room.permissionOverwrites.edit(room.guild.roles.everyone, { Connect: null });
      }
      save();
      text = `🚫 Вход в кабинет: **${db.state.locked ? 'ЗАКРЫТ' : 'ОТКРЫТ'}**.`;
      logTitle = db.state.locked ? '🚫 Не впускать — ВКЛ' : '✅ Не впускать — ВЫКЛ';
    } catch (e) {
      db.state.locked = !db.state.locked; // откат
      return i.editReply({ content: `❌ Не удалось изменить права канала: ${e.message}\nНужно право «Управлять каналами».` });
    }
  }

  await sendLog(client, logTitle, [`Кто: <@${i.user.id}>`, `Затронуто людей: ${targets.length}`]);
  await i.editReply({ content: text });
}

// ───────────────────────── КНОПКИ «ПЕРЕКИНУТЬ?» ─────────────────────────
async function handleMoveButton(client, i, decision, callId) {
  if (!hasRole(i.member))
    return i.reply({ content: '❌ У вас нет доступа.', flags: EPH });

  const call = db.calls[callId];
  if (!call || call.status !== 'pending') {
    await i.reply({ content: 'Этот вызов уже неактуален.', flags: EPH });
    return i.message.delete().catch(() => {});
  }

  await i.deferUpdate();
  call.promptMessageId = null;

  if (decision === 'stay') {
    save();
    await i.message.delete().catch(() => {});
    return sendLog(client, '❌ Перемещение отклонено', [
      `Решил: <@${i.user.id}>`,
      `Вызванный: <@${call.targetId}> остаётся на месте (вызов остаётся активным)`,
    ], 0xfee75c);
  }

  // decision === 'go'
  const guild = i.guild;
  const target = await guild.members.fetch(call.targetId).catch(() => null);
  if (!target || !target.voice.channelId) {
    save();
    await i.message.delete().catch(() => {});
    return sendLog(client, '⚠️ Не удалось переместить', [
      `Нажал: <@${i.user.id}>`,
      `<@${call.targetId}> уже не в голосовом канале`,
    ], 0xfee75c);
  }

  try {
    await target.voice.setChannel(CFG.curatorRoomId, `Вызов в кабинет — ${i.user.tag}`);
    call.status = 'done';
    save();
    await sendLog(client, '✅ Перемещён в кабинет', [
      `Решил: <@${i.user.id}>`,
      `Вызванный: <@${call.targetId}>`,
      `Вызывал: <@${call.callerId}>`,
    ], 0x57f287);
  } catch (e) {
    save();
    await sendLog(client, '⚠️ Ошибка перемещения', [`<@${call.targetId}>: ${e.message}`], 0xed4245);
  }
  await i.message.delete().catch(() => {});
}

// ───────────────────────── ГОЛОСОВЫЕ СОБЫТИЯ ─────────────────────────
async function onVoice(client, oldS, newS) {
  if (newS.guild.id !== CFG.guildId) return;
  const member = newS.member;
  if (!member || member.user.bot) return;
  if (!newS.channelId || newS.channelId === oldS.channelId) return;

  // Новичкам в кабинете применяем активные режимы (мут / наушники)
  if (newS.channelId === CFG.curatorRoomId && !hasRole(member)) {
    if (db.state.muted && !newS.serverMute) await member.voice.setMute(true, 'Кабинет: заглушены все').catch(() => {});
    if (db.state.deafened && !newS.serverDeaf) await member.voice.setDeaf(true, 'Кабинет: наушники отключены').catch(() => {});
  }

  const call = activeCallFor(member.id);
  if (!call) return;

  if (newS.channelId === CFG.curatorRoomId) {
    // зашёл в кабинет сам — вызов выполнен
    call.status = 'done';
    await deletePrompt(client, call);
    save();
    return sendLog(client, '✅ Вызванный зашёл в кабинет сам', [`<@${member.id}> (вызывал <@${call.callerId}>)`], 0x57f287);
  }

  if (newS.channelId === CFG.waitChannelId) {
    call.arrived = true;
    save();
    return promptMove(client, call, 'wait', newS.channelId);
  }
  return promptMove(client, call, 'other', newS.channelId);
}

// ───────────────────────── ПРОСРОЧКА ─────────────────────────
async function checkOverdue(client) {
  const now = Date.now();
  const ch = await getChannel(client, CFG.setupChannelId);
  for (const call of Object.values(db.calls)) {
    if (call.status !== 'pending' || call.arrived || call.overdueNotified) continue;
    if (now < call.deadline) continue;
    call.overdueNotified = true;
    save();
    if (ch)
      await ch
        .send({
          content: `⏰ <@${call.callerId}>, вызванный вами <@${call.targetId}> **не явился в срок** (в <#${CFG.waitChannelId}> так и не заходил). Пора применять наказание.`,
          allowedMentions: { users: [call.callerId] },
        })
        .catch(() => {});
    await sendLog(client, '⏰ Вызов просрочен', [
      `Вызванный: <@${call.targetId}>`,
      `Вызывал: <@${call.callerId}>`,
      `Срок истёк: ${ts(call.deadline)}`,
    ], 0xed4245);
  }
}

// ───────────────────────── ИНИЦИАЛИЗАЦИЯ ─────────────────────────
function initCurator(client) {
  load();

  const start = async () => {
    await registerCommands(client);
    await ensureGuide(client);
    setInterval(() => checkOverdue(client).catch(() => {}), 60 * 1000);
    console.log('[curator] система вызова запущена');
  };
  if (client.isReady()) start();
  else client.once(Events.ClientReady, start);

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (i.guildId !== CFG.guildId) return;

      if (i.isChatInputCommand()) {
        if (i.commandName === 'call') return await cmdCall(client, i);
        if (i.commandName === 'uncall') return await cmdUncall(client, i);
        return;
      }
      if (i.isButton() && i.customId.startsWith('cur:')) {
        const [, action, callId] = i.customId.split(':');
        if (['kick', 'mute', 'deaf', 'lock'].includes(action)) return await handlePanel(client, i, action);
        if (action === 'go' || action === 'stay') return await handleMoveButton(client, i, action, callId);
      }
    } catch (e) {
      console.error('[curator] ошибка:', e);
      const msg = { content: '❌ Внутренняя ошибка, попробуйте ещё раз.', flags: EPH };
      if (i.deferred || i.replied) i.editReply(msg).catch(() => {});
      else if (i.isRepliable()) i.reply(msg).catch(() => {});
    }
  });

  client.on(Events.VoiceStateUpdate, (o, n) => onVoice(client, o, n).catch((e) => console.error('[curator] voice:', e)));
}

module.exports = { initCurator };
