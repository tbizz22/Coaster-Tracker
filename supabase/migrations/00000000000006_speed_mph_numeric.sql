-- speed_mph was declared `int` in the original schema, but km/h-sourced speeds
-- get converted with one decimal place (Math.round(kmh * 0.621371 * 10) / 10),
-- e.g. 21.7 mph — which a plain integer column rejects. Only affects metric
-- parks (Canada's Wonderland, etc.), which is why most updates succeeded and
-- a consistent subset failed every time with "invalid input syntax for integer".
alter table coasters alter column speed_mph type numeric;
