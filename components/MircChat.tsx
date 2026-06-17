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

function makeMsg(nick: string, content: string, msg_type: string): Message {
  return { id: `${Date.now()}-${Math.random()}`, nick, content, msg_type, created_at: new Date().toISOString() }
}

export default function MircChat() {
  const [nick, setNick] = useState('')
  const [nickDraft, setNickDraft] = useState('')
  const [nickError, setNickError] = useState('')
  const [connected, setConnected] = useState(false)

  const [messages, setMessages] = useState<Message[]>([])
  const [users, setUsers] = useState<string[]>([])
  const [input, setInput] = useState('')

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const addMsg = useCallback((msg: Message) => {
    setMessages((prev) => [...prev, msg])
  }, [])

  // Connect to Realtime room
  useEffect(() => {
    if (!connected || !nick) return

    const room = supabase.channel(ROOM, {
      config: {
        broadcast: { self: true },
        presence: { key: nick },
      },
    })

    channelRef.current = room

    room
      .on('broadcast', { event: 'msg' }, ({ payload }) => {
        addMsg(payload as Message)
      })
      .on('broadcast', { event: 'sys' }, ({ payload }) => {
        addMsg(payload as Message)
      })
      .on('presence', { event: 'sync' }, () => {
        const state = room.presenceState<{ nick: string }>()
        const online = Object.values(state)
          .flat()
          .map((u) => u.nick)
          .filter((v, i, a) => a.indexOf(v) === i) // dedupe
        setUsers(online)
      })
      .on('presence', { event: 'join' }, ({ newPresences }) => {
        const who = newPresences[0]?.nick
        if (who && who !== nick) {
          addMsg(makeMsg('***', `${who} kanala katıldı.`, 'join'))
        }
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }) => {
        const who = leftPresences[0]?.nick
        if (who) addMsg(makeMsg('***', `${who} kanaldan ayrıldı.`, 'leave'))
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await room.track({ nick })
          addMsg(makeMsg('***', `Hoş geldin ${nick}! ${CHANNEL_NAME} kanalına bağlandın.`, 'join'))
        }
      })

    return () => {
      supabase.removeChannel(room)
      channelRef.current = null
    }
  }, [connected, nick, addMsg])

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
    if (!text || !nick || !channelRef.current) return
    setInput('')
    inputRef.current?.focus()

    if (text.startsWith('/')) {
      const [rawCmd, ...rest] = text.slice(1).split(' ')
      const cmd = rawCmd.toLowerCase()

      if (cmd === 'nick' && rest[0]) {
        if (!validNick(rest[0])) return
        const old = nick
        // Announce nick change before updating state
        await channelRef.current.send({
          type: 'broadcast', event: 'sys',
          payload: makeMsg('***', `${old} artık ${rest[0]} olarak biliniyor.`, 'nick'),
        })
        setNick(rest[0])
      } else if (cmd === 'me' && rest.length) {
        await channelRef.current.send({
          type: 'broadcast', event: 'msg',
          payload: makeMsg(nick, rest.join(' '), 'action'),
        })
      } else if (cmd === 'yardim' || cmd === 'help') {
        addMsg(makeMsg('***', 'Komutlar: /nick <isim>  /me <eylem>  /yardim', 'system'))
      }
      return
    }

    await channelRef.current.send({
      type: 'broadcast', event: 'msg',
      payload: makeMsg(nick, text, 'message'),
    })
  }, [input, nick, addMsg])

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
        <span className="msg-text" style={{ color: nickColor(msg.nick) }}>{msg.content}</span>
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
