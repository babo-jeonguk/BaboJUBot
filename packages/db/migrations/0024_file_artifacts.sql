ALTER TABLE artifacts ADD COLUMN file jsonb;
ALTER TABLE artifacts ADD COLUMN file_bytes text;
ALTER TABLE artifacts DROP CONSTRAINT artifacts_format_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_format_check CHECK (format IN ('markdown', 'text', 'binary'));
ALTER TABLE artifacts ADD CONSTRAINT artifacts_file_snapshot_check CHECK ((file IS NULL) = (file_bytes IS NULL));
