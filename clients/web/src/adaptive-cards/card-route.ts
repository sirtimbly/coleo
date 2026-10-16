export function createCardRoute(instanceId: string, title = "Card"): {
	pathname: string;
	search: string;
	title: string;
} {
	const params = new URLSearchParams({ id: instanceId });
	return { pathname: "/card", search: `?${params.toString()}`, title };
}

export function parseCardRoute(searchParams: URLSearchParams): string | null {
	const id = searchParams.get("id");
	return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}
