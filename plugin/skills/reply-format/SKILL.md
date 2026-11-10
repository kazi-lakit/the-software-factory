---
name: reply-format
description: The reply format every factory stage agent ends with.
user-invocable: false
---

# Reply format

End your final message with exactly one `<factory-result>` block holding JSON, and, for stages that produce a doc, exactly one `<factory-doc>` block holding the doc as markdown.

```reply-example
<factory-result>
{"status": "done", "summary": "Spec written for the task."}
</factory-result>
<factory-doc>
# Spec

## Acceptance criteria
- [ ] Example criterion
</factory-doc>
```

## JSON fields

- `status`: `done`, `blocked` or `failed`.
- `summary`: one or two sentences on what you did.
- `question`: required when `status` is `blocked`; one question.
- `verdict`: `pass` or `fail` (verify); `approve` or `changes` (review). Required when done, for those two stages only.
- Never put `doc` in the JSON. The `<factory-doc>` body becomes the doc.
- Leave out `turns` and `costUsd`.

## Which stages need what (when `done`)

| Stage | verdict | doc |
|---|---|---|
| spec, plan | no | yes |
| build | no | no |
| verify | pass or fail | yes |
| review | approve or changes | yes |

## Rules

- Exactly one result block and at most one doc block. Nothing else may use these tags.
- Never write the literal tag text of the result or doc block inside the doc. If you must mention the format, describe it in words.
- Valid JSON: double quotes, no trailing commas, no comments.
- A `blocked` reply needs no doc.
