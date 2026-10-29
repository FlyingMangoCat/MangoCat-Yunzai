## 改了什么

<!-- 一句话说明改动范围：插件 / 运行时 / 面板 / 文档 / 审计脚本 -->

## 为什么

<!-- 解决的问题、关联 Issue -->

## 审计结论

- [ ] 已跑 `bash scripts/ci-audit.sh`（或 `node tools/plugin-audit.mjs <目录> --ratchet`）
- 结果：CRITICAL `_` / HIGH `_` / MEDIUM `_` / LOW `_`
- CRITICAL / HIGH 定性（属实 / 误报依据）：
- 新增 MEDIUM / LOW 说明：

## 兼容性

- [ ] 未破坏 L1 兼容基线（契约 §2）
- [ ] 涉及权限 / 鉴权 / 契约改动，已附 Issue 链接

## 自检

- [ ] `npm run lint-check`
- [ ] 改运行时：已跑 `npm test`（需 `config/test/default.yaml`）
- [ ] 改 `tools/plugin-audit.mjs`：已附正例 + 反例

## 禁止项确认

- [ ] 未提交真实密钥 / 大二进制 / `node_modules`
- [ ] 未在未说明的情况下 `--accept` 新增问题
- [ ] 未用「删掉命中代码」代替定性

## 回滚

<!-- 出问题时怎么退：revert 本 PR 即可 / 需要额外步骤 -->
