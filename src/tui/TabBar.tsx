import type { RuntimeSnapshot } from "../orchestrator/state.js";

interface TabBarProps {
  tabs: string[];
  selectedTab: number;
  snapshot: RuntimeSnapshot | null;
}

export function TabBar({ tabs, selectedTab, snapshot }: TabBarProps) {
  return (
    <box flexDirection="row" paddingX={1} gap={1} border borderStyle="rounded" borderColor="#444444">
      {tabs.map((tab, i) => {
        const isSelected = i === selectedTab;

        // Find status for this tab
        const runInfo = snapshot?.running.find(
          (r) => r.issue_identifier === tab
        );
        const retryInfo = snapshot?.retrying.find(
          (r) => r.identifier === tab
        );

        let icon = "";
        let iconColor = "";
        if (runInfo) {
          icon = " \u25CF";
          iconColor = "#00FF00";
        } else if (retryInfo) {
          icon = " \u21BB";
          iconColor = "#FFFF00";
        }

        const label = tab === "all" ? "All" : tab;

        return (
          <box
            key={tab}
            paddingX={1}
            backgroundColor={isSelected ? "#3a3a5a" : undefined}
          >
            <text>
              {isSelected ? (
                <span fg="#7aa2f7"><strong>{label}</strong></span>
              ) : (
                <span fg="#888888">{label}</span>
              )}
              {icon && <span fg={iconColor}>{icon}</span>}
            </text>
          </box>
        );
      })}
      <box flexGrow={1} />
    </box>
  );
}
