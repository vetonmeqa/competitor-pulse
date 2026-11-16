import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { competitor, mockApi, renderWithProviders } from "../test/helpers";
import { AddCompetitorForm } from "./AddCompetitorForm";

const input = () => screen.getByLabelText("Track a competitor");
const addButton = () => screen.getByRole("button", { name: "Add" });

describe("AddCompetitorForm", () => {
  it("adds a competitor and clears the field", async () => {
    const requests = mockApi({
      "POST /competitors": () => ({ status: 201, body: competitor() }),
      "GET /competitors": () => ({ body: [] }),
    });
    renderWithProviders(<AddCompetitorForm />);

    await userEvent.type(input(), "  acme-crm ");
    await userEvent.click(addButton());

    await waitFor(() => {
      expect(input()).toHaveValue("");
    });
    expect(requests.find((request) => request.method === "POST")).toEqual({
      method: "POST",
      path: "/competitors",
      body: { id: "acme-crm" },
    });
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });

  it("submits with the Enter key", async () => {
    const requests = mockApi({
      "POST /competitors": () => ({ status: 201, body: competitor() }),
      "GET /competitors": () => ({ body: [] }),
    });
    renderWithProviders(<AddCompetitorForm />);

    await userEvent.type(input(), "acme-crm{Enter}");
    await waitFor(() => {
      expect(requests.some((request) => request.method === "POST")).toBe(true);
    });
  });

  it.each([
    ["nothing", "", "Enter a competitor id."],
    ["an id with a space", "acme crm", /Use letters, digits/],
    ["an id that starts with a dash", "-acme", /Use letters, digits/],
    ["an id that is too long", "a".repeat(101), "An id can be at most 100 characters."],
  ])("rejects %s without calling the server", async (_label, value, message) => {
    const requests = mockApi({});
    renderWithProviders(<AddCompetitorForm />);

    if (value !== "") {
      await userEvent.type(input(), value);
    }
    await userEvent.click(addButton());

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(input()).toBeInvalid();
    expect(requests).toHaveLength(0);
  });

  it("shows the server's message when the id is already tracked, and keeps what was typed", async () => {
    mockApi({
      "POST /competitors": () => ({
        status: 409,
        body: { error: { code: "already_tracked", message: '"acme-crm" is already tracked.' } },
      }),
    });
    renderWithProviders(<AddCompetitorForm />);

    await userEvent.type(input(), "acme-crm");
    await userEvent.click(addButton());

    expect(await screen.findByText('"acme-crm" is already tracked.')).toBeInTheDocument();
    expect(input()).toHaveValue("acme-crm");
    expect(input()).toBeInvalid();
  });

  it("clears the error as soon as the user edits the field", async () => {
    mockApi({});
    renderWithProviders(<AddCompetitorForm />);

    await userEvent.click(addButton());
    expect(screen.getByRole("alert")).not.toBeEmptyDOMElement();

    await userEvent.type(input(), "a");
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
    expect(input()).toBeValid();
  });

  it("ties the hint and the error to the field for screen readers", async () => {
    mockApi({});
    renderWithProviders(<AddCompetitorForm />);

    expect(input()).toHaveAccessibleDescription(/Enter the id the source uses/);
    await userEvent.click(addButton());
    expect(input()).toHaveAccessibleDescription(/Enter a competitor id\./);
  });
});
