-- ============================================================================
-- IRON LOG — Supabase テーブル定義
-- わんにゃんメモリー／達人への道と同じプロジェクトに相乗りするため、
-- 「authenticated に grant / anon から revoke / RLS＋ポリシー」を毎回明示する。
-- Supabase ダッシュボード → SQL Editor に貼って実行する。
-- 何度実行しても壊れないように書いてある。
--
-- 注意: time は PostgreSQL の予約語なので、記録時刻の列名は clock にしている。
-- ============================================================================

-- ── 1) 種目リストと設定（1ユーザー1行。last-write-wins の小さな箱） ──
create table if not exists public.ironlog_state (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  doc        jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── 2) 筋トレのログ（1セッション1行。IDごとに独立なので端末間で潰し合わない） ──
create table if not exists public.ironlog_logs (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  id         text        not null,               -- アプリが作るID
  date       text        not null default '',    -- 'YYYY-MM-DD'
  clock      text        not null default '',    -- 'HH:MM'
  entries    jsonb       not null default '[]'::jsonb,
  total      double precision not null default 0,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists ironlog_logs_user_updated_idx
  on public.ironlog_logs (user_id, updated_at desc);

-- ── 3) 有酸素のログ ──
create table if not exists public.ironlog_cardio (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  id         text        not null,
  date       text        not null default '',
  clock      text        not null default '',
  data       jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists ironlog_cardio_user_updated_idx
  on public.ironlog_cardio (user_id, updated_at desc);

-- ── RLS ──
alter table public.ironlog_state  enable row level security;
alter table public.ironlog_logs   enable row level security;
alter table public.ironlog_cardio enable row level security;

drop policy if exists ironlog_state_own  on public.ironlog_state;
drop policy if exists ironlog_logs_own   on public.ironlog_logs;
drop policy if exists ironlog_cardio_own on public.ironlog_cardio;

create policy ironlog_state_own on public.ironlog_state
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy ironlog_logs_own on public.ironlog_logs
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy ironlog_cardio_own on public.ironlog_cardio
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 権限（anon は完全に締め出す。自動設定に頼らず明示する） ──
revoke all on public.ironlog_state  from anon;
revoke all on public.ironlog_logs   from anon;
revoke all on public.ironlog_cardio from anon;

grant select, insert, update, delete on public.ironlog_state  to authenticated;
grant select, insert, update, delete on public.ironlog_logs   to authenticated;
grant select, insert, update, delete on public.ironlog_cardio to authenticated;

-- ── 確認用（anon で叩くと permission denied になるのが正しい） ──
-- select * from public.ironlog_logs limit 1;
