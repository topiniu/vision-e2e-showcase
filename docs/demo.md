# 五分钟演示

## 运行前

按 README 安装 Node 依赖和 Chromium。无需 VPN、公司服务、账号、API key 或模型服务。

## 演示顺序

1. 执行 `npm run demo`，观察 passing=passed、failing=failed，两者的 evidence verified 都成立。
2. 打开 [passing.json](../test-workflows/demo/passing.json)，解释 fill → click → assertDom，以及 expected 如何定义业务结果。
3. 对比 [failing.json](../test-workflows/demo/failing.json)：只改变断言期望，动作仍能完成。红灯说明执行成功与验证成功是两个不同事实。
4. 打开 `output/demo/summary.json` 中列出的报告路径，查看失败步骤、实际/期望值、截图和诊断。
5. 如需展示面板，运行 `npm run demo:serve` 和 `npm run dev`，从 Demo 分组选择文件、查看步骤、运行并查看结果。

## 技术讲解线索

- 从测试文件到预检、归一化、执行器，再到报告的完整链路。
- 说明可见页面注入与 headless context 的所有权差异。
- 用超时和取消测试解释如何保证长任务收口。
- 用反例说明断言可信度，避免只展示“全绿截图”。

## 可核验材料

截图来自本地合成数据的真实运行；完整自动化验证见[验证记录](verification.md)。不要把本地演示的速度、成功率外推为生产业务效果。

看板中的 50% 仅表示这个演示特意包含一个正例和一个反例，不代表项目测试通过率。
