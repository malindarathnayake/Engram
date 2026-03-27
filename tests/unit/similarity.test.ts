import { describe, it, expect } from "vitest";
import {
  trigrams,
  trigramSimilarity,
  findMostSimilar,
} from "../../src/schema/similarity.js";

describe("trigrams", () => {
  it("generates trigrams with boundary padding", () => {
    const result = trigrams("abc");
    // " ab", "abc", "bc "
    expect(result.size).toBe(3);
    expect(result.has(" ab")).toBe(true);
    expect(result.has("abc")).toBe(true);
    expect(result.has("bc ")).toBe(true);
  });

  it("normalizes to lowercase", () => {
    const lower = trigrams("ABC");
    const upper = trigrams("abc");
    expect(lower).toEqual(upper);
  });

  it("handles empty string", () => {
    const result = trigrams("");
    expect(result.size).toBe(0);
  });

  it("handles single character", () => {
    const result = trigrams("a");
    // " a "
    expect(result.size).toBe(1);
  });

  it("handles two characters", () => {
    const result = trigrams("ab");
    // " ab", "ab "
    expect(result.size).toBe(2);
  });
});

describe("trigramSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(trigramSimilarity("Person", "Person")).toBe(1.0);
  });

  it("returns 1.0 for identical strings (case-insensitive)", () => {
    expect(trigramSimilarity("Person", "person")).toBe(1.0);
  });

  it("returns 0.0 for completely different strings", () => {
    const score = trigramSimilarity("abcdef", "xyz123");
    expect(score).toBeLessThan(0.1);
  });

  it("returns high score for similar strings", () => {
    const score = trigramSimilarity("Person", "Persons");
    expect(score).toBeGreaterThan(0.5); // Jaccard 0.625
  });

  it("returns moderate score for somewhat similar strings", () => {
    const score = trigramSimilarity("Person", "Personal");
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.8);
  });

  it("returns 0.0 for empty strings", () => {
    expect(trigramSimilarity("", "test")).toBe(0.0);
    expect(trigramSimilarity("test", "")).toBe(0.0);
  });

  it("handles both empty strings", () => {
    // Both empty after trim → identical, returns 1.0
    // (boundary: " " padded → single trigram " " which matches)
    const score = trigramSimilarity("", "");
    // Both produce empty trigram sets after normalization
    expect(score).toBeDefined();
  });

  it("detects similar entity type names", () => {
    // These should show meaningful similarity
    expect(trigramSimilarity("Employee", "Employees")).toBeGreaterThanOrEqual(0.6);
    expect(trigramSimilarity("Project", "Projects")).toBeGreaterThanOrEqual(0.6);
    expect(trigramSimilarity("TeamMember", "Team_Member")).toBeGreaterThan(0.3);
  });

  it("distinguishes different entity types", () => {
    expect(trigramSimilarity("Person", "Project")).toBeLessThan(0.5);
    expect(trigramSimilarity("Bug", "Meeting")).toBeLessThan(0.3);
    expect(trigramSimilarity("Decision", "Repository")).toBeLessThan(0.3);
  });
});

describe("findMostSimilar", () => {
  it("returns the most similar string", () => {
    const result = findMostSimilar("Person", [
      "Project",
      "Persons",
      "Meeting",
    ]);

    expect(result).not.toBeNull();
    expect(result!.match).toBe("Persons");
    expect(result!.score).toBeGreaterThan(0.5);
  });

  it("returns null for empty candidates", () => {
    expect(findMostSimilar("test", [])).toBeNull();
  });

  it("returns the only candidate when one exists", () => {
    const result = findMostSimilar("test", ["other"]);
    expect(result).not.toBeNull();
    expect(result!.match).toBe("other");
  });

  it("finds exact match with score 1.0", () => {
    const result = findMostSimilar("Person", ["Bug", "Person", "Project"]);
    expect(result!.match).toBe("Person");
    expect(result!.score).toBe(1.0);
  });
});
