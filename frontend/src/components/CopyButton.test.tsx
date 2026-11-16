import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";

afterEach(() => {
  vi.useRealTimers();
});

describe("CopyButton", () => {
  it("copies the value and confirms it", async () => {
    // user-event provides a working clipboard for the test.
    const user = userEvent.setup();
    render(<CopyButton value="acme-crm" label="acme-crm" />);
    const button = screen.getByRole("button", { name: "Copy acme-crm" });
    expect(button).toHaveAttribute("data-state", "idle");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    await user.click(button);

    expect(await navigator.clipboard.readText()).toBe("acme-crm");
    expect(button).toHaveAttribute("data-state", "copied");
    expect(screen.getByRole("status")).toHaveTextContent("Copied acme-crm");
  });

  it("copies the value it was given, not the label", async () => {
    const user = userEvent.setup();
    render(<CopyButton value="acme-crm" label="the competitor id" />);

    await user.click(screen.getByRole("button", { name: "Copy the competitor id" }));
    expect(await navigator.clipboard.readText()).toBe("acme-crm");
  });

  it("goes back to normal after two seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CopyButton value="acme-crm" label="acme-crm" />);
    const button = screen.getByRole("button", { name: "Copy acme-crm" });

    await user.click(button);
    // Writing to the clipboard is asynchronous, so the tick appears a moment later.
    await waitFor(() => {
      expect(button).toHaveAttribute("data-state", "copied");
    });

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(button).toHaveAttribute("data-state", "copied");
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(button).toHaveAttribute("data-state", "idle");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("says so when the browser refuses to copy", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("not allowed"));
    render(<CopyButton value="acme-crm" label="acme-crm" />);
    const button = screen.getByRole("button", { name: "Copy acme-crm" });

    await user.click(button);

    expect(button).toHaveAttribute("data-state", "failed");
    expect(button).toHaveAttribute("title", "Could not copy");
    expect(screen.getByRole("status")).toHaveTextContent("Could not copy acme-crm");
  });

  it("says so when the clipboard is not available at all", async () => {
    const user = userEvent.setup();
    // What a browser gives a page served over plain HTTP from another machine.
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      render(<CopyButton value="acme-crm" label="acme-crm" />);

      await user.click(screen.getByRole("button", { name: "Copy acme-crm" }));
      expect(screen.getByRole("status")).toHaveTextContent("Could not copy acme-crm");
    } finally {
      if (original) {
        Object.defineProperty(navigator, "clipboard", original);
      }
    }
  });

  it("works from the keyboard", async () => {
    const user = userEvent.setup();
    render(<CopyButton value="acme-crm" label="acme-crm" />);

    await user.tab();
    expect(screen.getByRole("button", { name: "Copy acme-crm" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await navigator.clipboard.readText()).toBe("acme-crm");
  });
});
