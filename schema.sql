-- Loku Tuning — Supabase / Postgres スキーマ
-- Loku本体DBに同居させる前提。既存の tenants(店) / friends(友だち) / friend_tags を参照する。
-- 汎用計測レイヤ: page × box を単位にし、ページ種別(LP/予約/EC/メニュー…)に依存しない。
-- 命名は loku_attn_* で本体と衝突回避。

-- ========== 既存想定（Lokuに既にあるもの・参照のみ） ==========
-- tenants(id uuid, ...)              店舗テナント
-- friends(id uuid, tenant_id, ...)   LINE友だち（実名側）
-- friend_tags(friend_id, tag text)   Loku既存のタグ資産（付与先はここ）

-- ========== 計測対象ページ ==========
create table if not exists loku_attn_pages (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,                 -- references tenants(id)
  kind         text not null default 'lp',    -- lp | reserve | ec | menu | campaign | shop ...
  slug         text not null,                 -- テナント内で一意なページキー
  url          text,                          -- 公開URL（Search Console 突合用）
  route_tag    text,                          -- 到達で即付与する流入タグ（例: 整体LP-A 流入）
  created_at   timestamptz not null default now(),
  unique (tenant_id, slug)
);

-- ページ内のボックス定義（セクション/画像/価格表/CTA…）
create table if not exists loku_attn_boxes (
  id            uuid primary key default gen_random_uuid(),
  page_id       uuid not null references loku_attn_pages(id) on delete cascade,
  box_key       text not null,                -- 'hero' 'pricing' 'beforeafter' ...
  label         text not null,
  box_type      text not null default 'text', -- text | image | price
  expected_sec  numeric not null default 3.0, -- 読了目安秒（text=文字数/8.3 等で算出して格納）
  ord           int not null default 0,
  unique (page_id, box_key)
);

-- ========== セッション（匿名） ==========
create table if not exists loku_attn_sessions (
  id            uuid primary key default gen_random_uuid(),
  anon_id       text not null,                -- SDKが発行する1st-party ID
  tenant_id     uuid not null,
  page_id       uuid not null references loku_attn_pages(id),
  -- サチコ層（来る前）: 突合できたら埋める。無ければ null
  entry_query   text,
  entry_pos     numeric,
  device        text,
  referrer      text,
  utm           jsonb,
  active_sec    numeric not null default 0,   -- ページ全体のアクティブ計測時間
  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (anon_id, page_id)
);
create index if not exists idx_attn_sessions_anon on loku_attn_sessions(anon_id);

-- ボックス毎の集計（1セッション×1ボックス＝1行、SDKからバッチ更新）
create table if not exists loku_attn_box_stats (
  session_id    uuid not null references loku_attn_sessions(id) on delete cascade,
  box_id        uuid not null references loku_attn_boxes(id) on delete cascade,
  active_view   numeric not null default 0,   -- 視認秒（4ゲート通過分の積算）
  engagement    numeric not null default 0,   -- 0-100 = active_view / expected_sec *100（上限100）
  revisits      int not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (session_id, box_id)
);

-- ========== 匿名 → 実名 の結合 ==========
create table if not exists loku_attn_identity (
  anon_id         text primary key,           -- セッションの anon_id
  friend_id       uuid not null,              -- references friends(id)
  tenant_id       uuid not null,
  consented       boolean not null default false, -- オプトイン同意（非同意は結合しない）
  purpose         text,                       -- 利用目的（個人情報保護法：特定・通知）
  consent_version text,                        -- 同意した文面バージョン（監査用）
  merged_at       timestamptz not null default now()
);
create index if not exists idx_attn_identity_friend on loku_attn_identity(friend_id);

-- ★要配慮個人情報（症状・診断等の健康情報）は保存しない。
--   collect 側で stripSensitive() により剥がす（compliance.mjs）。本テーブル群は行動データのみ。
-- ★忘れられる権利/オプトアウト（/api/attn/forget 相当）:
--   friend_id 指定でまとめて削除する例。
--   delete from loku_attn_box_stats bs using loku_attn_sessions s, loku_attn_identity i
--     where bs.session_id=s.id and s.anon_id=i.anon_id and i.friend_id=:fid;
--   delete from loku_attn_sessions s using loku_attn_identity i where s.anon_id=i.anon_id and i.friend_id=:fid;
--   delete from loku_attn_tag_fires where friend_id=:fid;
--   delete from loku_attn_identity where friend_id=:fid;
--   -- 付与済みタグ（friend_tags）の撤回は Loku 本体側の delete で行う。

-- ========== タグ設計（事前ルール） ==========
create table if not exists loku_attn_tag_rules (
  id         uuid primary key default gen_random_uuid(),
  page_id    uuid not null references loku_attn_pages(id) on delete cascade,
  kind       text not null default 'heat',    -- route | heat | aggregate
  box_key    text,                            -- heat時: 対象ボックス
  threshold  numeric default 60,              -- heat: engagement>=threshold / aggregate: 平均>=threshold
  tag        text not null,                   -- 付与するタグ名（Loku friend_tags に入る）
  active     boolean not null default true
);

-- 発火ログ（監査・重複付与防止）
create table if not exists loku_attn_tag_fires (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references loku_attn_sessions(id) on delete cascade,
  rule_id    uuid references loku_attn_tag_rules(id),
  tag        text not null,
  friend_id  uuid,                            -- 結合後に埋まる
  fired_at   timestamptz not null default now()
);

-- ========== Search Console（無料API・日次バッチ） ==========
create table if not exists loku_attn_search_console_daily (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  page_id     uuid references loku_attn_pages(id),
  date        date not null,
  query       text not null,
  impressions int not null default 0,
  clicks      int not null default 0,
  ctr         numeric,
  position    numeric,
  unique (tenant_id, page_id, date, query)
);

-- ========== 結合ビュー: 友だち×来訪ジャーニー（UIの1画面用） ==========
create or replace view loku_attn_friend_journey as
select
  i.friend_id,
  s.tenant_id,
  p.slug          as page_slug,
  p.kind          as page_kind,
  s.entry_query,                       -- 来る前
  s.entry_pos,
  s.device,
  s.active_sec,
  jsonb_object_agg(b.box_key, bs.engagement) as box_engagement,  -- 来た後
  s.started_at
from loku_attn_identity i
join loku_attn_sessions s  on s.anon_id = i.anon_id
join loku_attn_pages p     on p.id = s.page_id
join loku_attn_box_stats bs on bs.session_id = s.id
join loku_attn_boxes b     on b.id = bs.box_id
where i.consented = true
group by i.friend_id, s.tenant_id, p.slug, p.kind,
         s.entry_query, s.entry_pos, s.device, s.active_sec, s.started_at;

-- ========== 安全管理措置：RLS（個人情報保護法対応） ==========
-- 店は自テナントのみ参照。collect は service role で書込み、参照は tenant スコープに限定。
-- 例（sessions に適用。他テーブルも同様に tenant_id 経由で張る）:
--   alter table loku_attn_sessions enable row level security;
--   create policy tenant_read on loku_attn_sessions
--     for select using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
--   -- 書込みは service_role キーのみ（RLSバイパス）。匿名/anonロールには insert/update を与えない。
-- 保持期間：box_stats/sessions は保持方針に従い定期削除（例 24ヶ月）。cron で古い行を purge。
