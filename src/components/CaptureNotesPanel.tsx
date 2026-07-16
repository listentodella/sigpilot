import { CircleHelp } from "lucide-react";
import { useState } from "react";

export function CaptureNotesPanel({
  notes,
  onChange,
}: {
  notes: string;
  onChange: (notes: string) => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="captureNotesWrapper">
      <header className="captureNotesHeader">
        <strong>Notes</strong>
        <button
          aria-label="About capture notes"
          className={helpOpen ? "active" : ""}
          onClick={() => setHelpOpen((open) => !open)}
          type="button"
        >
          <CircleHelp size={15} />
        </button>
        {helpOpen && (
          <div className="captureNotesHelp">
            Write any info about your capture that will be helpful such as your test setup and important features of
            the signal.
          </div>
        )}
      </header>
      <textarea
        aria-label="Capture notes"
        className="captureNotesTextArea"
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="Click to add a description of your capture"
        value={notes}
      />
    </div>
  );
}
