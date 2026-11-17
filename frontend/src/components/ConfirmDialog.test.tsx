import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

function renderDialog() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <ConfirmDialog
      title="Stop tracking acme-crm?"
      confirmLabel="Remove"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      Its history will be deleted.
    </ConfirmDialog>,
  );
  return { onConfirm, onCancel, ...view };
}

describe("ConfirmDialog", () => {
  it("opens as a modal dialog named by its title and described by its message", () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "Stop tracking acme-crm?" });
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog).toHaveAccessibleDescription("Its history will be deleted.");
  });

  it("puts Cancel before the action, so Cancel is what the browser focuses", () => {
    renderDialog();
    const names = screen.getAllByRole("button").map((button) => button.textContent);
    expect(names).toEqual(["Cancel", "Remove"]);
  });

  it("confirms with the action button", async () => {
    const { onConfirm, onCancel } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels with the Cancel button", async () => {
    const { onConfirm, onCancel } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels when the browser closes it, as it does for Esc and a click outside", () => {
    const { onConfirm, onCancel } = renderDialog();
    const dialog = screen.getByRole<HTMLDialogElement>("dialog");
    dialog.close();
    fireEvent(dialog, new Event("close"));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ignores a close event that arrives while it is open", () => {
    // React's development mode opens, closes and reopens the dialog. The event from that
    // close arrives after the reopening and must not cancel the question.
    const { onCancel } = renderDialog();
    fireEvent(screen.getByRole("dialog"), new Event("close"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("closes the dialog when it leaves the page, so focus goes back", () => {
    const close = vi.spyOn(HTMLDialogElement.prototype, "close");
    const { unmount } = renderDialog();
    expect(close).not.toHaveBeenCalled();
    unmount();
    expect(close).toHaveBeenCalledOnce();
  });
});
