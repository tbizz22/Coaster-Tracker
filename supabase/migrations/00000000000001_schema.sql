-- Coaster Tracker — initial schema (Phase 1: single-household, no auth yet)
-- household_id columns are added now so Phase 2 (auth + RLS) only needs to add
-- policies, not reshape tables.

create extension if not exists "pgcrypto";

create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My Household',
  owner_user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table household_members (
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_household_id uuid references households(id) on delete set null
);

create table regions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  code text not null,
  name text not null,
  sort int not null default 0,
  unique (household_id, code)
);

-- riders/parks/coasters use client-generated text ids (the app's existing
-- uid() scheme) rather than server-generated uuids: persistence calls are
-- fire-and-forget upserts, so the id must be known client-side at insert time.
create table riders (
  id text primary key,
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  height int not null,
  color text not null default '#64748b',
  needs_companion boolean not null default false,
  sort int not null default 0
);

create table parks (
  id text primary key,
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  tag text,
  region_code text,
  badge text,
  family text,
  official_url text,
  lat double precision,
  lng double precision,
  sort int not null default 0
);

create table coasters (
  id text primary key,
  park_id text not null references parks(id) on delete cascade,
  name text not null,
  type text,
  min int,
  min_accompanied int,
  speed_mph int,
  racing boolean not null default false,
  defunct boolean not null default false,
  rcdb_id text,
  rcdb_url text,
  scale text,
  status text,
  height_source text,
  sort int not null default 0
);

create table credits (
  id uuid primary key default gen_random_uuid(),
  rider_id text not null references riders(id) on delete cascade,
  coaster_id text not null references coasters(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (rider_id, coaster_id)
);

create index idx_regions_household on regions(household_id);
create index idx_riders_household on riders(household_id);
create index idx_parks_household on parks(household_id);
create index idx_coasters_park on coasters(park_id);
create index idx_credits_rider on credits(rider_id);
create index idx_credits_coaster on credits(coaster_id);

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Every table is keyed (directly or via FK) to household_id; a row is visible
-- only if the requesting user is a member of that household. Membership check
-- is a small helper so policies stay simple and consistent across tables.

create or replace function is_household_member(hid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from household_members m
    where m.household_id = hid and m.user_id = auth.uid()
  );
$$;

alter table households enable row level security;
alter table household_members enable row level security;
alter table profiles enable row level security;
alter table regions enable row level security;
alter table riders enable row level security;
alter table parks enable row level security;
alter table coasters enable row level security;
alter table credits enable row level security;

create policy "members can read their household" on households
  for select using (is_household_member(id));
create policy "owner can update their household" on households
  for update using (owner_user_id = auth.uid());
create policy "authenticated users can create a household" on households
  for insert with check (owner_user_id = auth.uid());

create policy "members can read membership rows" on household_members
  for select using (is_household_member(household_id));
create policy "users manage their own membership row" on household_members
  for insert with check (user_id = auth.uid());

create policy "users read own profile" on profiles
  for select using (user_id = auth.uid());
create policy "users update own profile" on profiles
  for update using (user_id = auth.uid());
create policy "users insert own profile" on profiles
  for insert with check (user_id = auth.uid());

create policy "members manage regions" on regions
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy "members manage riders" on riders
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy "members manage parks" on parks
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy "members manage coasters" on coasters
  for all using (is_household_member((select household_id from parks where parks.id = coasters.park_id)))
  with check (is_household_member((select household_id from parks where parks.id = coasters.park_id)));

create policy "members manage credits" on credits
  for all using (is_household_member((select household_id from riders where riders.id = credits.rider_id)))
  with check (is_household_member((select household_id from riders where riders.id = credits.rider_id)));

-- ── New-user bootstrap ──────────────────────────────────────────────────────
-- On first sign-up, create a household + owner membership + profile so the
-- client never has to orchestrate that multi-table insert itself.

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_household_id uuid;
begin
  insert into households (name, owner_user_id) values ('My Household', new.id)
    returning id into new_household_id;
  insert into household_members (household_id, user_id, role) values (new_household_id, new.id, 'owner');
  insert into profiles (user_id, default_household_id) values (new.id, new_household_id);
  insert into regions (household_id, code, name, sort) values
    (new_household_id, 'NE', 'Northeast', 0),
    (new_household_id, 'SE', 'Southeast', 1),
    (new_household_id, 'MW', 'Midwest', 2),
    (new_household_id, 'TX', 'Texas', 3),
    (new_household_id, 'CA', 'California', 4),
    (new_household_id, 'INT', 'International', 5);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
