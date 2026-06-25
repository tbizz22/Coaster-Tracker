-- Split coasters.type (freeform "manufacturer model" string, e.g. "B&M Inverted")
-- into real manufacturer/model columns. RCDB already separates these on the
-- source side (material/design columns), so import/scrape can populate them
-- precisely going forward instead of round-tripping through one ambiguous string.
--
-- `type` is dropped in a LATER migration (00000000000003), after
-- scripts/backfill-manufacturer-model.mjs has read every row's `type` and
-- derived manufacturer/model from it — dropping it here would destroy that
-- source data before the backfill gets a chance to run.

alter table coasters add column manufacturer text;
alter table coasters add column model text;
