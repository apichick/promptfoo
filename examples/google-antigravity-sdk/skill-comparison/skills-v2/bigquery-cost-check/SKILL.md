---
name: bigquery-cost-check
description: Review BigQuery SQL queries for cost and partition-pruning issues before execution.
---

# BigQuery Cost Check (v2)

When reviewing a BigQuery SQL query for cost issues:

1. **Avoid `SELECT *`** (`select-star`): Flag queries that select all columns from columnar tables instead of projecting only required columns.
2. **Require Partition Filter** (`missing-partition-filter`): Flag queries on partitioned tables (such as `events` or tables partitioned by `_PARTITIONDATE` / `event_date`) that lack a `WHERE` filter on the partition column.
3. **Avoid Self-Joins on Large Fact Tables** (`unbounded-self-join`): Flag self-joins on fact tables when window functions (`LAG`, `LEAD`, `ROW_NUMBER`) can replace the join.
4. Always recommend validating estimated bytes billed with `bq query --dry_run` and setting `--maximum_bytes_billed`.
