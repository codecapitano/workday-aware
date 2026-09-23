import { Type } from 'typebox';

import {
  assessStatus,
  buildWorkdayGuidance,
  createBoundaryTracker,
  formatFooterStatus,
  resolveStatus,
} from './runtime.mjs';

const STATUS_KEY = 'workday-aware';
const REFRESH_INTERVAL_MS = 60_000;
const KINDS = ['implementation', 'research', 'verification', 'cleanup', 'handoff'];

export default function workdayAwareExtension(pi) {
  let interval;
  let tracker;

  const stopTimer = () => {
    if (interval) clearInterval(interval);
    interval = undefined;
  };

  const statusFor = (ctx) => resolveStatus({ cwd: ctx.cwd });

  const refresh = (ctx, { notify = true } = {}) => {
    try {
      const status = statusFor(ctx);
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, formatFooterStatus(status));
      if (!tracker) tracker = createBoundaryTracker(status);
      else if (notify && ctx.hasUI) {
        for (const boundary of tracker.update(status)) {
          const message = boundary === 'wrap_up' ? 'Workday wrap-up has started.' : 'The configured workday has ended.';
          ctx.ui.notify(message, 'warning');
        }
      }
      return status;
    } catch {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, 'Workday: status unavailable');
      return undefined;
    }
  };

  pi.registerTool({
    name: 'workday_assess',
    label: 'Workday assessment',
    description: 'Assess a pessimistic task-duration estimate against the configured wrap-up and end-of-day boundaries.',
    promptSnippet: 'Assess meaningful work against the configured workday',
    parameters: Type.Object({
      minimumMinutes: Type.Integer({ minimum: 0, description: 'Pessimistic minimum duration in minutes' }),
      maximumMinutes: Type.Optional(Type.Integer({ minimum: 0, description: 'Pessimistic maximum duration in minutes; defaults to the minimum' })),
      kind: Type.Union(KINDS.map((kind) => Type.Literal(kind))),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const status = statusFor(ctx);
        const input = {
          minMinutes: params.minimumMinutes,
          maxMinutes: params.maximumMinutes ?? params.minimumMinutes,
          kind: params.kind,
        };
        const result = assessStatus(status, input);
        return {
          content: [{ type: 'text', text: result.text }],
          details: { status, assessment: result.assessment },
        };
      } catch {
        return {
          content: [{ type: 'text', text: 'Workday status is unavailable.' }],
          details: { status: 'status_unavailable' },
        };
      }
    },
  });

  pi.registerCommand('workday', {
    description: 'Show the current Workday Aware status',
    handler: async (_args, ctx) => {
      const status = refresh(ctx, { notify: false });
      if (ctx.hasUI) ctx.ui.notify(status ? buildWorkdayGuidance(status) : 'Workday status is unavailable.', status ? 'info' : 'warning');
    },
  });

  pi.on('before_agent_start', (event, ctx) => {
    try {
      event.systemPromptOptions.sections.workday_aware = buildWorkdayGuidance(statusFor(ctx));
    } catch {
      // Fail open: unavailable workday context must not block the agent.
    }
  });

  pi.on('session_start', (_event, ctx) => {
    stopTimer();
    tracker = undefined;
    refresh(ctx, { notify: false });
    if (!ctx.hasUI) return;
    interval = setInterval(() => refresh(ctx), REFRESH_INTERVAL_MS);
    interval.unref?.();
  });

  pi.on('agent_settled', (_event, ctx) => {
    refresh(ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    stopTimer();
    tracker = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
