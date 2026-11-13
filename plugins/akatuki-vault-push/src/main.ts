import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
} from "obsidian";
import { PushScheduler } from "./scheduler";

interface AkatukiVaultPushSettings {
  endpoint: string;
  token: string;
  debounceSeconds: number;
  enabled: boolean;
}

const DEFAULT_SETTINGS: AkatukiVaultPushSettings = {
  endpoint: "https://akatuki-knowledge.sousou-e1121.workers.dev",
  token: "",
  debounceSeconds: 5,
  enabled: true,
};

const RETRY_DELAYS_MS = [2000, 8000, 32000];
const PUSH_PATH = "/api/sync/push-note";

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

interface LastPush {
  path: string;
  at: string;
  outcome: string;
}

export default class AkatukiVaultPushPlugin extends Plugin {
  settings: AkatukiVaultPushSettings = { ...DEFAULT_SETTINGS };
  private scheduler: PushScheduler | null = null;
  private statusBarItem: HTMLElement | null = null;
  lastPush: LastPush | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBarItem = this.addStatusBarItem();
    this.setStatus("待機中");

    this.scheduler = this.buildScheduler();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.settings.enabled) return;
        if (file instanceof TFile && file.extension === "md") {
          this.scheduler?.notifyChanged(file.path);
        }
      })
    );

    this.addSettingTab(new AkatukiVaultPushSettingTab(this.app, this));
  }

  onunload(): void {
    this.scheduler?.dispose();
    this.scheduler = null;
  }

  private setStatus(text: string): void {
    this.statusBarItem?.setText(`Akatuki Vault Push: ${text}`);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // The debounce window is fixed when the scheduler is built, so rebuild
    // it for a settings change to take effect without restarting Obsidian.
    // The modify handler reads this.scheduler at call time, so swapping the
    // instance here is enough.
    if (this.scheduler) {
      this.scheduler.dispose();
      this.scheduler = this.buildScheduler();
    }
  }

  private buildScheduler(): PushScheduler {
    return new PushScheduler({
      debounceMs: this.settings.debounceSeconds * 1000,
      retryDelaysMs: RETRY_DELAYS_MS,
      readContent: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error("file_not_found");
        return this.app.vault.read(file);
      },
      hashContent: sha256Hex,
      send: async (path, content, contentHash) => {
        const response = await requestUrl({
          url: this.settings.endpoint.replace(/\/+$/, "") + PUSH_PATH,
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.settings.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path,
            content,
            contentHash,
            clientSentAt: new Date().toISOString(),
          }),
          throw: false,
        });
        let body: { ok?: boolean; result?: string; reason?: string | null } | null = null;
        try {
          body = response.json as typeof body;
        } catch {
          body = null;
        }
        return { status: response.status, body };
      },
      onSettled: (path, outcome, reason) => {
        this.lastPush = { path, at: new Date().toLocaleString(), outcome };
        this.setStatus(`送信済み: ${path} (${outcome})`);
        if (outcome === "needs_review") {
          new Notice(`Akatuki Vault Push: 確認が必要なノートがあります: ${path}${reason ? ` (${reason})` : ""}`);
        }
      },
      onFailed: (path, status) => {
        this.setStatus(`送信できませんでした: ${path}`);
        if (status === 401) {
          new Notice("Akatuki Vault Push: 認証できませんでした。設定のトークンを確認してください。");
        } else {
          new Notice(`Akatuki Vault Push: 送信できませんでした: ${path}。正時の取り込みで反映されます。`);
        }
      },
    });
  }
}

class AkatukiVaultPushSettingTab extends PluginSettingTab {
  private readonly plugin: AkatukiVaultPushPlugin;

  constructor(app: App, plugin: AkatukiVaultPushPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("有効")
      .setDesc("編集したノートを Akatuki Knowledge へ送ります。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("受け口の起点")
      .addText((text) =>
        text
          .setPlaceholder("https://akatuki-knowledge.sousou-e1121.workers.dev")
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (value) => {
            this.plugin.settings.endpoint = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("認証トークン")
      .setDesc("Akatuki Knowledge の API トークン。プラグインの設定の中だけに保存されます。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("待ち秒数")
      .setDesc("編集が落ち着いてから送るまでの秒数です。")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.debounceSeconds))
          .onChange(async (value) => {
            const seconds = Number.parseInt(value, 10);
            if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 60) {
              this.plugin.settings.debounceSeconds = seconds;
              await this.plugin.saveSettings();
            }
          })
      );

    const last = this.plugin.lastPush;
    new Setting(containerEl)
      .setName("最後の送信")
      .setDesc(last ? `${last.at} / ${last.path} / ${last.outcome}` : "まだ送信していません。");
  }
}
