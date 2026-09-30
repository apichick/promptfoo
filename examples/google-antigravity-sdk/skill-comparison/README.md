# google-antigravity-sdk/skill-comparison (Antigravity Skill Comparison)

Compare two versions of a Google Antigravity `SKILL.md` (`skills-v1` vs `skills-v2`) side by side using the `google:antigravity-sdk` provider.

## Prerequisites

1. Install the `google-antigravity` Python package:

```bash
pip install google-antigravity
```

2. Configure Gemini / Vertex AI credentials (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, or Application Default Credentials with `vertex: true`).

## What This Example Tests

- **`skills-v1/bigquery-cost-check/SKILL.md`**: Checks only for `SELECT *` (`select-star`).
- **`skills-v2/bigquery-cost-check/SKILL.md`**: Checks for both `SELECT *` (`select-star`) and missing partition filters (`missing-partition-filter`).
- **Isolated App Data (`isolate_app_data: true`)**: Ensures user-level skills in `~/.gemini/antigravity` do not leak into the evaluation.
- **`type: skill-used` Assertion**: Verifies that the Antigravity agent actually loaded `bigquery-cost-check/SKILL.md` during its turn.

## Running the Evaluation

From the repository root:

```bash
npm run local -- eval -c examples/google-antigravity-sdk/skill-comparison/promptfooconfig.yaml --no-cache
```
