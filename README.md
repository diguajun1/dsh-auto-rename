# dsh-auto-rename

DSH Web 会话自动改名插件：让 AI 通读整个会话上下文，按 `YYYY-MM-DD_语义名` 的约定给会话起名并**自动应用**。

两种触发方式：

| 模式 | 触发 | 说明 |
| --- | --- | --- |
| 手动 | 输入框敲 `/auto-rename` | 立即让模型通读会话并改名 |
| 空闲自动（v0.2.0 新增） | 每轮对话结束后，**无人操作满 5 分钟** | 自动注入一次命名回合并改名 |

改名为可配置：`idleMs`（默认 `300000`，即 5 分钟）、`enabled`（默认 `true`）。

## 为什么需要它

会话标题默认是首条消息的截断，跨天的长会话在侧边栏里几乎无法区分。手写标题又容易漏掉日期前缀、或与开始日期对不上。本插件把「读全文 → 取概念 → 加日期前缀 → 落库」这一套流程交给模型 + 宿主协作完成：

- **日期前缀由宿主侧计算**（取会话第一个事件时间戳，本地时区），不靠模型猜；
- **改名走官方链路** `sessionTitle.rename()` → `sessions.flush()`，与侧边栏手动改名完全一致，刷新/重启不丢；
- **不引入任何 `@deepseek-ai` 内部依赖**，不使用 peerDependencies，纯 JS、零原生依赖，macOS / Linux / Windows 通用。

## 工作原理

DSH 的命令面与模型面是分开的，插件两侧都要挂东西：

1. **命令面**（宿主侧，不产生模型消息）：`ctx.inject(['commands'])` 注册 `/auto-rename`。
2. **模型面**：`ctx.tools.register()` 注册一个模型可见工具 `rename_current_session`。命令处理器通过 `agent.followup()` 注入一条普通 user 消息（与官方 `/goal` 同一条通路），模型在自己的上下文里读完整个会话后调用该工具落库。
3. **空闲自动**：宿主面监听 `session/event`。只有**人类**发起的消息（`user/message` 且 `source.kind === 'user'`）才为会话装一个 `setTimeout`；后续人类消息、下一轮 `turn/start`、会话销毁都会清掉它。计时器满窗存活时，注入与 `/auto-rename` **完全相同**的命名回合。

两个状态位保证不会失控：

- `awaitingRename`：吞掉「命名回合自己」的 `turn/end`，所以插件的输出不会再次触发改名；
- `pendingUserTurn`：只有人类消息会置位，因此一段「人已停手的对话」最多改名一次。

另有保护：

- `agent.status === 'running'` 或 `inbox.nextTurn/nextStep` 非空时不注入，改为 15 秒后复查（有人的回合还在跑就不打断）；
- `turn/end` 的 `reason.kind === 'blocked'`（等审批）不装计时器；
- 子会话（有 `parentSessionId`）不处理；
- 定时器 `unref()`，不会吊住宿主进程。

## 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-auto-rename
      name: dsh-auto-rename
      inject: [commands]
      config:
        enabled: true
        idleMs: 300000   # 5 分钟；也可写 idleMinutes: 5
```

- `enabled: false`：只关自动改名，`/auto-rename` 仍可用；
- `idleMs`：安静窗口（毫秒），优先级高于 `idleMinutes`；
- 非法/非正数回落到默认 5 分钟。

## 安装

```bash
dsh plugin --profile web add https://github.com/sci-zyf/dsh-auto-rename
```

安装后重启 DSH（或 profile 配了 `patchReload: live` 时自动生效）。

> 从 git 安装的插件修改后会被重装覆盖；要长期生效请把改动提交回上面的仓库，或在本地路径安装
> `dsh plugin add /path/to/dsh-auto-rename`。

## 使用

- 输入框输入 `/auto-rename` 回车：模型读完全文后自动改名，并给出「推荐 / 推荐原因 / 改名方式 / 其他备选」。
- 或者什么都不做，聊完离开 5 分钟：插件自动完成同样的流程。
- 手动改回：侧边栏右键改名，或 `/rename <title>`。

## 开发

```bash
npm test   # node --test test/，纯函数 + 空闲状态机
```

`test/idle.test.js` 用假的服务面（`agents.list()` / `followup` / `session/event`）验证：只有人类消息才装计时器、命名回合不会自我触发、忙时不注入、子会话跳过、销毁清计时器、`enabled: false` 静默。

## 许可

MIT
