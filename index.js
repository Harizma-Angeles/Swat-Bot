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
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store.data, null, 2));
      fs.renameSync(tmp, file); // атомарно: файл не побьётся при сбое
      dirty = false; // при ошибке записи оставляем данные грязными для повторной попытки
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
// Запись реестра: { nick: игровой ник, callsign: кличка (может быть пустой), rank: ранг }
function getEntry(userId) {
  const e = nicks[userId];
  if (!e) return null;
  return typeof e === 'string' ? { nick: e, callsign: '' } : e; // старый формат — просто строка
}
function saveNick(userId, nick, callsign, rank) {
  const prev = getEntry(userId) ?? { nick: '', callsign: '' };
  nicks[userId] = {
    nick: nick ?? prev.nick,
    callsign: callsign !== undefined ? callsign : prev.callsign,
    rank: rank !== undefined ? rank : prev.rank, // ранг на момент заявки (нужен, если одна роль закреплена за несколькими рангами)
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
const GUILD_ID = '1562580237601210518'; // сервер Russia Mafia

// Что включено на этом сервере. Остальные системы включим, когда для них будут готовы каналы и роли.
const FEATURES = {
  roster: true, // «Авторитеты»: список состава по рангам
  tickets: true, // тикеты (жалобы, предложения, вопросы)
  privateRooms: false, // приватные комнаты (пока нет каналов)
  briefing: true, // брифинги
  predSync: false, // сверка выговоров с игрой (пока нет каналов)
  curatorCalls: true, // вызов в кабинет Отца
};

// !!! ВПИШИТЕ ID каналов (правый клик по каналу → «Копировать ID»)
const REQUEST_CHANNEL_ID = '1563657813597618257'; // запросы ролей: канал с кнопкой
const REVIEW_CHANNEL_ID = '1563745203209244672'; // выдача ролей: сюда приходят заявки

// Роли рангов 1–10. В заявке можно выбрать ранги 1–8 (9 и 10 выдаются вручную).
const RANK_ROLES = {
  1: '1563682939781386330',
  2: '1563683197148074115',
  3: '1563683259743867045',
  4: '1563683324658978817',
  5: '1563683393911132200',
  6: '1563684401043480616',
  7: '1563684401043480616', // !!! совпадает с рангом 6 — проверьте ID роли 7-го ранга
  8: '1563684587035426986',
  9: '1563682085749653545',
  10: '1563279028834533457',
};
const MAX_REQUEST_RANK = 8;

const EMPLOYEE_ROLE_ID = '1563681939087556648'; // роль «Сотрудник» — выдаётся всем
const FRIEND_ROLE_ID = '1563681608215568435'; // роль «Друг организации»
const OP_ROLE_ID = '1562580468660965438'; // OP: доверенное лицо, высшая роль (всё доступно, наказания к ней не применяются)
const STAR_ROLE_ID = '1563682596272218232'; // роль «*» (звезда): администратор, ниже OP — доступ ко всем кнопкам
// Кто может нажимать кнопки во всех системах: OP, 9 и 10 ранги, «*»
const BUTTON_ROLES = [...new Set([OP_ROLE_ID, RANK_ROLES[9], RANK_ROLES[10], STAR_ROLE_ID])];

// Лимиты ника на сервере: «Кличка | Ник [ранг]»
const NICK_LIMIT = 32; // лимит Discord
const GAME_NICK_MAX = 20;
const CALLSIGN_MAX = 6;

// Типы запроса роли
const REQUEST_TYPES = {
  MAFIA: { name: 'Russia Mafia', emoji: '🔵', color: 0x4da6ff, hint: 'Ник, ранг (1–8) и кличка' },
  FRIEND: { name: 'Друг организации', emoji: '🟡', color: 0xf1c40f, hint: 'Ник и кто вас пригласил', prefix: 'Friend', roleIds: [EMPLOYEE_ROLE_ID, FRIEND_ROLE_ID] },
};

// Канал приветствий и прощаний (пусто — приветствий нет)
const WELCOME_CHANNEL_ID = '1563655522467454996'; // проходная: приветствия и прощания

// Роль, которая выдаётся каждому новому участнику при заходе (пусто — не выдавать)
const NEWCOMER_ROLE_ID = '';

// Доп. роль: должна быть у каждого, у кого есть любая роль ранга (1–10) — это роль «Сотрудник»
const EXTRA_RANK_ROLE_ID = EMPLOYEE_ROLE_ID;
const isRankRoleId = (id) => Object.values(RANK_ROLES).includes(id);
const hasRankRole = (member) => member.roles.cache.some((r) => isRankRoleId(r.id));

// Список руководителей (пока отключён)
const ROSTER_CHANNEL_ID = '1563656660071751822'; // авторитеты: состав по рангам
const ROSTER_INTERVAL_MS = 10 * 60 * 1000; // каждые 10 минут
const ROSTER_TITLE = 'Авторитеты';

// Кто может нажимать «Выдать роль» / «Отказать» и пользоваться командами модерации
const MODERATOR_ROLES = BUTTON_ROLES;

const COLORS = {
  main: 0x4da6ff, // голубой
  ok: 0x57f287,
  no: 0xed4245,
  warn: 0xfee75c,
};

// ---- Ник «Кличка | Ник [ранг]» (чистые функции) ----
const buildMafiaNick = (callsign, nick, rank) => `${callsign} | ${nick} [${rank}]`;
/** То же, но если не помещается в 32 символа — укорачивает игровой ник (кличка и ранг остаются). */
function fitMafiaNick(callsign, nick, rank) {
  const head = `${callsign} | `;
  const tail = ` [${rank}]`;
  const room = Math.max(1, NICK_LIMIT - head.length - tail.length);
  return head + (nick.length > room ? nick.slice(0, room) : nick) + tail;
}
const buildFriendNick = (nick) => `Friend | ${nick}`.slice(0, NICK_LIMIT);
/** Ранг участника по ролям. Если одна роль закреплена за несколькими рангами — берём сохранённый в реестре. */
function rankFromRoles(member, entry) {
  const have = Object.entries(RANK_ROLES).filter(([, id]) => member.roles.cache.has(id)).map(([r]) => Number(r));
  if (!have.length) return null;
  const sharedOnly = have.length > 1 && new Set(have.map((r) => RANK_ROLES[r])).size === 1;
  if (sharedOnly && entry?.rank && have.includes(Number(entry.rank))) return Number(entry.rank);
  return Math.max(...have);
}
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
        '> 1️⃣ Выберите: **Russia Mafia** или **Друг организации**\n' +
        '> 2️⃣ Заполните форму: для Russia Mafia — ник, ранг (1–8) и кличка; для друга организации — ник и кто вас пригласил\n' +
        '> 3️⃣ Дождитесь решения — результат придёт вам в личные сообщения'
    )
    .setFooter({ text: 'Russia Mafia' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('role_start').setLabel('Начать запрос роли').setStyle(ButtonStyle.Primary).setEmoji('📝')
  );
  return { embeds: [embed], components: [row] };
}

async function ensurePanel() {
  if (!REQUEST_CHANNEL_ID) return console.error('Не указан REQUEST_CHANNEL_ID — впишите ID канала запроса ролей в index.js.');
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
    .addStringOption((o) => o.setName('ник').setDescription('Игровой ник, например Nick_Name').setRequired(true).setMaxLength(40))
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

// ---------- Авторитеты: весь состав по рангам (10 → 1) ----------
/** Блоки «ранг → участники». Ранг участника определяется по ролям (если роль общая у нескольких рангов — по реестру). */
function rosterBlocks(guild) {
  const byRank = new Map();
  for (let r = 10; r >= 1; r--) byRank.set(r, []);
  for (const m of guild.members.cache.values()) {
    if (m.user.bot) continue;
    const r = rankFromRoles(m, getEntry(m.id));
    if (r && byRank.has(r)) byRank.get(r).push(m);
  }
  const blocks = [];
  for (const [rank, members] of byRank) {
    members.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
    blocks.push({
      title: `${rank} ранг`,
      count: members.length,
      lines: members.length ? members.map((m) => `<@${m.id}> — \`${getEntry(m.id)?.nick || m.displayName}\``) : ['*На данном ранге никого нет.*'],
    });
  }
  return blocks;
}

/** Режет блоки на страницы, чтобы каждая влезала в описание embed (лимит Discord 4096 символов). */
function rosterPages(guild) {
  const LIMIT = 3800;
  const pages = [];
  let cur = '';
  const flush = () => { if (cur) pages.push(cur); cur = ''; };
  for (const b of rosterBlocks(guild)) {
    const head = `### ${b.title}${b.count ? ` — ${b.count}` : ''}`;
    if (cur && cur.length + head.length + b.lines[0].length + 4 > LIMIT) flush();
    cur += (cur ? '\n\n' : '') + head;
    for (const line of b.lines) {
      if (cur.length + line.length + 1 > LIMIT) {
        flush();
        cur = `### ${b.title} (продолжение)`;
      }
      cur += '\n' + line;
    }
  }
  flush();
  return pages;
}

let rosterRunning = false;
let rosterLastKey = '';
let rosterLastAt = 0;
async function updateRoster() {
  if (!FEATURES.roster || !ROSTER_CHANNEL_ID) return;
  if (rosterRunning) return;
  rosterRunning = true;
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    const channel = await client.channels.fetch(ROSTER_CHANNEL_ID).catch(() => null);
    if (!channel) return console.error('Канал «Авторитеты» не найден!');

    await loadMembers(guild);

    const pages = rosterPages(guild);
    const key = pages.join('\u0000');
    // Ничего не изменилось — не трогаем Discord (раз в час всё равно проверяем, что сообщения на месте)
    if (key === rosterLastKey && Date.now() - rosterLastAt < 60 * 60 * 1000) return;

    const embeds = pages.map((text, k) => {
      const e = new EmbedBuilder()
        .setColor(COLORS.main)
        .setTitle(pages.length > 1 ? `${ROSTER_TITLE} (${k + 1}/${pages.length})` : ROSTER_TITLE)
        .setDescription(text);
      if (k === pages.length - 1) e.setFooter({ text: 'Список обновляется автоматически' }).setTimestamp();
      return e;
    });

    // Наши прежние сообщения списка — по порядку; лишние удаляем, недостающие добавляем
    const messages = await withRetry(() => channel.messages.fetch({ limit: 50 }));
    const mine = [...messages.values()]
      .filter((m) => m.author.id === client.user.id && m.embeds[0]?.title?.startsWith(ROSTER_TITLE))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (let k = 0; k < embeds.length; k++) {
      const payload = { embeds: [embeds[k]], allowedMentions: { parse: [] } };
      if (mine[k]) await withRetry(() => mine[k].edit(payload));
      else await withRetry(() => channel.send(payload));
    }
    for (const extra of mine.slice(embeds.length)) await extra.delete().catch(() => {});

    rosterLastKey = key;
    rosterLastAt = Date.now();
  } catch (err) {
    console.error('Не удалось обновить «Авторитеты»:', isNetworkError(err) ? 'нет связи с Discord' : err.message);
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

/** Тип участника по ролям: MAFIA (есть роль ранга), FRIEND (друг организации) или null. */
function memberKind(member) {
  if (hasRankRole(member)) return 'MAFIA';
  if (member.roles.cache.has(FRIEND_ROLE_ID)) return 'FRIEND';
  return null;
}
const nickPrefix = memberKind; // старое имя: «есть ли у участника статус, по которому строится ник»

// Ник уже «по форме»: «Кличка | Ник [ранг]» или «Friend | Ник»
const MAFIA_NICK_RE = /^(.{1,6}?)\s*\|\s*(.+?)\s*\[(\d{1,2})\]\s*$/;
const FRIEND_NICK_RE = /^Friend\s*\|\s*(.+)$/i;

/** Если игрока нет в реестре, но его ник на сервере уже по форме — записываем ник, кличку и ранг в реестр. */
function adoptFromNick(member) {
  if (member.user.bot || getEntry(member.id) || !member.nickname) return false;
  try {
    const m = member.nickname.match(MAFIA_NICK_RE);
    if (m) {
      saveNick(member.id, m[2].trim().slice(0, 40), m[1].trim(), Number(m[3]));
      return true;
    }
    const f = member.nickname.match(FRIEND_NICK_RE);
    if (f) {
      saveNick(member.id, f[1].trim().slice(0, 40), '', null);
      return true;
    }
    return false;
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

/** Приводит серверный ник игрока из реестра к форме «Кличка | Ник [ранг]» (или «Friend | Ник») по его ролям. */
async function syncMemberNick(member) {
  if (member.user.bot) return 'skip';
  const entry = getEntry(member.id);
  if (!entry?.nick) return 'no-nick';

  const kind = memberKind(member);
  if (!kind) return 'no-dept'; // нет роли ранга и «Друга организации» — ник не трогаем
  let target;
  if (kind === 'FRIEND') {
    target = buildFriendNick(entry.nick);
  } else {
    const rank = rankFromRoles(member, entry);
    if (!entry.callsign || !rank) return 'no-nick'; // для ника нужна кличка
    target = fitMafiaNick(entry.callsign, entry.nick, rank);
  }
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
  console.log('Версия: roles-MSU-briefing-recovery-v1 | index:', __filename, '| data:', DATA_DIR, '| pid:', process.pid);
  console.log('Сервер:', GUILD_ID, '| включено:', Object.entries(FEATURES).filter(([, v]) => v).map(([k]) => k).join(', ') || 'запросы ролей, ники, модерация');
  for (const guild of client.guilds.cache.values()) {
    if (guild.id !== GUILD_ID) await refuseGuild(guild);
  }
  const mainGuild = client.guilds.cache.get(GUILD_ID);
  if (mainGuild) await registerCommands(mainGuild);
  if (mainGuild) await loadMembers(mainGuild); // один раз загружаем участников, дальше всё берётся из кэша
  if (FEATURES.roster) setInterval(updateRoster, ROSTER_INTERVAL_MS);
  setInterval(syncAllNicks, SYNC_INTERVAL_MS);
  setInterval(modTick, 30_000);
  setInterval(() => { const n = Date.now(); for (const [k, v] of pendingDeny) if (v.until < n) pendingDeny.delete(k); }, 10 * 60 * 1000).unref?.();
  pruneModCases();
  const logFails = (label, results) => results.forEach((r) => r.status === 'rejected' && console.error(`Ошибка при старте (${label}):`, isNetworkError(r.reason) ? 'нет связи с Discord' : r.reason?.message ?? r.reason));
  logFails('панели', await Promise.allSettled([ensurePanel(), FEATURES.tickets && ensureTicketPanel(), FEATURES.roster && updateRoster()]));
  logFails('проверки', await Promise.allSettled([syncAllNicks(), modTick(), FEATURES.tickets && cleanupTickets(), FEATURES.privateRooms && privateRooms.init(), FEATURES.briefing && briefing.init(), FEATURES.predSync && predSync.init(), FEATURES.curatorCalls && curatorCalls.init()]));
});

client.on('guildCreate', async (guild) => {
  if (guild.id !== GUILD_ID) return refuseGuild(guild);
  await registerCommands(guild);
  await ensurePanel();
  if (FEATURES.tickets) await ensureTicketPanel();
});

// ---------- Новый участник ----------
async function sendWelcomeChannel(guild, payload) {
  if (!WELCOME_CHANNEL_ID) return;
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
    if (NEWCOMER_ROLE_ID) await member.roles.add(NEWCOMER_ROLE_ID, 'Автороль новому участнику');
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

const ROSTER_ROLE_IDS = new Set(Object.values(RANK_ROLES));
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
  if (member.guild.id === GUILD_ID && member.roles?.cache && hasRankRole(member)) scheduleRoster(); // ушёл участник с рангом — обновляем «Авторитеты»
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

    // Вызовы в кабинет Отца
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
          { name: `📝 Нет ника или клички в реестре (${groups['no-nick'].length})`, value: list(groups['no-nick']) },
          { name: `🏢 Нет роли ранга и «Друга организации» (${groups['no-dept'].length})`, value: list(groups['no-dept']) },
          { name: `🔒 Бот не может менять ник (${groups.forbidden.length + groups.error.length})`, value: list([...groups.forbidden, ...groups.error]) },
          { name: `🚪 Нет на сервере (${groups.left.length})`, value: list(groups.left) },
          {
            name: `👥 Не в реестре, но с ролью ранга/«Друга организации» (${unregRoles.length})`,
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

    // Тикеты
    if (i.isButton() && i.customId.startsWith('ticket_open')) return await showTicketModal(i);
    if (i.isModalSubmit() && i.customId.startsWith('ticket_modal')) return await handleTicketSubmit(i);
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


// Коды старых форм (отделы прежнего сервера) больше не поддерживаются — просим открыть форму заново.
function resolveRoleRequestType(raw) {
  const upper = String(raw ?? '').trim().toUpperCase();
  return Object.hasOwn(REQUEST_TYPES, upper) ? upper : null;
}
function unknownDepartment(i, raw) {
  console.warn('Неизвестный тип заявки:', String(raw).slice(0, 100), '| файл:', __filename);
  return i.reply(ephemeral('❌ Эта форма заявки устарела. Нажмите «Начать запрос роли» заново.'));
}

// ---------- Шаг 1: выбор — Russia Mafia или Друг организации ----------
async function showDepartmentSelect(i) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('role_dept')
    .setPlaceholder('Выберите, кто вы')
    .addOptions(Object.entries(REQUEST_TYPES).map(([key, t]) => ({ label: t.name, value: key, emoji: t.emoji, description: t.hint })));
  await i.reply({
    content: '**Выберите, кем вы являетесь:**',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

// ---------- Шаг 2: форма ----------
async function showRequestModal(i) {
  const type = resolveRoleRequestType(i.values[0]);
  if (!type) return unknownDepartment(i, i.values[0]);
  const modal = new ModalBuilder().setCustomId(`role_modal:${type}`).setTitle(`Запрос: ${REQUEST_TYPES[type].name}`);

  const nick = new TextInputBuilder()
    .setCustomId('nick')
    .setLabel(`Никнейм (до ${GAME_NICK_MAX} символов)`)
    .setPlaceholder('Itachi_Takatsuki')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(GAME_NICK_MAX)
    .setRequired(true);

  if (type === 'FRIEND') {
    const who = new TextInputBuilder()
      .setCustomId('who')
      .setLabel('Кем вы являетесь / кто вас пригласил?')
      .setPlaceholder('Например: друг Itachi_Takatsuki, он меня пригласил')
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(2)
      .setMaxLength(500)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(nick), new ActionRowBuilder().addComponents(who));
    return await i.showModal(modal);
  }

  const rank = new TextInputBuilder()
    .setCustomId('rank')
    .setLabel(`Ранг (цифра от 1 до ${MAX_REQUEST_RANK})`)
    .setPlaceholder('5')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(1)
    .setRequired(true);
  const callsign = new TextInputBuilder()
    .setCustomId('callsign')
    .setLabel(`Кличка (до ${CALLSIGN_MAX} символов)`)
    .setPlaceholder('Гром')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(CALLSIGN_MAX)
    .setRequired(true);
  modal.addComponents(
    new ActionRowBuilder().addComponents(nick),
    new ActionRowBuilder().addComponents(rank),
    new ActionRowBuilder().addComponents(callsign)
  );
  await i.showModal(modal);
}

// ---------- Шаг 3: приём заявки ----------
async function sendRequestToReview(i, embed, approveId) {
  const reviewChannel = REVIEW_CHANNEL_ID ? await withRetry(() => client.channels.fetch(REVIEW_CHANNEL_ID), { tries: 3 }).catch(() => null) : null;
  if (!reviewChannel) {
    await i.editReply('❌ Канал заявок недоступен. Сообщите администрации.');
    return false;
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(approveId).setLabel('Выдать роль').setStyle(ButtonStyle.Success).setEmoji('✅'),
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
  return true;
}

async function handleRequestSubmit(i) {
  const type = resolveRoleRequestType(i.customId.split(':')[1]);
  if (!type) return unknownDepartment(i, i.customId);
  const nick = i.fields.getTextInputValue('nick').trim();
  if (!nick) return i.reply(ephemeral('❌ Никнейм не может быть пустым.'));
  if (nick.length > GAME_NICK_MAX) return i.reply(ephemeral(`❌ Никнейм слишком длинный (максимум ${GAME_NICK_MAX} символов).`));

  // ---- Друг организации: ник + «кем являетесь / кто пригласил» ----
  if (type === 'FRIEND') {
    const who = i.fields.getTextInputValue('who').trim();
    if (!who) return i.reply(ephemeral('❌ Напишите, кем вы являетесь или кто вас пригласил.'));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const t = REQUEST_TYPES.FRIEND;
    const embed = new EmbedBuilder()
      .setColor(t.color)
      .setTitle(buildFriendNick(nick))
      .setThumbnail(i.user.displayAvatarURL())
      .addFields(
        { name: `${t.emoji} Статус`, value: t.name, inline: true },
        { name: '🎮 Ник', value: nick, inline: true },
        { name: '👤 Заявитель', value: `<@${i.user.id}>`, inline: true },
        { name: '❓ Кем является / кто пригласил', value: who.slice(0, 1024) },
        { name: '🎖️ Роли к выдаче', value: t.roleIds.map((id) => `<@&${id}>`).join('\n') }
      )
      .setFooter({ text: 'Статус: ожидает рассмотрения' })
      .setTimestamp();
    await sendRequestToReview(i, embed, `approve:${i.user.id}:FRIEND:0`);
    return;
  }

  // ---- Russia Mafia: ник + ранг + кличка ----
  const rank = i.fields.getTextInputValue('rank').trim();
  const callsign = i.fields.getTextInputValue('callsign').trim();
  if (!new RegExp(`^[1-${MAX_REQUEST_RANK}]$`).test(rank)) {
    return i.reply(ephemeral(`❌ **Ранг указан неверно!** Нужна ровно одна цифра от 1 до ${MAX_REQUEST_RANK}, без букв и других символов. Попробуйте снова.`));
  }
  if (!callsign) return i.reply(ephemeral('❌ Кличка не может быть пустой.'));
  if (callsign.length > CALLSIGN_MAX) return i.reply(ephemeral(`❌ Кличка слишком длинная (максимум ${CALLSIGN_MAX} символов).`));
  const preview = buildMafiaNick(callsign, nick, rank);
  if (preview.length > NICK_LIMIT) {
    return i.reply(ephemeral(`❌ Итоговый ник «${preview}» — ${preview.length} символов, а лимит Discord ${NICK_LIMIT}. Сократите кличку или ник минимум на ${preview.length - NICK_LIMIT}.`));
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const t = REQUEST_TYPES.MAFIA;
  const rankRoleId = RANK_ROLES[rank];
  const embed = new EmbedBuilder()
    .setColor(t.color)
    .setTitle(preview)
    .setThumbnail(i.user.displayAvatarURL())
    .addFields(
      { name: `${t.emoji} Статус`, value: t.name, inline: true },
      { name: '🎮 Ник', value: nick, inline: true },
      { name: '🪪 Кличка', value: callsign, inline: true },
      { name: '🎖️ Ранг', value: rank, inline: true },
      { name: '👤 Заявитель', value: `<@${i.user.id}>`, inline: true },
      { name: '🎖️ Роли к выдаче', value: `<@&${EMPLOYEE_ROLE_ID}>\n<@&${rankRoleId}>` }
    )
    .setFooter({ text: 'Статус: ожидает рассмотрения' })
    .setTimestamp();
  await sendRequestToReview(i, embed, `approve:${i.user.id}:MAFIA:${rank}`);
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

  const [, userId, rawType, rank] = i.customId.split(':');
  const dept = resolveRoleRequestType(rawType);
  const isFriend = dept === 'FRIEND';
  if (!dept || (!isFriend && !(Number(rank) >= 1 && Number(rank) <= MAX_REQUEST_RANK && RANK_ROLES[rank]))) {
    processing.delete(msgId);
    return unknownDepartment(i, rawType);
  }

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

    // Убираем прежние роли ранга/друга/новичка, затем выдаём новые
    const keep = isFriend ? [...REQUEST_TYPES.FRIEND.roleIds] : [EMPLOYEE_ROLE_ID, RANK_ROLES[rank]];
    const toRemove = [...new Set([NEWCOMER_ROLE_ID, ...Object.values(RANK_ROLES), FRIEND_ROLE_ID].filter(Boolean))].filter(
      (id) => !keep.includes(id) && member.roles.cache.has(id)
    );
    if (toRemove.length) await member.roles.remove(toRemove, `Смена роли по заявке: ${i.user.tag}`);
    await member.roles.add(keep, `Заявка одобрена: ${i.user.tag}`);

    // Игровой ник и кличка из заявки
    const field = (part) => (i.message.embeds[0]?.fields?.find((f) => f.name.includes(part))?.value ?? '').trim();
    const gameNick = field('Ник');
    const callsign = isFriend ? '' : field('Кличка');

    // Ник на сервере: «Кличка | Ник [ранг]» или «Friend | Ник»
    const newNick = isFriend ? buildFriendNick(gameNick) : fitMafiaNick(callsign, gameNick, rank);
    let nickOk = true;
    try {
      await member.setNickname(newNick, `Заявка одобрена: ${i.user.tag}`);
    } catch (err) {
      nickOk = false;
      console.error('Не удалось сменить ник:', err.message);
    }

    // Запоминаем ник, кличку и ранг в реестре
    if (gameNick) {
      try {
        saveNick(userId, gameNick, callsign, isFriend ? null : Number(rank));
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

// ===================== ТИКЕТЫ =====================
const TICKET_PANEL_CHANNEL_ID = '1563661934547439757'; // тикеты: канал с кнопками
const TICKET_CATEGORY_ID = '1563668635719958629'; // раздел, где создаются тикеты
const TICKET_LOG_CHANNEL_ID = '1563662242413678593'; // канал уведомлений: логи тикетов
const TICKET_STAFF_ROLES = [OP_ROLE_ID, RANK_ROLES[9], RANK_ROLES[10]]; // пингуются и работают с кнопками
const TICKET_EXTRA_ID = STAR_ROLE_ID; // роль «*» тоже работает с тикетами (не пингуется)

const ticketStore = makeStore(path.join(DATA_DIR, 'tickets.json'), () => ({ counter: 0, tickets: {} }));
const ticketDb = ticketStore.data;
ticketDb.tickets ??= {};
ticketDb.counter ??= 0;
const saveTickets = () => ticketStore.saveNow(); // номера и статусы тикетов пишем сразу

const ticketLocks = new Set(); // id каналов, чьи кнопки уже нажаты и обрабатываются

const canUseTicket = (member) =>
  !!member && (member.id === TICKET_EXTRA_ID || member.roles.cache.some((r) => TICKET_STAFF_ROLES.includes(r.id) || r.id === TICKET_EXTRA_ID));

// Типы тикетов. Для каждого — своя форма; канал тикета называется ticket-<slug>-0001
const TICKET_TYPES = {
  complaint: { label: 'Жалоба на игрока', emoji: '🚨', slug: 'player', style: ButtonStyle.Danger, color: COLORS.warn },
  suggestion: { label: 'Предложение', emoji: '💡', slug: 'idea', style: ButtonStyle.Success, color: COLORS.ok },
  question: { label: 'Вопрос', emoji: '❓', slug: 'question', style: ButtonStyle.Primary, color: COLORS.main },
};
const ticketTypeOf = (key) => TICKET_TYPES[key] ?? TICKET_TYPES.complaint;

function ticketPanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(COLORS.main)
    .setTitle('🎫 ТИКЕТЫ')
    .setDescription(
      'Нужна помощь администрации? Выберите тип обращения кнопкой ниже.\n\n' +
        '**Типы тикетов:**\n' +
        '> 🚨 **Жалоба на игрока** — нарушение правил (нужна ссылка на видео-доказательство)\n' +
        '> 💡 **Предложение** — идея, как улучшить организацию или сервер\n' +
        '> ❓ **Вопрос** — вопрос к администрации\n\n' +
        '**Как это работает:**\n' +
        '> 1️⃣ Нажмите кнопку нужного типа\n' +
        '> 2️⃣ Заполните форму\n' +
        '> 3️⃣ Бот создаст отдельный тикет, где ваше обращение рассмотрит администрация\n' +
        '> 4️⃣ О закрытии тикета вы получите уведомление в личные сообщения'
    )
    .setFooter({ text: 'Russia Mafia • Тикеты' });
  const row = new ActionRowBuilder().addComponents(
    ...Object.entries(TICKET_TYPES).map(([key, t]) =>
      new ButtonBuilder().setCustomId(`ticket_open:${key}`).setLabel(t.label).setStyle(t.style).setEmoji(t.emoji)
    )
  );
  return { embeds: [embed], components: [row] };
}

async function ensureTicketPanel() {
  if (!FEATURES.tickets) return;
  const channel = await client.channels.fetch(TICKET_PANEL_CHANNEL_ID).catch(() => null);
  if (!channel) return console.error('Канал тикетов не найден!');
  const messages = await withRetry(() => channel.messages.fetch({ limit: 30 })).catch(() => null);
  if (!messages) return console.error('Не удалось проверить панель тикетов (нет связи) — новую не создаю, чтобы не было дублей.');
  const existing = messages.find(
    (m) => m.author.id === client.user.id && m.components.some((r) => r.components.some((c) => String(c.customId).startsWith('ticket_open')))
  );
  if (!existing) {
    await withRetry(() => channel.send(ticketPanelPayload()));
    console.log('Панель тикетов отправлена.');
  } else if (existing.embeds[0]?.title !== '🎫 ТИКЕТЫ') {
    await withRetry(() => existing.edit(ticketPanelPayload())); // старая панель с одной кнопкой «Подать жалобу» → новая с типами
    console.log('Панель тикетов обновлена.');
  }
}

async function ticketLog(embed) {
  try {
    const ch = await client.channels.fetch(TICKET_LOG_CHANNEL_ID);
    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('Не удалось записать лог тикета:', err.message);
  }
}

const ticketName = (n, type = 'complaint') => `ticket-${ticketTypeOf(type).slug}-${String(n).padStart(4, '0')}`;

// Шаг 1: кнопка → форма (своя для каждого типа)
async function showTicketModal(i) {
  const type = TICKET_TYPES[i.customId.split(':')[1]] ? i.customId.split(':')[1] : 'complaint';
  const field = (id, label, style, placeholder, max) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setPlaceholder(placeholder).setRequired(true).setMaxLength(max)
    );
  const rows =
    type === 'complaint'
      ? [
          field('initiator', 'Инициатор наказания', TextInputStyle.Short, 'Nick_Name', 40),
          field('violator', 'Нарушитель', TextInputStyle.Short, 'Nick_Name', 40),
          field('essence', 'Суть нарушения', TextInputStyle.Paragraph, 'Опишите, что произошло', 1000),
          field('evidence', 'Доказательство (ссылка на видео)', TextInputStyle.Short, 'https://youtube.com/...', 300),
        ]
      : type === 'suggestion'
        ? [
            field('topic', 'Тема предложения', TextInputStyle.Short, 'Коротко, о чём идея', 100),
            field('essence', 'Ваше предложение', TextInputStyle.Paragraph, 'Опишите идею подробно', 1500),
          ]
        : [
            field('topic', 'Тема вопроса', TextInputStyle.Short, 'Коротко, о чём вопрос', 100),
            field('essence', 'Ваш вопрос', TextInputStyle.Paragraph, 'Опишите вопрос подробно', 1500),
          ];
  const modal = new ModalBuilder().setCustomId(`ticket_modal:${type}`).setTitle(ticketTypeOf(type).label).addComponents(...rows);
  await i.showModal(modal);
}

/** Поля тикета (для embed в канале тикета и для лога) — разные для разных типов. */
function ticketContentFields(type, d, authorId) {
  const author = { name: '👤 Автор', value: `<@${authorId}>`, inline: true };
  if (type === 'complaint') {
    return [
      { name: '👮 Инициатор наказания', value: `\`${d.initiator}\``, inline: true },
      { name: '⚠️ Нарушитель', value: `\`${d.violator}\``, inline: true },
      author,
      { name: '📝 Суть нарушения', value: d.essence },
      { name: '🎥 Доказательство', value: d.evidence },
    ];
  }
  return [author, { name: '📌 Тема', value: d.topic, inline: true }, { name: type === 'suggestion' ? '💡 Предложение' : '❓ Вопрос', value: d.essence }];
}

// Шаг 2: создание тикета
async function handleTicketSubmit(i) {
  const type = TICKET_TYPES[i.customId.split(':')[1]] ? i.customId.split(':')[1] : 'complaint';
  const T = ticketTypeOf(type);
  const val = (id) => i.fields.getTextInputValue(id).trim();
  const d =
    type === 'complaint'
      ? { initiator: val('initiator'), violator: val('violator'), essence: val('essence'), evidence: val('evidence') }
      : { topic: val('topic'), essence: val('essence') };

  if (type === 'complaint' && !/^https?:\/\/\S+$/i.test(d.evidence)) {
    return i.reply(ephemeral('❌ В поле «Доказательство» нужна ссылка на видео (начинается с http:// или https://). Попробуйте снова.'));
  }

  // Один открытый тикет на игрока (если канал удалили вручную — запись считается закрытой)
  for (const [chId, t] of Object.entries(ticketDb.tickets)) {
    if (t.userId !== i.user.id || t.status !== 'open') continue;
    if (i.guild.channels.cache.has(chId)) {
      return i.reply(ephemeral(`❌ У вас уже есть открытый тикет: <#${chId}>. Дождитесь его рассмотрения.`));
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
  const name = ticketName(number, type);

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
      topic: `${T.label} #${String(number).padStart(4, '0')} • автор: ${i.user.id}`,
      permissionOverwrites: overwrites,
      reason: `${T.label} от ${i.user.tag}`,
    });

    ticketDb.tickets[channel.id] = {
      number,
      name,
      type,
      userId: i.user.id,
      claimedBy: null,
      status: 'open',
      createdAt: Date.now(),
    };
    saveTickets();

    const embed = new EmbedBuilder()
      .setColor(T.color)
      .setTitle(`${T.emoji} ${T.label} — ${name}`)
      .setThumbnail(i.user.displayAvatarURL())
      .addFields(...ticketContentFields(type, d, i.user.id), { name: '📌 Статус', value: '⏳ Ожидает рассмотрения' })
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

    await i.editReply(`✅ Тикет создан: <#${channel.id}>`);

    await ticketLog(
      new EmbedBuilder()
        .setColor(T.color)
        .setTitle(`📨 Новый тикет (${T.label}) — ${name}`)
        .addFields({ name: 'Канал', value: `<#${channel.id}>`, inline: true }, ...ticketContentFields(type, d, i.user.id))
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
    return i.reply({ ...ephemeral(`⏳ Тикет уже взял ${who}.`), allowedMentions: { parse: [] } });
  }
  ticketLocks.add(chId);
  ticket.claimedBy = i.user.id;
  try {
    saveTickets();
    const old = i.message.embeds[0];
    const embed = EmbedBuilder.from(old)
      .setColor(COLORS.main)
      .setFooter({ text: 'Тикет взят в работу' });
    const fields = (old.fields ?? []).map((f) => (f.name.includes('Статус') ? { ...f, value: `🔧 В работе — <@${i.user.id}>` } : f));
    embed.setFields(fields);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_close').setLabel('Закрыть').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );
    await i.update({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });

    await ticketLog(
      new EmbedBuilder()
        .setColor(COLORS.main)
        .setTitle(`✋ Тикет взят — ${ticket.name}`)
        .addFields(
          { name: 'Взял', value: `<@${i.user.id}> (\`${i.user.id}\`)`, inline: true },
          { name: 'Канал', value: `<#${chId}>`, inline: true }
        )
        .setTimestamp()
    );
  } catch (err) {
    // откат, чтобы тикет можно было взять снова
    ticket.claimedBy = null;
    try { saveTickets(); } catch {}
    console.error('Ошибка при взятии тикета:', err);
    if (!i.replied && !i.deferred) i.reply(ephemeral('❌ Не удалось взять тикет. Попробуйте ещё раз.')).catch(() => {});
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
    .setTitle('Закрытие тикета')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Причина закрытия')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Например: вопрос решён / предложение рассмотрено / наказание выдано')
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
  if (!FEATURES.tickets) return;
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
              .setTitle('🔒 Тикет закрыт')
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

    // ЛС автору тикета
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
        .setTitle(`🔒 Тикет закрыт — ${ticket.name}`)
        .addFields(
          { name: 'Закрыл', value: `<@${i.user.id}> (\`${i.user.id}\`)`, inline: true },
          { name: 'Автор', value: `<@${ticket.userId}>`, inline: true },
          { name: 'ЛС автору', value: dmOk ? '✅ доставлено' : '❌ закрыты личные сообщения', inline: true },
          { name: 'Причина', value: reason }
        )
        .setTimestamp()
    );

    setTimeout(() => {
      deleteTicketChannel(chId, `Тикет закрыт: ${i.user.tag}`).finally(() => ticketLocks.delete(chId));
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
const MOD_COMMAND_ROLES = [OP_ROLE_ID]; // команды модерации — как раньше, только OP (кнопки — см. BUTTON_ROLES)

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
  if (member.roles.cache.has(OP_ROLE_ID)) return '❌ Это доверенное лицо (OP) — наказания к нему не применяются.';
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
const PRIVATE_CATEGORY_ID = ''; // !!! категория, где создаются комнаты (нужно для FEATURES.privateRooms)
const PRIVATE_LOBBY_ID = ''; // !!! канал-«лобби»: зайти сюда = создать комнату (нужно для FEATURES.privateRooms)
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
    setupChannel: '1563746639036948653', // настройка брифинга (панель и кнопки)
    newsChannel: '1563657379256471643', // новости (объявления, напоминания)
    absenceChannel: '1563747559753912400', // неявки
    listsChannel: '1563747403700633720', // логи брифинга: кто когда зашёл, списки явки
    briefingVoice: '1563746902988558377', // основной войс брифинга
    afterVoice: '', // !!! куда переносить после брифинга. Пусто — люди остаются на месте; вставьте ID войса, чтобы переносило
  },
  // Кто управляет брифингами. Личный пользователь НЕ пингуется при появлении кнопок.
  controllerUserIds: [],
  controllerRoleIds: BUTTON_ROLES, // OP, 9 и 10 ранги, «*»
  // Роли, чья явка учитывается: все ранги 1–10
  attendeeRoleIds: [...new Set(Object.values(RANK_ROLES))],
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
    alertChannel: '', // !!! оповещения о расхождениях (нужно для FEATURES.predSync)
    tableChannel: '', // !!! полная таблица сверки игроков (нужно для FEATURES.predSync)
  },
  controllerUserIds: [],
  controllerRoleIds: BUTTON_ROLES, // OP, 9 и 10 ранги, «*» — пингуются и могут жать кнопки
  getRegistry: () => Object.keys(nicks).map((id) => [id, getEntry(id)?.nick]),
  countDiscordPreds: (userId) => activeCases(userId, 'pred').length,
});
// =========================================================


// ===================== КАБИНЕТ ОТЦА =====================
const curatorCalls = require('./curatorcalls')(client, {
  guildId: GUILD_ID,
  ids: {
    setupChannel: '1563680137298321539', // настройка кабинета Отца
    officeVoice: '1563679827863543868', // кабинет Отца (войс)
    waitingVoice: '1563679791331152012', // ожидание (войс)
    logChannel: '1563680165928771637', // лог кабинета Отца
  },
  controllerRoleIds: BUTTON_ROLES, // OP, 9 и 10 ранги, «*»
  store: makeStore(path.join(DATA_DIR, 'curator-calls.json'), () => ({})),
  sendDM,
  colors: COLORS,
});
if (FEATURES.curatorCalls) commands.push(...curatorCalls.commands);

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
