import { describe, it, expect } from "vitest";
import { decodeUtf16, parseCsv, parseSearchTerms } from "./play-console.mjs";

const CSV =
  `Date,Package Name,Traffic Source,Search Term,UTM Source,UTM Campaign,Store Listing Visitors,Store Listing Acquisitions,Store Listing Conversion Rate\n` +
  `2026-07-01,com.mindset.app,Play Store (organic) - Search,mindset,,,"1,234",56,4.54%\n` +
  `2026-07-01,com.mindset.app,Play Store (organic) - Search,Other,,,400,10,2.50%\n` +
  `2026-07-01,com.mindset.app,Play Store (organic) - Explore,,,,900,20,2.22%\n`;

describe("decodeUtf16", () => {
  it("strips the LE BOM so the first header is 'Date', not '\\uFEFFDate' (02 §7.4)", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Date,X", "utf16le")]);
    expect(decodeUtf16(le)).toBe("Date,X");
  });

  it("handles big-endian via BOM detection", () => {
    const leBody = Buffer.from("Date", "utf16le");
    const be = Buffer.alloc(leBody.length + 2);
    be[0] = 0xfe; be[1] = 0xff;
    for (let i = 0; i < leBody.length; i += 2) { be[i + 2] = leBody[i + 1]; be[i + 3] = leBody[i]; }
    expect(decodeUtf16(be)).toBe("Date");
  });
});

describe("parseCsv", () => {
  it("keeps quoted commas inside a field", () => {
    const rows = parseCsv(`a,"1,234",c\n`);
    expect(rows[0]).toEqual(["a", "1,234", "c"]);
  });
});

describe("parseSearchTerms", () => {
  it("keeps only Search-traffic rows with a term, parsing formatted numbers", () => {
    const terms = parseSearchTerms(CSV);
    expect(terms).toHaveLength(2);
    expect(terms[0]).toMatchObject({ package_name: "com.mindset.app", search_term: "mindset", visitors: 1234, acquisitions: 56 });
    expect(terms[1].search_term).toBe("Other"); // Google's low-volume rollup row survives, labeled
  });

  it("refuses to guess when the header changed (verify-don't-assume, 02 §7.3)", () => {
    expect(() => parseSearchTerms("Foo,Bar\n1,2\n")).toThrow(/header/);
  });
});
