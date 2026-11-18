import { useEffect, useState } from "react";
import NumberFlow from "@number-flow/react";

const DEFAULT_LOCALE = "en-US";

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getZeroAnimationSeed(decimals) {
  return decimals > 0 ? 0.8 : 8;
}

function formatNumberFlowText(value, { prefix = "", suffix = "", decimals = 0 } = {}) {
  const numeric = toFiniteNumber(value);
  if (numeric == null) {
    return "-";
  }
  return `${prefix}${new Intl.NumberFormat(DEFAULT_LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(numeric)}${suffix}`;
}

export function NumberFlowValue({ value, suffix = "", prefix = "", decimals = 0, className, delay = 1000 }) {
  const numeric = toFiniteNumber(value);
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    if (numeric == null) {
      return undefined;
    }
    let frame = 0;
    let settleFrame = 0;
    const timer = window.setTimeout(() => {
      if (numeric === 0) {
        setDisplayValue(getZeroAnimationSeed(decimals));
        frame = requestAnimationFrame(() => {
          settleFrame = requestAnimationFrame(() => {
            setDisplayValue(numeric);
          });
        });
        return;
      }
      frame = requestAnimationFrame(() => {
        setDisplayValue(numeric);
      });
    }, delay);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(settleFrame);
    };
  }, [decimals, delay, numeric]);

  if (numeric == null) {
    return "-";
  }
  return (
    <span className={className} data-number-flow-value data-print-value={formatNumberFlowText(numeric, { prefix, suffix, decimals })}>
      <NumberFlow
        value={displayValue}
        locales={DEFAULT_LOCALE}
        format={{
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }}
        prefix={prefix}
        suffix={suffix}
        willChange
      />
    </span>
  );
}

export function NumberFlowDuration({ value, className, delay = 820 }) {
  const numeric = toFiniteNumber(value);
  if (numeric == null) {
    return "-";
  }
  if (numeric < 1000) {
    return <NumberFlowValue className={className} value={Math.round(numeric)} suffix=" ms" delay={delay} />;
  }
  const totalSeconds = Math.round(numeric / 1000);
  if (totalSeconds < 60) {
    return <NumberFlowValue className={className} value={totalSeconds} suffix=" s" delay={delay} />;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return (
    <span className={className}>
      <NumberFlowValue value={minutes} suffix="m" delay={delay} />
      {" "}
      <NumberFlowValue value={seconds} suffix="s" delay={delay + 90} />
    </span>
  );
}
