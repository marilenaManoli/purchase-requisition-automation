# Recorded model answers

`extractions/` holds the raw answers of `qwen2.5:7b` (local, via Ollama, temperature 0)
for all 48 sample emails, recorded with the final prompt by `npm run extract-all`.

They let anyone reproduce the reported results without running the model:

```bash
npm run run-all -- --saved     # full pipeline with these answers, compared with scripts/expectedOutcomes.ts
npm run seed && npm run load-saved   # fill the app's database for a demo
```

Only the model's reading is replayed; ingestion, validation, the evidence check, all
checks, the approval chain and routing run live on every replay. Each file's
`outcome.rawOutput` is exactly what the model returned. The other fields are the
validation result at recording time, for reference.
