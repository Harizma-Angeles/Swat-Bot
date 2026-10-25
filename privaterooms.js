// ===================== ПРИВАТНЫЕ КОМНАТЫ =====================
// Заходишь в канал-«лобби» → бот создаёт для тебя голосовой канал в категории, называет его твоим ником
// в Discord, даёт тебе права на его настройку (название, лимит, кик, мут) и переносит тебя в него.
// Когда в комнате не остаётся людей — она удаляется.
const { ChannelType, PermissionsBitField, OverwriteType } = require('discord.js');

const F = PermissionsBitField.Flags;

// Что получает владелец комнаты (только в своём канале):
//  ManageChannels — менять название, лимит участников, битрейт
//  MoveMembers    — «кикать» (отключать от голоса) участников
//  MuteMembers    — мутить участников
const OWNER_PERMS = new PermissionsBitField([F.ViewChannel, F.Connect, F.ManageChannels, F.MoveMembers, F.MuteMembers]);

module.exports = function createPrivateRooms(client, cfg) {
  const { guildId, categoryId, lobbyId, store } = cfg;
  const rooms = (store.data.channels ??= {}); // channelId -> ownerId
  const creating = new Set(); // userId, для которых комната создаётся прямо сейчас (защита от дублей)
  const rejoin = new Set(); // userId, который снова зашёл в лобби, пока его комната ещё создавалась

  const humansIn = (channel) => channel.members.filter((m) => !m.user.bot).size;

  function roomName(member) {
    const raw = (member.displayName ?? member.user?.username ?? 'Комната').replace(/\s*[\r\n]+\s*/g, ' ').trim();
    return (raw || 'Комната').slice(0, 100);
  }

  /** Права новой комнаты: всё, что задано на категории, + права владельца (с учётом его прав на категории). */
  function buildOverwrites(parent, ownerId) {
    const list = [];
    for (const o of parent?.permissionOverwrites?.cache?.values?.() ?? []) {
      if (o.id === ownerId) continue;
      list.push({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield });
    }
    const prev = parent?.permissionOverwrites?.cache?.get?.(ownerId);
    list.push({
      id: ownerId,
      type: OverwriteType.Member,
      allow: (prev?.allow?.bitfield ?? 0n) | OWNER_PERMS.bitfield,
      deny: (prev?.deny?.bitfield ?? 0n) & ~OWNER_PERMS.bitfield,
    });
    return list;
  }

  function forget(channelId) {
    if (rooms[channelId] === undefined) return;
    delete rooms[channelId];
    store.save();
  }

  async function removeRoom(channel, reason) {
    forget(channel.id);
    await channel.delete(reason).catch((e) => {
      if (e?.code !== 10003) console.error('Приватные комнаты: не удалось удалить канал:', e.message); // 10003 — уже удалён
    });
  }

  /** Удаляет комнату, если в ней не осталось людей. */
  async function deleteIfEmpty(guild, channelId) {
    if (rooms[channelId] === undefined) return;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return forget(channelId);
    if (humansIn(channel) === 0) await removeRoom(channel, 'Приватная комната опустела');
  }

  async function onJoinLobby(member) {
    if (creating.has(member.id)) {
      rejoin.add(member.id); // не теряем повторный вход — обработаем, как только текущая операция закончится
      return;
    }
    creating.add(member.id);
    try {
      const guild = member.guild;

      // У человека уже есть комната — просто возвращаем его в неё, а не плодим новые
      const ownedId = Object.keys(rooms).find((id) => rooms[id] === member.id && guild.channels.cache.has(id));
      if (ownedId) {
        await member.voice.setChannel(guild.channels.cache.get(ownedId), 'Возврат в свою приватную комнату').catch(() => {});
        return;
      }

      const parent = guild.channels.cache.get(categoryId) ?? (await guild.channels.fetch(categoryId).catch(() => null));
      if (!parent) return console.error('Приватные комнаты: категория не найдена, проверьте ID.');

      const make = (overwrites) => guild.channels.create({
        name: roomName(member),
        type: ChannelType.GuildVoice,
        parent: categoryId,
        permissionOverwrites: overwrites,
        reason: `Приватная комната для ${member.user.tag}`,
      });
      let channel;
      try {
        channel = await make(buildOverwrites(parent, member.id));
      } catch (err) {
        if (err?.code !== 50013) throw err;
        // Боту нельзя выдавать владельцу права, которых нет у самого бота — создаём комнату только с правами категории
        console.warn('Приватные комнаты: не удалось выдать владельцу права на комнату (у бота их нет на категории). Создаю комнату с правами категории.');
        channel = await make(buildOverwrites(parent, member.id).filter((o) => o.id !== member.id));
      }
      rooms[channel.id] = member.id;
      store.save();

      // Человек мог уже выйти из лобби, пока создавался канал — тогда комната никому не нужна
      if (member.voice.channelId !== lobbyId) return await removeRoom(channel, 'Владелец ушёл до переноса');
      try {
        await member.voice.setChannel(channel, 'Перенос в приватную комнату');
      } catch (err) {
        console.error('Приватные комнаты: не удалось перенести игрока (нужно право «Перемещать участников»):', err.message);
        await removeRoom(channel, 'Не удалось перенести владельца');
      }
    } catch (err) {
      const hint = err?.code === 50013 ? ' Выдайте боту права «Управлять каналами», «Перемещать участников», «Отключать микрофон участникам», «Просмотр канала», «Подключаться» на категории.' : '';
      console.error(`Приватные комнаты: ошибка создания комнаты: ${err.message}.${hint}`);
    } finally {
      creating.delete(member.id);
      if (rejoin.delete(member.id) && member.voice.channelId === lobbyId) await onJoinLobby(member);
    }
  }

  client.on('voiceStateUpdate', async (oldS, newS) => {
    try {
      const guild = newS.guild ?? oldS.guild;
      if (guild.id !== guildId) return;
      const member = newS.member ?? oldS.member;
      if (!member || member.user.bot) return;

      // Сначала чистим опустевшую комнату, которую человек покинул, и только потом обрабатываем вход в лобби:
      // иначе, перейдя из своей комнаты в лобби, он «вернулся» бы в комнату, которая тут же удаляется.
      if (oldS.channelId && oldS.channelId !== newS.channelId) await deleteIfEmpty(guild, oldS.channelId);
      if (newS.channelId === lobbyId && oldS.channelId !== lobbyId) await onJoinLobby(member);
    } catch (err) {
      console.error('Приватные комнаты:', err.message);
    }
  });

  // Канал удалили вручную — забываем о нём
  client.on('channelDelete', (channel) => forget(channel.id));

  /** После запуска: убираем из хранилища исчезнувшие каналы и удаляем пустые комнаты (если бот был выключен). */
  async function init() {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    // Диагностика: сразу видно, чего не хватает
    const parent = guild.channels.cache.get(categoryId) ?? (await guild.channels.fetch(categoryId).catch(() => null));
    const lobby = guild.channels.cache.get(lobbyId) ?? (await guild.channels.fetch(lobbyId).catch(() => null));
    if (!parent) console.error('Приватные комнаты: категория', categoryId, 'не найдена (проверьте ID и что бот видит категорию).');
    if (!lobby) console.error('Приватные комнаты: канал создания', lobbyId, 'не найден (проверьте ID).');
    else if (lobby.type !== ChannelType.GuildVoice) console.error('Приватные комнаты: канал создания должен быть ГОЛОСОВЫМ, сейчас тип', lobby.type);
    if (parent) {
      const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      const have = me && parent.permissionsFor(me);
      const need = { 'Просмотр канала': F.ViewChannel, 'Управление каналами': F.ManageChannels, 'Перемещение участников': F.MoveMembers, 'Подключаться': F.Connect };
      const missing = have ? Object.entries(need).filter(([, f]) => !have.has(f)).map(([n]) => n) : ['(не удалось проверить)'];
      if (missing.length) console.error('Приватные комнаты: у бота на категории нет прав:', missing.join(', '));
      else console.log('Приватные комнаты: готово (категория и лобби найдены, права есть).');
    }
    for (const id of Object.keys(rooms)) {
      const channel = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
      if (!channel) forget(id);
      else if (humansIn(channel) === 0) await removeRoom(channel, 'Пустая приватная комната после перезапуска');
    }
  }

  return { init, rooms, _internals: { buildOverwrites, roomName, onJoinLobby, deleteIfEmpty } };
};
