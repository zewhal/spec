import { mkdirSync } from "node:fs";
import path from "node:path";

import slugify from "slugify";

export class ArtifactManager {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  testDir(suiteId: string, testId: string): string {
    const target = path.join(this.root, slugify(suiteId), slugify(testId));
    mkdirSync(target, { recursive: true });
    return target;
  }

  buildPath(suiteId: string, testId: string, artifactName: string, extension: string): string {
    const directory = this.testDir(suiteId, testId);
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const safeName = slugify(artifactName) || "artifact";
    return path.join(directory, `${slugify(suiteId)}__${slugify(testId)}__${timestamp}__${safeName}.${extension}`);
  }
}
