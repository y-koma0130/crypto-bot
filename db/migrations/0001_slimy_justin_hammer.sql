ALTER TABLE "trades" ADD COLUMN "partial_exit_price" numeric;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "partial_amount" numeric;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "partial_pnl" numeric;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "partial_at" timestamp with time zone;