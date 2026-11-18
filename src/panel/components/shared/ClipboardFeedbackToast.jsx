import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2 } from "lucide-react";
import styles from "./ClipboardFeedbackToast.module.css";

export function ClipboardFeedbackToast() {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    const handleCopy = () => {
      window.clearTimeout(timerRef.current);
      setVisible(true);
      timerRef.current = window.setTimeout(() => setVisible(false), 1600);
    };
    window.addEventListener("zhuzhu:clipboard-copy", handleCopy);
    return () => {
      window.removeEventListener("zhuzhu:clipboard-copy", handleCopy);
      window.clearTimeout(timerRef.current);
    };
  }, []);

  if (!visible || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className={styles.toast} role="status" aria-live="polite">
      <CheckCircle2 />
      <span>Copied</span>
    </div>,
    document.body,
  );
}
