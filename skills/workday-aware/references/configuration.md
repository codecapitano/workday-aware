# Configuration

Configure an IANA timezone, workdays, end-of-day time, wrap-up duration, and meaningful-work threshold. The threshold is 15 minutes by default.

Pass custom values to `setup` with `--timezone`, `--work-days`, `--end-of-day`, `--wrap-up-minutes`, and `--meaningful-work-minutes`. For Pi, run `setup --preview` without an adapter, show the preview, and after approval replace `--preview` with `--confirm`. For every other host, run `setup --preview --adapter <host>`, show the preview, and after approval replace `--preview` with `--confirm --adapter <host>`. Never pass `--preview` and `--confirm` together.

Global configuration is stored under `workday-aware/config.json` in `$WORKDAY_AWARE_CONFIG_HOME`, `$XDG_CONFIG_HOME`, `~/.config`, or `%APPDATA%` on Windows. Timezones are validated against the Node.js runtime's IANA data. Reject unknown keys, invalid values, and overnight schedules.

A `.workday-aware.json` project override is read only from the Git root and only after that exact absolute Git root is added to global `trustedProjects`. After the user explicitly approves trust for a reviewed Git root, run:

```sh
node <skill-directory>/scripts/setup.mjs trust-project /absolute/path/to/repository --confirm
```

Estimates are integer minutes, such as `45-75`, and include verification and handoff.
