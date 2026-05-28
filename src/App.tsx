import { Copy, Download, Save, Settings, SquarePen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Excalidraw, convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";
import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  NormalizedZoomValue,
} from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import "./App.css";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

window.EXCALIDRAW_ASSET_PATH = "/";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const SETTINGS_STORAGE_KEY = "fast-settings";
const DEFAULT_SETTINGS: AppSettings = {
  exportBackground: true,
  exportPadding: 0,
  viewBackgroundColor: "#ffffff",
};
const SHORTCUTS = {
  capture: "Cmd/Ctrl+Shift+N",
  copy: "Cmd/Ctrl+Shift+C",
  copyClose: "Esc",
  save: "Cmd/Ctrl+S",
  discard: "Cmd/Ctrl+Shift+D",
  settings: "Cmd/Ctrl+,",
};

type CaptureScene = {
  key: number;
  src: string;
  width: number;
  height: number;
  fileId: FileId;
  files: BinaryFiles;
};

type AppSettings = {
  exportBackground: boolean;
  exportPadding: number;
  viewBackgroundColor: string;
};

function loadSettings(): AppSettings {
  try {
    const rawSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!rawSettings) return DEFAULT_SETTINGS;

    const parsedSettings = JSON.parse(rawSettings) as Partial<AppSettings>;
    return {
      exportBackground:
        typeof parsedSettings.exportBackground === "boolean"
          ? parsedSettings.exportBackground
          : DEFAULT_SETTINGS.exportBackground,
      exportPadding:
        typeof parsedSettings.exportPadding === "number"
          ? Math.min(128, Math.max(0, parsedSettings.exportPadding))
          : DEFAULT_SETTINGS.exportPadding,
      viewBackgroundColor:
        typeof parsedSettings.viewBackgroundColor === "string"
          ? parsedSettings.viewBackgroundColor
          : DEFAULT_SETTINGS.viewBackgroundColor,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load capture image"));
    image.src = src;
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read exported PNG"));
    reader.readAsDataURL(blob);
  });
}

function buildCaptureScene(src: string, width: number, height: number): CaptureScene {
  const fileId = `fast-capture-${Date.now()}` as FileId;
  const now = Date.now();
  const file: BinaryFileData = {
    id: fileId,
    dataURL: src as DataURL,
    mimeType: "image/png",
    created: now,
    lastRetrieved: now,
  };

  return {
    key: now,
    src,
    width,
    height,
    fileId,
    files: {
      [fileId]: file,
    },
  };
}

function normalizedZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) as NormalizedZoomValue;
}

function ShortcutKey({ children }: { children: string }) {
  return <kbd className="shortcut-key">{children}</kbd>;
}

function App() {
  const excalidrawRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [scene, setScene] = useState<CaptureScene | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [message, setMessage] = useState("Ready for a region capture.");
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const captureRegion = useCallback(async () => {
    setIsCapturing(true);
    setMessage("Select a region with the macOS capture cursor.");
    try {
      const src = await invoke<string>("capture_region");
      const image = await loadImage(src);
      const nextScene = buildCaptureScene(src, image.naturalWidth, image.naturalHeight);
      setScene(nextScene);
      setMessage("Captured. Use Excalidraw tools to annotate, then copy or save.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setIsCapturing(false);
    }
  }, []);

  const exportPng = useCallback(async () => {
    const api = excalidrawRef.current;
    if (!api) throw new Error("Editor is not ready.");

    const blob = await exportToBlob({
      elements: api.getSceneElements(),
      appState: {
        ...api.getAppState(),
        exportBackground: settings.exportBackground,
        viewBackgroundColor: settings.viewBackgroundColor,
      },
      files: api.getFiles(),
      mimeType: "image/png",
      exportPadding: settings.exportPadding,
    });

    return blobToDataUrl(blob);
  }, [settings]);

  const copyImage = useCallback(async () => {
    try {
      const png = await exportPng();
      await invoke("copy_png_to_clipboard", { dataUrl: png });
      setMessage("Copied annotated PNG to clipboard.");
    } catch (error) {
      setMessage(String(error));
    }
  }, [exportPng]);

  const copyImageAndClose = useCallback(async () => {
    try {
      const png = await exportPng();
      await invoke("copy_png_to_clipboard", { dataUrl: png });
      await invoke("close_window");
    } catch (error) {
      setMessage(String(error));
    }
  }, [exportPng]);

  const saveImage = useCallback(async () => {
    try {
      const png = await exportPng();
      const path = await invoke<string>("save_png", { dataUrl: png });
      setMessage(`Saved ${path}`);
    } catch (error) {
      setMessage(String(error));
    }
  }, [exportPng]);

  const discardCapture = useCallback(() => {
    setScene(null);
    excalidrawRef.current = null;
    setMessage("Capture discarded.");
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    excalidrawRef.current?.updateScene({
      appState: {
        viewBackgroundColor: settings.viewBackgroundColor,
      },
    });
  }, [settings]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditableTarget =
        target?.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;

      if (event.defaultPrevented || isEditableTarget) return;

      if (event.key === "Escape" && settingsOpen) {
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }

      if (event.key === "Escape" && scene) {
        event.preventDefault();
        void copyImageAndClose();
        return;
      }

      if (!event.metaKey && !event.ctrlKey) return;

      const key = event.key.toLowerCase();

      if (key === ",") {
        event.preventDefault();
        setSettingsOpen((open) => !open);
        return;
      }

      if (event.shiftKey && key === "n") {
        event.preventDefault();
        void captureRegion();
        return;
      }

      if (!scene) return;

      if (event.shiftKey && key === "c") {
        event.preventDefault();
        void copyImage();
        return;
      }

      if (!event.shiftKey && key === "s") {
        event.preventDefault();
        void saveImage();
        return;
      }

      if (event.shiftKey && key === "d") {
        event.preventDefault();
        discardCapture();
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [captureRegion, copyImage, copyImageAndClose, discardCapture, saveImage, scene, settingsOpen]);

  const initialData: ExcalidrawInitialDataState | null = scene
    ? {
        elements: convertToExcalidrawElements(
          [
            {
              type: "image",
              x: 0,
              y: 0,
              width: scene.width,
              height: scene.height,
              fileId: scene.fileId,
              status: "saved",
              locked: true,
            },
          ],
          { regenerateIds: false },
        ),
        files: scene.files,
        appState: {
          viewBackgroundColor: settings.viewBackgroundColor,
          currentItemStrokeColor: "#f04438",
          currentItemBackgroundColor: "transparent",
          currentItemFillStyle: "hachure" as const,
          currentItemStrokeWidth: 2,
          currentItemRoughness: 1,
          activeTool: { type: "selection", customType: null, locked: false, lastActiveTool: null },
          scrollX: 80,
          scrollY: 80,
          zoom: { value: normalizedZoom(1) },
        },
        scrollToContent: true,
      }
    : null;

  return (
    <main className="app-shell">
      <section className="workspace">
        <div className="floating-actions" aria-label="FAST actions">
          <button
            className="action-button"
            onClick={captureRegion}
            disabled={isCapturing}
            title={`Capture region (${SHORTCUTS.capture})`}
            aria-label="Capture region"
            data-tooltip="Capture region"
            data-shortcut={SHORTCUTS.capture}
            type="button"
          >
            <SquarePen size={18} />
          </button>
          <button
            className="action-button"
            onClick={copyImage}
            disabled={!scene}
            title={`Copy PNG (${SHORTCUTS.copy})`}
            aria-label="Copy PNG"
            data-tooltip="Copy PNG"
            data-shortcut={SHORTCUTS.copy}
            type="button"
          >
            <Copy size={18} />
          </button>
          <button
            className="action-button"
            onClick={saveImage}
            disabled={!scene}
            title={`Save PNG (${SHORTCUTS.save})`}
            aria-label="Save PNG"
            data-tooltip="Save PNG"
            data-shortcut={SHORTCUTS.save}
            type="button"
          >
            <Save size={18} />
          </button>
          <button
            className="action-button"
            onClick={discardCapture}
            disabled={!scene}
            title={`Discard capture (${SHORTCUTS.discard})`}
            aria-label="Discard capture"
            data-tooltip="Discard capture"
            data-shortcut={SHORTCUTS.discard}
            type="button"
          >
            <X size={18} />
          </button>
          <button
            className="action-button"
            onClick={() => setSettingsOpen(true)}
            title={`Settings (${SHORTCUTS.settings})`}
            aria-label="Settings"
            data-tooltip="Settings"
            data-shortcut={SHORTCUTS.settings}
            type="button"
          >
            <Settings size={18} />
          </button>
        </div>

        <p className="status" role="status">
          {message}
        </p>

        {scene && initialData ? (
          <div className="excalidraw-stage">
            <Excalidraw
              key={scene.key}
              initialData={initialData}
              excalidrawAPI={(api) => {
                excalidrawRef.current = api;
                api.addFiles(Object.values(scene.files));
                api.setActiveTool({ type: "selection", locked: false });
                requestAnimationFrame(() => api.scrollToContent(api.getSceneElements(), { fitToContent: true }));
              }}
              autoFocus
              handleKeyboardGlobally
              UIOptions={{
                canvasActions: {
                  loadScene: false,
                  saveToActiveFile: false,
                  export: false,
                  saveAsImage: false,
                  toggleTheme: false,
                },
              }}
            />
          </div>
        ) : (
          <div className="empty-state">
            <h2>Capture a region to start.</h2>
            <p>FAST opens the selected image in an Excalidraw-powered annotation editor.</p>
            <button onClick={captureRegion} disabled={isCapturing}>
              <Download size={18} />
              <span>{isCapturing ? "Waiting for selection" : "Capture Region"}</span>
            </button>
          </div>
        )}

        {settingsOpen ? (
          <div className="settings-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
            <section
              className="settings-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="settings-header">
                <div>
                  <h2 id="settings-title">Settings</h2>
                  <p>Export defaults, canvas appearance, and keyboard shortcuts.</p>
                </div>
                <button onClick={() => setSettingsOpen(false)} title="Close settings" aria-label="Close settings">
                  <X size={18} />
                </button>
              </header>

              <div className="settings-content">
                <section className="settings-section" aria-labelledby="export-settings-title">
                  <div className="settings-section-heading">
                    <h3 id="export-settings-title">Export</h3>
                    <p>Controls used whenever you copy or save a PNG.</p>
                  </div>

                  <label className="setting-row setting-row-toggle">
                    <span>
                      <strong>Include background</strong>
                      <small>Keep the canvas color in exported images.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={settings.exportBackground}
                      onChange={(event) =>
                        setSettings((current) => ({ ...current, exportBackground: event.target.checked }))
                      }
                    />
                  </label>

                  <label className="setting-row">
                    <span>
                      <strong>Export padding</strong>
                      <small>Add whitespace around the final PNG.</small>
                    </span>
                    <span className="number-control">
                      <input
                        type="number"
                        min="0"
                        max="128"
                        step="1"
                        value={settings.exportPadding}
                        onChange={(event) =>
                          setSettings((current) => ({
                            ...current,
                            exportPadding: Math.min(128, Math.max(0, Number(event.target.value) || 0)),
                          }))
                        }
                      />
                      <span>px</span>
                    </span>
                  </label>
                </section>

                <section className="settings-section" aria-labelledby="canvas-settings-title">
                  <div className="settings-section-heading">
                    <h3 id="canvas-settings-title">Canvas</h3>
                    <p>The editor background updates immediately.</p>
                  </div>

                  <label className="setting-row">
                    <span>
                      <strong>Background color</strong>
                      <small>{settings.viewBackgroundColor.toUpperCase()}</small>
                    </span>
                    <span className="color-control">
                      <span className="color-swatch" style={{ backgroundColor: settings.viewBackgroundColor }} />
                      <input
                        type="color"
                        value={settings.viewBackgroundColor}
                        onChange={(event) =>
                          setSettings((current) => ({ ...current, viewBackgroundColor: event.target.value }))
                        }
                      />
                    </span>
                  </label>
                </section>

                <section className="settings-section" aria-labelledby="shortcut-settings-title">
                  <div className="settings-section-heading">
                    <h3 id="shortcut-settings-title">Shortcuts</h3>
                    <p>Use Cmd on macOS or Ctrl on Windows and Linux.</p>
                  </div>

                  <dl className="shortcut-list">
                    <div>
                      <dt>Capture region</dt>
                      <dd>
                        <ShortcutKey>{SHORTCUTS.capture}</ShortcutKey>
                      </dd>
                    </div>
                    <div>
                      <dt>Copy PNG</dt>
                      <dd>
                        <ShortcutKey>{SHORTCUTS.copy}</ShortcutKey>
                      </dd>
                    </div>
                    <div>
                      <dt>Copy and close</dt>
                      <dd>
                        <ShortcutKey>{SHORTCUTS.copyClose}</ShortcutKey>
                      </dd>
                    </div>
                    <div>
                      <dt>Save PNG</dt>
                      <dd>
                        <ShortcutKey>{SHORTCUTS.save}</ShortcutKey>
                      </dd>
                    </div>
                    <div>
                      <dt>Discard capture</dt>
                      <dd>
                        <ShortcutKey>{SHORTCUTS.discard}</ShortcutKey>
                      </dd>
                    </div>
                    <div>
                      <dt>Open settings</dt>
                      <dd>
                        <ShortcutKey>{SHORTCUTS.settings}</ShortcutKey>
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}

export default App;
