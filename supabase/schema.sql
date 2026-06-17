-- Run this entire file in the Supabase SQL Editor
-- Dashboard → SQL Editor → New query → paste → Run

-- Tables
create table if not exists channels (
  id      uuid        default gen_random_uuid() primary key,
  name    text        not null unique,
  topic   text        not null default '',
  created_at timestamptz default now()
);

create table if not exists messages (
  id         uuid        default gen_random_uuid() primary key,
  channel_id uuid        references channels(id) on delete cascade,
  nick       text        not null,
  content    text        not null,
  msg_type   text        not null default 'message',
  created_at timestamptz default now()
);

create table if not exists channel_users (
  id         uuid        default gen_random_uuid() primary key,
  channel_id uuid        references channels(id) on delete cascade,
  nick       text        not null,
  last_seen  timestamptz default now(),
  unique(channel_id, nick)
);

-- Default channels
insert into channels (name, topic) values
  ('#genel',  'Genel sohbet kanalı'),
  ('#haber',  'Haberler ve güncel gelişmeler'),
  ('#oyun',   'Oyun sohbeti ve duyurular'),
  ('#destek', 'Yardım ve destek')
on conflict (name) do nothing;

-- RLS (open/public for now — lock down as needed)
alter table channels      enable row level security;
alter table messages      enable row level security;
alter table channel_users enable row level security;

create policy "channels: public read"   on channels      for select using (true);
create policy "channels: public insert" on channels      for insert with check (true);
create policy "channels: public update" on channels      for update using (true);

create policy "messages: public read"   on messages      for select using (true);
create policy "messages: public insert" on messages      for insert with check (true);

create policy "users: public read"      on channel_users for select using (true);
create policy "users: public insert"    on channel_users for insert with check (true);
create policy "users: public update"    on channel_users for update using (true);
create policy "users: public delete"    on channel_users for delete using (true);

-- Realtime
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table channel_users;
