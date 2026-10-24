# dsh-prompt-boost

输入框旁的一键「增强提示词」按钮：点一下把一句草稿扩写成完整规格，再点一下还原原文。

A one-click "enhance prompt" button beside the DSH composer: press once to expand a
rough draft into a complete specification, press again to restore the original.

## 它做什么

- 读取你输入框里的草稿，交给当前默认模型**扩写为规格**：一行目标 + 3–6 条可核对的编号要求
- 草稿涉及已有数据/文件/流程时，会自动补上「先检查再改、保住不能丢的、完成后验证、汇报改动」
- 结果写回输入框，**原文保留在内存里**
- 再点一次 → 恢复原文
- 增强后你手动改过文字 → 再点不会覆盖你的编辑，而是忘掉旧原文

按钮位置在输入框右下角、**模型选择器左边**。状态一眼可辨：

| 状态 | 外观 |
|---|---|
| 待增强 | 灰色 ✨ |
| 正在增强 | 呼吸闪烁 |
| 已增强 | 蓝色 ✨，悬停显示「恢复原提示词」 |
| 出错 | 红色 ✨，悬停显示具体原因 |

## 增强力度

默认 `expand`（扩写）。另有 `standard`（忠实精修，不加内容）与 `concise`（压缩到更短），
可在请求体里传 `mode` 指定：

```jsonc
POST /prompt-boost/enhance
{ "text": "你好", "mode": "standard" }   // mode 省略 = expand
```

`expand` 会推断并补齐合理的验收标准，因此**可能加入你原文没说的要求**——这是设计意图，
不是 bug；不想要的话用 `standard`。

## 安装

需要 DSH `0.2.x`（在 `0.2.1-rc.2` 上验证）。

```sh
# web profile
dsh plugin --profile web add dsh-prompt-boost

# 其他 profile 换成对应名字
dsh plugin --profile <name> add dsh-prompt-boost
```

桌面版（DSH Desktop）请在应用内的 **设置 → 插件** 里安装，或用插件市场。

安装后重启 DSH（宿主插件需要重启才会加载）。

## 工作原理

两层结构，和 DSH 的插件约定一致：

- **宿主半边** `lib/index.js`：注册一个 `POST /prompt-boost/enhance` 路由。收到草稿后调用
  `ctx.llm.prepareCall(...)` 请求当前默认模型，把流式结果聚合返回。
- **浏览器半边** `lib/client.js`：注册到 `conversation.input.right` 插槽（模型选择器左侧），
  通过 `conversation.input.for(actx)` 拿到输入框 shell，用 `draftSnapshot` 读、
  `setDraft` 写。

### 推理内容不会混进结果

`deepseek-flash` 这类模型默认会把思考过程写进正文。插件在 `prepareCall` 时传
`reasoningEffort: 'off'`，DeepSeek 适配器会据此发出 `thinking: { type: 'disabled' }`，
思考就不会污染正文。另有 `finalizeText()` 作为兜底清洗，覆盖不听话的模型。

## 已知限制

- 依赖 DSH 客户端内部接口（`conversation.input.for`、`draftSnapshot`），**跨大版本可能失效**。
  `engines.dsh` 已锁定 `<0.3.0`。
- 增强质量取决于你配置的默认模型。
- 长草稿上限 32 KB，单次调用超时 90 秒。

## 调试

若按钮报「拿不到输入框」，插件会把运行时诊断写到
`~/.dsh/prompt-boost-diag.log`（每次挂载/点击一行 JSON）。

## License

MIT
