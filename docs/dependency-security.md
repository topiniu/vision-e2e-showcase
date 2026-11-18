# 开发与打包依赖修复（1.11.2）

日期：2026-11-18。基线审计为 13 项（8 high、5 moderate），来自两个底层问题的依赖链传播。

## Minimatch：升级已修复版本

[官方告警 GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) 的受影响范围为 7.0.0 至 11.0.1 之前，修复版从 11.0.1 开始。

用精确 override 将这个范围内的实例升级到 11.0.9，覆盖 app-builder-lib 和 @electron/universal。保留不在此告警范围内的旧主版本实例，避免破坏它们的函数式 API。没有降级 Vite 或 electron-builder 来躲开依赖链。

## Picomatch：本地安全分支

[官方告警 GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) 覆盖截至检查时的最新版本 4.0.7，尚无上游修复发布。

`vendor/picomatch/` 是保留原作者和 MIT 许可证的本地分支，包名为 `@vision-e2e/picomatch`，版本为 `4.0.7-security.1`，标记 private，不发布到 npm。

只修改重复 extglob 的风险分析：含通配符、量词、分组、字符类、花括号、转义、引号、空分支或歧义前缀分支的重复模式走上游已有的字面量回退，不能通过旧的递归限制选项绕过。普通 glob、globstar、字面量重复组和前缀无歧义的字面量分支保留。额外复现的 `+(ab|abab)`、`+(a|ab|b)` 也加入限时回归。

兼容边界：危险的 `+(...)` / `*(...)` 模式按字面量匹配，不再用于扩展文件集合。这个限制在本项目构建与打包所用的模式上经过验证，但不承诺所有自定义重复 extglob 与旧版语义一致。

忽略大小写的重复多分支组同样回退，避免 `+(a|AA)` 的分支在忽略大小写后重叠；`nocase` 与显式 `flags: 'i'` 都有回归覆盖。

## 审计覆盖与验证

**npm audit 不会审计本地分支。** 因此“npm audit 为 0”必须与本地补丁检查同时成立：

1. 全部依赖（含 devDependencies）运行 npm audit，任何等级的新增告警都会导致检查失败。
2. 检查本地分支文件列表与 SHA-256，篡改源码或增加未审查文件会失败。
3. 检查 Vite、fdir、tinyglobby、Parcel watcher 实际加载同一份补丁，打包链实际加载 minimatch 11.0.9。
4. 在限时子进程中运行重复 extglob 与 globparts 放大样例，避免测试本身挂死。
5. 校验普通匹配、scan/parse/makeRe、回调、Windows 分隔符与打包过滤接口。

原始 picomatch 4.0.7 在三个攻击样例上均触发 1 秒超时；本地分支的更长攻击输入与兼容性回归通过。原始包只用于本地对照，没有进入本仓库。

执行：

```bash
npm ci
npm run check:security
npm test
npm run demo
npm run build:panel
npm run release:dir
```

补丁源码、原始上游文件哈希和回归用例均在仓库中可审查。上游发布修复版后，应替换本地分支并重新运行这些检查。
