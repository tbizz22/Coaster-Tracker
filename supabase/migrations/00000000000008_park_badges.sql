-- badge (single freeform text, never actually displayed anywhere) becomes
-- badges (text[]) so a park can carry multiple preset badges (Home Park,
-- Pass Holder, Favorite) picked from a dropdown instead of one hand-typed
-- string. Preserve any existing single value as a one-element array.
alter table parks add column badges text[] not null default '{}';
update parks set badges = array[badge] where badge is not null and badge <> '';
alter table parks drop column badge;
