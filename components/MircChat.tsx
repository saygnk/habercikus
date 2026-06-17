'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

const ROOM = 'sohbet'
const CHANNEL_NAME = '#sohbet'

interface Message {
  id: string
  nick: string
  content: string
  msg_type: string
  created_at: string
  status?: 'sending' | 'sent' | 'read'
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

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export default function MircChat() {
  const [nick, setNick] = useState('')
  const [nickDraft, setNickDraft] = useState('')
  const [nickError, setNickError] = useState('')
  const [connected, setConnected] = useState(false)

  const [messages, setMessages] = useState<Message[]>([])
  const [users, setUsers] = useState<string[]>([])
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [unread, setUnread] = useState(0)

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const isVisibleRef = useRef(true)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasTypingRef = useRef(false)
  const nickRef = useRef(nick)

  useEffect(() => { nickRef.current = nick }, [nick])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typingUsers])

  // Tab visibility + title flash
  useEffect(() => {
    const onVisibility = () => {
      isVisibleRef.current = !document.hidden
      if (!document.hidden) {
        setUnread(0)
        document.title = 'habercikus'
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    if (unread === 0) { document.title = 'habercikus'; return }
    let on = true
    const t = setInterval(() => {
      document.title = on ? `(${unread}) yeni mesaj ●` : 'habercikus'
      on = !on
    }, 800)
    return () => clearInterval(t)
  }, [unread])

  const addMsg = useCallback((msg: Message) => {
    setMessages(prev => [...prev, msg])
  }, [])

  const updateStatus = useCallback((id: string, status: 'sent' | 'read') => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, status } : m))
  }, [])

  // Realtime room
  useEffect(() => {
    if (!connected || !nick) return

    const room = supabase.channel(ROOM, {
      config: {
        broadcast: { self: false },
        presence: { key: nick },
      },
    })
    channelRef.current = room

    room
      .on('broadcast', { event: 'msg' }, ({ payload }) => {
        const msg = payload as Message
        addMsg(msg)
        // Send read ack back to sender
        room.send({ type: 'broadcast', event: 'ack', payload: { id: msg.id } })
        if (isVisibleRef.current === false) {
          setUnread(prev => prev + 1)
        }
      })
      .on('broadcast', { event: 'sys' }, ({ payload }) => {
        addMsg(payload as Message)
      })
      .on('broadcast', { event: 'ack' }, ({ payload }) => {
        // Someone read one of our messages
        updateStatus((payload as { id: string }).id, 'read')
      })
      .on('presence', { event: 'sync' }, () => {
        const state = room.presenceState<{ nick: string; isTyping?: boolean }>()
        const all = Object.values(state).flat()
        const online = all.map(u => u.nick).filter((v, i, a) => a.indexOf(v) === i)
        setUsers(online)
        setTypingUsers(all.filter(u => u.isTyping && u.nick !== nickRef.current).map(u => u.nick))
      })
      .on('presence', { event: 'join' }, ({ newPresences }) => {
        const who = (newPresences[0] as unknown as { nick: string })?.nick
        if (who && who !== nick) {
          addMsg({ id: makeId(), nick: '***', content: `${who} kanala katıldı.`, msg_type: 'join', created_at: new Date().toISOString() })
        }
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }) => {
        const who = (leftPresences[0] as unknown as { nick: string })?.nick
        if (who) addMsg({ id: makeId(), nick: '***', content: `${who} kanaldan ayrıldı.`, msg_type: 'leave', created_at: new Date().toISOString() })
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await room.track({ nick, isTyping: false })
          addMsg({ id: makeId(), nick: '***', content: `Hoş geldin ${nick}! ${CHANNEL_NAME} kanalına bağlandın.`, msg_type: 'join', created_at: new Date().toISOString() })
        }
      })

    return () => {
      supabase.removeChannel(room)
      channelRef.current = null
    }
  }, [connected, nick, addMsg, updateStatus])

  const handleConnect = useCallback(() => {
    const n = nickDraft.trim()
    if (!validNick(n)) { setNickError('2-20 karakter: harf, rakam, _ veya -'); return }
    setNick(n)
    setConnected(true)
  }, [nickDraft])

  const stopTyping = useCallback(() => {
    wasTypingRef.current = false
    channelRef.current?.track({ nick: nickRef.current, isTyping: false })
  }, [])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value)
    if (!channelRef.current) return
    if (!wasTypingRef.current && e.target.value.length > 0) {
      wasTypingRef.current = true
      channelRef.current.track({ nick: nickRef.current, isTyping: true })
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    typingTimerRef.current = setTimeout(stopTyping, 2000)
  }, [stopTyping])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || !nick || !channelRef.current) return
    setInput('')
    inputRef.current?.focus()
    stopTyping()

    if (text.startsWith('/')) {
      const [rawCmd, ...rest] = text.slice(1).split(' ')
      const cmd = rawCmd.toLowerCase()
      if (cmd === 'nick' && rest[0]) {
        if (!validNick(rest[0])) return
        const old = nick
        await channelRef.current.send({ type: 'broadcast', event: 'sys', payload: { id: makeId(), nick: '***', content: `${old} artık ${rest[0]} olarak biliniyor.`, msg_type: 'nick', created_at: new Date().toISOString() } })
        setNick(rest[0])
      } else if (cmd === 'me' && rest.length) {
        const id = makeId()
        const msg: Message = { id, nick, content: rest.join(' '), msg_type: 'action', created_at: new Date().toISOString(), status: 'sending' }
        addMsg(msg)
        await channelRef.current.send({ type: 'broadcast', event: 'msg', payload: msg })
        updateStatus(id, 'sent')
      } else if (cmd === 'yardim' || cmd === 'help') {
        addMsg({ id: makeId(), nick: '***', content: 'Komutlar: /nick <isim>  /me <eylem>  /yardim', msg_type: 'system', created_at: new Date().toISOString() })
      }
      return
    }

    const id = makeId()
    const msg: Message = { id, nick, content: text, msg_type: 'message', created_at: new Date().toISOString(), status: 'sending' }
    addMsg(msg)
    await channelRef.current.send({ type: 'broadcast', event: 'msg', payload: msg })
    updateStatus(id, 'sent')
  }, [input, nick, addMsg, updateStatus, stopTyping])

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
            onChange={e => { setNickDraft(e.target.value); setNickError('') }}
            onKeyDown={e => e.key === 'Enter' && handleConnect()}
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

  const typingText = typingUsers.length === 1
    ? `${typingUsers[0]} yazıyor…`
    : typingUsers.length > 1
    ? `${typingUsers.join(', ')} yazıyor…`
    : null

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
          {messages.map(msg => <MsgLine key={msg.id} msg={msg} myNick={nick} />)}
          {typingText && <div className="typing-indicator">{typingText}</div>}
          <div ref={bottomRef} />
        </div>

        <div className="chat-users">
          <div className="users-header">ONLİNE</div>
          {users.map(u => (
            <div key={u} className="user-item" style={{ color: nickColor(u) }}>
              <span className="user-dot">●</span> {u}
            </div>
          ))}
        </div>
      </div>

      <div className="chat-inputbar">
        <span className="input-prefix">[{CHANNEL_NAME}]</span>
        <input
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={handleInputChange}
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

function StatusIcon({ status }: { status?: string }) {
  if (!status || status === 'sending') return <span className="msg-status sending">○</span>
  if (status === 'sent') return <span className="msg-status sent" title="Gönderildi">✓</span>
  return <span className="msg-status read" title="Okundu">✓✓</span>
}

function MsgLine({ msg, myNick }: { msg: Message; myNick: string }) {
  const time = ts(msg.created_at)
  const isMe = msg.nick === myNick

  if (msg.msg_type === 'message') {
    return (
      <div className={`msg-line ${isMe ? 'msg-mine' : ''}`}>
        <span className="msg-ts">[{time}]</span>{' '}
        <span className="msg-bracket">&lt;</span>
        <span className="msg-nick" style={{ color: nickColor(msg.nick) }}>{msg.nick}</span>
        <span className="msg-bracket">&gt;</span>{' '}
        <span className="msg-text" style={{ color: nickColor(msg.nick) }}>{msg.content}</span>
        {isMe && <StatusIcon status={msg.status} />}
      </div>
    )
  }
  if (msg.msg_type === 'action') {
    return (
      <div className="msg-line msg-action">
        <span className="msg-ts">[{time}]</span>{' '}
        <span>* <span style={{ color: nickColor(msg.nick) }}>{msg.nick}</span> <span style={{ color: nickColor(msg.nick) }}>{msg.content}</span></span>
        {isMe && <StatusIcon status={msg.status} />}
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
