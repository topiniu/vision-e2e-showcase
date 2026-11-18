export function copyTextToClipboard(value) {
  const text = String(value ?? "");
  if (!text) {
    return false;
  }
  const notifyCopied = () => {
    if (typeof window === "undefined") {
      return;
    }
    window.dispatchEvent(new CustomEvent("zhuzhu:clipboard-copy", {
      detail: { text },
    }));
  };
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).then(notifyCopied, () => {});
    return true;
  }
  if (typeof document === "undefined") {
    return false;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
  if (copied) {
    notifyCopied();
  }
  return copied;
}
