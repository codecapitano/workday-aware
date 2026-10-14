const MAX_WIDTH = 80;
const MIN_WIDTH = 8;
const UNAVAILABLE = 'Workday status is unavailable.';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const clean = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ').replace(CONTROL, '').trim();
const isMinutes = (value) => Number.isInteger(value) && value >= 0;
const isClock = (value) => clean(value).length > 0;

function duration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// Returns a structured description of the status, or undefined when it cannot be presented.
function describe(status) {
  if (!status || typeof status !== 'object') return undefined;
  const phase = status.phase ?? status.state;
  if (phase === 'no_boundary') return { phase, heading: 'No workday boundary today', color: 'muted' };
  if (!isClock(status.wrapUp) || !isClock(status.endOfDay)) return undefined;
  const endOfDay = clean(status.endOfDay);
  if (phase === 'after_eod') {
    return { phase, heading: `After hours · Ended at ${endOfDay}`, color: 'warning' };
  }
  if (phase === 'wrap_up' && isMinutes(status.remainingToEndOfDay)) {
    const remaining = duration(status.remainingToEndOfDay);
    return {
      phase,
      heading: `Wrap-up · ${remaining} until ${endOfDay}`,
      color: 'warning',
      remaining,
    };
  }
  if (phase === 'before_wrap_up' && isMinutes(status.remainingToWrapUp)) {
    return {
      phase,
      heading: `Wrap-up in ${duration(status.remainingToWrapUp)} · End of day at ${endOfDay}`,
      color: 'success',
    };
  }
  return undefined;
}

export function formatWorkdayStatus(status) {
  const info = describe(status);
  if (!info) return UNAVAILABLE;
  return info.heading;
}

function detailLines(status) {
  const local = [status.localDate, status.localTime].map(clean).filter(Boolean).join(' ');
  const when = [clean(status.timezone) && `Timezone: ${clean(status.timezone)}`, local && `Local time: ${local}`].filter(Boolean);
  const origin = [
    clean(status.source) && `Source: ${clean(status.source)}`,
    isMinutes(status.meaningfulWorkMinutes) && `Threshold: ${duration(status.meaningfulWorkMinutes)}`,
  ].filter(Boolean);
  return [when.join(' · '), origin.join(' · ')].filter(Boolean);
}

export function createWorkdayStatusPresentation({ visibleWidth, truncateToWidth, wrapTextWithAnsi }) {
  const fit = (text, width) => (visibleWidth(text) <= width ? text : truncateToWidth(text, width));
  const wrap = (text, width) => wrapTextWithAnsi(text, Math.max(1, width)).map((line) => fit(line, width));

  function component(build) {
    return {
      invalidate() {},
      render(width) {
        if (!Number.isFinite(width) || width < 1) return [];
        const safe = Math.floor(width);
        return build(safe).map((line) => fit(line, safe));
      },
    };
  }

  function padFor(options, width) {
    const pad = Number.isInteger(options?.outputPad) && options.outputPad > 0 ? options.outputPad : 0;
    return width - pad * 2 >= MIN_WIDTH ? pad : 0;
  }

  return {
    renderMessage(message, options, theme) {
      const status = message?.details?.status;
      return component((width) => {
        const pad = padFor(options, width);
        const margin = ' '.repeat(pad);
        const inner = Math.min(MAX_WIDTH, width - pad * 2);
        const info = describe(status);
        const blocks = [];
        const heading = info ? info.heading : UNAVAILABLE;
        blocks.push(theme.fg(info ? info.color : 'warning', theme.bold(heading)));
        const lines = blocks.flatMap((block) => wrap(block, inner));
        if (options?.expanded && info) {
          const details = detailLines(status).flatMap((line) => wrap(theme.fg('muted', line), inner));
          if (details.length) lines.push('', ...details);
        }
        return lines.map((line) => (line ? margin + line : line));
      });
    },

    renderWidget(status, theme) {
      return component((width) => {
        const info = describe(status);
        let text;
        if (info?.phase === 'after_eod') text = 'After hours';
        else if (info?.phase === 'wrap_up') text = `Wrap-up · ${info.remaining} left`;
        else return [];
        return wrap(theme.fg('warning', theme.bold(text)), width);
      });
    },
  };
}
