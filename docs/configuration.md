# Configuration

For normal setup, ask your agent:

```text
Set up Workday Aware. My workday ends at 17:30, with 30 minutes for wrap-up.
```

The agent previews any changes and waits for approval before writing. If you provide no custom values, Workday Aware uses the system timezone, Monday through Friday, a 17:30 end of day, a 30-minute wrap-up period, and a 15-minute meaningful-work threshold.

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
