export const actionKinds = [
  "goto",
  "refresh",
  "back",
  "forward",
  "click",
  "double_click",
  "right_click",
  "hover",
  "focus",
  "blur",
  "fill",
  "clear",
  "append_text",
  "press",
  "select_option",
  "check",
  "uncheck",
  "upload_file",
  "drag_and_drop",
  "scroll_to",
  "scroll_by",
  "wait_for",
  "switch_tab",
  "close_tab",
  "switch_frame",
  "accept_dialog",
  "dismiss_dialog",
  "set_viewport",
  "set_storage_state",
  "take_screenshot",
  "comment",
  "group",
] as const;

export const expectationKinds = [
  "url_is",
  "url_contains",
  "title_is",
  "title_contains",
  "text_visible",
  "text_not_visible",
  "element_visible",
  "element_hidden",
  "element_enabled",
  "element_disabled",
  "element_checked",
  "element_unchecked",
  "value_equals",
  "attribute_equals",
  "count_equals",
  "count_gte",
  "request_seen",
  "response_status",
  "console_clean",
  "page_error_absent",
  "toast_visible",
  "dialog_visible",
  "download_started",
  "new_tab_opened",
  "focus_on",
  "in_viewport",
  "screenshot_match",
  "custom_rule",
] as const;

export const readinessModes = [
  "domcontentloaded",
  "load",
  "networkidle",
  "locator_visible",
  "text_visible",
] as const;

export const waitTypes = [
  "url",
  "text",
  "locator",
  "request",
  "response",
  "download",
  "dialog",
  "timeout",
] as const;

export const resolutionConfidences = ["exact", "high", "medium", "low"] as const;

export const testStatuses = ["passed", "failed", "skipped"] as const;

export const stepStatuses = ["passed", "failed", "skipped"] as const;

export const failureClasses = [
  "spec_error",
  "locator_resolution_failure",
  "action_failure",
  "assertion_failure",
  "app_crash_page_error",
  "timeout",
  "flaky_recovered",
  "unsupported_widget",
  "environment_issue",
] as const;

export const executionEventTypes = [
  "suite_started",
  "test_started",
  "test_finished",
  "suite_finished",
  "step_started",
  "step_finished",
  "expectation_started",
  "expectation_finished",
  "console_message",
  "page_error",
  "network_request",
  "network_response",
  "screenshot_captured",
  "error",
] as const;

export type ActionKind = (typeof actionKinds)[number];
export type ExpectationKind = (typeof expectationKinds)[number];
export type ReadinessMode = (typeof readinessModes)[number];
export type WaitType = (typeof waitTypes)[number];
export type ResolutionConfidence = (typeof resolutionConfidences)[number];
export type TestStatus = (typeof testStatuses)[number];
export type StepStatus = (typeof stepStatuses)[number];
export type FailureClass = (typeof failureClasses)[number];
export type ExecutionEventType = (typeof executionEventTypes)[number];
