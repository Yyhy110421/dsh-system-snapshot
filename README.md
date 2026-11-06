# 快照 · dsh-system-snapshot

给 DSH 用的系统快照插件。改系统设置之前先留一份白名单快照，改完能对比出**新增、删除、改动**；需要时把注册表白名单、hosts、用户环境变量恢复回去。

> 只快照白名单，不碰整个注册表。服务、防火墙、计划任务、系统环境变量**永远只读**，不会被恢复。

## 能做什么

| 类别 | 采集内容 | 可恢复 |
|---|---|---|
| 注册表 | 指定键下的值（名称、类型、值） | ✅ |
| hosts | 全文、SHA-256、路径 | ✅ |
| 用户环境变量 | 名称和值 | ✅ |
| 系统环境变量 | 名称和值 | ❌ 只读 |
| 服务 | 名称、显示名、状态、启动类型 | ❌ 只读 |
| 防火墙规则 | 名称、显示名、方向、动作、启用状态、配置文件 | ❌ 只读 |
| 计划任务 | 路径、名称、状态 | ❌ 只读 |

## 工具

### system_snapshot

建快照或列快照。

```text
system_snapshot action=create label=改代理前
system_snapshot action=list
```

### system_diff

把一份快照和当前状态（默认）或另一份快照比较。只输出变化名称和摘要，不输出环境变量的值。

```text
system_diff id=snap-20261106-120000-abcd
system_diff id=snap-20261106-120000-abcd compareTo=current maxItems=100
```

### system_restore

恢复注册表白名单、hosts、用户环境变量。**必须显式传 `confirm:true`**，并且只应在用户明确要求时调用。

```text
system_restore id=snap-20261106-120000-abcd confirm=true
system_restore id=snap-20261106-120000-abcd confirm=true categories=["registry","hosts"]
```

恢复前会自动：

1. 再建一份“恢复前自动备份”快照；
2. hosts 如果存在，先复制一份 `hosts.bak-日期-时间`；
3. 再写入目标内容。

服务、防火墙、计划任务、系统环境变量即使出现在 `categories` 里也只会被跳过并报告，不会改。

## 安装

在 DSH 里打开 **设置 → 插件管理器**，安装：

```text
github:Yyhy110421/dsh-system-snapshot
```

或者从本地目录安装（开发时用）：

```text
file:E:\DSH\projects\dsh-system-snapshot
```

装完重启 DSH。然后打开 **设置 → 系统快照**。

> `file:` 安装是实体拷贝；改了源码要卸载再装。插件管理器里的“更新”只对 npm 注册表插件生效，本插件不发布 npm。

## 设置页

**设置 → 系统快照** 可以：

- 立即建快照；
- 编辑注册表白名单（一行一个键，只接受 `HKCU\` 或 `HKLM\`，不接受通配符和 `..`）；
- 开关 hosts、用户环境变量、系统环境变量、服务、防火墙、计划任务；
- 调整保留份数（1–100）、保留天数（1–365）、差异最多列多少条（20–2000）；
- 勾选恢复范围（注册表 / hosts / 用户环境变量）；
- 查看已有快照、和当前比较、二次确认后恢复。

## 数据在哪

默认：

```text
%DSH_HOME%\data\system-snapshot\
  snapshots\snap-*.json
  settings.json
  tmp\
```

`DSH_HOME` 没设置时是 `%USERPROFILE%\.dsh`。快照只在本机，不上传、不联网。

**快照里有环境变量的值、hosts 内容和注册表值，按敏感文件对待。** 没有加密。

## 安全边界

- 注册表只读/写白名单键下的值，不递归子键，不碰全注册表。
- 恢复前必须 `confirm:true`，设置页要点两次。
- 恢复先生成备份快照；hosts 另存 `.bak-时间`。
- 服务、防火墙、计划任务、系统环境变量没有写入代码路径。
- 恢复不是事务：中途失败会返回 `partial:true` 和 `errors`，已完成的项不会回滚。
- 写 hosts 可能需要管理员权限；没有权限时会在 `errors` 里报告。
- 用户环境变量恢复只影响之后新启动的进程，已经运行的进程不会变。

## 限制

- 仅 Windows；依赖 Windows PowerShell 5.1。
- 不备份文件、驱动、已安装程序、浏览器数据。
- 不递归注册表子键；只记录白名单键本身的值。
- 服务/防火墙/计划任务只记录状态，不能据此还原。
- 全量采集（含服务、防火墙、计划任务）在这台机器上约 10–15 秒；只采注册表时很快。

## 开发

```powershell
cd E:\DSH\projects\dsh-system-snapshot
node --check lib/core.js
node --check lib/index.js
node --check client.js
npm test
npm run test:integration
```

- `npm test`：纯逻辑 + 宿主注册/路由，不跑 PowerShell。
- `npm run test:integration`：真实跑 PowerShell，只操作测试键 `HKCU\Software\DSH-SystemSnapshot-Test`，结束时删除该键和临时目录。

## License

MIT © 2026 Yyhy110421
