-- Restore the construction-material / track-layout taxonomy that RCDB's
-- park-listing page actually provides (e.g. "Steel" + "Sit Down") — a separate
-- axis from manufacturer/model (e.g. "B&M" + "Hyper"). An earlier pass
-- mislabeled these RCDB columns as manufacturer/model; this is the corrected,
-- additive fix (see docs/BACKLOG.md "Done" entry on the manufacturer/model split).
alter table coasters add column material text; -- Steel / Wood / Hybrid
alter table coasters add column style text;     -- Sit Down / Inverted / Suspended / Flying / Wing / …
