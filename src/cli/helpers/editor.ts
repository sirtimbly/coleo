const EDITOR_COMMAND_RE = /[^\s"']+|"([^"]*)"|'([^']*)'/g;

function stripEditorQuotes(part: string): string {
	if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
		return part.slice(1, -1);
	}
	return part;
}

export function parseEditorCommand(editor: string): string[] {
	const parts = editor.trim().match(EDITOR_COMMAND_RE) || ["vi"];
	return parts.map(stripEditorQuotes);
}
