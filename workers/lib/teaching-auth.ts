export async function hasValidTeachingAdminToken(
	request: Request,
	configuredToken: string | undefined,
): Promise<boolean> {
	if (!configuredToken) return false;
	const authorization = request.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return false;
	const suppliedToken = authorization.slice("Bearer ".length);

	const encoder = new TextEncoder();
	const [suppliedDigest, configuredDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(suppliedToken)),
		crypto.subtle.digest("SHA-256", encoder.encode(configuredToken)),
	]);
	const supplied = new Uint8Array(suppliedDigest);
	const configured = new Uint8Array(configuredDigest);
	let difference = 0;
	for (let index = 0; index < configured.length; index += 1) {
		difference |= supplied[index] ^ configured[index];
	}
	return difference === 0;
}
