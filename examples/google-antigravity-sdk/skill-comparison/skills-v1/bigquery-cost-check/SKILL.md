---
name: bigquery-cost-check
description: Review BigQuery SQL queries for basic cost issues before execution.
---

# BigQuery Cost Check (v1)

When reviewing a BigQuery SQL query for cost issues:

1. Check if the query uses `SELECT *` instead of selecting explicit columns, and report issue ID `select-star`.
2. Recommend running `--dry_run` to estimate bytes scanned before executing.
