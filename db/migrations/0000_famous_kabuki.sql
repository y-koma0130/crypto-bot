CREATE TABLE "bot_status" (
	"bot_name" text PRIMARY KEY NOT NULL,
	"is_active" boolean DEFAULT true,
	"is_halted" boolean DEFAULT false,
	"last_run_at" timestamp with time zone,
	"current_position" jsonb
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_name" text NOT NULL,
	"symbol" text NOT NULL,
	"signal" text NOT NULL,
	"reasoning" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_name" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"amount" numeric NOT NULL,
	"entry_price" numeric NOT NULL,
	"exit_price" numeric,
	"pnl" numeric,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"closed_at" timestamp with time zone
);
