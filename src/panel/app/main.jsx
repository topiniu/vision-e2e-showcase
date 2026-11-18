import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./globals.css";

// StrictMode double-invokes every render in the dev build. With this large,
// not-yet-memoized App tree that roughly doubles the main-thread cost of every
// interaction (switch file, collapse sidebar, click case) — the perceived lag.
// StrictMode is a no-op in production builds either way, so gate it behind an
// opt-in env (`VITE_STRICT=1`) and default OFF so `npm run dev` stays snappy.
const strict = import.meta.env?.VITE_STRICT === "1";
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(strict ? (
  <React.StrictMode>
    <App />
  </React.StrictMode>
) : (
  <App />
));
