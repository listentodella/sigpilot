# GitHub Workflows

## 跨平台构建说明

### 构建 Workflow

`build-cross-platform.yml` 提供了完整的跨平台构建流程：

- **macOS**: 构建 arm64 和 x64 两个架构的 `.app` 和 `.dmg`
- **Windows**: 构建 x64 架构的 `.exe` (NSIS) 和 `.msi`
- **Linux**: 构建 x64 架构的 `.AppImage` 和 `.deb`

### 平台特定说明

#### macOS
- **构建产物**: `.app.zip` 和 `.dmg`
- **Runner**: `macos-14` (Apple Silicon) 和 `macos-13` (Intel)
- **特定依赖**: 
  - Saleae runtime (仅 macOS 版本包含完整的 legacy 解码器支持)
  - macOS 特定的 Objective-C 依赖 (block2, objc2-*)

#### Windows
- **构建产物**: `.exe` (NSIS 安装器) 和 `.msi`
- **Runner**: `windows-latest`
- **功能限制**:
  - 不包含 Saleae legacy runtime (仅支持 sigrok 解码)
  - 基础采集和导入功能完整
  - 截图功能使用通用实现

#### Linux
- **构建产物**: `.AppImage` 和 `.deb`
- **Runner**: `ubuntu-22.04`
- **依赖**: webkit2gtk-4.1, gtk-3, libusb-1.0
- **功能限制**:
  - 不包含 Saleae legacy runtime (仅支持 sigrok 解码)
  - 基础采集和导入功能完整
  - 截图功能使用通用实现

### 触发条件

- **Push**: 推送到 main/master/develop 分支或 `v*` tag
- **Pull Request**: 针对上述分支的 PR
- **手动**: 通过 GitHub Actions 手动触发

### 发布流程

当推送 `v*` tag 时（例如 `v0.1.0`），workflow 会自动：

1. 构建所有平台的产物
2. 创建 GitHub Release
3. 上传所有构建产物到 Release

创建 release 的示例命令：

```bash
git tag v0.1.0
git push origin v0.1.0
```

### 本地测试

在推送 tag 之前，可以通过以下方式测试构建：

```bash
# macOS
pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg

# Windows (在 Windows 机器上)
pnpm tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi

# Linux (在 Linux 机器上)
pnpm tauri build --target x86_64-unknown-linux-gnu --bundles appimage,deb
```

### 平台功能对比

| 功能 | macOS | Windows | Linux |
|------|-------|---------|-------|
| 基础采集 | ✅ | ✅ | ✅ |
| .pxl 导入导出 | ✅ | ✅ | ✅ |
| Sigrok 解码 | ✅ | ✅ | ✅ |
| Saleae Legacy 解码 | ✅ | ❌ | ❌ |
| 原生截图 | ✅ | ❌ | ❌ |
| USB 设备支持 | ✅ | ✅ | ✅ |

### 已知限制

1. **Windows/Linux**: 
   - Saleae runtime 依赖 macOS 特定的动态库，暂时无法跨平台
   - 可以导入 Saleae `.sal` 文件，但无法使用 legacy 解码器

2. **截图功能**:
   - Windows/Linux 的 `capture_screenshot_png` 返回错误
   - 前端应该优雅降级或使用 HTML Canvas 截图方案

3. **资源打包**:
   - `resources/native` 中的 Saleae runtime 仅在 macOS 版本中有效
   - 其他平台仍会打包这些文件，但不会被使用
