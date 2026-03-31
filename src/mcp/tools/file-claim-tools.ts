/**
 * File Claim Tools
 * 
 * MCP tools for file claiming and conflict management.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ARM_ID, sendToBrain, logActivity, getDatabase } from "./utils";

/**
 * Register file claim-related tools on the MCP server
 */
export function registerFileClaimTools(server: McpServer): void {
	// Claim a file for read, write, or exclusive access
	server.registerTool(
		"claim_file",
		{
			description:
				"Request exclusive access to a file to prevent conflicts with other arms",
			inputSchema: {
				file_path: z
					.string()
					.describe("Path to the file to claim (relative to project root)"),
				claim_type: z
					.enum(["read", "write", "exclusive"])
					.optional()
					.describe("Type of claim (default: read)"),
				reason: z
					.string()
					.optional()
					.describe("Brief explanation of why you need this file"),
			},
		},
		async ({ file_path, claim_type = "read", reason }) => {
			try {
				const database = getDatabase(false);
				const now = new Date().toISOString();

				// Check if arm exists
				const arm = database
					.query("SELECT id FROM arms WHERE id = ?")
					.get(ARM_ID);
				if (!arm) {
					logActivity(ARM_ID, "claim_file_failed", file_path, {
						error: "arm_not_found",
						claim_type,
						reason,
					});
					return {
						content: [
							{
								type: "text" as const,
								text: `Failed to claim ${file_path}: Arm ${ARM_ID} not found in database`,
							},
						],
					};
				}

				// Check for exclusive claim conflicts
				if (claim_type === "exclusive") {
					const existing = database
						.query(
							"SELECT arm_id FROM claims WHERE file_path = ? AND released_at IS NULL",
						)
						.get(file_path) as { arm_id: string } | null;
					if (existing && existing.arm_id !== ARM_ID) {
						logActivity(ARM_ID, "claim_file_failed", file_path, {
							error: "exclusive_conflict",
							claim_type,
							reason,
							existing_arm: existing.arm_id,
						});
						return {
							content: [
								{
									type: "text" as const,
									text: `Cannot claim ${file_path} exclusively: File already claimed by ${existing.arm_id}`,
								},
							],
						};
					}
				}

				// Check if this arm already has a claim on this file
				const existingClaim = database
					.query(
						"SELECT id, claim_type FROM claims WHERE arm_id = ? AND file_path = ? AND released_at IS NULL",
					)
					.get(ARM_ID, file_path) as { id: number; claim_type: string } | null;

				if (existingClaim) {
					// Update existing claim
					database.run(
						"UPDATE claims SET claim_type = ?, claimed_at = ? WHERE id = ?",
						[claim_type, now, existingClaim.id],
					);

					logActivity(ARM_ID, "claim_file_updated", file_path, {
						claim_type,
						reason,
						previous_type: existingClaim.claim_type,
					});

					return {
						content: [
							{
								type: "text" as const,
								text: `Updated claim on ${file_path}: ${existingClaim.claim_type} → ${claim_type}${reason ? `\nReason: ${reason}` : ""}`,
							},
						],
					};
				} else {
					// Create new claim
					const result = database.run(
						"INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
						[ARM_ID, file_path, claim_type, now],
					);

					logActivity(ARM_ID, "claim_file", file_path, {
						claim_type,
						reason,
						claim_id: result.lastInsertRowid,
					});

					return {
						content: [
							{
								type: "text" as const,
								text: `Successfully claimed ${file_path} (${claim_type})${reason ? `\nReason: ${reason}` : ""}\n\nOther arms will see this file as owned by you.`,
							},
						],
					};
				}
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				logActivity(ARM_ID, "claim_file_failed", file_path, {
					error: errorMsg,
					claim_type,
					reason,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to claim ${file_path}: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Release a file claim
	server.registerTool(
		"release_claim",
		{
			description: "Release your claim on a file so other arms can work on it",
			inputSchema: {
				file_path: z.string().describe("Path to the file to release"),
				reason: z
					.string()
					.optional()
					.describe("Brief explanation of why you're releasing the claim"),
			},
		},
		async ({ file_path, reason }) => {
			try {
				const database = getDatabase(false);
				const now = new Date().toISOString();

				const result = database.run(
					"UPDATE claims SET released_at = ? WHERE arm_id = ? AND file_path = ? AND released_at IS NULL",
					[now, ARM_ID, file_path],
				);

				if (result.changes === 0) {
					logActivity(ARM_ID, "release_claim_failed", file_path, {
						error: "no_active_claim",
						reason,
					});
					return {
						content: [
							{
								type: "text" as const,
								text: `No active claim found on ${file_path} to release`,
							},
						],
					};
				}

				logActivity(ARM_ID, "release_claim", file_path, { reason });

				return {
					content: [
						{
							type: "text" as const,
							text: `Released claim on ${file_path}${reason ? `\nReason: ${reason}` : ""}\n\nOther arms can now claim this file.`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				logActivity(ARM_ID, "release_claim_failed", file_path, {
					error: errorMsg,
					reason,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to release claim on ${file_path}: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Check for conflicts on a file
	server.registerTool(
		"check_conflicts",
		{
			description:
				"Check if a file has conflicting claims or if it's safe to work on",
			inputSchema: {
				file_path: z.string().describe("Path to the file to check"),
			},
		},
		async ({ file_path }) => {
			try {
				const database = getDatabase();

				// Get all active claims on this file
				const claims = database
					.query(
						`SELECT arm_id, claim_type, claimed_at FROM claims
           WHERE file_path = ? AND released_at IS NULL
           ORDER BY claimed_at ASC`,
					)
					.all(file_path) as Array<{
					arm_id: string;
					claim_type: string;
					claimed_at: string;
				}>;

				if (claims.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `✅ ${file_path} is available - no active claims`,
							},
						],
					};
				}

				if (claims.length === 1) {
					const claim = claims[0];
					if (!claim) {
						return {
							content: [
								{
									type: "text" as const,
									text: `⚠️ ${file_path} has unexpected claim data`,
								},
							],
						};
					}

					if (claim.arm_id === ARM_ID) {
						return {
							content: [
								{
									type: "text" as const,
									text: `✅ ${file_path} is claimed by you (${claim.claim_type}) since ${claim.claimed_at}`,
								},
							],
						};
					} else {
						return {
							content: [
								{
									type: "text" as const,
									text: `⚠️ ${file_path} is claimed by ${claim.arm_id} (${claim.claim_type}) since ${claim.claimed_at}`,
								},
							],
						};
					}
				}

				// Multiple claims - conflict zone
				const claimList = claims
					.map((c) => `${c.arm_id} (${c.claim_type})`)
					.join(", ");
				const yourClaim = claims.find((c) => c.arm_id === ARM_ID);

				logActivity(ARM_ID, "check_conflicts", file_path, {
					conflict: true,
					claim_count: claims.length,
					arms: claims.map((c) => c.arm_id),
				});

				return {
					content: [
						{
							type: "text" as const,
							text: `🔥 CONFLICT ZONE: ${file_path}\n\nMultiple claims: ${claimList}\n\n${yourClaim ? "You have a claim on this file. Coordinate with other arms before making changes." : "Consider requesting approval before claiming this contested file."}`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to check conflicts for ${file_path}: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Transfer a claim to another arm
	server.registerTool(
		"transfer_claim",
		{
			description:
				"Transfer your file claim to another arm (requires coordination)",
			inputSchema: {
				file_path: z.string().describe("Path to the file to transfer"),
				to_arm: z.string().describe("ID of the arm to transfer the claim to"),
				reason: z.string().describe("Reason for the transfer"),
			},
		},
		async ({ file_path, to_arm, reason }) => {
			try {
				const database = getDatabase(false);

				// Check if target arm exists
				const targetArm = database
					.query("SELECT id FROM arms WHERE id = ?")
					.get(to_arm);
				if (!targetArm) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Cannot transfer claim: Target arm ${to_arm} not found`,
							},
						],
					};
				}

				// Check if we have an active claim
				const ourClaim = database
					.query(
						"SELECT id, claim_type FROM claims WHERE arm_id = ? AND file_path = ? AND released_at IS NULL",
					)
					.get(ARM_ID, file_path) as { id: number; claim_type: string } | null;

				if (!ourClaim) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No active claim found on ${file_path} to transfer`,
							},
						],
					};
				}

				// Check if target arm already has a claim
				const theirClaim = database
					.query(
						"SELECT id FROM claims WHERE arm_id = ? AND file_path = ? AND released_at IS NULL",
					)
					.get(to_arm, file_path);

				if (theirClaim) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Cannot transfer: ${to_arm} already has a claim on ${file_path}`,
							},
						],
					};
				}

				// Update claim ownership
				const now = new Date().toISOString();
				database.run(
					"UPDATE claims SET arm_id = ?, claimed_at = ? WHERE id = ?",
					[to_arm, now, ourClaim.id],
				);

				// Notify the brain about the transfer
				const messageId = await sendToBrain({
					from: ARM_ID,
					to: "brain",
					type: "claim_transfer",
					payload: {
						filePath: file_path,
						fromArm: ARM_ID,
						toArm: to_arm,
						claimType: ourClaim.claim_type,
						reason,
					},
				});

				logActivity(ARM_ID, "transfer_claim", file_path, {
					to_arm,
					reason,
					claim_type: ourClaim.claim_type,
					message_id: messageId,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: `Transferred ${ourClaim.claim_type} claim on ${file_path} to ${to_arm}\n\nReason: ${reason}\n\nBrain notified (message: ${messageId})`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to transfer claim: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Get your current file claims
	server.registerTool(
		"list_my_claims",
		{
			description: "List all files you currently have claimed",
			inputSchema: {},
		},
		async () => {
			try {
				const database = getDatabase();

				const claims = database
					.query(
						`SELECT file_path, claim_type, claimed_at FROM claims
           WHERE arm_id = ? AND released_at IS NULL
           ORDER BY claimed_at DESC`,
					)
					.all(ARM_ID) as Array<{
					file_path: string;
					claim_type: string;
					claimed_at: string;
				}>;

				if (claims.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: "You have no active file claims.",
							},
						],
					};
				}

				const claimList = claims
					.map(
						(c) =>
							`- ${c.file_path} (${c.claim_type}) - claimed ${c.claimed_at}`,
					)
					.join("\n");

				return {
					content: [
						{
							type: "text" as const,
							text: `Your active file claims (${claims.length}):\n\n${claimList}\n\nUse 'release_claim' to release files you're done with.`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to list claims: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Pre-file operation check (before editing files)
	server.registerTool(
		"pre_file_operation",
		{
			description:
				"Call this before editing any files to check claims and get permission",
			inputSchema: {
				file_path: z
					.string()
					.describe("Path to the file you want to operate on"),
				operation: z
					.enum(["read", "write", "delete", "create"])
					.describe("Type of operation"),
				estimated_duration: z
					.number()
					.optional()
					.describe("Estimated operation duration in minutes"),
			},
		},
		async ({ file_path, operation, estimated_duration }) => {
			try {
				// Import the enforcement functions
				const { canWriteToFile, autoClaimFile } = await import(
					"../../arm/claim-enforcement"
				);
				// ApiDatabase has compatible query/run interface with Database
				// TypeScript types don't match but runtime works correctly
				const database = getDatabase(false) as unknown as import("bun:sqlite").Database;

				// Check if operation is allowed
				if (
					operation === "write" ||
					operation === "delete" ||
					operation === "create"
				) {
					const result = canWriteToFile(database, ARM_ID, file_path);

					if (!result.canWrite) {
						logActivity(ARM_ID, "pre_file_operation_blocked", file_path, {
							operation,
							reason: result.reason,
							estimated_duration,
						});

						return {
							content: [
								{
									type: "text" as const,
									text: `❌ File operation blocked: ${result.reason}\n\nUse 'claim_file' tool to request access or 'check_conflicts' to see current claims.`,
								},
							],
						};
					}

					// Auto-claim if suggested
					if (result.shouldClaim) {
						const claimType =
							operation === "write" ||
							operation === "delete" ||
							operation === "create"
								? "write"
								: "read";
						const claimed = autoClaimFile(
							database,
							ARM_ID,
							file_path,
							claimType,
						);

						logActivity(ARM_ID, "pre_file_operation_auto_claim", file_path, {
							operation,
							claim_type: claimType,
							claimed,
							estimated_duration,
						});

						return {
							content: [
								{
									type: "text" as const,
									text: `✅ File operation approved for ${file_path}\n${claimed ? `Auto-claimed file (${claimType} access)` : "Operation allowed"}\n\nProceed with your ${operation} operation.`,
								},
							],
						};
					}
				}

				logActivity(ARM_ID, "pre_file_operation_approved", file_path, {
					operation,
					estimated_duration,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: `✅ File operation approved for ${file_path} (${operation})`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				logActivity(ARM_ID, "pre_file_operation_failed", file_path, {
					error: errorMsg,
					operation,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: `Error checking file operation permission: ${errorMsg}\n\nProceeding with operation (fail-open mode)`,
						},
					],
				};
			}
		},
	);

	// Post-file operation reporting (after editing files)
	server.registerTool(
		"post_file_operation",
		{
			description:
				"Call this after editing files to report completion and detect conflicts",
			inputSchema: {
				file_path: z.string().describe("Path to the file that was operated on"),
				operation: z
					.enum(["read", "write", "delete", "create"])
					.describe("Type of operation performed"),
				success: z.boolean().describe("Whether the operation succeeded"),
				changes_summary: z
					.string()
					.optional()
					.describe("Brief summary of changes made"),
			},
		},
		async ({ file_path, operation, success, changes_summary }) => {
			try {
				// Import the enforcement functions
				const { checkAndEscalateIfThrashing } = await import(
					"../../arm/claim-enforcement"
				);
				// ApiDatabase has compatible query/run interface with Database
				const database = getDatabase(false) as unknown as import("bun:sqlite").Database;

				// Log the activity for thrashing detection
				logActivity(ARM_ID, `file_${operation}`, file_path, {
					success,
					changes_summary,
					timestamp: new Date().toISOString(),
				});

				// Check for thrashing if this was a write operation
				if ((operation === "write" || operation === "create") && success) {
					await checkAndEscalateIfThrashing(database, file_path);
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `✅ File operation logged: ${file_path} (${operation})${success ? "" : " - FAILED"}\n${changes_summary ? `Changes: ${changes_summary}` : ""}\n\nThrashing detection updated.`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);

				return {
					content: [
						{
							type: "text" as const,
							text: `Error logging file operation: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Get current claim mode
	server.registerTool(
		"get_claim_mode",
		{
			description: "Get the current file claim enforcement mode",
			inputSchema: {},
		},
		async () => {
			try {
				const { getClaimMode, getClaimEnforcementConfig } = await import(
					"../../arm/claim-enforcement"
				);
				// ApiDatabase has compatible query/run interface with Database
				const database = getDatabase() as unknown as import("bun:sqlite").Database;
				const mode = getClaimMode(database);
				const config = getClaimEnforcementConfig(database);

				const modeDescriptions: Record<string, string> = {
					strict: "Must claim files before writing. Conflicts are blocked.",
					lazy: "Claims optional. Conflicts detected after the fact with auto-escalation.",
					disabled: "No claim enforcement. Parallel writes allowed.",
				};

				return {
					content: [
						{
							type: "text" as const,
							text: `Current claim mode: **${mode}**\n\n${modeDescriptions[mode] || mode}\n\nConfiguration:\n- Auto-claim on write: ${config.autoClaimOnWrite}\n- Block on conflict: ${config.blockOnConflict}\n- Thrashing detection: ${config.enableThrashingDetection}`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to get claim mode: ${errorMsg}`,
						},
					],
				};
			}
		},
	);
}
