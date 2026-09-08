# dsh-auto-rename

[English](README.en.md)

DSH Web 输入框斜杠命令 `/auto-rename`：让模型通读整个会话，推荐一个带日期前缀的语义名，并自动完成改名。

效果：输入

```text
/auto-rename
```

模型在**一个普通 AI 回合**内读完当前会话全文（不额外重复发送全文、不额外增加独立模型调用），按 recommend-new-session-name skill 的规则给出分行分点的输出：

```text
推荐：

2026-08-08_会议纪要整理

推荐原因：

这段会话围绕某次会议纪要进行整理与归档

改名方式：

已通过 rename_current_session 自动应用。

其他备选：

- 2026-08-08_会议纪要
- 会议纪要整理
```

会话标题随即变为 `2026-08-08_会议纪要整理`，与侧边栏手动改名走同一条官方链路（`sessionTitle.rename` + `sessions.flush`），刷新/恢复后标题不变。日期前缀 `YYYY-MM-DD` 取**会话开始日期**，由插件在宿主侧从会话日志计算，跨平台一致，不依赖模型猜测。

## 为什么是"命令 + 模型回合"而不是命令直接改名

DSH 的斜杠命令运行在 UI 命令平面，宿主侧执行、不经模型。若命令自己"读全文再取名"，就必须把整段对话作为一次独立模型请求的输入，等于把全文重复发送一遍，浪费 token。

本插件让命令只负责触发：命令向当前会话注入一条 user 消息并唤醒驱动器（与官方 `/goal` 命令向 agent 投喂消息同一机制），模型在它**本来就在处理**的回合里读取全文并给出推荐，再调用插件注册的模型可见工具 `rename_current_session` 完成改名。因此 token 成本与直接让模型取名相当，不会重复发送全文；改名链路仍然官方、持久。

## 安装

前置条件与 [dsh-rename](https://github.com/sci-zyf/dsh-rename) 相同：

- 已全局安装 dsh CLI：`npm install -g @deepseek-ai/dsh`
- Node.js ≥ 22.19（见 `package.json` engines 字段）
- 已存在 web profile：`dsh profile list` 中应包含 `web`

从 GitHub 仓库安装：

```bash
dsh plugin --profile web add https://github.com/sci-zyf/dsh-auto-rename
```

安装后重启 DSH（或 profile `patchReload: live` 时自动生效）。卸载：

```bash
dsh plugin --profile web remove dsh-auto-rename
```

## 使用

在 DSH Web 输入框输入：

```text
/auto-rename
```

命令不接受参数；需要手动指定标题时用 `/rename <title>`。模型回合结束后，标题即已应用；若此部署缺少模型可见工具能力，插件会自动降级为"只给出推荐名、请用 /rename 应用"，不会静默失败。

## 宿主适配与平台

- 适配 DSH 0.1.2-rc 系列（web profile）。
- 纯 UI 命令插件 + 一个模型可见工具：不直接 import 任何 `@deepseek-ai` 内部包，不声明 peerDependencies。依赖的命令平面（`commands`）、会话接口（`sessionTitle`、`sessions`）、agent 消息注入面（`agent.followup`）与工具注册面（`tools`）均为 DSH 公开面；宿主升级时以实际运行验证为准，而非版本号约束。
- 纯 JS 实现，不调用 shell、不依赖文件系统，日期前缀在宿主进程内用 JavaScript 计算，因此在 macOS / Linux / Windows 行为一致。
- 源码通过 GitHub 仓库分发，不发布 npm。

## 实现

- `lib/index.js`：cordis 插件，`ctx.inject(['commands'])` 就绪后注册 `/auto-rename`。
- 命令 handler 在宿主侧计算会话开始日期 `YYYY-MM-DD`，构造命名指令，经 `agent.followup` 唤醒主模型回合。
- 回合内模型调用本插件注册的 `rename_current_session` 工具，工具内部 `sessionTitle.rename(session, title)` 接受标题、`sessions.flush(session)` 持久化——与 dsh-rename 的 apply 链路一致。
- 注册面与生命周期事件对齐 `@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-tools` 契约；工具在首次执行命令时惰性注册，宿主缺少工具服务时自动降级。

## 测试

```bash
npm test
```

测试覆盖日期前缀计算、标题规范化、命名指令文本结构、改名工具的官方链路调用与各类降级路径。
