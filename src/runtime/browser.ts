import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";

export type BrowserLaunchConfig = {
  browser?: string;
  headless?: boolean;
  slow_mo_ms?: number;
  viewport?: string;
  locale?: string;
  storage_state_path?: string | null;
  ignore_https_errors?: boolean;
};

export type ViewportSize = {
  width: number;
  height: number;
};

export function resolveViewport(viewport: string): ViewportSize {
  const profiles: Record<string, ViewportSize> = {
    mobile: { width: 390, height: 844 },
    tablet: { width: 834, height: 1112 },
    desktop: { width: 1440, height: 900 },
    ultrawide: { width: 1920, height: 1080 },
  };

  const key = viewport.trim().toLowerCase();
  if (profiles[key]) {
    return profiles[key];
  }
  if (key.includes("x")) {
    const [widthText, heightText] = key.split("x", 2);
    const width = Number(widthText);
    const height = Number(heightText);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return { width, height };
    }
  }
  return profiles.desktop!;
}

export class BrowserSession {
  readonly config: Required<BrowserLaunchConfig>;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;

  constructor(config: BrowserLaunchConfig) {
    this.config = {
      browser: config.browser ?? "chromium",
      headless: config.headless ?? true,
      slow_mo_ms: config.slow_mo_ms ?? 0,
      viewport: config.viewport ?? "desktop",
      locale: config.locale ?? "en-US",
      storage_state_path: config.storage_state_path ?? null,
      ignore_https_errors: config.ignore_https_errors ?? false,
    };
  }

  async start(): Promise<this> {
    this.browser = await this.launchBrowser();
    await this.newContextPage(false);
    return this;
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.context = null;
    this.browser = null;
    this.activePage = null;
  }

  get page(): Page {
    if (!this.activePage) {
      throw new Error("BrowserSession is not active.");
    }
    return this.activePage;
  }

  async newContextPage(closeExisting: boolean = true): Promise<Page> {
    if (!this.browser) {
      throw new Error("BrowserSession is not active.");
    }
    if (closeExisting && this.context) {
      await this.context.close();
    }
    this.context = await this.browser.newContext(this.buildContextOptions());
    this.activePage = await this.context.newPage();
    return this.activePage;
  }

  private async launchBrowser(): Promise<Browser> {
    const options = { headless: this.config.headless, slowMo: this.config.slow_mo_ms };
    const name = this.config.browser.trim().toLowerCase();
    if (name === "chromium") {
      return chromium.launch(options);
    }
    if (name === "firefox") {
      return firefox.launch(options);
    }
    if (name === "webkit") {
      return webkit.launch(options);
    }
    throw new Error(`Unsupported browser '${this.config.browser}'.`);
  }

  private buildContextOptions(): BrowserContextOptions {
    const viewport = resolveViewport(this.config.viewport);
    return {
      viewport,
      locale: this.config.locale,
      ignoreHTTPSErrors: this.config.ignore_https_errors,
      storageState: this.config.storage_state_path ?? undefined,
    };
  }
}
