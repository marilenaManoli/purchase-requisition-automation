import { z } from "zod";

// All settings come from environment variables (loaded from .env by the npm
// scripts). Every value has a safe local default, so a fresh clone runs
// without a .env file. Read config from here, never from process.env directly.
const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().min(1).default("./data/app.db"),
  OLLAMA_URL: z.url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().min(1).default("qwen2.5:7b"),
  ERP_URL: z.url().default("http://127.0.0.1:8080"),
});

export type Config = z.infer<typeof ConfigSchema>;

// .parse throws on an invalid value (e.g. PORT=abc), so a bad setting
// stops the app at startup instead of failing later in some request.
export const config: Config = ConfigSchema.parse(process.env);
