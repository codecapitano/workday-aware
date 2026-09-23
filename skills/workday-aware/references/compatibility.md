# Compatibility

Codex and Claude Code support automatic `UserPromptSubmit` hooks when installed and configured. Gemini CLI supports an automatic `BeforeAgent` hook when installed and configured. OpenCode uses its native context hook on a best-effort basis.

Pi has native support through the Pi package. The package loads the Workday Aware skill and extension. Pi provides `/workday` for phase-aware status and `workday_assess` for task assessment. The extension presents status and boundary notifications in the TUI and through Pi's UI/RPC path. It sends one wrap-up notification and one end-of-day notification per active session and local date. Its session-scoped in-process timer checks every 60 seconds and stops when Pi exits. It starts no daemon, child process, or detached process.

Cursor, GitHub Copilot CLI, and Windsurf are instruction-only. Other hosts are unsupported. For Pi, run `setup --preview` without an adapter, then replace `--preview` with `--confirm` after approval. For every other host, run `setup --preview --adapter <host>`, then replace `--preview` with `--confirm` after approval. Never pass both flags. Skills CLI installation alone does not configure native hooks.

Hook wrappers discard standard input. The runtime never reads prompts.
