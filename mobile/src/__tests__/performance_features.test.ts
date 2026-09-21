import { useDebounce } from "../utils/useDebounce";

describe("Performance utilities & enhancements", () => {
  it("useDebounce está definido como hook", () => {
    expect(typeof useDebounce).toBe("function");
  });
});
