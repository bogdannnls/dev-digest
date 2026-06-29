import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { MarkdownSplit } from "./MarkdownSplit";
import messages from "../../../../../../../messages/en/skills.json";

function Wrapped() {
  const [value, setValue] = React.useState("");
  return (
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      <MarkdownSplit value={value} onChange={setValue} />
    </NextIntlClientProvider>
  );
}

describe("MarkdownSplit", () => {
  it("renders typed markdown in the preview pane", async () => {
    render(<Wrapped />);
    await userEvent.type(screen.getByRole("textbox"), "## Hello");
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
  });
});
