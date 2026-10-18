export interface GardenDisplaySettings {
  showTasks: boolean;
  showBugs: boolean;
  showDiscoveries: boolean;
  showProposals: boolean;
  showClaims: boolean;
  showHealth: boolean;
  showLabels: boolean;
  showLinks: boolean;
  showCompleted: boolean;
  followSelection: boolean;
  brightness: number;
  motion: number;
  bubbleScale: number;
}

export type GardenSelectionKind =
  | 'brain'
  | 'anchor'
  | 'arm'
  | 'task'
  | 'bug'
  | 'bubble';

export interface GardenSelection {
  kind: GardenSelectionKind;
  id: string;
}
