# 右侧栏命令基础设施

## 功能范围

- 复刻 Saleae 右侧栏的面板入口顺序、可见性/可选性判断、快捷键命令命名和关闭规则。
- 顶部工具栏的 Add Analyzer、Add Range Measurement、Add Marker Pair、Add Single Marker 改为走统一命令入口。
- 增加原版侧栏导航快捷键：`N A`、`N C`、`N D`、`N E`、`N M`、`N N`、`N T`、`N Q`。
- 增加原版添加快捷键：`Cmd/Ctrl+G` 添加 range measurement、`Cmd/Ctrl+T` 添加 marker pair、`Shift+Cmd/Ctrl+T` 添加 single marker。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/panelsContent.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/PanelSwitchers.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/commands.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/shortcuts/keyBindings.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/commands.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/commands.ts`

## 本地落点文件

- `src/lib/sidebar.ts`
- `src/App.tsx`
- `src/components/LogicToolbar.tsx`
- `src/styles.css`

## 复用方式

- 状态规则复刻：按原版 `getPanelAllowed` 的思路统一判断 `visible/selectable`。
- 命令命名复刻：沿用原版 `sidebar:*`、`advancedMeasurements:*`、`markers:*` 字符串。
- 快捷键复刻：沿用原版右栏 `n + key` 导航和 marker/range 添加快捷键。
- 结构复刻：右栏点击、顶部工具栏和键盘快捷键统一进入本地 command dispatcher。

## 用户可见行为

- 右栏按钮 tooltip 会显示原版导航快捷键。
- 普通 Logic 类 session 会按原版隐藏 MSO 专属的 Recording Settings / Cursors 入口。
- 切换 session 后，如果当前面板在新 session 下不可用，会自动关闭。
- 在非输入控件聚焦时可以用快捷键打开侧栏面板或添加 range / marker。

## 验证方式

- `pnpm build`

## 已知差距 / 后续任务

- 本次只完成目标 0 基础设施；每个按钮内的完整业务功能会按后续目标逐个搬运。
- `Recording Settings` 和 `Cursors` 的 MSO 判断目前根据 session 设备标识做轻量映射；真正 MSO 设备模型将在目标 1/2 继续补。
- 原版完整 command palette / shortcuts dialog 尚未搬入。

## 对应 Git 提交

- `port: sidebar command infrastructure`
