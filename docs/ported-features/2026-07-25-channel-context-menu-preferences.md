# 通道右键菜单 Preferences

## 功能范围

- 将通道右键菜单 `Settings` 从 Device Settings 跳转占位替换为应用级 Settings 对话框。
- 搬运并接通三项适用于 PXLogic 的原版全局设置：
  - `Color-match Waveforms`
  - `Pan to Trigger`
  - `When saving a capture rename tab to saved capture filename`
- `Show/Hide Channels` 子菜单只列当前 active digital rows，不再列出全部 32 路并禁用未启用项。
- Screenshot Destination 文案恢复为原版 `Save to File` / `Copy to Clipboard`。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/RowContextMenu.tsx`
  - `Settings` 调用 `dialogApi.open('preferences')`。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/preferences/index.tsx`
  - Preferences section 顺序、标题、checkbox 文案和默认值。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/preferences/styles.module.css`
  - section title 的 12px 下间距、36px section 间距和内容 padding。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/rowVisibilityMenu/index.tsx`
  - 对 `activeRows.filter(isChannel)` 生成可见性菜单。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/rapidDataStore/SessionStore.ts`
  - 捕获结束后按 `isPanToTriggerAutoUpdates` 定位触发点。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/saveLoadCapture/thunks.tsx`
  - 保存成功后按文件 basename 重命名 session。
- Logic 2.4.43 `127.0.0.1:9222`：
  - 实测原版菜单、active rows、680px Settings dialog 和 `#212224` 背景。

## 本地落点文件

- `src/App.tsx`
- `src/components/PreferencesDialog.tsx`
- `src/components/WaveformCanvas.tsx`
- `src/lib/preferences.ts`
- `src/styles.css`
- `tests/preferences.test.ts`

## 复用方式

- 结构搬运：复用原版 `PreferencesDialog -> DialogHeader -> DialogContent -> Title/Checkbox` 层级和 section 顺序。
- 状态规则搬运：默认 `matchChannelColors=true`、`panToTrigger=true`、`renameTabToSavedCapture=false`，应用全局持久化。
- 算法搬运：颜色不匹配时使用原版 `on-background-0` 白色 fallback；Pan to Trigger 关闭时保留结束前 viewport。
- 算法搬运：保存成功后从实际路径 basename 移除最后一个扩展名并重命名 session。
- 状态规则搬运：可见性菜单严格按 active channel order 构造，隐藏通道仍保留在菜单内以便恢复。
- 范围适配：PXLogic 不支持 MSO，也没有 Saleae telemetry/update/automation server，因此不生成无效控件或新的占位项。

## 用户可见行为

- 通道右键 `Settings` 打开居中的原版深色应用设置对话框，不再打开右侧 Device Settings。
- `Color-match Waveforms` 关闭后数字波形统一使用白色，重新打开后恢复通道色。
- `Pan to Trigger` 打开时捕获完成会把触发点置于 viewport 中央；关闭时保留用户结束前正在查看的位置。
- 保存重命名打开后，保存 `/captures/vehicle-bus.pxcap` 会将 session 改名为 `vehicle-bus`。
- Demo 默认八通道时，Show/Hide submenu 只显示 D0-D7，且没有不可点击的 D8-D31。

## 验证

```sh
node --test tests/preferences.test.ts
pnpm build
cargo test --workspace --no-fail-fast
git diff --check
```

- Node tests 覆盖默认值/旧设置归一化、localStorage round-trip 和保存文件名解析。
- 浏览器 smoke 覆盖 Settings menu click、三项 checkbox、canvas `data-match-channel-colors` 即时变化和 reload 持久化。
- 9222 对照确认原版 active rows 列表为 D0、D2、D3、D4、D5、D6，不包含 inactive D1/D7。
- 本地 Demo 对照确认 active rows 列表为 D0-D7，不包含 D8-D31。

## 已知边界

- 当前产品固定使用 Logic 2 dark theme，因此没有创建不生效的 Light theme 控件。
- PXLogic 不提供 Saleae MSO、匿名数据上报、自动更新或 Automation Server；对应原版 section 被有意省略，而非 disabled placeholder。
- Settings dialog 已复用原版视觉常量与状态规则，但没有引入原版 MobX/Dialog/uikit 依赖树。

## 对应提交

- `port: complete channel context menu preferences`
