// `npm run dev`: starts the web app on the configured port.
import { config } from "../config.ts";
import { openDb } from "../db/db.ts";
import { loadReferenceData } from "../db/queries.ts";
import { HttpErpClient } from "../erp/poClient.ts";
import { OllamaClient } from "../extract/llm.ts";
import { createApp } from "./app.ts";

const db = openDb(config.DB_PATH);
const seeded = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'employees'`).get();
if (!seeded) {
  console.error(`No database at ${config.DB_PATH}. Run "npm run seed" first.`);
  process.exit(1);
}
const ref = loadReferenceData(db);

const app = createApp({
  db,
  ref,
  llm: new OllamaClient(config.OLLAMA_URL, config.OLLAMA_MODEL),
  erp: new HttpErpClient(config.ERP_URL),
});
app.listen(config.PORT, () => {
  console.log(`Purchase requisitions: http://localhost:${config.PORT} (LLM: ${config.OLLAMA_MODEL}, ERP: ${config.ERP_URL})`);
});
