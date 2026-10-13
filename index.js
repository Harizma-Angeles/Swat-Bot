require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ---------- Хранилище игровых ников (файл data/nicks.json) ----------
const DATA_DIR = path.join(__dirname, 'data');
const NICKS_FILE = path.join(DATA_DIR, 'nicks.json');

// ---------- Помощники: сеть, повторы, файловые хранилища ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NET_CODES = new Set(['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const isNetworkError = (e) =>
  NET_CODES.has(e?.code) || NET_CODES.has(e?.cause?.code) || /timeout|ECONNRESET|EAI_AGAIN|fetch failed/i.test(e?.message ?? '');

/** Повторяет операцию при сетевых сбоях (экспоненциальная пауза). Остальные ошибки пробрасывает сразу. */
async function withRetry(fn, { tries = 5, base = 1000 } = {}) {
  let last;
  for (let n = 0; n < tries; n++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isNetworkError(e)) throw e;
      await sleep(base * 2 ** n);
    }
  }
  throw last;
}

/** JSON-хранилище: запись отложенная (склеивает частые сохранения), атомарная, сбрасывается при выходе. */
const stores = new Set();
function makeStore(file, initial, delay = 300) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data === null || typeof data !== 'object') throw new Error('неверный формат');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Файл есть, но повреждён — не затираем, а откладываем копию, чтобы данные можно было спасти
      try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); console.error(`Файл ${path.basename(file)} повреждён, копия сохранена. Начинаю с пустого.`); } catch {}
    }
    data = initial();
  }
  let timer = null;
  let dirty = false;
  const store = {
    data,
    get dirty() { return dirty; },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      dirty = false;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store.data, null, 2));
      fs.renameSync(tmp, file); // атомарно: файл не побьётся при сбое
    },
    saveNow() {
      dirty = true;
      store.flush();
    },
    save() {
      dirty = true;
      if (!timer) timer = setTimeout(() => { timer = null; try { store.flush(); } catch (e) { console.error('Ошибка записи', file, e.message); } }, delay);
    },
  };
  stores.add(store);
  return store;
}
function flushAll() {
  for (const st of stores) { if (st.dirty) { try { st.flush(); } catch {} } } // пишем только то, что изменилось
}
process.on('exit', flushAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushAll(); try { client.destroy(); } catch {} process.exit(0); });

const nickStore = makeStore(NICKS_FILE, () => ({}));
const nicks = nickStore.data;
// Запись реестра: { nick: игровой ник, callsign: позывной (может быть пустым) }
function getEntry(userId) {
  const e = nicks[userId];
  if (!e) return null;
  return typeof e === 'string' ? { nick: e, callsign: '' } : e; // старый формат — просто строка
}
function saveNick(userId, nick, callsign) {
  const prev = getEntry(userId) ?? { nick: '', callsign: '' };
  nicks[userId] = {
    nick: nick ?? prev.nick,
    callsign: callsign !== undefined ? callsign : prev.callsign,
  };
  nickStore.save();
}
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionsBitField,
  MessageFlags,
  SlashCommandBuilder,
  Options,
} = require('discord.js');

// ===================== НАСТРОЙКИ =====================
const GUILD_ID = '1553150104062394448';
const REQUEST_CHANNEL_ID = '1553182058753298432'; // канал с кнопкой запроса роли
const REVIEW_CHANNEL_ID = '1557851005293568091'; // канал, куда приходят заявки

const RANK_ROLES = {
  1: '1553158492389511278',
  2: '1553179974851104878',
  3: '1553180054589022228',
  4: '1553180126257086514',
  5: '1553180207702085822',
  6: '1553180332247748628',
  7: '1553180389164716052',
  8: '1553180447947890859',
};

const DEPARTMENTS = {
  STG: { name: 'STG', roleId: '1553183740874727514' },
  RED: { name: 'RED', roleId: '1553180446576349184' },
  RAP: { name: 'R.A.P', roleId: '1553449584779460711' },
  MOBILE: { name: 'Мобильная группа', roleId: '1559631983599030344' },
};

// Канал приветствий и прощаний
const WELCOME_CHANNEL_ID = '1555156051022839828';

// Роль, которая выдаётся каждому новому участнику при заходе на сервер
const NEWCOMER_ROLE_ID = '1557859742058151936';

// Доп. роль: должна быть у каждого, у кого есть любая роль ранга (1–8)
const EXTRA_RANK_ROLE_ID = '1553182125321359431';
const isRankRoleId = (id) => Object.values(RANK_ROLES).includes(id);
const hasRankRole = (member) => member.roles.cache.some((r) => isRankRoleId(r.id));

// Особые типы запроса: без отдела и ранга, в форме только ник
const SPECIAL_TYPES = {
  FRIEND: { name: 'Друг организации', emoji: '🤝', prefix: 'Friend', roleId: '1558071002582356008', roleIds: ['1558071002582356008', EXTRA_RANK_ROLE_ID] },
  EX: { name: 'Бывший оперативник', emoji: '🪖', prefix: 'Ex', roleId: '1555332217998282923', roleIds: [EXTRA_RANK_ROLE_ID, '1555332217998282923'] },
};

// Приставки в нике для глав и заместителей отделов (приоритет — сверху вниз)
const LEADER_PREFIXES = [
  { roleId: '1554444954351173753', prefix: 'H.RED' }, // Head RED
  { roleId: '1554445137340407929', prefix: 'H.STG' }, // Head STG
  { roleId: '1557818662583541850', prefix: 'D.RED' }, // Dep RED
  { roleId: '1557831487645290506', prefix: 'D.STG' }, // Dep STG
];

// Канал со списком руководителей (обновляется автоматически)
const ROSTER_CHANNEL_ID = '1556729576330362891';
const ROSTER_INTERVAL_MS = 10 * 60 * 1000; // каждые 10 минут
const ROSTER_TITLE = 'Состав руководителей';
const ROSTER_LINE = '—————————————————';
const ROSTER_LEADERS = [{ title: 'Куратор SWAT', roleId: '1553158349317742653' }, { title: 'Зам.Куратора SWAT', roleId: '1553158717787340971' }];
const ROSTER_HEADS = [
  { title: 'Head RED', roleId: '1554444954351173753' },
  { title: 'Dep RED', roleId: '1557818662583541850' },
  { title: 'Head STG', roleId: '1554445137340407929' },
  { title: 'Dep STG', roleId: '1557831487645290506' },
];

// Кто может нажимать «Выдать роль» / «Отказать»
const MODERATOR_ROLES = [
  '1553158717787340971',
  '1553158349317742653',
  '1554444954351173753',
  '1557818662583541850',
  '1553180446576349184',
  '1554445137340407929',
  '1557831487645290506',
];

const COLORS = {
  main: 0x5865f2,
  ok: 0x57f287,
  no: 0xed4245,
  warn: 0xfee75c,
};
// =====================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions],
  allowedMentions: { parse: [] },
  // Длинные таймауты и повторы запросов — бот переживает кратковременные сбои сети хостинга
  rest: { timeout: 30_000, retries: 5 },
  // Не храним в памяти лишнее (сообщения, реакции, голос, треды и т.п.) — бот ими не пользуется
  makeCache: Options.cacheWithLimits({
    MessageManager: 0,
    ReactionManager: 0,
    ReactionUserManager: 0,
    PresenceManager: 0,
    ThreadManager: 0,
    ThreadMemberManager: 0,
    StageInstanceManager: 0,
    GuildScheduledEventManager: 0,
    GuildInviteManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
    GuildBanManager: 0,
    AutoModerationRuleManager: 0,
    BaseGuildEmojiManager: 0,
    ApplicationCommandManager: 0,
  }),
});

// Защита от двойных нажатий
const processing = new Set(); // id сообщений, которые уже обработаны/обрабатываются
const pendingDeny = new Map(); // messageId -> { moderatorId, until }

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const canModerate = (member) =>
  !!member && member.roles.cache.some((r) => MODERATOR_ROLES.includes(r.id));

// ---------- Отказ работать на чужих серверах ----------
async function refuseGuild(guild) {
  try {
    const embed = new EmbedBuilder()
      .setColor(COLORS.no)
      .setTitle('🚫 Доступ запрещён')
      .setDescription(
        '**Бот не работает на данном сервере!**\n\nЭтот бот создан исключительно для одного закрытого сервера. Я покидаю этот сервер.'
      )
      .setTimestamp();

    let channel = guild.systemChannel;
    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const canSend = (c) =>
      c && me && c.permissionsFor(me)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]);
    if (!canSend(channel)) {
      channel = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && canSend(c));
    }
    if (channel) await channel.send({ embeds: [embed] }).catch(() => {});
  } finally {
    await guild.leave().catch(() => {});
  }
}

// ---------- Панель запроса ролей ----------
function panelPayload() {
  const embed = new EmbedBuilder()
    .setColor(COLORS.main)
    .setTitle('📋 ЗАПРОС РОЛИ')
    .setDescription(
      'Нажмите кнопку ниже, чтобы запросить роль.\n\n' +
        '**Как это работает:**\n' +
        '> 1️⃣ Выберите свой отдел (STG / RED / R.A.P / Мобильная группа) или статус «Друг организации» / «Бывший оперативник»\n' +
        '> 2️⃣ Заполните форму: ник, позывной, ранг (для особых статусов — только ник)\n' +
        '> 3️⃣ Дождитесь решения — результат придёт вам в личные сообщения'
    )
    .setFooter({ text: 'FBI Helper' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('role_start').setLabel('Начать запрос роли').setStyle(ButtonStyle.Primary).setEmoji('📝')
  );
  return { embeds: [embed], components: [row] };
}

async function ensurePanel() {
  const channel = await client.channels.fetch(REQUEST_CHANNEL_ID).catch(() => null);
  if (!channel) return console.error('Канал запроса ролей не найден!');
  const messages = await withRetry(() => channel.messages.fetch({ limit: 30 })).catch(() => null);
  if (!messages) return console.error('Не удалось проверить панель запроса ролей (нет связи) — новую не создаю, чтобы не было дублей.');
  const existing = messages.find(
    (m) => m.author.id === client.user.id && m.components.some((r) => r.components.some((c) => c.customId === 'role_start'))
  );
  const payload = panelPayload();
  if (!existing) {
    await withRetry(() => channel.send(payload));
    console.log('Панель запроса ролей отправлена.');
  } else if (existing.embeds[0]?.description !== payload.embeds[0].data.description) {
    await withRetry(() => existing.edit(payload)); // обновляем текст старой панели
    console.log('Панель запроса ролей обновлена.');
  }
}

// ---------- Слэш-команды ----------
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Проверить задержку бота'),
  new SlashCommandBuilder()
    .setName('addrest')
    .setDescription('Записать игровой ник игрока в реестр (по нему бот ставит ник «ОТДЕЛ | Ник»)')
    .addUserOption((o) => o.setName('игрок').setDescription('Пинг игрока').setRequired(true))
    .addStringOption((o) => o.setName('ник').setDescription('Игровой ник, например Harizma_Angeles').setRequired(true).setMaxLength(40))
    .addStringOption((o) => o.setName('позывной').setDescription('Позывной (необязательно, хранится в реестре)').setRequired(false).setMaxLength(30))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('restrlist')
    .setDescription('Показать весь реестр игроков (игровой ник и позывной)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('syncnicks')
    .setDescription('Проверить ники всех игроков из реестра сейчас и показать, кого и почему не удалось изменить')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('fastroll')
    .setDescription('Снять у игроков ВСЕ роли и оставить только выбранные')
    .addStringOption((o) => o.setName('игроки').setDescription('Пинги игроков (можно несколько, через пробел)').setRequired(true))
    .addStringOption((o) => o.setName('роли').setDescription('Какие роли оставить (пинги ролей, можно несколько)').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('clearroll')
    .setDescription('Снять роль у игрока')
    .addUserOption((o) => o.setName('игрок').setDescription('Пинг игрока').setRequired(true))
    .addRoleOption((o) => o.setName('роль').setDescription('Какую роль снять').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
];

const metaStore = makeStore(path.join(DATA_DIR, 'meta.json'), () => ({}));
async function registerCommands(guild) {
  try {
    const json = commands.map((c) => c.toJSON());
    const hash = require('crypto').createHash('sha1').update(JSON.stringify(json)).digest('hex');
    // Не дёргаем Discord при каждом старте: перерегистрация только если набор команд изменился или пропал на сервере
    if (metaStore.data.commandsHash === hash) {
      const existing = await withRetry(() => guild.commands.fetch()).catch(() => null);
      if (existing && existing.size === json.length) return console.log('Слэш-команды без изменений.');
    }
    await withRetry(() => guild.commands.set(json));
    metaStore.data.commandsHash = hash;
    metaStore.save();
    console.log('Слэш-команды зарегистрированы.');
  } catch (err) {
    console.error('Не удалось зарегистрировать команды (проверьте, что бот приглашён со scope applications.commands):', err.message);
  }
}

// ---------- Загрузка списка участников (с защитой от rate limit) ----------
// Полный список запрашивается у Discord редко: после первой загрузки кэш сам обновляется
// событиями входа/выхода/смены ролей, поэтому повторные запросы не нужны.
let membersFetchedAt = 0;
let membersFetching = null;
const MEMBERS_REFETCH_MS = 60 * 60 * 1000;

async function loadMembers(guild) {
  if (membersFetching) return membersFetching;
  if (membersFetchedAt && Date.now() - membersFetchedAt < MEMBERS_REFETCH_MS) return;
  membersFetching = (async () => {
    try {
      await guild.members.fetch();
      membersFetchedAt = Date.now();
    } catch (err) {
      // Не удалось (например, rate limit) — работаем с тем, что есть в кэше, и повторим в следующий раз
      console.error('Не удалось загрузить полный список участников, использую кэш:', err.message);
    } finally {
      membersFetching = null;
    }
  })();
  return membersFetching;
}

// ---------- Список руководителей ----------
function rosterLines(guild, sections) {
  const lines = [];
  for (const sec of sections) {
    const role = guild.roles.cache.get(sec.roleId);
    const members = role ? [...role.members.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)) : [];
    if (!members.length) {
      lines.push(`**${sec.title}** — *вакантно*`);
      continue;
    }
    for (const m of members) lines.push(`**${sec.title}** — <@${m.id}> — \`${getEntry(m.id)?.nick || m.displayName}\``);
  }
  return lines.join('\n');
}

let rosterRunning = false;
let rosterMsgId = null;
let rosterLastDesc = '';
let rosterLastAt = 0;
async function updateRoster() {
  if (rosterRunning) return;
  rosterRunning = true;
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    const channel = await client.channels.fetch(ROSTER_CHANNEL_ID).catch(() => null);
    if (!channel) return console.error('Канал списка руководителей не найден!');

    await loadMembers(guild);

    const description =
      `${ROSTER_LINE}\n${rosterLines(guild, ROSTER_LEADERS)}\n${ROSTER_LINE}\n` +
      `### Главы отделов\n${ROSTER_LINE}\n${rosterLines(guild, ROSTER_HEADS)}\n${ROSTER_LINE}`;

    // Ничего не изменилось — не трогаем Discord (раз в час всё равно проверяем, что сообщение на месте)
    if (description === rosterLastDesc && Date.now() - rosterLastAt < 60 * 60 * 1000) return;

    const embed = new EmbedBuilder()
      .setColor(COLORS.main)
      .setTitle(ROSTER_TITLE)
      .setDescription(description)
      .setFooter({ text: 'Список обновляется автоматически каждые 10 минут' })
      .setTimestamp();

    const payload = { embeds: [embed], allowedMentions: { parse: [] } };
    let done = false;
    if (rosterMsgId) {
      done = await withRetry(() => channel.messages.edit(rosterMsgId, payload)).then(() => true, () => false);
      if (!done) rosterMsgId = null;
    }
    if (!done) {
      const messages = await withRetry(() => channel.messages.fetch({ limit: 30 }));
      const existing = messages.find((m) => m.author.id === client.user.id && m.embeds[0]?.title === ROSTER_TITLE);
      const msg = existing ? await existing.edit(payload) : await channel.send(payload);
      rosterMsgId = msg.id;
    }
    rosterLastDesc = description;
    rosterLastAt = Date.now();
  } catch (err) {
    console.error('Не удалось обновить список руководителей:', isNetworkError(err) ? 'нет связи с Discord' : err.message);
  } finally {
    rosterRunning = false;
  }
}

/** Ник игрока в Discord (серверный ник, иначе имя), одной строкой. Для не найденных на сервере — игровой ник из реестра. */
function discordName(guild, userId) {
  const member = guild.members.cache.get(userId);
  const name = member?.displayName ?? getEntry(userId)?.nick ?? userId;
  return name.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

const SYNC_STATUS_TEXT = {
  changed: 'ник изменён',
  ok: 'ник уже по форме',
  'no-dept': 'нет роли отдела/должности (ник не менялся)',
  'no-nick': 'нет игрового ника',
  forbidden: 'бот не может менять ник',
  error: 'ошибка смены ника',
  skip: 'пропущен',
};

// ---------- Проверка ников по реестру ----------
const SYNC_INTERVAL_MS = 10 * 60 * 1000;

/** Приставка ника: H.RED / H.STG / D.RED / D.STG для глав и замов, иначе название единственного отдела. */
function nickPrefix(member) {
  const leader = LEADER_PREFIXES.find((l) => member.roles.cache.has(l.roleId));
  if (leader) return leader.prefix;
  const depts = Object.values(DEPARTMENTS).filter((d) => member.roles.cache.has(d.roleId));
  if (depts.length) return depts.length === 1 ? depts[0].name : null;
  // Нет отдела: «Друг организации» → Friend, «Бывший оперативник» → Ex
  const special = Object.values(SPECIAL_TYPES).filter((t) => member.roles.cache.has(t.roleId));
  return special.length === 1 ? special[0].prefix : null;
}

// Ник уже «по форме»: «ПРИСТАВКА | Ник» (приставки: STG, RED, R.A.P, H.RED, H.STG, D.RED, D.STG, Friend, Ex)
const KNOWN_PREFIXES = [...LEADER_PREFIXES.map((l) => l.prefix), ...Object.values(DEPARTMENTS).map((d) => d.name), ...Object.values(SPECIAL_TYPES).map((t) => t.prefix)]
  .sort((a, b) => b.length - a.length)
  .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const NICK_FORM_RE = new RegExp(`^(?:${KNOWN_PREFIXES.join('|')})\\s*\\|\\s*(.+)$`);

/** Если игрока нет в реестре, но его ник на сервере уже по форме «ПРИСТАВКА | Ник» — записываем этот ник в реестр. */
function adoptFromNick(member) {
  if (member.user.bot || getEntry(member.id) || !member.nickname) return false;
  const m = member.nickname.match(NICK_FORM_RE);
  if (!m) return false;
  try {
    saveNick(member.id, m[1].trim().slice(0, 40), undefined);
    return true;
  } catch (err) {
    console.error('Не удалось добавить игрока в реестр по нику:', err.message);
    return false;
  }
}

/** Если у игрока есть роль ранга, а доп. роли нет — выдаёт её. true, если выдали. */
async function syncExtraRole(member) {
  if (member.user.bot || !hasRankRole(member) || member.roles.cache.has(EXTRA_RANK_ROLE_ID)) return false;
  try {
    await member.roles.add(EXTRA_RANK_ROLE_ID, 'Авто: доп. роль всем с рангом');
    return true;
  } catch (err) {
    console.error(`Не удалось выдать доп. роль ${member.user.tag}:`, err.message);
    return false;
  }
}

/** Участники сервера (не боты), которых нет в реестре. */
function unregisteredMembers(guild) {
  return [...guild.members.cache.values()].filter((m) => !m.user.bot && !getEntry(m.id));
}

/** Приводит серверный ник игрока из реестра к виду «ПРИСТАВКА | Ник» (например STG | Harizma_Angeles) по его ролям. */
async function syncMemberNick(member) {
  if (member.user.bot) return 'skip';
  const entry = getEntry(member.id);
  if (!entry?.nick) return 'no-nick';

  const prefix = nickPrefix(member);
  if (!prefix) return 'no-dept'; // нет отдела/статуса или их несколько — не угадываем

  const target = `${prefix} | ${entry.nick}`.slice(0, 32);
  if (member.nickname === target) return 'ok';
  if (!member.manageable) return 'forbidden';
  try {
    await member.setNickname(target, 'Автопроверка ника по реестру');
    return 'changed';
  } catch (err) {
    console.error(`Не удалось сменить ник ${member.user.tag}:`, err.message);
    return 'error';
  }
}

let syncRunning = false;
async function syncAllNicks() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    await loadMembers(guild);
    let changed = 0;
    let adopted = 0;
    let extra = 0;
    for (const member of guild.members.cache.values()) {
      if (member.user.bot) continue;
      if (await syncExtraRole(member)) extra++;
      if (adoptFromNick(member)) adopted++;
      if (!getEntry(member.id)) continue;
      if ((await syncMemberNick(member)) === 'changed') changed++;
    }
    if (changed || adopted || extra) console.log(`Автопроверка: ников исправлено ${changed}, добавлено в реестр ${adopted}, выдано доп. ролей ${extra}.`);
  } catch (err) {
    console.error('Ошибка автопроверки ников:', isNetworkError(err) ? 'нет связи с Discord' : err.message);
  } finally {
    syncRunning = false;
  }
}

// ---------- Готовность ----------
client.once('clientReady', async () => {
  console.log(`Бот запущен как ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    if (guild.id !== GUILD_ID) await refuseGuild(guild);
  }
  const mainGuild = client.guilds.cache.get(GUILD_ID);
  if (mainGuild) await registerCommands(mainGuild);
  if (mainGuild) await loadMembers(mainGuild); // один раз загружаем участников, дальше всё берётся из кэша
  setInterval(updateRoster, ROSTER_INTERVAL_MS);
  setInterval(syncAllNicks, SYNC_INTERVAL_MS);
  setInterval(modTick, 30_000);
  setInterval(() => { const n = Date.now(); for (const [k, v] of pendingDeny) if (v.until < n) pendingDeny.delete(k); }, 10 * 60 * 1000).unref?.();
  pruneModCases();
  const logFails = (label, results) => results.forEach((r) => r.status === 'rejected' && console.error(`Ошибка при старте (${label}):`, isNetworkError(r.reason) ? 'нет связи с Discord' : r.reason?.message ?? r.reason));
  logFails('панели', await Promise.allSettled([ensurePanel(), ensureTicketPanel(), updateRoster()]));
  logFails('проверки', await Promise.allSettled([syncAllNicks(), modTick(), cleanupTickets(), privateRooms.init(), briefing.init(), predSync.init(), curatorCalls.init()]));
});

client.on('guildCreate', async (guild) => {
  if (guild.id !== GUILD_ID) return refuseGuild(guild);
  await registerCommands(guild);
  await ensurePanel();
  await ensureTicketPanel();
});

// ---------- Новый участник ----------
async function sendWelcomeChannel(guild, payload) {
  try {
    const channel = await client.channels.fetch(WELCOME_CHANNEL_ID);
    const { mentionUser, ...rest } = payload;
    await channel.send({ ...rest, allowedMentions: { users: mentionUser ? [mentionUser] : [] } });
  } catch (err) {
    console.error('Не удалось отправить сообщение в канал приветствий:', err.message);
  }
}

client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== GUILD_ID || member.user.bot) return;

  // 1. Автороль
  try {
    await member.roles.add(NEWCOMER_ROLE_ID, 'Автороль новому участнику');
  } catch (err) {
    console.error('Не удалось выдать роль новому участнику:', err.message);
  }
  await reapplyMute(member);

  // 2. Приветствие
  const embed = new EmbedBuilder()
    .setColor(COLORS.ok)
    .setAuthor({ name: 'Новый участник', iconURL: member.guild.iconURL() ?? undefined })
    .setTitle('👋 Добро пожаловать!')
    .setDescription(
      `Рады видеть тебя на сервере, <@${member.id}>!\n\n` +
        `Чтобы получить свою роль, загляни в канал <#${REQUEST_CHANNEL_ID}> и подай заявку.`
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '👤 Участник', value: `${member.user.username}`, inline: true },
      { name: '🔢 Участник №', value: `${member.guild.memberCount}`, inline: true },
      { name: '📅 Аккаунт создан', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true }
    )
    .setTimestamp();
  await sendWelcomeChannel(member.guild, { embeds: [embed], mentionUser: member.id, content: `<@${member.id}>` });
});

const ROSTER_ROLE_IDS = new Set([...ROSTER_LEADERS, ...ROSTER_HEADS].map((x) => x.roleId));
let rosterTimer = null;
const scheduleRoster = () => {
  clearTimeout(rosterTimer);
  rosterTimer = setTimeout(() => updateRoster(), 5000); // склеиваем несколько смен ролей подряд
};

client.on('guildMemberUpdate', async (oldM, newM) => {
  if (newM.guild.id !== GUILD_ID || newM.user.bot) return;
  if ([...ROSTER_ROLE_IDS].some((id) => oldM.roles.cache.has(id) !== newM.roles.cache.has(id))) scheduleRoster();
  adoptFromNick(newM);
  await syncExtraRole(newM);
  if (!getEntry(newM.id)) return;
  const changedRoles =
    oldM.partial ||
    oldM.roles.cache.size !== newM.roles.cache.size ||
    [...newM.roles.cache.keys()].some((id) => !oldM.roles.cache.has(id));
  if (changedRoles) await syncMemberNick(newM);
});

client.on('guildMemberRemove', async (member) => {
  if (member.guild.id !== GUILD_ID || member.user?.bot) return;
  if ([...ROSTER_ROLE_IDS].some((id) => member.roles?.cache?.has(id))) scheduleRoster();

  const gameNick = getEntry(member.id)?.nick;
  const embed = new EmbedBuilder()
    .setColor(COLORS.no)
    .setAuthor({ name: 'Участник покинул сервер', iconURL: member.guild.iconURL() ?? undefined })
    .setTitle('🚪 До встречи!')
    .setDescription(`**${member.user?.username ?? 'Неизвестный'}** покинул(а) сервер.`)
    .addFields(
      ...(gameNick ? [{ name: '🎮 Игровой ник', value: gameNick, inline: true }] : []),
      ...(member.joinedTimestamp
        ? [{ name: '📅 Был на сервере с', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>`, inline: true }]
        : []),
      { name: '👥 Осталось участников', value: `${member.guild.memberCount}`, inline: true }
    )
    .setTimestamp();
  if (member.user) embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  await sendWelcomeChannel(member.guild, { embeds: [embed] });
});

// ---------- Взаимодействия ----------
client.on('interactionCreate', async (i) => {
  try {
    if (i.guildId !== GUILD_ID) {
      if (i.isRepliable()) {
        return await i.reply(ephemeral('❌ Бот не работает на данном сервере!')).catch(() => {});
      }
      return;
    }

    // Вызовы в кабинет куратора
    if (curatorCalls.owns(i)) return await curatorCalls.handle(i);

    // Брифинги (кнопки и формы с префиксом br_)
    if (briefing.owns(i)) return await briefing.handle(i);

    // Сверка выговоров игра ↔ Дискорд (кнопки с префиксом ps_)
    if (predSync.owns(i)) return await predSync.handle(i);

    // Команды модерации
    if (i.isChatInputCommand() && MOD_COMMAND_NAMES.has(i.commandName)) return await handleModCommand(i);

    // /ping
    if (i.isChatInputCommand() && i.commandName === 'ping') {
      const embed = new EmbedBuilder()
        .setColor(COLORS.main)
        .setTitle('🏓 Pong!')
        .addFields(
          { name: 'Задержка ответа', value: `${Date.now() - i.createdTimestamp} мс`, inline: true },
          { name: 'WebSocket', value: `${Math.round(client.ws.ping)} мс`, inline: true }
        )
        .setTimestamp();
      return await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // /addrest (только администраторы)
    if (i.isChatInputCommand() && i.commandName === 'addrest') {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return await i.reply(ephemeral('❌ Эта команда доступна только администраторам.'));
      }
      const target = i.options.getUser('игрок', true);
      const nick = i.options.getString('ник', true).trim();
      if (!nick) return await i.reply(ephemeral('❌ Ник не может быть пустым.'));
      const callsignOpt = i.options.getString('позывной')?.trim();
      saveNick(target.id, nick, callsignOpt || undefined);
      const entry = getEntry(target.id);
      await i.reply(
        ephemeral(
          `✅ Игрок <@${target.id}> записан в реестр: **${nick}**` + (entry.callsign ? `, позывной **${entry.callsign}**.` : '.') + '\nНик на сервере будет приведён к форме «ПРИСТАВКА | Ник».'
        )
      );
      const m = await i.guild.members.fetch(target.id).catch(() => null);
      if (m) await syncMemberNick(m);
      return await updateRoster();
    }

    // /restrlist (только администраторы)
    if (i.isChatInputCommand() && i.commandName === 'restrlist') {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return await i.reply(ephemeral('❌ Эта команда доступна только администраторам.'));
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await loadMembers(i.guild);

      const ids = Object.keys(nicks).sort((a, b) =>
        (getEntry(a)?.nick ?? '').localeCompare(getEntry(b)?.nick ?? '', 'ru', { sensitivity: 'base' })
      );
      if (!ids.length) return await i.editReply('📭 Реестр пока пуст.');

      const lines = ids.map((id, idx) => {
        const e = getEntry(id);
        const onServer = i.guild.members.cache.has(id);
        return (
          `**${idx + 1}.** <@${id}> — ${e.nick ? `\`${e.nick}\`` : '*нет ника*'}${e.callsign ? ` — позывной **${e.callsign}**` : ''}` +
          (onServer ? '' : ' 🚪')
        );
      });

      // Режем на страницы, чтобы не упереться в лимит Discord (4096 символов в embed)
      const pages = [];
      let cur = '';
      for (const line of lines) {
        if (cur.length + line.length + 1 > 3800) {
          pages.push(cur);
          cur = '';
        }
        cur += (cur ? '\n' : '') + line;
      }
      if (cur) pages.push(cur);

      const withNick = ids.filter((id) => getEntry(id)?.nick).length;
      const makeEmbed = (text, n) =>
        new EmbedBuilder()
          .setColor(COLORS.main)
          .setTitle(n === 0 ? '📚 Реестр игроков' : '📚 Реестр игроков (продолжение)')
          .setDescription(text)
          .setFooter({
            text: `Всего: ${ids.length} • с ником: ${withNick} • без ника: ${ids.length - withNick} • 🚪 — нет на сервере • стр. ${n + 1}/${pages.length}`,
          });

      await i.editReply({ embeds: [makeEmbed(pages[0], 0)], allowedMentions: { parse: [] } });
      for (let n = 1; n < pages.length; n++) {
        await i.followUp({ embeds: [makeEmbed(pages[n], n)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      return;
    }

    // /syncnicks (только администраторы)
    if (i.isChatInputCommand() && i.commandName === 'syncnicks') {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return await i.reply(ephemeral('❌ Эта команда доступна только администраторам.'));
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await loadMembers(i.guild);

      let adopted = 0;
      for (const m of i.guild.members.cache.values()) if (adoptFromNick(m)) adopted++;

      const groups = { changed: [], ok: [], 'no-nick': [], 'no-dept': [], forbidden: [], error: [], left: [] };
      for (const id of Object.keys(nicks)) {
        const member = i.guild.members.cache.get(id);
        const status = member ? await syncMemberNick(member) : 'left';
        (groups[status] ?? (groups[status] = [])).push(id);
      }
      const list = (ids) => {
        if (!ids.length) return '—';
        const text = ids.map((id) => `\`${getEntry(id)?.nick || discordName(i.guild, id)}\``).join(' ');
        return text.length > 1000 ? text.slice(0, 1000) + '…' : text;
      };
      // Все остальные участники сервера, которых нет в реестре
      const unreg = unregisteredMembers(i.guild);
      const unregRoles = unreg.filter((m) => nickPrefix(m));
      const names = (arr) => {
        if (!arr.length) return '—';
        const text = arr.map((m) => `\`${m.displayName}\``).join(' ');
        return text.length > 1000 ? text.slice(0, 1000) + '…' : text;
      };
      const embed = new EmbedBuilder()
        .setColor(COLORS.main)
        .setTitle('🔄 Проверка ников завершена')
        .addFields(
          { name: `✅ Изменён ник (${groups.changed.length})`, value: list(groups.changed) },
          { name: `👌 Уже по форме (${groups.ok.length})`, value: list(groups.ok) },
          { name: `📝 Нет игрового ника в реестре (${groups['no-nick'].length})`, value: list(groups['no-nick']) },
          { name: `🏢 Нет роли отдела (STG/RED/R.A.P/Мобильная группа) и не глава/зам, или несколько отделов сразу (${groups['no-dept'].length})`, value: list(groups['no-dept']) },
          { name: `🔒 Бот не может менять ник (${groups.forbidden.length + groups.error.length})`, value: list([...groups.forbidden, ...groups.error]) },
          { name: `🚪 Нет на сервере (${groups.left.length})`, value: list(groups.left) },
          {
            name: `👥 Не в реестре, но с ролью отдела/должностью (${unregRoles.length})`,
            value: names(unregRoles) + (unregRoles.length ? '\nДобавьте: `/addrest` игрок ник' : ''),
          },
          { name: '🔎 Проверено всего', value: `Участников (без ботов): ${i.guild.members.cache.filter((m) => !m.user.bot).size} • в реестре: ${Object.keys(nicks).length} • без записи: ${unreg.length}${adopted ? ` • добавлено по нику: ${adopted}` : ''}` }
        )
        .setFooter({ text: 'Ник добавляется командой /addrest игрок ник' });
      const buttons = [];
      if (groups['no-nick'].length) {
        buttons.push(new ButtonBuilder().setCustomId('fill_callsigns').setLabel('Заполнить ники').setStyle(ButtonStyle.Primary).setEmoji('✏️'));
      }
      if (unregRoles.length) {
        buttons.push(new ButtonBuilder().setCustomId('add_nicks').setLabel('Добавить ники в реестр').setStyle(ButtonStyle.Success).setEmoji('➕'));
      }
      const components = buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
      return await i.editReply({ embeds: [embed], components, allowedMentions: { parse: [] } });
    }

    // Кнопка «Добавить ники в реестр» — для тех, кого ещё нет в реестре (только администраторы)
    if (i.isButton() && i.customId === 'add_nicks') {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return await i.reply(ephemeral('❌ Эта кнопка доступна только администраторам.'));
      }
      await loadMembers(i.guild);
      const candidates = unregisteredMembers(i.guild).filter((m) => nickPrefix(m));
      if (!candidates.length) return await i.reply(ephemeral('✅ Нет игроков с ролью отдела/должностью, которых нет в реестре.'));

      const template = candidates
        .map((m) => `${m.displayName.replace(/\s*[\r\n]+\s*/g, ' ').trim()} = `)
        .join('\n')
        .slice(0, 4000);
      const modal = new ModalBuilder().setCustomId('add_nicks_modal').setTitle('Добавить игроков в реестр');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('lines')
            .setLabel('Впишите игровой ник после знака =')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(template)
            .setRequired(true)
            .setMaxLength(4000)
        )
      );
      return await i.showModal(modal);
    }

    // Отправка таблицы «Добавить ники в реестр» (только администраторы)
    if (i.isModalSubmit() && i.customId === 'add_nicks_modal') {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return await i.reply(ephemeral('❌ Эта функция доступна только администраторам.'));
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await loadMembers(i.guild);

      // Все, кого нет в реестре, по их нику в Discord
      const byName = new Map();
      for (const m of unregisteredMembers(i.guild)) {
        const key = m.displayName.replace(/\s*[\r\n]+\s*/g, ' ').trim().toLowerCase();
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(m);
      }

      const done = [];
      const unknown = [];
      for (const raw of i.fields.getTextInputValue('lines').split('\n')) {
        const line = raw.trim();
        const eq = line.lastIndexOf('=');
        if (eq < 1) continue;
        const name = line.slice(0, eq).trim();
        const gameNick = line.slice(eq + 1).trim().slice(0, 40);
        if (!gameNick) continue;
        const members = byName.get(name.toLowerCase());
        if (!members?.length) {
          unknown.push(name);
          continue;
        }
        for (const member of members) {
          saveNick(member.id, gameNick, undefined);
          const st = await syncMemberNick(member);
          done.push(`<@${member.id}> — **${gameNick}** — ${SYNC_STATUS_TEXT[st] ?? st}`);
        }
      }

      const embed = new EmbedBuilder()
        .setColor(done.length ? COLORS.ok : COLORS.warn)
        .setTitle('➕ Игроки добавлены в реестр')
        .setDescription(done.length ? done.join('\n').slice(0, 4000) : 'Ни одной заполненной строки не найдено. Впишите игровой ник после знака «=».');
      if (unknown.length) embed.addFields({ name: '❓ Не найдены среди тех, кого нет в реестре', value: unknown.join(', ').slice(0, 1000) });
      embed.setFooter({ text: 'Повторите /syncnicks, чтобы увидеть, кто ещё остался' });
      await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
      return await updateRoster();
    }

    // Кнопка «Заполнить ники» (только администраторы)
    if (i.isButton() && i.customId === 'fill_callsigns') {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return await i.reply(ephemeral('❌ Эта кнопка доступна только администраторам.'));
      }
      const missing = Object.keys(nicks).filter((id) => !getEntry(id)?.nick);
      if (!missing.length) return await i.reply(ephemeral('✅ У всех игроков из реестра уже указан игровой ник.'));

      await loadMembers(i.guild);
      const template = missing.map((id) => `${discordName(i.guild, id)} = `).join('\n').slice(0, 4000);
      const modal = new ModalBuilder().setCustomId('callsigns_modal').setTitle('Игровые ники');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('lines')
            .setLabel('Впишите игровой ник после знака =')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(template)
            .setRequired(true)
            .setMaxLength(4000)
        )
      );
      return await i.showModal(modal);
    }

    // Отправка таблицы ников (только администраторы)
    if (i.isModalSubmit() && i.customId === 'callsigns_modal') {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return await i.reply(ephemeral('❌ Эта функция доступна только администраторам.'));
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await loadMembers(i.guild);

      const statusText = {
        changed: 'ник изменён',
        ok: 'ник уже по форме',
        'no-dept': 'нет роли отдела (ник не менялся)',
        forbidden: 'бот не может менять ник',
        error: 'ошибка смены ника',
        skip: 'пропущен',
      };
      const done = [];
      const unknown = [];
      // Игроки без игрового ника, сгруппированные по их нику в Discord
      const byName = new Map();
      for (const id of Object.keys(nicks).filter((uid) => !getEntry(uid)?.nick)) {
        const key = discordName(i.guild, id).toLowerCase();
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(id);
      }

      for (const raw of i.fields.getTextInputValue('lines').split('\n')) {
        const line = raw.trim();
        const eq = line.lastIndexOf('=');
        if (eq < 1) continue; // нет знака «=» — пропускаем
        const name = line.slice(0, eq).trim();
        const gameNick = line.slice(eq + 1).trim().slice(0, 40);
        if (!gameNick) continue; // не заполнено — пропускаем
        const ids = byName.get(name.toLowerCase());
        if (!ids?.length) {
          unknown.push(name);
          continue;
        }
        for (const id of ids) {
          saveNick(id, gameNick, undefined);
          const member = i.guild.members.cache.get(id);
          const st = member ? await syncMemberNick(member) : 'left';
          done.push(`<@${id}> — **${gameNick}** — ${st === 'left' ? 'нет на сервере' : statusText[st] ?? st}`);
        }
      }

      const embed = new EmbedBuilder()
        .setColor(done.length ? COLORS.ok : COLORS.warn)
        .setTitle('✏️ Ники сохранены')
        .setDescription(done.length ? done.join('\n').slice(0, 4000) : 'Ни одной заполненной строки не найдено. Впишите игровой ник после знака «=».');
      if (unknown.length) embed.addFields({ name: '❓ Не найдены в реестре', value: unknown.join(', ').slice(0, 1000) });
      embed.setFooter({ text: 'Повторите /syncnicks, чтобы увидеть, кто ещё остался' });
      await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
      return await updateRoster();
    }

    // /fastroll (только администраторы)
    if (i.isChatInputCommand() && i.commandName === 'fastroll') {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return await i.reply(ephemeral('❌ Эта команда доступна только администраторам.'));
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });

      const extractIds = (text) => [...new Set([...text.matchAll(/\d{17,20}/g)].map((m) => m[0]))];
      const userIds = extractIds(i.options.getString('игроки', true));
      const roleIds = extractIds(i.options.getString('роли', true)).filter((id) => id !== i.guild.id);

      if (!userIds.length) return await i.editReply('❌ Не нашёл ни одного игрока. Укажите пинги: `@игрок1 @игрок2`.');
      if (!roleIds.length) return await i.editReply('❌ Не нашёл ни одной роли. Укажите пинги ролей: `@роль1 @роль2`.');
      if (userIds.length > 25) return await i.editReply('❌ Слишком много игроков за раз (максимум 25).');

      // Проверяем роли заранее, чтобы не оставить людей с полуготовым результатом
      if (roleIds.some(isRankRoleId) && !roleIds.includes(EXTRA_RANK_ROLE_ID)) roleIds.push(EXTRA_RANK_ROLE_ID); // ранг → всегда с доп. ролью
      const problems = [];
      for (const id of roleIds) {
        const role = i.guild.roles.cache.get(id);
        if (!role) problems.push(`\`${id}\` — такой роли нет на сервере`);
        else if (role.managed) problems.push(`<@&${id}> — системная роль (интеграция/бот)`);
        else if (!role.editable) problems.push(`<@&${id}> — выше роли бота, выдать нельзя`);
      }
      if (problems.length) {
        return await i.editReply({ content: `❌ Операция отменена, ни у кого ничего не изменено:\n${problems.join('\n')}`, allowedMentions: { parse: [] } });
      }

      const results = [];
      for (const uid of userIds) {
        const member = await i.guild.members.fetch(uid).catch(() => null);
        if (!member) {
          results.push(`<@${uid}> — ❌ не найден на сервере`);
          continue;
        }
        if (member.user.bot) {
          results.push(`<@${uid}> — ⏭️ бот, пропущен`);
          continue;
        }
        if (!member.manageable) {
          results.push(`<@${uid}> — ❌ роль игрока выше роли бота (или владелец сервера)`);
          continue;
        }
        // Роли, которые бот физически не может снять (системные / выше бота), оставляем, иначе операция упадёт
        const protectedRoles = member.roles.cache
          .filter((r) => r.id !== i.guild.id && (r.managed || !r.editable) && !roleIds.includes(r.id))
          .map((r) => r.id);
        const finalRoles = [...new Set([...roleIds, ...protectedRoles])];
        const removed = member.roles.cache.filter((r) => r.id !== i.guild.id && !finalRoles.includes(r.id)).size;
        try {
          await member.roles.set(finalRoles, `/fastroll от ${i.user.tag}`);
          results.push(`<@${uid}> — ✅ снято ролей: ${removed}` + (protectedRoles.length ? `, не тронуто системных: ${protectedRoles.length}` : ''));
        } catch (err) {
          console.error('Ошибка /fastroll:', err.message);
          results.push(`<@${uid}> — ❌ ошибка: ${err.message}`);
        }
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.ok)
        .setTitle('⚡ Быстрая смена ролей')
        .setDescription(results.join('\n').slice(0, 4000))
        .addFields({ name: 'Оставлены роли', value: roleIds.map((id) => `<@&${id}>`).join(' ').slice(0, 1000) })
        .setFooter({ text: `Выполнил: ${i.user.tag}` })
        .setTimestamp();
      await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
      return await updateRoster();
    }

    // /clearroll (только администраторы)
    if (i.isChatInputCommand() && i.commandName === 'clearroll') {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return await i.reply(ephemeral('❌ Эта команда доступна только администраторам.'));
      }
      const target = i.options.getUser('игрок', true);
      const role = i.options.getRole('роль', true);
      const member = await i.guild.members.fetch(target.id).catch(() => null);
      if (!member) return await i.reply(ephemeral('❌ Игрок не найден на сервере.'));
      if (role.id === i.guild.id || role.managed) {
        return await i.reply(ephemeral('❌ Эту роль нельзя снять (системная или управляется интеграцией).'));
      }
      if (!member.roles.cache.has(role.id)) {
        return await i.reply(ephemeral(`⚠️ У <@${member.id}> нет роли <@&${role.id}>.`));
      }
      if (!member.manageable) {
        return await i.reply(ephemeral('❌ Я не могу менять роли этого игрока: его высшая роль выше или равна роли бота (или он владелец сервера).'));
      }
      const botRole = i.guild.roles.cache.get(role.id);
      if (!botRole?.editable) {
        return await i.reply(ephemeral('❌ Я не могу снять эту роль: она выше или равна роли бота. Поднимите роль бота выше.'));
      }
      await member.roles.remove(role.id, `/clearroll от ${i.user.tag}`);
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.ok)
            .setTitle('✅ Роль снята')
            .addFields(
              { name: 'Игрок', value: `<@${member.id}>`, inline: true },
              { name: 'Роль', value: `<@&${role.id}>`, inline: true },
              { name: 'Администратор', value: `<@${i.user.id}>`, inline: true }
            )
            .setTimestamp(),
        ],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return await updateRoster(); // если сняли роль руководителя — список сразу обновится
    }

    // Кнопка «Начать запрос роли»
    if (i.isButton() && i.customId === 'role_start') return await showDepartmentSelect(i);

    // Выбор отдела
    if (i.isStringSelectMenu() && i.customId === 'role_dept') return await showRequestModal(i);

    // Отправка формы
    if (i.isModalSubmit() && i.customId.startsWith('role_modal:')) return await handleRequestSubmit(i);

    // Кнопки модерации
    if (i.isButton() && i.customId.startsWith('approve:')) return await handleApprove(i);
    if (i.isButton() && i.customId.startsWith('deny:')) return await handleDenyButton(i);

    // Модалка причины отказа
    if (i.isModalSubmit() && i.customId.startsWith('deny_modal:')) return await handleDenySubmit(i);

    // Жалобы (тикеты)
    if (i.isButton() && i.customId === 'ticket_open') return await showTicketModal(i);
    if (i.isModalSubmit() && i.customId === 'ticket_modal') return await handleTicketSubmit(i);
    if (i.isButton() && i.customId === 'ticket_claim') return await handleTicketClaim(i);
    if (i.isButton() && i.customId === 'ticket_close') return await showTicketCloseModal(i);
    if (i.isModalSubmit() && i.customId === 'ticket_close_modal') return await handleTicketCloseSubmit(i);
  } catch (err) {
    if (err?.code === 10062 || err?.code === 40060) return; // взаимодействие устарело / уже подтверждено
    const net = isNetworkError(err);
    if (net) console.warn('Ошибка взаимодействия: нет связи с Discord (' + (err.code ?? err.message) + ')');
    else console.error('Ошибка взаимодействия:', err);
    const text = net ? '❌ Нет связи с Discord, попробуйте через минуту.' : '❌ Произошла ошибка. Попробуйте ещё раз позже.';
    if (i.isRepliable()) {
      if (!i.replied && !i.deferred) i.reply(ephemeral(text)).catch(() => {});
      else if (i.deferred && !i.replied) i.editReply({ content: text, embeds: [], components: [] }).catch(() => {});
    }
  }
});

// ---------- Шаг 1: выбор отдела ----------
async function showDepartmentSelect(i) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('role_dept')
    .setPlaceholder('Выберите отдел или статус')
    .addOptions([
      ...Object.entries(DEPARTMENTS).map(([key, d]) => ({ label: d.name, value: key, description: `Отдел ${d.name}` })),
      ...Object.entries(SPECIAL_TYPES).map(([key, t]) => ({ label: t.name, value: key, emoji: t.emoji, description: `Запрос роли: ${t.name}` })),
    ]);
  await i.reply({
    content: '**Выберите ваш отдел или статус:**',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

// ---------- Шаг 2: форма ----------
async function showRequestModal(i) {
  const dept = i.values[0];
  const special = SPECIAL_TYPES[dept];
  const modal = new ModalBuilder().setCustomId(`role_modal:${dept}`).setTitle(special ? `Запрос: ${special.name}` : 'Запрос роли');

  const nick = new TextInputBuilder()
    .setCustomId('nick')
    .setLabel('Никнейм')
    .setPlaceholder('Itachi_Takatsuki')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(40)
    .setRequired(true);
  if (special) {
    // «Друг организации» / «Бывший оперативник» — нужен только ник
    modal.addComponents(new ActionRowBuilder().addComponents(nick));
    return await i.showModal(modal);
  }
  const callsign = new TextInputBuilder()
    .setCustomId('callsign')
    .setLabel('Позывной')
    .setPlaceholder('Гром')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(40)
    .setRequired(true);
  const rank = new TextInputBuilder()
    .setCustomId('rank')
    .setLabel('Ранг (цифра от 1 до 8)')
    .setPlaceholder('8')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(1)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nick),
    new ActionRowBuilder().addComponents(callsign),
    new ActionRowBuilder().addComponents(rank)
  );
  await i.showModal(modal);
}

// ---------- Шаг 3: приём заявки ----------
async function handleSpecialRequestSubmit(i, dept) {
  const special = SPECIAL_TYPES[dept];
  const nick = i.fields.getTextInputValue('nick').trim();
  if (!nick) return i.reply(ephemeral('❌ Никнейм не может быть пустым.'));

  await i.deferReply({ flags: MessageFlags.Ephemeral }); // сразу отвечаем, дальше можно не спешить
  const reviewChannel = await withRetry(() => client.channels.fetch(REVIEW_CHANNEL_ID), { tries: 3 }).catch(() => null);
  if (!reviewChannel) return i.editReply('❌ Канал заявок недоступен. Сообщите администрации.');

  const embed = new EmbedBuilder()
    .setColor(COLORS.warn)
    .setTitle(nick)
    .setThumbnail(i.user.displayAvatarURL())
    .addFields(
      { name: `${special.emoji} Статус`, value: special.name, inline: true },
      { name: '👤 Заявитель', value: `<@${i.user.id}>`, inline: true },
      { name: '🎖️ Роли к выдаче', value: special.roleIds.map((id) => `<@&${id}>`).join('\n') }
    )
    .setFooter({ text: 'Статус: ожидает рассмотрения' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve:${i.user.id}:${dept}:0`).setLabel('Выдать роль').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`deny:${i.user.id}`).setLabel('Отказать').setStyle(ButtonStyle.Danger).setEmoji('❌')
  );
  await reviewChannel.send({
    content: `🔔 Новая заявка на роль! ${MODERATOR_ROLES.map((id) => `<@&${id}>`).join(' ')}`,
    embeds: [embed],
    components: [row],
    allowedMentions: { roles: MODERATOR_ROLES },
  });
  await i.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.ok)
        .setTitle('✅ Запрос отправлен')
        .setDescription('Ваша заявка передана на рассмотрение. Ожидайте — результат придёт вам в личные сообщения.'),
    ],
  });
}

async function handleRequestSubmit(i) {
  const dept = i.customId.split(':')[1];
  if (SPECIAL_TYPES[dept]) return handleSpecialRequestSubmit(i, dept);
  const department = DEPARTMENTS[dept];
  if (!department) return i.reply(ephemeral('❌ Неизвестный отдел.'));

  const nick = i.fields.getTextInputValue('nick').trim();
  const callsign = i.fields.getTextInputValue('callsign').trim();
  const rank = i.fields.getTextInputValue('rank').trim();

  if (!/^[1-8]$/.test(rank)) {
    return i.reply(
      ephemeral('❌ **Ранг указан неверно!** Нужна ровно одна цифра от 1 до 8, без букв и других символов. Попробуйте снова.')
    );
  }
  if (!nick || !callsign) {
    return i.reply(ephemeral('❌ Никнейм и позывной не могут быть пустыми.'));
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral }); // сразу отвечаем, дальше можно не спешить
  const reviewChannel = await withRetry(() => client.channels.fetch(REVIEW_CHANNEL_ID), { tries: 3 }).catch(() => null);
  if (!reviewChannel) return i.editReply('❌ Канал заявок недоступен. Сообщите администрации.');

  const rankRoleId = RANK_ROLES[rank];
  const embed = new EmbedBuilder()
    .setColor(COLORS.warn)
    .setTitle(`${nick} [${rank}]`)
    .setThumbnail(i.user.displayAvatarURL())
    .addFields(
      { name: '🪪 Позывной', value: callsign, inline: true },
      { name: '🏢 Отдел', value: department.name, inline: true },
      { name: '👤 Заявитель', value: `<@${i.user.id}>`, inline: true },
      { name: '🎖️ Роли к выдаче', value: `<@&${rankRoleId}>\n<@&${department.roleId}>\n<@&${EXTRA_RANK_ROLE_ID}>` }
    )
    .setFooter({ text: 'Статус: ожидает рассмотрения' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${i.user.id}:${dept}:${rank}`)
      .setLabel('Выдать роль')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder().setCustomId(`deny:${i.user.id}`).setLabel('Отказать').setStyle(ButtonStyle.Danger).setEmoji('❌')
  );

  await reviewChannel.send({
    content: `🔔 Новая заявка на роль! ${MODERATOR_ROLES.map((id) => `<@&${id}>`).join(' ')}`,
    embeds: [embed],
    components: [row],
    allowedMentions: { roles: MODERATOR_ROLES },
  });

  await i.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.ok)
        .setTitle('✅ Запрос отправлен')
        .setDescription('Ваша заявка передана на рассмотрение. Ожидайте — результат придёт вам в личные сообщения.'),
    ],
  });
}

// ---------- Вспомогательное ----------
function processingRow(text = 'Обработка...') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('processing').setLabel(text).setStyle(ButtonStyle.Secondary).setDisabled(true).setEmoji('⏳')
  );
}

async function sendDM(userId, payload) {
  try {
    const user = await withRetry(() => client.users.fetch(userId), { tries: 3, base: 800 });
    await withRetry(() => user.send(payload), { tries: 3, base: 800 });
    return true;
  } catch {
    return false;
  }
}

async function guardModerator(i) {
  if (!canModerate(i.member)) {
    await i.reply(ephemeral('❌ У вас нет прав для обработки заявок.'));
    return false;
  }
  return true;
}

// ---------- Одобрение ----------
async function handleApprove(i) {
  if (!(await guardModerator(i))) return;

  const msgId = i.message.id;
  if (processing.has(msgId)) {
    return i.reply(ephemeral('⏳ Эта заявка уже обрабатывается или обработана.'));
  }
  processing.add(msgId); // блокировка ставится синхронно, до любых await

  const [, userId, dept, rank] = i.customId.split(':');
  const special = SPECIAL_TYPES[dept];
  const department = DEPARTMENTS[dept];
  const rankRoleId = RANK_ROLES[rank];

  try {
    // Сразу блокируем кнопки
    await i.update({ components: [processingRow()] });
    pendingDeny.delete(msgId);

    const member = await i.guild.members.fetch(userId).catch(() => null);
    if (!member) {
      return finishRequest(i, {
        ok: false,
        title: '⚠️ Ошибка',
        verdict: 'Игрок не найден на сервере (возможно, вышел).',
      });
    }

    // Убираем старые роли ранга и отдела, затем выдаём новые
    const keep = special ? [...special.roleIds] : [rankRoleId, department.roleId, EXTRA_RANK_ROLE_ID];
    const toRemove = [
      NEWCOMER_ROLE_ID,
      ...Object.values(RANK_ROLES),
      ...Object.values(DEPARTMENTS).map((d) => d.roleId),
      ...Object.values(SPECIAL_TYPES).flatMap((t) => t.roleIds),
    ].filter(
      (id) => !keep.includes(id) && member.roles.cache.has(id)
    );
    if (toRemove.length) await member.roles.remove(toRemove, `Смена роли по заявке: ${i.user.tag}`);
    await member.roles.add(keep, `Заявка одобрена: ${i.user.tag}`);

    // Игровой ник из заявки (заголовок вида «Ник [ранг]») и позывной
    const gameNick = (i.message.embeds[0]?.title ?? '').replace(/\s*\[\d\]\s*$/, '').trim();
    const callsign = (i.message.embeds[0]?.fields?.find((f) => f.name.includes('Позывной'))?.value ?? '').trim();

    // Ник на сервере по форме: ПРИСТАВКА | Ник  (например STG | Harizma_Angeles)
    const leader = LEADER_PREFIXES.find((l) => member.roles.cache.has(l.roleId));
    const newNick = `${special ? special.prefix : leader ? leader.prefix : department.name} | ${gameNick}`.slice(0, 32);
    let nickOk = true;
    try {
      await member.setNickname(newNick, `Заявка одобрена: ${i.user.tag}`);
    } catch (err) {
      nickOk = false;
      console.error('Не удалось сменить ник:', err.message);
    }

    // Запоминаем ник и позывной в реестре
    if (gameNick) {
      try {
        saveNick(userId, gameNick, callsign);
      } catch (err) {
        console.error('Не удалось сохранить игровой ник:', err.message);
      }
    }

    const dmOk = await sendDM(userId, {
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.ok)
          .setTitle('✅ Заявка одобрена')
          .setDescription('Ваша заявка на выдачу роли была одобрена!'),
      ],
    });

    await finishRequest(i, {
      ok: true,
      verdict: '✅ Роль выдана',
      nick: nickOk ? newNick : null,
      dmOk,
    });
  } catch (err) {
    console.error('Ошибка при выдаче роли:', err);
    // Возвращаем кнопки, чтобы можно было повторить
    processing.delete(msgId);
    await i.message
      .edit({ components: originalButtons(userId, dept, rank) })
      .catch(() => {});
    await i.followUp(ephemeral('❌ Не удалось выдать роль. Проверьте, что роль бота выше выдаваемых ролей и есть право «Управлять ролями».')).catch(() => {});
  }
}

function originalButtons(userId, dept, rank) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`approve:${userId}:${dept}:${rank}`).setLabel('Выдать роль').setStyle(ButtonStyle.Success).setEmoji('✅'),
      new ButtonBuilder().setCustomId(`deny:${userId}`).setLabel('Отказать').setStyle(ButtonStyle.Danger).setEmoji('❌')
    ),
  ];
}

// ---------- Отказ ----------
async function handleDenyButton(i) {
  if (!(await guardModerator(i))) return;

  const msgId = i.message.id;
  if (processing.has(msgId)) {
    return i.reply(ephemeral('⏳ Эта заявка уже обрабатывается или обработана.'));
  }

  // Если другой модератор прямо сейчас вводит причину — не даём открыть вторую форму
  const pending = pendingDeny.get(msgId);
  if (pending && pending.until > Date.now() && pending.moderatorId !== i.user.id) {
    return i.reply(ephemeral(`⏳ Причину отказа уже вводит <@${pending.moderatorId}>.`));
  }
  pendingDeny.set(msgId, { moderatorId: i.user.id, until: Date.now() + 5 * 60 * 1000 });

  const userId = i.customId.split(':')[1];
  const modal = new ModalBuilder().setCustomId(`deny_modal:${userId}`).setTitle('Отказ в заявке');
  const reason = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Причина отказа')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(reason));
  await i.showModal(modal);
}

async function handleDenySubmit(i) {
  if (!canModerate(i.member)) return i.reply(ephemeral('❌ У вас нет прав для обработки заявок.'));
  if (!i.isFromMessage()) return i.reply(ephemeral('❌ Не удалось определить заявку.'));

  const msgId = i.message.id;
  if (processing.has(msgId)) {
    return i.reply(ephemeral('⏳ Эта заявка уже обрабатывается или обработана.'));
  }
  processing.add(msgId);

  const userId = i.customId.split(':')[1];
  const reason = i.fields.getTextInputValue('reason').trim();

  const originalRows = i.message.components.map((r) => ActionRowBuilder.from(r));
  try {
    await i.update({ components: [processingRow()] });
    pendingDeny.delete(msgId);

    const dmOk = await sendDM(userId, {
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.no)
          .setTitle('❌ Заявка отказана')
          .setDescription(`Ваша заявка была отказана по причине: **${reason}**`),
      ],
    });

    await finishRequest(i, { ok: false, verdict: '❌ Отказано', reason, dmOk });
  } catch (err) {
    console.error('Ошибка при отказе:', err);
    processing.delete(msgId);
    // Возвращаем кнопки, иначе заявка навсегда останется с «Обработка...»
    await i.message.edit({ components: originalRows }).catch(() => {});
    await i.followUp(ephemeral('❌ Не удалось оформить отказ. Попробуйте ещё раз.')).catch(() => {});
  }
}

// ---------- Финальное обновление сообщения заявки ----------
async function finishRequest(i, { ok, title, verdict, reason, dmOk, nick }) {
  const base = EmbedBuilder.from(i.message.embeds[0]);
  base.setColor(ok ? COLORS.ok : COLORS.no);
  base.setFooter({ text: `Статус: ${ok ? 'одобрена' : 'отказана'}` });
  base.addFields(
    { name: '⚖️ Вердикт', value: verdict, inline: true },
    { name: '🛡️ Рассмотрел', value: `<@${i.user.id}>`, inline: true }
  );
  if (reason) base.addFields({ name: '📄 Причина', value: reason });
  if (nick) base.addFields({ name: '✏️ Установлен ник', value: nick });
  if (ok && !nick) base.addFields({ name: '✏️ Ник', value: 'Не удалось сменить ник (у игрока роль выше роли бота или он владелец сервера).' });
  if (dmOk === false) base.addFields({ name: '📭 ЛС', value: 'Не удалось отправить игроку личное сообщение (ЛС закрыты).' });
  if (title) base.setTitle(`${base.data.title} — ${title}`);

  await i.message.edit({ content: '', embeds: [base], components: [] });
  setTimeout(() => processing.delete(i.message.id), 10 * 60 * 1000).unref?.(); // кнопок уже нет — замок больше не нужен
}

// ===================== ТИКЕТЫ-ЖАЛОБЫ =====================
const TICKET_PANEL_CHANNEL_ID = '1557891643015958538'; // канал с кнопкой «Подать жалобу»
const TICKET_CATEGORY_ID = '1557893591848984636'; // раздел, где создаются тикеты
const TICKET_LOG_CHANNEL_ID = '1557891365948493894'; // логи жалоб
const TICKET_STAFF_ROLES = ['1553158717787340971', '1553158349317742653']; // пингуются и работают с кнопками
const TICKET_EXTRA_ID = '1440272013028626475'; // тоже может нажимать кнопки (роль или пользователь)

const ticketStore = makeStore(path.join(DATA_DIR, 'tickets.json'), () => ({ counter: 0, tickets: {} }));
const ticketDb = ticketStore.data;
ticketDb.tickets ??= {};
ticketDb.counter ??= 0;
const saveTickets = () => ticketStore.saveNow(); // номера и статусы тикетов пишем сразу

const ticketLocks = new Set(); // id каналов, чьи кнопки уже нажаты и обрабатываются

const canUseTicket = (member) =>
  !!member && (member.id === TICKET_EXTRA_ID || member.roles.cache.some((r) => TICKET_STAFF_ROLES.includes(r.id) || r.id === TICKET_EXTRA_ID));

function ticketPanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(COLORS.no)
    .setTitle('🚨 ЖАЛОБА НА ИГРОКА')
    .setDescription(
      'Столкнулись с нарушением? Вы можете подать жалобу на игрока.\n\n' +
        '**Как это работает:**\n' +
        '> 1️⃣ Нажмите кнопку ниже\n' +
        '> 2️⃣ Заполните форму:\n' +
        '> • инициатор наказания\n' +
        '> • нарушитель\n' +
        '> • суть нарушения\n' +
        '> • доказательство (ссылка на видео)\n' +
        '> 3️⃣ Бот создаст отдельный тикет, где жалобу рассмотрит администрация\n' +
        '> 4️⃣ О закрытии тикета вы получите уведомление в личные сообщения'
    )
    .setFooter({ text: 'FBI Helper • Жалобы' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_open').setLabel('Подать жалобу').setStyle(ButtonStyle.Danger).setEmoji('📨')
  );
  return { embeds: [embed], components: [row] };
}

async function ensureTicketPanel() {
  const channel = await client.channels.fetch(TICKET_PANEL_CHANNEL_ID).catch(() => null);
  if (!channel) return console.error('Канал жалоб не найден!');
  const messages = await withRetry(() => channel.messages.fetch({ limit: 30 })).catch(() => null);
  if (!messages) return console.error('Не удалось проверить панель жалоб (нет связи) — новую не создаю, чтобы не было дублей.');
  const exists = messages.some(
    (m) => m.author.id === client.user.id && m.components.some((r) => r.components.some((c) => c.customId === 'ticket_open'))
  );
  if (!exists) {
    await withRetry(() => channel.send(ticketPanelPayload()));
    console.log('Панель жалоб отправлена.');
  }
}

async function ticketLog(embed) {
  try {
    const ch = await client.channels.fetch(TICKET_LOG_CHANNEL_ID);
    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('Не удалось записать лог жалобы:', err.message);
  }
}

const ticketName = (n) => `ticket-player-${String(n).padStart(4, '0')}`;

// Шаг 1: кнопка → форма
async function showTicketModal(i) {
  const field = (id, label, style, placeholder, max) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setPlaceholder(placeholder).setRequired(true).setMaxLength(max)
    );
  const modal = new ModalBuilder()
    .setCustomId('ticket_modal')
    .setTitle('Жалоба на игрока')
    .addComponents(
      field('initiator', 'Инициатор наказания', TextInputStyle.Short, 'Nick_Name', 40),
      field('violator', 'Нарушитель', TextInputStyle.Short, 'Nick_Name', 40),
      field('essence', 'Суть нарушения', TextInputStyle.Paragraph, 'Опишите, что произошло', 1000),
      field('evidence', 'Доказательство (ссылка на видео)', TextInputStyle.Short, 'https://youtube.com/...', 300)
    );
  await i.showModal(modal);
}

// Шаг 2: создание тикета
async function handleTicketSubmit(i) {
  const initiator = i.fields.getTextInputValue('initiator').trim();
  const violator = i.fields.getTextInputValue('violator').trim();
  const essence = i.fields.getTextInputValue('essence').trim();
  const evidence = i.fields.getTextInputValue('evidence').trim();

  if (!/^https?:\/\/\S+$/i.test(evidence)) {
    return i.reply(ephemeral('❌ В поле «Доказательство» нужна ссылка на видео (начинается с http:// или https://). Попробуйте снова.'));
  }

  // Один открытый тикет на игрока (если канал удалили вручную — запись считается закрытой)
  for (const [chId, t] of Object.entries(ticketDb.tickets)) {
    if (t.userId !== i.user.id || t.status !== 'open') continue;
    if (i.guild.channels.cache.has(chId)) {
      return i.reply(ephemeral(`❌ У вас уже есть открытая жалоба: <#${chId}>. Дождитесь её рассмотрения.`));
    }
    t.status = 'closed';
    t.deleted = true;
    t.closedAt = Date.now();
    saveTickets();
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  // Номер выдаётся синхронно и сразу сохраняется — два тикета не получат один номер
  const number = ++ticketDb.counter;
  saveTickets();
  const name = ticketName(number);

  try {
    const guild = i.guild;
    const overwrites = [
      { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      {
        id: i.user.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles],
      },
      {
        id: client.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ManageMessages,
          PermissionsBitField.Flags.EmbedLinks,
        ],
      },
    ];
    const staffAllow = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles];
    for (const rid of TICKET_STAFF_ROLES) overwrites.push({ id: rid, allow: staffAllow });
    // TICKET_EXTRA_ID — роль или пользователь
    if (guild.roles.cache.has(TICKET_EXTRA_ID)) overwrites.push({ id: TICKET_EXTRA_ID, allow: staffAllow });
    else if (guild.members.cache.has(TICKET_EXTRA_ID) || (await guild.members.fetch(TICKET_EXTRA_ID).catch(() => null))) overwrites.push({ id: TICKET_EXTRA_ID, allow: staffAllow });

    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: TICKET_CATEGORY_ID,
      topic: `Жалоба #${String(number).padStart(4, '0')} • автор: ${i.user.id}`,
      permissionOverwrites: overwrites,
      reason: `Жалоба от ${i.user.tag}`,
    });

    ticketDb.tickets[channel.id] = {
      number,
      name,
      userId: i.user.id,
      claimedBy: null,
      status: 'open',
      createdAt: Date.now(),
    };
    saveTickets();

    const embed = new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle(`🚨 Жалоба ${name}`)
      .setThumbnail(i.user.displayAvatarURL())
      .addFields(
        { name: '👮 Инициатор наказания', value: `\`${initiator}\``, inline: true },
        { name: '⚠️ Нарушитель', value: `\`${violator}\``, inline: true },
        { name: '👤 Автор жалобы', value: `<@${i.user.id}>`, inline: true },
        { name: '📝 Суть нарушения', value: essence },
        { name: '🎥 Доказательство', value: evidence },
        { name: '📌 Статус', value: '⏳ Ожидает рассмотрения' }
      )
      .setFooter({ text: 'Нажмите «Взять», чтобы начать рассмотрение' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_claim').setLabel('Взять').setStyle(ButtonStyle.Success).setEmoji('✋')
    );

    await channel.send({
      content: `${TICKET_STAFF_ROLES.map((id) => `<@&${id}>`).join(' ')} <@${i.user.id}>`,
      embeds: [embed],
      components: [row],
      allowedMentions: { roles: TICKET_STAFF_ROLES, users: [i.user.id] },
    });

    await i.editReply(`✅ Жалоба отправлена! Тикет: <#${channel.id}>`);

    await ticketLog(
      new EmbedBuilder()
        .setColor(COLORS.warn)
        .setTitle(`📨 Новая жалоба — ${name}`)
        .addFields(
          { name: 'Автор', value: `<@${i.user.id}> (\`${i.user.id}\`)`, inline: true },
          { name: 'Канал', value: `<#${channel.id}>`, inline: true },
          { name: 'Инициатор наказания', value: `\`${initiator}\``, inline: true },
          { name: 'Нарушитель', value: `\`${violator}\``, inline: true },
          { name: 'Суть нарушения', value: essence },
          { name: 'Доказательство', value: evidence }
        )
        .setTimestamp()
    );
  } catch (err) {
    console.error('Ошибка создания тикета:', err);
    await i.editReply('❌ Не удалось создать тикет. Сообщите администрации (проверьте права бота на раздел тикетов).').catch(() => {});
  }
}

// Шаг 3: «Взять»
async function handleTicketClaim(i) {
  if (!canUseTicket(i.member)) return i.reply(ephemeral('❌ Эта кнопка доступна только администрации.'));

  const chId = i.channelId;
  const ticket = ticketDb.tickets[chId];
  if (!ticket || ticket.status !== 'open') return i.reply(ephemeral('❌ Тикет не найден или уже закрыт.'));

  // Сначала запоминаем, кто нажал (синхронно, до любых await), потом обрабатываем
  if (ticketLocks.has(chId) || ticket.claimedBy) {
    const who = ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'другим администратором';
    return i.reply({ ...ephemeral(`⏳ Жалобу уже взял ${who}.`), allowedMentions: { parse: [] } });
  }
  ticketLocks.add(chId);
  ticket.claimedBy = i.user.id;
  try {
    saveTickets();
    const old = i.message.embeds[0];
    const embed = EmbedBuilder.from(old)
      .setColor(COLORS.main)
      .setFooter({ text: 'Жалоба взята в работу' });
    const fields = (old.fields ?? []).map((f) => (f.name.includes('Статус') ? { ...f, value: `🔧 В работе — <@${i.user.id}>` } : f));
    embed.setFields(fields);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_close').setLabel('Закрыть').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );
    await i.update({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });

    await ticketLog(
      new EmbedBuilder()
        .setColor(COLORS.main)
        .setTitle(`✋ Жалоба взята — ${ticket.name}`)
        .addFields(
          { name: 'Взял', value: `<@${i.user.id}> (\`${i.user.id}\`)`, inline: true },
          { name: 'Канал', value: `<#${chId}>`, inline: true }
        )
        .setTimestamp()
    );
  } catch (err) {
    // откат, чтобы жалобу можно было взять снова
    ticket.claimedBy = null;
    try { saveTickets(); } catch {}
    console.error('Ошибка при взятии жалобы:', err);
    if (!i.replied && !i.deferred) i.reply(ephemeral('❌ Не удалось взять жалобу. Попробуйте ещё раз.')).catch(() => {});
  } finally {
    ticketLocks.delete(chId);
  }
}

// Шаг 4: «Закрыть» → форма с причиной
async function showTicketCloseModal(i) {
  if (!canUseTicket(i.member)) return i.reply(ephemeral('❌ Эта кнопка доступна только администрации.'));
  const ticket = ticketDb.tickets[i.channelId];
  if (!ticket || ticket.status !== 'open') return i.reply(ephemeral('❌ Тикет не найден или уже закрыт.'));

  const modal = new ModalBuilder()
    .setCustomId('ticket_close_modal')
    .setTitle('Закрытие жалобы')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Причина закрытия')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Например: нарушение подтверждено, наказание выдано')
          .setRequired(true)
          .setMaxLength(500)
      )
    );
  await i.showModal(modal);
}

/** Удаляет канал тикета с повторами. Если сети нет — запись остаётся, и канал удалится при следующем запуске. */
async function deleteTicketChannel(chId, reason) {
  try {
    const ch = await withRetry(() => client.channels.fetch(chId));
    await withRetry(() => ch.delete(reason));
  } catch (err) {
    if (err?.code !== 10003) {
      console.error('Не удалось удалить канал тикета (повторю позже):', isNetworkError(err) ? 'нет связи с Discord' : err.message);
      return false;
    }
  }
  const t = ticketDb.tickets[chId];
  if (t) {
    t.deleted = true;
    saveTickets();
  }
  return true;
}

/** При старте: добиваем недоудалённые закрытые тикеты и чистим старые записи. */
async function cleanupTickets() {
  const now = Date.now();
  for (const [chId, t] of Object.entries(ticketDb.tickets)) {
    if (t.status === 'closed' && !t.deleted) await deleteTicketChannel(chId, 'Закрытый тикет (добивание после сбоя)');
    else if (t.status === 'closed' && t.deleted && now - (t.closedAt ?? 0) > 30 * 864e5) delete ticketDb.tickets[chId];
  }
  saveTickets();
}

async function handleTicketCloseSubmit(i) {
  if (!canUseTicket(i.member)) return i.reply(ephemeral('❌ Эта кнопка доступна только администрации.'));
  const chId = i.channelId;
  const ticket = ticketDb.tickets[chId];
  if (!ticket || ticket.status !== 'open') return i.reply(ephemeral('❌ Тикет не найден или уже закрыт.'));
  if (ticketLocks.has(chId)) return i.reply(ephemeral('⏳ Тикет уже закрывается.'));
  ticketLocks.add(chId);
  ticket.status = 'closed'; // сразу, до любых await

  const reason = i.fields.getTextInputValue('reason').trim();
  try {
    ticket.closedBy = i.user.id;
    ticket.closeReason = reason;
    ticket.closedAt = Date.now();
    saveTickets();

    try {
      await withRetry(() =>
        i.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.no)
              .setTitle('🔒 Жалоба закрыта')
              .setDescription(`Закрыл: <@${i.user.id}>\n**Причина:** ${reason}\n\nКанал будет удалён через 10 секунд.`),
          ],
          allowedMentions: { parse: [] },
        })
      );
    } catch (replyErr) {
      // 40060 — ответ уже ушёл при повторной попытке: это не сбой. Иначе возвращаем тикет в работу, чтобы его можно было закрыть снова
      if (replyErr?.code !== 40060) {
        ticket.status = 'open';
        delete ticket.closedBy; delete ticket.closeReason; delete ticket.closedAt;
        saveTickets();
        ticketLocks.delete(chId);
        throw replyErr;
      }
    }

    // ЛС автору жалобы
    const dmOk = await sendDM(ticket.userId, {
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.no)
          .setTitle('🔒 Ваш тикет закрыт')
          .setDescription(
            `Ваш тикет **${ticket.name}** был закрыт администратором <@${i.user.id}> (\`${i.user.id}\`) по причине: ${reason}`
          )
          .setTimestamp(),
      ],
    });

    await ticketLog(
      new EmbedBuilder()
        .setColor(COLORS.no)
        .setTitle(`🔒 Жалоба закрыта — ${ticket.name}`)
        .addFields(
          { name: 'Закрыл', value: `<@${i.user.id}> (\`${i.user.id}\`)`, inline: true },
          { name: 'Автор жалобы', value: `<@${ticket.userId}>`, inline: true },
          { name: 'ЛС автору', value: dmOk ? '✅ доставлено' : '❌ закрыты личные сообщения', inline: true },
          { name: 'Причина', value: reason }
        )
        .setTimestamp()
    );

    setTimeout(() => {
      deleteTicketChannel(chId, `Жалоба закрыта: ${i.user.tag}`).finally(() => ticketLocks.delete(chId));
    }, 10_000);
  } catch (err) {
    console.error('Ошибка закрытия тикета:', err);
    ticketLocks.delete(chId);
  }
}
// =========================================================

// ===================== МОДЕРАЦИЯ =====================
// Сюда пишутся логи наказаний (ID канала). Пусто — логов в канал не будет.
const MOD_LOG_CHANNEL_ID = '';
// Кто может пользоваться командами модерации (кроме администраторов сервера)
const MOD_COMMAND_ROLES = MODERATOR_ROLES;

const DAY = 864e5;
const MAX_TIMEOUT_MS = 28 * DAY - 60_000; // лимит Discord на один тайм-аут; длинные муты продлеваются автоматически
const MAX_PUNISH_MS = 3650 * DAY;

const MOD_TYPES = {
  warn: { label: 'Предупреждение (warn)', emoji: '⚠️', color: 0xfee75c, defaultMs: 30 * DAY },
  pred: { label: 'Выговор (pred)', emoji: '📋', color: 0xe67e22, defaultMs: 30 * DAY },
  mute: { label: 'Мут', emoji: '🔇', color: 0xed4245 },
  ban: { label: 'Бан', emoji: '🔨', color: 0x992d22 },
  kick: { label: 'Кик', emoji: '👢', color: 0xe67e22 },
};

const modStore = makeStore(path.join(DATA_DIR, 'mod.json'), () => ({ counter: 0, cases: {} }), 200);
modStore.data.counter ??= 0;
modStore.data.cases ??= {};
const modCases = modStore.data.cases;

// ---------- Срок наказания ----------
function unitMs(u) {
  if (/^(сек|sec)/.test(u) || u === 's' || u === 'с') return 1e3;
  if (/^(мин|min)/.test(u) || u === 'm' || u === 'м') return 60e3;
  if (/^(час|hour)/.test(u) || u === 'h' || u === 'ч') return 3600e3;
  if (/^(дн|ден|дне|day)/.test(u) || u === 'd' || u === 'д') return DAY;
  if (/^(нед|week)/.test(u) || u === 'w' || u === 'н') return 7 * DAY;
  return null;
}
/** «30м», «12ч», «7д», «2н», «1д12ч», «навсегда» → { ok, ms } (ms = null — бессрочно) */
function parseDuration(input) {
  const s = String(input).trim().toLowerCase().replace(/\s+/g, '');
  if (['навсегда', 'перм', 'перманент', 'perm', 'permanent', '0'].includes(s)) return { ok: true, ms: null };
  const re = /(\d+)([a-zа-я]+)/y;
  let pos = 0;
  let total = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    const mult = m ? unitMs(m[2]) : null;
    if (!m || !mult) return { ok: false };
    total += Number(m[1]) * mult;
    pos = re.lastIndex;
  }
  if (!total || total > MAX_PUNISH_MS) return { ok: false };
  return { ok: true, ms: total };
}
function fmtDuration(ms) {
  if (ms == null) return 'навсегда';
  let s = Math.floor(ms / 1000);
  const parts = [];
  for (const [n, l] of [[86400, 'д'], [3600, 'ч'], [60, 'мин'], [1, 'сек']]) {
    const v = Math.floor(s / n);
    if (v) { parts.push(`${v} ${l}`); s -= v * n; }
  }
  return parts.join(' ') || '0 сек';
}
const ts = (ms, f = 'F') => `<t:${Math.floor(ms / 1000)}:${f}>`;

// ---------- Дела ----------
const activeCases = (userId, type) => Object.values(modCases).filter((c) => c.active && c.userId === userId && (!type || c.type === type));

function createCase({ type, userId, modId, reason, ms }) {
  const id = ++modStore.data.counter;
  const now = Date.now();
  const c = {
    id, type, userId, modId, reason,
    createdAt: now,
    durationMs: ms ?? null,
    expiresAt: ms ? now + ms : null,
    active: type !== 'kick', // кик — разовое действие
  };
  modCases[id] = c;
  modStore.save();
  return c;
}
function closeCase(c, by, why) {
  c.active = false;
  c.endedAt = Date.now();
  if (by) c.endedBy = by;
  if (why) c.endReason = why;
  modStore.save();
}

// ---------- Красивые ЛС ----------
const userRef = (id) => `<@${id}> (\`${client.users.cache.get(id)?.username ?? id}\`)`;
function punishEmbed(c, guild) {
  const t = MOD_TYPES[c.type];
  const e = new EmbedBuilder()
    .setColor(t.color)
    .setTitle(`${t.emoji} Вы получили наказание: ${t.label}`)
    .setDescription(`На сервере **${guild.name}** к вам применена мера.`)
    .addFields(
      { name: '👮 Выдал', value: userRef(c.modId), inline: true },
      { name: '📅 Дата', value: ts(c.createdAt), inline: true },
      { name: '🔢 Дело', value: `#${c.id}`, inline: true },
      { name: '📄 Причина', value: c.reason }
    )
    .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined })
    .setTimestamp();
  if (c.type !== 'kick') {
    e.addFields(
      { name: '⏳ Срок', value: c.durationMs ? fmtDuration(c.durationMs) : 'навсегда', inline: true },
      { name: '🏁 Действует до', value: c.expiresAt ? `${ts(c.expiresAt)} (${ts(c.expiresAt, 'R')})` : 'бессрочно', inline: true }
    );
  }
  if (c.type === 'warn' || c.type === 'pred') {
    e.addFields({ name: `📊 Активных ${c.type === 'warn' ? 'warn' : 'выговоров'}`, value: `${activeCases(c.userId, c.type).length}`, inline: true });
  }
  return e;
}
function endedEmbed(c, guild) {
  const t = MOD_TYPES[c.type];
  return new EmbedBuilder()
    .setColor(COLORS.ok)
    .setTitle('✅ Наказание закончилось')
    .setDescription(`Срок наказания **${t.label}** (дело #${c.id}) на сервере **${guild.name}** истёк. Просим больше не нарушать правила.`)
    .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined })
    .setTimestamp();
}
function liftedEmbed(c, guild, byId, why) {
  const t = MOD_TYPES[c.type];
  return new EmbedBuilder()
    .setColor(COLORS.ok)
    .setTitle('🕊️ Наказание снято досрочно')
    .setDescription(`Наказание **${t.label}** (дело #${c.id}) на сервере **${guild.name}** снято.`)
    .addFields({ name: '👮 Снял', value: userRef(byId), inline: true }, ...(why ? [{ name: '📄 Причина', value: why }] : []))
    .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined })
    .setTimestamp();
}

async function modLog(embed) {
  if (!MOD_LOG_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(MOD_LOG_CHANNEL_ID);
    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('Не удалось записать лог наказания:', err.message);
  }
}
function resultEmbed(c, user, extra = []) {
  const t = MOD_TYPES[c.type];
  const e = new EmbedBuilder()
    .setColor(t.color)
    .setTitle(`${t.emoji} ${t.label} — дело #${c.id}`)
    .addFields(
      { name: '👤 Игрок', value: `<@${user.id}> (\`${user.id}\`)`, inline: true },
      { name: '👮 Модератор', value: `<@${c.modId}>`, inline: true },
      ...(c.type === 'kick' ? [] : [{ name: '⏳ Срок', value: c.durationMs ? `${fmtDuration(c.durationMs)} (до ${ts(c.expiresAt)})` : 'навсегда', inline: true }]),
      { name: '📄 Причина', value: c.reason },
      ...extra
    )
    .setTimestamp();
  return e;
}
const dmField = (ok) => ({ name: '✉️ Уведомление в ЛС', value: ok ? '✅ доставлено' : '❌ у игрока закрыты ЛС', inline: true });

// ---------- Проверки ----------
function canRunMod(i) {
  return !!i.member && (i.memberPermissions?.has(PermissionsBitField.Flags.Administrator) || i.member.roles.cache.some((r) => MOD_COMMAND_ROLES.includes(r.id)));
}
/** Возвращает текст ошибки или null. member — GuildMember цели (если на сервере). */
function checkTarget(i, user, member, { needMember = true } = {}) {
  if (user.id === i.user.id) return '❌ Нельзя применить это к себе.';
  if (user.bot) return '❌ Нельзя применить это к боту.';
  if (user.id === i.guild.ownerId) return '❌ Нельзя применить это к владельцу сервера.';
  if (!member) return needMember ? '❌ Игрок не найден на сервере.' : null;
  if (i.user.id !== i.guild.ownerId && member.roles.highest.position >= i.member.roles.highest.position) {
    return '❌ Высшая роль игрока выше или равна вашей.';
  }
  return null;
}
function readDuration(i, { required = false, def = null } = {}) {
  const raw = i.options.getString('срок');
  if (!raw) {
    if (required) return { error: '❌ Укажите срок, например `30м`, `12ч`, `7д`, `2н` или `навсегда`.' };
    return { ok: true, ms: def };
  }
  const d = parseDuration(raw);
  if (!d.ok) return { error: '❌ Срок указан неверно. Примеры: `30м`, `12ч`, `7д`, `2н`, `1д12ч`, `навсегда`.' };
  return d;
}

// ---------- Команды ----------
const durOpt = (o, req, desc) => o.setName('срок').setDescription(desc ?? 'Например 30м, 12ч, 7д, 2н, 1д12ч или «навсегда»').setRequired(req).setMaxLength(20);
const userOpt = (o) => o.setName('игрок').setDescription('Пинг или ID игрока').setRequired(true);
const reasonOpt = (o, req = true) => o.setName('причина').setDescription('Причина').setRequired(req).setMaxLength(400);
const MOD_COMMANDS = [
  new SlashCommandBuilder().setName('warn').setDescription('Выдать предупреждение')
    .addUserOption(userOpt).addStringOption((o) => reasonOpt(o)).addStringOption((o) => durOpt(o, false, 'Срок (по умолчанию 30д)')),
  new SlashCommandBuilder().setName('unwarn').setDescription('Снять предупреждение')
    .addUserOption(userOpt)
    .addIntegerOption((o) => o.setName('номер').setDescription('Номер дела (по умолчанию — последний активный warn)').setRequired(false).setMinValue(1))
    .addStringOption((o) => reasonOpt(o, false)),
  new SlashCommandBuilder().setName('pred').setDescription('Выдать выговор')
    .addUserOption(userOpt).addStringOption((o) => reasonOpt(o)).addStringOption((o) => durOpt(o, false, 'Срок (по умолчанию 30д)')),
  new SlashCommandBuilder().setName('unpred').setDescription('Снять выговор')
    .addUserOption(userOpt)
    .addIntegerOption((o) => o.setName('номер').setDescription('Номер дела (по умолчанию — последний активный выговор)').setRequired(false).setMinValue(1))
    .addStringOption((o) => reasonOpt(o, false)),
  new SlashCommandBuilder().setName('mute').setDescription('Выдать мут')
    .addUserOption(userOpt).addStringOption((o) => durOpt(o, true)).addStringOption((o) => reasonOpt(o)),
  new SlashCommandBuilder().setName('unmute').setDescription('Снять мут')
    .addUserOption(userOpt).addStringOption((o) => reasonOpt(o, false)),
  new SlashCommandBuilder().setName('kick').setDescription('Выгнать игрока с сервера')
    .addUserOption(userOpt).addStringOption((o) => reasonOpt(o)),
  new SlashCommandBuilder().setName('ban').setDescription('Забанить игрока')
    .addUserOption(userOpt).addStringOption((o) => reasonOpt(o)).addStringOption((o) => durOpt(o, false, 'Срок (пусто — навсегда), например 7д')),
  new SlashCommandBuilder().setName('unban').setDescription('Разбанить игрока')
    .addUserOption(userOpt).addStringOption((o) => reasonOpt(o, false)),
];
commands.push(...MOD_COMMANDS);
const MOD_COMMAND_NAMES = new Set(MOD_COMMANDS.map((c) => c.name));

async function handleModCommand(i) {
  if (!canRunMod(i)) return i.reply(ephemeral('❌ У вас нет прав для использования команд модерации.'));
  const name = i.commandName;
  const user = i.options.getUser('игрок', true);
  const member = i.options.getMember('игрок');
  const reasonRaw = i.options.getString('причина');
  const reason = reasonRaw?.trim() || null;

  // Все проверки — до того, как писать игроку в ЛС, чтобы не уведомить о наказании, которое не удастся применить
  let err = null;
  let dur = { ok: true, ms: null };
  if (name === 'warn' || name === 'pred') {
    err = checkTarget(i, user, member);
    dur = readDuration(i, { def: MOD_TYPES[name].defaultMs });
  } else if (name === 'mute') {
    err = checkTarget(i, user, member);
    dur = readDuration(i, { required: true });
    if (!err && !member.moderatable) err = '❌ Я не могу выдать мут этому игроку (его роль выше моей или нет права «Модерировать участников»).';
  } else if (name === 'kick') {
    err = checkTarget(i, user, member);
    if (!err && !member.kickable) err = '❌ Я не могу кикнуть этого игрока (его роль выше моей или нет права «Выгонять участников»).';
  } else if (name === 'ban') {
    err = checkTarget(i, user, member, { needMember: false });
    dur = readDuration(i, { def: null });
    if (!err && member && !member.bannable) err = '❌ Я не могу забанить этого игрока (его роль выше моей или нет права «Банить участников»).';
  } else if (name === 'unban') {
    if (user.id === i.user.id) err = '❌ Вы не можете разбанить себя.';
  }
  if (!err && dur.error) err = dur.error;
  if (err) return i.reply(ephemeral(err));

  await i.deferReply();
  const guild = i.guild;
  const stamp = (r) => `${r ?? 'без причины'} | ${i.user.tag}`.slice(0, 500);

  try {
    // ---------- warn / pred ----------
    if (name === 'warn' || name === 'pred') {
      const c = createCase({ type: name, userId: user.id, modId: i.user.id, reason, ms: dur.ms });
      const dmOk = await sendDM(user.id, { embeds: [punishEmbed(c, guild)] });
      const e = resultEmbed(c, user, [dmField(dmOk), { name: `📊 Активных ${name === 'warn' ? 'warn' : 'выговоров'}`, value: `${activeCases(user.id, name).length}`, inline: true }]);
      await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
      return modLog(e);
    }

    // ---------- unwarn / unpred ----------
    if (name === 'unwarn' || name === 'unpred') {
      const type = name === 'unwarn' ? 'warn' : 'pred';
      const num = i.options.getInteger('номер');
      let c;
      if (num) {
        c = modCases[num];
        if (!c || c.userId !== user.id || c.type !== type || !c.active) return i.editReply(`❌ Активного дела **#${num}** (${MOD_TYPES[type].label}) у этого игрока нет.`);
      } else {
        c = activeCases(user.id, type).sort((a, b) => b.createdAt - a.createdAt)[0];
        if (!c) return i.editReply(`⚠️ У <@${user.id}> нет активных наказаний этого типа.`);
      }
      closeCase(c, i.user.id, reason);
      const dmOk = await sendDM(user.id, { embeds: [liftedEmbed(c, guild, i.user.id, reason)] });
      const e = new EmbedBuilder()
        .setColor(COLORS.ok)
        .setTitle(`🕊️ Снято: ${MOD_TYPES[type].label} — дело #${c.id}`)
        .addFields(
          { name: '👤 Игрок', value: `<@${user.id}>`, inline: true },
          { name: '👮 Снял', value: `<@${i.user.id}>`, inline: true },
          dmField(dmOk),
          { name: '📊 Осталось активных', value: `${activeCases(user.id, type).length}`, inline: true },
          ...(reason ? [{ name: '📄 Причина', value: reason }] : [])
        )
        .setTimestamp();
      await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
      return modLog(e);
    }

    // ---------- mute ----------
    if (name === 'mute') {
      for (const old of activeCases(user.id, 'mute')) closeCase(old, i.user.id, 'заменён новым мутом');
      const c = createCase({ type: 'mute', userId: user.id, modId: i.user.id, reason, ms: dur.ms });
      const dmOk = await sendDM(user.id, { embeds: [punishEmbed(c, guild)] }); // сначала ЛС…
      try {
        await withRetry(() => member.timeout(Math.min(dur.ms ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS), stamp(reason))); // …потом мут
      } catch (e) {
        delete modCases[c.id];
        modStore.save();
        throw e;
      }
      const e = resultEmbed(c, user, [dmField(dmOk)]);
      await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
      return modLog(e);
    }

    // ---------- unmute ----------
    if (name === 'unmute') {
      const cases = activeCases(user.id, 'mute');
      const timedOut = !!member?.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now();
      if (!cases.length && !timedOut) return i.editReply(`⚠️ У <@${user.id}> нет мута.`);
      if (member && timedOut) {
        if (!member.moderatable) return i.editReply('❌ Я не могу снять мут с этого игрока.');
        await withRetry(() => member.timeout(null, stamp(reason)));
      }
      const c = cases[0] ?? createCase({ type: 'mute', userId: user.id, modId: i.user.id, reason: 'выдан вручную', ms: null });
      for (const x of cases.length ? cases : [c]) closeCase(x, i.user.id, reason);
      const dmOk = await sendDM(user.id, { embeds: [liftedEmbed(c, guild, i.user.id, reason)] });
      const e = new EmbedBuilder()
        .setColor(COLORS.ok)
        .setTitle(`🔊 Мут снят — дело #${c.id}`)
        .addFields({ name: '👤 Игрок', value: `<@${user.id}>`, inline: true }, { name: '👮 Снял', value: `<@${i.user.id}>`, inline: true }, dmField(dmOk), ...(reason ? [{ name: '📄 Причина', value: reason }] : []))
        .setTimestamp();
      await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
      return modLog(e);
    }

    // ---------- kick ----------
    if (name === 'kick') {
      const c = createCase({ type: 'kick', userId: user.id, modId: i.user.id, reason });
      const dmOk = await sendDM(user.id, { embeds: [punishEmbed(c, guild)] }); // сначала ЛС…
      try {
        await withRetry(() => member.kick(stamp(reason))); // …потом кик
      } catch (e) {
        delete modCases[c.id];
        modStore.save();
        throw e;
      }
      const e = resultEmbed(c, user, [dmField(dmOk)]);
      await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
      return modLog(e);
    }

    // ---------- ban ----------
    if (name === 'ban') {
      for (const old of activeCases(user.id, 'ban')) closeCase(old, i.user.id, 'заменён новым баном');
      const c = createCase({ type: 'ban', userId: user.id, modId: i.user.id, reason, ms: dur.ms });
      const dmOk = await sendDM(user.id, { embeds: [punishEmbed(c, guild)] }); // сначала ЛС (после бана написать уже нельзя)…
      try {
        await withRetry(() => guild.members.ban(user.id, { reason: stamp(reason) })); // …потом бан
      } catch (e) {
        delete modCases[c.id];
        modStore.save();
        throw e;
      }
      const e = resultEmbed(c, user, [dmField(dmOk)]);
      await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
      return modLog(e);
    }

    // ---------- unban ----------
    if (name === 'unban') {
      const banned = await withRetry(() => guild.bans.fetch({ user: user.id, force: true })).catch(() => null);
      if (!banned) return i.editReply(`⚠️ <@${user.id}> не забанен.`);
      await withRetry(() => guild.members.unban(user.id, stamp(reason)));
      const cases = activeCases(user.id, 'ban');
      for (const x of cases) closeCase(x, i.user.id, reason);
      const dmOk = cases[0] ? await sendDM(user.id, { embeds: [liftedEmbed(cases[0], guild, i.user.id, reason)] }) : false;
      const e = new EmbedBuilder()
        .setColor(COLORS.ok)
        .setTitle('🔓 Бан снят')
        .addFields({ name: '👤 Игрок', value: `<@${user.id}> (\`${user.id}\`)`, inline: true }, { name: '👮 Снял', value: `<@${i.user.id}>`, inline: true }, dmField(dmOk), ...(reason ? [{ name: '📄 Причина', value: reason }] : []))
        .setTimestamp();
      await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
      return modLog(e);
    }
  } catch (err) {
    console.error(`Ошибка /${name}:`, isNetworkError(err) ? 'нет связи с Discord' : err);
    const text = isNetworkError(err) ? '❌ Нет связи с Discord, попробуйте через минуту.' : `❌ Не удалось выполнить команду: ${err.message}`;
    await i.editReply({ content: text, embeds: [] }).catch(() => {});
  }
}

// ---------- Окончание наказаний (проверка раз в 30 секунд) ----------
async function finishCase(guild, c) {
  try {
    if (c.type === 'mute') {
      const m = guild.members.cache.get(c.userId);
      if (m?.communicationDisabledUntilTimestamp > Date.now() && m.moderatable) await withRetry(() => m.timeout(null, 'Срок мута истёк'));
    } else if (c.type === 'ban') {
      await withRetry(() => guild.members.unban(c.userId, 'Срок бана истёк')).catch((e) => {
        if (e?.code !== 10026) throw e; // 10026 — уже разбанен
      });
    }
  } catch (err) {
    if (isNetworkError(err)) return; // нет сети — дело остаётся активным, повторим в следующую проверку
    console.error(`Не удалось завершить дело #${c.id}:`, err.message);
  }
  closeCase(c, null, 'срок истёк');
  const dmOk = await sendDM(c.userId, { embeds: [endedEmbed(c, guild)] });
  await modLog(
    new EmbedBuilder()
      .setColor(COLORS.ok)
      .setTitle(`✅ Срок закончился — ${MOD_TYPES[c.type].label}, дело #${c.id}`)
      .addFields({ name: '👤 Игрок', value: `<@${c.userId}>`, inline: true }, dmField(dmOk))
      .setTimestamp()
  );
}

/** Длинные муты: Discord даёт максимум 28 дней, поэтому бот продлевает тайм-аут, пока не истечёт срок дела. */
async function maintainMute(guild, c, now) {
  const m = guild.members.cache.get(c.userId);
  if (!m) return;
  const until = m.communicationDisabledUntilTimestamp;
  if (!until || until <= now) {
    if (now - c.createdAt > 30_000) closeCase(c, null, 'мут снят вручную'); // сняли руками — не держим дело активным
    return;
  }
  if (until - now < DAY && (c.expiresAt == null || until < c.expiresAt) && m.moderatable) {
    const target = Math.min(c.expiresAt ?? Infinity, now + MAX_TIMEOUT_MS);
    await withRetry(() => m.timeout(target - now, 'Продление мута')).catch((e) => console.error('Не удалось продлить мут:', e.message));
  }
}

let modTicking = false;
async function modTick() {
  if (modTicking) return;
  modTicking = true;
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    const now = Date.now();
    for (const c of Object.values(modCases)) {
      if (!c.active) continue;
      if (c.expiresAt && c.expiresAt <= now) await finishCase(guild, c);
      else if (c.type === 'mute') await maintainMute(guild, c, now);
    }
  } catch (err) {
    console.error('Ошибка проверки наказаний:', isNetworkError(err) ? 'нет связи с Discord' : err.message);
  } finally {
    modTicking = false;
  }
}

/** Игрок с активным мутом вышел и зашёл снова — возвращаем мут. */
async function reapplyMute(member) {
  const c = activeCases(member.id, 'mute')[0];
  if (!c || (c.expiresAt && c.expiresAt <= Date.now()) || !member.moderatable) return;
  const left = Math.min(c.expiresAt ? c.expiresAt - Date.now() : MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  await withRetry(() => member.timeout(left, `Мут по делу #${c.id} (повторный вход)`)).catch((e) => console.error('Не удалось вернуть мут:', e.message));
}

function pruneModCases() {
  const limit = Date.now() - 365 * DAY;
  for (const [id, c] of Object.entries(modCases)) if (!c.active && (c.endedAt ?? c.createdAt) < limit) delete modCases[id];
  modStore.save();
}
// =========================================================


// ===================== ПРИВАТНЫЕ КОМНАТЫ =====================
// Отдельный модуль privaterooms.js: зашёл в лобби — бот создаёт твой голосовой канал в категории
const PRIVATE_CATEGORY_ID = '1558218636001411214'; // категория, где создаются комнаты
const PRIVATE_LOBBY_ID = '1558219429676847155'; // канал-«лобби»: зайти сюда = создать комнату
const privateRooms = require('./privaterooms')(client, {
  guildId: GUILD_ID,
  categoryId: PRIVATE_CATEGORY_ID,
  lobbyId: PRIVATE_LOBBY_ID,
  store: makeStore(path.join(DATA_DIR, 'private-rooms.json'), () => ({ channels: {} })),
});
// =========================================================

// ===================== БРИФИНГИ =====================
// Отдельный модуль briefing.js: назначение, напоминания, управление войсом, явка, неявки, выговоры
const briefing = require('./briefing')(client, {
  guildId: GUILD_ID,
  store: makeStore(path.join(DATA_DIR, 'briefing.json'), () => ({ phase: 'idle' })),
  colors: COLORS,
  utcOffsetMin: 180, // время брифингов вводится и показывается по МСК (UTC+3)
  ids: {
    setupChannel: '1558223523460153424', // настройка брифинга (панель и кнопки)
    newsChannel: '1553158038825861211', // новости (объявления, напоминания)
    absenceChannel: '1558141619763679262', // неявки
    listsChannel: '1558217396781842432', // списки явки
    briefingVoice: '1558178483744800838', // войс брифинга
    afterVoice: '1555156649017344170', // куда переносить после брифинга
  },
  // Кто управляет брифингами. Личный пользователь НЕ пингуется при появлении кнопок.
  controllerUserIds: ['1440272013028626475'],
  controllerRoleIds: ['1553158349317742653', '1553158717787340971'], // Куратор SWAT, Зам.Куратора SWAT
  // Роли, чья явка учитывается
  attendeeRoleIds: [
    '1553158349317742653', '1553158717787340971', '1558057372478607360', '1558057222905405492',
    '1553180446576349184', '1553183740874727514', '1553180447947890859', '1553180389164716052',
    '1553180332247748628', '1553180126257086514', '1553180207702085822', '1553179974851104878',
    '1553180054589022228', '1553158492389511278', '1553449584779460711',
  ],
  pings: {
    createPred: (userId, modId, reason) => createCase({ type: 'pred', userId, modId, reason, ms: MOD_TYPES.pred.defaultMs }),
    sendDM,
    punishEmbed,
  },
});
// =========================================================

// ===================== СВЕРКА ВЫГОВОРОВ: ИГРА ↔ ДИСКОРД =====================
// Отдельный модуль predsync.js + Lua-скрипт predsync.lua (запускается в игре и шлёт данные из /members)
const predSync = require('./predsync')(client, {
  store: makeStore(path.join(DATA_DIR, 'predsync.json'), () => ({})),
  colors: COLORS,
  port: Number(process.env.SERVER_PORT || process.env.PORT || 4062),
  ids: {
    alertChannel: '1558579646025564310', // оповещения о расхождениях (с кнопками)
    tableChannel: '1558586286137413782', // полная таблица сверки игроков
  },
  controllerUserIds: ['1440272013028626475'],
  controllerRoleIds: ['1553158349317742653', '1553158717787340971'], // Куратор SWAT, Зам.Куратора SWAT — пингуются и могут жать кнопки
  getRegistry: () => Object.keys(nicks).map((id) => [id, getEntry(id)?.nick]),
  countDiscordPreds: (userId) => activeCases(userId, 'pred').length,
});
// =========================================================


// ===================== КАБИНЕТ КУРАТОРА =====================
const curatorCalls = require('./curatorcalls')(client, {
  guildId: GUILD_ID,
  ids: {
    setupChannel: '1559535472374579220',
    officeVoice: '1553160581656223821',
    waitingVoice: '1559535100360654878',
    logChannel: '1559537571292389446',
  },
  controllerRoleIds: ['1553158349317742653', '1553158717787340971', '1558125529943642303'],
  store: makeStore(path.join(DATA_DIR, 'curator-calls.json'), () => ({})),
  sendDM,
  colors: COLORS,
});
commands.push(...curatorCalls.commands);

client.on('error', (err) => console.error('Ошибка клиента:', err));
process.on('unhandledRejection', (err) => console.error('Необработанная ошибка:', isNetworkError(err) ? 'нет связи с Discord' : err));
process.on('uncaughtException', (err) => console.error('Критическая ошибка:', err));

async function start() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('Не найден DISCORD_TOKEN. Добавьте его в файл .env: DISCORD_TOKEN=ваш_токен');
    process.exit(1);
  }
  for (let n = 0; ; n++) {
    try {
      return await client.login(token);
    } catch (err) {
      if (!isNetworkError(err)) {
        console.error('Не удалось войти в Discord:', err.message);
        process.exit(1);
      }
      const wait = Math.min(5000 * 2 ** n, 60_000);
      console.warn(`Нет связи с Discord, повторная попытка входа через ${wait / 1000} с…`);
      await sleep(wait);
    }
  }
}
start();
