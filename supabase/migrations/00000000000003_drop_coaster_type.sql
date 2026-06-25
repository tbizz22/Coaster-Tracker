-- Run only after scripts/backfill-manufacturer-model.mjs has populated
-- manufacturer/model for every existing coaster row (see 00000000000002).
-- Confirmed: 254/254 coasters backfilled, 57 matched a known manufacturer,
-- 197 left manufacturer blank with the original descriptor preserved in model.
alter table coasters drop column type;
