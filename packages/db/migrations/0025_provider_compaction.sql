CREATE TABLE "compaction_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"threshold_tokens" integer NOT NULL,
	"ratio_percent" double precision NOT NULL,
	CONSTRAINT "compaction_settings_singleton" CHECK ("compaction_settings"."id" = 1),
	CONSTRAINT "compaction_threshold_range" CHECK ("compaction_settings"."threshold_tokens" between 50000 and 1000000),
	CONSTRAINT "compaction_ratio_range" CHECK ("compaction_settings"."ratio_percent" between 50 and 95)
);
