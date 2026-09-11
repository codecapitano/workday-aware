# Compatibility

Codex and Claude Code support automatic `UserPromptSubmit` hooks when installed and configured. Gemini CLI supports an automatic `BeforeAgent` hook when installed and configured. OpenCode uses its native context hook on a best-effort basis.

Cursor, GitHub Copilot CLI, and Windsurf are instruction-only. Other hosts are unsupported. Run `setup --preview --adapter <host>` before `setup --confirm --adapter <host>`; Skills CLI installation alone does not configure native hooks.

Hook wrappers discard standard input. The runtime never reads prompts.
