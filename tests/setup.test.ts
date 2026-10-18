import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";

// Step 0 smoke test: proves the test runner, TypeScript and the sample data
// are all in place. Replaced by real module tests from step 1 on.
describe("project setup", () => {
  it("has the 48 sample emails and 21 quotes from the brief", () => {
    const emails = readdirSync("data/emails").filter((f) => f.endsWith(".eml"));
    const quotes = readdirSync("data/quotes").filter((f) => f.endsWith(".pdf"));
    expect(emails).toHaveLength(48);
    expect(quotes).toHaveLength(21);
  });
});
