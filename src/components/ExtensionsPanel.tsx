import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
  CircleHelp,
  ExternalLink,
  FolderOpen,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createExtensionTemplate, readExtensionPackage } from "../lib/api";
import {
  extensionFeatureLabel,
  extensionRecordFromPackage,
  sortUiExtensions,
  UiExtensionFeatureType,
  UiExtensionManifest,
  UiExtensionRecord,
} from "../lib/extensions";

interface ExtensionsPanelProps {
  busy: boolean;
  extensions: UiExtensionRecord[];
  onChange: (updater: (extensions: UiExtensionRecord[]) => UiExtensionRecord[]) => void;
  onNotify: (message: string) => void;
}

const EXTENSION_DOCS_URL = "https://support.saleae.com/extensions";
const MARKETPLACE_TERMS_URL = "https://www.saleae.com/terms";
const PUBLISH_URL = "https://marketplace.saleae.com/publish";

export function ExtensionsPanel({ busy, extensions, onChange, onNotify }: ExtensionsPanelProps) {
  const { t } = useTranslation("extensions");
  const [searchQuery, setSearchQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sorted = useMemo(() => sortUiExtensions(extensions), [extensions]);
  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((extension) => {
      const manifest = extension.manifest;
      return (
        manifest.name.toLowerCase().includes(query) ||
        manifest.author.toLowerCase().includes(query) ||
        manifest.description?.toLowerCase().includes(query)
      );
    });
  }, [searchQuery, sorted]);
  const selectedExtension = extensions.find((extension) => extension.id === selectedId) ?? null;
  const updateCount = extensions.filter((extension) => extension.canUpdate && extension.installed).length;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (selectedId) {
        setSelectedId(null);
      } else if (createOpen) {
        setCreateOpen(false);
      } else {
        setMenuOpen(false);
        setHelpOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [createOpen, selectedId]);

  function updateExtension(id: string, updater: (extension: UiExtensionRecord) => UiExtensionRecord) {
    onChange((current) => current.map((extension) => (extension.id === id ? updater(extension) : extension)));
  }

  function install(extension: UiExtensionRecord) {
    updateExtension(extension.id, (current) => ({
      ...current,
      enabled: true,
      installed: true,
    }));
    onNotify(`${extension.manifest.name} was installed`);
  }

  function uninstall(extension: UiExtensionRecord) {
    if (busy || extension.source === "BuiltIn") return;
    if (extension.source === "Local") {
      onChange((current) => current.filter((item) => item.id !== extension.id));
      setSelectedId(null);
    } else {
      updateExtension(extension.id, (current) => ({
        ...current,
        enabled: false,
        installed: false,
      }));
    }
    onNotify(`${extension.manifest.name} was uninstalled`);
  }

  function toggleEnabled(extension: UiExtensionRecord) {
    if (busy || !extension.installed) return;
    updateExtension(extension.id, (current) => ({ ...current, enabled: !current.enabled }));
    onNotify(`${extension.manifest.name} ${extension.enabled ? "disabled" : "enabled"}`);
  }

  function update(extension: UiExtensionRecord) {
    if (busy || !extension.canUpdate) return;
    updateExtension(extension.id, (current) => ({ ...current, canUpdate: false }));
    onNotify(`${extension.manifest.name} updated`);
  }

  function updateAll() {
    if (busy) return;
    onChange((current) => current.map((extension) => ({ ...extension, canUpdate: false })));
    onNotify(`${updateCount} extension update${updateCount === 1 ? "" : "s"} installed`);
  }

  async function reloadLocal(extension: UiExtensionRecord) {
    if (busy || !extension.localPath) return;
    try {
      const extensionPackage = await readExtensionPackage(extension.localPath);
      updateExtension(extension.id, (current) => ({
        ...current,
        manifest: extensionPackage.manifest,
        readme: extensionPackage.readme,
      }));
      onNotify(`${extension.manifest.name} reloaded`);
    } catch (error) {
      onNotify(String(error));
    }
  }

  async function loadExistingExtension() {
    setMenuOpen(false);
    if (!("__TAURI_INTERNALS__" in window)) {
      fileInputRef.current?.click();
      return;
    }
    try {
      setLoadingFile(true);
      const path = await openDialog({
        multiple: false,
        filters: [{ name: t("jsonFilter"), extensions: ["json"] }],
        title: t("selectJsonFile"),
      });
      if (typeof path !== "string") return;
      const extensionPackage = await readExtensionPackage(path);
      addLoadedExtension(extensionRecordFromPackage(extensionPackage));
    } catch (error) {
      onNotify(String(error));
    } finally {
      setLoadingFile(false);
    }
  }

  async function handleBrowserFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const manifest = JSON.parse(await file.text()) as UiExtensionManifest;
      if (!isExtensionManifest(manifest)) {
        throw new Error("The selected extension.json is missing required metadata");
      }
      addLoadedExtension(
        extensionRecordFromPackage({
          manifest,
          path: file.name,
        }),
      );
    } catch (error) {
      onNotify(String(error));
    }
  }

  function addLoadedExtension(extension: UiExtensionRecord) {
    onChange((current) => {
      const duplicate = current.findIndex(
        (item) => item.localPath === extension.localPath || item.id === extension.id,
      );
      if (duplicate < 0) return [...current, extension];
      return current.map((item, index) => (index === duplicate ? extension : item));
    });
    onNotify(`${extension.manifest.name} loaded`);
  }

  function refreshMarketplace() {
    setMenuOpen(false);
    onNotify(t("marketplaceChecked"));
  }

  return (
    <div className="extensionsSidebar">
      <header className="extensionsHeader">
        <div className="extensionsHeaderTitle">
          <strong>{t("title")}</strong>
          <button
            aria-label={t("about")}
            className={helpOpen ? "active" : ""}
            onClick={() => setHelpOpen((open) => !open)}
            type="button"
          >
            <CircleHelp size={15} />
          </button>
        </div>
        <div className="extensionsMenuAnchor">
          <button
            aria-label={t("menu")}
            className={menuOpen ? "active" : ""}
            onClick={() => setMenuOpen((open) => !open)}
            type="button"
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <div className="extensionsMenu">
              <button disabled={busy} onClick={() => { setMenuOpen(false); setCreateOpen(true); }} type="button">
                Create New Extension...
              </button>
              <button disabled={busy || loadingFile} onClick={loadExistingExtension} type="button">
                Load Existing Extension...
              </button>
              <button disabled={busy} onClick={() => openExternal(PUBLISH_URL)} type="button">
                Publish Extension
              </button>
              <button disabled={busy} onClick={refreshMarketplace} type="button">
                Check for Updates
              </button>
              <button onClick={() => openExternal(MARKETPLACE_TERMS_URL)} type="button">
                Marketplace Terms
              </button>
            </div>
          )}
        </div>
        {helpOpen && (
          <div className="extensionsHelpPopover">
            Extensions are community-written Python modules for High-Level Analyzers and digital or analog
            measurements.
            <button onClick={() => openExternal(EXTENSION_DOCS_URL)} type="button">
              Learn More <ExternalLink size={11} />
            </button>
          </div>
        )}
      </header>

      <div className="extensionsSearchSection">
        <Search size={14} />
        <input
          aria-label={t("searchLabel")}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t("searchPlaceholder")}
          type="search"
          value={searchQuery}
        />
      </div>

      {updateCount > 0 && (
        <div className="extensionUpdateBar">
          <span>{updateCount} update available</span>
          <button disabled={busy} onClick={updateAll} type="button">
            Update All
          </button>
        </div>
      )}

      <div className="extensionsListScroll">
        {filtered.map((extension, index) => (
          <ExtensionListItem
            busy={busy}
            extension={extension}
            isSelected={extension.id === selectedId}
            key={extension.id}
            onInstall={() => install(extension)}
            onOpen={() => setSelectedId(extension.id === selectedId ? null : extension.id)}
            onReload={() => reloadLocal(extension)}
            onToggleEnabled={() => toggleEnabled(extension)}
            onUninstall={() => uninstall(extension)}
            onUpdate={() => update(extension)}
          />
        ))}

        {filtered.length === 0 && searchQuery.trim() && (
          <div className="extensionsNoResults">
            No Results. Change or simplify your search terms to try again.
          </div>
        )}

        {(filtered.length === 0 || !searchQuery.trim()) && (
          <CreateExtensionCard onCreate={() => setCreateOpen(true)} />
        )}
      </div>

      <input
        accept="application/json,.json"
        className="extensionFileInput"
        onChange={handleBrowserFile}
        ref={fileInputRef}
        type="file"
      />

      {createOpen && (
        <CreateExtensionDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(extension) => {
            addLoadedExtension(extension);
            setCreateOpen(false);
          }}
          onNotify={onNotify}
        />
      )}

      {selectedExtension &&
        createPortal(
          <ExtensionDetail
            busy={busy}
            extension={selectedExtension}
            onClose={() => setSelectedId(null)}
            onInstall={() => install(selectedExtension)}
            onToggleEnabled={() => toggleEnabled(selectedExtension)}
            onUninstall={() => uninstall(selectedExtension)}
          />,
          document.body,
        )}
    </div>
  );
}

function ExtensionListItem({
  busy,
  extension,
  isSelected,
  onInstall,
  onOpen,
  onReload,
  onToggleEnabled,
  onUninstall,
  onUpdate,
}: {
  busy: boolean;
  extension: UiExtensionRecord;
  isSelected: boolean;
  onInstall: () => void;
  onOpen: () => void;
  onReload: () => void;
  onToggleEnabled: () => void;
  onUninstall: () => void;
  onUpdate: () => void;
}) {
  const { t } = useTranslation("extensions");
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const action =
    extension.source === "Marketplace" && !extension.installed
      ? { label: t("install"), onClick: onInstall }
      : extension.canUpdate
        ? { label: t("update"), onClick: onUpdate }
        : null;

  return (
    <div
      className={`extensionListItem ${isSelected ? "selected" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setMenuOpen(false); }}
    >
      <div
        className="extensionListMain"
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <div className="extensionListTitle">
          <strong style={{ opacity: extension.enabled || !extension.installed ? 1 : 0.5 }}>
            {extension.manifest.name}
          </strong>
          {extension.source === "Local" && <span className="localBadge">{t("localBadge")}</span>}
          {extension.source === "Local" && (
            <button
              aria-label={t("reload")}
              className="extensionReloadButton"
              disabled={busy}
              onClick={(event) => { event.stopPropagation(); onReload(); }}
              type="button"
            >
              <RefreshCw size={11} />
            </button>
          )}
        </div>
        <p style={{ opacity: extension.enabled || !extension.installed ? 1 : 0.5 }}>
          {extension.manifest.description || t("noDescription")}
        </p>
        <div className="extensionListFooter">
          <span>by {extension.manifest.author}</span>
          {action && (
            <button
              className="extensionInlineAction"
              disabled={busy}
              onClick={(event) => { event.stopPropagation(); action.onClick(); }}
              type="button"
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
      <div className={`extensionItemMenuAnchor ${hovered || menuOpen ? "visible" : ""}`}>
        <button
          aria-label={`${extension.manifest.name} menu`}
          onClick={() => setMenuOpen((open) => !open)}
          type="button"
        >
          <MoreVertical size={14} />
        </button>
        {menuOpen && (
          <div className="extensionItemMenu">
            {extension.source === "Marketplace" && !extension.installed && (
              <button onClick={onInstall} type="button">{t("install")}</button>
            )}
            {extension.source !== "BuiltIn" && extension.installed && (
              <button disabled={busy} onClick={onUninstall} type="button">
              {t("uninstall")}
            </button>
            )}
            {extension.installed && (
              <button disabled={busy} onClick={onToggleEnabled} type="button">
                {extension.enabled ? t("disable") : t("enable")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CreateExtensionCard({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation("extensions");
  return (
    <div className="createExtensionCard">
      <div className="extensionShapes" aria-hidden="true">
        <span className="extensionTriangle" />
        <span className="extensionCircle" />
        <span className="extensionSquare" />
      </div>
      <strong>{t("createYourOwn")}</strong>
      <p>
        Visit the{" "}
        <button onClick={() => openExternal(EXTENSION_DOCS_URL)} type="button">
          documentation page
        </button>{" "}
        to learn more
      </p>
      <button className="createExtensionButton" onClick={onCreate} type="button">
        Create Extension
      </button>
    </div>
  );
}

function CreateExtensionDialog({
  onClose,
  onCreated,
  onNotify,
}: {
  onClose: () => void;
  onCreated: (extension: UiExtensionRecord) => void;
  onNotify: (message: string) => void;
}) {
  const { t } = useTranslation("extensions");
  const [type, setType] = useState<UiExtensionFeatureType>("HighLevelAnalyzer");
  const [additionalOpen, setAdditionalOpen] = useState(false);
  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    try {
      setBusy(true);
      let path: string | null = null;
      if ("__TAURI_INTERNALS__" in window) {
        path = await saveDialog({
          defaultPath: name.trim() || "My Extension",
          title: t("createFolderTitle"),
        });
      } else {
        path = `preview:${slugify(name) || "my-extension"}`;
      }
      if (!path) return;
      const extensionPackage = await createExtensionTemplate({
        author,
        description,
        name,
        path,
        type,
      });
      onCreated(extensionRecordFromPackage(extensionPackage));
    } catch (error) {
      onNotify(String(error));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="extensionDialogBackdrop" onMouseDown={onClose}>
      <section className="extensionDialog" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <strong>{t("createTitle")}</strong>
          <button aria-label={t("close")} onClick={onClose} type="button"><X size={14} /></button>
        </header>
        <div className="extensionDialogBody">
          <h3>{t("generateFromTemplate")}</h3>
          <div className="extensionTemplateRow">
            <div>
              <select value={type} onChange={(event) => setType(event.target.value as UiExtensionFeatureType)}>
                <option value="HighLevelAnalyzer">{t("typeHighLevelAnalyzer")}</option>
                <option value="DigitalMeasurement">{t("typeDigitalMeasurement")}</option>
                <option value="AnalogMeasurement">{t("typeAnalogMeasurement")}</option>
              </select>
              <button
                className={`extensionAdditionalToggle ${additionalOpen ? "open" : ""}`}
                onClick={() => setAdditionalOpen((open) => !open)}
                type="button"
              >
                <ChevronRight size={12} />
                Additional Information
              </button>
              {additionalOpen && (
                <div className="extensionAdditionalFields">
                  <input onChange={(event) => setName(event.target.value)} placeholder={t("fieldTitle")} value={name} />
                  <input onChange={(event) => setAuthor(event.target.value)} placeholder={t("fieldAuthor")} value={author} />
                  <input
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={t("fieldDescription")}
                    value={description}
                  />
                </div>
              )}
            </div>
            <button className="extensionSaveAsButton" disabled={busy} onClick={create} type="button">
              <FolderOpen size={14} />
              Save As...
            </button>
          </div>
          <button className="extensionDocsLink" onClick={() => openExternal(EXTENSION_DOCS_URL)} type="button">
            Documentation and Examples
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ExtensionDetail({
  busy,
  extension,
  onClose,
  onInstall,
  onToggleEnabled,
  onUninstall,
}: {
  busy: boolean;
  extension: UiExtensionRecord;
  onClose: () => void;
  onInstall: () => void;
  onToggleEnabled: () => void;
  onUninstall: () => void;
}) {
  const { t } = useTranslation("extensions");
  return (
    <div className="extensionDetailOverlay">
      <aside className="extensionDetailSummary">
        {extension.source === "Marketplace" && (
          <div className="extensionDetailAvatar">{extension.manifest.author.slice(0, 1).toUpperCase()}</div>
        )}
        <h2>{extension.manifest.name}</h2>
        <p>by {extension.manifest.author}</p>
        <p>{extension.manifest.version}</p>
        {extension.source === "Marketplace" && !extension.installed ? (
          <button className="extensionPrimaryButton" onClick={onInstall} type="button">Install</button>
        ) : extension.source !== "BuiltIn" ? (
          <button className="extensionDangerButton" disabled={busy} onClick={onUninstall} type="button">
            Uninstall
          </button>
        ) : null}
        {extension.installed && (
          <label className="extensionEnabledToggle">
            <input
              checked={extension.enabled}
              disabled={busy}
              onChange={onToggleEnabled}
              type="checkbox"
            />
            <span>{extension.enabled ? t("enabled") : t("disabled")}</span>
          </label>
        )}
        {extension.repository && (
          <button className="extensionDetailLink" onClick={() => openExternal(extension.repository!)} type="button">
            Repository
          </button>
        )}
        <button className="extensionDetailLink" onClick={() => openExternal("https://www.saleae.com/contact")} type="button">
          Report
        </button>
      </aside>
      <article className="extensionReadme">
        <button aria-label={t("closeDetails")} className="extensionDetailClose" onClick={onClose} type="button">
          <X size={14} />
        </button>
        <ReadmeContent extension={extension} />
      </article>
    </div>
  );
}

function ReadmeContent({ extension }: { extension: UiExtensionRecord }) {
  const { t } = useTranslation("extensions");
  const readme = extension.readme?.trim();
  if (!readme) return <p>readme.md missing from extension</p>;
  return (
    <>
      {readme.split(/\r?\n/).map((line, index) => {
        if (line.startsWith("## ")) return <h2 key={index}>{line.slice(3)}</h2>;
        if (line.startsWith("# ")) return <h1 key={index}>{line.slice(2)}</h1>;
        if (/^\d+\.\s/.test(line)) return <p className="extensionReadmeList" key={index}>{line}</p>;
        if (!line.trim()) return <div className="extensionReadmeSpacer" key={index} />;
        return <p key={index}>{line}</p>;
      })}
      <h3>{t("includedFeatures")}</h3>
      {Object.entries(extension.manifest.extensions).length === 0 ? (
        <p>No feature metadata is available until this marketplace extension is installed.</p>
      ) : (
        Object.entries(extension.manifest.extensions).map(([name, feature]) => (
          <div className="extensionFeatureRow" key={name}>
            <strong>{name}</strong>
            <span>{extensionFeatureLabel(feature.type)}</span>
            <code>{feature.entryPoint}</code>
          </div>
        ))
      )}
    </>
  );
}

function isExtensionManifest(value: unknown): value is UiExtensionManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<UiExtensionManifest>;
  return (
    typeof manifest.name === "string" &&
    typeof manifest.author === "string" &&
    typeof manifest.version === "string" &&
    typeof manifest.apiVersion === "string" &&
    Boolean(manifest.extensions) &&
    typeof manifest.extensions === "object"
  );
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}
