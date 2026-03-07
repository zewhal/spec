import type { ConsoleMessage, Page, Request, Response } from "playwright";

import type { NetworkRequestLog, NetworkResponseLog } from "../models/result";

export class BrowserObserver {
  console_messages: string[] = [];
  page_errors: string[] = [];
  requests: NetworkRequestLog[] = [];
  responses: NetworkResponseLog[] = [];

  install(page: Page): void {
    page.on("console", (message) => this.onConsole(message));
    page.on("pageerror", (error) => this.onPageError(error));
    page.on("request", (request) => this.onRequest(request));
    page.on("response", (response) => this.onResponse(response));
  }

  hasRequest(method: string, requestPath: string): boolean {
    const targetMethod = method.toUpperCase().trim();
    const targetPath = requestPath.trim();
    return this.requests.some((request) => request.method.toUpperCase() === targetMethod && request.url.includes(targetPath));
  }

  hasResponse(method: string, requestPath: string, statusCode: number): boolean {
    const targetMethod = method.toUpperCase().trim();
    const targetPath = requestPath.trim();
    return this.responses.some(
      (response) => response.method.toUpperCase() === targetMethod && response.url.includes(targetPath) && response.status === statusCode,
    );
  }

  private onConsole(message: ConsoleMessage): void {
    this.console_messages.push(`${message.type()}: ${message.text()}`);
  }

  private onPageError(error: Error): void {
    this.page_errors.push(String(error));
  }

  private onRequest(request: Request): void {
    this.requests.push({
      method: request.method(),
      url: request.url(),
      resource_type: request.resourceType(),
      timestamp: new Date().toISOString(),
    });
  }

  private onResponse(response: Response): void {
    this.responses.push({
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
      timestamp: new Date().toISOString(),
    });
  }
}
