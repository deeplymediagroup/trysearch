import { describe, it, expect } from "vitest";
import { parseAppRef } from "./resolve.mjs";

describe("parseAppRef", () => {
  it("reads the id and storefront out of an App Store URL", () => {
    expect(parseAppRef("https://apps.apple.com/us/app/mindset-daily-motivation/id1487761500")).toEqual({
      store: "ios",
      id: "1487761500",
      country: "us",
    });
  });

  it("does not mistake the /app/ path segment for a storefront", () => {
    expect(parseAppRef("https://itunes.apple.com/app/id1487761500")).toEqual({ store: "ios", id: "1487761500", country: null });
  });

  it("reads a Play URL including gl=", () => {
    expect(parseAppRef("https://play.google.com/store/apps/details?id=com.mindset.app&gl=gb&hl=en")).toEqual({
      store: "android",
      id: "com.mindset.app",
      country: "gb",
    });
  });

  it("treats a bare number as an iOS trackId", () => {
    expect(parseAppRef(" 1487761500 ")).toEqual({ store: "ios", id: "1487761500", country: null });
  });

  it("leaves a dotted token ambiguous — it is a valid id on BOTH stores", () => {
    expect(parseAppRef("com.example.app")).toEqual({ store: null, bundle: "com.example.app", country: null });
  });

  it("falls back to a name search", () => {
    expect(parseAppRef("mindset daily motivation")).toEqual({ store: null, query: "mindset daily motivation", country: null });
  });

  it("returns null for nothing at all", () => {
    expect(parseAppRef("   ")).toBeNull();
    expect(parseAppRef(undefined)).toBeNull();
  });
});
