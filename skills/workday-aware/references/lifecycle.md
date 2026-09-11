# Lifecycle

Run `assess --estimate <minimum>-<maximum> --kind <kind>`. Human output uses readable labels; JSON uses underscore states. If an estimate may cross wrap-up, uses wrap-up, exceeds end of day, or starts after end of day, pause for the user's decision and propose a smaller slice that fits. During wrap-up, prefer verification, cleanup, and handoff over new work, but still pause before crossing the boundary.

A current-task-only override applies only when the user explicitly requests it. State the override in the response and retain normal assessment for later tasks.
