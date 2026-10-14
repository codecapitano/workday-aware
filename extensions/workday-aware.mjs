import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import {
  assessStatus,
  buildWorkdayGuidance,
  createBoundaryTracker,
  formatFooterStatus,
  resolveStatus,
} from './runtime.mjs';
import { createWorkdayAssessPresentation } from './presentation.mjs';
import { createWorkdayStatusPresentation, formatWorkdayStatus } from './status-presentation.mjs';

const STATUS_KEY = 'workday-aware';
const STATUS_ENTRY_TYPE = 'workday-status';
const REFRESH_INTERVAL_MS = 60_000;
const KINDS = ['implementation', 'research', 'verification', 'cleanup', 'handoff'];

function loadPresentations() {
  if (![visibleWidth, truncateToWidth, wrapTextWithAnsi].every((fn) => typeof fn === 'function')) return {};
  const helpers = { visibleWidth, truncateToWidth, wrapTextWithAnsi };
  return { assessment: createWorkdayAssessPresentation(helpers), status: createWorkdayStatusPresentation(helpers) };
}

export default function workdayAwareExtension(pi) {
  const { assessment: presentation, status: statusPresentation } = loadPresentations();
  const canRenderStatus = statusPresentation && typeof pi.registerEntryRenderer === 'function' && typeof pi.appendEntry === 'function';
  if (canRenderStatus) {
    // Custom entries appear in the transcript without entering model context or starting a turn.
    pi.registerEntryRenderer(STATUS_ENTRY_TYPE, (entry, options, theme) => statusPresentation.renderMessage({ details: entry.data }, options, theme));
  }
  let interval;
  let tracker;

  const stopTimer = () => {
    if (interval) clearInterval(interval);
    interval = undefined;
  };

  const statusFor = (ctx) => resolveStatus({ cwd: ctx.cwd });

  const updateWidget = (ctx, status) => {
    if (!ctx.hasUI) return;
    const show = status?.phase === 'wrap_up' || status?.phase === 'after_eod';
    if (!show) {
      ctx.ui.setWidget(STATUS_KEY, undefined);
    } else if (ctx.mode === 'tui' && statusPresentation) {
      ctx.ui.setWidget(STATUS_KEY, (_tui, theme) => statusPresentation.renderWidget(status, theme), { placement: 'aboveEditor' });
    } else {
      // RPC clients support plain widget lines, not terminal component factories.
      ctx.ui.setWidget(STATUS_KEY, formatWorkdayStatus(status).split('\n'), { placement: 'aboveEditor' });
    }
  };

  const refresh = (ctx, { notify = true } = {}) => {
    let status;
    try {
      status = statusFor(ctx);
    } catch {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, 'Workday: status unavailable');
      updateWidget(ctx, undefined);
      return undefined;
    }
    if (ctx.hasUI) {
      const hasBanner = ctx.mode === 'tui' && (status.phase === 'wrap_up' || status.phase === 'after_eod');
      ctx.ui.setStatus(STATUS_KEY, hasBanner ? undefined : formatFooterStatus(status));
    }
    updateWidget(ctx, status);
    if (!tracker) tracker = createBoundaryTracker(status);
    else if (notify && ctx.hasUI) {
      for (const boundary of tracker.update(status)) {
        const message = boundary === 'wrap_up' ? 'Workday wrap-up has started.' : 'The configured workday has ended.';
        ctx.ui.notify(message, 'warning');
      }
    }
    return status;
  };

  pi.registerTool({
    name: 'workday_assess',
    label: 'Workday assessment',
    description: 'Assess a pessimistic task-duration estimate against the configured wrap-up and end-of-day boundaries.',
    promptSnippet: 'Assess meaningful work against the configured workday',
    ...presentation,
    parameters: Type.Object({
      minimumMinutes: Type.Integer({ minimum: 0, description: 'Pessimistic minimum duration in minutes' }),
      maximumMinutes: Type.Optional(Type.Integer({ minimum: 0, description: 'Pessimistic maximum duration in minutes; defaults to the minimum' })),
      kind: Type.Union(KINDS.map((kind) => Type.Literal(kind))),
      task: Type.Optional(Type.String({ maxLength: 120, description: 'Short task name to highlight in the assessment, such as Investigate Workday UX' })),
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
          details: { status, assessment: result.assessment, ...(params.task?.trim() ? { task: params.task } : {}) },
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
      if (!ctx.hasUI) return;
      if (ctx.mode === 'tui' && canRenderStatus) {
        pi.appendEntry(STATUS_ENTRY_TYPE, { status });
      } else {
        const caution = !status || status.phase === 'wrap_up' || status.phase === 'after_eod';
        ctx.ui.notify(formatWorkdayStatus(status), caution ? 'warning' : 'info');
      }
    },
  });

  pi.on('before_agent_start', (event, ctx) => {
    try {
      event.systemPromptOptions.sections.workday_aware = buildWorkdayGuidance(statusFor(ctx), { conciseUI: ctx.mode === 'tui' });
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
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(STATUS_KEY, undefined);
    }
  });
}
