-- Per-household additions to the coaster Manufacturer dropdown/datalist.
-- MANUFACTURER_OPTIONS in credit-tracker.jsx stays the hardcoded built-in set
-- (major manufacturers everyone benefits from); this table lets a household
-- add its own (small/regional builders not worth shipping to every user).
create table custom_manufacturers (
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  sort int not null default 0,
  primary key (household_id, name)
);

alter table custom_manufacturers enable row level security;

create policy "members manage custom manufacturers" on custom_manufacturers
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));
