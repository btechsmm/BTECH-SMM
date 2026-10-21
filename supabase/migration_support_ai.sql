-- ============================================================================
-- BTECH CUSTOMER SUPPORT — AI assistant, conversations, ticket workflow, admin
-- ----------------------------------------------------------------------------
-- Run after schema.sql (support_tickets / support_messages) and migration_insights.sql.
-- Additive and idempotent. Existing tickets and messages are preserved.
--
-- DESIGN
--  * Reuses support_tickets / support_messages; adds the missing columns.
--  * Customers can no longer insert tickets/messages directly. That closed a hole where a
--    customer could insert a message with sender = 'support' (a forged staff reply). All
--    writes go through the SECURITY DEFINER functions below, which use auth.uid().
--  * The Edge Function runs every customer lookup and ticket creation with the CUSTOMER'S OWN
--    JWT, so row-level security enforces ownership. The service-role key is only used for the
--    five support_chat_* / support_ai_* functions that write conversation and usage rows.
--  * Priority is decided by support_priority_rules from the ticket category, never by the
--    browser or the AI. Ticket creation never approves refunds, credits wallets, cancels
--    orders or pays commissions.
--  * Internal notes are support_messages with visibility = 'internal'. Customer policies and
--    the Edge Function never read them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tickets and messages: extend, do not replace
-- ---------------------------------------------------------------------------
alter table public.support_tickets
  add column if not exists category text not null default 'general',
  add column if not exists priority text not null default 'normal',
  add column if not exists assigned_to uuid references auth.users(id),
  add column if not exists assigned_team text,
  add column if not exists ai_summary text,
  add column if not exists conversation_id uuid,
  add column if not exists related_order_id text,
  add column if not exists related_amount numeric,
  add column if not exists source text not null default 'form',
  add column if not exists idempotency_key text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution text,
  add column if not exists reopened_count integer not null default 0;

alter table public.support_tickets drop constraint if exists support_tickets_status_check;
alter table public.support_tickets add constraint support_tickets_status_check
  check (status in ('open', 'in_progress', 'awaiting_customer', 'resolved', 'closed'));
alter table public.support_tickets drop constraint if exists support_tickets_category_check;
alter table public.support_tickets add constraint support_tickets_category_check
  check (category in ('general', 'account', 'service', 'order', 'payment', 'refund', 'cancellation', 'security', 'other'));
alter table public.support_tickets drop constraint if exists support_tickets_priority_check;
alter table public.support_tickets add constraint support_tickets_priority_check
  check (priority in ('low', 'normal', 'high', 'urgent'));
alter table public.support_tickets drop constraint if exists support_tickets_source_check;
alter table public.support_tickets add constraint support_tickets_source_check check (source in ('form', 'ai_chat'));

create unique index if not exists support_tickets_idem_uq on public.support_tickets (user_id, idempotency_key) where idempotency_key is not null;
create index if not exists support_tickets_status_idx on public.support_tickets (status, priority, created_at desc);
create index if not exists support_tickets_user_idx on public.support_tickets (user_id, created_at desc);

alter table public.support_messages
  add column if not exists visibility text not null default 'customer' check (visibility in ('customer', 'internal')),
  add column if not exists author_id uuid references auth.users(id);
create index if not exists support_messages_ticket_idx on public.support_messages (ticket_id, created_at);

-- Customers read their own tickets and the customer-visible messages only. No direct writes.
drop policy if exists "tickets_insert_own" on public.support_tickets;
drop policy if exists "ticket_messages_insert_own" on public.support_messages;
drop policy if exists "ticket_messages_select_own" on public.support_messages;
create policy "ticket_messages_select_own" on public.support_messages
  for select using (
    visibility = 'customer'
    and exists (select 1 from public.support_tickets t where t.id = ticket_id and t.user_id = auth.uid())
  );
drop policy if exists "tickets_select_admin" on public.support_tickets;
create policy "tickets_select_admin" on public.support_tickets for select using (public.is_admin());
drop policy if exists "ticket_messages_select_admin" on public.support_messages;
create policy "ticket_messages_select_admin" on public.support_messages for select using (public.is_admin());

-- Audit trail of ticket changes (staff-visible only)
create table if not exists public.support_ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id text not null references public.support_tickets(id) on delete cascade,
  actor_id uuid references auth.users(id),
  event text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists support_ticket_events_ticket_idx on public.support_ticket_events (ticket_id, created_at);
alter table public.support_ticket_events enable row level security;
drop policy if exists support_ticket_events_admin on public.support_ticket_events;
create policy support_ticket_events_admin on public.support_ticket_events for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 2. Settings, priority rules, knowledge base
-- ---------------------------------------------------------------------------
create table if not exists public.support_settings (
  id boolean primary key default true check (id),
  ai_enabled boolean not null default true,
  model text not null default 'claude-haiku-5-5',
  max_input_chars integer not null default 800 check (max_input_chars between 100 and 4000),
  max_history_messages integer not null default 8 check (max_history_messages between 0 and 30),
  max_output_tokens integer not null default 600 check (max_output_tokens between 100 and 2000),
  per_user_limit integer not null default 20 check (per_user_limit between 1 and 500),
  per_user_window_minutes integer not null default 60 check (per_user_window_minutes between 1 and 1440),
  per_user_daily_limit integer not null default 100 check (per_user_daily_limit between 1 and 2000),
  global_daily_limit integer not null default 3000 check (global_daily_limit between 1 and 100000),
  max_open_tickets integer not null default 5 check (max_open_tickets between 1 and 50),
  web_search_enabled boolean not null default false,
  web_search_domains text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.support_settings (id) values (true) on conflict (id) do nothing;
alter table public.support_settings enable row level security;
drop policy if exists support_settings_admin on public.support_settings;
create policy support_settings_admin on public.support_settings for select using (public.is_admin());

create table if not exists public.support_priority_rules (
  category text primary key check (category in ('general', 'account', 'service', 'order', 'payment', 'refund', 'cancellation', 'security', 'other')),
  priority text not null check (priority in ('low', 'normal', 'high', 'urgent')),
  updated_at timestamptz not null default now()
);
insert into public.support_priority_rules (category, priority) values
  ('general', 'low'), ('other', 'normal'), ('account', 'normal'), ('service', 'normal'), ('order', 'normal'),
  ('refund', 'normal'), ('cancellation', 'normal'), ('payment', 'high'), ('security', 'urgent')
on conflict (category) do nothing;
alter table public.support_priority_rules enable row level security;
drop policy if exists support_priority_rules_admin on public.support_priority_rules;
create policy support_priority_rules_admin on public.support_priority_rules for select using (public.is_admin());

create table if not exists public.support_kb (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  title text not null check (length(trim(title)) between 3 and 140),
  body text not null check (length(trim(body)) between 10 and 2500),
  keywords text not null default '',
  active boolean not null default true,
  source text not null default 'admin',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
alter table public.support_kb enable row level security;
drop policy if exists support_kb_read on public.support_kb;
create policy support_kb_read on public.support_kb for select to authenticated using (active or public.is_admin());

-- ---------------------------------------------------------------------------
-- 3. Conversations, chat messages, usage
-- ---------------------------------------------------------------------------
create table if not exists public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation',
  ticket_id text references public.support_tickets(id) on delete set null,
  feedback_rating smallint check (feedback_rating between 1 and 5),
  feedback_comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists support_conversations_user_idx on public.support_conversations (user_id, updated_at desc);

create table if not exists public.support_chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists support_chat_messages_conv_idx on public.support_chat_messages (conversation_id, created_at);

create table if not exists public.support_ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  conversation_id uuid,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists support_ai_usage_user_idx on public.support_ai_usage (user_id, created_at desc);
create index if not exists support_ai_usage_time_idx on public.support_ai_usage (created_at desc);

alter table public.support_conversations enable row level security;
alter table public.support_chat_messages enable row level security;
alter table public.support_ai_usage enable row level security;
drop policy if exists support_conversations_own on public.support_conversations;
create policy support_conversations_own on public.support_conversations for select using (auth.uid() = user_id or public.is_admin());
drop policy if exists support_chat_messages_own on public.support_chat_messages;
create policy support_chat_messages_own on public.support_chat_messages for select using (auth.uid() = user_id or public.is_admin());
drop policy if exists support_ai_usage_admin on public.support_ai_usage;
create policy support_ai_usage_admin on public.support_ai_usage for select using (public.is_admin());

-- No client writes anywhere on the new tables: only the functions below write.
revoke insert, update, delete on
  public.support_settings, public.support_priority_rules, public.support_kb, public.support_conversations,
  public.support_chat_messages, public.support_ai_usage, public.support_ticket_events,
  public.support_tickets, public.support_messages
from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------
create or replace function public.support_clean(p text, p_max integer)
returns text
language sql
immutable
as $$
  select left(trim(regexp_replace(coalesce(p, ''), '[\x00-\x08\x0B\x0C\x0E-\x1F]', '', 'g')), p_max);
$$;

create or replace function public.support_new_ticket_id()
returns text
language plpgsql
as $$
declare
  v text;
begin
  loop
    v := 'TCK-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from public.support_tickets where id = v);
  end loop;
  return v;
end;
$$;
revoke execute on function public.support_clean(text, integer) from public, anon, authenticated;
revoke execute on function public.support_new_ticket_id() from public, anon, authenticated;

create or replace function public.support_notify(p_user uuid, p_title text, p_text text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notifications (user_id, type, title, text) values (p_user, 'system', p_title, p_text);
$$;
revoke execute on function public.support_notify(uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Customer functions (identity always from auth.uid())
-- ---------------------------------------------------------------------------
create or replace function public.support_public_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('ai_enabled', s.ai_enabled, 'max_input_chars', s.max_input_chars) from public.support_settings s where s.id;
$$;

-- Creates a ticket (or reuses one for the same unresolved issue). Never moves money or changes orders.
create or replace function public.support_create_ticket(
  p_subject text, p_message text, p_category text default 'general', p_order_id text default null,
  p_conversation_id uuid default null, p_ai_summary text default null, p_idempotency_key text default null,
  p_source text default 'form')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_subject text := public.support_clean(p_subject, 120);
  v_msg text := public.support_clean(p_message, 2000);
  v_cat text := coalesce(nullif(trim(p_category), ''), 'general');
  v_pri text;
  v_order public.orders;
  v_ticket public.support_tickets;
  v_open integer;
  v_max integer;
  v_conv uuid;
begin
  if v_uid is null then raise exception 'Please sign in to contact support.'; end if;
  if length(v_subject) < 4 then raise exception 'Please enter a short subject (at least 4 characters).'; end if;
  if length(v_msg) < 10 then raise exception 'Please describe the issue in a little more detail.'; end if;
  if v_cat not in ('general', 'account', 'service', 'order', 'payment', 'refund', 'cancellation', 'security', 'other') then v_cat := 'general'; end if;
  if p_source not in ('form', 'ai_chat') then p_source := 'form'; end if;

  -- Same submission twice (double click, retry): return the ticket already created.
  if p_idempotency_key is not null then
    select * into v_ticket from public.support_tickets where user_id = v_uid and idempotency_key = left(p_idempotency_key, 80);
    if found then
      return jsonb_build_object('ticket_id', v_ticket.id, 'reused', true, 'status', v_ticket.status, 'priority', v_ticket.priority);
    end if;
  end if;

  -- Only an order that really belongs to this customer may be linked; the amount comes from the order.
  if p_order_id is not null then
    select * into v_order from public.orders where id = p_order_id and user_id = v_uid;
  end if;

  -- Same unresolved issue (same category and order): add to the existing ticket instead of opening another.
  if v_order.id is not null then
    select * into v_ticket from public.support_tickets
     where user_id = v_uid and related_order_id = v_order.id and category = v_cat and status in ('open', 'in_progress', 'awaiting_customer')
     order by created_at desc limit 1;
    if found then
      insert into public.support_messages (ticket_id, sender, message, author_id) values (v_ticket.id, 'user', v_msg, v_uid);
      update public.support_tickets set updated_at = now(), status = case when status = 'awaiting_customer' then 'open' else status end where id = v_ticket.id;
      insert into public.support_ticket_events (ticket_id, actor_id, event, detail) values (v_ticket.id, v_uid, 'customer_followup', jsonb_build_object('via', p_source));
      return jsonb_build_object('ticket_id', v_ticket.id, 'reused', true, 'status', v_ticket.status, 'priority', v_ticket.priority);
    end if;
  end if;

  select max_open_tickets into v_max from public.support_settings where id;
  select count(*) into v_open from public.support_tickets where user_id = v_uid and status in ('open', 'in_progress', 'awaiting_customer');
  if v_open >= coalesce(v_max, 5) then
    raise exception 'You already have % open support requests. Please wait for a reply or add to an existing one.', v_open;
  end if;
  if (select count(*) from public.support_tickets where user_id = v_uid and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many requests in a short time. Please try again later.';
  end if;

  select priority into v_pri from public.support_priority_rules where category = v_cat;
  v_pri := coalesce(v_pri, 'normal');

  if p_conversation_id is not null and exists (select 1 from public.support_conversations where id = p_conversation_id and user_id = v_uid) then
    v_conv := p_conversation_id;
  end if;

  insert into public.support_tickets (id, user_id, subject, status, category, priority, ai_summary, conversation_id, related_order_id, related_amount, source, idempotency_key)
  values (public.support_new_ticket_id(), v_uid, v_subject, 'open', v_cat, v_pri, nullif(public.support_clean(p_ai_summary, 600), ''), v_conv,
          v_order.id, v_order.amount, p_source, left(p_idempotency_key, 80))
  returning * into v_ticket;

  insert into public.support_messages (ticket_id, sender, message, author_id) values (v_ticket.id, 'user', v_msg, v_uid);
  insert into public.support_ticket_events (ticket_id, actor_id, event, detail)
  values (v_ticket.id, v_uid, 'created', jsonb_build_object('source', p_source, 'category', v_cat, 'priority', v_pri));
  if v_conv is not null then update public.support_conversations set ticket_id = v_ticket.id, updated_at = now() where id = v_conv; end if;

  return jsonb_build_object('ticket_id', v_ticket.id, 'reused', false, 'status', 'open', 'priority', v_pri);
end;
$$;

create or replace function public.support_ticket_reply(p_ticket_id text, p_message text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  t public.support_tickets;
  v_msg text := public.support_clean(p_message, 2000);
begin
  if v_uid is null then raise exception 'Please sign in.'; end if;
  if length(v_msg) < 2 then raise exception 'Please type a message.'; end if;
  select * into t from public.support_tickets where id = p_ticket_id and user_id = v_uid for update;
  if not found then raise exception 'Ticket not found.'; end if;
  if t.status = 'closed' then raise exception 'This request is closed. Please open a new request.'; end if;
  if (select count(*) from public.support_messages where ticket_id = t.id and sender = 'user' and created_at > now() - interval '10 minutes') >= 8 then
    raise exception 'Too many messages in a short time. Please wait a few minutes.';
  end if;
  insert into public.support_messages (ticket_id, sender, message, author_id) values (t.id, 'user', v_msg, v_uid);
  update public.support_tickets
     set updated_at = now(),
         status = case when status in ('awaiting_customer', 'resolved') then 'open' else status end,
         reopened_count = reopened_count + (case when status = 'resolved' then 1 else 0 end),
         resolved_at = case when status = 'resolved' then null else resolved_at end
   where id = t.id;
  insert into public.support_ticket_events (ticket_id, actor_id, event) values (t.id, v_uid, 'customer_reply');
  return jsonb_build_object('ticket_id', t.id);
end;
$$;

create or replace function public.support_conversation_feedback(p_conversation uuid, p_rating integer, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'Rating must be 1 to 5.'; end if;
  update public.support_conversations
     set feedback_rating = p_rating, feedback_comment = nullif(public.support_clean(p_comment, 500), ''), updated_at = now()
   where id = p_conversation and user_id = auth.uid();
  if not found then raise exception 'Conversation not found.'; end if;
end;
$$;

-- Keyword retrieval over approved entries (no vector store). Returns a few short entries.
create or replace function public.support_kb_search(p_query text, p_limit integer default 4)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_words text[];
begin
  if auth.uid() is null then return '[]'::jsonb; end if;
  select coalesce(array_agg(distinct w), '{}') into v_words
    from regexp_split_to_table(lower(public.support_clean(p_query, 400)), '[^a-z0-9À-ɏ]+') w
   where length(w) >= 3;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'body', r.body) order by r.score desc, r.updated_at desc)
    from (
      select k.id, k.title, k.body, k.updated_at,
             (select count(*) from unnest(v_words) w
               where lower(k.title || ' ' || k.keywords) like '%' || w || '%') * 3
             + (select count(*) from unnest(v_words) w where lower(k.body) like '%' || w || '%') as score
        from public.support_kb k where k.active
       order by score desc, k.updated_at desc limit least(greatest(coalesce(p_limit, 4), 1), 6)
    ) r where r.score > 0), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Functions for the Edge Function only (service role). p_user always comes from the verified JWT.
-- ---------------------------------------------------------------------------
create or replace function public.support_ai_quota(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.support_settings;
  v_win integer;
  v_day integer;
  v_all integer;
  v_oldest timestamptz;
begin
  select * into s from public.support_settings where id;
  if not s.ai_enabled then
    return jsonb_build_object('allowed', false, 'reason', 'disabled', 'settings', to_jsonb(s));
  end if;
  select count(*), min(created_at) into v_win, v_oldest from public.support_ai_usage
   where user_id = p_user and created_at > now() - make_interval(mins => s.per_user_window_minutes);
  select count(*) into v_day from public.support_ai_usage where user_id = p_user and created_at > now() - interval '24 hours';
  select count(*) into v_all from public.support_ai_usage where created_at > now() - interval '24 hours';
  if v_all >= s.global_daily_limit then
    return jsonb_build_object('allowed', false, 'reason', 'global_limit', 'settings', to_jsonb(s));
  end if;
  if v_day >= s.per_user_daily_limit then
    return jsonb_build_object('allowed', false, 'reason', 'daily_limit', 'settings', to_jsonb(s));
  end if;
  if v_win >= s.per_user_limit then
    return jsonb_build_object('allowed', false, 'reason', 'rate_limit',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_oldest + make_interval(mins => s.per_user_window_minutes) - now())))::integer),
      'settings', to_jsonb(s));
  end if;
  return jsonb_build_object('allowed', true, 'settings', to_jsonb(s));
end;
$$;

create or replace function public.support_chat_begin(p_user uuid, p_conversation uuid, p_title text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v uuid;
begin
  if p_conversation is not null then
    select id into v from public.support_conversations where id = p_conversation and user_id = p_user;
    if not found then raise exception 'Conversation not found.'; end if;
    return v;
  end if;
  insert into public.support_conversations (user_id, title) values (p_user, coalesce(nullif(left(trim(coalesce(p_title, '')), 60), ''), 'New conversation')) returning id into v;
  return v;
end;
$$;

create or replace function public.support_chat_append(p_user uuid, p_conv uuid, p_role text, p_content text, p_meta jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.support_conversations where id = p_conv and user_id = p_user) then raise exception 'Conversation not found.'; end if;
  insert into public.support_chat_messages (conversation_id, user_id, role, content, meta) values (p_conv, p_user, p_role, left(p_content, 6000), p_meta);
  update public.support_conversations set updated_at = now() where id = p_conv;
end;
$$;

create or replace function public.support_chat_history(p_user uuid, p_conv uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content) order by m.created_at), '[]'::jsonb)
  from (select role, content, created_at from public.support_chat_messages
         where conversation_id = p_conv and user_id = p_user order by created_at desc limit greatest(p_limit, 0)) m;
$$;

create or replace function public.support_ai_log_usage(p_user uuid, p_conv uuid, p_in integer, p_out integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.support_ai_usage (user_id, conversation_id, input_tokens, output_tokens) values (p_user, p_conv, greatest(p_in, 0), greatest(p_out, 0));
$$;

-- ---------------------------------------------------------------------------
-- 7. Admin functions (is_admin() re-checked inside every one)
-- ---------------------------------------------------------------------------
create or replace function public.admin_support_staff()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'email', email) order by name) from public.profiles where role = 'admin'), '[]'::jsonb);
end;
$$;

create or replace function public.admin_support_list(
  p_status text default null, p_priority text default null, p_category text default null,
  p_search text default null, p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q text := lower(trim(coalesce(p_search, '')));
  v_total integer;
  v_rows jsonb;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  with f as (
    select t.*, p.name as customer_name, p.email as customer_email
      from public.support_tickets t left join public.profiles p on p.id = t.user_id
     where (coalesce(p_status, '') = '' or (p_status = 'active' and t.status in ('open', 'in_progress', 'awaiting_customer')) or t.status = p_status)
       and (coalesce(p_priority, '') = '' or t.priority = p_priority)
       and (coalesce(p_category, '') = '' or t.category = p_category)
       and (v_q = '' or lower(t.id) like '%' || v_q || '%' or lower(t.subject) like '%' || v_q || '%'
            or lower(coalesce(p.email, '')) like '%' || v_q || '%' or lower(coalesce(p.name, '')) like '%' || v_q || '%'
            or lower(coalesce(t.related_order_id, '')) like '%' || v_q || '%')
  )
  select (select count(*) from f),
         coalesce((select jsonb_agg(r) from (
           select id, subject, status, category, priority, assigned_to, assigned_team, source, related_order_id, created_at, updated_at,
                  customer_name, customer_email,
                  (select count(*) from public.support_messages m where m.ticket_id = f.id and m.visibility = 'customer') as messages
             from f
            order by case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
                     case when status in ('open', 'in_progress', 'awaiting_customer') then 0 else 1 end, updated_at desc
            limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)) r), '[]'::jsonb)
    into v_total, v_rows;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

create or replace function public.admin_support_get(p_ticket text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t public.support_tickets;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select * into t from public.support_tickets where id = p_ticket;
  if not found then raise exception 'Ticket not found.'; end if;
  return jsonb_build_object(
    'ticket', to_jsonb(t),
    'customer', (select jsonb_build_object('name', name, 'email', email, 'phone', phone) from public.profiles where id = t.user_id),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'sender', m.sender, 'visibility', m.visibility, 'message', m.message, 'created_at', m.created_at,
                  'author', (select name from public.profiles where id = m.author_id)) order by m.created_at)
                from public.support_messages m where m.ticket_id = t.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'detail', e.detail, 'created_at', e.created_at,
                  'actor', (select name from public.profiles where id = e.actor_id)) order by e.created_at)
                from public.support_ticket_events e where e.ticket_id = t.id), '[]'::jsonb),
    'conversation', coalesce((select jsonb_agg(jsonb_build_object('role', c.role, 'content', c.content, 'created_at', c.created_at) order by c.created_at)
                from (select * from public.support_chat_messages where conversation_id = t.conversation_id order by created_at desc limit 40) c), '[]'::jsonb));
end;
$$;

-- Reply to the customer (visible), or ask for more information (also sets awaiting_customer).
create or replace function public.admin_support_reply(p_ticket text, p_message text, p_kind text default 'reply')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.support_tickets;
  v_msg text := public.support_clean(p_message, 2000);
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if length(v_msg) < 2 then raise exception 'Type a message first.'; end if;
  select * into t from public.support_tickets where id = p_ticket for update;
  if not found then raise exception 'Ticket not found.'; end if;
  if t.status = 'closed' then raise exception 'Reopen this ticket before replying.'; end if;
  insert into public.support_messages (ticket_id, sender, message, visibility, author_id) values (t.id, 'support', v_msg, 'customer', auth.uid());
  update public.support_tickets set updated_at = now(),
         status = case when p_kind = 'info_request' then 'awaiting_customer' when status = 'open' then 'in_progress' else status end,
         assigned_to = coalesce(assigned_to, auth.uid())
   where id = t.id;
  insert into public.support_ticket_events (ticket_id, actor_id, event) values (t.id, auth.uid(), case when p_kind = 'info_request' then 'info_requested' else 'staff_reply' end);
  perform public.support_notify(t.user_id, case when p_kind = 'info_request' then 'Support needs more information' else 'New reply from BTECH Support' end,
                                'Ticket ' || t.id || ' has an update. Open Support to read it.');
end;
$$;

create or replace function public.admin_support_note(p_ticket text, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text := public.support_clean(p_note, 2000);
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if length(v_note) < 2 then raise exception 'Type a note first.'; end if;
  if not exists (select 1 from public.support_tickets where id = p_ticket) then raise exception 'Ticket not found.'; end if;
  insert into public.support_messages (ticket_id, sender, message, visibility, author_id) values (p_ticket, 'support', v_note, 'internal', auth.uid());
  insert into public.support_ticket_events (ticket_id, actor_id, event) values (p_ticket, auth.uid(), 'internal_note');
end;
$$;

-- action: assign | status | priority | team | escalate | resolve | reopen | close
create or replace function public.admin_support_set(p_ticket text, p_action text, p_value text default null, p_resolution text default null)
returns public.support_tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.support_tickets;
  v_old jsonb;
  v_next text;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select * into t from public.support_tickets where id = p_ticket for update;
  if not found then raise exception 'Ticket not found.'; end if;
  v_old := jsonb_build_object('status', t.status, 'priority', t.priority, 'assigned_to', t.assigned_to, 'team', t.assigned_team);

  if p_action = 'assign' then
    if p_value is not null and p_value <> '' and not exists (select 1 from public.profiles where id = p_value::uuid and role = 'admin') then raise exception 'Choose a staff member.'; end if;
    update public.support_tickets set assigned_to = nullif(p_value, '')::uuid, updated_at = now() where id = t.id returning * into t;
  elsif p_action = 'team' then
    update public.support_tickets set assigned_team = nullif(public.support_clean(p_value, 60), ''), updated_at = now() where id = t.id returning * into t;
  elsif p_action = 'priority' then
    if p_value not in ('low', 'normal', 'high', 'urgent') then raise exception 'Invalid priority.'; end if;
    update public.support_tickets set priority = p_value, updated_at = now() where id = t.id returning * into t;
  elsif p_action = 'status' then
    if p_value not in ('open', 'in_progress', 'awaiting_customer') then raise exception 'Use Resolve or Close to finish a ticket.'; end if;
    update public.support_tickets set status = p_value, updated_at = now() where id = t.id returning * into t;
  elsif p_action = 'escalate' then
    v_next := case t.priority when 'low' then 'normal' when 'normal' then 'high' else 'urgent' end;
    update public.support_tickets set priority = v_next, assigned_team = coalesce(nullif(public.support_clean(p_value, 60), ''), 'Senior support'), updated_at = now() where id = t.id returning * into t;
  elsif p_action = 'resolve' then
    if length(public.support_clean(p_resolution, 1000)) < 5 then raise exception 'Describe how this was resolved.'; end if;
    update public.support_tickets set status = 'resolved', resolution = public.support_clean(p_resolution, 1000), resolved_at = now(), updated_at = now() where id = t.id returning * into t;
    insert into public.support_messages (ticket_id, sender, message, author_id) values (t.id, 'support', 'Resolved: ' || t.resolution, auth.uid());
    perform public.support_notify(t.user_id, 'Your support request was resolved', 'Ticket ' || t.id || ' was marked resolved. Reply on the ticket if you still need help.');
  elsif p_action = 'reopen' then
    update public.support_tickets set status = 'open', resolved_at = null, reopened_count = reopened_count + 1, updated_at = now() where id = t.id and status in ('resolved', 'closed') returning * into t;
  elsif p_action = 'close' then
    update public.support_tickets set status = 'closed', updated_at = now() where id = t.id returning * into t;
  else
    raise exception 'Unknown action.';
  end if;

  insert into public.support_ticket_events (ticket_id, actor_id, event, detail)
  values (t.id, auth.uid(), p_action, jsonb_build_object('before', v_old, 'value', p_value));
  perform public.audit_log('support_' || p_action, 'support_ticket', t.id, v_old,
                           jsonb_build_object('status', t.status, 'priority', t.priority, 'assigned_to', t.assigned_to, 'team', t.assigned_team), p_value);
  return t;
end;
$$;

create or replace function public.admin_support_kb_save(p_id uuid, p_topic text, p_title text, p_body text, p_keywords text, p_active boolean)
returns public.support_kb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.support_kb;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  if p_id is null then
    insert into public.support_kb (topic, title, body, keywords, active, source, updated_by)
    values (public.support_clean(p_topic, 40), public.support_clean(p_title, 140), public.support_clean(p_body, 2500), public.support_clean(p_keywords, 400), coalesce(p_active, true), 'admin', auth.uid())
    returning * into r;
  else
    update public.support_kb set topic = public.support_clean(p_topic, 40), title = public.support_clean(p_title, 140), body = public.support_clean(p_body, 2500),
           keywords = public.support_clean(p_keywords, 400), active = coalesce(p_active, active), source = 'admin', updated_at = now(), updated_by = auth.uid()
     where id = p_id returning * into r;
    if not found then raise exception 'Entry not found.'; end if;
  end if;
  perform public.audit_log('support_kb_save', 'support_kb', r.id::text, null, jsonb_build_object('title', r.title, 'active', r.active), null);
  return r;
end;
$$;

create or replace function public.admin_support_kb_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return coalesce((select jsonb_agg(to_jsonb(k) order by k.topic, k.title) from public.support_kb k), '[]'::jsonb);
end;
$$;

create or replace function public.admin_support_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object('settings', (select to_jsonb(s) from public.support_settings s where id),
                            'rules', (select coalesce(jsonb_agg(to_jsonb(r) order by r.category), '[]'::jsonb) from public.support_priority_rules r));
end;
$$;

create or replace function public.admin_support_settings_update(p_patch jsonb, p_rules jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  k text;
  v_old jsonb;
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  select to_jsonb(s) into v_old from public.support_settings s where id;
  update public.support_settings set
    ai_enabled = coalesce((p_patch->>'ai_enabled')::boolean, ai_enabled),
    model = coalesce(nullif(left(p_patch->>'model', 80), ''), model),
    max_input_chars = coalesce((p_patch->>'max_input_chars')::integer, max_input_chars),
    max_history_messages = coalesce((p_patch->>'max_history_messages')::integer, max_history_messages),
    max_output_tokens = coalesce((p_patch->>'max_output_tokens')::integer, max_output_tokens),
    per_user_limit = coalesce((p_patch->>'per_user_limit')::integer, per_user_limit),
    per_user_window_minutes = coalesce((p_patch->>'per_user_window_minutes')::integer, per_user_window_minutes),
    per_user_daily_limit = coalesce((p_patch->>'per_user_daily_limit')::integer, per_user_daily_limit),
    global_daily_limit = coalesce((p_patch->>'global_daily_limit')::integer, global_daily_limit),
    max_open_tickets = coalesce((p_patch->>'max_open_tickets')::integer, max_open_tickets),
    web_search_enabled = coalesce((p_patch->>'web_search_enabled')::boolean, web_search_enabled),
    web_search_domains = coalesce(case when p_patch ? 'web_search_domains' then array(select jsonb_array_elements_text(p_patch->'web_search_domains')) end, web_search_domains),
    updated_at = now(), updated_by = auth.uid()
  where id;
  if p_rules is not null then
    for k in select jsonb_object_keys(p_rules) loop
      update public.support_priority_rules set priority = p_rules->>k, updated_at = now() where category = k;
    end loop;
  end if;
  perform public.audit_log('support_settings_update', 'support_settings', 'singleton', v_old, p_patch, null);
end;
$$;

create or replace function public.admin_support_analytics(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admin access required.'; end if;
  return jsonb_build_object(
    'tickets', (select count(*) from public.support_tickets where created_at >= p_from and created_at < p_to),
    'tickets_from_ai', (select count(*) from public.support_tickets where source = 'ai_chat' and created_at >= p_from and created_at < p_to),
    'open_now', (select count(*) from public.support_tickets where status in ('open', 'in_progress', 'awaiting_customer')),
    'by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.support_tickets where created_at >= p_from and created_at < p_to group by 1) x),
    'by_category', (select coalesce(jsonb_object_agg(category, n), '{}'::jsonb) from (select category, count(*) n from public.support_tickets where created_at >= p_from and created_at < p_to group by 1) x),
    'by_priority', (select coalesce(jsonb_object_agg(priority, n), '{}'::jsonb) from (select priority, count(*) n from public.support_tickets where created_at >= p_from and created_at < p_to group by 1) x),
    'avg_first_reply_hours', (select round(avg(extract(epoch from (fr.at - t.created_at)) / 3600.0)::numeric, 1)
                               from public.support_tickets t
                               join lateral (select min(created_at) as at from public.support_messages m where m.ticket_id = t.id and m.sender = 'support' and m.visibility = 'customer') fr on fr.at is not null
                              where t.created_at >= p_from and t.created_at < p_to),
    'conversations', (select count(*) from public.support_conversations where created_at >= p_from and created_at < p_to),
    'ai_messages', (select count(*) from public.support_ai_usage where created_at >= p_from and created_at < p_to),
    'input_tokens', (select coalesce(sum(input_tokens), 0) from public.support_ai_usage where created_at >= p_from and created_at < p_to),
    'output_tokens', (select coalesce(sum(output_tokens), 0) from public.support_ai_usage where created_at >= p_from and created_at < p_to),
    'feedback_avg', (select round(avg(feedback_rating)::numeric, 2) from public.support_conversations where feedback_rating is not null and created_at >= p_from and created_at < p_to),
    'feedback_count', (select count(*) from public.support_conversations where feedback_rating is not null and created_at >= p_from and created_at < p_to));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Approved starter knowledge base (only facts verifiable from the application code)
--    Anything BTECH has not published (delivery times, refill/guarantee rules, prices) is deliberately absent.
-- ---------------------------------------------------------------------------
insert into public.support_kb (topic, title, body, keywords, source)
select * from (values
 ('platform', 'Creating an account and logging in',
  'You can register with your email and a password, or continue with Google. After you log in you can reach your dashboard, orders, wallet, rewards and ambassador pages from the left menu.',
  'register sign up signup create account login log in google password jisajili ingia akaunti', 'code'),
 ('orders', 'How to place an order',
  'Open Services, choose a service, enter your target link and the quantity (it must be between the service minimum and maximum), then confirm. The order is created as unpaid and you pay for it with your wallet balance or M-Pesa. Prices and limits are shown on the service page.',
  'place order buy order new order how to order agiza oda order service quantity link', 'code'),
 ('orders', 'Order statuses and tracking',
  'Each order shows a status of pending, processing, completed or cancelled, a payment status of unpaid, paid or refunded, and a progress indicator. You can see them on the Orders page and on each order''s details page.',
  'order status track tracking pending processing completed cancelled progress where is my order oda hali', 'code'),
 ('orders', 'Delayed orders',
  'First check the order''s status and progress on its details page. BTECH SMM has not published a guaranteed delivery time, so the assistant cannot promise one. If the order still looks stuck, offer to send it to human support so staff can check it.',
  'delay delayed slow late not started stuck taking long order haijafika imechelewa', 'code'),
 ('wallet', 'Wallet deposits with M-Pesa',
  'On the Wallet page enter an amount and your M-Pesa number to receive a payment prompt on your phone. The wallet is credited after the payment is confirmed. A prompt you cancel or that fails is not counted as a deposit. You can spend wallet balance on orders.',
  'wallet deposit top up topup mpesa m-pesa stk prompt pay add money weka pesa', 'code'),
 ('wallet', 'Money taken but wallet not credited',
  'If M-Pesa confirmed a payment to you but your wallet balance did not change, do not pay again. Check the transaction list on the Wallet page, then ask for human support and include the M-Pesa receipt code so staff can investigate.',
  'charged deducted missing not credited balance wrong pending deposit failed payment pesa imekatwa', 'code'),
 ('security', 'Never share PINs, OTPs or passwords',
  'BTECH SMM staff and this assistant never ask for your M-Pesa PIN, one-time codes or account password. Do not share them with anyone. If you think someone accessed your account or made a transaction you did not make, ask for human support immediately and change your password.',
  'pin otp password hacked unauthorized stolen fraud scam security compromised nimeibiwa', 'code'),
 ('orders', 'Cancelling an order',
  'You can request a cancellation from the order''s details page while the order is pending or processing. Staff review the request. The assistant cannot cancel an order itself.',
  'cancel cancellation stop order ghairi futa', 'code'),
 ('orders', 'Refund requests',
  'You can request a refund from an order''s details page (cancelled orders cannot be refunded). Staff review each request and you are notified of the decision. The assistant cannot approve a refund itself.',
  'refund money back return reimburse rudisha pesa', 'code'),
 ('loyalty', 'Rewards and loyalty',
  'The Loyalty & Rewards page shows your points and level if the rewards programme is switched on. Points are earned on qualifying orders and some levels give a discount on eligible services. Your own status is on that page.',
  'loyalty rewards points level discount tier pointi zawadi', 'code'),
 ('ambassador', 'Ambassador programme',
  'You can apply on the Ambassador page. Approved ambassadors get a referral link and code. Commission is earned on qualifying orders from referred customers and becomes available after a hold period. Withdrawals are requested on the Ambassador page and reviewed by staff before payment. The current rates, hold period and minimum are shown on that page.',
  'ambassador referral commission withdraw affiliate refer earn balozi', 'code'),
 ('contact', 'Contacting BTECH SMM',
  'You can email btech.smm1@gmail.com or message WhatsApp support on +254112887428. You can also ask here for human support and a support request will be created that you can track on the Support page.',
  'contact human agent support whatsapp email phone call speak person mtu msaada', 'code'),
 ('policy-gap', 'Policies BTECH SMM has not published',
  'BTECH SMM has not published delivery time estimates, refill guarantees, or drop-protection rules in this assistant''s approved knowledge. Do not state any. Say that you do not have an official answer and offer to send the question to human support.',
  'guarantee refill drop warranty how long delivery time speed days hours eta', 'code')
) as v(topic, title, body, keywords, source)
where not exists (select 1 from public.support_kb);

-- ---------------------------------------------------------------------------
-- 9. Execute permissions
-- ---------------------------------------------------------------------------
revoke execute on function
  public.support_public_status(), public.support_create_ticket(text, text, text, text, uuid, text, text, text),
  public.support_ticket_reply(text, text), public.support_conversation_feedback(uuid, integer, text), public.support_kb_search(text, integer),
  public.admin_support_staff(), public.admin_support_list(text, text, text, text, integer, integer), public.admin_support_get(text),
  public.admin_support_reply(text, text, text), public.admin_support_note(text, text), public.admin_support_set(text, text, text, text),
  public.admin_support_kb_save(uuid, text, text, text, text, boolean), public.admin_support_kb_list(), public.admin_support_settings_get(),
  public.admin_support_settings_update(jsonb, jsonb), public.admin_support_analytics(timestamptz, timestamptz)
from public, anon;
grant execute on function
  public.support_public_status(), public.support_create_ticket(text, text, text, text, uuid, text, text, text),
  public.support_ticket_reply(text, text), public.support_conversation_feedback(uuid, integer, text), public.support_kb_search(text, integer),
  public.admin_support_staff(), public.admin_support_list(text, text, text, text, integer, integer), public.admin_support_get(text),
  public.admin_support_reply(text, text, text), public.admin_support_note(text, text), public.admin_support_set(text, text, text, text),
  public.admin_support_kb_save(uuid, text, text, text, text, boolean), public.admin_support_kb_list(), public.admin_support_settings_get(),
  public.admin_support_settings_update(jsonb, jsonb), public.admin_support_analytics(timestamptz, timestamptz)
to authenticated;

-- Edge Function only (service role): never callable from a browser.
revoke execute on function
  public.support_ai_quota(uuid), public.support_chat_begin(uuid, uuid, text), public.support_chat_append(uuid, uuid, text, text, jsonb),
  public.support_chat_history(uuid, uuid, integer), public.support_ai_log_usage(uuid, uuid, integer, integer)
from public, anon, authenticated;
grant execute on function
  public.support_ai_quota(uuid), public.support_chat_begin(uuid, uuid, text), public.support_chat_append(uuid, uuid, text, text, jsonb),
  public.support_chat_history(uuid, uuid, integer), public.support_ai_log_usage(uuid, uuid, integer, integer)
to service_role;

-- ============================================================================
-- End of migration.
-- ============================================================================
