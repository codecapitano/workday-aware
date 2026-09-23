# Security

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/codecapitano/workday-aware/security/advisories/new). This requires private vulnerability reporting to be enabled for the repository. Do not include credentials, personal schedules, or private prompts in a report.

The runtime makes no network requests, sends no telemetry, runs no daemon, child process, or detached process, exposes no Model Context Protocol (MCP) server, and never reads hook standard input or prompts. Pi uses only a session-scoped in-process timer, which checks status every 60 seconds and stops when Pi exits. Setup previews changes and requires confirmation before modifying host configuration. Removing the Pi package with `pi remove git:github.com/codecapitano/workday-aware@v1.1.0` is separate from removing Workday Aware configuration or host adapters.
