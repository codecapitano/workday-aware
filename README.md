# Workday Aware

Checks whether meaningful coding-agent work fits before wrap-up and end of day.

I built it because coding agents make it too easy to keep going past the end of the day: one more test, one more fix, one more interesting idea. Workday Aware gives the agent a clear stopping point, so it can suggest a smaller final task instead of pulling you into another hour of work.

**Examples**
<img width="815" height="138" alt="Screenshot 2026-09-09 at 15 34 47" src="https://github.com/user-attachments/assets/407e5ca7-9078-4ab9-8dd0-d21149982e36" />
<img width="1042" height="145" alt="Screenshot 2026-09-09 at 16 51 17" src="https://github.com/user-attachments/assets/c9e7a02a-375d-4f8b-90b5-a67afda3edc9" />
<img width="786" height="101" alt="Screenshot 2026-09-10 at 17 58 31" src="https://github.com/user-attachments/assets/21e3bee4-5c2c-48d8-8c3f-47e35c9c30ab" />
<img width="746" height="84" alt="Screenshot 2026-09-10 at 17 59 16" src="https://github.com/user-attachments/assets/859e3bdd-e835-4084-aac6-fa493ec1fb6e" />
<img width="761" height="83" alt="Screenshot 2026-09-10 at 18 03 39" src="https://github.com/user-attachments/assets/23f46d5c-80d1-4c0d-8ac2-8db458fe8b37" />


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
