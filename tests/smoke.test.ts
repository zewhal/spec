import { expect, test } from "bun:test";

import { appName } from "../src/index";

test("exports the app name", () => {
  expect(appName).toBe("spec");
});
