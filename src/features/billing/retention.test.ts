import { expect, test } from "vitest";
import { BILLING_RECORD_RETENTION_MONTHS, billingRetentionEndsAt } from "./retention";

test.each([
  ["2025-08-31T12:34:56.789Z", "2027-02-28T12:34:56.789Z"],
  ["2022-08-31T23:59:59.999Z", "2024-02-29T23:59:59.999Z"],
  ["2024-02-29T00:00:00.000Z", "2025-08-29T00:00:00.000Z"],
  ["2025-12-31T00:00:00.000Z", "2027-06-30T00:00:00.000Z"],
])("clamps eighteen UTC months from %s", (from, to) => {
  expect(BILLING_RECORD_RETENTION_MONTHS).toBe(18);
  expect(billingRetentionEndsAt(Date.parse(from))).toBe(Date.parse(to));
});
