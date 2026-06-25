-- Physical structure height (ft) and opening year — distinct from rider min
-- height (`min`/`min_accompanied`, which gate eligibility). Sourced from each
-- coaster's own RCDB page (fill-speeds extended to pull these alongside speed).
alter table coasters add column height_ft numeric;
alter table coasters add column year_opened int;
