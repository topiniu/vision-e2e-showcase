"use strict";


const http = require("node:http");

function buildRow(index) {
  return `
    <tr class="row" data-row="${index}">
      <td><span class="cell-id">SPU-${String(index).padStart(6, "0")}</span></td>
      <td>
        <div class="cell-wrap">
          <div class="cell-inner">
            <span class="cell-name">样品名称 ${index}</span>
            <span class="cell-sub">项目成员 ${index % 37}</span>
          </div>
        </div>
      </td>
      <td><div class="cell-wrap"><span class="cell-status">${index % 3 === 0 ? "待定价" : "已定价"}</span></div></td>
      <td>
        <div class="cell-wrap">
          <ul class="tag-list">
            <li class="tag">类目${index % 11}</li>
            <li class="tag">批次${index % 7}</li>
          </ul>
        </div>
      </td>
      <td><button type="button" class="row-action" data-testid="row-action-${index}">查看</button></td>
    </tr>`;
}

// Each row is ~18 elements. Chrome's own overhead plus the chrome/nav shell is
// ~120 elements, so `rows = (nodes - 120) / 18` lands close to the requested
// count without pretending to be exact.
function rowsForNodes(nodes) {
  return Math.max(1, Math.round((Number(nodes) - 120) / 18));
}

function buildHtml(nodes) {
  const rows = rowsForNodes(nodes);
  const body = Array.from({ length: rows }, (_unused, index) => buildRow(index + 1)).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>打样列表（性能基准 ${nodes} 节点）</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; }
  .page { padding: 12px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #e5e7eb; padding: 4px 6px; font-size: 12px; }
  .tag-list { margin: 0; padding-left: 14px; }
  .toolbar { display: flex; gap: 8px; padding: 8px 0; }
  .ant-modal { border: 1px solid #d1d5db; padding: 12px; margin-top: 12px; }
  .hidden-block { display: none; }
</style>
</head>
<body>
  <div class="page">
    <div class="toolbar">
      <input placeholder="请输入样品名称" data-testid="perf-search-input" />
      <button type="button" data-testid="perf-search-btn">查询</button>
      <button type="button" data-testid="perf-reset-btn">重置</button>
    </div>

    <!-- The scoped-resolution landmark: a container whose text contains the
         nearText anchor, sitting *after* a large amount of unrelated DOM so a
         naive full-document scan pays the full price to reach it. -->
    <div class="ant-modal" data-testid="perf-panel">
      <div class="ant-modal-content">
        <h3>定价确认</h3>
        <button type="button" data-testid="perf-confirm-btn">确认定价</button>
      </div>
    </div>

    <div class="hidden-block">
      <div><span>隐藏区域文本</span></div>
    </div>

    <table data-testid="perf-table">
      <thead><tr><th>编号</th><th>名称</th><th>状态</th><th>标签</th><th>操作</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>
</body>
</html>`;
}

// Starts the fixture on an ephemeral loopback port. `url(nodes)` builds the
// address for a given size; the server itself is size-agnostic.
function startHeavyPageServer() {
  const server = http.createServer((request, response) => {
    const requested = Number(new URL(request.url, "http://127.0.0.1").searchParams.get("nodes")) || 2000;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(buildHtml(requested));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        url: (nodes = 2000) => `http://127.0.0.1:${port}/?nodes=${nodes}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = {
  buildHtml,
  rowsForNodes,
  startHeavyPageServer,
};
