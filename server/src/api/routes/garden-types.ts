export interface FileClaim {
  id: number;
  armId: string;
  filePath: string;
  claimType: "read" | "write" | "exclusive";
  claimedAt: string;
  releasedAt: string | null;
}
