import { describe, expect, it } from "vitest";

import { isEditableTarget } from "./keyboard";

describe("isEditableTarget", () => {
  it("defers to fields the browser is already editing", () => {
    // Space, the arrows and Ctrl+Z all mean something else inside these, and taking
    // them away would break typing a path into the open dialog.
    expect(isEditableTarget("INPUT")).toBe(true);
    expect(isEditableTarget("SELECT")).toBe(true);
    expect(isEditableTarget("TEXTAREA")).toBe(true);
  });

  it("defers to anything marked contenteditable, whatever its tag", () => {
    expect(isEditableTarget("DIV", true)).toBe(true);
    expect(isEditableTarget("SPAN", true)).toBe(true);
  });

  it("claims the key everywhere else", () => {
    expect(isEditableTarget("CANVAS")).toBe(false);
    expect(isEditableTarget("BUTTON")).toBe(false);
    expect(isEditableTarget("BODY")).toBe(false);
    expect(isEditableTarget("DIV")).toBe(false);
  });

  it("is not fooled by casing or a missing tag", () => {
    expect(isEditableTarget("input")).toBe(true);
    expect(isEditableTarget("Select")).toBe(true);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

describe("a control that does not use the arrow keys", () => {
  it("lets the shortcuts through for a checkbox", () => {
    // Clicking a layer checkbox leaves it focused. If that counted as editable, toggling
    // a layer would silently turn keyboard navigation off until the author clicked
    // somewhere else - which is exactly the bug this pins down.
    expect(isEditableTarget("INPUT", false, "checkbox")).toBe(false);
  });

  it("lets them through for buttons rendered as inputs", () => {
    for (const type of ["button", "submit", "reset"]) {
      expect(isEditableTarget("INPUT", false, type)).toBe(false);
    }
  });

  it("still protects everything that does use them", () => {
    for (const type of ["text", "number", "range", "radio", "search", "email"]) {
      expect(isEditableTarget("INPUT", false, type)).toBe(true);
    }
  });

  it("treats an input with no type as a text box", () => {
    expect(isEditableTarget("INPUT", false, undefined)).toBe(true);
    expect(isEditableTarget("INPUT")).toBe(true);
  });

  it("is not case sensitive about the type", () => {
    expect(isEditableTarget("INPUT", false, "CheckBox")).toBe(false);
  });

  it("still protects a select and a textarea whatever the type says", () => {
    expect(isEditableTarget("SELECT", false, "checkbox")).toBe(true);
    expect(isEditableTarget("TEXTAREA", false, "checkbox")).toBe(true);
  });

  it("still protects anything contenteditable", () => {
    expect(isEditableTarget("DIV", true, "checkbox")).toBe(true);
  });
});
