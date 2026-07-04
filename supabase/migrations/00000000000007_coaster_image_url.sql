-- Add image_url to coasters for storing a Wikimedia Commons (or other freely-licensed)
-- image URL to display as a thumbnail in the mobile Plan view.
alter table coasters add column image_url text;
