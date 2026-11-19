# Vision E2E 展示版协作规范

- 当前版本：1.11.3，基于 v1.11 的独立展示版。
- 公开前同时运行工作树和完整可达历史的脱敏检查；组织专用规则通过私有环境变量注入，不写入源码、测试或文档。CI 的 push/手动运行缺少私有策略时必须失败。
- 安全门禁检查全部依赖及本地 picomatch 安全分支；修改 vendor 时必须更新来源、补丁哈希和安全回归记录，不能仅依赖 npm audit 的零计数。
- 本仓库不得迁入内部业务用例、需求记录、聊天、凭据或旧执行产物。
- 运行和提交前执行 `npm run check:privacy`，测试不允许依赖组织网络或已有认证状态。
- 维护 README、演示和 `docs/verification.md` 中的真实验证结果；不要填写未实测的效果指标。
- 实质改动记录到 `docs/implementation-records/v1.11-showcase.md`。

## 实施记录门禁

- 每次对项目代码、配置、文档、测试文件 schema、运行逻辑或 UI/UX 做实质改动时，必须同步更新对应版本的实施记录文档。
- 实施记录统一存放在 `docs/implementation-records/`。
- 文件按版本号命名：`vX.Y-版本主题.md`，例如 `v0.4-test-file-driven-platform.md`。
- 当前版本为 `v0.4` 时，改动应优先记录到 `docs/implementation-records/v0.4-test-file-driven-platform.md`。
- 如果进入新版本开发，必须先从 `docs/implementation-records/TEMPLATE.md` 创建新的版本实施记录，再开始或完成代码改动。
- 实施记录至少要回填：
  - 改动日期
  - 改动摘要
  - 主要代码/文档落点
  - 验证方式与结果
  - 风险、限制或后续事项
- 只做临时排查且没有留下仓库改动时，可以不更新实施记录；但如果排查结论会影响后续开发判断，应记录到当前版本实施记录的“变更流水”或“已知限制”中。

## 当前产品结构约定

- 产品入口以测试文件为核心，不再以全局 `Build / Run / Templates` 为主流程。
- 一个测试文件代表一个需求迭代，一个测试文件内包含多个 cases。
- 文件级信息编辑和 case steps 编辑分离：
  - `Edit file` 只编辑需求级/文件级元信息。
  - `Build cases` 负责 case 和 steps 编辑。
  - `Run` 负责执行 selected case 或 all cases。
- 测试文件默认目录为 `test-workflows/`，读写必须限制在该目录内。

## UI/UX 实现约定

- 能使用成熟开源组件或项目已安装 shadcn/ui 组件解决的交互，不要手写同类基础组件。
- 抽屉、弹窗、Popover、Tooltip、Tabs、Switch、Select、ToggleGroup、ScrollArea、Sheet 等优先复用 `src/panel/components/ui/` 中的 shadcn/ui 组件；缺失组件时先评估通过 `npx shadcn@latest add` 引入，而不是直接手写。
- 自定义 CSS 应聚焦业务布局和视觉微调，不应重新实现开源组件已经提供的打开/关闭、焦点管理、可访问性语义和基础交互动效。
