const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { WebSocketServer } = require('ws');
const express = require('express');
const http = require('http');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !CLIENT_ID) {
  console.error('Manque DISCORD_TOKEN ou CLIENT_ID dans les variables d\'environnement');
  process.exit(1);
}

// HTTP server + WebSocket sur le même port
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/', (req, res) => res.send('LiveChat Server OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', clients: wss.clients.size }));

// Clients connectés par guildId
const clients = new Map(); // guildId -> Set<ws>

wss.on('connection', (ws, req) => {
  let guildId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'register' && msg.guildId) {
        guildId = msg.guildId;
        if (!clients.has(guildId)) clients.set(guildId, new Set());
        clients.get(guildId).add(ws);
        ws.send(JSON.stringify({ type: 'registered', guildId }));
        console.log(`[WS] Client enregistré pour guild ${guildId} (total: ${clients.get(guildId).size})`);
      }
    } catch {}
  });

  ws.on('close', () => {
    if (guildId && clients.has(guildId)) {
      clients.get(guildId).delete(ws);
      if (clients.get(guildId).size === 0) clients.delete(guildId);
    }
  });

  ws.on('error', () => {});
});

function broadcast(guildId, payload) {
  const guild = clients.get(guildId);
  if (!guild) return;
  const data = JSON.stringify(payload);
  for (const ws of guild) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
  console.log(`[Broadcast] Guild ${guildId} → ${guild.size} client(s)`);
}

// Bot Discord
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`[Bot] Connecté en tant que ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'livechat') return;

  const text = interaction.options.getString('texte') || '';
  const attachment = interaction.options.getAttachment('media');
  const customDuration = interaction.options.getInteger('duree');

  if (!text && !attachment) {
    await interaction.reply({ content: '❌ Donne un texte ou un média !', ephemeral: true });
    return;
  }

  let url = null;
  let mediaType = null;

  if (attachment) {
    url = attachment.url;
    const ct = attachment.contentType || '';
    if (ct.startsWith('video/')) mediaType = 'video';
    else {
      const ext = (attachment.name || '').split('.').pop().toLowerCase();
      mediaType = ['mp4', 'webm', 'mov'].includes(ext) ? 'video' : 'image';
    }
  }

  const guildId = interaction.guildId;
  const connected = clients.get(guildId)?.size || 0;

  broadcast(guildId, {
    type: 'media',
    username: interaction.user.displayName || interaction.user.username,
    avatar: interaction.user.displayAvatarURL({ size: 64 }),
    text,
    url,
    mediaType,
    duration: customDuration || null,
  });

  await interaction.reply({
    content: `✅ Envoyé à **${connected}** écran${connected > 1 ? 's' : ''} !`,
    ephemeral: true
  });
});

async function registerCommands() {
  const command = new SlashCommandBuilder()
    .setName('livechat')
    .setDescription('Affiche un média sur tous les écrans connectés')
    .addStringOption(opt =>
      opt.setName('texte').setDescription('Message à afficher').setRequired(false))
    .addAttachmentOption(opt =>
      opt.setName('media').setDescription('Image, GIF ou vidéo').setRequired(false))
    .addIntegerOption(opt =>
      opt.setName('duree').setDescription('Durée en secondes').setRequired(false).setMinValue(1).setMaxValue(120));

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [command.toJSON()] });
    console.log('[Bot] Commande /livechat enregistrée globalement');
  } catch (e) {
    console.error('[Bot] Erreur enregistrement commande:', e.message);
  }
}

client.login(TOKEN);
server.listen(PORT, () => console.log(`[Server] En écoute sur le port ${PORT}`));
