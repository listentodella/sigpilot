import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { DecoderBackendKind } from "../lib/api";

export interface AnalyzerLibraryChoice {
  backend: DecoderBackendKind;
  name: string;
  source: string;
}

export function AnalyzerLibraryMenu({
  choices,
  onSelect,
}: {
  choices: AnalyzerLibraryChoice[];
  onSelect: (choice: AnalyzerLibraryChoice) => void;
}) {
  const groups = useMemo(
    () =>
      choices.reduce<Array<{ id: string; label: string; choices: AnalyzerLibraryChoice[] }>>(
        (result, choice) => {
          const id = `${choice.backend}:${choice.source}`;
          const group = result.find((candidate) => candidate.id === id);
          if (group) group.choices.push(choice);
          else result.push({ id, label: choice.source, choices: [choice] });
          return result;
        },
        [],
      ),
    [choices],
  );
  const [activeGroupId, setActiveGroupId] = useState(groups[0]?.id ?? "");
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0];

  return (
    <div className="analyzerLibraryMenu">
      <div className="analyzerLibrarySources" role="menu">
        {groups.map((group) => (
          <button
            className={group.id === activeGroup?.id ? "active" : ""}
            key={group.id}
            onClick={() => setActiveGroupId(group.id)}
            onPointerEnter={() => setActiveGroupId(group.id)}
            type="button"
          >
            <span>{group.label}</span>
            <ChevronRight size={12} />
          </button>
        ))}
      </div>
      <div className="analyzerLibraryProtocols" role="menu">
        {activeGroup?.choices.map((choice) => (
          <button
            key={`${choice.backend}:${choice.name}`}
            onClick={() => onSelect(choice)}
            type="button"
          >
            {choice.name}
          </button>
        ))}
      </div>
    </div>
  );
}
