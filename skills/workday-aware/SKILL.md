---
name: workday-aware
description: Assess non-trivial agent work against the user's configured meaningful-work threshold, wrap-up time, and end of day. Do not use for brief replies or clearly trivial actions.
---

Before non-trivial work, make a pessimistic estimate that includes implementation, verification, and handoff. Read the meaningful-work threshold from the latest injected Workday status. If no status is present, resolve this skill's directory and run `node <skill-directory>/scripts/workday-aware.mjs status --json` first. If the estimate's maximum is below the configured threshold, continue without an assessment. Otherwise run `node <skill-directory>/scripts/workday-aware.mjs assess --estimate <minimum>-<maximum> --kind <kind>` and report its current status before starting. Valid kinds are `implementation`, `research`, `verification`, `cleanup`, and `handoff`.

If the assessment says the work does not fit, pause for a conversational decision. Do not split or defer work without the user's direction. A user can explicitly request a current-task-only override; apply it only to that task, report the override, and continue without changing future-task behavior.

When asked to configure a host, resolve this skill's directory and run `node <skill-directory>/scripts/setup.mjs setup --preview --adapter <host>`. Show the symbolic preview and wait for explicit approval before rerunning it with `--confirm`. Valid hosts are `codex`, `claude-code`, `gemini-cli`, `opencode`, `cursor`, `copilot`, and `windsurf`.

For configuration, read [configuration](references/configuration.md). For host support, read [compatibility](references/compatibility.md). For lifecycle and exceptions, read [lifecycle](references/lifecycle.md).
