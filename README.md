# Workday Aware

Checks whether meaningful coding-agent work fits before wrap-up and end of day.

I built it because coding agents make it too easy to keep going past the end of the day: one more test, one more fix, one more interesting idea. Workday Aware gives the agent a clear stopping point, so it can suggest a smaller final task instead of pulling you into another hour of work.

## Quick start

Requirements: Node.js 20 or later and a supported coding agent.

Install the `v1.0.0` release with the pinned Vercel Skills CLI. npm provides the installer; GitHub provides the skill:

```sh
npx skills@1.5.25 add https://github.com/codecapitano/workday-aware/tree/v1.0.0 --global
```

Then ask the agent:

```text
Set up Workday Aware.
```

The agent detects the active tool and system timezone, previews the files and settings it would change, and waits for approval before writing.

You can configure the schedule conversationally:

```text
Set up Workday Aware. My workday ends at 17:30, with 30 minutes for wrap-up.
```

Without custom values, Workday Aware uses the system timezone, Monday through Friday, a 17:30 end of day, and a 30-minute wrap-up period.

## Compatibility

- **Automatic:** Codex, Claude Code, and Gemini CLI.
- **Best effort:** OpenCode.
- **Instruction-only:** Cursor, GitHub Copilot CLI, and Windsurf.

Other tools are currently unsupported.

## Privacy and security

The runtime reads only local configuration, the current time, and explicit command arguments. Hook input is discarded, and prompts are never read. Workday Aware itself has no runtime network access, telemetry, daemon, or Model Context Protocol (MCP) server.

For public GitHub sources, the pinned Vercel Skills CLI contacts Vercel for a pre-install audit and anonymous post-install usage telemetry. The audit sends the repository and selected skill names. Usage telemetry includes the repository, selected skill names and repository-relative paths, target agents, global-install flag, CLI version, continuous-integration marker, and detected agent. Set `DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1` when running the installer to opt out of both. See the [pinned v1.5.25 telemetry source](https://github.com/vercel-labs/skills/blob/v1.5.25/src/telemetry.ts).

Your coding agent may retain the injected timezone, schedule, and status text according to its own data-retention policy. Report vulnerabilities through the [security policy](SECURITY.md).

Advanced settings and project overrides are documented in [configuration](docs/configuration.md). Contributions are welcome under the [contribution guidelines](CONTRIBUTING.md).

Licensed under the [MIT License](LICENSE).
