# 外部调用协议

独立 runtime：`npm run runtime:server`，默认仅本机端口 32146。桌面 App Run / MCP 默认端口 32147。端口与网络访问策略由配置决定；写入/执行接口使用 `src/shared/api-guard.js` 的令牌策略，远程写入需要本地配置的 Token。

## 推荐路径

1. 用预检校验完整 schemaVersion=2 测试文件。
2. 向 `POST /test-sessions` 提交 `{testFile, authProfile, wait:false}`。
3. 保存返回的 sessionId，通过 `GET /test-sessions/:id` 轮询至 terminal，或订阅事件。
4. 读取 `GET /test-sessions/:id/report` 与诊断，决定修订用例还是修复被测应用。

`POST /run` 是低层平铺动作接口，不替代完整测试文件的 setup/case/teardown 语义。实际路由与工具参数以 `GET /capabilities`、`src/main/mcp-server.js` 及 `runtime/server/http.js` 为准。

## 环境与身份

使用 `target.origins` 解析 `{{origin.name}}`；缺少映射时拒绝运行。真实身份通过本地 `.zhuzhu-credentials.json` 中的 credentialRef 引用，不把凭据值写进工作流。认证 profile 的 storageState 存于被忽略的 output 目录。

本地演示不需要认证。`demo:serve` 或 `demo` 只在本地创建空 profile 以运行同一条会话链路。
