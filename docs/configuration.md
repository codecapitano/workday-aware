# Configuration

For normal setup, ask your agent:

```text
Set up Workday Aware. My workday ends at 17:30, with 30 minutes for wrap-up.
```

The agent previews any changes and waits for approval before writing. If you provide no custom values, Workday Aware uses the system timezone, Monday through Friday, a 17:30 end of day, a 30-minute wrap-up period, and a 15-minute meaningful-work threshold.

### Pi

Native Pi support requires Node.js 22.19 or later. Install it with:

```sh
pi install git:github.com/codecapitano/workday-aware@v1.2.1
```

The native package loads the Workday Aware skill and Pi extension. The Vercel Skills CLI is skill-only for Pi and does not load the extension. Restart Pi or run `/reload` after installing or updating the package.

Use `/workday` to display the current phase-aware status. Pi also provides `workday_assess` for task estimates. The extension presents status in the TUI and notifications through Pi's UI/RPC path. It sends at most one wrap-up and one end-of-day notification for each active session and local date. A session-scoped in-process timer checks every 60 seconds and stops when Pi exits, so no reminders continue after exit. Pi starts no daemon, child process, or detached process.

In the TUI, `/workday` shows a one-line, phase-colored summary. Expand the entry for technical details. During wrap-up and after end of day, a short indicator stays above the editor and replaces the footer status. It clears on a new workday before wrap-up, on a non-workday, or when status is unavailable. RPC clients receive plain messages and widget lines, and keep the footer status.

The `workday_assess` tool accepts an optional `task` name of up to 120 characters. Named assessments show the task, estimate, verdict, and relevant wrap-up or end-of-day time from the effective schedule. The agent asks one short approval question instead of repeating the timing. Labels do not change the assessment policy or approve work. An override still applies only to the current task.

`pi remove git:github.com/codecapitano/workday-aware@v1.2.1` removes the Pi package. It does not remove Workday Aware configuration or host adapter state. Purge the Workday configuration and installed adapter state separately with `node <skill-directory>/scripts/setup.mjs uninstall --purge --confirm`.

## Manual configuration

Global configuration is stored in `workday-aware/config.json` under `$WORKDAY_AWARE_CONFIG_HOME`, `$XDG_CONFIG_HOME`, `~/.config`, or `%APPDATA%` on Windows.

```json
{
  "version": 1,
  "timezone": "Europe/Berlin",
  "workDays": ["mon", "tue", "wed", "thu", "fri"],
  "endOfDay": "17:30",
  "wrapUpMinutes": 30,
  "meaningfulWorkMinutes": 15
}
```

## Project overrides

A project may define schedule fields in `.workday-aware.json` at its Git root. The runtime ignores that file unless the exact absolute Git root is listed in global `trustedProjects`. After reviewing a repository, tell your agent that you approve trusting that Git root for Workday Aware.

Windows drive paths and UNC paths are accepted. Unknown keys, invalid values, untrusted project files, and overnight schedules fail safely or produce a bounded warning. Timezones are validated at runtime through Node.js `Intl` against the runtime's IANA timezone data.
