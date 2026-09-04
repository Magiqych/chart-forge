import { describe, expect, it } from "vitest";

import {
  describeFailure,
  isAbsolutePath,
  isSupportedAnalysisVersion,
  isSupportedProjectVersion,
  normalizePath,
  ProjectLoadError,
  resolveRelativeRef,
} from "./project";

describe("documentRef resolution", () => {
  const project = "D:/10.repo/chart-forge-work/projects/song.project.json";

  it("resolves a plain relative reference", () => {
    expect(resolveRelativeRef(project, "analysis.json")).toBe(
      "D:/10.repo/chart-forge-work/projects/analysis.json",
    );
  });

  it("resolves a reference into a subdirectory", () => {
    expect(resolveRelativeRef(project, "out/analysis.json")).toBe(
      "D:/10.repo/chart-forge-work/projects/out/analysis.json",
    );
  });

  it("resolves a legitimate '..' reference - the common real layout", () => {
    expect(resolveRelativeRef(project, "../runs/pinned-A/analysis.json")).toBe(
      "D:/10.repo/chart-forge-work/runs/pinned-A/analysis.json",
    );
  });

  it("resolves several levels of '..'", () => {
    expect(resolveRelativeRef(project, "../../audio/song.wav")).toBe(
      "D:/10.repo/audio/song.wav",
    );
  });

  it("does not reject a reference merely for containing '..'", () => {
    // The Project contract allows it and real projects sit beside their runs
    // directory; refusing it for looking suspicious would break valid documents.
    expect(() => resolveRelativeRef(project, "../runs/x/analysis.json")).not.toThrow();
  });

  it("passes an absolute reference through", () => {
    expect(resolveRelativeRef(project, "D:/elsewhere/analysis.json")).toBe(
      "D:/elsewhere/analysis.json",
    );
  });

  it("accepts backslash separators from Windows projects", () => {
    expect(resolveRelativeRef("D:\\work\\p.json", "..\\runs\\a.json")).toBe("D:/runs/a.json");
  });

  it("handles a POSIX project path", () => {
    // The project lives in /home/u, so ".." resolves to /home.
    expect(resolveRelativeRef("/home/u/p.json", "../runs/a.json")).toBe("/home/runs/a.json");
  });

  it("normalises '.' segments", () => {
    expect(resolveRelativeRef(project, "./analysis.json")).toBe(
      "D:/10.repo/chart-forge-work/projects/analysis.json",
    );
  });
});

describe("path normalisation", () => {
  it("collapses . and ..", () => {
    expect(normalizePath("D:/a/b/../c/./d")).toBe("D:/a/c/d");
  });

  it("keeps the drive prefix", () => {
    expect(normalizePath("C:/x/../y")).toBe("C:/y");
  });

  it("keeps a POSIX root", () => {
    expect(normalizePath("/x/../y")).toBe("/y");
  });

  it("does not climb above a root", () => {
    expect(normalizePath("D:/../../x")).toBe("D:/x");
  });

  it("keeps leading .. on a genuinely relative path", () => {
    expect(normalizePath("../../x")).toBe("../../x");
  });

  it("collapses duplicate separators", () => {
    expect(normalizePath("D://a///b")).toBe("D:/a/b");
  });
});

describe("absolute path detection", () => {
  it("recognises Windows and POSIX absolutes", () => {
    expect(isAbsolutePath("D:/x")).toBe(true);
    expect(isAbsolutePath("D:\\x")).toBe(true);
    expect(isAbsolutePath("/x")).toBe(true);
  });

  it("treats the rest as relative", () => {
    expect(isAbsolutePath("x/y")).toBe(false);
    expect(isAbsolutePath("../x")).toBe(false);
    expect(isAbsolutePath("./x")).toBe(false);
  });
});

describe("version support", () => {
  it("reads Analysis 0.2.x only", () => {
    expect(isSupportedAnalysisVersion("0.2.0")).toBe(true);
    expect(isSupportedAnalysisVersion("0.2.9")).toBe(true);
    expect(isSupportedAnalysisVersion("0.1.0")).toBe(false);
    expect(isSupportedAnalysisVersion("0.3.0")).toBe(false);
  });

  it("reads Project 0.1.x and 0.2.x", () => {
    expect(isSupportedProjectVersion("0.1.0")).toBe(true);
    expect(isSupportedProjectVersion("0.2.0")).toBe(true);
    expect(isSupportedProjectVersion("1.0.0")).toBe(false);
  });
});

describe("load failures are distinguishable", () => {
  const kinds = [
    "project-unreadable",
    "project-malformed",
    "project-unsupported-version",
    "analysis-missing-reference",
    "analysis-unreadable",
    "analysis-malformed",
    "analysis-unsupported-version",
    "analysis-hash-mismatch",
    "audio-unreadable",
  ] as const;

  it("gives every failure kind its own message", () => {
    const messages = kinds.map((kind) => describeFailure(new ProjectLoadError(kind, "x")));
    expect(new Set(messages).size).toBe(kinds.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(10);
  });

  it("carries the kind and an optional detail", () => {
    const error = new ProjectLoadError("analysis-hash-mismatch", "bad hash", "expected abc");
    expect(error.kind).toBe("analysis-hash-mismatch");
    expect(error.detail).toBe("expected abc");
    expect(error).toBeInstanceOf(Error);
  });

  it("distinguishes a missing reference from an unreadable file", () => {
    expect(describeFailure(new ProjectLoadError("analysis-missing-reference", ""))).not.toBe(
      describeFailure(new ProjectLoadError("analysis-unreadable", "")),
    );
  });
});
