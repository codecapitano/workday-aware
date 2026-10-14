const MAX_WIDTH = 80;
const MIN_WIDTH = 8;

const VERDICTS = {
  fits_before_wrap_up: { label: 'Fits before wrap-up', color: 'success' },
  may_fit: { label: 'May cross wrap-up', color: 'warning' },
  uses_wrap_up: { label: 'Uses wrap-up', color: 'warning' },
  exceeds_eod: { label: 'Exceeds end of day', color: 'error' },
  after_eod: { label: 'Past end of day', color: 'error' },
  no_boundary: { label: 'No workday boundary', color: 'muted' },
  unavailable: { label: 'Status unavailable', color: 'warning' },
  pending: { label: 'Assessing…', color: 'muted' },
  failed: { label: 'Assessment failed', color: 'error' },
  plain: { label: 'Assessment', color: 'muted' },
};

const ASSESSMENT_STATES = new Set(['fits_before_wrap_up', 'may_fit', 'uses_wrap_up', 'exceeds_eod', 'after_eod', 'no_boundary']);

const GUIDANCE = {
  may_fit: 'Reduce the scope or approve working into wrap-up.',
  uses_wrap_up: 'Reduce the scope or approve working into wrap-up.',
  exceeds_eod: 'Reduce the scope or approve working past end of day.',
  after_eod: 'Approve this task to work past end of day.',
};

const empty = Object.freeze({ render: () => [], invalidate() {} });

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const clean = (value) => String(value ?? '').replaceAll('\t', ' ').replace(CONTROL, '');
const isMinutes = (value) => Number.isInteger(value) && value >= 0;
const isClock = (value) => typeof value === 'string' && value.length > 0;

const plural = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'}`;

function remaining(minutes) {
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${plural(hours, 'hour')} ${plural(rest, 'minute')}` : plural(hours, 'hour');
}

function minutesOfText(text) {
  const match = /^(?:(\d+)h)?(?: ?(\d+)m)?$/.exec(text.trim());
  return match && (match[1] || match[2]) ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : undefined;
}

function estimateText(minimum, maximum) {
  return minimum === maximum ? plural(minimum, 'minute') : `${minimum}–${maximum} minutes`;
}

export function createWorkdayAssessPresentation({ visibleWidth, truncateToWidth, wrapTextWithAnsi }) {
  const fit = (text, width) => (visibleWidth(text) <= width ? text : truncateToWidth(text, width));
  const wrap = (text, width) => wrapTextWithAnsi(text, Math.max(1, width)).map((line) => fit(line, width));

  // Each block is a paragraph; blank paragraphs separate sections.
  function prose({ theme, width, pad, color, label, paragraphs }) {
    const margin = ' '.repeat(pad);
    const inner = Math.min(MAX_WIDTH, width - pad * 2);
    const out = wrap(theme.fg(color, theme.bold(`Workday · ${label}`)), inner).map((line) => margin + line);
    for (const paragraph of paragraphs) {
      out.push('');
      for (const line of wrap(paragraph, inner)) out.push(margin + line);
    }
    return out;
  }

  function component(build) {
    return {
      invalidate() {},
      render(width) {
        if (!Number.isFinite(width) || width < 1) return [];
        try {
          return build(Math.floor(width)).map((line) => fit(line, Math.floor(width)));
        } catch {
          return [];
        }
      },
    };
  }

  function padFor(context, width) {
    const pad = Number.isInteger(context?.outputPad) && context.outputPad > 0 ? context.outputPad : 0;
    return width - pad * 2 >= MIN_WIDTH ? pad : 0;
  }

  function estimateOf(args, text) {
    const minimum = args?.minimumMinutes;
    const maximum = args?.maximumMinutes ?? minimum;
    if (isMinutes(minimum) && isMinutes(maximum) && maximum >= minimum) return estimateText(minimum, maximum);
    const [low, high = low] = (/(?:^|; )estimate ([^;]+)(?:;|$)/.exec(text)?.[1] ?? '').split('–').map(minutesOfText);
    return isMinutes(low) && isMinutes(high) && high >= low ? estimateText(low, high) : undefined;
  }

  function textOf(result) {
    const parts = Array.isArray(result?.content) ? result.content : [];
    return clean(parts.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')).trim();
  }

  function timing(status, verdict, caution, bold) {
    const phase = verdict === 'after_eod' ? 'after_eod' : (status.phase ?? status.state);
    const at = (clock) => (isClock(clock) ? ` at ${clean(clock)}` : '');
    const wrapRemaining = isMinutes(status.remainingToWrapUp);
    const eodRemaining = isMinutes(status.remainingToEndOfDay);
    if (phase === 'no_boundary') return '';
    if (phase === 'after_eod') return `End of day passed${at(status.endOfDay)}.`;
    const eod = eodRemaining ? `${bold(remaining(status.remainingToEndOfDay))} until end of day${at(status.endOfDay)}` : undefined;
    if (phase === 'wrap_up') {
      return [`Wrap-up started${at(status.wrapUp)}.`, eod ? `You have ${eod}.` : ''].filter(Boolean).join(' ');
    }
    const wrapClause = wrapRemaining ? `${bold(remaining(status.remainingToWrapUp))} until wrap-up${at(status.wrapUp)}` : undefined;
    const clauses = [wrapClause, caution || !wrapClause ? eod : undefined].filter(Boolean);
    return clauses.length ? `You have ${clauses.join(' and ')}.` : '';
  }

  function resolve(result, context) {
    const details = result?.details;
    const text = textOf(result);
    if (context?.isError) return { verdict: 'failed', text, fallback: true };
    if (details?.status === 'status_unavailable') return { verdict: 'unavailable', text, status: undefined };
    const state = details?.assessment?.state;
    if (ASSESSMENT_STATES.has(state) && details.status && typeof details.status === 'object') {
      return { verdict: state, text, status: details.status, kind: details.assessment.kind };
    }
    return { verdict: 'plain', text, fallback: true };
  }

  function resultParagraphs(resolved, args, expanded, theme) {
    const bold = (text) => theme.bold(text);
    const paragraphs = [];
    if (resolved.fallback) {
      if (resolved.text) paragraphs.push(resolved.text);
      return paragraphs;
    }
    const caution = VERDICTS[resolved.verdict].color === 'warning' || VERDICTS[resolved.verdict].color === 'error';
    const estimate = estimateOf(args, resolved.text);
    const sentences = [];
    if (estimate) sentences.push(`Estimated work: ${bold(clean(estimate))}.`);
    if (resolved.status) sentences.push(timing(resolved.status, resolved.verdict, caution, bold));
    if (sentences.some(Boolean)) paragraphs.push(sentences.filter(Boolean).join(' '));
    if (resolved.verdict !== 'unavailable' && caution) {
      paragraphs.push(`${bold('Your decision needed.')} ${GUIDANCE[resolved.verdict]}`);
    }
    if (expanded) {
      const status = resolved.status ?? {};
      const kind = resolved.kind ?? args?.kind;
      const local = [status.localDate, status.localTime].filter(Boolean).map(clean).join(' ');
      const details = [
        kind && `Kind: ${clean(kind)}`,
        status.timezone && `Timezone: ${clean(status.timezone)}`,
        local && `Local time: ${local}`,
        status.phase && `Phase: ${clean(status.phase)}`,
      ].filter(Boolean);
      if (details.length) paragraphs.push(theme.fg('muted', details.join(' · ')));
      if (resolved.text) paragraphs.push(theme.fg('muted', resolved.text));
    }
    return paragraphs;
  }

  return {
    renderShell: 'self',

    renderCall(args, theme, context) {
      if (!context?.isPartial) return empty;
      return component((width) => {
        const paragraphs = [];
        const estimate = estimateOf(args, '');
        if (estimate) paragraphs.push(`Estimated work: ${theme.bold(clean(estimate))}.`);
        if (context.expanded && typeof args?.kind === 'string') paragraphs.push(theme.fg('muted', `Kind: ${clean(args.kind)}`));
        return prose({ theme, width, pad: padFor(context, width), color: VERDICTS.pending.color, label: VERDICTS.pending.label, paragraphs });
      });
    },

    renderResult(result, options, theme, context) {
      if (options?.isPartial || context?.isPartial) return empty;
      return component((width) => {
        const resolved = resolve(result, context);
        const { color, label } = VERDICTS[resolved.verdict];
        const paragraphs = resultParagraphs(resolved, context?.args, Boolean(options?.expanded ?? context?.expanded), theme);
        return prose({ theme, width, pad: padFor(context, width), color, label, paragraphs });
      });
    },
  };
}
