'use strict'

// Catch anything that crashes the process silently
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message, err.stack)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason)
})

console.log('Loading dependencies...')

let makeWASocket, DisconnectReason, fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore, initAuthCreds, BufferJSON

try {
  const baileys = require('@whiskeysockets/baileys')
  makeWASocket              = baileys.default
  DisconnectReason          = baileys.DisconnectReason
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion
  makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore
  initAuthCreds             = baileys.initAuthCreds
  BufferJSON                = baileys.BufferJSON
  console.log('Baileys loaded OK')
} catch (err) {
  console.error('Failed to load Baileys:', err.message)
  process.exit(1)
}

const { createClient } = require('@supabase/supabase-js')
const express = require('express')
const P = require('pino')

// ── Config ────────────────────────────────────────────────────────
const API_SECRET   = process.env.BRIDGE_API_SECRET
const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
const PORT         = process.env.PORT || 3001

console.log('ENV check — PORT:', PORT,
  'API_SECRET:', !!API_SECRET,
  'SUPABASE_URL:', !!SUPABASE_URL,
  'SERVICE_KEY:', !!SERVICE_KEY)

if (!API_SECRET || !SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing required env vars. Exiting.')
  process.exit(1)
}

const db     = createClient(SUPABASE_URL, SERVICE_KEY)
const app    = express()
const logger = P({ level: 'silent' })

app.use(express.json())

// ── Auth middleware ───────────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
  if (token !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// ── Session store ─────────────────────────────────────────────────
const sessions = new Map()

// ── Supabase auth state ───────────────────────────────────────────
async function makeSupabaseAuthState(userId) {
  const { data } = await db
    .from('wa_sessions')
    .select('creds, keys')
    .eq('user_id', userId)
    .maybeSingle()

  const creds = data?.creds
    ? JSON.parse(JSON.stringify(data.creds), BufferJSON.reviver)
    : initAuthCreds()

  let keysMap = data?.keys ?? {}

  const keyStore = {
    get: async (type, ids) => {
      const out = {}
      for (const id of ids) {
        const raw = keysMap[type]?.[id]
        if (raw !== undefined) out[id] = JSON.parse(JSON.stringify(raw), BufferJSON.reviver)
      }
      return out
    },
    set: async (data) => {
      for (const [type, map] of Object.entries(data)) {
        keysMap[type] = keysMap[type] || {}
        for (const [id, val] of Object.entries(map)) {
          if (val) keysMap[type][id] = JSON.parse(JSON.stringify(val, BufferJSON.replacer))
          else delete keysMap[type][id]
        }
      }
    },
  }

  const state = { creds, keys: makeCacheableSignalKeyStore(keyStore, logger) }

  const saveCreds = async () => {
    try {
      await db.from('wa_sessions').upsert({
        user_id:    userId,
        creds:      JSON.parse(JSON.stringify(state.creds, BufferJSON.replacer)),
        keys:       keysMap,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
    } catch (err) {
      console.error(`[${userId.slice(0,8)}] save session error:`, err.message)
    }
  }

  return { state, saveCreds }
}

// ── Helpers ───────────────────────────────────────────────────────
const jidToPhone  = jid => '+' + jid.split('@')[0]
const phoneToJid  = phone => phone.replace(/\D/g, '') + '@s.whatsapp.net'
const isGroup     = jid => jid?.endsWith('@g.us')
const isStatus    = jid => jid === 'status@broadcast'
const isValidJid  = jid => /^\d{7,15}$/.test(jid?.split('@')[0] ?? '')

async function ensureContact(userId, phone, name) {
  const { data: existing } = await db.from('contacts').select('id, name')
    .eq('user_id', userId).eq('phone', phone).maybeSingle()
  if (existing) {
    if (name && !existing.name) await db.from('contacts').update({ name }).eq('id', existing.id)
    return existing.id
  }
  const { data } = await db.from('contacts')
    .insert({ user_id: userId, phone, name: name || null }).select('id').single()
  return data.id
}

async function ensureConversation(userId, contactId) {
  const { data: existing } = await db.from('conversations').select('id')
    .eq('user_id', userId).eq('contact_id', contactId).maybeSingle()
  if (existing) return existing.id
  const { data } = await db.from('conversations')
    .insert({ user_id: userId, contact_id: contactId, status: 'open' }).select('id').single()
  return data.id
}

async function saveMessage(userId, msg) {
  try {
    const jid = msg.key.remoteJid
    if (!jid || isGroup(jid) || isStatus(jid) || !isValidJid(jid)) return
    if (msg.key.fromMe || !msg.message) return

    const phone    = jidToPhone(jid)
    const pushName = msg.pushName || null
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      (msg.message?.imageMessage    ? '[image]'    : null) ||
      (msg.message?.audioMessage    ? '[audio]'    : null) ||
      (msg.message?.documentMessage ? '[document]' : null) ||
      null
    if (!text) return

    const { data: dup } = await db.from('messages').select('id').eq('message_id', msg.key.id).maybeSingle()
    if (dup) return

    const contactId      = await ensureContact(userId, phone, pushName)
    const conversationId = await ensureConversation(userId, contactId)
    const ts = msg.messageTimestamp
      ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
      : new Date().toISOString()

    await db.from('messages').insert({
      conversation_id: conversationId, sender_type: 'contact',
      content_type: 'text', content_text: text,
      message_id: msg.key.id, status: 'delivered', created_at: ts,
    })
    await db.from('conversations').update({
      last_message_text: text, last_message_at: ts,
      updated_at: new Date().toISOString(), status: 'open',
    }).eq('id', conversationId)

    console.log(`[${userId.slice(0,8)}] ← ${phone}: ${text.slice(0, 60)}`)
  } catch (err) {
    console.error(`[${userId.slice(0,8)}] msg error:`, err.message)
  }
}

async function processOutbox(userId, socket) {
  try {
    const { data: items } = await db.from('bridge_queue')
      .select('*').eq('user_id', userId).eq('status', 'pending')
      .order('created_at').limit(5)
    if (!items?.length) return
    for (const item of items) {
      try {
        const sent = await socket.sendMessage(phoneToJid(item.to_phone), { text: item.message })
        await db.from('bridge_queue').update({ status: 'sent', wa_message_id: sent.key.id }).eq('id', item.id)
        if (item.crm_message_id) {
          await db.from('messages').update({ message_id: sent.key.id, status: 'sent' }).eq('id', item.crm_message_id)
        }
      } catch (err) {
        await db.from('bridge_queue').update({ status: 'failed', error: err.message }).eq('id', item.id)
      }
    }
  } catch (err) {
    console.error(`[${userId.slice(0,8)}] outbox error:`, err.message)
  }
}

async function startSession(userId) {
  const existing = sessions.get(userId)
  if (existing?.socket) { try { existing.socket.end() } catch (_) {} }
  sessions.set(userId, { status: 'connecting', qr: null, phone: null, socket: null })

  try {
    const { version }          = await fetchLatestBaileysVersion()
    const { state, saveCreds } = await makeSupabaseAuthState(userId)

    const socket = makeWASocket({
      version, auth: { creds: state.creds, keys: state.keys },
      logger, browser: ['SWCRM', 'Chrome', '3.0'], markOnlineOnConnect: false,
    })

    sessions.get(userId).socket = socket
    socket.ev.on('creds.update', saveCreds)

    socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      const sess = sessions.get(userId)
      if (!sess) return
      if (qr) { sess.qr = qr; sess.status = 'qr_pending'; console.log(`[${userId.slice(0,8)}] QR ready`) }
      if (connection === 'open') {
        sess.status = 'connected'; sess.qr = null
        sess.phone = socket.user?.id ? jidToPhone(socket.user.id) : null
        console.log(`[${userId.slice(0,8)}] Connected — ${sess.phone}`)
        await db.from('whatsapp_config')
          .update({ status: 'connected', connection_type: 'bridge', connected_at: new Date().toISOString() })
          .eq('user_id', userId)
        if (sess._outboxInterval) clearInterval(sess._outboxInterval)
        sess._outboxInterval = setInterval(() => {
          const s = sessions.get(userId)
          if (s?.socket && s.status === 'connected') processOutbox(userId, s.socket)
        }, 1500)
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        const sess = sessions.get(userId)
        if (sess) { clearInterval(sess._outboxInterval); sess.status = code === DisconnectReason.loggedOut ? 'disconnected' : 'reconnecting'; sess.socket = null }
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => startSession(userId), 5000)
        } else {
          await db.from('wa_sessions').delete().eq('user_id', userId)
          await db.from('whatsapp_config').update({ status: 'disconnected', connection_type: 'meta' }).eq('user_id', userId)
        }
      }
    })

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) await saveMessage(userId, msg)
    })
  } catch (err) {
    console.error(`[${userId.slice(0,8)}] startSession error:`, err.message)
    sessions.set(userId, { status: 'error', qr: null, phone: null, socket: null })
  }
}

// ── Routes ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, sessions: sessions.size }))

app.post('/connect/:userId', auth, async (req, res) => {
  const { userId } = req.params
  const existing = sessions.get(userId)
  if (existing?.status === 'connected') return res.json({ status: 'already_connected', phone: existing.phone })
  startSession(userId).catch(err => console.error('startSession error:', err.message))
  res.json({ status: 'connecting' })
})

app.get('/qr/:userId', auth, (req, res) => {
  const sess = sessions.get(req.params.userId)
  if (!sess) return res.json({ status: 'not_started' })
  if (sess.status === 'connected') return res.json({ status: 'connected', phone: sess.phone })
  if (sess.qr) return res.json({ status: 'qr_pending', qr: sess.qr })
  res.json({ status: sess.status })
})

app.get('/status/:userId', auth, (req, res) => {
  const sess = sessions.get(req.params.userId)
  if (!sess) return res.json({ status: 'not_started' })
  res.json({ status: sess.status, phone: sess.phone || null })
})

app.post('/disconnect/:userId', auth, async (req, res) => {
  const { userId } = req.params
  const sess = sessions.get(userId)
  if (sess) { clearInterval(sess._outboxInterval); try { sess.socket?.end() } catch (_) {} sessions.delete(userId) }
  await db.from('wa_sessions').delete().eq('user_id', userId)
  await db.from('whatsapp_config').update({ status: 'disconnected', connection_type: 'meta' }).eq('user_id', userId)
  res.json({ ok: true })
})

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SWCRM WhatsApp Bridge running on port ${PORT}`)
  console.log(`Sessions: ${sessions.size}`)
})

// Reconnect previously connected users
;(async () => {
  try {
    const { data } = await db.from('whatsapp_config')
      .select('user_id').eq('status', 'connected').eq('connection_type', 'bridge')
    if (data?.length) {
      console.log(`Resuming ${data.length} session(s)…`)
      for (const { user_id } of data) {
        await startSession(user_id)
        await new Promise(r => setTimeout(r, 1000))
      }
    }
  } catch (err) {
    console.error('Startup resume error:', err.message)
  }
})()
