# Workflow Backups

This directory contains disabled/backup workflow files.

## build-macos.yml.backup

**原因**: 替换为 `build-cross-platform.yml`

**日期**: 2026-07-28

**说明**: 
- 旧的 macOS 专用构建流程
- 新的跨平台 workflow 已包含完整的 macOS 构建（arm64 + x64）
- 重命名为 `.backup` 后缀，GitHub Actions 会忽略此文件
- 如需恢复: `mv build-macos.yml.backup build-macos.yml`

**功能对比**:

| 功能 | 旧 workflow | 新 workflow |
|------|-------------|-------------|
| macOS arm64 | ✅ | ✅ |
| macOS x64 | ✅ | ✅ |
| Windows | ❌ | ✅ |
| Linux | ❌ | ✅ |
| 产物格式 | .app.zip | .app.zip + .dmg |
| Runner | macos-26 (不存在) | macos-14/13 |

**注意**: 旧 workflow 使用了不存在的 `macos-26` 和 `macos-26-intel` runner，新 workflow 已修正为标准的 GitHub runner。

## build-cross-platform.yml.backup-full

**原因**: 暂时禁用，测试 self-hosted runner

**日期**: 2026-07-28

**说明**:
- 完整的跨平台构建流程（macOS + Windows + Linux）
- 使用 GitHub 托管的 runner
- 暂时备份以避免与 self-hosted 测试冲突
- 修复了所有平台的依赖和构建问题

**如何恢复**:
```bash
# 恢复跨平台构建
mv build-cross-platform.yml.backup-full build-cross-platform.yml

# 禁用 self-hosted 测试
mv test-windows-selfhosted.yml test-windows-selfhosted.yml.disabled
```

**功能特性**:
- ✅ macOS (arm64 + x64) - GitHub hosted
- ✅ Windows (x64) - GitHub hosted  
- ✅ Linux (x64) - GitHub hosted
- ✅ 自动发布到 GitHub Releases (v* tags)
- ✅ 完整的 Linux 依赖安装
- ✅ 跳过 native 资源准备（Windows/Linux）

## 恢复方法

如果需要恢复旧的 macOS 专用构建：

```bash
# 恢复单个文件
mv build-macos.yml.backup build-macos.yml

# 同时禁用跨平台构建（避免冲突）
mv build-cross-platform.yml build-cross-platform.yml.disabled
```

如果需要恢复跨平台构建：

```bash
# 恢复跨平台构建
mv build-cross-platform.yml.backup-full build-cross-platform.yml

# 禁用 self-hosted 测试（避免冲突）
mv test-windows-selfhosted.yml test-windows-selfhosted.yml.disabled
```

## 清理备份

如果确认不再需要备份文件：

```bash
rm *.backup*
```

## 当前激活的 Workflows

- **build-cross-platform.yml**: self-hosted Windows/Linux 与 GitHub 托管 macOS 构建
