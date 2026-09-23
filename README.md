# Workday Aware

Workday Aware helps coding agents respect your working hours. It estimates substantial tasks against your configured schedule, including wrap-up and end-of-day boundaries, and warns when work may run late.
You can then choose a smaller slice, defer the task, or explicitly continue, while the agent prioritizes verification, cleanup, and handoff as the day winds down.

**Examples**
<img width="786" height="101" alt="Screenshot 2026-09-10 at 17 58 31" src="https://github.com/user-attachments/assets/21e3bee4-5c2c-48d8-8c3f-47e35c9c30ab" />
<img width="746" height="84" alt="Screenshot 2026-09-10 at 17 59 16" src="https://github.com/user-attachments/assets/859e3bdd-e835-4084-aac6-fa493ec1fb6e" />
<img width="761" height="83" alt="Screenshot 2026-09-10 at 18 03 39" src="https://github.com/user-attachments/assets/23f46d5c-80d1-4c0d-8ac2-8db458fe8b37" />


## Quick start

Requirements: Node.js 20 or later and a supported coding agent. Native Pi integration requires Node.js 22.19 or later, matching Pi 0.87.1.

Install the `v1.1.0` release with the pinned Vercel Skills CLI. These default commands opt out of the Vercel audit and telemetry. npm provides the installer; GitHub provides the skill. For Pi, use the native Pi package command below. The native package loads both the skill and the Pi extension; the Vercel Skills CLI installs the skill only for Pi.

macOS/Linux:

```sh
DO_NOT_TRACK=1 npx skills@1.5.25 add https://github.com/codecapitano/workday-aware/tree/v1.1.0 --global
```

Windows PowerShell:

```powershell
$env:DO_NOT_TRACK = "1"; npx skills@1.5.25 add https://github.com/codecapitano/workday-aware/tree/v1.1.0 --global
```

For Pi, install the native package with:

```sh
pi install git:github.com/codecapitano/workday-aware@v1.1.0
```

After installing or updating a Pi package, restart Pi or run `/reload` so Pi loads the skill and extension.

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
- **Native Pi:** Pi loads the skill and extension from the native package. `/workday` shows status, and `workday_assess` assesses a task. The extension reports phase-aware status in the TUI and exposes the assessment tool through Pi's tool/RPC path.
- **Best effort:** OpenCode.
- **Instruction-only:** Cursor, GitHub Copilot CLI, and Windsurf.

Other tools are currently unsupported. Pi keeps one wrap-up notification and one end-of-day notification per active session and local date. The in-process 60-second timer stops when Pi exits, so it cannot send reminders after exit. Pi does not start a daemon, child process, or detached process.

## Privacy and security

The runtime reads only local configuration, the current time, and explicit command arguments. Hook input is discarded, and prompts are never read. Workday Aware itself has no runtime network access, telemetry, daemon, child process, detached process, or Model Context Protocol (MCP) server. Pi uses a session-scoped in-process timer that checks status every 60 seconds while the session is active; it stops when Pi exits.

For public GitHub sources, the pinned Vercel Skills CLI contacts Vercel for a pre-install audit and anonymous post-install usage telemetry. The audit sends the repository and selected skill names. Usage telemetry includes the repository, selected skill names and repository-relative paths, target agents, global-install flag, CLI version, continuous-integration marker, and detected agent. The default commands above opt out of both. Either `DO_NOT_TRACK=1` or `DISABLE_TELEMETRY=1` disables both. See the [pinned v1.5.25 telemetry source](https://github.com/vercel-labs/skills/blob/v1.5.25/src/telemetry.ts).

Your coding agent may retain the injected timezone, schedule, and status text according to its own data-retention policy. Report vulnerabilities through the [security policy](SECURITY.md).

Advanced settings and project overrides are documented in [configuration](docs/configuration.md). Contributions are welcome under the [contribution guidelines](CONTRIBUTING.md).

Licensed under the [MIT License](LICENSE).
