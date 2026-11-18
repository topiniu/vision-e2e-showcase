import { useEffect, useState } from "react";
import { Button } from "@panel/components/ui/button";
import { getRunBoardUrl } from "@panel/lib/panel-api";
import styles from "../PanelShell.module.css";

export function RunBoardPage({ theme }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    setError("");
    getRunBoardUrl().then((result) => {
      if (disposed) return;
      if (!result?.success || !result.url) throw new Error("运行看板服务暂不可用，请稍后重试。");
      setSource(result.url);
    }).catch((reason) => {
      if (!disposed) setError(reason.message || "运行看板加载失败。");
    });
    return () => { disposed = true; };
  }, [attempt]);

  if (error) return (
    <div className="grid justify-items-center gap-3 p-8" role="alert">
      <p>{error}</p>
      <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
    </div>
  );
  if (!source) return <p className="p-8 text-muted-foreground" role="status">正在连接运行看板…</p>;

  const url = new URL(source);
  url.searchParams.set("theme", theme === "light" ? "light" : "dark");
  return <iframe className={styles.runBoardFrame} title="运行看板" src={url.href} sandbox="allow-scripts allow-same-origin" />;
}
