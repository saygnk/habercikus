'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

const CHANNEL_NAME = '#sohbet'

interface Message {
  id: string
  nick: string
  content: string
  msg_type: string
  created_at: string
}

const NICK_COLORS = [
  '#33ff33', '#ff6633', '#33ccff', '#ffcc33',
  '#ff33cc', '#33ffcc', '#cc33ff', '#ff4444',
  '#44ff88', '#ff8844', '#44aaff', '#ffaa44',
]

function nickColor(nick: string): string {
  let h = 0
  for (let i = 0; i < nick.length; i++) h = nick.charCodeAt(i) + ((h << 5) - h)
  return NICK_COLORS[Math.abs(h) % NICK_COLORS.length]
}

function ts(iso: string): string {
  return new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
}

function validNick(s: string): boolean {
  return /^[a-zA-Z0-9_\-\[\]{}|^`\\]{2,20}$/.test(s)
}

function sysMsg(content: string, type = 'system'): Message {
  return { id: `sys-${Date.now()}-${Math.random()}`, nick: '***', content, msg_type: type, created_at: new Date().toISOString() }
}

export default function MircChat() {
  const [nick, setNick] = useState('')
  const [nickDraft, setNickDraft] = useState('')
  const [nickError, setNickError] = useState('')
  const [connected, setConnected] = useState(false)
  const [channelId, setChannelId] = useState<string | null>(null)

  const [messages, setMessages] = useState<Message[]>([])
  const [users, setUsers] = useState<string[]>([])
  const [input, setInput] = useState('')

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Track IDs we've already added optimistically so realtime echo doesn't duplicate
  const sentIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Get or create the single channel
  useEffect(() => {
    if (!connected) return
    ;(async () => {
      const { data, error } = await supabase
        .from('channels')
        .upsert({ name: CHANNEL_NAME, topic: '' }, { onConflict: 'name' })
        .select('id')
        .single()
      if (error || !data) {
        setMessages([sysMsg(`Veritabanı bağlantısı kurulamadı: ${error?.message ?? 'bilinmeyen hata'}. supabase/schema.sql dosyasını çalıştırdığınızdan emin olun.`)])
        return
      }
      setChannelId(data.id)
    })()
  }, [connected])

  // Subscribe + presence once channel is ready
  useEffect(() => {
    if (!channelId || !nick) return

    setMessages([sysMsg(`Hoş geldin ${nick}! ${CHANNEL_NAME} kanalına bağlandın.`, 'join')])

    // Announce join to others (fire and forget)
    supabase.from('messages').insert({
      channel_id: channelId, nick, content: `${nick} kanala katıldı.`, msg_type: 'join',
    })

    upsertPresence(channelId, nick)
    loadUsers(channelId)

    if (pingRef.current) clearInterval(pingRef.current)
    pingRef.current = setInterval(() => {
      upsertPresence(channelId, nick)
      loadUsers(channelId)
    }, 20000)

    const sub = supabase
      .channel(`room:${channelId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` },
        (p) => {
          const msg = p.new as Message & { channel_id: string }
          // Skip our own join broadcast and already-shown optimistic messages
          if (msg.nick === nick && msg.msg_type === 'join') return
          if (sentIds.current.has(msg.id)) {
            sentIds.current.delete(msg.id)
            return
          }
          setMessages((prev) => [...prev, msg])
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'channel_users', filter: `channel_id=eq.${channelId}` },
        () => loadUsers(channelId)
      )
      .subscribe()

    return () => {
      supabase.removeChannel(sub)
      if (pingRef.current) clearInterval(pingRef.current)
      supabase.from('channel_users').delete().eq('channel_id', channelId).eq('nick', nick)
    }
  }, [channelId, nick])

  async function loadUsers(chId: string) {
    const since = new Date(Date.now() - 40000).toISOString()
    const { data } = await supabase
      .from('channel_users').select('nick')
      .eq('channel_id', chId).gte('last_seen', since)
    if (data) setUsers(data.map((u) => u.nick))
  }

  async function upsertPresence(chId: string, userNick: string) {
    await supabase.from('channel_users').upsert(
      { channel_id: chId, nick: userNick, last_seen: new Date().toISOString() },
      { onConflict: 'channel_id,nick' }
    )
  }

  const handleConnect = useCallback(() => {
    const n = nickDraft.trim()
    if (!validNick(n)) {
      setNickError('2-20 karakter: harf, rakam, _ veya -')
      return
    }
    setNick(n)
    setConnected(true)
  }, [nickDraft])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || !nick) return
    setInput('')
    inputRef.current?.focus()

    if (text.startsWith('/')) {
      const [rawCmd, ...rest] = text.slice(1).split(' ')
      const cmd = rawCmd.toLowerCase()
      if (cmd === 'nick' && rest[0]) {
        if (!validNick(rest[0])) return
        const old = nick
        setNick(rest[0])
        if (channelId) {
          await supabase.from('messages').insert({
            channel_id: channelId, nick: rest[0],
            content: `${old} artık ${rest[0]} olarak biliniyor.`, msg_type: 'nick',
          })
        }
      } else if (cmd === 'me' && rest.length && channelId) {
        const optimistic: Message = { id: `opt-${Date.now()}`, nick, content: rest.join(' '), msg_type: 'action', created_at: new Date().toISOString() }
        setMessages((prev) => [...prev, optimistic])
        const { data } = await supabase.from('messages').insert({ channel_id: channelId, nick, content: rest.join(' '), msg_type: 'action' }).select('id').single()
        if (data) {
          sentIds.current.add(data.id)
          setMessages((prev) => prev.map((m) => m.id === optimistic.id ? { ...m, id: data.id } : m))
        }
      } else if (cmd === 'yardim' || cmd === 'help') {
        setMessages((prev) => [...prev, sysMsg('Komutlar: /nick <isim>  /me <eylem>  /yardim')])
      }
      return
    }

    if (!channelId) {
      setMessages((prev) => [...prev, sysMsg('Kanal bağlantısı henüz hazır değil, lütfen bekleyin.')])
      return
    }

    // Optimistic: show immediately
    const optimistic: Message = { id: `opt-${Date.now()}`, nick, content: text, msg_type: 'message', created_at: new Date().toISOString() }
    setMessages((prev) => [...prev, optimistic])

    const { data, error } = await supabase
      .from('messages')
      .insert({ channel_id: channelId, nick, content: text, msg_type: 'message' })
      .select('id')
      .single()

    if (error) {
      // Replace optimistic with error
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id))
      setMessages((prev) => [...prev, sysMsg(`Mesaj gönderilemedi: ${error.message}`)])
      return
    }

    if (data) {
      // Mark real ID so realtime echo is skipped; swap optimistic id with real id
      sentIds.current.add(data.id)
      setMessages((prev) => prev.map((m) => m.id === optimistic.id ? { ...m, id: data.id } : m))
    }
  }, [input, channelId, nick])

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleSend()
  }

  if (!connected) {
    return (
      <div className="nick-screen">
        <div className="nick-box">
          <div className="nick-logo">habercikus</div>
          <div className="nick-subtitle">{CHANNEL_NAME} · anlık sohbet</div>
          <input
            className="nick-input"
            value={nickDraft}
            onChange={(e) => { setNickDraft(e.target.value); setNickError('') }}
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            placeholder="Takma adını gir…"
            maxLength={20}
            autoFocus
          />
          {nickError && <div className="nick-error">{nickError}</div>}
          <button className="nick-btn" onClick={handleConnect}>Bağlan</button>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-app">
      <div className="chat-topbar">
        <div className="topbar-left">
          <span className="topbar-brand">habercikus</span>
          <span className="topbar-channel">{CHANNEL_NAME}</span>
          <span className="topbar-desc">Anlık sohbet — geçmiş yok, kayıt yok.</span>
        </div>
        <div className="topbar-count">{users.length} kişi</div>
      </div>

      <div className="chat-body">
        <div className="chat-messages">
          {messages.map((msg) => (
            <MsgLine key={msg.id} msg={msg} myNick={nick} />
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="chat-users">
          <div className="users-header">ONLİNE</div>
          {users.map((u) => (
            <div key={u} className="user-item" style={{ color: nickColor(u) }}>{u}</div>
          ))}
        </div>
      </div>

      <div className="chat-inputbar">
        <span className="input-prefix">[{CHANNEL_NAME}]</span>
        <input
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Mesajını yaz, Enter ile gönder…"
          autoFocus
        />
        <button className="chat-send" onClick={handleSend}>Gönder</button>
      </div>

      <div className="chat-statusbar">
        <span>Nick: <strong style={{ color: nickColor(nick) }}>{nick}</strong></span>
        <span>Geçmiş yok</span>
        <span>Anlık</span>
        <span>Güvenli</span>
      </div>
    </div>
  )
}

function MsgLine({ msg, myNick }: { msg: Message; myNick: string }) {
  const time = ts(msg.created_at)
  if (msg.msg_type === 'message') {
    return (
      <div className="msg-line" style={msg.nick === myNick ? { opacity: 0.85 } : undefined}>
        <span className="msg-ts">[{time}]</span>{' '}
        <span className="msg-bracket">&lt;</span>
        <span className="msg-nick" style={{ color: nickColor(msg.nick) }}>{msg.nick}</span>
        <span className="msg-bracket">&gt;</span>{' '}
        <span className="msg-text">{msg.content}</span>
      </div>
    )
  }
  if (msg.msg_type === 'action') {
    return (
      <div className="msg-line msg-action">
        <span className="msg-ts">[{time}]</span>{' '}
        <span>* <span style={{ color: nickColor(msg.nick) }}>{msg.nick}</span> {msg.content}</span>
      </div>
    )
  }
  return (
    <div className="msg-line msg-sys">
      <span className="msg-ts">[{time}]</span>{' '}
      <span>*** {msg.content}</span>
    </div>
  )
}
