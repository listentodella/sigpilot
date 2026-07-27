import { ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DecoderBackendKind, SigrokDecoderCatalogItem } from "../lib/api";
import { analyzerCatalogChoiceKey, sigrokCatalogRunnerLabel } from "../lib/analyzers";

export interface AnalyzerLibraryChoice {
  backend: DecoderBackendKind;
  catalogItem?: SigrokDecoderCatalogItem;
  description?: string | null;
  name: string;
  runnerStatus?: string | null;
  source: string;
}

export function AnalyzerLibraryMenu({
  choices,
  onSelect,
}: {
  choices: AnalyzerLibraryChoice[];
  onSelect: (choice: AnalyzerLibraryChoice) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredChoices = useMemo(
    () =>
      normalizedQuery
        ? choices.filter((choice) =>
            [
              choice.name,
              choice.source,
              choice.description,
              choice.runnerStatus,
              choice.catalogItem?.id,
              choice.catalogItem?.name,
              choice.catalogItem?.longname,
              choice.catalogItem?.desc,
              ...(choice.catalogItem?.tags ?? []),
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(normalizedQuery),
          )
        : choices,
    [choices, normalizedQuery],
  );
  const groups = useMemo(
    () =>
      filteredChoices.reduce<Array<{ id: string; label: string; choices: AnalyzerLibraryChoice[] }>>(
        (result, choice) => {
          const id = `${choice.backend}:${choice.source}`;
          const group = result.find((candidate) => candidate.id === id);
          if (group) group.choices.push(choice);
          else result.push({ id, label: choice.source, choices: [choice] });
          return result;
        },
        [],
      ),
    [filteredChoices],
  );
  const [activeGroupId, setActiveGroupId] = useState(groups[0]?.id ?? "");
  useEffect(() => {
    if (groups.some((group) => group.id === activeGroupId)) return;
    setActiveGroupId(groups[0]?.id ?? "");
  }, [activeGroupId, groups]);
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0];

  return (
    <div className="analyzerLibraryMenu">
      <label className="analyzerLibrarySearch">
        <Search size={13} />
        <input
          aria-label="Search analyzers"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          inputMode="search"
          name="pxlogic-analyzer-library-search"
          placeholder="Search decoders"
          spellCheck={false}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
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
            <small>{group.choices.length}</small>
            <ChevronRight size={12} />
          </button>
        ))}
      </div>
      <div className="analyzerLibraryProtocols" role="menu">
        {activeGroup?.choices.map((choice) => (
          <button
            key={analyzerCatalogChoiceKey(choice)}
            onClick={() => onSelect(choice)}
            title={choice.description ?? undefined}
            type="button"
          >
            <span>{choice.name}</span>
            {choice.runnerStatus && (
              <small className={choice.runnerStatus === "verified_sparse_c" ? "runnable" : ""}>
                {sigrokCatalogRunnerLabel(choice.runnerStatus)}
              </small>
            )}
          </button>
        ))}
        {!activeGroup && <div className="analyzerLibraryEmpty">No decoders found</div>}
      </div>
    </div>
  );
}
