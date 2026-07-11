import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupHeader } from "./GroupHeader";

afterEach(cleanup);

describe("GroupHeader", () => {
  it("renders role label, file count and finding count, and flips chevron/aria state when collapsed changes", () => {
    const { rerender } = render(
      <GroupHeader role="core" fileCount={3} findingCount={2} collapsed={false} onToggle={() => {}} />,
    );
    const button = screen.getByRole("button", { name: /core/i });
    expect(button).toHaveTextContent("Core");
    expect(button).toHaveTextContent("3 files");
    expect(button).toHaveTextContent("2 findings");
    expect(button).toHaveAttribute("aria-expanded", "true");

    rerender(<GroupHeader role="core" fileCount={3} findingCount={2} collapsed={true} onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: /core/i })).toHaveAttribute("aria-expanded", "false");
  });

  it("omits the finding count when there are no findings, and singularizes counts of 1", () => {
    render(<GroupHeader role="boilerplate" fileCount={1} findingCount={0} collapsed onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: /boilerplate/i });
    expect(button).toHaveTextContent("Boilerplate");
    expect(button).toHaveTextContent("1 file");
    expect(button).not.toHaveTextContent("findings");
  });

  it("calls onToggle on click and on keyboard activation (Enter/Space, native button behavior)", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<GroupHeader role="wiring" fileCount={2} findingCount={5} collapsed={false} onToggle={onToggle} />);
    const button = screen.getByRole("button", { name: /wiring/i });

    await user.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);

    button.focus();
    await user.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledTimes(2);

    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(3);
  });
});
