const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags } = require('discord.js');
const { createServer } = require('http');
const { Server } = require('socket.io');
const express = require('express');
const https = require('https');

const fileCache = new Map();

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || '' }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;
const ROLE_NAME = 'Tars';

if (!TOKEN || !CLIENT_ID) { console.error('Manque DISCORD_TOKEN ou CLIENT_ID'); process.exit(1); }

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
});

app.get('/', (req, res) => res.send('LiveChat Server OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', clients: io.engine.clientsCount }));
app.get('/media/:id', (req, res) => {
  const cached = fileCache.get(req.params.id);
  if (!cached) { res.status(404).send('Not found'); return; }
  res.setHeader('Content-Type', cached.contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(cached.buffer);
});

io.on('connection', (socket) => {
  let guildId = null;

  socket.on('register', (data) => {
    guildId = data.guildId;
    socket.join(guildId);
    const size = io.sockets.adapter.rooms.get(guildId)?.size || 0;
    console.log(`[IO] Client connecté guild ${guildId} (total room: ${size})`);
    socket.emit('registered');
  });

  socket.on('done', () => {
    if (guildId) finishMedia(guildId);
  });

  socket.on('disconnect', (reason) => {
    if (guildId) {
      const size = io.sockets.adapter.rooms.get(guildId)?.size || 0;
      console.log(`[IO] Client déconnecté guild ${guildId} (total room: ${size}) — ${reason}`);
    }
  });
});

const queues = new Map();
const processing = new Set();
const mediaTimers = new Map();
const handledInteractions = new Set();

function getRoomSize(guildId) {
  return io.sockets.adapter.rooms.get(guildId)?.size || 0;
}

function finishMedia(guildId) {
  if (!processing.has(guildId)) return;
  const timer = mediaTimers.get(guildId);
  if (timer) { clearTimeout(timer); mediaTimers.delete(guildId); }
  const queue = queues.get(guildId);
  if (queue) queue.shift();
  processing.delete(guildId);
  console.log(`[Queue] Média terminé guild ${guildId}`);
  if (queues.get(guildId)?.length > 0) processQueue(guildId);
}

function processQueue(guildId) {
  if (processing.has(guildId)) return;
  const queue = queues.get(guildId);
  if (!queue || queue.length === 0) return;
  processing.add(guildId);
  io.to(guildId).emit('show-media', { ...queue[0], action: 'show' });
  const timer = setTimeout(() => finishMedia(guildId), 35000);
  mediaTimers.set(guildId, timer);
}

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

bot.on('warn', (info) => console.log(`[Bot] Warn: ${info}`));
bot.on('error', (err) => console.log(`[Bot] Error: ${err.message}`));

bot.once('clientReady', async () => {
  console.log(`[Bot] Connecté : ${bot.user.tag}`);
  await registerCommands();
});

bot.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Commande /stop
  if (interaction.commandName === 'stop') {
    try {
      const hasRole = interaction.member.roles.cache.some(r => r.name === ROLE_NAME);
      if (!hasRole) {
        await interaction.reply({ content: `❌ Tu dois avoir le rôle **${ROLE_NAME}**.`, ephemeral: true });
        return;
      }
      const guildId = interaction.guildId;
      if (processing.has(guildId)) {
        io.to(guildId).emit('stop-media');
        finishMedia(guildId);
        await interaction.reply({ content: '⏹️ Média arrêté !', ephemeral: true });
      } else {
        await interaction.reply({ content: '❌ Aucun média en cours.', ephemeral: true });
      }
    } catch(e) {
      console.error('[Stop] Erreur:', e.message);
    }
    return;
  }

  if (interaction.commandName !== 'livechat') return;

  try {
    if (handledInteractions.has(interaction.id)) return;
    handledInteractions.add(interaction.id);
    setTimeout(() => handledInteractions.delete(interaction.id), 10000);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const hasRole = interaction.member.roles.cache.some(r => r.name === ROLE_NAME);
    if (!hasRole) {
      await interaction.editReply({ content: `❌ Tu dois avoir le rôle **${ROLE_NAME}**.` });
      return;
    }

    const guildId = interaction.guildId;

    if (processing.has(guildId)) {
      await interaction.editReply({ content: '⏳ Un média est déjà en cours, attends qu\'il soit terminé !' });
      return;
    }

    if (!queues.has(guildId)) queues.set(guildId, []);
    const queue = queues.get(guildId);
    if (queue.length >= 3) {
      await interaction.editReply({ content: '⏳ File d\'attente pleine (3/3).' });
      return;
    }

    const text = interaction.options.getString('texte') || '';
    const attachment = interaction.options.getAttachment('media');

    if (!text && !attachment) {
      await interaction.editReply({ content: '❌ Donne un texte ou un média.' });
      return;
    }

    let url = null;
    let mediaType = null;

    if (attachment) {
      const ct = attachment.contentType || '';
      if (ct.startsWith('video/')) mediaType = 'video';
      else if (ct.includes('gif')) mediaType = 'gif';
      else if (ct.startsWith('audio/') || /\.(mp3|wav|ogg|aac|flac)$/i.test(attachment.name || '')) mediaType = 'audio';
      else mediaType = 'image';

      try {
        const { buffer, contentType } = await downloadBuffer(attachment.url);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
        fileCache.set(id, { buffer, contentType: contentType || ct });
        setTimeout(() => fileCache.delete(id), 60000);
        const host = process.env.SERVER_URL || `http://localhost:${PORT}`;
        url = `${host}/media/${id}`;
      } catch(e) {
        url = attachment.url;
        console.error('[Media] Erreur download:', e.message);
      }
    }

    const connected = getRoomSize(guildId);
    const payload = {
      username: interaction.member.displayName || interaction.user.username,
      avatar: interaction.user.displayAvatarURL({ size: 64 }),
      text, url, mediaType,
    };

    queue.push(payload);
    setTimeout(() => processQueue(guildId), 1500);

    await interaction.editReply({ content: `✅ Envoyé à **${connected}** écran${connected !== 1 ? 's' : ''} !` });
  } catch(e) {
    console.error('[Interaction] Erreur:', e.message);
  }
});

async function registerCommands() {
  const livechat = new SlashCommandBuilder()
    .setName('livechat')
    .setDescription('Affiche un média sur tous les écrans connectés')
    .addStringOption(o => o.setName('texte').setDescription('Message à afficher').setRequired(false))
    .addAttachmentOption(o => o.setName('media').setDescription('Image, GIF ou vidéo').setRequired(false));

  const stop = new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Annule le média en cours d\'affichage');

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    const guilds = bot.guilds.cache;
    for (const [, guild] of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guild.id), { body: [] });
        console.log(`[Bot] Commandes guild supprimées pour ${guild.name}`);
      } catch {}
    }
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [livechat.toJSON(), stop.toJSON()] });
    console.log('[Bot] Commandes /livechat et /stop enregistrées globalement');
  } catch(e) { console.error('[Bot] Erreur commande:', e.message); }
}

bot.login(TOKEN).catch(e => console.error('[Bot] Login failed:', e.message));
httpServer.listen(PORT, () => console.log(`[Server] Port ${PORT}`));

setInterval(() => {
  const host = process.env.SERVER_URL || `http://localhost:${PORT}`;
  https.get(`${host}/health`, () => {}).on('error', () => {});
}, 4 * 60 * 1000);
