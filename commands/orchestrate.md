---
description: Plan a feature and run it through the Gemini workers with zc
argument-hint: <what to build or fix>
---

Use the `orchestrate` skill to handle this request: $ARGUMENTS

Follow its hard rules: run `zc doctor` first, do not edit project files yourself (every change goes through `zc dispatch` to a Gemini worker), and do only what was asked.
