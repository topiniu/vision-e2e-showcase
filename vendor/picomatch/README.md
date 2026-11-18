# Picomatch 本地安全分支

- 来源：npm `picomatch@4.0.7`，保留上游 MIT 许可证和作者信息。
- 本地名称：`@vision-e2e/picomatch@4.0.7-security.1`，仅供本项目使用，不发布到 npm。
- 上游仓库：https://github.com/micromatch/picomatch
- 对应告警：https://github.com/advisories/GHSA-fc5q-39xc-vjpf

截至 2026-11-18，上游没有已发布的修复版。本分支没有宣称是上游发布，也没有将未修复代码改成一个看似安全的上游版本号。

## 补丁与兼容边界

只修改 `lib/parse.js` 的重复 extglob 风险判定：含通配符、量词、分组、字符类、花括号、转义或引号的 `+(...)` / `*(...)` 使用上游已有的字面量回退，不再生成可能出现嵌套量词的正则。空分支以及任一字面量分支是另一分支前缀的情况也回退，避免 `+(ab|abab)`、`+(a|ab|b)` 等歧义分段。保留普通 glob、globstar、花括号、独立字符类、字面量重复组和前缀无歧义的字面量分支。

旧的 `maxExtglobRecursion:false` 不能关闭安全检查。风险重复组的匹配语义有意变为字面量；不要依赖它匹配文件集合。本项目实际构建和打包 glob 没有依赖这种写法。

不区分大小写时的重复多分支组也按字面量处理，防止 `+(a|AA)` 在忽略大小写后变成歧义模式。

这不是对任意用户提供的正则表达式安全性的保证。它修复此告警所针对的重复 extglob 路径。

## 验证与维护

`security-patch.json` 记录本地文件 SHA-256 和原始上游文件 SHA-256。`npm run check:security` 对所有依赖运行 npm audit，并额外检查本地分支的文件完整性和各使用者实际加载的实现。

`test/runtime/dependency-security.test.js` 在有超时限制的子进程中执行攻击样例，同时覆盖普通匹配与调用方。不要只依赖 npm audit 的零计数：npm 不会审计这个本地分支，必须同时通过这两类检查。

上游发布修复版后，优先移除此分支和 file override；完成漏洞回归、全量测试、前端构建与打包验证后再更新锁文件。
