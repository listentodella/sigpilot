# Analyzers 右侧栏

## 功能范围

- 将 Analyzers 面板替换为 Saleae 风格结构：标题、`+` analyzer selection、Suggested Analyzers、active analyzer 列表。
- Active analyzer 支持删除、上移、下移和设置区。
- Async Serial 复用现有 UART decode：Input channel、Bit rate、Inverted、Decode。
- 增加 Data 区：Data Table / Terminal 切换、帧列表跳转、复制帧 label。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/compositions/AnalyzersSidebar.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/compositions/AnalyzersSelector/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/compositions/AnalyzersSelector/AnalyzerSelectionPopover.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/compositions/AnalyzersSelector/SuggestedAnalyzers.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/compositions/AnalyzersSelector/AnalyzerItem.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/dataTable`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/terminal/SerialTerminal.tsx`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`

## 复用方式

- 结构复刻：按原版 `AnalyzersSelector` + `Data` 区组织面板。
- 行为复刻：`+` 弹出 analyzer selection；无 analyzer 时显示 Suggested Analyzers；active analyzer 可重排/删除。
- 功能复用：Async Serial 直接接入现有 `decodeUartFrames` 和 decode result 跳转。
- 适配实现：I2C/SPI/CAN/I2S/Manchester 先保留 selection 和 active item 入口，具体 settings/decoder 后续逐项搬运。

## 用户可见行为

- 打开 Analyzers 后能从 Suggested Analyzers 或 `+` 添加 Async Serial。
- Async Serial 设置可修改输入通道、bit rate、inverted，并触发 decode。
- Data Table 中点击帧会跳转到对应样本位置。
- Terminal 视图会以时间 + label 的形式显示同一批 decoded frames。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`
- 点击 `Try a demo Logic device`，打开 `Analyzers (N A)`。
- 添加 `Async Serial`，验证 active analyzer row 出现。
- 验证 Data Table 有 18 条 decode row，切换 Terminal 后有 18 条 terminal line。

## 已知差距 / 后续任务

- 非 Async Serial analyzer 只有入口和禁用设置区，完整配置与 decode 后续按 analyzer 类型搬。
- 原版 data table 的列配置、搜索、导出、table free space warning 尚未搬入。
- 原版 analyzer trigger settings / HLA sidebar 未在本目标展开。

## 对应 Git 提交

- `port: analyzers sidebar`
