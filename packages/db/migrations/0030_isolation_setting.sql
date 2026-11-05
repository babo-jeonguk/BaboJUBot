CREATE TABLE "execution_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"isolated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "execution_settings_singleton" CHECK ("execution_settings"."id" = 1)
);
