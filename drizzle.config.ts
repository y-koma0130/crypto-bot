import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({ path: process.env["ENV_FILE"] ?? ".env.test" });

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
