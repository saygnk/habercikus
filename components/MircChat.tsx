'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

interface Channel {
  id: string
  name: string
  topic: string
}

interface Message {
  id: string
  channel_id: string
  nick: string
  content: string
  msg_type: string
  created_at: string
}

const NICK_COLORS = [
  '#cc0000', '#cc6600', '#cccc00', '#006600',
  '#006666', '#0000cc', '#6600cc', '#cc0066',
  '#990000', '#009900', '#009999', '#000099',
  '#990099', '#996600', '#cc3300', '#3300cc',
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

export default function MircChat() {
  const [nick, setNick] = useState('')
  const [nickDraft, setNickDraft] = useState('')
  const [nickError, setNickError] = useState('')
  const [connected, setConnected] = useState(false)

  const [channels, setChannels] = useState<Channel[]>([])
  const [current, setCurrent] = useState<Channel | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [users, setUsers] = useState<string[]>([])
  const [input, setInput] = useState('')

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const joinedRef = useRef<Set<string>>(new Set())
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Load channels once connected
  useEffect(() => {
    if (!connected) return
    loadChannels()
  }, [connected])

  async function loadChannels() {
    const { data } = await supabase.from('channels').select('*').order('name')
    if (data?.length) {
      setChannels(data)
      if (!current) setCurrent(data[0])
    }
  }

  // Channel switch: load history + realtime + presence
  useEffect(() => {
    if (!current || !nick) return

    loadMessages(current.id)
    loadUsers(current.id)

    // Announce join once per channel per session
    if (!joinedRef.current.has(current.id)) {
      joinedRef.current.add(current.id)
      insertMsg(current.id, nick, `${nick} has joined ${current.name}`, 'join')
    }

    upsertPresence(current.id, nick)

    if (pingRef.current) clearInterval(pingRef.current)
    pingRef.current = setInterval(() => {
      upsertPresence(current.id, nick)
      loadUsers(current.id)
    }, 20000)

    const sub = supabase
      .channel(`room:${current.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${current.id}` },
        (p) => setMessages((prev) => [...prev, p.new as Message])
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'channel_users', filter: `channel_id=eq.${current.id}` },
        () => loadUsers(current.id)
      )
      .subscribe()

    return () => {
      supabase.removeChannel(sub)
      if (pingRef.current) clearInterval(pingRef.current)
    }
  }, [current?.id, nick])

  async function loadMessages(channelId: string) {
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: true })
      .limit(200)
    if (data) setMessages(data)
  }

  async function loadUsers(channelId: string) {
    const since = new Date(Date.now() - 40000).toISOString()
    const { data } = await supabase
      .from('channel_users')
      .select('nick')
      .eq('channel_id', channelId)
      .gte('last_seen', since)
    if (data) setUsers(data.map((u) => u.nick))
  }

  async function upsertPresence(channelId: string, userNick: string) {
    await supabase.from('channel_users').upsert(
      { channel_id: channelId, nick: userNick, last_seen: new Date().toISOString() },
      { onConflict: 'channel_id,nick' }
    )
  }

  async function insertMsg(channelId: string, userNick: string, content: string, type: string) {
    await supabase.from('messages').insert({ channel_id: channelId, nick: userNick, content, msg_type: type })
  }

  const handleConnect = useCallback(() => {
    const n = nickDraft.trim()
    if (!validNick(n)) {
      setNickError('Nick must be 2-20 chars: letters, numbers, _ - [ ] { }')
      return
    }
    setNick(n)
    setConnected(true)
  }, [nickDraft])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || !current || !nick) return
    setInput('')
    inputRef.current?.focus()

    if (text.startsWith('/')) {
      const [rawCmd, ...rest] = text.slice(1).split(' ')
      const cmd = rawCmd.toLowerCase()
      const args = rest.join(' ')

      if (cmd === 'nick' && rest[0]) {
        if (!validNick(rest[0])) return
        const old = nick
        setNick(rest[0])
        await insertMsg(current.id, rest[0], `${old} is now known as ${rest[0]}`, 'nick')

      } else if (cmd === 'join') {
        const name = args.startsWith('#') ? args : `#${args}`
        await supabase.from('channels').upsert({ name, topic: '' }, { onConflict: 'name' }).select()
        await loadChannels()

      } else if (cmd === 'topic' && args) {
        await supabase.from('channels').update({ topic: args }).eq('id', current.id)
        await insertMsg(current.id, nick, `${nick} changed the topic to: ${args}`, 'topic')
        await loadChannels()

      } else if (cmd === 'me' && args) {
        await insertMsg(current.id, nick, args, 'action')

      } else if (cmd === 'part') {
        await insertMsg(current.id, nick, `${nick} has left ${current.name}`, 'leave')
        await supabase.from('channel_users').delete().eq('channel_id', current.id).eq('nick', nick)

      } else if (cmd === 'help') {
        const helpMsg: Message = {
          id: `help-${Date.now()}`,
          channel_id: current.id,
          nick: '***',
          content: 'Commands: /nick <n>  /join <#ch>  /topic <text>  /me <action>  /part  /help',
          msg_type: 'system',
          created_at: new Date().toISOString(),
        }
        setMessages((prev) => [...prev, helpMsg])
      }
      return
    }

    await insertMsg(current.id, nick, text, 'message')
  }, [input, current, nick])

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleSend()
  }

  // ── Nick dialog ──
  if (!connected) {
    return (
      <div className="overlay">
        <div className="win-dialog">
          <div className="win-titlebar">
            <span>Connect to habercikus</span>
            <span className="win-btn-x">✕</span>
          </div>
          <div className="win-body">
            <p>Choose a nickname to enter the chat:</p>
            <input
              className="win-input"
              value={nickDraft}
              onChange={(e) => { setNickDraft(e.target.value); setNickError('') }}
              onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              placeholder="e.g. CoolUser99"
              maxLength={20}
              autoFocus
            />
            {nickError && <span className="win-error">{nickError}</span>}
            <button className="win-button" onClick={handleConnect}>Connect</button>
          </div>
        </div>
      </div>
    )
  }

  // ── Main mIRC window ──
  return (
    <div className="mirc-app">
      {/* Title bar */}
      <div className="mirc-titlebar">
        <span>habercikus — [{current?.name ?? '...'}]</span>
        <div className="mirc-titlebar-btns">
          <span>_</span>
          <span>□</span>
          <span>✕</span>
        </div>
      </div>

      {/* Menu bar */}
      <div className="mirc-menubar">
        {['File', 'Edit', 'View', 'Favorites', 'Tools', 'Help'].map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>

      {/* Body */}
      <div className="mirc-body">
        {/* Channel list */}
        <div className="mirc-sidebar">
          <div className="mirc-sidebar-header">Channels</div>
          <div className="mirc-sidebar-list">
            {channels.map((ch) => (
              <div
                key={ch.id}
                className={`mirc-ch-item ${current?.id === ch.id ? 'active' : ''}`}
                onClick={() => setCurrent(ch)}
              >
                {ch.name}
              </div>
            ))}
          </div>
        </div>

        {/* Chat */}
        <div className="mirc-chat">
          <div className="mirc-topic-bar">
            <em>Topic:</em> {current?.topic || 'No topic set — type /topic <text> to set one'}
          </div>

          <div className="mirc-messages">
            {messages.map((msg) => (
              <MessageLine key={msg.id} msg={msg} myNick={nick} />
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="mirc-inputbar">
            <span className="mirc-input-ch">[{current?.name}]</span>
            <input
              ref={inputRef}
              className="mirc-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="Type a message or /help for commands…"
              autoFocus
            />
            <button className="mirc-send" onClick={handleSend}>Send</button>
          </div>
        </div>

        {/* User list */}
        <div className="mirc-users">
          <div className="mirc-users-header">Users ({users.length})</div>
          <div className="mirc-users-list">
            {users.map((u) => (
              <div key={u} className={`mirc-user-item ${u === nick ? 'me' : ''}`}>
                {u === nick ? `@${u}` : u}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="mirc-statusbar">
        <span className="mirc-status-seg">Connected as <strong>{nick}</strong></span>
        <span className="mirc-status-seg">{current?.name}</span>
        <span className="mirc-status-seg">{users.length} user{users.length !== 1 ? 's' : ''} online</span>
        <span className="mirc-status-seg">habercikus v1.0</span>
      </div>
    </div>
  )
}

function MessageLine({ msg, myNick }: { msg: Message; myNick: string }) {
  const time = ts(msg.created_at)
  const lineClass = `mirc-line line-${msg.msg_type}`

  if (msg.msg_type === 'message') {
    const isMe = msg.nick === myNick
    return (
      <div className={lineClass} style={isMe ? { background: '#f0f8ff' } : undefined}>
        <span className="mirc-ts">[{time}]</span>{' '}
        <span className="mirc-bracket">&lt;</span>
        <span className="mirc-nick" style={{ color: nickColor(msg.nick) }}>{msg.nick}</span>
        <span className="mirc-bracket">&gt;</span>{' '}
        <span className="mirc-text">{msg.content}</span>
      </div>
    )
  }

  if (msg.msg_type === 'action') {
    return (
      <div className={lineClass}>
        <span className="mirc-ts">[{time}]</span>{' '}
        <span className="mirc-act">
          * <span style={{ color: nickColor(msg.nick) }}>{msg.nick}</span> {msg.content}
        </span>
      </div>
    )
  }

  return (
    <div className={lineClass}>
      <span className="mirc-ts">[{time}]</span>{' '}
      <span className="mirc-sys">*** {msg.content}</span>
    </div>
  )
}
