-- Meu bolso: tudo com prefixo bolso_ para não esbarrar nas tabelas dos outros apps.
-- Não cria trigger em auth.users (ele dispararia para usuários de outros apps).
create table if not exists bolso_admins (user_id uuid primary key references auth.users(id) on delete cascade);

create or replace function bolso_is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from bolso_admins where user_id = auth.uid()) $$;

create table if not exists bolso_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  plan text not null default 'none' check (plan in ('none','premium','plus')),
  plan_until timestamptz,
  trial_until timestamptz,
  ref_code text unique not null default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7)),
  referred_by uuid references bolso_profiles(id) on delete set null,
  consent_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists bolso_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}', updated_at timestamptz not null default now()
);
create table if not exists bolso_push_subs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text unique not null, sub jsonb not null, created_at timestamptz not null default now()
);
create table if not exists bolso_banners (
  id bigint generated always as identity primary key,
  title text not null, body text, tone text not null default 'good' check (tone in ('good','warn','bad','info')),
  active boolean not null default true, starts_at timestamptz not null default now(), ends_at timestamptz
);
create table if not exists bolso_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('admin','ai')),
  role text not null check (role in ('user','admin','assistant')),
  body text not null, created_at timestamptz not null default now()
);

create or replace function bolso_has_access() returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from bolso_profiles where id = auth.uid()
   and (trial_until > now() or (plan <> 'none' and (plan_until is null or plan_until > now())))) $$;

-- Cria o perfil na primeira entrada. Quem veio por link ganha 30 dias grátis.
create or replace function bolso_ensure_profile(p_name text, p_ref text default null)
returns bolso_profiles language plpgsql security definer set search_path = public as $$
declare r bolso_profiles; refid uuid;
begin
  select * into r from bolso_profiles where id = auth.uid();
  if found then return r; end if;
  if p_ref is not null then select id into refid from bolso_profiles where ref_code = upper(p_ref) and id <> auth.uid(); end if;
  insert into bolso_profiles(id, name, referred_by, trial_until, consent_at)
  values (auth.uid(), left(coalesce(p_name,'Você'), 60), refid, case when refid is not null then now() + interval '30 days' end, now())
  returning * into r;
  return r;
end $$;

create or replace function bolso_ref_count() returns int language sql stable security definer set search_path = public as
$$ select count(*)::int from bolso_profiles where referred_by = auth.uid() $$;

revoke all on function bolso_is_admin(), bolso_has_access(), bolso_ensure_profile(text,text), bolso_ref_count() from public, anon;
grant execute on function bolso_is_admin(), bolso_has_access(), bolso_ensure_profile(text,text), bolso_ref_count() to authenticated;

alter table bolso_admins enable row level security;
alter table bolso_profiles enable row level security;
alter table bolso_state enable row level security;
alter table bolso_push_subs enable row level security;
alter table bolso_banners enable row level security;
alter table bolso_messages enable row level security;

-- Perfil: só leitura do próprio. Plano e período só mudam pelo servidor (service role).
create policy "perfil proprio" on bolso_profiles for select to authenticated using (id = auth.uid() or bolso_is_admin());
-- Dados financeiros: só o dono lê e grava. Admin NÃO lê.
create policy "estado proprio" on bolso_state for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "push proprio" on bolso_push_subs for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "banners ativos" on bolso_banners for select to authenticated
  using (active and starts_at <= now() and (ends_at is null or ends_at > now()));
create policy "banners admin" on bolso_banners for all to authenticated using (bolso_is_admin()) with check (bolso_is_admin());
create policy "msgs leitura" on bolso_messages for select to authenticated using (user_id = auth.uid() or bolso_is_admin());
create policy "msgs usuario envia" on bolso_messages for insert to authenticated
  with check (user_id = auth.uid() and channel = 'admin' and role = 'user' and bolso_has_access());
create policy "msgs admin envia" on bolso_messages for insert to authenticated with check (bolso_is_admin() and role = 'admin' and channel = 'admin');
