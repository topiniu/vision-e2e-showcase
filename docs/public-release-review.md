# 公开前审查与历史维护

## 检查范围

`npm run check:privacy` 检查已跟踪及待提交文件；`npm run check:history` 检查所有可达引用中的文件版本、路径和提交元数据。历史检查拒绝浅克隆，CI 使用完整历史。

通用规则检查常见凭据形态、非保留域名的通配示例、被禁止的产物路径、符号链接、子模块及分发工作流中的字面量身份信息。规则是辅助检查，不能证明不存在任何组织资料；截图和上下文仍需人工审阅。

## 私有策略

`ZHUZHU_PRIVATE_REFERENCES` 接受以逗号或换行分隔的字面量匹配项，忽略大小写。维护者在仓库外配置实际名单，不把名单或含原始资料的检查报告提交到仓库。错误输出不包含命中的原始值。

CI 从 `SHOWCASE_PRIVATE_REFERENCES` repository secret 注入策略。push 和手动运行设置 `ZHUZHU_REQUIRE_PRIVATE_REFERENCES=true`，缺少策略会失败。fork PR 无法取得该 secret，因此只执行通用检查，不替代维护者在发布前的完整私有审查。

本地复核时，先从自己的私有配置加载策略，再运行：

```bash
ZHUZHU_REQUIRE_PRIVATE_REFERENCES=1 npm run check:privacy
ZHUZHU_REQUIRE_PRIVATE_REFERENCES=1 npm run check:history
npm run check:security
npm test
npm run demo
npm run build:panel
```

## 改写历史后

此展示版对已有提交做过脱敏改写。旧克隆不可直接 merge 回新 main；应重新克隆，或只迁移逐项审查后的独立改动。旧历史备份仅保存在仓库外的私有位置，不创建备份分支或标签重新推送。

Git 分支改写不会自动清除托管平台的旧对象缓存。公开前须在远端重新克隆检查历史，并核对旧引用及平台附属内容；不能仅以工作树干净或 CI 通过作为公开结论。本展示仓库用于公开求职展示，原私库和旧展示归档继续保持私有。

## 数据目录边界

桌面 userData 与默认工作区使用展示版的独立目录。独立 HTTP runtime 的桥发现文件仍默认使用旧的共享路径；需要与其他版本并行运行时，用专用 `ZHUZHU_ENDPOINT_FILE` 覆盖该路径。该发现文件不分发到 Git，也不存放凭据。
