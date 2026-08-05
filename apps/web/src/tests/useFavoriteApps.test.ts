import { afterEach, describe, expect, test } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useFavoriteApps } from "../hooks/useFavoriteApps";

const STORAGE_KEY = "dp_favorite_apps";

describe("useFavoriteApps", () => {
  afterEach(() => {
    localStorage.clear();
  });

  test("starts empty with nothing in storage", () => {
    const { result } = renderHook(() => useFavoriteApps());
    expect(result.current[0].size).toBe(0);
  });

  test("toggling adds an id, and persists it to localStorage", () => {
    const { result } = renderHook(() => useFavoriteApps());

    act(() => result.current[1](7));

    expect(result.current[0].has(7)).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([7]);
  });

  test("toggling an already-favorited id removes it", () => {
    const { result } = renderHook(() => useFavoriteApps());

    act(() => result.current[1](7));
    act(() => result.current[1](7));

    expect(result.current[0].has(7)).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([]);
  });

  test("loads a previously-persisted set on mount", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([3, 9]));
    const { result } = renderHook(() => useFavoriteApps());

    expect(result.current[0].has(3)).toBe(true);
    expect(result.current[0].has(9)).toBe(true);
  });

  test("falls back to empty when storage contains invalid JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json");
    const { result } = renderHook(() => useFavoriteApps());
    expect(result.current[0].size).toBe(0);
  });

  test("falls back to empty when storage contains a non-array value", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: "an array" }));
    const { result } = renderHook(() => useFavoriteApps());
    expect(result.current[0].size).toBe(0);
  });
});
